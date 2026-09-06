"use strict";
// This launches exact copies of the current server modules in a temporary
// directory. No local .env/auth files, live workspace, or existing port is used.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const nodeHttp = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "office-http-integration-"));
const stage = path.join(temporary, "server");
const admin = crypto.randomBytes(32).toString("hex");
const secrets = [admin], children = [], observedTools = new Set();
let app, environment, base, room, human, agent, peer, outsider, sourceDigest, requestCount = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rpc = (method, params) => ({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params });
const a2a = (operation, args, messageId = crypto.randomUUID()) => rpc("message/send", {
  message: { messageId, role: "user", parts: [{ kind: "data", data: { operation, arguments: args } }] },
});
async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.notEqual(port, 3218);
  return port;
}
function start(file) {
  const child = spawn(process.execPath, [file], { cwd: stage, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { child.output += chunk.toString(); });
  children.push(child); return child;
}
async function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Isolated HTTP fixture exited before readiness");
    try { await fetch(url, { signal: AbortSignal.timeout(300) }); return; } catch {}
    await pause(40);
  }
  throw new Error("Isolated HTTP fixture failed to become ready");
}
async function http(route, { who, method = "GET", input, status = 200, headers = {} } = {}) {
  requestCount++;
  const credential = typeof who === "string" ? who : who?.token;
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...headers },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  // Failures print the route and status only, never passwords or session tokens.
  assert.equal(response.status, status, `${method} ${route.split("?")[0]} HTTP status`);
  const data = (response.headers.get("content-type") || "").includes("json") ? await response.json() : await response.text();
  return { response, data };
}
const api = async (who, route, method = "GET", input, status = 200) =>
  (await http("/api/im" + route, { who, method, input, status })).data;
async function mcp(who, name, args = {}, failed = false) {
  const result = await api(who, "/mcp", "POST", rpc("tools/call", { name, arguments: args }));
  assert.equal(result.result?.isError, failed, `MCP ${name} result`);
  if (!failed) observedTools.add(name);
  const text = result.result.content[0].text;
  try { return JSON.parse(text); } catch { return text; }
}
async function account(name, kind) {
  const machine = await api(admin, "/admin/principals", "POST", { name, kind });
  secrets.push(machine.token);
  const username = `http-${crypto.randomUUID()}`, password = crypto.randomBytes(24).toString("base64url");
  secrets.push(password);
  await api(admin, "/admin/accounts", "POST", { principal_id: machine.principal.id, username, password });
  const { response, data: session } = await http("/api/im/auth/login", { method: "POST", input: { username, password } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(session.principal.id, machine.principal.id);
  assert.equal(session.principal.kind, kind);
  assert.equal(session.token === machine.token, false);
  secrets.push(session.token);
  return { ...session, machineToken: machine.token, username, password };
}
before(async () => {
  fs.mkdirSync(stage, { recursive: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".js") || ["index.html","native-emoji-catalog.json"].includes(entry.name)))
      fs.copyFileSync(path.join(root, entry.name), path.join(stage, entry.name));
  }
  const hash = crypto.createHash("sha256");
  for (const filename of fs.readdirSync(stage).filter((name) => name.endsWith(".js") || name === "native-emoji-catalog.json").sort()) {
    hash.update(filename + "\n"); hash.update(fs.readFileSync(path.join(stage, filename)));
  }
  sourceDigest = hash.digest("hex");
  fs.symlinkSync(path.join(root, "node_modules"), path.join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const port = await freePort(), collabPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Deliberately do not inherit model keys, personal environment, or proxies.
  environment = { PATH: process.env.PATH || "", PORT: String(port), HOST: "127.0.0.1",
    COLLAB_PORT: String(collabPort), COLLAB_HOST: "127.0.0.1", COLLAB_URL: `http://127.0.0.1:${collabPort}`,
    DOC_FREE_TOKEN: admin, DOC_FREE_PUBLIC_URL: base,
    DOC_FREE_DATA: path.join(temporary, "data.json"), DOC_FREE_IM_DATA: path.join(temporary, "native-im.json"),
    DOC_FREE_CRDT_DIR: path.join(temporary, "crdt") };
  const collab = start("collab-server.js"); await ready(environment.COLLAB_URL, collab);
  app = start("server.js"); await ready(base + "/health", app);
  human = await account("HTTP Human", "human");
  agent = await account("HTTP Agent", "agent");
  peer = await account("HTTP ordinary peer", "human");
  outsider = await account("HTTP outside Agent", "agent");
  room = (await api(human, "/rooms", "POST", { name: "HTTP protocol fixture" })).room;
  for (const person of [agent, peer]) await api(human, `/rooms/${room.id}/members`, "POST", { principal_id: person.principal.id });
});
after(async () => {
  for (const child of children) await stop(child);
  for (const child of children) for (const secret of secrets)
    assert.equal(child.output.includes(secret), false, "Child process output must not contain credentials");
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("HTTP account sessions reach A2A through the actual server wiring and receipts survive restart", async () => {
  const { data: card } = await http("/.well-known/agent-card.json", { headers: { host: "untrusted.example" } });
  assert.equal(card.url, base + "/api/im/a2a");
  assert.equal(card.preferredTransport, "JSONRPC");
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal(card.securitySchemes.bearer.scheme, "bearer");
  for (const operation of ["office_account", "office_sessions", "office_revoke_session", "office_signal", "office_join_meeting", "enterprise_create_member"])
    assert.equal(card.skills.some((skill) => skill.id === operation), false);
  const messages = [];
  for (const person of [human, agent]) {
    assert.equal((await api(person, "/me")).principal.kind, person.principal.kind);
    const input = a2a("im_send", { room_id: room.id, content: `HTTP-${person.principal.kind}-receipt`, client_id: crypto.randomUUID() });
    const { response, data } = await http("/api/im/a2a", { who: person, method: "POST", input,
      headers: { "x-actor-id": outsider.principal.id } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(data.id, input.id);
    assert.equal(data.result.status.state, "completed");
    assert.equal(data.result.artifacts[0].parts[0].data.result.message.author_id, person.principal.id);
    const replay = await api(person, "/a2a", "POST", { ...input, id: "retry-rpc-id" });
    assert.equal(replay.result.id, data.result.id);
    const denied = await api(outsider, "/a2a", "POST", rpc("tasks/get", { id: data.result.id }));
    assert.equal(denied.error.code, -32001);
    const own = await api(person, "/a2a", "POST", rpc("tasks/get", { id: data.result.id }));
    assert.equal(own.result.id, data.result.id);
    messages.push({ person, input, id: data.result.id });
  }
  assert.equal((await api(human, `/rooms/${room.id}`)).messages.length, 2);
  await http("/api/im/a2a", { method: "POST", input: a2a("im_identity", {}), status: 401 });
  await http("/api/im/a2a?access_token=not-a-credential", { method: "POST", input: a2a("im_identity", {}), status: 401 });
  const input = a2a("im_identity", {}); input.params.message.actor = outsider.principal.id;
  assert.ok((await api(human, "/a2a", "POST", input)).error);
  await stop(app); app = start("server.js"); await ready(base + "/health", app);
  for (const item of messages) assert.equal((await api(item.person, "/a2a", "POST", item.input)).result.id, item.id);
  assert.equal((await api(human, `/rooms/${room.id}`)).messages.length, 2);
  const gatewayFile = fs.readFileSync(path.join(temporary, "native-a2a.json"), "utf8");
  for (const secret of secrets) assert.equal(gatewayFile.includes(secret), false);
});

test("HTTP mailbox delivery and MCP/A2A reads preserve mailbox and BCC scope", async () => {
  const draft = (await mcp(human, "office_draft_mail", { client_id: crypto.randomUUID(),
    to_ids: [agent.principal.id], bcc_ids: [peer.principal.id], subject: "HTTP private mail", body: "Internal mail fixture" })).draft;
  const sent = await mcp(human, "office_send_mail", { mail_id: draft.id, base_revision: draft.revision, client_id: "http-send-once" });
  assert.equal(sent.delivered, 2);
  assert.deepEqual(sent.item.bcc_ids, [peer.principal.id]);
  const inbox = await api(agent, "/mail?folder=inbox");
  const delivery = inbox.items.find((item) => item.message_id === draft.id);
  assert.ok(delivery);
  const detail = await mcp(agent, "office_read_mail", { mail_id: delivery.id });
  assert.equal(detail.item.body, "Internal mail fixture");
  assert.equal(JSON.stringify(detail).includes(peer.principal.id), false);
  const exported = await mcp(agent, "office_export_mail", { mail_id: delivery.id });
  assert.equal(exported.includes(peer.principal.id), false);
  await api(outsider, `/mail/${delivery.id}`, "GET", undefined, 404);
  const denied = await mcp(outsider, "office_read_mail", { mail_id: delivery.id }, true);
  assert.equal(denied.code, "not_found");
  const gatewayDenied = await api(outsider, "/a2a", "POST", a2a("office_read_mail", { mail_id: delivery.id }));
  assert.equal(gatewayDenied.result.status.state, "failed");
  assert.equal(JSON.stringify(gatewayDenied).includes("Internal mail fixture"), false);
  const allowed = await api(agent, "/a2a", "POST", a2a("office_read_mail", { mail_id: delivery.id }));
  assert.equal(allowed.result.status.state, "completed");
  assert.equal(JSON.stringify(allowed).includes(peer.principal.id), false);
});

test("HTTP approvals and attendance never expose private events or exports to ordinary peers", async () => {
  const privateNote = "private-approval-" + crypto.randomUUID();
  const privateLocation = "private-location-" + crypto.randomUUID();
  const approval = (await api(human, `/rooms/${room.id}/approvals`, "POST", {
    client_id: crypto.randomUUID(), template_id: "general", title: privateNote,
    description: privateNote, payload: { restricted_note: privateNote }, approver_id: agent.principal.id,
  })).request;
  const attendance = (await api(human, `/rooms/${room.id}/attendance`, "POST", {
    client_id: crypto.randomUUID(), action: "check_in", timezone: "UTC", location_note: privateLocation,
  })).record;
  assert.equal((await api(agent, `/approvals/${approval.id}`)).request.id, approval.id);
  await api(peer, `/approvals/${approval.id}`, "GET", undefined, 403);
  assert.equal((await mcp(peer, "office_read_approval", { approval_id: approval.id }, true)).code, "approval_scope");
  assert.equal((await mcp(peer, "office_export_approval", { approval_id: approval.id }, true)).code, "approval_scope");
  const rejected = await api(peer, "/a2a", "POST", a2a("office_read_approval", { approval_id: approval.id }));
  assert.equal(rejected.result.status.state, "failed");
  assert.equal(JSON.stringify(rejected).includes(privateNote), false);
  const ownEvents = (await api(human, "/events?after=0")).events;
  assert.ok(ownEvents.some((event) => event.request_id === approval.id));
  assert.ok(ownEvents.some((event) => event.record_id === attendance.id));
  const reviewerEvents = (await api(agent, "/events?after=0")).events;
  assert.ok(reviewerEvents.some((event) => event.request_id === approval.id));
  assert.equal(reviewerEvents.some((event) => event.record_id === attendance.id), false);
  const views = [await api(peer, "/events?after=0"), await mcp(peer, "im_events", { after: 0, wait: 0 }),
    await api(peer, "/a2a", "POST", a2a("im_events", { after: 0, wait: 0 })),
    await api(peer, `/rooms/${room.id}/export`)];
  for (const view of views) {
    const text = JSON.stringify(view);
    for (const value of [approval.id, attendance.id, privateNote, privateLocation]) assert.equal(text.includes(value), false);
  }
  await api(peer, `/approvals/${approval.id}/decision`, "POST", {
    client_id: crypto.randomUUID(), base_revision: 1, decision: "approved", actor_id: agent.principal.id,
  }, 403);
  const decided = await mcp(agent, "office_decide_approval", { approval_id: approval.id,
    client_id: crypto.randomUUID(), base_revision: 1, decision: "approved" });
  assert.equal(decided.request.decided_by, agent.principal.id);
});

test("builtin plugin declarations resolve to real authenticated MCP operations including ephemeral media", async (t) => {
  const initialized = await api(human, "/mcp", "POST", rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "HTTP fixture", version: "1" } }));
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  const tools = (await api(human, "/mcp", "POST", rpc("tools/list", {}))).result.tools;
  const toolNames = new Set(tools.map((tool) => tool.name));
  const plugins = (await mcp(human, "office_plugins")).plugins;
  const capabilities = (await mcp(human, "office_capabilities")).capabilities;
  const document = (await mcp(human, "im_create_document", { room_id: room.id, title: "HTTP canonical note", content: "# Shared HTTP note" })).document;
  const task = (await mcp(human, "im_create_task", { room_id: room.id, title: "HTTP task", assignee_id: agent.principal.id })).task;
  const meeting = (await mcp(human, "office_create_meeting", { room_id: room.id, title: "Synthetic protocol meeting", client_id: crypto.randomUUID() })).meeting;
  const firstMedia = await mcp(human, "office_join_meeting", { meeting_id: meeting.id, device_id: "synthetic-human" });
  const secondMedia = await mcp(agent, "office_join_meeting", { meeting_id: meeting.id, device_id: "synthetic-agent" });
  const signalSentinel = "synthetic-ice-" + crypto.randomUUID();
  await mcp(human, "office_signal", { meeting_id: meeting.id, session_id: firstMedia.session_id,
    to: secondMedia.session_id, kind: "candidate", payload: { candidate: signalSentinel } });
  const approval = (await mcp(human, "office_create_approval", { room_id: room.id, client_id: crypto.randomUUID(),
    template_id: "general", title: "Protocol decision", approver_id: agent.principal.id })).request;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const cases = {
    "im.identity": ["im_identity", {}], "im.contacts": ["im_contacts", {}], "im.rooms": ["im_rooms", {}],
    "im.messages": ["im_history", { room_id: room.id }], "im.agents": ["im_agents", {}],
    "im.attachments": ["im_attachments", { room_id: room.id }],
    "docs.documents": ["im_read_document", { room_id: room.id, document_id: document.id }],
    "tasks.tasks": ["im_update_task", { room_id: room.id, task_id: task.id, base_revision: task.revision, status: "doing" }],
    "meetings.meetings": ["office_read_meeting", { meeting_id: meeting.id }],
    "meetings.media": ["office_receive_signals", { meeting_id: meeting.id, session_id: secondMedia.session_id, after: 0, wait: 0 }, agent],
    "calendar.events": ["office_calendar", {}], "workbench.preferences": ["office_workbench", {}],
    "attendance.records": ["office_attendance", {}],
    "attendance.corrections": ["office_attendance_correction", { room_id: room.id, client_id: crypto.randomUUID(), date: yesterday,
      timezone: "UTC", check_in_at: `${yesterday}T09:00:00Z`, check_out_at: `${yesterday}T17:00:00Z`, reason: "HTTP fixture correction", approver_id: agent.principal.id }],
    "approvals.requests": ["office_read_approval", { approval_id: approval.id }],
    "approvals.decisions": ["office_decide_approval", { approval_id: approval.id, base_revision: approval.revision,
      decision: "approved", client_id: crypto.randomUUID() }, agent],
    "mail.messages": ["office_mail_folders", {}], "settings.preferences": ["office_settings", {}],
    "settings.plugins": ["office_plugins", {}],
  };
  const core = new Set(["im", "docs", "tasks", "meetings", "calendar", "workbench", "attendance", "approvals", "mail", "settings"]);
  for (const plugin of plugins.filter((entry) => core.has(entry.id))) {
    assert.equal(plugin.available, true); assert.equal(plugin.execution, "native_authorized_handler");
    for (const capability of plugin.capabilities) {
      assert.ok(cases[capability.id], `Capability has a real endpoint probe: ${capability.id}`);
      assert.ok(capabilities.some((entry) => entry.id === capability.id && entry.available));
    }
  }
  for (const [capability, [name, args, person = human]] of Object.entries(cases)) {
    assert.ok(toolNames.has(name), `${capability} is declared in tools/list`);
    const result = await mcp(person, name, args);
    if (capability === "meetings.media") assert.equal(result.signals[0].payload.candidate, signalSentinel);
  }
  for (const name of ["office_account", "office_sessions", "office_revoke_session"]) assert.ok(toolNames.has(name));
  const blocked = await api(human, "/a2a", "POST", a2a("office_signal", { meeting_id: meeting.id,
    session_id: firstMedia.session_id, to: secondMedia.session_id, kind: "candidate", payload: { candidate: signalSentinel } }));
  assert.equal(blocked.error.code, -32004);
  for (const file of ["native-im.json", "native-a2a.json"]) assert.equal(fs.readFileSync(path.join(temporary, file), "utf8").includes(signalSentinel), false);
  await mcp(human, "office_leave_meeting", { meeting_id: meeting.id, session_id: firstMedia.session_id });
  await mcp(agent, "office_leave_meeting", { meeting_id: meeting.id, session_id: secondMedia.session_id });
  const closed = await api(human, "/a2a", "POST", a2a("office_end_meeting", { meeting_id: meeting.id }));
  assert.equal(closed.result.status.state, "completed");
  t.diagnostic(`Verified ${Object.keys(cases).length} builtin capability mappings through actual HTTP MCP invocations; ${observedTools.size} unique tools exercised.`);
});

test("enterprise owners authorize Agents through the same HTTP MCP/A2A role boundary as humans", async (t) => {
  const identity = await mcp(human, "enterprise_identity");
  assert.equal(identity.membership.role, "member", "Room ownership does not grant enterprise management");
  assert.equal(identity.capabilities.access_admin, false);
  await api(human, "/enterprise/admin/overview", "GET", undefined, 403);
  await api(agent, "/admin/enterprise/bootstrap", "POST", { principal_id: agent.principal.id }, 401);
  const enterprise = await api(admin, "/admin/enterprise/bootstrap", "POST", {
    principal_id: human.principal.id, name: "HTTP equal rights enterprise",
  });
  assert.equal(enterprise.membership.role, "owner");
  for (const person of [agent, peer]) {
    const denied = await mcp(person, "enterprise_members", {}, true);
    assert.equal(denied.code, "enterprise_admin_required");
    const gateway = await api(person, "/a2a", "POST", a2a("enterprise_overview", {}));
    assert.equal(gateway.result.status.state, "failed");
    assert.equal(gateway.result.status.message.parts[1].data.code, "enterprise_admin_required");
  }
  const member = (await mcp(human, "enterprise_read_member", { principal_id: agent.principal.id })).member;
  const promoted = await api(human, "/a2a", "POST", a2a("enterprise_update_member", {
    principal_id: agent.principal.id, base_revision: member.revision, role: "admin",
  }));
  assert.equal(promoted.result.status.state, "completed");
  assert.equal(promoted.result.artifacts[0].parts[0].data.result.member.role, "admin");
  const overview = await mcp(agent, "enterprise_overview");
  assert.equal(overview.membership.kind, "agent");
  assert.equal(overview.capabilities.manage_members, true);
  assert.equal(overview.capabilities.assign_owner, false);
  assert.ok((await mcp(agent, "enterprise_roles")).roles.some((role) => role.id === "admin"));
  assert.equal((await mcp(agent, "enterprise_read_role", { role_id: "owner" })).role.capabilities.assign_admin, true);

  const creation = { name: "HTTP managed Agent", kind: "agent", client_id: "http-member-create-once" };
  const created = await mcp(agent, "enterprise_create_member", creation);
  assert.equal(created.member.role, "member");
  assert.equal(created.credential_returned, true);
  assert.ok(created.token); secrets.push(created.token);
  const repeated = await mcp(agent, "enterprise_create_member", creation);
  assert.equal(repeated.member.id, created.member.id);
  assert.equal(repeated.token, null);
  const blocked = await api(agent, "/a2a", "POST", a2a("enterprise_create_member", {
    ...creation, client_id: "must-not-create-durable-credential",
  }));
  assert.equal(blocked.error.code, -32004);
  const managed = await mcp(agent, "enterprise_members", { q: "HTTP managed", page_size: 1 });
  assert.equal(managed.total, 1);

  const departmentInput = { name: "HTTP native research", client_id: "http-department-once" };
  const department = (await mcp(agent, "enterprise_create_department", departmentInput)).department;
  assert.equal((await mcp(agent, "enterprise_create_department", departmentInput)).department.id, department.id);
  const child = (await mcp(agent, "enterprise_create_department", {
    name: "HTTP research child", parent_id: department.id, client_id: "http-child-once",
  })).department;
  assert.equal((await mcp(agent, "enterprise_departments", { q: "HTTP" })).departments.length, 2);
  assert.equal((await mcp(agent, "enterprise_read_department", { department_id: child.id })).department.parent_id, department.id);
  const cycle = await mcp(agent, "enterprise_update_department", {
    department_id: department.id, base_revision: department.revision, parent_id: child.id,
  }, true);
  assert.equal(cycle.code, "department_cycle");
  const renamed = (await mcp(agent, "enterprise_update_department", {
    department_id: child.id, base_revision: child.revision, name: "HTTP applied research",
  })).department;
  const assigned = (await mcp(agent, "enterprise_update_member", {
    principal_id: created.member.id, base_revision: created.member.revision, department_id: child.id,
  })).member;
  assert.equal((await mcp(agent, "enterprise_delete_department", {
    department_id: child.id, base_revision: renamed.revision,
  }, true)).code, "department_not_empty");
  const moved = (await mcp(agent, "enterprise_update_member", {
    principal_id: created.member.id, base_revision: assigned.revision, department_id: null,
  })).member;
  for (const entry of [renamed, department]) assert.equal((await mcp(agent, "enterprise_delete_department", {
    department_id: entry.id, base_revision: entry.revision,
  })).removed, true);
  assert.equal((await mcp(agent, "enterprise_revoke_member", {
    principal_id: created.member.id, base_revision: moved.revision,
  })).member.status, "revoked");
  await api(created.token, "/me", "GET", undefined, 401);

  const escalation = await api(agent, "/a2a", "POST", a2a("enterprise_update_member", {
    principal_id: agent.principal.id, base_revision: overview.membership.revision, role: "owner",
  }));
  assert.equal(escalation.result.status.state, "failed");
  assert.equal(escalation.result.status.message.parts[1].data.code, "enterprise_owner_required");
  const spoof = await api(peer, "/a2a", "POST", a2a("enterprise_update_member", {
    principal_id: peer.principal.id, base_revision: 1, role: "owner", actor_id: human.principal.id,
  }));
  assert.equal(spoof.error.data.code, "credential_or_actor_override");
  const lastOwner = await mcp(human, "enterprise_update_member", {
    principal_id: human.principal.id, base_revision: enterprise.membership.revision, role: "member",
  }, true);
  assert.equal(lastOwner.code, "last_enterprise_owner");
  await mcp(human, "enterprise_update_profile", {
    base_revision: enterprise.enterprise.revision, name: "HTTP human and Agent enterprise",
  });
  const audit = await mcp(agent, "enterprise_audit", { q: "department.deleted", page_size: 10 });
  assert.equal(audit.total, 2);
  assert.ok(audit.entries.every((entry) => entry.actor_id === agent.principal.id && entry.actor_kind === "agent"));
  const exported = await mcp(agent, "enterprise_export");
  assert.ok(exported.includes("HTTP human and Agent enterprise"));
  for (const secret of [...secrets, "token_hash", "password_hash", "Internal mail fixture"])
    assert.equal(exported.includes(secret), false, "Enterprise document excludes credentials and private mailbox content");
  await api(peer, "/enterprise/admin/export", "GET", undefined, 403);
  await mcp(human, "enterprise_update_member", {
    principal_id: agent.principal.id, base_revision: overview.membership.revision, role: "member",
  });
  assert.equal((await mcp(agent, "enterprise_overview", {}, true)).code, "enterprise_admin_required");
  const demoted = await api(agent, "/a2a", "POST", a2a("enterprise_overview", {}));
  assert.equal(demoted.result.status.state, "failed", "Existing login cannot retain removed enterprise privileges");
  assert.equal((await mcp(peer, "enterprise_identity")).membership.role, "member");
  for (const file of ["native-im.json", "native-a2a.json"]) {
    const stored = fs.readFileSync(path.join(temporary, file), "utf8");
    for (const secret of secrets) assert.equal(stored.includes(secret), false);
  }
  t.diagnostic("Verified all 17 enterprise MCP tools, owner-granted Agent administration, immediate demotion, and credential-issuing A2A exclusion.");
});

test("enterprise application policy fences REST, MCP, fresh A2A and cached receipts while recovery stays available", async (t) => {
  const current = (await mcp(human, "enterprise_read_member", { principal_id: agent.principal.id })).member;
  await mcp(human, "enterprise_update_member", { principal_id: agent.principal.id, base_revision: current.revision, role: "admin" });
  const apps = await mcp(agent, "enterprise_apps");
  assert.ok(apps.apps.some((entry) => entry.id === "mail"));
  assert.equal((await mcp(peer, "enterprise_configure_app", { plugin_id: "mail", base_revision: 1, enabled: false }, true)).code, "enterprise_admin_required");
  const mailbox = await mcp(agent, "office_mail", { folder: "inbox" });
  const document = (await api(agent, `/rooms/${room.id}`)).documents[0];
  const privateApproval = (await mcp(human, "office_create_approval", { room_id: room.id,
    client_id: "app-policy-private-approval", template_id: "general", title: "Policy approval sentinel",
    description: "Private policy approval payload", approver_id: agent.principal.id })).request;
  const cases = [
    { plugin: "mail", operation: "office_read_mail", args: { mail_id: mailbox.items[0].id }, route: `/mail/${mailbox.items[0].id}`, sentinel: "Internal mail fixture", resultType: "mail" },
    { plugin: "docs", operation: "im_read_document", args: { room_id: room.id, document_id: document.id }, route: `/rooms/${room.id}/documents/${document.id}`, sentinel: "Shared HTTP note", resultType: "document" },
    { plugin: "approvals", operation: "office_read_approval", args: { approval_id: privateApproval.id }, route: `/approvals/${privateApproval.id}`, sentinel: "Private policy approval payload", resultType: "approval" },
  ];
  for (const entry of cases) {
    const input = a2a(entry.operation, entry.args);
    const cached = await api(agent, "/a2a", "POST", input);
    assert.equal(cached.result.status.state, "completed");
    assert.ok(JSON.stringify(cached).includes(entry.sentinel));
    const searchInput = a2a("im_search", { q: entry.sentinel });
    const cachedSearch = await api(agent, "/a2a", "POST", searchInput);
    assert.equal(cachedSearch.result.status.state, "completed");
    assert.ok(JSON.stringify(cachedSearch.result.artifacts).includes(entry.sentinel));
    const policy = (await mcp(agent, "enterprise_read_app", { plugin_id: entry.plugin })).app.policy;
    await mcp(agent, "enterprise_configure_app", { plugin_id: entry.plugin, base_revision: policy.revision,
      enabled: true, denied_principal_ids: [agent.principal.id] });
    const rest = await api(agent, entry.route, "GET", undefined, 403);
    assert.equal(rest.code, "app_policy_denied"); assert.equal(rest.plugin_id, entry.plugin);
    const tool = await mcp(agent, entry.operation, entry.args, true);
    assert.equal(tool.code, "app_policy_denied"); assert.equal(tool.plugin_id, entry.plugin);
    const fresh = await api(agent, "/a2a", "POST", a2a(entry.operation, entry.args));
    assert.equal(fresh.result.status.state, "failed");
    assert.equal(fresh.result.status.message.parts[1].data.plugin_id, entry.plugin);
    assert.deepEqual(fresh.result.history, []);
    for (const request of [rpc("tasks/get", { id: cached.result.id }), input,
      rpc("tasks/get", { id: cachedSearch.result.id }), searchInput]) {
      const denied = await api(agent, "/a2a", "POST", request);
      assert.equal(denied.error.code, -32003);
      assert.equal(denied.error.data.code, "app_policy_denied");
      assert.equal(denied.error.data.status, 403);
      assert.equal(denied.error.data.plugin_id, entry.plugin);
      assert.equal(JSON.stringify(denied).includes(entry.sentinel), false);
    }
    const plugin = (await mcp(agent, "office_plugins")).plugins.find((item) => item.id === entry.plugin);
    assert.equal(plugin.enterprise_allowed, false);
    assert.equal(plugin.effective_enabled, false);
    const search = await mcp(agent, "im_search", { q: entry.sentinel });
    assert.equal(search.results.some((item) => item.type === entry.resultType), false);
    const freshSearch = await api(agent, "/a2a", "POST", a2a("im_search", { q: entry.sentinel }));
    assert.equal(freshSearch.result.status.state, "completed", "Fresh search may return a current filtered result");
    const freshResults = freshSearch.result.artifacts[0].parts[0].data.result.results;
    assert.equal(freshResults.some((item) => item.type === entry.resultType), false);
    assert.equal(JSON.stringify(freshResults).includes(entry.sentinel), false);
    const freshLibrary = await api(agent, "/a2a", "POST", a2a("im_library", {}));
    assert.equal(freshLibrary.result.status.state, "completed", "Current filtered library remains usable");
    if (entry.plugin === "docs") assert.deepEqual(freshLibrary.result.artifacts[0].parts[0].data.result.documents, []);
    const events = await mcp(agent, "im_events", { after: 0 });
    assert.equal(events.events.some((event) => event.type.startsWith({ mail: "mail.", docs: "document.", approvals: "approval." }[entry.plugin])), false);
    assert.equal((await mcp(agent, "enterprise_identity")).membership.role, "admin");
    assert.ok(await mcp(agent, "office_settings"));
    await mcp(agent, "enterprise_configure_app", { plugin_id: entry.plugin, base_revision: policy.revision + 1,
      enabled: true, denied_principal_ids: [] });
    const restored = await api(agent, "/a2a", "POST", input);
    assert.equal(restored.result.id, cached.result.id);
  }
  const enterpriseReceipt = await api(agent, "/a2a", "POST", a2a("enterprise_export", {}));
  await mcp(human, "enterprise_update_member", { principal_id: agent.principal.id, base_revision: current.revision + 1, role: "member" });
  const demoted = await api(agent, "/a2a", "POST", rpc("tasks/get", { id: enterpriseReceipt.result.id }));
  assert.equal(demoted.error.data.code, "enterprise_admin_required");
  assert.equal(demoted.result, undefined);
  t.diagnostic("Verified all 3 enterprise app-policy tools and current authorization for cached mail, canonical document, approval and enterprise receipts.");
});

test("logging out invalidates the HTTP session for both MCP and A2A without revoking its machine identity", async (t) => {
  const owned = await api(agent, "/a2a", "POST", a2a("im_identity", {}));
  await api(agent, "/auth/logout", "POST", {});
  await api(agent, "/a2a", "POST", rpc("tasks/get", { id: owned.result.id }), 401);
  await api(agent, "/mcp", "POST", rpc("tools/list", {}), 401);
  assert.equal((await api(agent.machineToken, "/me")).principal.id, agent.principal.id);
  const login = await api("", "/auth/login", "POST", { username: agent.username, password: agent.password });
  secrets.push(login.token);
  const receipt = await api(login, "/a2a", "POST", rpc("tasks/get", { id: owned.result.id }));
  assert.equal(receipt.result.id, owned.result.id);
  for (const file of ["native-im.json", "native-a2a.json"]) {
    const stored = fs.readFileSync(path.join(temporary, file), "utf8");
    for (const secret of secrets) assert.equal(stored.includes(secret), false);
  }
  t.diagnostic(`Completed ${requestCount} real HTTP requests with isolated server/CRDT processes and no model, email transport, or real media capture.`);
  t.diagnostic(`Staged JavaScript and emoji catalog source SHA-256: ${sourceDigest}`);
});

test("registered integration declarations remain unavailable and do not manufacture MCP or A2A endpoints", async (t) => {
  let calls = 0;
  const adapter = nodeHttp.createServer((_request, response) => { calls++; response.end("Unexpected invocation"); });
  adapter.listen(0, "127.0.0.1"); await once(adapter, "listening");
  t.after(() => new Promise((resolve) => adapter.close(resolve)));
  const manifest = { id: "http_adapter", name: "HTTP declared integration", kind: "integration",
    capabilities: [{ id: "http_adapter.status", name: "External status" }],
    adapter: { transport: "mcp", endpoint: `http://127.0.0.1:${adapter.address().port}/mcp` },
    config_schema: { label: { type: "string", default: "Fixture" } } };
  await api(peer, "/admin/plugins", "POST", { manifest }, 401);
  const registered = await api(admin, "/admin/plugins", "POST", { manifest });
  assert.equal(registered.plugin.available, false);
  const configured = await mcp(human, "office_configure_plugin", {
    plugin_id: "http_adapter", base_revision: 1, enabled: true, config: { label: "Enabled preference" },
  });
  assert.equal(configured.plugin.enabled, true);
  assert.equal(configured.plugin.execution, "not_connected");
  assert.equal(configured.plugin.available, false);
  const declaration = (await mcp(human, "office_capabilities")).capabilities.find((item) => item.id === "http_adapter.status");
  assert.equal(declaration.available, false); assert.equal(declaration.execution, "not_connected");
  const tools = (await api(human, "/mcp", "POST", rpc("tools/list", {}))).result.tools;
  assert.equal(tools.some((tool) => tool.name === "http_adapter.status"), false);
  assert.equal((await mcp(human, "http_adapter.status", {}, true)).code, "unknown_tool");
  const gateway = await api(human, "/a2a", "POST", a2a("http_adapter.status", {}));
  assert.equal(gateway.error.code, -32004);
  assert.equal(calls, 0);
  t.diagnostic(`Final request count: ${requestCount}; registered extension made zero outbound adapter requests.`);
});
