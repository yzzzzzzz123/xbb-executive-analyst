"use strict";

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { AgentTurnFailureError, AgentTurnTimeoutError, principalKeyFromUserId } = require("../codex/persistent-agent.js");
const { MAX_USER_QUESTION_BYTES } = require("../codex/context-policy.js");
const { authorize, AccessDeniedError } = require("../security/access-control.js");
const { routeSkill } = require("../rag/skill-router.js");
const { chartTypeLabel, formatDuration } = require("../xbb/query-progress.js");
const { createWecomChartImage } = require("./chart-image.js");
const { MessageStore, MessageStoreCapacityError } = require("./message-store.js");
const { splitMarkdownText } = require("./text-delivery.js");
const { createRequestMetrics } = require("../observability/request-metrics.js");
const { DeliveryTimeoutError, createDeliveryDeadline, validateBudget, withinBudget } = require("./delivery-budget.js");

const DEFAULT_ROUTE_MEMORY_MAX_ENTRIES = 4096;
const MAX_ANSWER_PREVIEW_UPDATES = 12;
const XBB_FOLLOW_UP_HANDOFF_ANSWER = "已收到你的补充要求，正在继续分析。完整结果会回复到你最新一条消息。";

function extractQuestion(message) {
  if (message?.msgtype === "text") return message.text?.content;
  if (message?.msgtype === "voice") return message.voice?.content;
  if (message?.msgtype === "mixed" && Array.isArray(message.mixed?.msg_item)) {
    return message.mixed.msg_item
      .filter((item) => item?.msgtype === "text")
      .map((item) => item.text?.content || "")
      .join("\n");
  }
  return "";
}

function operationalFailure(error) {
  if (error instanceof AccessDeniedError) return error.message;
  if (error?.code === "REQUEST_DEADLINE_EXCEEDED") return "本次请求已到达从接收开始计算的处理时限，包含排队等待；已停止等待并请求取消本请求仍在进行的分析或查询，不会把迟到结果补发为新结论。可以继续原问题；若需要精确材料，系统会重新核实。";
  if (error?.code === "REQUEST_CANCELLED") return "本次请求已取消，不再发送它的迟到结果；其他请求不受本次取消影响。";
  if (error instanceof AgentTurnFailureError) {
    const message = {
      unauthorized: "机器人连接模型服务的登录已失效，暂时无法回答。请管理员在部署机器的 Windows 端重新登录 Codex 后恢复服务。",
      connection_failed: "机器人暂时无法连接模型服务，自动重试后仍未恢复，本轮未能生成答复。请管理员检查部署机器的网络和代理连接。",
      usage_limit: "模型服务的使用额度暂时受限，本轮未能生成答复。请管理员检查模型账户的可用额度。",
      context_limit: "本轮对话超过模型上下文限制，已清理失效上下文；下一条消息将使用新会话。",
      invalid_request: "模型服务未接受本轮请求。请管理员检查机器人使用的模型和请求配置。",
      service_error: "模型服务暂时出现故障，本轮未能生成答复；服务恢复后可以继续提问。"
    }[error.modelErrorCode];
    if (message) return message;
  }
  if (error instanceof AgentTurnTimeoutError) {
    return error.routeMode === "xbb"
      ? "本轮实时取数或推理超过时限，自动恢复流程已保护数据完整性并重置会话；没有输出不完整或陈旧数字。服务会从新 Thread 继续接收原问题，无需拆分主题。"
      : "这个问题需要较长推理，本轮超过时限后系统已自动重置上下文，避免返回半截答案；可直接继续原问题。";
  }
  if (error instanceof AgentTurnFailureError && error.routeMode === "xbb") {
    return "本轮实时源或分析进程连续异常，系统已清理失效会话并交给看门狗恢复；没有用替代或陈旧数据拼答案。恢复后可原样继续，不需要缩小问题。";
  }
  return "本轮通用推理链路异常，系统已清理失效上下文并进入自动恢复；可直接继续原问题。";
}

function defaultStreamId() {
  return `stream_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryTransient(operation, options = {}) {
  const attempts = Math.max(1, Math.min(4, Number(options.attempts) || 1));
  const wait = options.wait || delay;
  const shouldRetry = typeof options.shouldRetry === "function" ? options.shouldRetry : () => true;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (typeof options.canAttempt === "function" && !options.canAttempt()) throw new DeliveryTimeoutError();
    try { return await operation(attempt); } catch (error) {
      lastError = error;
      if (attempt < attempts && shouldRetry(error)) await wait(Math.min(400, 75 * (2 ** (attempt - 1))));
      else break;
    }
  }
  throw lastError;
}

function isTransientRenderError(error) {
  return !/(?:无效|不符合|缺少|不支持|安全上限|超过.*(?:限制|大小)|字段|schema|contract)/i.test(String(error?.message || ""));
}

function isTransientTransportError(error) {
  if (error instanceof DeliveryTimeoutError) return false;
  const message = String(error?.message || "");
  const code = String(error?.code || error?.errcode || "");
  return !/(?:^|\D)(?:400|401|403|410)(?:\D|$)|鉴权|认证失败|无权限|非法|invalid|格式|超过.*(?:限制|大小)|10\s*mb/i.test(`${code} ${message}`);
}

function appendVisualNotice(answer, notice) {
  const text = String(answer || "").trim();
  return text.includes(notice) ? text : `${text}\n\n${notice}`;
}

function isXbbOperationalHandoff(result) {
  return Boolean(result
    && result.routeMode === "xbb"
    && !result.chart
    && String(result.answer || "").trim() === XBB_FOLLOW_UP_HANDOFF_ANSWER);
}

function normalizeRenderedImage(rendered) {
  const item = rendered?.item || rendered;
  if (item?.msgtype !== "image"
      || typeof item.image?.base64 !== "string" || !item.image.base64
      || typeof item.image?.md5 !== "string" || !item.image.md5) {
    throw new Error("图片渲染器未返回有效的企业微信图片项。");
  }
  return Object.freeze({ item, buffer: Buffer.isBuffer(rendered?.buffer) ? rendered.buffer : null });
}

function assertBoundedIdentifier(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`企业微信长连接消息缺少 ${label}。`);
  if (Buffer.byteLength(value, "utf8") > 512) throw new Error(`企业微信长连接消息 ${label} 超过安全上限。`);
}

function validateFrame(frame) {
  assertBoundedIdentifier(frame?.headers?.req_id, "req_id");
  const message = frame.body;
  if (!message || typeof message !== "object") throw new Error("企业微信长连接消息缺少正文。");
  assertBoundedIdentifier(message.msgid, "msgid");
  return message;
}

function createProgressPublisher({ deliver, updateState, drainBudgetMs = 6000, now = () => performance.now() }) {
  validateBudget(drainBudgetMs);
  let pending = null;
  let running = false;
  let closed = false;
  let current = Promise.resolve();
  let wakeTimer = null;
  let wakeFinished = Promise.resolve();
  let resolveWake = null;
  let lastPreviewAt = -Infinity;
  const stopWaiting = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
    resolveWake?.();
    resolveWake = null;
  };
  const valid = (entry) => {
    try { return !entry.isCurrent || entry.isCurrent() === true; } catch { return false; }
  };

  const pump = () => {
    if (running || closed || wakeTimer) return current;
    running = true;
    current = (async () => {
      while (!closed && pending !== null) {
        const entry = pending;
        pending = null;
        if (!valid(entry)) continue;
        const remaining = entry.minimumIntervalMs - (now() - lastPreviewAt);
        if (entry.minimumIntervalMs > 0 && remaining > 0) {
          pending = entry;
          wakeFinished = new Promise((resolve) => { resolveWake = resolve; });
          wakeTimer = setTimeout(() => { stopWaiting(); void pump(); }, Math.ceil(remaining));
          wakeTimer.unref?.();
          break;
        }
        if (entry.minimumIntervalMs > 0) lastPreviewAt = now();
        try {
          const delivered = await deliver(entry.content, () => !closed && valid(entry), () => {
            try { entry.onDispatch?.(); } catch {}
          });
          if (delivered !== false && typeof entry.onDelivered === "function") {
            try { Promise.resolve(entry.onDelivered()).catch(() => {}); } catch {}
          }
        } catch {
          if (typeof entry.onDeliveryFailed === "function") {
            try { Promise.resolve(entry.onDeliveryFailed()).catch(() => {}); } catch {}
          }
        }
      }
    })().catch(() => { /* 中间进度失败不能阻断最终答复 */ }).finally(() => {
      running = false;
      if (!closed && pending !== null) void pump();
    });
    return current;
  };

  return Object.freeze({
    publish(content, options = {}) {
      if (closed) return;
      const value = String(content || "").trim();
      if (!value) return;
      const entry = { content: value,
        isCurrent: typeof options.isCurrent === "function" ? options.isCurrent : null,
        minimumIntervalMs: Number.isInteger(options.minimumIntervalMs) && options.minimumIntervalMs > 0 && options.minimumIntervalMs <= 60000 ? options.minimumIntervalMs : 0,
        onDispatch: options.onDispatch, onDelivered: options.onDelivered, onDeliveryFailed: options.onDeliveryFailed };
      if (!valid(entry)) return;
      pending = entry;
      // Preview text is deliberately absent from the replay cache. A duplicate
      // incoming message can replay status or the final result, never a stale
      // draft whose turn/owner validity cannot be represented in that cache.
      if (options.store !== false) updateState(value);
      if (!entry.minimumIntervalMs && wakeTimer) stopWaiting();
      void pump();
    },
    async flush() {
      do {
        if (!running && pending !== null) void pump();
        await current;
        if (wakeTimer) await wakeFinished;
      } while (running || pending !== null);
    },
    async close() {
      closed = true;
      pending = null;
      stopWaiting();
      // SDK serializes already submitted replies by req_id. Only that one
      // in-flight update may finish; no queued/late stage can follow the answer.
      try { await withinBudget(() => current, drainBudgetMs); return true; }
      catch { return false; }
    }
  });
}

function createLongConnectionHandler({
  policy,
  agent,
  messageStore = new MessageStore(),
  streamIdFactory = defaultStreamId,
  principalKeyFactory = principalKeyFromUserId,
  statusWriter = () => {},
  heartbeatMs = 45000,
  chartRenderer = createWecomChartImage,
  retryWait = delay,
  renderAttempts = 2,
  // SDK upload chunks already retry three times. Do not multiply whole uploads.
  transportAttempts = 1,
  progressDrainBudgetMs = 6000,
  replyBudgetMs = 7000,
  renderBudgetMs = 10000,
  uploadBudgetMs = 15000,
  mediaDeliveryBudgetMs = 6000,
  businessRequestBudgetMs = 20 * 60 * 1000,
  generalRequestBudgetMs = 15 * 60 * 1000,
  analysisDeliveryReserveMs = 30000,
  answerPreviewIntervalMs = 1000,
  monotonicNow = () => performance.now(),
  routeMemoryMaxEntries = DEFAULT_ROUTE_MEMORY_MAX_ENTRIES
}) {
  if (!policy || !agent?.answer) throw new Error("企业微信长连接处理器初始化参数不完整。");
  if (!Number.isInteger(routeMemoryMaxEntries) || routeMemoryMaxEntries < 1) throw new Error("企业微信路由记忆上限无效。");
  [progressDrainBudgetMs, replyBudgetMs, renderBudgetMs, uploadBudgetMs, mediaDeliveryBudgetMs].forEach(validateBudget);
  [businessRequestBudgetMs, generalRequestBudgetMs].forEach((budgetMs) => createDeliveryDeadline({ budgetMs }));
  validateBudget(analysisDeliveryReserveMs);
  if (!Number.isInteger(answerPreviewIntervalMs) || answerPreviewIntervalMs < 1 || answerPreviewIntervalMs > 60000) throw new Error("正文预览间隔必须为 1–60000 毫秒。");
  if (typeof monotonicNow !== "function") throw new Error("请求单调时钟无效。");
  // 应急图在启动阶段只生成和校验一次。运行时拒绝/渲染故障只复用这个不可变项，
  // 避免未授权消息触发 Sharp CPU 开销，也消除最后一级兜底再次抛错的窗口。
  const lastRouteByUser = new Map();
  const rememberRoute = (userId, routeMode) => {
    lastRouteByUser.delete(userId);
    lastRouteByUser.set(userId, routeMode);
    if (lastRouteByUser.size > routeMemoryMaxEntries) lastRouteByUser.delete(lastRouteByUser.keys().next().value);
  };
  const writeStatus = (value) => {
    try { statusWriter(value); } catch { /* 状态日志故障不能阻断图片和文字答复 */ }
  };

  return Object.freeze({
    async handleMessage(frame, client) {
      if (!client?.replyStream) throw new Error("企业微信长连接客户端不可用。");
      const message = validateFrame(frame);
      const messageId = message.msgid;
      const receivedAtMs = Date.now();
      const receivedAtMonotonic = monotonicNow();
      const userId = String(message.from?.userid || "");
      const question = String(extractQuestion(message) || "").trim();
      const oversized = Buffer.byteLength(question, "utf8") > MAX_USER_QUESTION_BYTES;
      const inferredRoute = oversized ? lastRouteByUser.get(userId) || "general" : routeSkill(question, lastRouteByUser.get(userId) || null).mode;
      // 路由意图不含经营事实，可以在鉴权前安全记忆。这样未授权用户收到拒绝后说
      // “继续”，仍会被识别为上一条销帮帮追问并附应急图；LRU 上限避免常驻泄漏。
      rememberRoute(userId, inferredRoute);

      let access;
      try {
        access = authorize(policy, userId);
      } catch (error) {
        const content = operationalFailure(error);
        let begun;
        try {
          begun = messageStore.begin({ messageId, userId, streamId: streamIdFactory(), content });
        } catch (storeError) {
          if (!(storeError instanceof MessageStoreCapacityError)) throw storeError;
          const items = [];
          return withinBudget(() => client.replyStream(frame, streamIdFactory(), "当前请求已触发并发保护，系统仍在处理已接收的任务；本条未读取销帮帮，也未生成任何经营数字。", true, items), replyBudgetMs);
        }
        const { state, isNew } = begun;
        if (isNew) {
          // 授权拒绝不是经营分析结果，且不得让未登记用户以不同 msgid 并发触发 Sharp。
          const items = [];
          messageStore.complete(messageId, content, items);
        }
        return withinBudget(() => client.replyStream(frame, state.streamId, state.content, true, state.msgItem), replyBudgetMs);
      }

      const initialContent = oversized ? "本条输入超过 32 KiB 接收上限，未提交给模型或查询工具。请按表、模块或完整 SQL/JSON 代码块分条提供，并保留目标和约束；不要把同一个代码块从中间截断。" : question
        ? "正在识别问题范围和分析维度……"
        : "目前仅支持文字、语音转文字或图文中的文字问题。";
      let begun;
      try {
        begun = messageStore.begin({ messageId, userId, streamId: streamIdFactory(), content: initialContent });
      } catch (storeError) {
        if (!(storeError instanceof MessageStoreCapacityError)) throw storeError;
        const items = [];
        return withinBudget(() => client.replyStream(frame, streamIdFactory(), "当前请求已触发并发保护，系统仍在处理已接收的任务；本条未读取销帮帮，也未生成任何经营数字。", true, items), replyBudgetMs);
      }
      const { state, isNew } = begun;

      if (!isNew) return withinBudget(() => client.replyStream(frame, state.streamId, state.content, state.finish, state.finish ? state.msgItem : undefined), replyBudgetMs);
      const requestBudgetMs = inferredRoute === "xbb" ? businessRequestBudgetMs : generalRequestBudgetMs;
      const deadline = createDeliveryDeadline({ budgetMs: requestBudgetMs, startedAt: receivedAtMonotonic, now: monotonicNow });
      const finalReplyReserveMs = Math.min(replyBudgetMs, Math.max(1, Math.floor(requestBudgetMs / 10)));
      const analysisReserveMs = Math.max(finalReplyReserveMs, Math.min(analysisDeliveryReserveMs, Math.floor(requestBudgetMs / 5)));
      const metrics = createRequestMetrics({ now: monotonicNow, startedAt: receivedAtMonotonic });
      let outcome = "success";
      let failureClass;
      const finishMetrics = (routeMode, imageDelivery, result = outcome) => {
        const value = metrics.finish({ routeMode, imageDelivery, outcome: result, failureClass });
        if (value) writeStatus(value);
      };
      const replyStream = (content, finish, items) => deadline.run(
        () => client.replyStream(frame, state.streamId, content, finish, items), replyBudgetMs, finish ? 0 : finalReplyReserveMs
      );
      writeStatus({ status: "message_received" });
      if (!question || oversized) {
        const items = [];
        messageStore.complete(messageId, initialContent, items);
        let reply;
        try { reply = await replyStream(initialContent, true, items); }
        catch (error) { failureClass = error?.code === "REQUEST_DEADLINE_EXCEEDED" ? "deadline_exceeded" : error instanceof DeliveryTimeoutError ? "delivery_timeout" : "transport_failed"; finishMetrics(inferredRoute, "none", "failed"); throw error; }
        metrics.mark("firstReplyMs");
        finishMetrics(inferredRoute, items.length ? "inline" : "none", "unsupported");
        writeStatus({ status: "reply_completed", elapsedMs: Date.now() - receivedAtMs });
        return reply;
      }

      try {
        await replyStream(initialContent, false);
        metrics.mark("firstReplyMs");
      } catch (error) {
        messageStore.delete(messageId);
        failureClass = error?.code === "REQUEST_DEADLINE_EXCEEDED" ? "deadline_exceeded" : error instanceof DeliveryTimeoutError ? "delivery_timeout" : "transport_failed";
        finishMetrics(inferredRoute, "none", "failed");
        throw error;
      }

      let answer;
      let chart = null;
      let routeMode = inferredRoute;
      let heartbeat;
      let onProgress;
      let progressPublisher;
      let previewOpen = true;
      let activePreview = null;
      let previewDispatches = 0;
      let previewAttempted = false;
      try {
        let latestStage = initialContent;
        progressPublisher = createProgressPublisher({
          deliver: (content, isCurrent, onDispatch) => deadline.run(() => {
            if (!isCurrent()) return false;
            onDispatch();
            return client.replyStream(frame, state.streamId, content, false);
          }, replyBudgetMs, finalReplyReserveMs),
          updateState: (content) => messageStore.update(messageId, content),
          drainBudgetMs: progressDrainBudgetMs,
          now: monotonicNow
        });
        const previewIsCurrent = (preview) => {
          try { return previewOpen && inferredRoute === "general" && preview?.isCurrent?.() === true; } catch { return false; }
        };
        onProgress = (content) => {
          latestStage = String(content || "").trim() || latestStage;
          if (!previewIsCurrent(activePreview)) {
            activePreview = null;
            progressPublisher.publish(latestStage);
          }
        };
        heartbeat = setInterval(() => {
          if (previewIsCurrent(activePreview)) return;
          activePreview = null;
          const seconds = Math.max(1, Math.floor((Date.now() - receivedAtMs) / 1000));
          progressPublisher.publish(`${latestStage}\n已用时：${formatDuration(seconds)}；当前阶段仍在继续。`);
        }, heartbeatMs);
        heartbeat.unref?.();
        const result = await metrics.measure("analysisMs", () => deadline.run((_isOpen, signal, remainingMs) => agent.answer({
          question,
          access,
          principalKey: principalKeyFactory(userId, access),
          messageId,
          onProgress,
          onAnswerPreview: (preview) => {
            if (!previewIsCurrent(preview) || typeof preview.text !== "string" || !preview.text.trim()
                || Buffer.byteLength(preview.text, "utf8") > 18000 || previewDispatches >= MAX_ANSWER_PREVIEW_UPDATES) return;
            activePreview = preview;
            progressPublisher.publish(`正文预览（生成中，请以最终答复为准）\n\n${preview.text}`, {
              store: false, minimumIntervalMs: answerPreviewIntervalMs,
              isCurrent: () => previewIsCurrent(preview) && previewDispatches < MAX_ANSWER_PREVIEW_UPDATES,
              onDispatch: () => { previewAttempted = true; previewDispatches += 1; },
              onDelivered: () => metrics.markFirst("answerPreviewVisibleMs"),
              onDeliveryFailed: () => {
                // An older in-flight failure must not remove a newer queued
                // preview. Only its own failed draft stops suppressing status.
                if (activePreview !== preview) return;
                activePreview = null;
                progressPublisher.publish(latestStage);
              }
            });
          },
          onTiming: (event) => metrics.addQueryTiming(event),
          signal,
          remainingMs
        }), requestBudgetMs, analysisReserveMs));
        answer = typeof result === "string" ? result : result?.answer;
        if (typeof answer !== "string" || !answer.trim()) throw new Error("Codex Agent 最终答复缺少文字答复。");
        chart = typeof result === "object" && result ? result.chart : null;
        if (result?.routeMode === "xbb" || result?.routeMode === "general") routeMode = result.routeMode;
      } catch (error) {
        outcome = "failed";
        failureClass = error?.code === "REQUEST_DEADLINE_EXCEEDED" ? "deadline_exceeded" : error?.code === "REQUEST_CANCELLED" ? "cancelled" : error instanceof AgentTurnTimeoutError ? "analysis_timeout" : "analysis_failed";
        answer = operationalFailure(error);
        if (previewAttempted) answer = `本轮未完成，之前显示的正文预览不是完整结果，请以本条状态为准。\n\n${answer}`;
        if (error?.routeMode === "xbb") routeMode = "xbb";
      } finally {
        previewOpen = false;
        if (heartbeat) clearInterval(heartbeat);
        metrics.mark("answerReadyMs");
        if (progressPublisher) {
          const closing = progressPublisher.close();
          try { await metrics.measure("progressDrainMs", () => deadline.run(() => closing, progressDrainBudgetMs, finalReplyReserveMs)); }
          catch { /* Closed synchronously; only an already-dispatched ACK may arrive. */ }
        }
      }
      rememberRoute(userId, routeMode);
      let answerVisible = false;
      let standaloneText = "";
      let standaloneTextReply;
      const target = message.chattype === "group" ? String(message.chatid || "") : userId;
      const deliverStandaloneText = async (content, streamError) => {
        if (!target || typeof client.sendMessage !== "function") throw streamError || new Error("企业微信独立文字通道不可用。");
        // A render failure may append a notice after the original answer was
        // delivered. Send only that addition; never resend successful chunks.
        const unsent = standaloneText && content.startsWith(standaloneText) ? content.slice(standaloneText.length) : content;
        for (const part of splitMarkdownText(unsent)) {
          standaloneTextReply = await deadline.run(() => client.sendMessage(target, {
            msgtype: "markdown", markdown: { content: part }
          }), replyBudgetMs);
        }
        standaloneText = content;
        if (!answerVisible) metrics.mark("answerVisibleMs");
        answerVisible = true;
        writeStatus({ status: "text_standalone_delivered" });
        return standaloneTextReply;
      };
      if (chart) {
        // No image may be dispatched without an ACK for the complete answer.
        // Long analysis can outlive the passive stream; active Markdown uses
        // a fresh request ID and the same authorized conversation target.
        const visible = `${answer}\n\n正在制作：${chartTypeLabel(chart.type)}，图片随后补齐。`;
        messageStore.update(messageId, visible);
        try {
          await replyStream(visible, false);
          answerVisible = true;
          metrics.mark("answerVisibleMs");
        } catch (streamError) {
          writeStatus({ status: "text_stream_failed" });
          try { await deliverStandaloneText(answer, streamError); }
          catch (error) {
            messageStore.complete(messageId, answer, []);
            writeStatus({ status: "text_delivery_failed" });
            failureClass = error?.code === "REQUEST_DEADLINE_EXCEEDED" ? "deadline_exceeded" : error instanceof DeliveryTimeoutError ? "delivery_timeout" : "transport_failed";
            finishMetrics(routeMode, "none", "failed");
            throw error;
          }
        }
      }
      let msgItem = [];
      let imageBuffer = null;
      if (chart) {
        try {
          const rendered = normalizeRenderedImage(await metrics.measure("renderMs", () => deadline.run((isOpen) => retryTransient(() => chartRenderer(chart), {
            canAttempt: isOpen,
            attempts: renderAttempts,
            wait: retryWait,
            shouldRetry: (error) => isOpen() && isTransientRenderError(error)
          }), renderBudgetMs, finalReplyReserveMs)));
          msgItem = [rendered.item];
          imageBuffer = rendered.buffer;
          writeStatus({ status: "chart_generated" });
        } catch {
          if (outcome === "success") outcome = "degraded";
          writeStatus({ status: "chart_failed" });
          answer = appendVisualNotice(answer, "（图表暂未生成，文字结论已保留。）");
        }
      }
      let uploadedMediaId = null;
      if (imageBuffer && target && typeof client.uploadMedia === "function" && typeof client.sendMediaMessage === "function") {
        try {
          const uploaded = await metrics.measure("uploadMs", () => deadline.run((isOpen) => retryTransient(
            async () => {
              const result = await client.uploadMedia(imageBuffer, { type: "image", filename: "经营分析图表.png" });
              if (!result?.media_id) throw new Error("企业微信未返回图片 media_id。");
              return result;
            },
            { attempts: transportAttempts, canAttempt: isOpen, wait: retryWait, shouldRetry: (error) => isOpen() && isTransientTransportError(error) }
          ), uploadBudgetMs, finalReplyReserveMs));
          uploadedMediaId = uploaded.media_id;
          writeStatus({ status: "chart_uploaded" });
        } catch {
          if (outcome === "success") outcome = "degraded";
          uploadedMediaId = null;
          writeStatus({ status: "chart_upload_failed" });
        }
      }
      let standaloneDelivered = false;
      if (uploadedMediaId) {
        try {
          await metrics.measure("mediaDeliveryMs", () => deadline.run((isOpen) => retryTransient(
            () => client.sendMediaMessage(target, "image", uploadedMediaId),
            { attempts: Math.min(2, transportAttempts), canAttempt: isOpen, wait: retryWait, shouldRetry: (error) => isOpen() && isTransientTransportError(error) }
          ), mediaDeliveryBudgetMs, finalReplyReserveMs));
          standaloneDelivered = true;
          writeStatus({ status: "chart_delivered" });
        } catch {
          if (outcome === "success") outcome = "degraded";
          standaloneDelivered = false;
          writeStatus({ status: "chart_media_delivery_failed" });
        }
      }
      const inlineItems = standaloneDelivered ? [] : [...msgItem];
      // 首次若已用独立 media 消息送图，正文不重复内嵌；缓存仍保存完整图片项，
      // 让企业微信重放同一 msgid 时也不会只收到文字。
      messageStore.complete(messageId, answer, msgItem);
      let reply;
      try {
        if (standaloneText && !inlineItems.length) {
          reply = standaloneText === answer ? standaloneTextReply : await deliverStandaloneText(answer);
        } else {
          try { reply = await replyStream(answer, true, inlineItems); }
          catch (error) {
            writeStatus({ status: "text_stream_failed" });
            reply = standaloneText === answer ? standaloneTextReply : await deliverStandaloneText(answer, error);
            // A failed inline packet is not an image delivery. The independent
            // text remains usable even if both image transports are unavailable.
            if (inlineItems.length) {
              inlineItems.length = 0;
              if (outcome === "success") outcome = "degraded";
              writeStatus({ status: "chart_failed" });
            }
          }
        }
        if (!answerVisible) metrics.mark("answerVisibleMs");
      } catch (error) {
        writeStatus({ status: "text_delivery_failed" });
        failureClass = error?.code === "REQUEST_DEADLINE_EXCEEDED" ? "deadline_exceeded" : error instanceof DeliveryTimeoutError ? "delivery_timeout" : "transport_failed";
        finishMetrics(routeMode, standaloneDelivered ? "standalone" : msgItem.length ? "failed" : "none", "failed");
        throw error;
      }
      if (inlineItems.length) {
        writeStatus({ status: "chart_inline_delivered" });
        writeStatus({ status: "chart_delivered" });
      }
      writeStatus({ status: "reply_completed", elapsedMs: Date.now() - receivedAtMs });
      finishMetrics(routeMode, standaloneDelivered ? "standalone" : inlineItems.length ? "inline" : msgItem.length ? "failed" : "none");
      return reply;
    }
  });
}

module.exports = {
  DEFAULT_ROUTE_MEMORY_MAX_ENTRIES,
  XBB_FOLLOW_UP_HANDOFF_ANSWER,
  appendVisualNotice,
  createLongConnectionHandler,
  createProgressPublisher,
  extractQuestion,
  normalizeRenderedImage,
  operationalFailure,
  isTransientRenderError,
  isTransientTransportError,
  isXbbOperationalHandoff,
  retryTransient,
  validateFrame
};
