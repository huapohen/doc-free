"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "native-plugins-tests-"),
);
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
async function setup() {
  const file = path.join(temporary, crypto.randomUUID() + ".json"),
    admin = crypto.randomBytes(32).toString("hex");
  const options = {
    file,
    adminToken: admin,
    workspace: {
      handle: async () => {
        throw new Error("unexpected document read");
      },
    },
  };
  let im = createNativeIM(options);
  const call = (token, route, method = "GET", input = {}) =>
    im.handle(method, "/api/im" + route, input, token);
  const make = (name, kind = "human") =>
    call(admin, "/admin/principals", "POST", { name, kind });
  const human = await make("Human"),
    agent = await make("Agent", "agent"),
    outside = await make("Outside");
  return {
    file,
    admin,
    call,
    make,
    human,
    agent,
    outside,
    restart: () => {
      im = createNativeIM(options);
    },
  };
}
const adapterManifest = () => ({
  id: "device_demo",
  name: "Device declaration",
  kind: "hardware",
  description: "Unconnected adapter declaration",
  adapter: {
    transport: "device",
    endpoint: "https://device.example.invalid/adapter",
  },
  capabilities: [{ id: "device_demo.status", name: "Read device status" }],
  config_schema: {
    label: { type: "string", default: "Preview" },
    polling: { type: "boolean", default: false },
    interval: { type: "number", enum: [10, 30], default: 30 },
  },
});

test("plugin discovery and preferences treat humans and agents equally without changing native authorization", async () => {
  const f = await setup();
  const plugins = (await f.call(f.human.token, "/plugins")).plugins;
  assert.deepEqual(
    plugins.map((entry) => entry.id),
    [
      "im",
      "docs",
      "tasks",
      "meetings",
      "minutes",
      "calendar",
      "workbench",
      "attendance",
      "approvals",
      "mail",
      "settings",
      "enterprise",
    ],
  );
  assert.ok(
    plugins.every((entry) => entry.builtin && entry.available && entry.enabled),
  );
  assert.deepEqual(
    (await f.call(f.human.token, "/capabilities")).capabilities,
    (await f.call(f.agent.token, "/capabilities")).capabilities,
  );
  const disabled = await f.call(f.agent.token, "/plugins/im", "PATCH", {
    base_revision: 1,
    enabled: false,
  });
  assert.equal(disabled.plugin.revision, 2);
  assert.equal(
    (await f.call(f.human.token, "/plugins/im")).plugin.enabled,
    true,
  );
  await assert.rejects(
    f.call(f.agent.token, "/plugins/im", "PATCH", {
      base_revision: 1,
      enabled: true,
    }),
    { code: "conflict" },
  );
  const { room } = await f.call(f.agent.token, "/rooms", "POST", {
    name: "Same authorized API",
  });
  await assert.rejects(f.call(f.outside.token, `/rooms/${room.id}`), {
    code: "not_a_member",
  });
  await assert.rejects(
    f.call(f.outside.token, "/plugins/im", "PATCH", {
      base_revision: 1,
      enabled: true,
      role: "owner",
    }),
    { code: "invalid_plugin_config" },
  );
  f.restart();
  assert.equal(
    (await f.call(f.agent.token, "/plugins/im")).plugin.enabled,
    false,
  );
  const privateEvents = (await f.call(f.agent.token, "/events")).events.filter(
    (entry) => entry.type === "plugin.configured",
  );
  assert.equal(privateEvents.length, 1);
  assert.equal(privateEvents[0].room_id, null);
  assert.deepEqual(privateEvents[0].audience_ids, [f.agent.principal.id]);
  assert.ok(
    !(await f.call(f.human.token, "/events")).events.some(
      (entry) => entry.type === "plugin.configured",
    ),
  );
  assert.match(await f.call(f.agent.token, "/plugins/export"), /im.messages/);
});

test("only administrators register unavailable adapters; typed personal config is revisioned and cannot contain credentials", async () => {
  const f = await setup(),
    manifest = adapterManifest();
  await assert.rejects(
    f.call(f.agent.token, "/admin/plugins", "POST", { manifest }),
    { code: "unauthorized" },
  );
  const registered = await f.call(f.admin, "/admin/plugins", "POST", {
    manifest,
  });
  assert.equal(registered.plugin.available, false);
  assert.equal(registered.plugin.revision, 1);
  const configured = await f.call(
    f.agent.token,
    "/plugins/device_demo",
    "PATCH",
    { base_revision: 1, enabled: true, config: { label: "Lab", interval: 10 } },
  );
  assert.equal(configured.plugin.enabled, true);
  assert.equal(configured.plugin.available, false);
  assert.equal(configured.plugin.execution, "not_connected");
  assert.deepEqual(configured.plugin.config, {
    label: "Lab",
    polling: false,
    interval: 10,
  });
  assert.deepEqual(
    (await f.call(f.human.token, "/plugins/device_demo")).plugin.config,
    { label: "Preview", polling: false, interval: 30 },
  );
  for (const config of [
    { interval: "10" },
    { interval: 20 },
    { api_key: "placeholder" },
    { unknown: true },
  ])
    await assert.rejects(
      f.call(f.agent.token, "/plugins/device_demo", "PATCH", {
        base_revision: 2,
        config,
      }),
      { code: "invalid_plugin_config" },
    );
  assert.equal(
    (await f.call(f.agent.token, "/plugins/device_demo")).plugin.revision,
    2,
  );
  await assert.rejects(
    f.call(f.admin, "/admin/plugins", "POST", { manifest }),
    { code: "conflict" },
  );
  for (const invalid of [
    { ...manifest, id: "im" },
    { ...manifest, capabilities: [{ id: "mail.send", name: "spoof" }] },
    { ...manifest, executable: "any code" },
    { ...manifest, config_schema: { api_key: { type: "string" } } },
    {
      ...manifest,
      adapter: {
        transport: "api",
        endpoint: "https://example.invalid/?key=not-secret",
      },
    },
    {
      ...manifest,
      adapter: { transport: "api", endpoint: "file:///etc/passwd" },
    },
  ])
    await assert.rejects(
      f.call(f.admin, "/admin/plugins", "POST", {
        manifest: invalid,
        base_revision: 1,
      }),
    );
  const updated = await f.call(f.admin, "/admin/plugins", "POST", {
    manifest: {
      ...manifest,
      config_schema: { polling: { type: "boolean", default: true } },
    },
    base_revision: 1,
  });
  assert.equal(updated.plugin.revision, 2);
  assert.deepEqual(
    (await f.call(f.agent.token, "/plugins/device_demo")).plugin.config,
    { polling: false },
  );
  f.restart();
  const capabilities = (await f.call(f.agent.token, "/capabilities"))
    .capabilities;
  assert.equal(
    capabilities.find((entry) => entry.id === "device_demo.status").available,
    false,
  );
});

test("contacts are individual kind-neutral relationships, independent of room membership and durable across restart", async () => {
  const f = await setup();
  const first = await f.call(f.agent.token, "/contacts", "POST", {
    principal_id: f.human.principal.id,
  });
  assert.equal(first.contact.kind, "human");
  assert.equal(first.duplicate, false);
  assert.equal(
    (
      await f.call(f.agent.token, "/contacts", "POST", {
        principal_id: f.human.principal.id,
      })
    ).duplicate,
    true,
  );
  const humanContacts=(await f.call(f.human.token, "/contacts")).contacts;
  assert.deepEqual(humanContacts.map(person=>person.system_agent_key),["activate-agent","desktop-companion"]);
  assert.ok(!humanContacts.some(person=>person.id===f.agent.principal.id),"Another member adding you does not create a reciprocal contact");
  await assert.rejects(
    f.call(f.human.token, "/contacts", "POST", {
      principal_id: f.human.principal.id,
    }),
    { code: "invalid_principal" },
  );
  await f.call(f.human.token, "/contacts", "POST", {
    principal_id: f.agent.principal.id,
  });
  assert.equal(
    (await f.call(f.human.token, "/agents")).agents.find(
      (entry) => entry.id === f.agent.principal.id,
    ).relationship,
    "friend",
  );
  const { room } = await f.call(f.agent.token, "/rooms", "POST", {
    name: "Private work",
  });
  await assert.rejects(f.call(f.human.token, `/rooms/${room.id}`), {
    code: "not_a_member",
  });
  await f.call(f.agent.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: f.human.principal.id,
  });
  await f.call(f.human.token, `/contacts/${f.agent.principal.id}`, "DELETE");
  assert.equal(
    (await f.call(f.human.token, `/rooms/${room.id}`)).room.id,
    room.id,
  );
  assert.equal((await f.call(f.agent.token, "/contacts")).contacts.length, 1);
  f.restart();
  assert.equal(
    (await f.call(f.agent.token, "/contacts")).contacts[0].id,
    f.human.principal.id,
  );
  await f.call(f.admin, "/admin/revoke", "POST", {
    principal_id: f.human.principal.id,
  });
  assert.equal((await f.call(f.agent.token, "/contacts")).contacts.length, 0);
});

test("all-member mentions expand to actual current principals above twenty and reject a removed or fabricated all identity", async () => {
  const f = await setup();
  const { room } = await f.call(f.human.token, "/rooms", "POST", {
    name: "All hands",
  });
  const ids = [f.human.principal.id];
  for (let index = 0; index < 24; index++) {
    const person = await f.make(
      `Member ${index}`,
      index % 2 ? "agent" : "human",
    );
    ids.push(person.principal.id);
    await f.call(f.human.token, `/rooms/${room.id}/members`, "POST", {
      principal_id: person.principal.id,
    });
  }
  const send = (mentions) =>
    f.call(f.human.token, `/rooms/${room.id}/messages`, "POST", {
      client_id: crypto.randomUUID(),
      content: "Everyone can inspect this message",
      mentions,
    });
  assert.deepEqual((await send(ids)).message.mentions, [...ids].sort());
  await assert.rejects(send(["all"]), { code: "invalid_mentions" });
  await f.call(
    f.human.token,
    `/rooms/${room.id}/members/${ids.at(-1)}`,
    "DELETE",
  );
  await assert.rejects(send(ids), { code: "invalid_mentions" });
});
