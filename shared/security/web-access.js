"use strict";

const crypto = require("node:crypto");
const { authorize } = require("./access-control.js");

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");

function validateInvitations(invitations) {
  if (!Array.isArray(invitations) || !invitations.length || invitations.length > 100) throw new Error("请在仓库外配置网页访问码。");
  const ids = new Set();
  for (const entry of invitations) {
    if (!entry || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) || ids.has(entry.id)
      || !/^[a-f0-9]{64}$/.test(entry.codeHash) || entry.scope !== "all"
      || !Number.isFinite(Date.parse(entry.expiresAt))) throw new Error("网页访问码配置无效；本入口仅允许显式的集团只读授权。");
    ids.add(entry.id);
  }
  return invitations;
}

function createWebAccess({ invitations, now = Date.now, sessionTtlMs = 8 * 60 * 60 * 1000, maxSessions = 100, onRevoke = () => {} }) {
  validateInvitations(invitations);
  const sessions = new Map();
  const liveGrant = (id) => invitations.find((g) => g.id === id && !g.disabled && Date.parse(g.expiresAt) > now());
  function revoke(id) {
    const session = sessions.get(id);
    if (session) { sessions.delete(id); onRevoke(session); }
  }
  function sweep() {
    for (const [id, s] of sessions) if (s.expiresAt <= now() || !liveGrant(s.grantId)) revoke(id);
  }
  function login(code) {
    sweep();
    const hash = Buffer.from(digest(typeof code === "string" && code.length <= 256 ? code.trim() : ""), "hex");
    let grant;
    for (const g of invitations) {
      if (crypto.timingSafeEqual(hash, Buffer.from(g.codeHash, "hex")) && liveGrant(g.id)) grant = g;
    }
    if (!grant) return null;
    if (sessions.size >= maxSessions) throw Object.assign(new Error("体验人数已达上限，请稍后再试。"), { status: 429 });
    const id = token();
    const userId = `web:${grant.id}:${id}`;
    const session = {
      id, grantId: grant.id, csrf: token(),
      expiresAt: Math.min(now() + sessionTtlMs, Date.parse(grant.expiresAt)),
      access: authorize({ users: { [userId]: { scope: "all" } } }, userId),
      principalKey: digest(JSON.stringify({ channel: "invited-web", userId, conversation: token(), scope: "all" })),
      activeJob: null, lastJob: null, messageTimes: [], resetTimes: []
    };
    sessions.set(id, session);
    return session;
  }
  function get(id) { sweep(); return typeof id === "string" ? sessions.get(id) || null : null; }
  function reset(session) {
    onRevoke(session);
    session.principalKey = digest(JSON.stringify({ channel: "invited-web", userId: session.access.userId, conversation: token(), scope: "all" }));
    session.activeJob = null;
    session.lastJob = null;
  }
  return { login, get, revoke, reset, sweep, close() { for (const id of sessions.keys()) revoke(id); } };
}

module.exports = { createWebAccess, validateInvitations, digest };
