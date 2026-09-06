"use strict";
const crypto = require("node:crypto");
const { problem } = require("./work-protocol");
function createNativeDocumentEditor({ im, now = Date.now }) {
  const tickets = new Map(), sessions = new Map();
  const key = () => crypto.randomBytes(32).toString("base64url");
  const cleanup = () => {
    for (const table of [tickets, sessions]) for (const [key, value] of table) if (value.expires_at <= now()) table.delete(key);
  };
  function authorize(access, documentName) {
    const s = sessions.get(access);
    if (!s || s.expires_at <= now()) throw problem(401, "editor_session_expired", "编辑会话已过期，请从人机重新打开文档");
    if (documentName !== `doc-${s.document_id}`) throw problem(403, "document_scope", "编辑会话仅适用于这篇文档");
    const principal = im.authorizeDocument(s.credential, s.room_id, s.document_id);
    return { ...s, principal };
  }
  async function issue(credential, roomId, documentId) {
    cleanup();
    if (tickets.size + sessions.size >= 1000) throw problem(429, "editor_capacity", "编辑会话较多，请稍后重试");
    const value = await im.handle("GET", `/api/im/rooms/${roomId}/documents/${documentId}`, {}, credential);
    if (value.document.contract) throw problem(409, "immutable_record", "任务契约和提案使用专用审阅界面");
    im.authorizeDocument(credential, roomId, documentId);
    const ticket = key();
    tickets.set(ticket, { credential, room_id: roomId, document_id: documentId, expires_at: now() + 60000 });
    return { path: `/office-document#open=${ticket}`, expires_in: 60, scope: "single_document" };
  }
  function exchange(ticket) {
    const s = tickets.get(ticket); tickets.delete(ticket);
    if (!s || s.expires_at <= now()) throw problem(401, "editor_ticket_expired", "打开链接已使用或过期，请从人机重新打开");
    const principal = im.authorizeDocument(s.credential, s.room_id, s.document_id);
    const access = "office-doc_" + key(), expires_at = now() + 30 * 60 * 1000;
    sessions.set(access, { ...s, expires_at });
    return { access_token: access, document_id: s.document_id, room_id: s.room_id,
      principal, expires_at, scope: "single_document" };
  }
  async function read(access) {
    const entry = sessions.get(access);
    const s = authorize(access, `doc-${entry?.document_id}`);
    return im.handle("GET", `/api/im/rooms/${s.room_id}/documents/${s.document_id}`, {}, s.credential);
  }
  function close(access) { sessions.delete(access); return { closed: true }; }
  return { issue, exchange, authorize, read, close };
}
module.exports = { createNativeDocumentEditor };
