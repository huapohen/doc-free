"use strict";
// A frozen, bounded plan shares the native IM file and its single commit.
const crypto = require("node:crypto");
const { problem, requireText } = require("./work-protocol");
const copy = (v) => JSON.parse(JSON.stringify(v));
const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
const digest = (v) => crypto.createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");
const string = (maxLength, extra = {}) => ({ type: "string", maxLength, ...extra });
const pid = string(100);
const revision = { type: "integer", minimum: 1 };
const participants = { type: "array", maxItems: 100, items: pid };
const target = { anyOf: [pid, { type: "object", required: ["step_key", "field"], additionalProperties: false,
  properties: { step_key: string(64), field: { const: "resource_id" } } }] };
const fields = {
  im_create_task: { title: string(200), description: string(12000), assignee_id: pid },
  im_update_task: { task_id: target, base_revision: revision, title: string(200), description: string(12000), assignee_id: pid, status: { enum: ["open", "doing", "done"] } },
  im_add_contact: { principal_id: pid },
  office_create_event: { title: string(200), description: string(8000), location: string(300), starts_at: string(80), ends_at: string(80), attendee_ids: participants },
  office_update_event: { event_id: target, base_revision: revision, title: string(200), description: string(8000), location: string(300), starts_at: string(80), ends_at: string(80), attendee_ids: participants },
  office_respond_event: { event_id: target, base_revision: revision, response: { enum: ["accepted", "declined", "tentative"] } },
  im_create_document: { title: string(200), content: string(60000) },
  im_update_document: { document_id: target, base_revision: revision, title: string(200), content: string(60000) },
};
const required = {
  im_create_task: ["title", "assignee_id"], im_update_task: ["task_id", "base_revision"], im_add_contact: ["principal_id"],
  office_create_event: ["title", "starts_at", "ends_at", "attendee_ids"], office_update_event: ["event_id", "base_revision"],
  office_respond_event: ["event_id", "base_revision", "response"],
  im_create_document: ["title", "content"], im_update_document: ["document_id", "base_revision"],
};
const descriptions = {
  im_create_task: "Create a real task in this room and assign a current colleague.",
  im_update_task: "Update a captured room task at its expected version; done requires visible document evidence.",
  im_add_contact: "Add one current room colleague to your own contacts; never publishes existing personal relationships.",
  office_create_event: "Schedule an event with explicit timezone and current room attendees.",
  office_update_event: "Update a captured ordinary event you created or own; meeting-linked events are excluded.",
  office_respond_event: "Respond to your own invitation at the captured expected revision.",
  im_create_document: "Create a canonical shared document with a durable operation receipt and recoverable binding.",
  im_update_document: "Update a captured shared document by expected revision; canonical receipt reconciles interrupted writes.",
};
const OPERATIONS = Object.keys(fields);
const defaultAutonomy = () => ({ enabled: true, max_steps: 4, allowed_operations: [...OPERATIONS], review_interval_seconds: 300 });
function autonomy(value = {}) { return { ...defaultAutonomy(), ...copy(value) }; }
function validateAutonomy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !Object.hasOwn(defaultAutonomy(), k)))
    throw problem(422, "invalid_autonomy", "主动配置只允许启用、动作列表、步数和复核间隔");
  const v = autonomy(value);
  if (typeof v.enabled !== "boolean" || !Number.isInteger(v.max_steps) || v.max_steps < 1 || v.max_steps > 4 ||
      !Number.isInteger(v.review_interval_seconds) || v.review_interval_seconds < 60 || v.review_interval_seconds > 86400 ||
      !Array.isArray(v.allowed_operations) || v.allowed_operations.length > OPERATIONS.length || v.allowed_operations.some((x) => !OPERATIONS.includes(x)))
    throw problem(422, "invalid_autonomy", "无效主动动作范围、步数或复核间隔");
  v.allowed_operations = [...new Set(v.allowed_operations)].sort();
  return v;
}
function createNativeActions({ state, stamp, now, persist, event, member, active, policies, reduceTask, addContact, office, snapshot, equal, documentsAdapter }) {
  for (const room of state.rooms) for (const t of room.turns) if (t.action_plan) {
    const { hash, ...value } = t.action_plan;
    if (hash !== digest(value) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 4 ||
        !Array.isArray(t.action_receipts) || !t.execution_manifest || t.action_receipts.length > value.steps.length ||
        value.steps.some((s, i) => s.operation_id !== "operation-" + digest([room.id, t.principal_id, t.id, i]).slice(0, 40) ||
          s.input_hash !== digest({ key: s.key, operation: s.operation, arguments: s.arguments, evidence: s.evidence })) ||
        t.action_receipts.some((r, i) => r.operation_id !== value.steps[i].operation_id || r.input_hash !== value.steps[i].input_hash || !["committed", "rejected", "applying"].includes(r.status) ||
          (r.status !== "committed" && i !== t.action_receipts.length - 1)))
      throw new Error("Native action ledger is corrupt; refusing to reset or replay operations");
  }
  function capabilities(room, p) {
    const config = autonomy(room.members[p.id].autonomy);
    return { protocol: "native-actions/v1", capability_version: 1, max_steps: config.enabled ? config.max_steps : 0,
      max_actions_per_root: 12, review_interval_seconds: config.review_interval_seconds,
      operations: config.enabled ? config.allowed_operations.filter((name) => documentsAdapter || !name.endsWith("_document")).map((name) => ({ name, description: descriptions[name],
        arguments_schema: { type: "object", additionalProperties: false, required: required[name], properties: copy(fields[name]) } })) : [] };
  }
  function initialManifest(context) {
    return { membership_revision: context.policy.membership_revision, messages: copy(context.message_manifest),
      documents: copy(context.document_manifest), tasks: copy(context.task_manifest), office: copy(context.office.manifest) };
  }
  function find(room, tid) {
    const t = room.turns.find((t) => t.id === tid);
    if (!t) throw problem(404, "not_found", "运行不存在");
    return t;
  }
  function guard(room, p, t, lease) {
    const m = member(room, p);
    policies.requirePlugins(["im", "docs", "tasks", "meetings", "calendar"], p);
    if (t.principal_id !== p.id || p.kind !== "agent") throw problem(403, "turn_owner_required", "动作必须由该运行的 Agent 本人执行");
    if (m.mode === "paused" || t.status !== "running") throw problem(409, "turn_finished", "运行已停止，不能继续动作");
    if (typeof lease !== "string" || !lease || !equal(t.lease_hash || "", crypto.createHash("sha256").update(lease).digest("hex")) || t.lease_expires_at <= now())
      throw problem(409, "lease_expired", "动作租约已失效");
    return m;
  }
  function view(t) { return { plan: copy(t.action_plan || null), receipts: copy(t.action_receipts || []) }; }
  function source(context, ref) {
    const records = ref.kind === "message" ? [...context.messages, context.trigger.message].filter(Boolean)
      : ref.kind === "document" ? context.documents : ref.kind === "task" ? context.tasks
      : ref.kind === "calendar" ? context.office.calendar : [];
    return records.find((item) => item.id === ref.id && (item.revision || 1) === ref.revision);
  }
  function evidence(context, refs) {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 4) throw problem(422, "invalid_evidence", "每个动作需要 1–4 条可见依据");
    return refs.map((ref) => {
      if (!ref || Object.keys(ref).some((k) => !["kind", "id", "revision", "quote"].includes(k)) || !Number.isInteger(ref.revision))
        throw problem(422, "invalid_evidence", "依据必须包含种类、ID、版本和原文");
      const item = source(context, ref), quote = requireText(ref.quote, "evidence.quote", 1000);
      const text = item && (ref.kind === "message" ? item.content : `${item.title}\n${item.content || item.description || ""}`);
      if (!item || !text.includes(quote)) throw problem(422, "invalid_evidence", "依据不在捕获的可见版本中");
      return { kind: ref.kind, id: ref.id, revision: ref.revision, quote };
    });
  }
  function argumentsFor(operation, args, context, previous) {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((k) => !Object.hasOwn(fields[operation], k)) || required[operation].some((k) => args[k] === undefined))
      throw problem(422, "invalid_operation_arguments", "动作参数不符合固定能力合同");
    const result = copy(args), pids = new Set(context.participants.filter((p) => !p.disabled).map((p) => p.principal_id));
    for (const [key, value] of Object.entries(result)) {
      const schema = fields[operation][key];
      if (["task_id", "event_id", "document_id"].includes(key)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const step = previous.find((s) => s.key === value.step_key);
          if (Object.keys(value).sort().join(",") !== "field,step_key" || value.field !== "resource_id" ||
              !step || step.operation !== (key === "task_id" ? "im_create_task" : key === "event_id" ? "office_create_event" : "im_create_document"))
            throw problem(422, "invalid_result_reference", "仅允许绑定前面创建动作的真实资源 ID");
        } else if (typeof value !== "string" || !(key === "task_id" ? context.tasks : key === "event_id" ? context.office.calendar : context.documents).some((item) => item.id === value))
          throw problem(422, "uncaptured_resource", "动作目标必须已在原上下文中读取");
      } else if (schema.enum) {
        if (!schema.enum.includes(value)) throw problem(422, "invalid_operation_arguments", "无效动作枚举");
      } else if (schema.type === "integer") {
        if (!Number.isSafeInteger(value) || value < 1) throw problem(422, "version_required", "动作需要明确的预期版本");
      } else if (schema.type === "array") {
        if (!Array.isArray(value) || value.length > 100 || value.some((pid) => !pids.has(pid))) throw problem(422, "invalid_attendees", "只允许捕获的房间参与者");
        result[key] = [...new Set(value)].sort();
      } else if (typeof value !== "string" || value.length > schema.maxLength) throw problem(422, "invalid_operation_arguments", "动作字段类型或长度无效");
      if (["principal_id", "assignee_id"].includes(key) && !pids.has(value)) throw problem(422, "invalid_principal", "只允许捕获的房间参与者");
      if (["starts_at", "ends_at"].includes(key) && (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value)))
        throw problem(422, "invalid_datetime", "自动日程需要明确时区");
    }
    return result;
  }
  function finalResult(value, room) {
    if (!value || !["reply", "silent", "blocked"].includes(value.action) || Object.keys(value).some((k) => !["action", "content", "rationale", "mentions", "artifact"].includes(k)))
      throw problem(422, "invalid_action", "计划需保存有界最终说明");
    const v = { action: value.action, rationale: requireText(value.rationale, "rationale", 8000), content: "", mentions: [], artifact: null };
    if (v.action === "reply") {
      v.content = requireText(value.content, "content", 10000);
      if (!Array.isArray(value.mentions || []) || (value.mentions || []).length > 100 || (value.mentions || []).some((x) => !Object.hasOwn(room.members, x))) throw problem(422, "invalid_mentions", "提及必须是当前成员");
      v.mentions = [...new Set(value.mentions || [])].sort();
      if (value.artifact) v.artifact = { title: requireText(value.artifact.title, "title", 200), content: requireText(value.artifact.content, "content", 60000) };
    }
    return v;
  }
  async function assertSnapshot(room, t) {
    const current = await snapshot(room, t), expected = t.execution_manifest || initialManifest(t.context);
    if (digest(current) !== digest(expected)) throw problem(409, "stale_context", "原始依据或他人的工作版本已变化，剩余动作停止");
  }
  async function plan(room, p, tid, input) {
    const t = find(room, tid); guard(room, p, t, input.lease_token);
    if (input.context_hash !== t.context.context_hash || input.model !== t.context.model || input.reasoning_effort !== t.context.reasoning_effort)
      throw problem(409, "invocation_mismatch", "计划必须匹配领取时的上下文及模型配置");
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 4) throw problem(422, "action_budget", "每轮计划只允许 1–4 个动作");
    const config = autonomy(room.members[p.id].autonomy), captured = t.context.actions;
    if (!config.enabled || input.steps.length > config.max_steps || input.steps.length > (captured?.max_steps || 0)) throw problem(403, "autonomy_denied", "此同事的主动动作配置不允许该计划");
    const steps = [];
    for (const entry of input.steps) {
      if (!entry || Object.keys(entry).some((k) => !["key", "operation", "arguments", "evidence"].includes(k)) ||
          !OPERATIONS.includes(entry.operation) || !config.allowed_operations.includes(entry.operation) || !captured.operations.some((x) => x.name === entry.operation))
        throw problem(422, "unsupported_operation", "只能执行当轮固定能力目录中的动作");
      const key = requireText(entry.key, "step.key", 64);
      if (!/^[a-zA-Z0-9_-]+$/.test(key) || steps.some((x) => x.key === key)) throw problem(422, "invalid_step_key", "动作 key 必须唯一且只含字母数字下划线连字符");
      const args = argumentsFor(entry.operation, entry.arguments, t.context, steps), refs = evidence(t.context, entry.evidence);
      if (entry.operation === "im_update_task" && args.status === "done" && !refs.some((e) => e.kind === "document"))
        throw problem(422, "delivery_evidence_required", "任务完成需要捕获的共享交付文档依据");
      const step = { key, operation: entry.operation, arguments: args, evidence: refs };
      steps.push({ ...step, operation_id: "operation-" + digest([room.id, p.id, t.id, steps.length]).slice(0, 40), input_hash: digest(step) });
    }
    const value = { summary: requireText(input.summary, "summary", 2000), steps, final_result: finalResult(input.final_result, room) };
    value.hash = digest(value);
    if (t.action_plan) {
      if (t.action_plan.hash !== value.hash) throw problem(409, "plan_conflict", "此运行已冻结不同计划");
      return { ...view(t), duplicate: true };
    }
    const reserved = room.turns.filter((x) => x.root_id === t.root_id).reduce((n, x) => n + (x.action_plan?.steps.length || 0), 0);
    if (reserved + steps.length > 12) throw problem(409, "action_budget", "本次协作因果链最多 12 个动作");
    await assertSnapshot(room, t); guard(room, p, t, input.lease_token);
    t.action_plan = value; t.action_receipts = []; t.execution_manifest = initialManifest(t.context);
    event(room, "turn.planned", p.id, { turn_id: t.id, plan_hash: value.hash }); persist();
    return { ...view(t), duplicate: false };
  }
  function recordDocument(room, t, step, receipt, result) {
    const intent = t.document_intents[step.operation_id];
    if (result.resource_id !== intent.document_id || !Number.isInteger(result.after_revision) || typeof result.content_hash !== "string")
      throw problem(503, "invalid_document_receipt", "规范文档回执无法验证，保留原意图等待恢复");
    if (!room.document_ids.includes(result.resource_id)) room.document_ids.push(result.resource_id);
    room.document_versions[result.resource_id] = `${result.after_revision}:${result.content_hash}`;
    const list = t.execution_manifest.documents, old = list.find((d) => d.id === result.resource_id);
    const manifest = { id: result.resource_id, revision: result.after_revision, content_hash: result.content_hash };
    if (old) Object.assign(old, manifest); else list.push(manifest);
    Object.assign(receipt, { status: "committed", resource_id: result.resource_id, before_revision: result.before_revision,
      after_revision: result.after_revision, after_hash: result.content_hash, committed_at: result.committed_at, error_code: null });
    event(room, step.operation === "im_create_document" ? "document.created" : "document.updated", t.principal_id,
      { document_id: result.resource_id, revision: result.after_revision, content_hash: result.content_hash,
        root_id: t.root_id, depth: t.depth, turn_id: t.id, operation_id: step.operation_id });
  }
  async function reconcile(room, t, step, receipt) {
    if (!documentsAdapter || !t.document_intents?.[step.operation_id]) throw problem(503, "outcome_pending", "文档动作适配器不可用，保留原意图");
    const result = await documentsAdapter.recover(t.document_intents[step.operation_id], { actor_id: t.principal_id });
    if (result) {
      recordDocument(room, t, step, receipt, result);
      event(room, "turn.operation", t.principal_id, { turn_id: t.id, operation_id: step.operation_id, status: "committed" });
      persist();
    }
    return result;
  }
  async function execute(room, p, tid, oid, input) {
    const t = find(room, tid); guard(room, p, t, input.lease_token);
    const plan = t.action_plan, step = plan?.steps.find((s) => s.operation_id === oid);
    if (!step || input.plan_hash !== plan.hash) throw problem(409, "plan_conflict", "动作不属于冻结计划");
    const receipts = t.action_receipts, previous = receipts.find((r) => r.operation_id === oid);
    if (previous?.status === "applying") await reconcile(room, t, step, previous);
    if (previous && previous.status !== "applying") return { ...view(t), receipt: copy(previous), duplicate: true };
    if (receipts.some((r) => r !== previous && r.status !== "committed")) throw problem(409, "plan_stopped", "前面的动作失败，剩余动作未执行");
    if (plan.steps[previous ? receipts.length - 1 : receipts.length]?.operation_id !== oid) throw problem(409, "operation_order", "只能按冻结顺序执行动作");
    const receipt = previous || { operation_id: oid, input_hash: step.input_hash, operation: step.operation, principal_id: p.id,
      turn_id: t.id, root_id: t.root_id, started_at: stamp(), committed_at: null, status: "rejected", resource_id: null,
      before_revision: null, after_revision: null, evidence_refs: copy(step.evidence), error_code: null };
    let args;
    try {
      const config = autonomy(room.members[p.id].autonomy);
      if (!config.enabled || !config.allowed_operations.includes(step.operation) || (previous ? receipts.length - 1 : receipts.length) >= config.max_steps) throw problem(403, "autonomy_denied", "主动权限已变化");
      await assertSnapshot(room, t); guard(room, p, t, input.lease_token);
      args = copy(step.arguments);
      for (const k of ["task_id", "event_id", "document_id"]) if (args[k] && typeof args[k] === "object") {
        const dependency = plan.steps.find((s) => s.key === args[k].step_key), committed = receipts.find((r) => r.operation_id === dependency.operation_id && r.status === "committed");
        if (!committed) throw problem(409, "operation_order", "依赖尚未提交");
        args[k] = committed.resource_id;
      }
      for (const pid of [...(args.attendee_ids || []), ...[args.principal_id, args.assignee_id].filter(Boolean)]) {
        active(pid); if (!room.members[pid]) throw problem(403, "not_a_member", "目标参与者已离开会话");
      }
      const cause = { root_id: t.root_id, depth: t.depth, turn_id: t.id, operation_id: oid };
      let resource;
      if (step.operation.endsWith("_document")) {
        if (!documentsAdapter) throw problem(422, "unsupported_operation", "规范文档动作尚未连接");
        if (step.operation === "im_create_document" && !previous && room.document_ids.length >= 50) throw problem(409, "limit_reached", "每会话最多 50 篇文档");
        if (step.operation === "im_update_document" && !room.document_ids.includes(args.document_id)) throw problem(403, "document_scope", "文档不属于当前会话");
        t.document_intents ||= {};
        if (!previous) {
          const intent = documentsAdapter.prepare({ operation: step.operation, operation_id: oid, input_hash: step.input_hash, arguments: args }, p.id);
          t.document_intents[oid] = copy(intent);
          receipt.status = "applying"; t.action_receipts.push(receipt);
          event(room, "turn.operation", p.id, { turn_id: t.id, operation_id: oid, status: "applying" }); persist();
        }
        const deadline = Math.min(t.lease_expires_at, now() + 10000);
        try {
          const result = await documentsAdapter.apply(t.document_intents[oid], { actor_id: p.id, deadline_ms: deadline,
            beforeCommit: () => guard(room, p, t, input.lease_token) });
          if (!result) throw problem(503, "outcome_pending", "规范文档提交尚未确认");
          recordDocument(room, t, step, receipt, result);
          event(room, "turn.operation", p.id, { turn_id: t.id, operation_id: oid, status: "committed" }); persist();
          return { ...view(t), receipt: copy(receipt), duplicate: false };
        } catch (error) {
          // The intent remains applying even on transport errors. Never blindly create a second document.
          if (error.code === "storage_failed") throw error;
          try {
            if (await reconcile(room, t, step, receipt)) return { ...view(t), receipt: copy(receipt), duplicate: true };
            if (Number.isInteger(error.status) && error.status < 500) {
              // Definitive business rejection plus no canonical receipt: no write happened.
              error.document_not_committed = true;
              throw error;
            }
          }
          catch (recoveryError) { if (recoveryError.code === "storage_failed" || recoveryError.document_not_committed) throw recoveryError; }
          throw problem(503, "outcome_pending", "文档结果待确认，保留稳定操作 ID 等待恢复");
        }
      } else if (step.operation.startsWith("im_") && step.operation !== "im_add_contact") {
        receipt.before_revision = args.task_id ? room.tasks.find((x) => x.id === args.task_id)?.revision : null;
        resource = reduceTask(step.operation === "im_create_task" ? "create" : "update", room, p, args, cause);
        const list = t.execution_manifest.tasks, old = list.find((x) => x.id === resource.id);
        if (old) old.revision = resource.revision; else list.push({ id: resource.id, revision: resource.revision });
      } else if (step.operation === "im_add_contact") {
        addContact(p, args.principal_id);
        resource = { id: args.principal_id, revision: null };
      } else {
        const current = args.event_id && state.office.calendar.find((x) => x.id === args.event_id);
        if (current?.meeting_id) throw problem(422, "unsupported_operation", "自动动作首版不修改关联会议的日程");
        receipt.before_revision = current?.revision || null;
        resource = office.reduceCalendar(step.operation === "office_create_event" ? "create" : step.operation === "office_update_event" ? "update" : "respond", room, p, args, cause);
        const list = t.execution_manifest.office.calendar, old = list.find((x) => x.id === resource.id);
        if (old) old.revision = resource.revision; else list.push({ id: resource.id, revision: resource.revision });
      }
      receipt.resource_id = resource.id; receipt.after_revision = resource.revision;
      receipt.status = "committed"; receipt.committed_at = stamp();
    } catch (error) {
      if (!Number.isInteger(error.status) || error.status >= 500 || ["lease_expired", "turn_finished"].includes(error.code)) throw error;
      receipt.status = "rejected";
      receipt.error_code = /^[a-z_]+$/.test(error.code || "") ? error.code : "operation_rejected";
    }
    if (!t.action_receipts.includes(receipt)) t.action_receipts.push(receipt);
    event(room, "turn.operation", p.id, { turn_id: t.id, operation_id: oid, status: receipt.status });
    persist();
    return { ...view(t), receipt: copy(receipt), duplicate: false };
  }
  function summary(t) {
    return (t.action_receipts || []).map((r) => ({ operation_id: r.operation_id, operation: r.operation, status: r.status,
      resource_id: r.resource_id, after_revision: r.after_revision, error_code: r.error_code }));
  }
  return { capabilities, initialManifest, plan, execute, assertSnapshot, summary,
    async read(room, p, tid) {
      member(room, p); policies.requirePlugins(["im", "docs", "tasks", "meetings", "calendar"], p);
      const t = find(room, tid);
      for (const receipt of t.action_receipts || []) if (receipt.status === "applying") {
        try { await reconcile(room, t, t.action_plan.steps.find((s) => s.operation_id === receipt.operation_id), receipt); }
        catch (error) { if (error.code === "storage_failed") throw error; }
      }
      return view(t);
    } };
}
module.exports = { createNativeActions, autonomy, validateAutonomy, OPERATIONS, digest };
