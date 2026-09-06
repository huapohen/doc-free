"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const { callNativeTool, publicTools } = require("../native-im-mcp");
const { createNativeA2A, LIMITS } = require("../native-a2a");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-a2a-tests-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const request = (method, params) => ({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params });
const send = (operation, args, options = {}) => request("message/send", {
  message: { messageId: options.messageId || crypto.randomUUID(), role: "user",
    ...(options.contextId ? { contextId: options.contextId } : {}),
    parts: [{ kind: "data", data: { operation, arguments: args } }] },
  ...(options.blocking === false ? { configuration: { blocking: false } } : {}),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
async function fixture(invoke = callNativeTool) {
  const directory = path.join(temporary, crypto.randomUUID());
  const admin = crypto.randomBytes(32).toString("hex");
  const im = createNativeIM({ file: path.join(directory, "im.json"), adminToken: admin,
    workspace: { handle: async () => { throw new Error("Unexpected document access"); } } });
  const member = (who, route, method = "GET", body = {}) => im.handle(method, "/api/im" + route, body, who.token ?? who);
  const human = await member(admin, "/admin/principals", "POST", { name: "Human", kind: "human" });
  const agent = await member(admin, "/admin/principals", "POST", { name: "Agent", kind: "agent" });
  const { room } = await member(human, "/rooms", "POST", { name: "A2A fixtures" });
  await member(human, `/rooms/${room.id}/members`, "POST", { principal_id: agent.principal.id });
  const file = path.join(directory, "gateway/a2a.json");
  const options = { file, im, invokeTool: invoke, publicTools };
  let gateway = createNativeA2A(options);
  const call = (req, who = human) => gateway.handle(req, who.token ?? who);
  return { directory, file, options, im, admin, human, agent, room, member, call,
    restart: () => { gateway = createNativeA2A(options); } };
}
async function terminal(f, taskId, who) {
  for (let i = 0; i < 100; i++) {
    const result = await f.call(request("tasks/get", { id: taskId }), who);
    assert.ok(result.result, JSON.stringify(result.error));
    if (!["submitted", "working"].includes(result.result.status.state)) return result.result;
    await new Promise(setImmediate);
  }
  throw new Error("Task failed to reach a terminal state");
}

test("A2A executes member tools for both humans and Agents with durable receipts", async () => {
  const f = await fixture(async (im, name, args, credential) => {
    const durable = JSON.parse(fs.readFileSync(f.file, "utf8"));
    assert.equal(durable.tasks.at(-1).phase, "working");
    assert.deepEqual(durable.tasks.at(-1).input.arguments, args);
    assert.equal(fs.readFileSync(f.file, "utf8").includes(credential), false);
    return callNativeTool(im, name, args, credential);
  });
  for (const person of [f.human, f.agent]) {
    const message = send("im_send", { room_id: f.room.id, client_id: crypto.randomUUID(), content: "Visible from A2A" }, { contextId: "shared-work" });
    const response = await f.call(message, person);
    assert.equal(response.id, message.id);
    assert.equal(response.result.kind, "task");
    assert.equal(response.result.contextId, "shared-work");
    assert.equal(response.result.status.state, "completed");
    assert.equal(response.result.artifacts[0].parts[0].data.result.message.author_id, person.principal.id);
    assert.equal(response.result.history[0].messageId, message.params.message.messageId);
    assert.equal((await f.call(request("tasks/cancel", { id: response.result.id }), person)).error.code, -32002);
  }
  assert.equal((await f.member(f.human, `/rooms/${f.room.id}`)).messages.length, 2);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test("task ownership is authenticated independently and actor or credential input cannot override it", async () => {
  const f = await fixture();
  const response = await f.call(send("im_identity", {}));
  const taskId = response.result.id;
  const forbidden = await f.call(request("tasks/get", { id: taskId }), f.agent);
  const missing = await f.call(request("tasks/get", { id: "a2a-does-not-exist" }), f.agent);
  assert.deepEqual(forbidden.error, missing.error);
  await assert.rejects(f.call(request("tasks/get", { id: taskId }), "invalid-token"), { code: "unauthorized" });
  await assert.rejects(f.call(request("tasks/get", { id: taskId }), f.admin), { code: "unauthorized" });
  for (const args of [{ actor: f.agent.principal.id }, { actor_id: f.agent.principal.id },
    { actorId: f.agent.principal.id }, { nested: { Authorization: "override" } },
    { apiKey: "a-different-secret" }, { APIKey: "a-different-secret" },
    { accessToken: "a-different-secret" }, { content: f.human.token }]) {
    assert.ok((await f.call(send("im_identity", args))).error);
  }
  assert.equal((await f.call(send("im_identity", {}, { messageId: f.human.token }))).error.data.code, "credential_in_input");
  assert.equal((await f.call(send("im_identity", {}, { contextId: f.human.token }))).error.data.code, "credential_in_input");
  const spoof = send("im_identity", {}); spoof.params.message.actor = f.agent.principal.id;
  assert.ok((await f.call(spoof)).error);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).tasks.length, 1);
  assert.equal(fs.readFileSync(f.file, "utf8").includes(f.human.token), false);
});

test("owner/messageId deduplication survives retry and restart even without a native client_id", async () => {
  const f = await fixture();
  const message = send("im_create_room", { name: "Once", description: "Stable" }, { messageId: "stable-message" });
  const first = (await f.call(message)).result;
  const reordered = send("im_create_room", { description: "Stable", name: "Once" }, { messageId: "stable-message" });
  const concurrent = await Promise.all([f.call(reordered), f.call(reordered)]);
  assert.ok(concurrent.every((response) => response.result.id === first.id));
  f.restart();
  assert.deepEqual((await f.call(reordered)).result, first);
  const conflict = await f.call(send("im_create_room", { name: "Different" }, { messageId: "stable-message" }));
  assert.equal(conflict.error.data.code, "idempotency_conflict");
  assert.equal((await f.member(f.human, "/rooms")).rooms.filter((room) => room.name === "Once").length, 1);
  const other = (await f.call(reordered, f.agent)).result;
  assert.notEqual(other.id, first.id);
});

test("queued tasks can be canceled; running and completed operations cannot be canceled", async () => {
  const started = deferred(), release = deferred(); let invoked = 0;
  const f = await fixture(async (...args) => { invoked++; started.resolve(); await release.promise; return callNativeTool(...args); });
  const running = (await f.call(send("im_identity", {}, { blocking: false }))).result;
  await started.promise;
  const queued = (await f.call(send("im_identity", {}, { blocking: false }))).result;
  assert.equal(queued.status.state, "submitted");
  const canceled = (await f.call(request("tasks/cancel", { id: queued.id }))).result;
  assert.equal(canceled.status.state, "canceled");
  assert.equal((await f.call(request("tasks/cancel", { id: running.id }))).error.code, -32002);
  release.resolve();
  assert.equal((await terminal(f, running.id)).status.state, "completed");
  assert.equal((await terminal(f, queued.id)).status.state, "canceled");
  assert.equal(invoked, 1);
});

test("simultaneous first-request retries share one executing task", async () => {
  const started = deferred(), release = deferred(); let invoked = 0;
  const f = await fixture(async (...args) => { invoked++; started.resolve(); await release.promise; return callNativeTool(...args); });
  const message = send("im_create_room", { name: "One concurrent effect" }, { messageId: "concurrent-first-send" });
  const first = f.call(message);
  await started.promise;
  const duplicate = await f.call({ ...message, id: "new-rpc-request-id" });
  assert.equal(duplicate.result.status.state, "working");
  assert.equal(invoked, 1);
  release.resolve();
  const completed = await first;
  assert.equal(completed.result.id, duplicate.result.id);
  assert.equal(completed.result.status.state, "completed");
  assert.equal((await f.member(f.human, "/rooms")).rooms.filter((room) => room.name === "One concurrent effect").length, 1);
});

test("queued credentials are reauthenticated before any member operation is invoked", async () => {
  const started = deferred(), release = deferred(); let invoked = 0;
  const f = await fixture(async (...args) => { invoked++; started.resolve(); await release.promise; return callNativeTool(...args); });
  const first = (await f.call(send("im_identity", {}, { blocking: false }))).result;
  await started.promise;
  const queued = (await f.call(send("im_create_room", { name: "Must not execute" }, { blocking: false }), f.agent)).result;
  await f.member(f.admin, "/admin/revoke", "POST", { principal_id: f.agent.principal.id });
  release.resolve(); await terminal(f, first.id);
  let record;
  for (let i = 0; i < 100; i++) {
    record = JSON.parse(fs.readFileSync(f.file)).tasks.find((task) => task.id === queued.id);
    if (record.phase === "failed") break;
    await new Promise(setImmediate);
  }
  assert.equal(record.phase, "failed");
  assert.equal(record.receipt.error.code, "authorization_failed");
  assert.equal(invoked, 1);
});

test("input and pending queue limits reject extra work before execution", async () => {
  const started = deferred(), release = deferred(); let invoked = 0;
  const f = await fixture(async (...args) => { invoked++; started.resolve(); await release.promise; return callNativeTool(...args); });
  const tooLarge = await f.call(send("im_identity", { text: "x".repeat(LIMITS.inputBytes) }));
  assert.equal(tooLarge.error.data.code, "input_too_large");
  const first = (await f.call(send("im_identity", {}, { blocking: false }))).result;
  await started.promise;
  const queued = [];
  for (let i = 1; i < LIMITS.pending; i++) queued.push((await f.call(send("im_identity", {}, { blocking: false }))).result.id);
  assert.equal((await f.call(send("im_identity", {}, { blocking: false }))).error.data.code, "queue_capacity");
  for (const taskId of queued) await f.call(request("tasks/cancel", { id: taskId }));
  release.resolve(); await terminal(f, first.id);
  assert.equal(invoked, 1);
});

test("a restart snapshot of executing work becomes input-required and is never replayed", async () => {
  const started = deferred(), release = deferred();
  const f = await fixture(async (...args) => { started.resolve(); await release.promise; return callNativeTool(...args); });
  const message = send("im_identity", {}, { messageId: "interrupted", blocking: false });
  const original = (await f.call(message)).result; await started.promise;
  const recoveryFile = path.join(f.directory, "recovery.json");
  fs.copyFileSync(f.file, recoveryFile);
  let replays = 0;
  const recovered = createNativeA2A({ ...f.options, file: recoveryFile, invokeTool: async () => { replays++; } });
  const response = await recovered.handle(message, f.human.token);
  assert.equal(response.result.id, original.id);
  assert.equal(response.result.status.state, "input-required");
  assert.match(response.result.status.message.parts[0].text, /will not be replayed/);
  assert.equal(replays, 0);
  release.resolve(); await terminal(f, original.id);
});

test("unknown outcome after a side effect is recorded without retrying or leaking raw errors", async () => {
  let invoked = 0;
  const f = await fixture(async (...args) => { invoked++; await callNativeTool(...args); throw new Error("connection lost " + args[3]); });
  const message = send("im_create_room", { name: "Effect before network failure" }, { messageId: "ambiguous-effect" });
  const response = await f.call(message);
  assert.equal(response.result.status.state, "input-required");
  assert.equal((await f.call(message)).result.id, response.result.id);
  f.restart(); await f.call(message);
  assert.equal(invoked, 1);
  assert.equal((await f.member(f.human, "/rooms")).rooms.filter((room) => room.name === "Effect before network failure").length, 1);
  assert.equal(fs.readFileSync(f.file, "utf8").includes(f.human.token), false);
});

test("failure to store acceptance prevents invocation and puts the gateway in fail-stop", async () => {
  let invoked = 0;
  const f = await fixture(async () => { invoked++; return {}; });
  fs.writeFileSync(path.dirname(f.file), "This path is not a directory");
  const message = send("im_identity", {});
  assert.equal((await f.call(message)).error.data.code, "storage_failed");
  assert.equal((await f.call(message)).error.data.code, "storage_failed");
  assert.equal(invoked, 0);
});

test("receipt persistence failure leaves durable working state and cannot duplicate an effect on restart", async (t) => {
  let invoked = 0, failFinalWrite = false;
  const f = await fixture(async (...args) => { invoked++; const result = await callNativeTool(...args); failFinalWrite = true; return result; });
  const rename = fs.renameSync;
  fs.renameSync = function (source, destination) {
    if (destination === f.file && failFinalWrite) throw new Error("Injected receipt disk failure");
    return rename.apply(this, arguments);
  };
  t.after(() => { fs.renameSync = rename; });
  const message = send("im_create_room", { name: "Receipt failure effect" }, { messageId: "receipt-failure" });
  assert.equal((await f.call(message)).error.data.code, "storage_failed");
  const durable = JSON.parse(fs.readFileSync(f.file));
  assert.equal(durable.tasks[0].phase, "working");
  assert.equal((await f.call(request("tasks/get", { id: durable.tasks[0].id }))).error.data.code, "storage_failed");
  fs.renameSync = rename; f.restart();
  assert.equal((await f.call(message)).result.status.state, "input-required");
  assert.equal(invoked, 1);
  assert.equal((await f.member(f.human, "/rooms")).rooms.filter((room) => room.name === "Receipt failure effect").length, 1);
});

test("receipt limits and credential redaction preserve durable safe results", async () => {
  const f = await fixture(async (_im, _name, _args, credential) => ({ token: credential, apiKey: "other-secret-sentinel",
    nested: { authorization: "Bearer " + credential, accessToken: "other-secret-sentinel" }, text: "Echo " + credential }));
  const response = await f.call(send("im_identity", {}));
  assert.equal(response.result.status.state, "completed");
  assert.equal(JSON.stringify(response).includes(f.human.token), false);
  assert.equal(JSON.stringify(response).includes("other-secret-sentinel"), false);
  assert.equal(fs.readFileSync(f.file, "utf8").includes(f.human.token), false);
  let count = 0;
  const large = await fixture(async () => { count++; return { text: "x".repeat(LIMITS.receiptBytes + 1) }; });
  const message = send("im_identity", {});
  const oversized = (await large.call(message)).result;
  assert.equal(oversized.status.state, "input-required");
  assert.equal(oversized.status.message.parts[1].data.code, "receipt_too_large");
  await large.call(message); assert.equal(count, 1);
});

test("known member authorization and validation failures produce failed tasks", async () => {
  const f = await fixture();
  const invalid = (await f.call(send("im_create_room", {}))).result;
  assert.equal(invalid.status.state, "failed");
  assert.equal(invalid.status.message.parts[1].data.code, "operation_rejected");
  const privateRoom = (await f.member(f.human, "/rooms", "POST", { name: "Private" })).room;
  const denied = (await f.call(send("im_read_room", { room_id: privateRoom.id }), f.agent)).result;
  assert.equal(denied.status.state, "failed");
  assert.equal(denied.status.message.parts[1].data.code, "not_a_member");
});

test("Agent Card advertises only structured public tools and implemented transport capabilities", async () => {
  const f = await fixture();
  const gateway = createNativeA2A({ ...f.options, publicTools: [...publicTools,
    { name: "admin_reset", description: "Never expose" }, { name: "auth_login", description: "Never expose" },
    { name: "set_password", description: "Never expose" }] });
  const card = gateway.agentCard("https://office.example");
  assert.equal(card.url, "https://office.example/api/im/a2a");
  assert.equal(card.protocolVersion, "0.3.0");
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal(card.securitySchemes.bearer.scheme, "bearer");
  assert.ok(card.skills.some((skill) => skill.id === "im_send"));
  assert.ok(card.skills.some((skill) => skill.id === "enterprise_update_member"));
  assert.equal(card.skills.some((skill) => skill.id === "enterprise_create_member"), false);
  assert.equal(card.skills.some((skill) => /admin_reset|auth_login|set_password/.test(skill.id)), false);
  assert.throws(() => gateway.agentCard("https://user:secret@office.example"));
  for (const name of ["admin_reset", "auth_login", "set_password", "enterprise_create_member", "office_account"])
    assert.equal((await gateway.handle(send(name, {}), f.human.token)).error.code, -32004);
  const text = send("im_identity", {}); text.params.message.parts = [{ kind: "text", text: "Plan for me" }];
  assert.equal((await f.call(text)).error.code, -32005);
  assert.equal((await f.call([])).error.code, -32600);
  assert.equal((await f.call(request("message/stream", {}))).error.code, -32601);
});

test("corrupt persisted task receipts fail closed instead of silently resetting deduplication", async () => {
  const f = await fixture();
  await f.call(send("im_identity", {}));
  const content = JSON.parse(fs.readFileSync(f.file));
  content.tasks[0].input.operation = "im_create_room";
  fs.writeFileSync(f.file, JSON.stringify(content));
  assert.throws(() => f.restart(), /store is corrupt/);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).tasks.length, 1);
});

test("ephemeral media operations never persist SDP, ICE, or media session identifiers", async () => {
  let invoked = 0;
  const f = await fixture(async (...args) => { invoked++; return callNativeTool(...args); });
  await f.call(send("im_identity", {}));
  const before = fs.readFileSync(f.file, "utf8");
  const gateway = createNativeA2A(f.options);
  const names = gateway.agentCard("https://office.example").skills.map((skill) => skill.id);
  for (const operation of ["office_signal", "office_receive_signals", "office_join_meeting",
    "office_meeting_presence", "office_leave_meeting", "office_read_meeting", "im_presence"]) {
    assert.equal(names.includes(operation), false);
    const response = await f.call(send(operation, {
      meeting_id: "meeting-fixture", session_id: "media-temporary-session-sentinel",
      payload: { sdp: "v=0 SDP-SENTINEL", candidate: "candidate: ICE-SENTINEL" },
    }));
    assert.equal(response.error.code, -32004);
  }
  assert.equal(invoked, 1);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(before.includes("SDP-SENTINEL"), false);
  assert.equal(before.includes("media-temporary-session-sentinel"), false);
  for (const operation of ["office_meetings", "office_create_meeting", "office_end_meeting", "office_bind_notes", "office_calendar"])
    assert.ok(names.includes(operation));
});

test("completed mailbox receipts and duplicate submissions obey the current module policy without reexecution", async () => {
  let invocations = 0;
  const f = await fixture(async (...args) => { invocations++; return callNativeTool(...args); });
  await f.member(f.admin, "/admin/enterprise/bootstrap", "POST", { principal_id: f.human.principal.id });
  const sentinel = "Private retained draft " + crypto.randomUUID();
  const input = send("office_draft_mail", { client_id: "receipt-policy-draft", subject: "Private draft", body: sentinel });
  const original = (await f.call(input)).result;
  assert.equal(original.status.state, "completed");
  const taskId = original.id, draftId = original.artifacts[0].parts[0].data.result.draft.id;
  const count = invocations;
  await f.member(f.human, "/enterprise/admin/apps/mail", "PATCH", { base_revision: 1, enabled: false });
  await assert.rejects(f.member(f.human, `/mail/${draftId}`), { code: "app_policy_denied", plugin_id: "mail" });
  for (const req of [request("tasks/get", { id: taskId }), input]) {
    const result = await f.call(req);
    assert.equal(result.error.code, -32003);
    assert.equal(result.error.data.code, "app_policy_denied");
    assert.equal(result.error.data.status, 403);
    assert.equal(result.error.data.plugin_id, "mail");
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  }
  f.restart();
  assert.equal((await f.call(request("tasks/get", { id: taskId }))).error.data.plugin_id, "mail");
  assert.equal(invocations, count, "Reading or retrying a cached task never invokes the mutation again");
  const deniedNew = (await f.call(send("office_draft_mail", { client_id: "new-denied-draft", body: sentinel }))).result;
  assert.equal(deniedNew.status.state, "failed");
  assert.equal(deniedNew.status.message.parts[1].data.plugin_id, "mail");
  assert.deepEqual(deniedNew.history, []);
  assert.equal(JSON.stringify(deniedNew).includes(sentinel), false);
  await f.member(f.human, "/enterprise/admin/apps/mail", "PATCH", { base_revision: 2, enabled: true });
  const restored = (await f.call(input)).result;
  assert.equal(restored.id, taskId);
  assert.equal(restored.artifacts[0].parts[0].data.result.draft.id, draftId);
  assert.equal(invocations, count + 1, "Only the new rejected request reached the native handler");
});

test("room removal fences direct and aggregate cached receipts including their original inputs", async () => {
  let invocations = 0;
  const f = await fixture(async (...args) => { invocations++; return callNativeTool(...args); });
  const sentinel = "Former room private evidence " + crypto.randomUUID();
  await f.member(f.human, `/rooms/${f.room.id}/messages`, "POST", { client_id: "private-source", content: sentinel });
  const approval = (await f.member(f.human, `/rooms/${f.room.id}/approvals`, "POST", {
    client_id: "private-approval", template_id: "general", title: sentinel, approver_id: f.agent.principal.id,
  })).request;
  const requests = [
    send("im_create_task", { room_id: f.room.id, title: sentinel }),
    send("im_read_room", { room_id: f.room.id }),
    send("im_rooms", {}),
    send("im_search", { q: "Former room private" }),
    send("im_library", {}),
    send("im_events", { after: 0 }),
    send("im_export", { room_id: f.room.id }),
    send("office_read_approval", { approval_id: approval.id }),
  ];
  const receipts = [];
  for (const req of requests) {
    const response = await f.call(req, f.agent);
    assert.equal(response.result.status.state, "completed");
    receipts.push({ req, id: response.result.id });
  }
  const count = invocations;
  await f.member(f.human, `/rooms/${f.room.id}/members/${f.agent.principal.id}`, "DELETE");
  for (const receipt of receipts) for (const req of [request("tasks/get", { id: receipt.id }), receipt.req]) {
    const result = await f.call(req, f.agent);
    assert.equal(result.error.code, -32003);
    assert.equal(result.error.data.status, 403);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  }
  f.restart();
  assert.equal((await f.call(request("tasks/get", { id: receipts[0].id }), f.agent)).error.code, -32003);
  assert.equal(invocations, count);
  assert.equal((await f.member(f.human, `/rooms/${f.room.id}`)).tasks.length, 1);
});

test("enterprise role demotion fences completed administration snapshots without rerunning their tools", async () => {
  let invocations = 0;
  const f = await fixture(async (...args) => { invocations++; return callNativeTool(...args); });
  await f.member(f.admin, "/admin/enterprise/bootstrap", "POST", { principal_id: f.human.principal.id });
  await f.member(f.human, `/enterprise/admin/members/${f.agent.principal.id}`, "PATCH", { base_revision: 1, role: "admin" });
  const input = send("enterprise_export", {});
  const original = (await f.call(input, f.agent)).result;
  assert.equal(original.status.state, "completed");
  const count = invocations;
  await f.member(f.human, `/enterprise/admin/members/${f.agent.principal.id}`, "PATCH", { base_revision: 2, role: "member" });
  for (const req of [request("tasks/get", { id: original.id }), input]) {
    const result = await f.call(req, f.agent);
    assert.equal(result.error.code, -32003);
    assert.equal(result.error.data.code, "enterprise_admin_required");
    assert.equal(result.result, undefined);
  }
  assert.equal(invocations, count);
});
