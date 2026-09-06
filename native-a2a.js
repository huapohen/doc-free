"use strict";

// A single-writer, structured A2A adapter. The underlying member API remains the
// authority. Durable acceptance precedes invocation; interrupted work is never
// automatically replayed, including operations without a native client_id.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveNativeTool } = require("./native-im-mcp");
const PROTOCOL = "active-a2a/v1";
const LIMITS = Object.freeze({ inputBytes: 256 * 1024, receiptBytes: 512 * 1024,
  storeBytes: 64 * 1024 * 1024, tasks: 2000, perOwner: 200, pending: 16 });
const PHASES = new Set(["submitted", "working", "completed", "failed", "input-required", "canceled"]);
const pending = (record) => ["submitted", "working"].includes(record.phase);
const copy = (value) => JSON.parse(JSON.stringify(value));
const stamp = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Media signaling and session presence have a deliberately ephemeral lifetime.
// Even a read-meeting receipt would otherwise preserve its live session IDs.
const EPHEMERAL_TOOLS = new Set(["office_signal", "office_receive_signals", "office_join_meeting",
  "office_meeting_presence", "office_leave_meeting", "office_read_meeting", "im_presence"]);
// Member provisioning returns a one-time principal credential. It remains a
// direct authenticated MCP/REST operation; a durable task must never carry it.
const CREDENTIAL_ISSUING_TOOLS = new Set(["enterprise_create_member"]);
const blockedTool = (name) => EPHEMERAL_TOOLS.has(name) || CREDENTIAL_ISSUING_TOOLS.has(name) ||
  /admin|auth|password|credential|login|logout|(?:^|[_-])(?:sessions?|accounts?)(?:$|[_-])/i.test(name);
const fieldName = (key) => key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
  .replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]/g, "_").toLowerCase();
const secretKey = (key) => /(?:^|_)(?:password|credential|credentials|token|authorization|secret|bearer)(?:_|$)/.test(fieldName(key)) ||
  /(?:^|_)(?:api|private|access)_key(?:_|$)/.test(fieldName(key));
function fault(code, message, rpc = -32602) {
  return Object.assign(new Error(message), { code, rpc });
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
const digest = (value) => crypto.createHash("sha256").update(canonical(value)).digest("hex");
function boundedText(value, name, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw fault("invalid_params", `${name} must be a nonempty bounded string`);
  return value;
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw fault("invalid_params", "Unexpected object fields; actor and credential overrides are not accepted");
}
function validateJson(value, credential, depth = 0) {
  if (depth > 32) throw fault("invalid_params", "Input nesting exceeds the limit");
  if (typeof value === "string") {
    if (credential && (value === credential || (credential.length >= 8 && value.includes(credential))))
      throw fault("credential_in_input", "Credentials must only be supplied in the Authorization header");
    return;
  }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (!object(value) && !Array.isArray(value)) throw fault("invalid_params", "Input must contain JSON values only");
  for (const [key, child] of Object.entries(value)) {
    if (["actor", "actor_id", "__proto__", "constructor", "prototype"].includes(fieldName(key)) || secretKey(key))
      throw fault("credential_or_actor_override", "Actor and credential fields are not accepted");
    validateJson(child, credential, depth + 1);
  }
}
function redact(value, credential) {
  if (typeof value === "string") return credential && credential.length >= 8
    ? value.split(credential).join("[redacted credential]") : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, credential));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, secretKey(key) ? "[redacted credential]" : redact(item, credential)]));
  return value;
}

function createNativeA2A({ file, im, invokeTool, publicTools }) {
  if (!file || !im?.handle || typeof im.authorizeStoredOperation !== "function" ||
      typeof invokeTool !== "function" || !Array.isArray(publicTools))
    throw new Error("A2A requires a store, native IM authority with current receipt authorization, and explicit public tool catalog");
  const catalog = new Map(publicTools.filter((tool) => typeof tool.name === "string" && !blockedTool(tool.name))
    .map((tool) => [tool.name, copy(tool)]));
  let state = { protocol: PROTOCOL, tasks: [] };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.storeBytes) throw new Error("Invalid store");
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    const taskIds = new Set(), messageIds = new Set();
    if (state.protocol !== PROTOCOL || !Array.isArray(state.tasks) || state.tasks.length > LIMITS.tasks)
      throw new Error("Invalid schema");
    for (const record of state.tasks) {
      const messageKey = `${record.owner_id}:${record.message_id}`;
      if ([record.id, record.owner_id, record.message_id, record.context_id].some((value) => typeof value !== "string" || !value || value.length > 160) ||
          !PHASES.has(record.phase) || !object(record.input) || !object(record.input.arguments) ||
          record.input_hash !== digest(record.input) || !record.created_at || !record.updated_at ||
          taskIds.has(record.id) || messageIds.has(messageKey) ||
          (record.phase === "completed" && !Object.hasOwn(record.receipt || {}, "value")))
        throw new Error("Invalid task record");
      taskIds.add(record.id); messageIds.add(messageKey);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("A2A store is corrupt; refusing to discard task receipts");
  }
  let stopped = false, transactions = Promise.resolve(), draining = false, scheduled = false;
  const jobs = [];
  const storageError = () => fault("storage_failed",
    "A2A persistence failed. Execution outcome may be unknown; do not automatically replay. Repair storage and restart.", -32603);
  function healthy() { if (stopped) throw storageError(); }
  function serial(fn) {
    const operation = transactions.catch(() => {}).then(() => { healthy(); return fn(); });
    transactions = operation;
    return operation;
  }
  function persist() {
    let temporary;
    try {
      healthy();
      const data = JSON.stringify(state, null, 2);
      if (Buffer.byteLength(data) > LIMITS.storeBytes) throw new Error("Store size limit");
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      temporary = `${file}.${crypto.randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } catch {
      stopped = true;
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
      throw storageError();
    }
  }
  function status(record, phase, error = null) {
    record.phase = phase; record.updated_at = stamp();
    if (error) record.receipt = { error, automatic_replay: false };
  }
  let recovered = false;
  for (const record of state.tasks) if (pending(record)) {
    status(record, "input-required", { code: "outcome_unknown",
      message: "Execution was interrupted. Inspect the underlying operation before a new messageId; preserve any native client_id. This task will not be replayed." });
    recovered = true;
  }
  if (recovered) persist();

  async function principal(credential) {
    const result = await im.handle("GET", "/api/im/me", {}, credential);
    if (!result?.principal?.id) throw fault("unauthorized", "A member identity is required", -32000);
    return result.principal;
  }
  function owned(taskId, owner) {
    const record = state.tasks.find((task) => task.id === taskId && task.owner_id === owner.id);
    if (!record) throw fault("task_not_found", "Task not found", -32001);
    return record;
  }
  function view(record, includeInput = true) {
    const result = {
      kind: "task", id: record.id, contextId: record.context_id,
      status: { state: record.phase, timestamp: record.updated_at }, artifacts: [],
      history: includeInput ? [{ kind: "message", messageId: record.message_id, role: "user", contextId: record.context_id,
        parts: [{ kind: "data", data: { operation: record.input.operation, arguments: copy(record.input.arguments) } }] }] : [],
      metadata: { gatewayProtocol: PROTOCOL, operation: record.input.operation,
        inputHash: record.input_hash, automaticReplay: false },
    };
    if (record.phase === "completed") result.artifacts = [{ artifactId: record.id + "-receipt", name: "Member operation receipt",
      parts: [{ kind: "data", data: { operation: record.input.operation, result: copy(record.receipt.value) } }] }];
    if (record.receipt?.error) result.status.message = {
      kind: "message", messageId: record.id + "-status", taskId: record.id, contextId: record.context_id, role: "agent",
      parts: [{ kind: "text", text: record.receipt.error.message || "Member operation failed; no automatic replay." },
        { kind: "data", data: copy(record.receipt.error) }],
    };
    return result;
  }
  async function authorizedView(record, credential) {
    // Failed operations contain only a bounded error, never a business result.
    // Keep this useful outcome readable without reflecting private input that
    // may now belong to an inaccessible module, conversation, or principal.
    if (record.phase === "failed") return view(record, false);
    try {
      const descriptor = resolveNativeTool(record.input.operation, record.input.arguments);
      await im.authorizeStoredOperation({ ...descriptor, receipt: record.receipt?.value }, credential);
    } catch (error) {
      const denied = fault(error.code || "receipt_access_denied",
        "Current access does not permit reading this task receipt or its input", -32003);
      if (Number.isInteger(error.status)) denied.status = error.status;
      if (/^[a-z][a-z0-9_-]{1,49}$/.test(error.plugin_id || "")) denied.plugin_id = error.plugin_id;
      throw denied;
    }
    return view(record);
  }
  async function read(taskId, credential) {
    return serial(async () => authorizedView(owned(taskId, await principal(credential)), credential));
  }
  async function execute(job) {
    let executeRecord;
    await serial(async () => {
      const record = state.tasks.find((task) => task.id === job.id);
      if (record.phase !== "submitted") return;
      try {
        const owner = await principal(job.credential);
        if (owner.id !== record.owner_id) throw new Error("Owner changed");
      } catch {
        status(record, "failed", { code: "authorization_failed", message: "The queued owner credential is no longer valid. Nothing was invoked." });
        persist(); return;
      }
      status(record, "working"); record.started_at = stamp(); persist();
      executeRecord = record;
    });
    if (!executeRecord) return;
    let receipt, phase;
    try {
      const result = await invokeTool(im, executeRecord.input.operation, copy(executeRecord.input.arguments), job.credential);
      // Never persist credentials, including accidentally echoed member tokens.
      const encoded = JSON.stringify(redact(copy(result), job.credential));
      if (Buffer.byteLength(encoded) > LIMITS.receiptBytes) throw fault("receipt_too_large", "Receipt exceeds gateway limit");
      receipt = { value: JSON.parse(encoded) }; phase = "completed";
    } catch (error) {
      const knownFailure = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      phase = knownFailure ? "failed" : "input-required";
      receipt = { automatic_replay: false, error: {
        code: knownFailure ? (/^[a-z][a-z0-9_]{0,79}$/.test(error.code || "") ? error.code : "operation_rejected") :
          (error.code === "receipt_too_large" ? "receipt_too_large" : "outcome_unknown"),
        ...(knownFailure ? { status: error.status } : {}),
        ...(knownFailure && /^[a-z][a-z0-9_-]{1,49}$/.test(error.plugin_id || "") ? { plugin_id: error.plugin_id } : {}),
        message: knownFailure ? "The member API rejected the operation. Correct the request before using a new messageId." :
          "The operation outcome or receipt is unavailable. Inspect the underlying operation before a new messageId; preserve any native client_id. This task will not be replayed.",
      } };
    }
    await serial(() => { executeRecord.receipt = receipt; status(executeRecord, phase); persist(); });
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (jobs.length) {
        const job = jobs.shift();
        try { await execute(job); job.resolve(); }
        catch (error) { job.reject(error); }
        finally { job.credential = null; }
      }
    } finally { draining = false; }
  }
  function enqueue(taskId, credential) {
    const completed = new Promise((resolve, reject) => jobs.push({ id: taskId, credential, resolve, reject }));
    // Nonblocking requests have no awaiting consumer; errors remain represented
    // by fail-stop/recovery, rather than becoming unhandled promise rejections.
    completed.catch(() => {});
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => { scheduled = false; void drain(); });
    }
    return completed;
  }
  function parseMessage(params, credential) {
    keys(params, ["message", "configuration"]);
    if (params.configuration !== undefined) {
      keys(params.configuration, ["blocking"]);
      if (params.configuration.blocking !== undefined && typeof params.configuration.blocking !== "boolean")
        throw fault("invalid_params", "configuration.blocking must be boolean");
    }
    const message = params.message;
    keys(message, ["kind", "messageId", "contextId", "role", "parts"]);
    if ((message.kind !== undefined && message.kind !== "message") || message.role !== "user")
      throw fault("invalid_params", "A user message is required; its actor comes only from the bearer identity");
    boundedText(message.messageId, "messageId");
    if (message.contextId !== undefined) boundedText(message.contextId, "contextId");
    validateJson([message.messageId, message.contextId ?? null], credential);
    if (!Array.isArray(message.parts) || message.parts.length !== 1 || message.parts[0]?.kind !== "data")
      throw fault("structured_operation_required", "Provide one data part with operation and arguments; text planning is not implemented", -32005);
    keys(message.parts[0], ["kind", "data"]);
    const data = message.parts[0].data;
    keys(data, ["operation", "arguments"]);
    boundedText(data.operation, "operation", 100);
    if (!catalog.has(data.operation) || blockedTool(data.operation))
      throw fault("unsupported_operation", "Operation is not an allowed durable member tool; ephemeral media uses direct member REST or MCP", -32004);
    if (!object(data.arguments)) throw fault("invalid_params", "arguments must be an object");
    validateJson(data.arguments, credential);
    const input = { operation: data.operation, arguments: copy(data.arguments), context_id: message.contextId ?? null };
    return { messageId: message.messageId, input, blocking: params.configuration?.blocking !== false };
  }
  async function handle(request, credential) {
    // Authentication is independent of JSON-RPC inputs and remains the HTTP
    // authority's responsibility for status codes such as 401.
    await principal(credential);
    const requestId = typeof request?.id === "string" || (typeof request?.id === "number" && Number.isFinite(request.id)) ? request.id : null;
    try {
      healthy();
      if (!object(request)) throw fault("invalid_request", "Invalid JSON-RPC request", -32600);
      keys(request, ["jsonrpc", "id", "method", "params"]);
      if (request.jsonrpc !== "2.0" || !Object.hasOwn(request, "id") ||
          (request.id !== null && requestId === null) || typeof request.method !== "string")
        throw fault("invalid_request", "Invalid JSON-RPC request", -32600);
      if (Buffer.byteLength(JSON.stringify(request)) > LIMITS.inputBytes)
        throw fault("input_too_large", "A2A input exceeds 256 KiB");
      let result;
      if (request.method === "message/send") {
        const parsed = parseMessage(request.params, credential);
        const accepted = await serial(async () => {
          const owner = await principal(credential);
          const previous = state.tasks.find((task) => task.owner_id === owner.id && task.message_id === parsed.messageId);
          const inputHash = digest(parsed.input);
          if (previous) {
            if (previous.input_hash !== inputHash) throw fault("idempotency_conflict", "messageId already identifies different input");
            return { id: previous.id, duplicate: true };
          }
          if (state.tasks.length >= LIMITS.tasks || state.tasks.filter((task) => task.owner_id === owner.id).length >= LIMITS.perOwner)
            throw fault("task_capacity", "A2A task receipt capacity reached");
          if (state.tasks.filter(pending).length >= LIMITS.pending)
            throw fault("queue_capacity", "A2A execution queue is full");
          const record = { id: id("a2a"), owner_id: owner.id, message_id: parsed.messageId,
            context_id: parsed.input.context_id ?? id("context"), input: parsed.input, input_hash: inputHash,
            phase: "submitted", created_at: stamp(), updated_at: stamp() };
          state.tasks.push(record); persist();
          return { id: record.id, duplicate: false };
        });
        if (!accepted.duplicate) {
          const completion = enqueue(accepted.id, credential);
          if (parsed.blocking) await completion;
        }
        result = await read(accepted.id, credential);
      } else if (["tasks/get", "tasks/cancel"].includes(request.method)) {
        keys(request.params, ["id"]);
        const taskId = boundedText(request.params.id, "id");
        if (request.method === "tasks/get") result = await read(taskId, credential);
        else result = await serial(async () => {
          const record = owned(taskId, await principal(credential));
          if (record.phase !== "submitted") throw fault("task_not_cancelable", "Only queued tasks that have not started can be canceled", -32002);
          // Cancellation never replays the operation. Gate its echoed input in
          // the same way as tasks/get and duplicate message/send responses.
          await authorizedView(record, credential);
          status(record, "canceled"); persist(); return authorizedView(record, credential);
        });
      } else throw fault("method_not_found", "Method not found; streaming and push are not implemented", -32601);
      return { jsonrpc: "2.0", id: requestId, result };
    } catch (error) {
      return { jsonrpc: "2.0", id: requestId, error: {
        code: error.rpc || -32603,
        message: error.rpc ? error.message : "A2A request failed",
        data: { code: error.code && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : "internal_error", automaticReplay: false,
          ...(Number.isInteger(error.status) ? { status: error.status } : {}),
          ...(/^[a-z][a-z0-9_-]{1,49}$/.test(error.plugin_id || "") ? { plugin_id: error.plugin_id } : {}) },
      } };
    }
  }
  function agentCard(baseUrl) {
    const base = new URL(baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new Error("Agent Card requires a plain HTTP(S) origin");
    return { protocolVersion: "0.3.0", name: "Active Office member gateway", version: "0.5.0",
      description: "Structured durable office operations for human and Agent workspace members. Ephemeral media signaling, live meeting sessions and presence use direct member REST or MCP. No automatic text planning or replay of interrupted operations.",
      url: new URL("/api/im/a2a", base).href, preferredTransport: "JSONRPC",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "An independent member credential or valid login session; never an administrator credential" } },
      security: [{ bearer: [] }], defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
      skills: [...catalog.values()].map((tool) => ({ id: tool.name, name: tool.name,
        description: tool.description || "Authorized member operation", tags: ["member-api", "structured-operation"],
        inputModes: ["application/json"], outputModes: ["application/json"] })),
    };
  }
  return { handle, agentCard };
}
module.exports = { createNativeA2A, PROTOCOL, LIMITS };
