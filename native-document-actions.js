"use strict";
const { fingerprint, problem, requireText, parseContract } = require("./work-protocol");

// Canonical documents remain in Doc Free. The IM stores intent before calling
// this adapter and reconciles a separate durable CRDT receipt after a crash.
function createNativeDocumentActions({ read, create, write, lock, recover }) {
  function prepare(input, actor) {
    if (!["im_create_document", "im_update_document"].includes(input.operation))
      throw problem(422, "unsupported_operation", "不支持此文档动作");
    const operation_id = requireText(input.operation_id, "operation_id", 160);
    if (!/^[a-f0-9]{64}$/.test(input.input_hash || "")) throw problem(422, "invalid_input_hash", "动作输入摘要无效");
    const args = input.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args) ||
        Object.keys(args).some((key) => !(input.operation === "im_create_document"
          ? ["title", "content"] : ["title", "content", "document_id", "base_revision"]).includes(key)))
      throw problem(422, "invalid_operation_arguments", "无效文档动作参数");
    if (input.operation === "im_create_document" || args.title !== undefined) requireText(args.title, "title", 200);
    if ((input.operation === "im_create_document" || args.content !== undefined) &&
        (typeof args.content !== "string" || args.content.length > 200000)) throw problem(422, "invalid_content", "无效文档正文");
    if (input.operation === "im_update_document" && (!Number.isSafeInteger(args.base_revision) || args.base_revision < 1))
      throw problem(422, "version_required", "文档更新需要版本");
    const id = input.operation === "im_create_document" ? `action-doc-${fingerprint(`${actor}:${operation_id}`).slice(0, 32)}`
      : requireText(args.document_id, "document_id", 100);
    return { operation: input.operation, operation_id, input_hash: input.input_hash, document_id: id,
      actor_id: actor, arguments: JSON.parse(JSON.stringify(args)) };
  }
  function checkActor(intent, actor) {
    if (intent.actor_id !== actor) throw problem(403, "operation_owner_required", "文档动作属于另一位同事");
  }
  async function recovered(intent, { actor_id }) {
    checkActor(intent, actor_id);
    return lock(intent.document_id, () => recover(intent.document_id, intent.operation_id, intent.input_hash, actor_id));
  }
  async function apply(intent, { actor_id, deadline_ms, beforeCommit }) {
    checkActor(intent, actor_id);
    if (!Number.isSafeInteger(deadline_ms) || deadline_ms <= Date.now() || deadline_ms > Date.now() + 15000)
      throw problem(409, "commit_deadline_expired", "文档动作需要有效的短期提交截止时间");
    return lock(intent.document_id, async () => {
      const existing = await recover(intent.document_id, intent.operation_id, intent.input_hash, actor_id);
      if (existing) return existing;
      const args = intent.arguments;
      const meta = { actor_id, operation_id: intent.operation_id, input_hash: intent.input_hash,
        deadline_ms, beforeCommit, operation: intent.operation };
      try {
        if (intent.operation === "im_create_document") {
          if (parseContract({ content: args.content })) throw problem(422, "invalid_contract", "原生活动只创建普通正文，任务契约使用专用接口");
          await create({ id: intent.document_id, title: args.title, content: args.content }, { ...meta, create_once: true });
        } else {
          const document = await read(intent.document_id);
          if (!document) throw problem(404, "not_found", "文档不存在");
          if (parseContract(document) || parseContract({ content: args.content || "" }))
            throw problem(409, "immutable_record", "契约、运行记录和提案通过专用审阅动作更新");
          await write(document, args.content ?? document.content, { ...meta, base_version: args.base_revision,
            title: args.title ?? document.title, before_revision: args.base_revision });
        }
      } catch (error) {
        // A transport failure cannot release the IM queue while an old request
        // remains authorized to commit. The receiver checks this same deadline.
        if (!Number.isInteger(error.status) || error.status >= 500) {
          const remaining = deadline_ms - Date.now();
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
          const result = await recover(intent.document_id, intent.operation_id, intent.input_hash, actor_id);
          if (result) return result;
        }
        throw error;
      }
      const result = await recover(intent.document_id, intent.operation_id, intent.input_hash, actor_id);
      if (!result) throw problem(503, "document_commit_unknown", "文档回执尚未确认，保留意图等待恢复");
      return { ...result, duplicate: false };
    });
  }
  return { prepare, apply, recover: recovered };
}
module.exports = { createNativeDocumentActions };
