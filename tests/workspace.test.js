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
const { fingerprint, parseContract } = require("../work-protocol");

const root = path.resolve(__dirname, ".."),
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "active-doc-test-"));
const token = crypto.randomBytes(24).toString("hex");
let apiUrl, collabUrl, environment, app, collab;
const children = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
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
async function ready(url, process) {
  for (let i = 0; i < 80; i++) {
    if (process.exitCode !== null)
      throw new Error(`Server exited: ${process.errors}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(300) });
      return;
    } catch {}
    await pause(100);
  }
  throw new Error(`Server not ready: ${process.errors}`);
}
async function call(route, method = "GET", body, expected = 200) {
  const response = await fetch(apiUrl + "/api/workspace" + route, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-actor-id": "test-human",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
async function source(content = "## Goal\n\nShould be fast.") {
  return call("/documents", "POST", { title: "Test plan", content });
}
async function mission(d) {
  return call("/missions", "POST", {
    source_document_id: d.id,
    objective: "Make acceptance measurable",
    quiet_seconds: 2,
  });
}
async function proposal(d, m, overrides = {}) {
  return call("/runs", "POST", {
    mission_id: m.id,
    mission_revision: m.revision,
    source_revision: d.revision,
    source_hash: d.content_hash,
    action: "propose",
    rationale: "A concrete acceptance check is missing.",
    evidence_quotes: ["Should be fast."],
    replacement:
      "## Goal\n\nVerify two clients observe the same final document.",
    model: "test-model",
    reasoning_effort: "medium",
    ...overrides,
  });
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}
before(async () => {
  const port = await freePort(),
    collabPort = await freePort();
  apiUrl = `http://127.0.0.1:${port}`;
  collabUrl = `http://127.0.0.1:${collabPort}`;
  environment = {
    ...process.env,
    PORT: String(port),
    COLLAB_PORT: String(collabPort),
    COLLAB_URL: collabUrl,
    DOC_FREE_TOKEN: token,
    DOC_FREE_DATA: path.join(temporary, "data.json"),
    DOC_FREE_CRDT_DIR: path.join(temporary, "crdt"),
  };
  collab = start("collab-server.js");
  await ready(collabUrl, collab);
  app = start("server.js");
  await ready(apiUrl + "/health", app);
});
after(async () => {
  for (const child of children) await stop(child);
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("workspace is authenticated and serves the document-only UI", async () => {
  assert.equal((await fetch(apiUrl + "/api/workspace")).status, 401);
  const html = await (await fetch(apiUrl + "/workbench")).text();
  assert.ok(html.includes("协作文档正文") || html.includes("HUMAN + AGENT"));
  assert.ok(!html.includes("/group"));
});
test("mission is an ordinary readable document, and writes require revision", async () => {
  const d = await source(),
    m = await mission(d);
  const read = await call("/documents/" + m.id);
  assert.equal(parseContract(read).objective, "Make acceptance measurable");
  await call("/documents/" + d.id, "PUT", { content: "bad" }, 422);
  await call(
    "/documents/" + d.id,
    "PUT",
    { content: "bad", base_revision: 0 },
    409,
  );
  assert.equal((await call("/documents/" + d.id)).content, d.content);
});
test("duplicate run delivery produces one visible proposal", async () => {
  const d = await source(),
    m = await mission(d);
  const [a, b] = await Promise.all([proposal(d, m), proposal(d, m)]);
  assert.equal(a.document.id, b.document.id);
  assert.equal(Number(a.duplicate) + Number(b.duplicate), 1);
});
test("acceptance writes through CRDT, records actor and is idempotent", async () => {
  const d = await source(),
    m = await mission(d),
    p = (await proposal(d, m)).document;
  const a = await call("/proposals/" + p.id, "POST", {
    decision: "accept",
    base_revision: p.revision,
  });
  assert.equal(a.document.contract.status, "accepted");
  assert.equal(a.document.contract.resolved_by, "test-human");
  const updated = await call("/documents/" + d.id);
  assert.equal(updated.content, p.contract.replacement);
  assert.equal(updated.revision, d.revision + 1);
  assert.equal(
    (
      await call("/proposals/" + p.id, "POST", {
        decision: "accept",
        base_revision: p.revision,
      })
    ).duplicate,
    true,
  );
  assert.equal((await call("/documents/" + d.id)).revision, updated.revision);
});
test("human editing after inference makes proposal conflicted without overwrite", async () => {
  const d = await source(),
    m = await mission(d),
    p = (await proposal(d, m)).document;
  await call("/documents/" + d.id, "PUT", {
    content: d.content + "\n\nHuman constraint.",
    base_revision: d.revision,
  });
  const result = await call("/proposals/" + p.id, "POST", {
    decision: "accept",
    base_revision: p.revision,
  });
  assert.equal(result.document.contract.status, "conflicted");
  assert.ok(
    (await call("/documents/" + d.id)).content.includes("Human constraint."),
  );
});
test("paused mission invalidates an in-flight model response", async () => {
  const d = await source(),
    m = await mission(d);
  await call("/missions/" + m.id, "PATCH", {
    status: "paused",
    base_revision: m.revision,
  });
  await call(
    "/runs",
    "POST",
    {
      mission_id: m.id,
      mission_revision: m.revision,
      source_revision: d.revision,
      source_hash: d.content_hash,
      action: "stay_silent",
      rationale: "Nothing to do.",
      evidence_quotes: [],
    },
    409,
  );
});
test("invented evidence is rejected and rejecting proposal leaves source intact", async () => {
  const d = await source(),
    m = await mission(d);
  await call(
    "/runs",
    "POST",
    {
      mission_id: m.id,
      mission_revision: m.revision,
      source_revision: d.revision,
      source_hash: d.content_hash,
      action: "propose",
      rationale: "Missing evidence",
      evidence_quotes: ["invented"],
      replacement: "A change",
    },
    422,
  );
  const p = (await proposal(d, m)).document;
  const result = await call("/proposals/" + p.id, "POST", {
    decision: "reject",
    base_revision: p.revision,
  });
  assert.equal(result.document.contract.status, "rejected");
  assert.equal((await call("/documents/" + d.id)).content, d.content);
});
test("live CRDT edits are visible even without a REST save", async () => {
  const d = await source();
  const result = await fetch(collabUrl + "/internal/compare-replace", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      document_id: d.id,
      expected_content: d.content,
      content: d.content + "\n\nLive collaborator change.",
      title: d.title,
    }),
  });
  assert.equal(result.status, 200);
  const current = await call("/documents/" + d.id);
  assert.equal(current.revision, d.revision + 1);
  assert.ok(current.content.includes("Live collaborator change."));
});
test("CRDT state changes invalidate a proposal even if text is identical", async () => {
  const d = await source(),
    m = await mission(d),
    p = (await proposal(d, m)).document;
  const response = await fetch(collabUrl + "/internal/compare-replace", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      document_id: d.id,
      expected_content: d.content,
      content: d.content,
      title: d.title,
    }),
  });
  assert.equal(response.status, 200);
  const result = await call("/proposals/" + p.id, "POST", {
    decision: "accept",
    base_revision: p.revision,
  });
  assert.equal(result.document.contract.status, "conflicted");
  assert.equal((await call("/documents/" + d.id)).content, d.content);
});
test("MCP and REST share document contracts and Unicode actor labels", async () => {
  const response = await fetch(apiUrl + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "active_doc_create",
        arguments: {
          title: "MCP source",
          content: "Shared state",
          actor_id: "文档协作者",
        },
      },
    }),
  });
  const result = await response.json();
  assert.equal(result.result.isError, false);
  const d = JSON.parse(result.result.content[0].text);
  assert.equal((await call("/documents/" + d.id)).content, "Shared state");
  const event = (await call("/events")).events.find(
    (e) => e.document_id === d.id,
  );
  assert.equal(event.actor_id, "文档协作者");
});
test("event replay has a durable cursor, and restart preserves proposals", async () => {
  const d = await source(),
    m = await mission(d),
    p = (await proposal(d, m)).document;
  const before = await call("/events");
  assert.ok(before.events.length > 0);
  assert.equal((await call("/events?after=" + before.cursor)).events.length, 0);
  await stop(app);
  await stop(collab);
  collab = start("collab-server.js");
  await ready(collabUrl, collab);
  app = start("server.js");
  await ready(apiUrl + "/health", app);
  assert.equal((await call("/documents/" + p.id)).contract.status, "pending");
  assert.equal(
    (await call("/documents/" + d.id)).content_hash,
    fingerprint(d.content),
  );
  assert.equal((await call("/events")).cursor, before.cursor);
});
test("CRDT commit receipt recovers interrupted proposal finalization", async () => {
  const d = await source(),
    m = await mission(d),
    p = (await proposal(d, m)).document;
  // Simulate process interruption after the CRDT write but before JSON status update.
  const committed = await fetch(collabUrl + "/internal/compare-replace", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      document_id: d.id,
      expected_content: d.content,
      expected_title: d.title,
      content: p.contract.replacement,
      title: d.title,
      operation_id: p.id,
      result_revision: d.revision + 1,
    }),
  });
  assert.equal(committed.status, 200);
  await stop(app);
  app = start("server.js");
  await ready(apiUrl + "/health", app);
  const result = await call("/proposals/" + p.id, "POST", {
    decision: "accept",
    base_revision: p.revision,
  });
  assert.equal(result.document.contract.status, "accepted");
  assert.equal((await call("/documents/" + d.id)).revision, d.revision + 1);
});
