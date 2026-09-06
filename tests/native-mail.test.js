"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-mail-tests-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

async function fixture() {
  const file = path.join(temporary, crypto.randomUUID(), "native-im.json");
  const admin = crypto.randomBytes(32).toString("hex");
  const options = {
    file,
    adminToken: admin,
    workspace: { handle: async () => { throw new Error("Unexpected document access"); } },
  };
  let im = createNativeIM(options);
  const call = (who, route, method = "GET", input = {}) => {
    const url = new URL("http://fixture/api/im" + route);
    return im.handle(method, url.pathname, input, who.token ?? who, url.searchParams);
  };
  const people = [];
  for (const [name, kind] of [["Sender", "human"], ["Agent recipient", "agent"],
    ["Visible copy", "human"], ["Blind copy", "human"], ["Other mailbox", "agent"]]) {
    people.push(await call(admin, "/admin/principals", "POST", { name, kind }));
  }
  const [sender, agent, cc, bcc, outsider] = people;
  const create = (input = {}, who = sender) => call(who, "/mail/drafts", "POST", {
    client_id: crypto.randomUUID(), to_ids: [agent.principal.id],
    subject: "Visible internal delivery", body: "Shared working note", ...input,
  });
  const send = (draft, input = {}, who = sender) => call(who, `/mail/${draft.id}/send`, "POST", {
    client_id: crypto.randomUUID(), base_revision: draft.revision, ...input,
  });
  const list = (who, folder = "inbox") => call(who, `/mail?folder=${folder}`);
  return { file, admin, call, create, send, list, sender, agent, cc, bcc, outsider,
    restart: () => { im = createNativeIM(options); } };
}
const rejects = (request, code) => assert.rejects(request, { code });

test("internal mail reaches human and Agent inboxes without leaking blind recipients", async () => {
  const f = await fixture();
  const { draft } = await f.create({
    to_ids: [f.agent.principal.id, f.agent.principal.id],
    cc_ids: [f.agent.principal.id, f.cc.principal.id],
    bcc_ids: [f.cc.principal.id, f.bcc.principal.id],
  });
  assert.equal((await f.list(f.agent)).total, 0);
  const sent = await f.send(draft);
  assert.equal(sent.delivered, 3);
  assert.equal(sent.item.transport, "workspace_internal");
  assert.deepEqual(sent.item.bcc_ids, [f.bcc.principal.id]);
  for (const recipient of [f.agent, f.cc, f.bcc]) {
    const inbox = await f.list(recipient);
    assert.equal(inbox.total, 1);
    const { item } = await f.call(recipient, `/mail/${inbox.items[0].id}`);
    assert.equal(item.body, draft.body);
    assert.equal(item.read, false);
    assert.equal(item.bcc_ids, undefined);
    assert.equal(item.bcc, undefined);
    assert.equal(JSON.stringify(inbox).includes(f.bcc.principal.id), false);
    assert.equal(JSON.stringify(item).includes(f.bcc.principal.id), false);
    const search = await f.call(recipient, "/mail/search?q=working");
    assert.equal(search.total, 1);
    assert.equal(JSON.stringify(search).includes(f.bcc.principal.id), false);
    const folders = await f.call(recipient, "/mail/folders");
    assert.equal(folders.mailbox.external_connected, false);
    assert.equal(folders.folders.find((item) => item.id === "inbox").unread, 1);
  }
  const inboxId = (await f.list(f.agent)).items[0].id;
  await rejects(f.call(f.outsider, `/mail/${inboxId}`), "not_found");
  assert.equal((await f.list(f.outsider)).total, 0);
  const { draft: agentDraft } = await f.create({ to_ids: [f.sender.principal.id] }, f.agent);
  await f.send(agentDraft, {}, f.agent);
  assert.equal((await f.list(f.sender)).items[0].sender.kind, "agent");
  f.restart();
  assert.equal((await f.list(f.agent)).total, 1);
  assert.equal((await f.list(f.sender, "sent")).total, 1);
});

test("lost create and send responses remain idempotent across restarts", async () => {
  const f = await fixture();
  const input = { client_id: "stable-create" };
  const { draft } = await f.create(input);
  f.restart();
  const duplicate = await f.create(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.draft.id, draft.id);
  await rejects(f.create({ ...input, body: "changed request" }), "idempotency_conflict");
  const sent = await f.send(draft, { client_id: "stable-send" });
  f.restart();
  const retry = await f.send(draft, { client_id: "stable-send" });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.item.id, sent.item.id);
  assert.equal((await f.list(f.agent)).total, 1);
  assert.equal((await f.list(f.sender, "sent")).total, 1);
  assert.equal((await f.list(f.sender, "drafts")).total, 0);
  const { draft: other } = await f.create();
  await rejects(f.send(other, { client_id: "stable-send" }), "idempotency_conflict");
  await rejects(f.send(draft), "already_sent");
  assert.equal((await f.list(f.agent)).total, 1);
});

test("draft revisions preserve newer work and mailbox ownership", async () => {
  const f = await fixture();
  const { draft } = await f.create();
  for (const method of ["GET", "PATCH", "DELETE"]) {
    await rejects(f.call(f.outsider, `/mail/${draft.id}`, method,
      { base_revision: 1, body: "unauthorized" }), "not_found");
  }
  const result = await f.call(f.sender, `/mail/${draft.id}`, "PATCH",
    { base_revision: 1, body: "newer local work" });
  assert.equal(result.draft.revision, 2);
  await rejects(f.call(f.sender, `/mail/${draft.id}`, "PATCH",
    { base_revision: 1, body: "stale tab" }), "conflict");
  await rejects(f.send(draft), "conflict");
  await rejects(f.call(f.sender, `/mail/${draft.id}`, "PATCH",
    { base_revision: 2, subject: "must not apply", to_ids: ["missing-person"] }), "invalid_principal");
  const current = (await f.call(f.sender, `/mail/${draft.id}`)).item;
  assert.equal(current.body, "newer local work");
  assert.equal(current.subject, draft.subject);
  assert.equal(current.revision, 2);
  await f.send(current);
  await rejects(f.call(f.sender, `/mail/${draft.id}`, "PATCH",
    { base_revision: 3, body: "edit delivered mail" }), "not_draft");
});

test("discarded drafts restore with versions and can only be restored by their owner", async () => {
  const f = await fixture();
  const { draft } = await f.create();
  await f.call(f.sender, `/mail/${draft.id}`, "DELETE", { base_revision: draft.revision });
  assert.equal((await f.list(f.sender, "drafts")).total, 0);
  const discarded = (await f.list(f.sender, "trash")).items[0];
  assert.equal(discarded.original_folder, "drafts");
  await rejects(f.call(f.agent, `/mail/${discarded.id}`, "PATCH",
    { base_revision: discarded.revision, folder: "drafts" }), "not_found");
  const { item } = await f.call(f.sender, `/mail/${discarded.id}`, "PATCH",
    { base_revision: discarded.revision, folder: "drafts" });
  assert.equal(item.id, draft.id);
  assert.equal(item.revision, 3);
  assert.equal(item.status, "draft");
  assert.equal((await f.list(f.sender, "trash")).total, 0);
  f.restart();
  assert.equal((await f.list(f.sender, "drafts")).total, 1);
  await f.send(item);
  assert.equal((await f.list(f.agent)).total, 1);
});

test("delivery read state, trash, and restore are isolated to each mailbox", async () => {
  const f = await fixture();
  const { draft } = await f.create();
  const sent = await f.send(draft);
  const received = (await f.list(f.agent)).items[0];
  await rejects(f.call(f.sender, `/mail/${received.id}`, "PATCH",
    { base_revision: 1, folder: "trash" }), "not_found");
  await rejects(f.call(f.agent, `/mail/${received.id}`, "PATCH",
    { base_revision: 1, folder: "sent" }), "not_sender");
  const archived = (await f.call(f.agent, `/mail/${received.id}`, "PATCH",
    { base_revision: 1, folder: "archive", read: true })).item;
  assert.equal(archived.revision, 2);
  await rejects(f.call(f.agent, `/mail/${received.id}`, "PATCH",
    { base_revision: 1, read: false }), "conflict");
  const trashed = (await f.call(f.agent, `/mail/${received.id}`, "PATCH",
    { base_revision: 2, folder: "trash" })).item;
  f.restart();
  assert.equal((await f.list(f.sender, "sent")).items[0].id, sent.item.id);
  assert.equal((await f.list(f.agent, "trash")).total, 1);
  const restored = (await f.call(f.agent, `/mail/${received.id}`, "PATCH",
    { base_revision: trashed.revision, folder: trashed.original_folder, read: false })).item;
  assert.equal(restored.folder, "inbox");
  assert.equal(restored.read, false);
  await rejects(f.call(f.agent, `/mail/${received.id}`, "PATCH",
    { base_revision: restored.revision, folder: "drafts" }), "not_draft");
});

test("failed send validation creates no deliveries and does not consume its retry key", async () => {
  const f = await fixture();
  const { draft } = await f.create({ to_ids: [], subject: "" });
  await rejects(f.send(draft, { client_id: "retry-after-validation" }), "incomplete_mail");
  assert.equal((await f.list(f.sender, "sent")).total, 0);
  assert.equal((await f.list(f.agent)).total, 0);
  const changed = (await f.call(f.sender, `/mail/${draft.id}`, "PATCH",
    { base_revision: 1, to_ids: [f.agent.principal.id], subject: "Ready" })).draft;
  await f.send(changed, { client_id: "retry-after-validation" });
  assert.equal((await f.list(f.agent)).total, 1);
  const { draft: revokedTarget } = await f.create({ to_ids: [f.bcc.principal.id] });
  await f.call(f.admin, "/admin/revoke", "POST", { principal_id: f.bcc.principal.id });
  await rejects(f.send(revokedTarget), "invalid_principal");
  f.restart();
  assert.equal((await f.list(f.sender, "sent")).total, 1);
  assert.equal((await f.list(f.sender, "drafts")).items[0].status, "draft");
});

test("mail persistence failure fails closed and restart recovers the unsent draft", async () => {
  const f = await fixture();
  const { draft } = await f.create();
  fs.mkdirSync(f.file + ".tmp");
  await rejects(f.send(draft, { client_id: "retry-after-storage" }), "storage_failed");
  await rejects(f.list(f.agent), "storage_failed");
  fs.rmdirSync(f.file + ".tmp");
  f.restart();
  assert.equal((await f.list(f.agent)).total, 0);
  assert.equal((await f.list(f.sender, "drafts")).total, 1);
  await f.send(draft, { client_id: "retry-after-storage" });
  assert.equal((await f.list(f.agent)).total, 1);
});

test("personal settings are versioned per authenticated identity and reject unsupported changes atomically", async () => {
  const f = await fixture();
  const initial = (await f.call(f.sender, "/settings")).settings;
  const changed = (await f.call(f.sender, "/settings", "PATCH", {
    base_revision: initial.revision, message_alignment: "left", send_shortcut: "mod_enter",
    text_scale: 1.15, show_message_preview: false,
  })).settings;
  assert.equal(changed.revision, 2);
  assert.equal((await f.call(f.agent, "/settings")).settings.revision, 1);
  await rejects(f.call(f.sender, "/settings", "PATCH", {
    base_revision: 1, text_scale: 1,
  }), "conflict");
  for (const invalid of [{ text_scale: 10 }, { show_message_preview: "yes" },
    { principal_id: f.agent.principal.id }, { message_alignment: "right" }]) {
    await rejects(f.call(f.sender, "/settings", "PATCH", {
      base_revision: 2, send_shortcut: "enter", ...invalid,
    }), "unsupported_setting");
  }
  assert.deepEqual((await f.call(f.sender, "/settings")).settings, changed);
  await f.call(f.agent, "/settings", "PATCH", { base_revision: 1, text_scale: 0.9 });
  f.restart();
  assert.deepEqual((await f.call(f.sender, "/settings")).settings, changed);
  assert.equal((await f.call(f.agent, "/settings")).settings.text_scale, 0.9);
});
