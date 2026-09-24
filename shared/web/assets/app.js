"use strict";

const $ = (id) => document.getElementById(id);
let csrf = null;
let currentJob = null;
let polling = null;
let generation = 0;
let busy = false;
let serviceReady = false;
let pendingRequest = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function notice(text = "") { $("notice").textContent = text; $("notice").hidden = !text; }
function connection(ready, text) {
  serviceReady = ready;
  $("connection-text").textContent = text || (ready ? "服务已连接" : "正在连接分析服务");
  $("connection-dot").classList.toggle("offline", !ready);
  updateComposer();
}
function updateComposer() {
  $("send").hidden = busy;
  $("stop").hidden = !busy;
  $("stop").disabled = !currentJob;
  $("send").disabled = !serviceReady || !$("question").value.trim();
  $("question").readOnly = busy;
}
function clearChat() {
  generation += 1; clearTimeout(polling); currentJob = null; busy = false; pendingRequest = null;
  $("messages").replaceChildren(); $("welcome").hidden = false; notice(); updateComposer();
}
function loginScreen(message = "") {
  csrf = null; clearChat();
  $("workspace").hidden = true; $("login-screen").hidden = false;
  $("chart-dialog").close(); $("chart-large").removeAttribute("src");
  $("login-error").textContent = message;
}
async function api(url, body) {
  let response;
  try {
    response = await fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch { throw new Error("连接暂时中断，请检查网络后重试。"); }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/login") loginScreen("登录已过期，请重新输入访问码。");
    throw Object.assign(new Error(data.error || "请求未完成，请重试。"), { status: response.status });
  }
  return data;
}
function inlineText(node, value) {
  // Text nodes only: model HTML, links and image markup are never executed.
  const parts = value.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) node.append(element("strong", "", part.slice(2, -2)));
    else if (part.startsWith("`") && part.endsWith("`")) node.append(element("code", "", part.slice(1, -1)));
    else node.append(document.createTextNode(part));
  }
}
function renderAnswer(root, text) {
  root.replaceChildren();
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (/^```/.test(line)) {
      const code = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]); i += 1) code.push(lines[i]);
      root.append(element("pre", "", code.join("\n"))); i += 1; continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const table = element("table");
      const head = element("tr");
      for (const cell of cells(line)) { const th = element("th"); inlineText(th, cell); head.append(th); }
      const thead = element("thead"); thead.append(head); table.append(thead);
      const tbody = element("tbody"); i += 2;
      for (; i < lines.length && lines[i].includes("|") && lines[i].trim(); i += 1) {
        const row = element("tr"); for (const cell of cells(lines[i])) { const td = element("td"); inlineText(td, cell); row.append(td); } tbody.append(row);
      }
      table.append(tbody); const wrap = element("div", "table-scroll"); wrap.append(table); root.append(wrap); continue;
    }
    const heading = /^#{1,6}\s+(.+)/.exec(line);
    if (heading) { const h = element("h3"); inlineText(h, heading[1]); root.append(h); i += 1; continue; }
    if (/^\s*(?:[-*] |\d+[.)] )/.test(line)) {
      const list = element(/^\s*\d/.test(line) ? "ol" : "ul");
      for (; i < lines.length && /^\s*(?:[-*] |\d+[.)] )/.test(lines[i]); i += 1) {
        const item = element("li"); inlineText(item, lines[i].replace(/^\s*(?:[-*] |\d+[.)] )/, "")); list.append(item);
      }
      root.append(list); continue;
    }
    const paragraph = element("p"); inlineText(paragraph, line); root.append(paragraph); i += 1;
  }
}
function scrollDown() { $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight; }
function questionBubble(text) {
  $("welcome").hidden = true;
  const row = element("div", "message message-user"); row.append(element("div", "user-bubble", text)); $("messages").append(row);
}
function answerBubble() {
  const row = element("article", "message message-assistant");
  const head = element("div", "answer-head"); head.append(element("span", "answer-avatar", "✳"), element("span", "", "经营分析助手"));
  const elapsed = element("span", "elapsed"); head.append(elapsed);
  const body = element("div", "answer-body");
  const progress = element("div", "progress"); progress.append(element("span", "spinner")); const label = element("span", "", "正在接收问题"); progress.append(label);
  row.append(head, body, progress); $("messages").append(row); scrollDown();
  return { row, body, progress, label, elapsed, rendered: null, finished: false };
}
function displayJob(job, bubble) {
  const nearBottom = $("chat-scroll").scrollHeight - $("chat-scroll").scrollTop - $("chat-scroll").clientHeight < 150;
  bubble.elapsed.textContent = job.elapsedSeconds < 60 ? `${job.elapsedSeconds} 秒` : `${Math.floor(job.elapsedSeconds / 60)} 分 ${job.elapsedSeconds % 60} 秒`;
  bubble.label.textContent = job.progress;
  if (job.answer && bubble.rendered !== job.answer) { renderAnswer(bubble.body, job.answer); bubble.rendered = job.answer; }
  if (job.status !== "running" && !bubble.finished) {
    bubble.finished = true; bubble.progress.remove();
    if (job.error) { bubble.body.replaceChildren(element("p", "answer-error", job.error)); }
    if (job.chartUrl) {
      const button = element("button", "chart-button"); button.type = "button"; button.setAttribute("aria-label", "查看经营图大图");
      const img = element("img"); img.alt = "本次经营分析图"; img.src = job.chartUrl; img.loading = "lazy";
      img.addEventListener("error", () => { button.replaceChildren(element("span", "chart-caption", "图片已过期，请重新提问生成。")); button.disabled = true; });
      button.append(img); button.addEventListener("click", () => { $("chart-large").src = job.chartUrl; $("chart-dialog").showModal(); });
      bubble.row.append(button, element("div", "chart-caption", "点击图片放大查看完整经营图"));
    }
    const actions = element("div", "answer-actions");
    if (job.answer) {
      const copy = element("button", "", "复制文字"); copy.type = "button";
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(job.answer); copy.textContent = "已复制"; } catch { copy.textContent = "请选中文字复制"; } }); actions.append(copy);
    }
    if (job.chartUrl) { const link = element("a", "", "下载经营图"); link.href = job.chartUrl; link.download = "经营分析.png"; actions.append(link); }
    if (job.status === "error") { const retry = element("button", "", "重新提问"); retry.type = "button"; retry.addEventListener("click", () => { $("question").value = job.question; updateComposer(); $("question").focus(); }); actions.append(retry); }
    bubble.row.append(actions);
  }
  if (nearBottom) scrollDown();
}
async function pollJob(id, bubble, turn) {
  if (turn !== generation || !csrf) return;
  try {
    const job = await api(`/api/jobs/${id}`);
    if (turn !== generation) return;
    connection(true); notice(); displayJob(job, bubble);
    if (job.status !== "running") { busy = false; currentJob = null; updateComposer(); $("question").focus(); return; }
  } catch (error) {
    if (turn !== generation || !csrf) return;
    if (error.status === 404) {
      displayJob({ status: "error", elapsedSeconds: 0, error: "这次分析已过期，请重新提问。", question: "" }, bubble);
      busy = false; currentJob = null; updateComposer(); return;
    }
    notice("连接暂时中断，正在自动重连；分析仍会继续。"); connection(false, "正在重连");
  }
  polling = setTimeout(() => void pollJob(id, bubble, turn), 1500);
}
async function openWorkspace(session) {
  csrf = session.csrf; $("login-screen").hidden = true; $("workspace").hidden = false;
  $("access-code").value = ""; connection(session.ready); clearChat();
  if (session.lastJob) {
    try {
      const job = await api(`/api/jobs/${session.lastJob}`);
      questionBubble(job.question); const bubble = answerBubble(); displayJob(job, bubble);
      if (job.status === "running") { busy = true; currentJob = job.id; updateComposer(); void pollJob(job.id, bubble, generation); }
    } catch (error) { if (error.status !== 404) notice(error.message); }
  }
  if (!session.ready) notice("分析服务正在连接，连接完成后即可提问。");
  $("question").focus();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("login-submit").disabled = true; $("login-error").textContent = "";
  try { await openWorkspace(await api("/api/login", { code: $("access-code").value.trim() })); }
  catch (error) { $("login-error").textContent = error.message; }
  finally { $("login-submit").disabled = false; }
});
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const question = $("question").value.trim();
  if (!question || busy || !serviceReady) return;
  const turn = generation; busy = true; updateComposer(); notice();
  if (!pendingRequest || pendingRequest.question !== question) pendingRequest = { question, requestId: crypto.randomUUID() };
  try {
    const job = await api("/api/messages", pendingRequest);
    if (turn !== generation) return;
    pendingRequest = null; $("question").value = "";
    questionBubble(question); const bubble = answerBubble(); currentJob = job.id; updateComposer();
    void pollJob(job.id, bubble, turn);
  } catch (error) { if (turn === generation) {
    busy = false; updateComposer(); notice(error.message);
    if (error.status === 409) {
      try { await openWorkspace(await api("/api/session")); } catch {}
    }
  } }
});
$("question").addEventListener("input", updateComposer);
$("question").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $("chat-form").requestSubmit(); } });
for (const button of document.querySelectorAll("[data-question]")) button.addEventListener("click", () => { if (busy) return; $("question").value = button.dataset.question; updateComposer(); $("question").focus(); });
$("stop").addEventListener("click", async () => { if (!currentJob) return; $("stop").disabled = true; try { await api(`/api/jobs/${currentJob}/cancel`, {}); } catch (error) { notice(error.message); $("stop").disabled = false; } });
$("logout").addEventListener("click", async () => { try { await api("/api/logout", {}); loginScreen(); } catch (error) { notice(error.message); } });
$("close-chart").addEventListener("click", () => $("chart-dialog").close());
$("chart-dialog").addEventListener("close", () => $("chart-large").removeAttribute("src"));
document.addEventListener("visibilitychange", () => { if (!document.hidden && csrf && !busy) void checkHealth(); });
async function checkHealth() {
  if (!csrf || busy) return;
  try { const health = await api("/api/health"); connection(health.ready); if (health.ready) notice(); }
  catch { connection(false, "连接已中断"); notice("体验服务暂时无法连接，请稍后再试。"); }
}
setInterval(() => void checkHealth(), 15000);
void api("/api/session").then(openWorkspace).catch(() => loginScreen());
