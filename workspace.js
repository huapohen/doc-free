"use strict";

const { fingerprint, parseContract, contractDocument, updateContract, problem,
  requireText, validateMission, snapshot } = require("./work-protocol");

// No IM dependency. This adapter only needs canonical document operations.
function createWorkspace({ documents, read, create, write, lock, events, save, state }) {
  state.receipts ||= {};
  const get = async (id) => {
    const document = await read(id);
    if (!document) throw problem(404, "not_found", "文档不存在");
    return document;
  };
  const stableId = (kind, key) => `${kind}-${fingerprint(key).slice(0, 24)}`;
  const requireVersion = (input) => {
    if (!Number.isInteger(input.base_revision) || input.base_revision < 0)
      throw problem(422, "version_required", "请提供读取到的 base_revision");
  };
  async function list() {
    // Read the live CRDT projection so browser-only edits also reach workers.
    const result = [];
    for (const document of [...documents()]) result.push(snapshot(await get(document.id)));
    return { protocol: "active-doc/v1", documents: result, cursor: events().at(-1)?.seq || 0 };
  }
  async function createMission(input, actor) {
    const source = await get(requireText(input.source_document_id, "source_document_id", 100));
    if (parseContract(source)) throw problem(422, "invalid_source", "请选择正文文档作为任务来源");
    const contract = validateMission({ kind: "mission", objective: input.objective,
      source_document_id: source.id, status: "active", quiet_seconds: input.quiet_seconds ?? 8 });
    return snapshot(await create({ title: `任务 · ${source.title}`, content: contractDocument(
      `任务 · ${source.title}`, { ...contract, created_by: actor, created_at: new Date().toISOString() },
      "## 工作约定\n\nAgent 在正文停止变化后自动检查目标，给出带原文依据的修改提案。\n\n" +
      "人在正文中继续编辑；所有提案均需明确接受后才写入来源文档。可以随时暂停任务。\n\n" +
      `## 来源\n\n[${source.title}](/workbench#${source.id})\n`) }, { actor_id: actor }));
  }
  async function edit(id, input, actor) {
    requireVersion(input);
    return lock(id, async () => {
      const d = await get(id);
      const content = typeof input.content === "string" ? input.content : d.content;
      if (content.length > 200000) throw problem(413, "too_large", "正文超过 200000 字符");
      const oldContract = parseContract(d), next = parseContract({ content });
      if (oldContract && oldContract.kind !== "mission")
        throw problem(409, "immutable_record", "运行记录和提案通过审阅动作更新");
      if (oldContract && (!next || next.kind !== oldContract.kind))
        throw problem(422, "invalid_contract", "不能移除任务契约");
      if (next) {
        validateMission(next);
        const source = await get(next.source_document_id);
        if (source.id === d.id || parseContract(source)) throw problem(422, "invalid_source", "任务只能关注正文文档");
      }
      return snapshot(await write(d, content, { base_version: input.base_revision,
        title: requireText(input.title ?? d.title, "title", 200), actor_id: actor }));
    });
  }
  async function changeStatus(id, input, actor) {
    requireVersion(input);
    if (!["active", "paused", "completed"].includes(input.status)) throw problem(422, "invalid_status", "无效状态");
    return lock(id, async () => {
      const d = await get(id);
      validateMission(parseContract(d));
      return snapshot(await write(d, updateContract(d, { status: input.status }), {
        base_version: input.base_revision, actor_id: actor, operation: "mission_status" }));
    });
  }
  async function publishRun(input, actor) {
    const missionId = requireText(input.mission_id, "mission_id", 100);
    return lock(missionId, async () => {
      const mission = await get(missionId), contract = validateMission(parseContract(mission));
      const source = await get(contract.source_document_id);
      if (!Number.isInteger(input.mission_revision) || !Number.isInteger(input.source_revision))
        throw problem(422, "version_required", "运行必须引用任务和正文版本");
      const runKey = `${mission.id}:${input.mission_revision}:${source.id}:${input.source_revision}:${input.source_hash}:${input.model || "rules"}:${input.reasoning_effort || ""}`;
      const id = stableId("run", runKey), existing = documents().find((d) => d.id === id);
      if (existing) return { document: snapshot(existing), duplicate: true };
      if (contract.status !== "active" || mission.revision !== input.mission_revision ||
          source.revision !== input.source_revision || fingerprint(source.content) !== input.source_hash)
        throw problem(409, "stale_run", "任务或正文已变化，本次结果已丢弃，Agent 将重新观察");
      const action = input.action;
      if (!["stay_silent", "propose", "blocked"].includes(action)) throw problem(422, "invalid_action", "无效运行结果");
      requireText(input.rationale, "rationale", 8000);
      const quotes = input.evidence_quotes || [];
      if (!Array.isArray(quotes) || quotes.length > 12 || quotes.some((q) => typeof q !== "string" || !q || !source.content.includes(q)))
        throw problem(422, "invalid_evidence", "证据必须逐字引用当前正文");
      if (action === "propose") {
        requireText(input.replacement, "replacement", 200000);
        if (!quotes.length || input.replacement === source.content) throw problem(422, "invalid_proposal", "提案需要原文证据和实际修改");
      }
      const record = { kind: action === "propose" ? "proposal" : "run", mission_id: mission.id,
        mission_revision: mission.revision, source_document_id: source.id, source_revision: source.revision,
        source_hash: input.source_hash, action, status: action === "propose" ? "pending" : action,
        rationale: input.rationale, evidence_quotes: quotes, model: input.model || "rules",
        reasoning_effort: input.reasoning_effort || null, actor_id: actor, created_at: new Date().toISOString(),
        ...(action === "propose" ? { before: source.content, replacement: input.replacement } : {}) };
      const title = `${action === "propose" ? "提案" : "观察"} · ${source.title} · r${source.revision}`;
      const result = await create({ id, title, content: contractDocument(title, record,
        `## 判断依据\n\n${input.rationale}\n\n## 来源\n\n[来源正文](/workbench#${source.id}) · r${source.revision}\n\n` +
        quotes.map((q) => `> ${q.replace(/\n/g, "\n> ")}`).join("\n\n")) }, { actor_id: actor, operation: "agent_run" });
      return { document: snapshot(result), duplicate: false };
    });
  }
  async function resolve(id, input, actor) {
    if (!["accept", "reject"].includes(input.decision)) throw problem(422, "invalid_decision", "请选择接受或拒绝");
    requireVersion(input);
    return lock(id, async () => {
      const proposal = await get(id), p = parseContract(proposal);
      if (p?.kind !== "proposal") throw problem(422, "invalid_proposal", "不是修改提案");
      if (p.status !== "pending") return { document: snapshot(proposal), duplicate: true };
      if (proposal.revision !== input.base_revision) throw problem(409, "conflict", "提案版本已变化");
      const now = new Date().toISOString();
      let status = "rejected", sourceRevision = null;
      if (input.decision === "accept") {
        await lock(p.source_document_id, async () => {
          const source = await get(p.source_document_id);
          // A receipt lets a retry finish after source commit but before proposal finalization.
          const receipt = state.receipts[id] || source.applied_operations?.[id];
          if (receipt) { status = "accepted"; sourceRevision = receipt.revision; return; }
          const mission = await get(p.mission_id), m = parseContract(mission);
          if (m?.status !== "active" || mission.revision !== p.mission_revision ||
              source.revision !== p.source_revision || fingerprint(source.content) !== p.source_hash) {
            status = "conflicted"; return;
          }
          try {
            const updated = await write(source, p.replacement, { base_version: source.revision,
              actor_id: actor, operation: "proposal_accepted", operation_id: id });
            sourceRevision = updated.revision;
            state.receipts[id] = { revision: sourceRevision, actor_id: actor, at: now };
            save();
            status = "accepted";
          } catch (error) {
            if (error.status === 409) status = "conflicted";
            else throw error;
          }
        });
      }
      const updated = await write(proposal, updateContract(proposal, { status,
        resolved_by: actor, resolved_at: now, result_revision: sourceRevision }), {
        base_version: proposal.revision, actor_id: actor, operation: `proposal_${status}` });
      return { document: snapshot(updated), duplicate: false };
    });
  }
  async function handle(method, path, input, actor) {
    if (path === "/api/workspace" && method === "GET") return list();
    if (path === "/api/workspace/documents" && method === "POST") {
      requireText(input.title, "title", 200);
      if (typeof input.content !== "string" || input.content.length > 200000 || parseContract(input))
        throw problem(422, "invalid_content", "请输入普通正文；通过任务接口创建契约");
      return snapshot(await create({ title: input.title, content: input.content }, { actor_id: actor }));
    }
    if (path === "/api/workspace/missions" && method === "POST") return createMission(input, actor);
    if (path === "/api/workspace/runs" && method === "POST") return publishRun(input, actor);
    const match = path.match(/^\/api\/workspace\/(documents|missions|proposals)\/([a-zA-Z0-9_-]+)$/);
    if (match) {
      const [, type, id] = match;
      if (type === "documents" && method === "GET") return snapshot(await get(id));
      if (type === "documents" && method === "PUT") return edit(id, input, actor);
      if (type === "missions" && method === "PATCH") return changeStatus(id, input, actor);
      if (type === "proposals" && method === "POST") return resolve(id, input, actor);
    }
    throw problem(404, "not_found", "接口不存在");
  }
  return { handle, list };
}
module.exports = { createWorkspace };
