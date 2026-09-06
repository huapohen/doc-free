"use strict";
const crypto = require("node:crypto");
const Y = require("yjs");
const { problem } = require("./work-protocol");
const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, stable(v[key])])) : v;
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");
const stateHash = (document) => crypto.createHash("sha256").update(Y.encodeStateAsUpdate(document)).digest("hex");

// Build an isolated candidate, durably commit its content and receipt together,
// then publish the same Y update to connected editors. No asynchronous gap is
// permitted between comparison, deadline check, persistence and publication.
function commitDocumentOperation({ document, input, mode, read, replace, persist, now = Date.now }) {
  if (!input || typeof input.document_id !== "string" || input.document_id.length > 100 ||
      typeof input.content !== "string" || input.content.length > 200000 ||
      typeof input.title !== "string" || !input.title.trim() || input.title.length > 200)
    throw problem(422, "invalid_document", "无效文档正文或标题");
  if (!["replace", "compare-replace", "create-once"].includes(mode)) throw problem(422, "invalid_operation", "无效文档动作");
  const op = input.operation_id;
  if (op !== undefined && (typeof op !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(op)))
    throw problem(422, "invalid_operation_id", "无效动作标识");
  if (input.input_hash !== undefined && (typeof input.input_hash !== "string" || !/^[a-f0-9]{64}$/.test(input.input_hash)))
    throw problem(422, "invalid_input_hash", "无效动作输入摘要");
  if (input.deadline_ms !== undefined && !Number.isSafeInteger(input.deadline_ms))
    throw problem(422, "invalid_deadline", "无效提交截止时间");
  if (op && (!Number.isSafeInteger(input.result_revision) || input.result_revision < 1))
    throw problem(422, "invalid_revision", "动作需要有效结果版本");
  const requestHash = hash({ mode, document_id: input.document_id, title: input.title, content: input.content,
    expected_content: input.expected_content, expected_title: input.expected_title,
    expected_state_hash: input.expected_state_hash, result_revision: input.result_revision,
    actor_id: input.actor_id, before_revision: input.before_revision });
  const receipt = op && document.getMap("active-agent-operations").get(op);
  if (receipt) {
    if ((receipt.input_hash && receipt.input_hash !== input.input_hash) ||
        (receipt.request_hash && receipt.request_hash !== requestHash) || (!receipt.request_hash && input.input_hash))
      throw problem(409, "idempotency_conflict", "同一动作已使用不同输入或旧版回执");
    // Legacy proposal receipts remain readable by their legacy caller.
    return { ok: true, duplicate: true, receipt, ...read(document), state_hash: stateHash(document) };
  }
  const current = read(document);
  if (mode === "create-once" && current.initialized)
    throw problem(409, "document_exists", "文档已存在，创建动作不能覆盖正文");
  if (mode === "compare-replace" && (current.content !== input.expected_content ||
      (input.expected_title !== undefined && current.title !== input.expected_title) ||
      (input.expected_state_hash !== undefined && stateHash(document) !== input.expected_state_hash)))
    throw problem(409, "conflict", "协作正文已变化");
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    let committed;
    candidate.transact(() => {
      replace(candidate, input.content, input.title);
      if (op) {
        committed = { revision: input.result_revision, before_revision: input.before_revision ?? null,
          input_hash: input.input_hash || null, request_hash: requestHash, actor_id: input.actor_id || null,
          content_hash: crypto.createHash("sha256").update(read(candidate).content).digest("hex"),
          title: read(candidate).title,
          committed_at: new Date(now()).toISOString() };
        candidate.getMap("active-agent-operations").set(op, committed);
      }
    });
    if (input.deadline_ms !== undefined && now() >= input.deadline_ms)
      throw problem(409, "commit_deadline_expired", "提交截止时间已过，本动作未写入");
    persist(candidate);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(candidate));
    return { ok: true, duplicate: false, receipt: committed || null, ...read(document), state_hash: stateHash(document) };
  } finally { candidate.destroy(); }
}
module.exports = { commitDocumentOperation, stateHash };
