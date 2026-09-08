"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const { nativeMCP, callNativeTool, publicTools } = require("../native-im-mcp");
const { createNativeA2A } = require("../native-a2a");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-workbench-recents-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function setup() {
  const admin = crypto.randomBytes(32).toString("hex");
  const file = path.join(directory, crypto.randomUUID() + ".json");
  const options = {
    file,
    adminToken: admin,
    workspace: { handle: async () => { throw new Error("No workspace request expected"); } },
  };
  let im = createNativeIM(options);
  const call = (who, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im" + route);
    return im.handle(method, url.pathname, input, who.token, url.searchParams);
  };
  const human = await call({ token: admin }, "/admin/principals", "POST", { name: "Human owner", kind: "human" });
  const peer = await call({ token: admin }, "/admin/principals", "POST", { name: "Human colleague", kind: "human" });
  const agent = await call({ token: admin }, "/admin/principals", "POST", { name: "Agent colleague", kind: "agent" });
  await call({ token: admin }, "/admin/enterprise/bootstrap", "POST", { principal_id: human.principal.id });
  const policy = async (plugin, input) => {
    const { app } = await call(human, `/enterprise/admin/apps/${plugin}`);
    return call(human, `/enterprise/admin/apps/${plugin}`, "PATCH", { base_revision: app.policy.revision, enabled: app.policy.enabled, ...input });
  };
  const mcp = (who, name, args = {}) => nativeMCP(im, {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
  }, who.token);
  return {
    file, human, peer, agent, call, policy, mcp,
    a2a: () => createNativeA2A({ file: file + ".a2a", im, invokeTool: callNativeTool, publicTools }),
    restart: () => { im = createNativeIM(options); },
  };
}
const parse = (response) => JSON.parse(response.result.content[0].text);

test("recent apps start empty, follow real MRU visits and stay isolated across humans and agents after restart", async () => {
  const f = await setup();
  const original = fs.readFileSync(f.file, "utf8");
  for (const who of [f.human, f.peer, f.agent]) {
    const view = await f.call(who, "/workbench");
    assert.deepEqual(view.recents, []);
    assert.deepEqual(view.favorites, ["messages", "agents", "docs", "tasks"]);
  }
  assert.equal(fs.readFileSync(f.file, "utf8"), original, "reading does not invent or persist usage");
  for (const app_id of ["docs", "calendar", "mail", "calendar"])
    await f.call(f.human, "/workbench/recents", "POST", { app_id });
  await f.call(f.agent, "/workbench/recents", "POST", { app_id: "tasks" });
  assert.deepEqual((await f.call(f.human, "/workbench")).recents, ["calendar", "mail", "docs"]);
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["tasks"]);
  assert.deepEqual((await f.call(f.peer, "/workbench")).recents, []);
  f.restart();
  assert.deepEqual((await f.call(f.human, "/workbench")).recents, ["calendar", "mail", "docs"]);
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["tasks"]);
});

test("favorites and clearing personal usage preserve each other and never clear another identity", async () => {
  const f = await setup();
  for (const who of [f.human, f.agent])
    await f.call(who, "/workbench/recents", "POST", { app_id: "minutes" });
  const favorite = await f.call(f.human, "/workbench", "PATCH", { favorites: ["mail"] });
  assert.deepEqual(favorite.recents, ["minutes"]);
  const record = await f.call(f.human, "/workbench/recents", "POST", { app_id: "meetings" });
  assert.deepEqual(record.favorites, ["mail"]);
  const cleared = await f.call(f.human, "/workbench/recents", "DELETE", { principal_id: f.agent.principal.id });
  assert.deepEqual(cleared.recents, []);
  assert.deepEqual(cleared.favorites, ["mail"]);
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["minutes"]);
  f.restart();
  assert.deepEqual((await f.call(f.human, "/workbench")).recents, []);
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["minutes"]);
});

test("nonexistent, malformed and unimplemented recent app requests fail without changing stored history", async () => {
  const f = await setup();
  await f.call(f.agent, "/workbench/recents", "POST", { app_id: "agents" });
  for (const [input, error] of [
    [{ app_id: "missing" }, { status: 404, code: "app_not_found" }],
    [{ app_id: "reports" }, { status: 422, code: "app_unavailable" }],
    [{ app_id: "__proto__" }, { status: 404, code: "app_not_found" }],
    [{}, { status: 422 }],
    [{ app_id: ["docs"] }, { status: 422 }],
  ]) {
    const before = fs.readFileSync(f.file, "utf8");
    await assert.rejects(f.call(f.agent, "/workbench/recents", "POST", input), error);
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
  }
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["agents"]);
});

test("current enterprise policy filters prior visits and rejects blocked apps and meeting dependencies for both kinds", async () => {
  const f = await setup();
  for (const who of [f.human, f.agent])
    for (const app_id of ["mail", "meetings", "messages", "agents"])
      await f.call(who, "/workbench/recents", "POST", { app_id });
  const identities = [f.human.principal.id, f.agent.principal.id];
  await f.policy("mail", { enabled: false });
  await f.policy("docs", { denied_principal_ids: identities });
  await f.policy("im", { denied_principal_ids: identities });
  for (const who of [f.human, f.agent]) {
    const view = await f.call(who, "/workbench");
    assert.deepEqual(view.recents, []);
    for (const app_id of ["mail", "meetings", "messages", "agents"])
      assert.equal(view.apps.find((app) => app.id === app_id).available, false);
    for (const [app_id, plugin_id] of [["mail", "mail"], ["meetings", "docs"], ["messages", "im"], ["agents", "im"]]) {
      const before = fs.readFileSync(f.file, "utf8");
      await assert.rejects(f.call(who, "/workbench/recents", "POST", { app_id }), { status: 403, code: "app_policy_denied", plugin_id });
      assert.equal(fs.readFileSync(f.file, "utf8"), before);
    }
  }
  assert.equal((await f.call(f.peer, "/workbench")).apps.find((app) => app.id === "meetings").available, true);
  await f.policy("mail", { enabled: true });
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["mail"], "permission changes filter retained history without forging a new visit");
  await f.policy("workbench", { denied_principal_ids: [f.agent.principal.id] });
  for (const method of ["POST", "DELETE"])
    await assert.rejects(f.call(f.agent, "/workbench/recents", method, { app_id: "mail" }), { status: 403, code: "app_policy_denied", plugin_id: "workbench" });
});

test("MCP exposes the same recent history for independent agents without principal overrides", async () => {
  const f = await setup();
  for (const name of ["office_workbench", "office_record_recent_app", "office_clear_recent_apps"])
    assert.ok(publicTools.find((entry) => entry.name === name));
  assert.deepEqual(parse(await f.mcp(f.agent, "office_workbench")).recents, []);
  const recorded = await f.mcp(f.agent, "office_record_recent_app", { app_id: "docs" });
  assert.equal(recorded.result.isError, false);
  assert.deepEqual(parse(recorded).recents, ["docs"]);
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["docs"]);
  assert.deepEqual((await f.call(f.human, "/workbench")).recents, []);
  const override = await f.mcp(f.human, "office_clear_recent_apps", { principal_id: f.agent.principal.id });
  assert.equal(override.result.isError, true);
  assert.equal(parse(override).status, 422);
  await f.policy("docs", { denied_principal_ids: [f.agent.principal.id] });
  const denied = await f.mcp(f.agent, "office_record_recent_app", { app_id: "docs" });
  assert.equal(denied.result.isError, true);
  assert.deepEqual(parse(denied), { status: 403, code: "app_policy_denied", plugin_id: "docs" });
  const cleared = await f.mcp(f.agent, "office_clear_recent_apps");
  assert.equal(cleared.result.isError, false);
  assert.deepEqual(parse(cleared).recents, []);
});

test("personal recent events only reach their actor, including while IM is disabled", async () => {
  const f = await setup();
  await f.policy("im", { denied_principal_ids: [f.agent.principal.id] });
  await f.call(f.agent, "/workbench/recents", "POST", { app_id: "calendar" });
  await f.call(f.agent, "/workbench/recents", "DELETE");
  const events = (who) => f.call(who, "/events?after=0&wait=0").then((page) => page.events.filter((entry) => entry.type.startsWith("application.recents.")));
  assert.deepEqual((await events(f.agent)).map((entry) => entry.type), ["application.recents.updated", "application.recents.cleared"]);
  assert.deepEqual(await events(f.human), []);
  assert.deepEqual(await events(f.peer), []);
});

test("A2A records real personal visits and denies stale availability receipts after enterprise revocation", async () => {
  const f = await setup();
  const gateway = f.a2a();
  const send = (operation, args = {}) => ({
    jsonrpc: "2.0", id: crypto.randomUUID(), method: "message/send", params: {
      message: { messageId: crypto.randomUUID(), role: "user", parts: [{ kind: "data", data: { operation, arguments: args } }] },
    },
  });
  const record = await gateway.handle(send("office_record_recent_app", { app_id: "calendar" }), f.agent.token);
  assert.equal(record.result.status.state, "completed");
  assert.deepEqual(record.result.artifacts[0].parts[0].data.result.recents, ["calendar"]);
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["calendar"]);
  assert.deepEqual((await f.call(f.human, "/workbench")).recents, []);
  const getTask = { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: record.result.id } };
  assert.ok((await gateway.handle(getTask, f.human.token)).error, "another identity cannot fetch personal task history");
  await f.policy("calendar", { denied_principal_ids: [f.agent.principal.id] });
  const stale = await gateway.handle(getTask, f.agent.token);
  assert.ok(stale.error || !stale.result?.artifacts?.length, "previously available application receipt is withheld");
  const read = await gateway.handle(send("office_workbench"), f.agent.token);
  assert.equal(read.result.status.state, "completed");
  const current = read.result.artifacts[0].parts[0].data.result;
  assert.deepEqual(current.recents, []);
  assert.equal(current.apps.find((app) => app.id === "calendar").available, false);
});

test("catalog evolution retains bounded durable history, omits retired apps and rejects corrupt histories", async () => {
  const f = await setup();
  const data = JSON.parse(fs.readFileSync(f.file, "utf8"));
  const prior = Array.from({ length: 32 }, (_, index) => `retired-app-${index}`);
  data.office.workbench_preferences[f.agent.principal.id] = { recents: prior, favorites: ["mail"] };
  fs.writeFileSync(f.file, JSON.stringify(data));
  f.restart();
  assert.deepEqual((await f.call(f.agent, "/workbench")).recents, []);
  await f.call(f.agent, "/workbench/recents", "POST", { app_id: "docs" });
  const persisted = JSON.parse(fs.readFileSync(f.file, "utf8"));
  const preference = persisted.office.workbench_preferences[f.agent.principal.id];
  assert.deepEqual(preference.recents, ["docs", ...prior.slice(0, 31)]);
  assert.deepEqual(preference.favorites, ["mail"]);
  preference.recents = ["docs", "docs"];
  fs.writeFileSync(f.file, JSON.stringify(persisted));
  assert.throws(f.restart, /workbench preferences are corrupt/);
});

test("failed recent record or clear cannot leak half-written history or be committed by a later request", async () => {
  for (const method of ["POST", "DELETE"]) {
    const f = await setup();
    await f.call(f.agent, "/workbench/recents", "POST", { app_id: "mail" });
    const before = fs.readFileSync(f.file, "utf8");
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === f.file) throw new Error("Recent history persistence fixture");
      return rename(from, to);
    };
    try {
      await assert.rejects(f.call(f.agent, "/workbench/recents", method, { app_id: "docs" }), { code: "storage_failed" });
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
    await assert.rejects(f.call(f.agent, "/workbench"), { code: "storage_failed" });
    await assert.rejects(f.call(f.human, "/workbench/recents", "POST", { app_id: "calendar" }), { code: "storage_failed" });
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
    f.restart();
    assert.deepEqual((await f.call(f.agent, "/workbench")).recents, ["mail"]);
    assert.deepEqual((await f.call(f.human, "/workbench")).recents, []);
    const recovered = await f.call(f.agent, "/workbench/recents", method, { app_id: "docs" });
    assert.deepEqual(recovered.recents, method === "POST" ? ["docs", "mail"] : []);
  }
});
