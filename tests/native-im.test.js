"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createNativeIM } = require("../native-im");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-im-test-"));
const root = path.resolve(__dirname, "..");
const admin = crypto.randomBytes(32).toString("hex");
let base, environment, app, collab;
const children = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const socket = net.createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  return port;
}
function start(file) {
  const child = spawn(process.execPath, [file], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.errors = "";
  child.stderr.on("data", (chunk) => {
    child.errors += chunk.toString();
  });
  children.push(child);
  return child;
}
async function ready(url, child) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null)
      throw new Error(`Server exited: ${child.errors}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(300) });
      return;
    } catch {}
    await pause(50);
  }
  throw new Error(`Server not ready: ${child.errors}`);
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await once(child, "exit");
  }
}
before(async () => {
  const port = await freePort(),
    collabPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  environment = {
    ...process.env,
    PORT: String(port),
    COLLAB_PORT: String(collabPort),
    COLLAB_URL: `http://127.0.0.1:${collabPort}`,
    DOC_FREE_TOKEN: admin,
    DOC_FREE_DATA: path.join(temporary, "data.json"),
    DOC_FREE_CRDT_DIR: path.join(temporary, "crdt"),
    DOC_FREE_IM_DATA: path.join(temporary, "native-im.json"),
  };
  collab = start("collab-server.js");
  await ready(environment.COLLAB_URL, collab);
  app = start("server.js");
  await ready(base + "/health", app);
});
after(async () => {
  for (const child of children) await stop(child);
  fs.rmSync(temporary, { recursive: true, force: true });
});
async function call(token, route, method = "GET", input, status = 200) {
  const response = await fetch(base + "/api/im" + route, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-actor-id": "forged-owner",
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const result = response.headers.get("content-type").includes("markdown")
    ? await response.text()
    : await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
const provision = (name, kind = "human") =>
  call(admin, "/admin/principals", "POST", { name, kind });
const post = (token, room, content, extra = {}) =>
  call(token, `/rooms/${room.id}/messages`, "POST", {
    client_id: crypto.randomUUID(),
    content,
    ...extra,
  });
const detail = (token, room) => call(token, `/rooms/${room.id}`);
async function fixture() {
  const human = await provision("研究负责人");
  const agent = await provision("交付 Agent", "agent");
  const outside = await provision("Other team");
  const { room } = await call(human.token, "/rooms", "POST", {
    name: "Office launch",
    description: "Visible work",
  });
  await call(human.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: agent.principal.id,
  });
  return { human, agent, outside, room };
}
const finishBody = (lease, overrides = {}) => ({
  lease_token: lease,
  action: "reply",
  content: "已检查，请审阅交付物。",
  rationale: "基于已记录的共享上下文",
  model: "fixture-model",
  reasoning_effort: "medium",
  ...overrides,
});

test("independent identities authenticate author, room boundaries and kind-neutral capabilities", async () => {
  const { human, agent, outside, room } = await fixture();
  await call(admin, "/me", "GET", undefined, 401);
  assert.equal(
    (await call(agent.token, "/me")).principal.id,
    agent.principal.id,
  );
  await call(outside.token, `/rooms/${room.id}`, "GET", undefined, 403);
  await call(outside.token, `/rooms/${room.id}/export`, "GET", undefined, 403);
  await call(
    agent.token,
    `/rooms/${room.id}/members`,
    "POST",
    { principal_id: outside.principal.id },
    403,
  );
  const { message } = await post(
    agent.token,
    room,
    "Agent has the same message API",
    { author_id: human.principal.id, author: { kind: "human" } },
  );
  assert.equal(message.author_id, agent.principal.id);
  assert.equal(message.author.kind, "agent");
  assert.equal((await call(outside.token, "/rooms")).rooms.length, 0);
  assert.equal(
    (await call(outside.token, "/events?after=0")).events.some(
      (e) => e.room_id === room.id,
    ),
    false,
  );
  const agentRoom = await call(agent.token, "/rooms", "POST", {
    name: "Agent owned",
  });
  await call(agent.token, `/rooms/${agentRoom.room.id}/members`, "POST", {
    principal_id: human.principal.id,
  });
  const legacy = await fetch(base + "/api/workspace", {
    headers: { authorization: `Bearer ${agent.token}` },
  });
  assert.equal(legacy.status, 401);
  const stored = fs.readFileSync(environment.DOC_FREE_IM_DATA, "utf8");
  assert.equal(stored.includes(agent.token), false);
  assert.equal(stored.includes(human.token), false);
  assert.equal(fs.statSync(environment.DOC_FREE_IM_DATA).mode & 0o777, 0o600);
});

test("durable messages reject changed duplicate payload, validate reply/mentions and replay after restart", async () => {
  const { human, agent, outside, room } = await fixture();
  const data = {
    client_id: "stable-client",
    content: "One logical message",
    mentions: [agent.principal.id],
  };
  const first = await call(
    human.token,
    `/rooms/${room.id}/messages`,
    "POST",
    data,
  );
  const same = await call(
    human.token,
    `/rooms/${room.id}/messages`,
    "POST",
    data,
  );
  assert.equal(same.duplicate, true);
  assert.equal(same.message.id, first.message.id);
  await call(
    human.token,
    `/rooms/${room.id}/messages`,
    "POST",
    { ...data, content: "different" },
    409,
  );
  await post(human.token, room, "invalid", {
    mentions: [outside.principal.id],
  }).then(
    () => assert.fail("must reject"),
    () => {},
  );
  await call(
    human.token,
    `/rooms/${room.id}/messages`,
    "POST",
    { client_id: "bad-reply", content: "invalid", reply_to: "external" },
    422,
  );
  await stop(app);
  app = start("server.js");
  await ready(base + "/health", app);
  assert.equal(
    (await call(human.token, `/rooms/${room.id}/messages`, "POST", data))
      .duplicate,
    true,
  );
  const replay = await call(
    agent.token,
    `/events?after=${first.message.seq - 1}`,
  );
  assert.equal(replay.events[0].message.id, first.message.id);
  assert.equal(
    (await call(agent.token, `/events?after=${replay.cursor}`)).events.length,
    0,
  );
  assert.equal(
    (await call(agent.token, "/events?after=9007199254740991")).reset_required,
    true,
  );
});

test("long polling rechecks removal and credential revocation before delivering events", async () => {
  const { human, agent, room } = await fixture();
  const cursor = (await call(agent.token, "/events")).cursor;
  const waiting = call(agent.token, `/events?after=${cursor}&wait=2`);
  await pause(50);
  await call(
    human.token,
    `/rooms/${room.id}/members/${agent.principal.id}`,
    "DELETE",
  );
  await post(human.token, room, "Member removal must hide this");
  assert.equal((await waiting).events.length, 0);
  await call(agent.token, `/rooms/${room.id}`, "GET", undefined, 403);
  await call(human.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: agent.principal.id,
  });
  const next = (await call(agent.token, "/events")).cursor;
  const revoked = call(
    agent.token,
    `/events?after=${next}&wait=2`,
    "GET",
    undefined,
    401,
  );
  await pause(50);
  await call(admin, "/admin/revoke", "POST", {
    principal_id: agent.principal.id,
  });
  await revoked;
  await call(agent.token, "/me", "GET", undefined, 401);
});

test("native room documents use canonical revisions, scope and exact CRDT freshness", async () => {
  const { human, agent, outside, room } = await fixture();
  const { document } = await call(
    agent.token,
    `/rooms/${room.id}/documents`,
    "POST",
    { title: "Delivery brief", content: "## Acceptance\n\nDraft v1" },
  );
  assert.equal(document.revision, 1);
  const { room: second } = await call(outside.token, "/rooms", "POST", {
    name: "Private",
  });
  await call(
    outside.token,
    `/rooms/${second.id}/documents/${document.id}`,
    "GET",
    undefined,
    403,
  );
  const updated = await call(
    human.token,
    `/rooms/${room.id}/documents/${document.id}`,
    "PUT",
    {
      title: document.title,
      content: "## Acceptance\n\nDraft v2",
      base_revision: 1,
    },
  );
  assert.equal(updated.document.revision, 2);
  await call(
    agent.token,
    `/rooms/${room.id}/documents/${document.id}`,
    "PUT",
    { content: "stale", base_revision: 1 },
    409,
  );
  const { turn, context } = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {
      instructions: "Visible instructions",
      model: "fixture-model",
      reasoning_effort: "medium",
      lease_seconds: 60,
    },
  );
  assert.ok(turn);
  assert.equal(context.documents[0].content, updated.document.content);
  assert.equal(context.instructions, "Visible instructions");
  assert.equal(context.document_manifest[0].revision, 2);
  assert.equal(
    JSON.stringify((await detail(human.token, room)).runs).includes(
      turn.lease_token,
    ),
    false,
  );
  await call(human.token, `/rooms/${room.id}/documents/${document.id}`, "PUT", {
    content: "Human changed during inference",
    base_revision: 2,
  });
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${turn.id}/finish`,
    "POST",
    finishBody(turn.lease_token),
    409,
  );
  const visible = await detail(human.token, room);
  assert.equal(visible.messages.length, 0);
  assert.equal(visible.runs.at(-1).status, "stale");
  const fresh = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  assert.equal(
    fresh.context.documents[0].content,
    "Human changed during inference",
  );
  const output = finishBody(fresh.turn.lease_token, {
    artifact: {
      title: "Review",
      content: "## Result\n\nAn exact deliverable.",
    },
  });
  const result = await call(
    agent.token,
    `/rooms/${room.id}/turns/${fresh.turn.id}/finish`,
    "POST",
    output,
  );
  assert.equal(result.turn.result.artifact.title, "Review");
  assert.equal(
    (
      await call(
        agent.token,
        `/rooms/${room.id}/turns/${fresh.turn.id}/finish`,
        "POST",
        output,
      )
    ).duplicate,
    true,
  );
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${fresh.turn.id}/finish`,
    "POST",
    { ...output, content: "Changed output" },
    409,
  );
  const exported = await call(human.token, `/rooms/${room.id}/export`);
  assert.ok(exported.includes("active-im/v1"));
  assert.ok(exported.includes("Visible instructions"));
  assert.ok(exported.includes("An exact deliverable."));
  assert.equal(exported.includes(fresh.turn.lease_token), false);
});

test("office tasks have kind-neutral revision checks, assigned triggers and immutable invocation context", async () => {
  const { human, agent, outside, room } = await fixture();
  await call(agent.token, `/rooms/${room.id}/participation`, "PATCH", {
    mode: "mentions",
  });
  await post(
    human.token,
    room,
    "Ordinary message should not call mentions-only participant",
  );
  assert.equal(
    (await call(agent.token, `/rooms/${room.id}/turns/claim`, "POST", {})).turn,
    null,
  );
  await call(
    human.token,
    `/rooms/${room.id}/tasks`,
    "POST",
    { title: "Wrong assignee", assignee_id: outside.principal.id },
    422,
  );
  const { task } = await call(human.token, `/rooms/${room.id}/tasks`, "POST", {
    title: "Write launch plan",
    description: "Use shared brief",
    assignee_id: agent.principal.id,
  });
  const claim = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  assert.equal(claim.context.tasks[0].id, task.id);
  const changed = await call(
    agent.token,
    `/rooms/${room.id}/tasks/${task.id}`,
    "PATCH",
    { status: "doing", base_revision: 1 },
  );
  assert.equal(changed.task.revision, 2);
  await call(
    human.token,
    `/rooms/${room.id}/tasks/${task.id}`,
    "PATCH",
    { status: "done", base_revision: 1 },
    409,
  );
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${claim.turn.id}/finish`,
    "POST",
    finishBody(claim.turn.lease_token),
    409,
  );
  assert.equal(
    (await call(human.token, `/rooms/${room.id}/turns/${claim.turn.id}`)).turn
      .context.tasks[0].status,
    "open",
  );
  assert.equal(
    (await call(agent.token, `/rooms/${room.id}/turns/claim`, "POST", {})).turn,
    null,
    "own task edits do not trigger self loops",
  );
});

test("agent root dedup, explicit A2A mentions, depth budget, join and pause baselines suppress loops", async () => {
  const { human, agent, room } = await fixture();
  const second = await provision("Reviewer", "agent"),
    third = await provision("Editor", "agent"),
    fourth = await provision("Publisher", "agent");
  for (const target of [second, third, fourth])
    await call(human.token, `/rooms/${room.id}/members`, "POST", {
      principal_id: target.principal.id,
    });
  await post(human.token, room, "Please draft", {
    mentions: [agent.principal.id],
  });
  // Existing human trigger must be consumed by the peers before A2A test.
  for (const target of [second, third, fourth])
    await call(target.token, `/rooms/${room.id}/participation`, "PATCH", {
      mode: "mentions",
    });
  const one = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${one.turn.id}/finish`,
    "POST",
    finishBody(one.turn.lease_token, { mentions: [second.principal.id] }),
  );
  assert.equal(
    (await call(agent.token, `/rooms/${room.id}/turns/claim`, "POST", {})).turn,
    null,
  );
  const two = await call(
    second.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  assert.equal(two.turn.depth, 2);
  await call(
    second.token,
    `/rooms/${room.id}/turns/${two.turn.id}/finish`,
    "POST",
    finishBody(two.turn.lease_token, {
      mentions: [third.principal.id, agent.principal.id],
    }),
  );
  assert.equal(
    (await call(agent.token, `/rooms/${room.id}/turns/claim`, "POST", {})).turn,
    null,
    "same agent does not repeat root",
  );
  const three = await call(
    third.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  assert.equal(three.turn.depth, 3);
  await call(
    third.token,
    `/rooms/${room.id}/turns/${three.turn.id}/finish`,
    "POST",
    finishBody(three.turn.lease_token, { mentions: [fourth.principal.id] }),
  );
  assert.equal(
    (await call(fourth.token, `/rooms/${room.id}/turns/claim`, "POST", {}))
      .turn,
    null,
    "depth budget enforced",
  );
  await call(agent.token, `/rooms/${room.id}/participation`, "PATCH", {
    mode: "paused",
  });
  await post(human.token, room, "Ignore paused backlog");
  await call(agent.token, `/rooms/${room.id}/participation`, "PATCH", {
    mode: "active",
  });
  assert.equal(
    (await call(agent.token, `/rooms/${room.id}/turns/claim`, "POST", {})).turn,
    null,
  );
  const joining = await provision("Later agent", "agent");
  await call(human.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: joining.principal.id,
  });
  assert.equal(
    (await call(joining.token, `/rooms/${room.id}/turns/claim`, "POST", {}))
      .turn,
    null,
  );
});

test("lease takeover survives restart, rejects old worker and bounds retries; corrupt store fails closed", async () => {
  const file = path.join(temporary, "leases.json");
  let clock = 1000000;
  const options = {
    file,
    adminToken: admin,
    now: () => clock,
    leaseMs: 1000,
    workspace: {
      handle: async () => {
        throw new Error("unexpected document");
      },
    },
  };
  let im = createNativeIM(options);
  const invoke = (token, route, method = "GET", input = {}) =>
    im.handle(method, "/api/im" + route, input, token);
  const human = await invoke(admin, "/admin/principals", "POST", {
    name: "Human",
    kind: "human",
  });
  const agent = await invoke(admin, "/admin/principals", "POST", {
    name: "Agent",
    kind: "agent",
  });
  const { room } = await invoke(human.token, "/rooms", "POST", {
    name: "Recovery",
  });
  await invoke(human.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: agent.principal.id,
  });
  await invoke(human.token, `/rooms/${room.id}/messages`, "POST", {
    client_id: "one",
    content: "Recover",
  });
  const first = await invoke(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
  );
  im = createNativeIM(options);
  assert.equal(
    (await invoke(agent.token, `/rooms/${room.id}/turns/claim`, "POST")).turn,
    null,
  );
  clock += 1001;
  const second = await invoke(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
  );
  assert.equal(second.turn.id, first.turn.id);
  assert.equal(second.turn.attempt, 2);
  assert.notEqual(second.turn.lease_token, first.turn.lease_token);
  await assert.rejects(
    invoke(
      agent.token,
      `/rooms/${room.id}/turns/${first.turn.id}/finish`,
      "POST",
      finishBody(first.turn.lease_token),
    ),
    { code: "lease_expired" },
  );
  clock += 1001;
  const third = await invoke(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
  );
  assert.equal(third.turn.attempt, 3);
  clock += 1001;
  assert.equal(
    (await invoke(agent.token, `/rooms/${room.id}/turns/claim`, "POST")).turn,
    null,
  );
  const state = await invoke(human.token, `/rooms/${room.id}`);
  assert.equal(state.runs[0].status, "blocked");
  assert.equal(state.messages.length, 1);
  fs.writeFileSync(file, "{broken");
  assert.throws(() => createNativeIM(options), /corrupt/);
});

test("persistence faults fail stop and never expose or later commit rejected in-memory writes", async () => {
  const file = path.join(temporary, "faults.json");
  const options = {
    file,
    adminToken: admin,
    workspace: {
      handle: async () => {
        throw new Error("unexpected document");
      },
    },
  };
  const im = createNativeIM(options);
  const invoke = (token, route, method = "GET", input = {}) =>
    im.handle(method, "/api/im" + route, input, token);
  const human = await invoke(admin, "/admin/principals", "POST", {
    name: "Human",
    kind: "human",
  });
  const { room } = await invoke(human.token, "/rooms", "POST", {
    name: "Fault test",
  });
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === file)
      throw Object.assign(new Error("injected"), { code: "EIO" });
    return rename(source, target);
  };
  try {
    await assert.rejects(
      invoke(human.token, `/rooms/${room.id}/messages`, "POST", {
        client_id: "failed",
        content: "Never committed",
      }),
      { code: "storage_failed" },
    );
  } finally {
    fs.renameSync = rename;
  }
  await assert.rejects(invoke(human.token, `/rooms/${room.id}`), {
    code: "storage_failed",
  });
  await assert.rejects(
    invoke(human.token, `/rooms/${room.id}/tasks`, "POST", {
      title: "Unrelated mutation",
    }),
    { code: "storage_failed" },
  );
  const restarted = createNativeIM(options);
  const visible = await restarted.handle(
    "GET",
    `/api/im/rooms/${room.id}`,
    {},
    human.token,
  );
  assert.equal(visible.messages.length, 0);
  assert.equal(visible.tasks.length, 0);
});

test("lease is fenced again after delayed canonical reads at the commit boundary", async () => {
  let clock = 1000,
    delayReads = false;
  const document = {
    id: "test-doc",
    revision: 1,
    content_hash: "test-hash",
    title: "Brief",
    content: "Snapshot",
  };
  const im = createNativeIM({
    file: path.join(temporary, "fence.json"),
    adminToken: admin,
    now: () => clock,
    leaseMs: 1000,
    workspace: {
      handle: async () => {
        if (delayReads) clock += 2000;
        return document;
      },
    },
  });
  const invoke = (token, route, method = "GET", input = {}) =>
    im.handle(method, "/api/im" + route, input, token);
  const human = await invoke(admin, "/admin/principals", "POST", {
    name: "Human",
    kind: "human",
  });
  const agent = await invoke(admin, "/admin/principals", "POST", {
    name: "Agent",
    kind: "agent",
  });
  const { room } = await invoke(human.token, "/rooms", "POST", {
    name: "Fence test",
  });
  await invoke(human.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: agent.principal.id,
  });
  await invoke(admin, "/admin/import", "POST", {
    room_id: room.id,
    document_id: document.id,
  });
  const { turn } = await invoke(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
  );
  delayReads = true;
  await assert.rejects(
    invoke(
      agent.token,
      `/rooms/${room.id}/turns/${turn.id}/finish`,
      "POST",
      finishBody(turn.lease_token),
    ),
    { code: "lease_expired" },
  );
  assert.equal(
    (await invoke(human.token, `/rooms/${room.id}`)).messages.length,
    0,
  );
});

test("idle claim does not wake polling peers; owner controls participation without agent secret", async () => {
  const { human, agent, room } = await fixture();
  await call(
    human.token,
    `/rooms/${room.id}/tasks`,
    "POST",
    { title: "Prototype pollution", assignee_id: "__proto__" },
    422,
  );
  await call(
    human.token,
    `/rooms/${room.id}/messages`,
    "POST",
    {
      client_id: "prototype",
      content: "Wrong member",
      mentions: ["constructor"],
    },
    422,
  );
  const { member } = await call(
    human.token,
    `/rooms/${room.id}/participation`,
    "PATCH",
    { principal_id: agent.principal.id, mode: "paused" },
  );
  assert.equal(member.mode, "paused");
  await call(
    agent.token,
    `/rooms/${room.id}/participation`,
    "PATCH",
    { principal_id: human.principal.id, mode: "paused" },
    403,
  );
  await call(human.token, `/rooms/${room.id}/participation`, "PATCH", {
    principal_id: agent.principal.id,
    mode: "active",
  });
  const cursor = (await call(agent.token, "/events")).cursor;
  let resolved = false;
  const waiting = call(agent.token, `/events?after=${cursor}&wait=1`).then(
    (value) => {
      resolved = true;
      return value;
    },
  );
  await pause(40);
  assert.equal(
    (await call(agent.token, `/rooms/${room.id}/turns/claim`, "POST", {})).turn,
    null,
  );
  await pause(100);
  assert.equal(
    resolved,
    false,
    "no-event claim must not wake another idle worker",
  );
  await waiting;
});

test("pause, removal and revocation visibly cancel in-flight work and fence publication", async () => {
  const { human, agent, room } = await fixture();
  await post(human.token, room, "Start work");
  const first = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  await call(human.token, `/rooms/${room.id}/participation`, "PATCH", {
    principal_id: agent.principal.id,
    mode: "paused",
  });
  assert.equal(
    (await detail(human.token, room)).runs.at(-1).status,
    "cancelled",
  );
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${first.turn.id}/finish`,
    "POST",
    finishBody(first.turn.lease_token),
    409,
  );
  await call(human.token, `/rooms/${room.id}/participation`, "PATCH", {
    principal_id: agent.principal.id,
    mode: "active",
  });
  await post(human.token, room, "Second work");
  const second = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  await call(
    human.token,
    `/rooms/${room.id}/members/${agent.principal.id}`,
    "DELETE",
  );
  assert.equal(
    (await detail(human.token, room)).runs.at(-1).status,
    "cancelled",
  );
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${second.turn.id}/finish`,
    "POST",
    finishBody(second.turn.lease_token),
    403,
  );
  await call(human.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: agent.principal.id,
  });
  await post(human.token, room, "Third work");
  const third = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  await call(admin, "/admin/revoke", "POST", {
    principal_id: agent.principal.id,
  });
  assert.equal(
    (await detail(human.token, room)).runs.at(-1).status,
    "cancelled",
  );
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${third.turn.id}/finish`,
    "POST",
    finishBody(third.turn.lease_token),
    401,
  );
  assert.equal(
    (await detail(human.token, room)).messages.filter(
      (m) => m.author.kind === "agent",
    ).length,
    0,
  );
});

test("direct conversations are pair-idempotent with equal human and agent creation rights", async () => {
  const human = await provision("Direct human"),
    agent = await provision("Direct agent", "agent"),
    outside = await provision("Not a member");
  const first = await call(agent.token, "/rooms/direct", "POST", {
    principal_id: human.principal.id,
  });
  assert.equal(first.room.kind, "direct");
  assert.equal(first.room.created_by, agent.principal.id);
  const reverse = await call(human.token, "/rooms/direct", "POST", {
    principal_id: agent.principal.id,
  });
  assert.equal(reverse.duplicate, true);
  assert.equal(reverse.room.id, first.room.id);
  await call(outside.token, `/rooms/${first.room.id}`, "GET", undefined, 403);
  await call(
    agent.token,
    `/rooms/${first.room.id}/members`,
    "POST",
    { principal_id: outside.principal.id },
    409,
  );
  await call(
    agent.token,
    "/rooms/direct",
    "POST",
    { principal_id: agent.principal.id },
    422,
  );
  const message = await post(agent.token, first.room, "请协助检查", {
    mentions: [human.principal.id],
  });
  assert.deepEqual(message.message.mentions, [human.principal.id]);
  await stop(app);
  app = start("server.js");
  await ready(base + "/health", app);
  assert.equal(
    (
      await call(human.token, "/rooms/direct", "POST", {
        principal_id: agent.principal.id,
      })
    ).room.id,
    first.room.id,
  );
});

test("personal favorites, mute and monotonic read cursors preserve scoped unread counts", async () => {
  const { human, agent, outside, room } = await fixture();
  await post(human.token, room, "Own message is already read");
  const incoming = await post(agent.token, room, "Unread for human");
  const before = await detail(human.token, room);
  assert.equal(before.room.unread_count, 1);
  const marked = await call(
    human.token,
    `/rooms/${room.id}/preferences`,
    "PATCH",
    { favorite: true, muted: true, read_seq: incoming.message.seq },
  );
  assert.equal(marked.room.is_favorite, true);
  assert.equal(marked.room.muted, true);
  assert.equal(marked.room.unread_count, 0);
  const lower = await call(
    human.token,
    `/rooms/${room.id}/preferences`,
    "PATCH",
    { read_seq: 0 },
  );
  assert.equal(lower.room.read_seq, incoming.message.seq);
  const noNewMessageCursor = (await detail(human.token, room)).cursor;
  await call(human.token, `/rooms/${room.id}/preferences`, "PATCH", {
    read_seq: noNewMessageCursor,
  });
  assert.equal(
    (await detail(human.token, room)).cursor,
    noNewMessageCursor,
    "mark-read does not feed on its own preference event",
  );
  await call(
    human.token,
    `/rooms/${room.id}/preferences`,
    "PATCH",
    { read_seq: Number.MAX_SAFE_INTEGER },
    422,
  );
  await call(
    human.token,
    `/rooms/${room.id}/preferences`,
    "PATCH",
    { muted: "false" },
    422,
  );
  await call(
    outside.token,
    `/rooms/${room.id}/preferences`,
    "PATCH",
    { favorite: true },
    403,
  );
  assert.equal((await detail(agent.token, room)).room.is_favorite, false);
  await stop(app);
  app = start("server.js");
  await ready(base + "/health", app);
  const restored = (await call(human.token, "/rooms")).rooms.find(
    (item) => item.id === room.id,
  );
  assert.equal(restored.is_favorite, true);
  assert.equal(restored.read_seq, incoming.message.seq);
});

test("message edits and soft recall use author revisions, immutable events and inference fencing", async () => {
  const { human, agent, outside, room } = await fixture();
  const original = await post(
    human.token,
    room,
    "Original visible instruction",
  );
  const first = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  assert.equal(original.message.revision, 1);
  await call(
    agent.token,
    `/rooms/${room.id}/messages/${original.message.id}`,
    "PATCH",
    { content: "Impersonated edit", base_revision: 1 },
    403,
  );
  const edited = await call(
    human.token,
    `/rooms/${room.id}/messages/${original.message.id}`,
    "PATCH",
    { content: "Revised visible instruction", base_revision: 1 },
  );
  assert.equal(edited.message.revision, 2);
  assert.equal(edited.message.history[0].content, original.message.content);
  await call(
    human.token,
    `/rooms/${room.id}/messages/${original.message.id}`,
    "PATCH",
    { content: "Stale", base_revision: 1 },
    409,
  );
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${first.turn.id}/finish`,
    "POST",
    finishBody(first.turn.lease_token),
    409,
  );
  const events = await call(
    human.token,
    `/events?after=${original.message.seq - 1}`,
  );
  assert.equal(
    events.events.find((e) => e.type === "message.created").message.content,
    "Original visible instruction",
    "old event retains immutable original body",
  );
  const second = await call(
    agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  assert.ok(second.turn);
  assert.equal(
    second.context.messages.at(-1).content,
    "Revised visible instruction",
  );
  assert.equal(second.context.messages.at(-1).history, undefined);
  const recalled = await call(
    human.token,
    `/rooms/${room.id}/messages/${original.message.id}`,
    "DELETE",
    { base_revision: 2 },
  );
  assert.equal(recalled.message.content, "");
  assert.ok(recalled.message.retracted_at);
  assert.equal(recalled.message.revision, 3);
  await call(
    agent.token,
    `/rooms/${room.id}/turns/${second.turn.id}/finish`,
    "POST",
    finishBody(second.turn.lease_token),
    409,
  );
  await call(
    outside.token,
    `/rooms/${room.id}/messages/${original.message.id}`,
    "DELETE",
    { base_revision: 3 },
    403,
  );
  assert.equal(
    (await call(agent.token, `/rooms/${room.id}/turns/claim`, "POST", {})).turn,
    null,
  );
  const exported = await call(human.token, `/rooms/${room.id}/export`);
  const currentSection = exported
    .split("## 当前消息记录")[1]
    .split("## 消息修订审计")[0];
  assert.ok(currentSection.includes("[消息已撤回]"));
  assert.equal(currentSection.includes("Original visible instruction"), false);
  assert.ok(
    exported.includes("Original visible instruction"),
    "explicit history preserves auditable original",
  );
  assert.equal((await detail(human.token, room)).runs.at(-1).status, "stale");
});

test("reactions toggle per authenticated member and scoped search excludes recalled or foreign work", async () => {
  const { human, agent, outside, room } = await fixture();
  const needle = "search-proof-" + crypto.randomUUID();
  const { message } = await post(human.token, room, needle);
  const first = await call(
    agent.token,
    `/rooms/${room.id}/messages/${message.id}/reactions`,
    "POST",
    { emoji: "👍", actor_id: outside.principal.id },
  );
  assert.deepEqual(first.message.reactions["👍"], [agent.principal.id]);
  const toggled = await call(
    agent.token,
    `/rooms/${room.id}/messages/${message.id}/reactions`,
    "POST",
    { emoji: "👍" },
  );
  assert.deepEqual(toggled.message.reactions["👍"], []);
  await call(
    agent.token,
    `/rooms/${room.id}/messages/${message.id}/reactions`,
    "POST",
    { emoji: "<script>" },
    422,
  );
  await call(
    outside.token,
    `/rooms/${room.id}/messages/${message.id}/reactions`,
    "POST",
    { emoji: "👍" },
    403,
  );
  await call(human.token, `/rooms/${room.id}/documents`, "POST", {
    title: "Searchable brief",
    content: needle,
  });
  await call(human.token, `/rooms/${room.id}/tasks`, "POST", {
    title: "Searchable task",
    description: needle,
  });
  const results = await call(
    agent.token,
    "/search?q=" + encodeURIComponent(needle),
  );
  assert.deepEqual(
    new Set(results.results.map((result) => result.type)),
    new Set(["message", "document", "task"]),
  );
  const library = await call(agent.token, "/library");
  assert.equal(library.documents.length, 1);
  assert.deepEqual(library.documents[0].room_ids, [room.id]);
  assert.equal(library.documents[0].content, undefined);
  assert.equal(library.tasks[0].room_id, room.id);
  assert.equal((await call(outside.token, "/library")).documents.length, 0);
  assert.equal(
    (await call(outside.token, "/search?q=" + encodeURIComponent(needle)))
      .results.length,
    0,
  );
  assert.equal(
    (
      await call(
        agent.token,
        `/rooms/${room.id}/messages?q=${encodeURIComponent(needle)}`,
      )
    ).messages.length,
    1,
  );
  await call(
    human.token,
    `/rooms/${room.id}/messages/${message.id}`,
    "DELETE",
    { base_revision: 1 },
  );
  assert.equal(
    (
      await call(agent.token, "/search?q=" + encodeURIComponent(needle))
    ).results.some((item) => item.type === "message"),
    false,
  );
});

test("store creates dedicated idempotent buddies, derives only scoped worker secrets and survives restart", async () => {
  const human = await provision("Store owner"),
    other = await provision("Other owner"),
    outsider = await provision("Unrelated");
  const catalog = await call(human.token, "/agent-store");
  assert.deepEqual(
    catalog.agents.map((item) => item.id),
    ["product", "reviewer", "research"],
  );
  const installed = await call(
    human.token,
    "/agent-store/product/install",
    "POST",
    {},
  );
  assert.equal(installed.principal.kind, "agent");
  assert.equal(installed.principal.owner_id, human.principal.id);
  assert.equal(installed.principal.managed, true);
  assert.ok(installed.principal.instructions);
  assert.equal(installed.token, undefined);
  const duplicate = await call(
    human.token,
    "/agent-store/product/install",
    "POST",
    {},
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.principal.id, installed.principal.id);
  const dedicated = await call(
    other.token,
    "/agent-store/product/install",
    "POST",
    {},
  );
  assert.notEqual(dedicated.principal.id, installed.principal.id);
  assert.equal(
    (await call(human.token, "/rooms")).rooms.length,
    0,
    "store install does not silently join any room",
  );
  assert.equal(
    (await call(human.token, "/agents")).agents[0].relationship,
    "installed",
  );
  assert.equal((await call(outsider.token, "/agents")).agents.length, 0);
  await call(outsider.token, "/admin/workers", "GET", undefined, 401);
  const workers = await call(admin, "/admin/workers");
  const worker = workers.workers.find(
    (item) => item.principal.id === installed.principal.id,
  );
  assert.equal(
    (await call(worker.token, "/me")).principal.id,
    installed.principal.id,
  );
  await call(
    worker.token,
    "/admin/principals",
    "POST",
    { name: "Escalation", kind: "agent" },
    401,
  );
  const stored = fs.readFileSync(environment.DOC_FREE_IM_DATA, "utf8");
  assert.equal(stored.includes(worker.token), false);
  assert.equal(stored.includes(admin), false);
  await call(outsider.token, "/agents", "POST", {
    principal_id: installed.principal.id,
  });
  assert.equal(
    (await call(outsider.token, "/agents")).agents[0].relationship,
    "friend",
  );
  assert.equal((await call(outsider.token, "/rooms")).rooms.length, 0);
  const { room } = await call(worker.token, "/rooms/direct", "POST", {
    principal_id: human.principal.id,
  });
  await post(human.token, room, "Help draft a visible plan");
  const claim = await call(
    worker.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
    {},
  );
  assert.equal(
    claim.context.principal.instructions,
    installed.principal.instructions,
  );
  await stop(app);
  app = start("server.js");
  await ready(base + "/health", app);
  const restarted = (await call(admin, "/admin/workers")).workers.find(
    (item) => item.principal.id === installed.principal.id,
  );
  assert.equal(restarted.token, worker.token);
  assert.equal(
    (await call(human.token, "/agent-store/product/install", "POST", {}))
      .principal.id,
    installed.principal.id,
  );
  await call(admin, "/admin/revoke", "POST", {
    principal_id: installed.principal.id,
  });
  assert.equal(
    (await call(admin, "/admin/workers")).workers.some(
      (item) => item.principal.id === installed.principal.id,
    ),
    false,
  );
  await call(worker.token, "/me", "GET", undefined, 401);
  await call(human.token, "/agent-store/product/install", "POST", {}, 409);
});

test("presence is short-lived connection information and does not mutate durable work state", async () => {
  let clock = 5000;
  const file = path.join(temporary, "presence.json");
  const im = createNativeIM({
    file,
    adminToken: admin,
    now: () => clock,
    workspace: {
      handle: async () => {
        throw new Error("unexpected");
      },
    },
  });
  const invoke = (token, route, method = "GET", input = {}) =>
    im.handle(method, "/api/im" + route, input, token);
  const human = await invoke(admin, "/admin/principals", "POST", {
    name: "Online",
    kind: "human",
  });
  const { room } = await invoke(human.token, "/rooms", "POST", {
    name: "Presence",
  });
  const before = fs.readFileSync(file, "utf8");
  await invoke(human.token, "/presence", "POST", { status: "online" });
  assert.equal(
    (await invoke(human.token, `/rooms/${room.id}`)).members[0].presence.status,
    "online",
  );
  assert.equal(fs.readFileSync(file, "utf8"), before);
  clock += 60001;
  assert.equal(
    (await invoke(human.token, `/rooms/${room.id}`)).members[0].presence.status,
    "offline",
  );
});
