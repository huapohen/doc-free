"use strict";

// The contract lives in an ordinary, exportable document. There is no second
// mission database: UI, REST, MCP and workers parse this same visible block.
const crypto = require("node:crypto");
const PROTOCOL = "active-doc/v1";
const CONTRACT = /```active-agent\n([\s\S]*?)\n```/;
function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function parseContract(document) {
  const match = String(document.content || "").match(CONTRACT);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return value && value.protocol === PROTOCOL ? value : null;
  } catch { return null; }
}
function contractDocument(title, contract, body = "") {
  return `# ${title}\n\n\`\`\`active-agent\n${JSON.stringify({ protocol: PROTOCOL, ...contract }, null, 2)}\n\`\`\`\n\n${body}`;
}
function updateContract(document, values) {
  const current = parseContract(document);
  if (!current) throw problem(422, "invalid_contract", "文档缺少有效的 active-agent 契约");
  return document.content.replace(CONTRACT, () => `\`\`\`active-agent\n${JSON.stringify({ ...current, ...values }, null, 2)}\n\`\`\``);
}
function problem(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function requireText(value, name, max = 20000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw problem(422, "invalid_input", `${name} 必须是 1–${max} 字符的文本`);
  return value;
}
function validateMission(value) {
  if (!value || value.kind !== "mission") throw problem(422, "invalid_contract", "无效任务契约");
  requireText(value.objective, "objective", 4000);
  requireText(value.source_document_id, "source_document_id", 100);
  if (!["active", "paused", "completed"].includes(value.status)) throw problem(422, "invalid_contract", "无效任务状态");
  if (!Number.isInteger(value.quiet_seconds) || value.quiet_seconds < 2 || value.quiet_seconds > 3600)
    throw problem(422, "invalid_contract", "quiet_seconds 必须在 2–3600 之间");
  return value;
}
function snapshot(document) {
  return { id: document.id, title: document.title, content: document.content,
    revision: Number(document.revision || 0), updated_at: document.updatedAt,
    content_hash: fingerprint(document.content), contract: parseContract(document) };
}
module.exports = { PROTOCOL, fingerprint, parseContract, contractDocument, updateContract,
  problem, requireText, validateMission, snapshot };
