"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "native-search-tests-"),
);
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
async function setup() {
  const admin = crypto.randomBytes(32).toString("hex");
  const im = createNativeIM({
    file: path.join(temporary, crypto.randomUUID() + ".json"),
    adminToken: admin,
    workspace: {
      handle: async () => {
        throw new Error("unexpected document read");
      },
    },
  });
  const call = (token, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im" + route);
    return im.handle(method, url.pathname, input, token, url.searchParams);
  };
  const make = (name, kind = "human") =>
    call(admin, "/admin/principals", "POST", { name, kind });
  const owner = await make("产品负责人"),
    reviewer = await make("产品Agent", "agent"),
    peer = await make("Peer"),
    outside = await make("Outside");
  const { room } = await call(owner.token, "/rooms", "POST", {
    name: "Product room",
  });
  for (const person of [reviewer, peer])
    await call(owner.token, `/rooms/${room.id}/members`, "POST", {
      principal_id: person.principal.id,
    });
  return { admin, call, make, owner, reviewer, peer, outside, room };
}

test("unified search finds contacts/store and authorized office work while protecting private approvals and blind mail recipients", async () => {
  const f = await setup();
  const { request } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/approvals`,
    "POST",
    {
      client_id: "approval-search",
      template_id: "general",
      title: "产品隐私审批",
      approver_id: f.reviewer.principal.id,
      payload: { note: "restricted" },
    },
  );
  const { event } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/calendar`,
    "POST",
    {
      client_id: "calendar-search",
      title: "产品排期",
      starts_at: "2027-01-01T01:00:00Z",
      ends_at: "2027-01-01T02:00:00Z",
    },
  );
  const { draft } = await f.call(f.owner.token, "/mail/drafts", "POST", {
    client_id: "mail-search",
    to_ids: [f.reviewer.principal.id],
    bcc_ids: [f.peer.principal.id],
    subject: "Brief",
    body: "Long introduction ".repeat(30) + "产品内部邮件证据",
  });
  await f.call(f.owner.token, `/mail/${draft.id}/send`, "POST", {
    client_id: "send-search",
    base_revision: 1,
  });
  await f.call(f.owner.token, "/mail/drafts", "POST", {
    client_id: "private-draft",
    subject: "产品私有草稿",
    body: "never visible to reviewer",
  });
  const search = (person, query = "产品") =>
    f.call(person.token, "/search?q=" + encodeURIComponent(query));
  const result = await search(f.reviewer);
  assert.deepEqual(
    new Set(result.results.map((entry) => entry.type)),
    new Set(["person", "agent", "store", "mail", "approval", "calendar"]),
  );
  assert.ok(
    result.results.every(
      (entry) => entry.id && entry.title && typeof entry.snippet === "string",
    ),
  );
  const mail = result.results.find((entry) => entry.type === "mail");
  assert.match(mail.snippet, /产品内部邮件证据/);
  assert.equal(mail.mail.bcc_ids, undefined);
  assert.equal(
    result.results.find((entry) => entry.type === "approval").request.id,
    request.id,
  );
  assert.equal(
    result.results.find((entry) => entry.type === "calendar").event.id,
    event.id,
  );
  assert.ok(!JSON.stringify(result).includes("never visible to reviewer"));
  assert.ok(
    !(await search(f.peer)).results.some((entry) => entry.type === "approval"),
  );
  assert.deepEqual(
    new Set((await search(f.outside)).results.map((entry) => entry.type)),
    new Set(["person", "agent", "store"]),
  );
  assert.deepEqual((await search(f.outside, crypto.randomUUID())).results, []);
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/members/${f.reviewer.principal.id}`,
    "DELETE",
  );
  const removed = await search(f.reviewer);
  assert.ok(
    !removed.results.some((entry) =>
      ["approval", "calendar"].includes(entry.type),
    ),
  );
  assert.ok(
    removed.results.some((entry) => entry.type === "mail"),
    "personal delivery survives room removal",
  );
});

test("global search caps all domains at two hundred and excludes revoked directory identities", async () => {
  const f = await setup();
  for (let index = 0; index < 205; index++)
    await f.make(`boundedquery ${index}`, index % 2 ? "agent" : "human");
  const revoked = await f.make("uniquerevokedquery");
  await f.call(f.admin, "/admin/revoke", "POST", {
    principal_id: revoked.principal.id,
  });
  const result = await f.call(f.owner.token, "/search?q=boundedquery");
  assert.equal(result.results.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(
    (await f.call(f.owner.token, "/search?q=uniquerevokedquery")).results
      .length,
    0,
  );
});
