"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "native-app-policy-tests-"),
);
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
async function setup() {
  const file = path.join(temporary, crypto.randomUUID() + ".json"),
    admin = crypto.randomBytes(32).toString("hex"),
    documents = new Map();
  let reads = 0;
  const options = {
    file,
    adminToken: admin,
    workspace: {
      handle: async (method, route, input) => {
        if (method === "POST") {
          const doc = {
            id: "document-" + crypto.randomUUID(),
            title: input.title,
            content: input.content,
            revision: 1,
            content_hash: crypto
              .createHash("sha256")
              .update(input.content)
              .digest("hex"),
          };
          documents.set(doc.id, doc);
          return { ...doc };
        }
        reads++;
        const doc = documents.get(route.split("/").at(-1));
        if (!doc) throw new Error("unexpected document");
        return { ...doc };
      },
    },
  };
  let im = createNativeIM(options);
  const call = (token, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im" + route);
    return im.handle(method, url.pathname, input, token, url.searchParams);
  };
  const make = (name, kind = "human") =>
    call(admin, "/admin/principals", "POST", { name, kind });
  const owner = await make("Owner"),
    agent = await make("Agent", "agent"),
    peer = await make("Peer");
  await call(admin, "/admin/enterprise/bootstrap", "POST", {
    principal_id: owner.principal.id,
  });
  const { room } = await call(owner.token, "/rooms", "POST", {
    name: "Visible work",
  });
  for (const person of [agent, peer])
    await call(owner.token, `/rooms/${room.id}/members`, "POST", {
      principal_id: person.principal.id,
    });
  const setPolicy = async (plugin, input, actor = owner) => {
    const { app } = await call(actor.token, `/enterprise/admin/apps/${plugin}`);
    return call(actor.token, `/enterprise/admin/apps/${plugin}`, "PATCH", {
      base_revision: app.policy.revision,
      enabled: true,
      ...input,
    });
  };
  const changeMember = async (person, input) => {
    const { member } = await call(
      owner.token,
      `/enterprise/admin/members/${person.principal.id}`,
    );
    return call(
      owner.token,
      `/enterprise/admin/members/${person.principal.id}`,
      "PATCH",
      { base_revision: member.revision, ...input },
    );
  };
  return {
    admin,
    file,
    owner,
    agent,
    peer,
    room,
    call,
    setPolicy,
    changeMember,
    authorizeReceipt: (operation, token) =>
      im.authorizeStoredOperation(operation, token),
    reads: () => reads,
    restart: () => {
      im = createNativeIM(options);
    },
  };
}
const denied = (value, plugin_id) =>
  assert.rejects(value, { status: 403, code: "app_policy_denied", plugin_id });

test("enterprise application governance is separate from personal preferences and applies equally to owners, humans and agents", async () => {
  const f = await setup();
  await assert.rejects(f.call(f.peer.token, "/enterprise/admin/apps"), {
    code: "enterprise_admin_required",
  });
  await f.changeMember(f.agent, { role: "admin" });
  assert.equal(
    (await f.call(f.agent.token, "/enterprise")).capabilities.manage_apps,
    true,
  );
  await f.call(f.agent.token, "/plugins/mail", "PATCH", {
    base_revision: 1,
    enabled: false,
  });
  await f.call(f.agent.token, "/mail/folders");
  await f.setPolicy(
    "mail",
    { scope_mode: "restricted", allowed_principal_ids: [f.peer.principal.id] },
    f.agent,
  );
  await f.call(f.peer.token, "/mail/folders");
  await denied(f.call(f.owner.token, "/mail/folders"), "mail");
  await denied(f.call(f.agent.token, "/mail/folders"), "mail");
  const plugin = (await f.call(f.owner.token, "/plugins/mail")).plugin;
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.enterprise_allowed, false);
  assert.equal(plugin.effective_enabled, false);
  assert.equal(plugin.enterprise_policy_reason, "not_in_scope");
  await f.setPolicy("mail", {
    scope_mode: "all",
    denied_principal_ids: [f.peer.principal.id],
  });
  await denied(f.call(f.peer.token, "/mail/folders"), "mail");
  await f.call(f.agent.token, "/mail/folders");
  for (const core of ["settings", "enterprise"])
    await assert.rejects(f.setPolicy(core, { enabled: false }), {
      code: "app_policy_protected",
    });
  await f.setPolicy("im", { enabled: false });
  await denied(f.call(f.owner.token, "/principals"), "im");
  for (const route of [
    "/me",
    "/auth/account",
    "/settings",
    "/plugins",
    "/enterprise",
    "/enterprise/admin/apps",
  ])
    await f.call(f.owner.token, route);
  f.restart();
  await denied(f.call(f.owner.token, "/rooms"), "im");
});

test("every builtin business route is gated by its owning module and explicit cross-module dependencies", async () => {
  const f = await setup();
  const cases = [
    [
      "docs",
      `/rooms/${f.room.id}/documents`,
      "POST",
      { title: "Denied", content: "No write" },
    ],
    ["tasks", `/rooms/${f.room.id}/tasks`, "POST", { title: "Denied" }],
    [
      "mail",
      "/mail/drafts",
      "POST",
      { client_id: "denied", subject: "Denied" },
    ],
    ["calendar", "/calendar", "GET", {}],
    ["meetings", "/meetings", "GET", {}],
    ["attendance", "/attendance/export", "GET", {}],
    ["approvals", "/approval-templates", "GET", {}],
    ["workbench", "/workbench", "GET", {}],
    ["im", `/rooms/${f.room.id}/attachments`, "GET", {}],
  ];
  for (const [plugin, route, method, input] of cases) {
    await f.setPolicy(plugin, { enabled: false });
    await denied(f.call(f.agent.token, route, method, input), plugin);
    await f.setPolicy(plugin, { enabled: true });
  }
  await f.setPolicy("approvals", { enabled: false });
  await denied(
    f.call(
      f.agent.token,
      `/rooms/${f.room.id}/attendance/corrections`,
      "POST",
      {},
    ),
    "approvals",
  );
  await f.setPolicy("docs", { enabled: false });
  await denied(f.call(f.agent.token, "/meetings"), "docs");
  assert.equal(f.reads(), 0);
});

test("room projections, library, unified search and event replay cannot recover a denied module through aggregation", async () => {
  const f = await setup(),
    query = "policy-sensitive-record";
  const { document } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/documents`,
    "POST",
    { title: query, content: query },
  );
  await f.call(f.owner.token, `/rooms/${f.room.id}/tasks`, "POST", {
    title: query,
    description: query,
  });
  await f.call(f.owner.token, `/rooms/${f.room.id}/messages`, "POST", {
    client_id: "public-message",
    content: query,
  });
  await f.call(f.agent.token, `/rooms/${f.room.id}/turns/claim`, "POST");
  await f.call(f.owner.token, `/rooms/${f.room.id}/approvals`, "POST", {
    client_id: "private-approval",
    template_id: "general",
    title: query,
    approver_id: f.agent.principal.id,
  });
  await f.call(f.owner.token, `/rooms/${f.room.id}/calendar`, "POST", {
    client_id: "calendar",
    title: query,
    starts_at: "2027-01-01T00:00:00Z",
    ends_at: "2027-01-01T01:00:00Z",
  });
  const { draft } = await f.call(f.owner.token, "/mail/drafts", "POST", {
    client_id: "mail",
    to_ids: [f.agent.principal.id],
    subject: query,
    body: query,
  });
  await f.call(f.owner.token, `/mail/${draft.id}/send`, "POST", {
    client_id: "send",
    base_revision: 1,
  });
  for (const plugin of ["docs", "tasks", "mail", "approvals", "calendar"])
    await f.setPolicy(plugin, { enabled: false });
  const reads = f.reads(),
    room = await f.call(f.agent.token, `/rooms/${f.room.id}`);
  assert.deepEqual(room.documents, []);
  assert.deepEqual(room.tasks, []);
  assert.deepEqual(room.runs, []);
  assert.equal(room.room.document_count, 0);
  assert.equal(room.room.task_count, 0);
  const library = await f.call(f.agent.token, "/library");
  assert.deepEqual(library.documents, []);
  assert.deepEqual(library.tasks, []);
  const search = await f.call(f.agent.token, "/search?q=" + query);
  assert.deepEqual(
    search.results.map((entry) => entry.type),
    ["message"],
  );
  assert.equal(f.reads(), reads);
  const events = (await f.call(f.agent.token, "/events")).events;
  assert.ok(
    !events.some((entry) =>
      /^(document|task|mail|approval|calendar|turn)\./.test(entry.type),
    ),
  );
  assert.ok(
    events
      .filter((entry) => entry.room_id === null)
      .every(
        (entry) =>
          entry.audience_ids.length === 1 &&
          entry.audience_ids[0] === f.agent.principal.id,
      ),
  );
  await denied(f.call(f.agent.token, `/rooms/${f.room.id}/export`), "docs");
  await denied(
    f.call(f.agent.token, `/rooms/${f.room.id}/turns/claim`, "POST"),
    "docs",
  );
  await f.setPolicy("docs", { enabled: true });
  await f.setPolicy("im", { enabled: false });
  assert.equal(
    (
      await f.call(
        f.agent.token,
        `/rooms/${f.room.id}/documents/${document.id}`,
      )
    ).document.id,
    document.id,
  );
  assert.deepEqual(
    (await f.call(f.agent.token, "/search?q=" + query)).results.map(
      (entry) => entry.type,
    ),
    ["document"],
  );
});

test("policy changes wake private long polls and prevent later mailbox events while preserving policy recovery notifications", async () => {
  const f = await setup();
  const cursor = (await f.call(f.agent.token, "/events")).cursor;
  const waiting = f.call(f.agent.token, `/events?after=${cursor}&wait=25`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.setPolicy("mail", { denied_principal_ids: [f.agent.principal.id] });
  const response = await waiting;
  assert.ok(
    response.events.some(
      (entry) => entry.type === "application.policy_changed",
    ),
  );
  const { draft } = await f.call(f.owner.token, "/mail/drafts", "POST", {
    client_id: "denied-recipient",
    to_ids: [f.agent.principal.id],
    subject: "Private record",
    body: "not readable while denied",
  });
  await f.call(f.owner.token, `/mail/${draft.id}/send`, "POST", {
    client_id: "deliver",
    base_revision: 1,
  });
  assert.ok(
    !(await f.call(f.agent.token, `/events?after=${cursor}`)).events.some(
      (entry) => entry.type.startsWith("mail."),
    ),
  );
  await denied(f.call(f.agent.token, "/mail/search?q=Private"), "mail");
});

test("department scope is resolved live and a lost context scope cancels active work and media sessions", async () => {
  const f = await setup();
  const { department } = await f.call(
    f.owner.token,
    "/enterprise/admin/departments",
    "POST",
    { client_id: "dept", name: "Allowed department" },
  );
  await f.changeMember(f.agent, { department_id: department.id });
  await f.setPolicy("docs", {
    scope_mode: "restricted",
    allowed_principal_ids: [f.owner.principal.id],
    allowed_department_ids: [department.id],
  });
  await f.call(f.owner.token, `/rooms/${f.room.id}/messages`, "POST", {
    client_id: "trigger",
    content: "Visible work trigger",
  });
  const { turn } = await f.call(
    f.agent.token,
    `/rooms/${f.room.id}/turns/claim`,
    "POST",
  );
  const { meeting } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/meetings`,
    "POST",
    { client_id: "meeting", title: "Live meeting" },
  );
  const joined = await f.call(
    f.agent.token,
    `/meetings/${meeting.id}/join`,
    "POST",
    { device_id: "device" },
  );
  const waiting = f
    .call(
      f.agent.token,
      `/meetings/${meeting.id}/signals?session_id=${joined.session_id}&after=${joined.cursor}&wait=25`,
    )
    .catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.changeMember(f.agent, { department_id: null });
  const result = await waiting;
  assert.equal(result.code, "app_policy_denied");
  assert.equal(result.plugin_id, "docs");
  assert.equal(
    (await f.call(f.owner.token, `/rooms/${f.room.id}/turns/${turn.id}`)).turn
      .status,
    "cancelled",
  );
  assert.equal(
    (await f.call(f.owner.token, `/meetings/${meeting.id}`)).participants
      .length,
    0,
  );
  await denied(
    f.call(f.agent.token, `/rooms/${f.room.id}/documents`, "POST", {
      title: "Denied",
      content: "Denied",
    }),
    "docs",
  );
  f.restart();
  await denied(f.call(f.agent.token, "/meetings"), "docs");
});

test("library supplies only authorized business room names and current public member identities when IM is disabled", async () => {
  const f = await setup();
  await f.call(f.owner.token, "/rooms", "POST", {
    name: "Hidden unrelated room",
  });
  for (const plugin of ["im", "docs", "tasks"])
    await f.setPolicy(plugin, { enabled: false });
  const library = await f.call(f.agent.token, "/library");
  assert.equal(library.rooms.length, 1);
  assert.equal(library.rooms[0].id, f.room.id);
  assert.deepEqual(Object.keys(library.rooms[0]).sort(), [
    "id",
    "members",
    "name",
  ]);
  assert.deepEqual(Object.keys(library.rooms[0].members[0]).sort(), [
    "kind",
    "name",
    "principal_id",
  ]);
  await f.changeMember(f.peer, { status: "disabled" });
  assert.equal(
    (await f.call(f.agent.token, "/library")).rooms[0].members.length,
    2,
  );
  for (const plugin of ["attendance", "approvals", "calendar", "meetings"])
    await f.setPolicy(plugin, { enabled: false });
  assert.deepEqual((await f.call(f.agent.token, "/library")).rooms, []);
});

test("stored operation authorization blocks stale private or mixed receipts without rejecting fresh filtered aggregates", async () => {
  const f = await setup();
  await f.call(f.owner.token, `/rooms/${f.room.id}/documents`, "POST", {
    title: "receipt-proof",
    content: "receipt-proof",
  });
  await f.call(f.owner.token, `/rooms/${f.room.id}/messages`, "POST", {
    client_id: "receipt-message",
    content: "receipt-proof",
  });
  const cached = await f.call(f.agent.token, "/search?q=receipt-proof");
  await f.setPolicy("docs", { enabled: false });
  await denied(
    f.authorizeReceipt(
      {
        method: "GET",
        pathname: "/api/im/search",
        input: { q: "receipt-proof" },
        receipt: cached,
      },
      f.agent.token,
    ),
    "docs",
  );
  const filtered = await f.call(f.agent.token, "/search?q=receipt-proof");
  await f.authorizeReceipt(
    {
      method: "GET",
      pathname: "/api/im/search",
      input: { q: "receipt-proof" },
      receipt: filtered,
    },
    f.agent.token,
  );
  const library = await f.call(f.agent.token, "/library");
  await f.authorizeReceipt(
    { method: "GET", pathname: "/api/im/library", receipt: library },
    f.agent.token,
  );
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/members/${f.agent.principal.id}`,
    "DELETE",
  );
  await assert.rejects(
    f.authorizeReceipt(
      { method: "GET", pathname: "/api/im/search", receipt: filtered },
      f.agent.token,
    ),
    { code: "not_a_member" },
  );
  await assert.rejects(
    f.authorizeReceipt(
      {
        method: "POST",
        pathname: "/api/im/search",
        input: { source_room_id: f.room.id },
      },
      f.agent.token,
    ),
    { code: "not_a_member" },
  );
});

test("policy schema and revision errors leave authority intact and persistence failure cannot later commit a rejected restriction", async () => {
  const f = await setup();
  await assert.rejects(f.setPolicy("mail", { scope_mode: "unknown" }), {
    code: "invalid_app_policy",
  });
  await assert.rejects(
    f.setPolicy("mail", { allowed_principal_ids: ["principal-invented"] }),
    { code: "invalid_app_scope" },
  );
  await f.setPolicy("mail", { enabled: true });
  await assert.rejects(
    f.call(f.owner.token, "/enterprise/admin/apps/mail", "PATCH", {
      base_revision: 1,
      enabled: false,
    }),
    { code: "conflict" },
  );
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (to === f.file) throw new Error("injected policy persistence error");
      return rename(from, to);
    };
    await assert.rejects(f.setPolicy("mail", { enabled: false }), {
      code: "storage_failed",
    });
    await assert.rejects(f.call(f.agent.token, "/mail/folders"), {
      code: "storage_failed",
    });
  } finally {
    fs.renameSync = rename;
  }
  f.restart();
  await f.call(f.agent.token, "/mail/folders");
  assert.equal(
    (await f.call(f.owner.token, "/enterprise/admin/apps/mail")).app.policy
      .enabled,
    true,
  );
});
