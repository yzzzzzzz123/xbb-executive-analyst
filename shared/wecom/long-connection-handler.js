"use strict";

const crypto = require("node:crypto");
const { AgentTurnFailureError, AgentTurnTimeoutError, principalKeyFromUserId } = require("../codex/persistent-agent.js");
const { authorize, AccessDeniedError } = require("../security/access-control.js");
const { routeSkill } = require("../rag/skill-router.js");
const { chartTypeLabel, formatDuration } = require("../xbb/query-progress.js");
const { createWecomAnswerImage, createWecomChartImage, createWecomEmergencyImage } = require("./chart-image.js");
const { MessageStore, MessageStoreCapacityError } = require("./message-store.js");
const { createRequestMetrics } = require("../observability/request-metrics.js");
const { DeliveryTimeoutError, validateBudget, withinBudget } = require("./delivery-budget.js");

const DEFAULT_ROUTE_MEMORY_MAX_ENTRIES = 4096;
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

function createProgressPublisher({ deliver, updateState, drainBudgetMs = 6000 }) {
  validateBudget(drainBudgetMs);
  let pending = null;
  let running = false;
  let closed = false;
  let current = Promise.resolve();

  const pump = () => {
    if (running || closed) return current;
    running = true;
    current = (async () => {
      while (!closed && pending !== null) {
        const content = pending;
        pending = null;
        await deliver(content);
      }
    })().catch(() => { /* 中间进度失败不能阻断最终答复 */ }).finally(() => {
      running = false;
      if (!closed && pending !== null) void pump();
    });
    return current;
  };

  return Object.freeze({
    publish(content) {
      if (closed) return;
      const value = String(content || "").trim();
      if (!value) return;
      pending = value;
      updateState(value);
      void pump();
    },
    async flush() {
      do {
        if (!running && pending !== null) void pump();
        await current;
      } while (running || pending !== null);
    },
    async close() {
      closed = true;
      pending = null;
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
  answerRenderer = createWecomAnswerImage,
  emergencyImageFactory = createWecomEmergencyImage,
  retryWait = delay,
  renderAttempts = 2,
  // SDK upload chunks already retry three times. Do not multiply whole uploads.
  transportAttempts = 1,
  progressDrainBudgetMs = 6000,
  replyBudgetMs = 7000,
  renderBudgetMs = 10000,
  uploadBudgetMs = 15000,
  mediaDeliveryBudgetMs = 6000,
  routeMemoryMaxEntries = DEFAULT_ROUTE_MEMORY_MAX_ENTRIES
}) {
  if (!policy || !agent?.answer) throw new Error("企业微信长连接处理器初始化参数不完整。");
  if (!Number.isInteger(routeMemoryMaxEntries) || routeMemoryMaxEntries < 1) throw new Error("企业微信路由记忆上限无效。");
  [progressDrainBudgetMs, replyBudgetMs, renderBudgetMs, uploadBudgetMs, mediaDeliveryBudgetMs].forEach(validateBudget);
  // 应急图在启动阶段只生成和校验一次。运行时拒绝/渲染故障只复用这个不可变项，
  // 避免未授权消息触发 Sharp CPU 开销，也消除最后一级兜底再次抛错的窗口。
  const emergencyRender = normalizeRenderedImage(emergencyImageFactory());
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
      const userId = String(message.from?.userid || "");
      const question = String(extractQuestion(message) || "").trim();
      const inferredRoute = routeSkill(question, lastRouteByUser.get(userId) || null).mode;
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
          const items = inferredRoute === "xbb" ? [emergencyRender.item] : [];
          return client.replyStream(frame, streamIdFactory(), "当前请求已触发并发保护，系统仍在处理已接收的任务；本条未读取销帮帮，也未生成任何经营数字。", true, items);
        }
        const { state, isNew } = begun;
        if (isNew) {
          // 授权拒绝不是经营分析结果，且不得让未登记用户以不同 msgid 并发触发 Sharp。
          const items = inferredRoute === "xbb" ? [emergencyRender.item] : [];
          messageStore.complete(messageId, content, items);
        }
        return client.replyStream(frame, state.streamId, state.content, true, state.msgItem);
      }

      const initialContent = question
        ? "正在识别问题范围和分析维度……"
        : "目前仅支持文字、语音转文字或图文中的文字问题。";
      let begun;
      try {
        begun = messageStore.begin({ messageId, userId, streamId: streamIdFactory(), content: initialContent });
      } catch (storeError) {
        if (!(storeError instanceof MessageStoreCapacityError)) throw storeError;
        const items = inferredRoute === "xbb" ? [emergencyRender.item] : [];
        return client.replyStream(frame, streamIdFactory(), "当前请求已触发并发保护，系统仍在处理已接收的任务；本条未读取销帮帮，也未生成任何经营数字。", true, items);
      }
      const { state, isNew } = begun;

      if (!isNew) return client.replyStream(frame, state.streamId, state.content, state.finish, state.finish ? state.msgItem : undefined);
      const metrics = createRequestMetrics();
      let outcome = "success";
      const finishMetrics = (routeMode, imageDelivery, result = outcome) => {
        const value = metrics.finish({ routeMode, imageDelivery, outcome: result });
        if (value) writeStatus(value);
      };
      const replyStream = (content, finish, items) => withinBudget(
        () => client.replyStream(frame, state.streamId, content, finish, items), replyBudgetMs
      );
      writeStatus({ status: "message_received" });
      if (!question) {
        messageStore.complete(messageId, initialContent);
        let reply;
        try { reply = await replyStream(initialContent, true); }
        catch (error) { finishMetrics(inferredRoute, "none", "failed"); throw error; }
        metrics.mark("firstReplyMs");
        finishMetrics(inferredRoute, "none", "unsupported");
        writeStatus({ status: "reply_completed", elapsedMs: Date.now() - receivedAtMs });
        return reply;
      }

      try {
        await replyStream(initialContent, false);
        metrics.mark("firstReplyMs");
      } catch (error) {
        messageStore.delete(messageId);
        finishMetrics(inferredRoute, "none", "failed");
        throw error;
      }

      let answer;
      let chart = null;
      let routeMode = inferredRoute;
      let heartbeat;
      let onProgress;
      let progressPublisher;
      let usePrebuiltOperationalImage = false;
      try {
        let latestStage = initialContent;
        progressPublisher = createProgressPublisher({
          deliver: (content) => client.replyStream(frame, state.streamId, content, false),
          updateState: (content) => messageStore.update(messageId, content),
          drainBudgetMs: progressDrainBudgetMs
        });
        onProgress = (content) => {
          latestStage = String(content || "").trim() || latestStage;
          progressPublisher.publish(latestStage);
        };
        heartbeat = setInterval(() => {
          const seconds = Math.max(1, Math.floor((Date.now() - receivedAtMs) / 1000));
          progressPublisher.publish(`${latestStage}\n已用时：${formatDuration(seconds)}；当前阶段仍在继续。`);
        }, heartbeatMs);
        heartbeat.unref?.();
        const result = await metrics.measure("analysisMs", () => agent.answer({
          question,
          access,
          principalKey: principalKeyFactory(userId, access),
          messageId,
          onProgress,
          onTiming: (event) => metrics.addQueryTiming(event)
        }));
        answer = typeof result === "string" ? result : result.answer;
        chart = typeof result === "object" && result ? result.chart : null;
        if (result?.routeMode === "xbb" || result?.routeMode === "general") routeMode = result.routeMode;
        usePrebuiltOperationalImage = isXbbOperationalHandoff(result);
      } catch (error) {
        outcome = "failed";
        answer = operationalFailure(error);
        if (error?.routeMode === "xbb") routeMode = "xbb";
        usePrebuiltOperationalImage = routeMode === "xbb";
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        metrics.mark("answerReadyMs");
        if (progressPublisher) await metrics.measure("progressDrainMs", () => progressPublisher.close());
      }
      rememberRoute(userId, routeMode);
      const requiresImage = routeMode === "xbb";
      let answerVisible = false;
      if (requiresImage || chart) {
        // Send a complete readable answer before rasterization or upload. This
        // remains the same stream; the final packet still includes an image or
        // follows successful standalone delivery. No generic progress replaces it.
        const visible = `${answer}\n\n${chart ? `正在制作：${chartTypeLabel(chart.type)}` : "正在准备结论辅助图"}，图片随后补齐。`;
        messageStore.update(messageId, visible);
        try {
          await replyStream(visible, false);
          answerVisible = true;
          metrics.mark("answerVisibleMs");
        } catch { /* Final reply retains the complete answer and image for replay. */ }
      }
      let msgItem = [];
      let imageBuffer = null;
      let imageRender = null;
      if (chart) {
        try {
          const rendered = normalizeRenderedImage(await metrics.measure("renderMs", () => withinBudget((isOpen) => retryTransient(() => chartRenderer(chart), {
            canAttempt: isOpen,
            attempts: renderAttempts,
            wait: retryWait,
            shouldRetry: (error) => isOpen() && isTransientRenderError(error)
          }), renderBudgetMs)));
          msgItem = [rendered.item];
          imageBuffer = rendered.buffer;
          writeStatus({ status: "chart_generated" });
        } catch {
          if (outcome === "success") outcome = "degraded";
          writeStatus({ status: "chart_failed" });
          answer = appendVisualNotice(answer, "（数据图生成暂时异常，已自动改用结论速览图；文字口径不变。）");
        }
      }
      if (requiresImage && !msgItem.length) {
        if (usePrebuiltOperationalImage) {
          imageRender = emergencyRender;
          msgItem = [emergencyRender.item];
          // 交接/恢复答复可能在洪泛收敛时批量产生。直接内嵌启动期预构建图片，
          // 不为每条消息并发调用 Sharp，也不重复上传同一张占位图。
          imageBuffer = null;
        } else {
          try {
            imageRender = normalizeRenderedImage(await metrics.measure("renderMs", () => withinBudget((isOpen) => retryTransient(() => answerRenderer(answer), {
              canAttempt: isOpen,
              attempts: renderAttempts,
              wait: retryWait,
              shouldRetry: (error) => isOpen() && isTransientRenderError(error)
            }), renderBudgetMs)));
            msgItem = [imageRender.item];
            imageBuffer = imageRender.buffer;
            writeStatus({ status: "chart_generated" });
          } catch {
            if (outcome === "success") outcome = "degraded";
            imageRender = emergencyRender;
            msgItem = [emergencyRender.item];
            imageBuffer = emergencyRender.buffer;
            answer = appendVisualNotice(answer, "（可视化引擎暂时异常，已附安全占位图；本条文字结论仍按原口径保留。）");
            writeStatus({ status: "chart_failed" });
          }
        }
      }
      let uploadedMediaId = null;
      const target = message.chattype === "group" ? String(message.chatid || "") : userId;
      if (imageBuffer && target && typeof client.uploadMedia === "function" && typeof client.sendMediaMessage === "function") {
        try {
          const uploaded = await metrics.measure("uploadMs", () => withinBudget((isOpen) => retryTransient(
            async () => {
              const result = await client.uploadMedia(imageBuffer, { type: "image", filename: "经营分析图表.png" });
              if (!result?.media_id) throw new Error("企业微信未返回图片 media_id。");
              return result;
            },
            { attempts: transportAttempts, canAttempt: isOpen, wait: retryWait, shouldRetry: (error) => isOpen() && isTransientTransportError(error) }
          ), uploadBudgetMs));
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
          await metrics.measure("mediaDeliveryMs", () => withinBudget((isOpen) => retryTransient(
            () => client.sendMediaMessage(target, "image", uploadedMediaId),
            { attempts: Math.min(2, transportAttempts), canAttempt: isOpen, wait: retryWait, shouldRetry: (error) => isOpen() && isTransientTransportError(error) }
          ), mediaDeliveryBudgetMs));
          standaloneDelivered = true;
          writeStatus({ status: "chart_delivered" });
        } catch {
          if (outcome === "success") outcome = "degraded";
          standaloneDelivered = false;
          writeStatus({ status: "chart_media_delivery_failed" });
        }
      }
      const inlineItems = standaloneDelivered ? [] : msgItem;
      // 首次若已用独立 media 消息送图，正文不重复内嵌；缓存仍保存完整图片项，
      // 让企业微信重放同一 msgid 时也不会只收到文字。
      messageStore.complete(messageId, answer, msgItem);
      let reply;
      try {
        reply = await replyStream(answer, true, inlineItems);
        if (!answerVisible) metrics.mark("answerVisibleMs");
      } catch (error) {
        finishMetrics(routeMode, standaloneDelivered ? "standalone" : msgItem.length ? "failed" : "none", "failed");
        throw error;
      }
      if (inlineItems.length) {
        writeStatus({ status: "chart_inline_delivered" });
        writeStatus({ status: "chart_delivered" });
      }
      writeStatus({ status: "reply_completed", elapsedMs: Date.now() - receivedAtMs });
      finishMetrics(routeMode, standaloneDelivered ? "standalone" : inlineItems.length ? "inline" : "none");
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
