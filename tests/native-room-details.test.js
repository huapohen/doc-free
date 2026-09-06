"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const { nativeMCP, callNativeTool, publicTools } = require("../native-im-mcp");
const { createNativeA2A } = require("../native-a2a");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "room-details-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function fixture() {
  const file = path.join(directory, crypto.randomUUID() + ".json"), admin = crypto.randomBytes(32).toString("hex");
  const options = { file, adminToken: admin, workspace: { handle: async () => { throw new Error("Unexpected document operation"); } } };
  let im = createNativeIM(options);
  const call = (who, route, method = "GET", input = {}) => {
    const url = new URL("http://fixture/api/im" + route);
    return im.handle(method, url.pathname, input, who.token ?? who, url.searchParams);
  };
  const make = (name, kind = "human") => call(admin, "/admin/principals", "POST", { name, kind });
  const owner = await make("Human owner"), peer = await make("Human member"), agent = await make("Agent member", "agent"), outside = await make("Outside");
  const { room } = await call(owner, "/rooms", "POST", { name: "Initial group", description: "Initial description" });
  const base = "/rooms/" + room.id;
  for (const who of [peer, agent]) await call(owner, base + "/members", "POST", { principal_id: who.principal.id });
  const patch = (field, input, who = owner) => call(who, base + "/" + field, "PATCH", input);
  const rewrite = (update) => { const state = JSON.parse(fs.readFileSync(file)); update(state, state.rooms.find((entry) => entry.id === room.id)); fs.writeFileSync(file, JSON.stringify(state)); im = createNativeIM(options); };
  return { file, admin, owner, peer, agent, outside, room, base, call, patch, rewrite, restart: () => im = createNativeIM(options), get im() { return im; } };
}

test("group defaults are read-only; profile and announcement CAS are independent, durable and reject concurrent overwrites", async () => {
  const f = await fixture(), before = fs.readFileSync(f.file, "utf8");
  const initial = await f.call(f.owner, f.base + "/profile"), empty = await f.call(f.agent, f.base + "/announcement");
  assert.equal(initial.profile.revision, 1); assert.equal(empty.announcement.content, ""); assert.equal(empty.announcement.updated_at, null);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  const roomRevision = (await f.call(f.owner, f.base)).room.revision;
  const changed = await f.patch("profile", { base_revision: 1, name: "Renamed group", description: "Shared description" });
  assert.equal(changed.profile.updated_by, f.owner.principal.id); assert.equal(changed.profile.revision, 2);
  const posted = await f.patch("announcement", { base_revision: 1, content: "First announcement" });
  assert.equal(posted.announcement.revision, 2);
  const results = await Promise.allSettled([f.patch("announcement", { base_revision: 2, content: "Winner" }), f.patch("announcement", { base_revision: 2, content: "Stale" })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "conflict");
  await assert.rejects(f.patch("profile", { base_revision: 1, name: "Overwrite" }), { status: 409, code: "conflict" });
  const stable = fs.readFileSync(f.file, "utf8");
  await f.patch("profile", { base_revision: 2, name: "Renamed group" }); assert.equal(fs.readFileSync(f.file, "utf8"), stable);
  f.restart(); const detail = (await f.call(f.peer, f.base)).room;
  assert.equal(detail.name, "Renamed group"); assert.equal(detail.profile_revision, 2); assert.equal(detail.announcement_revision, 3);
  assert.equal(detail.announcement_preview, "Winner"); assert.equal(detail.revision, roomRevision + 3);
  const cleared = await f.patch("announcement", { base_revision: 3, content: "" }); assert.equal(cleared.announcement.revision, 4); assert.equal(cleared.announcement.content, "");
});

test("current group owners alone edit; Agent ownership and human membership obey identical rules without enterprise escalation", async () => {
  const f = await fixture();
  assert.deepEqual((await f.call(f.owner, f.base + "/profile")).permissions, { can_edit: true, reason: "owner" });
  for (const who of [f.peer, f.agent]) {
    assert.equal((await f.call(who, f.base + "/profile")).permissions.can_edit, false);
    await assert.rejects(f.patch("profile", { base_revision: 1, name: "Denied" }, who), { code: "owner_required" });
    await assert.rejects(f.patch("announcement", { base_revision: 1, content: "Denied" }, who), { code: "owner_required" });
  }
  await assert.rejects(f.call(f.outside, f.base + "/profile"), { code: "not_a_member" });
  await f.call(f.admin, "/admin/enterprise/bootstrap", "POST", { principal_id: f.outside.principal.id });
  await f.call(f.owner, f.base + "/members", "POST", { principal_id: f.outside.principal.id });
  await assert.rejects(f.patch("profile", { base_revision: 1, name: "Admin denied" }, f.outside), { code: "owner_required" });
  const { room } = await f.call(f.agent, "/rooms", "POST", { name: "Agent owned group" });
  assert.equal(room.created_by, f.agent.principal.id);
  const agentBase = "/rooms/" + room.id;
  assert.equal((await f.call(f.agent, agentBase)).members[0].role, "owner");
  await f.call(f.agent, agentBase + "/members", "POST", { principal_id: f.owner.principal.id });
  assert.equal((await f.call(f.agent, agentBase + "/announcement", "PATCH", { base_revision: 1, content: "Agent announcement" })).announcement.updated_by, f.agent.principal.id);
  await assert.rejects(f.call(f.owner, agentBase + "/announcement", "PATCH", { base_revision: 2, content: "Human denied" }), { code: "owner_required" });
  await f.call(f.owner, f.base + "/members/" + f.agent.principal.id, "DELETE");
  await assert.rejects(f.call(f.agent, f.base + "/announcement"), { code: "not_a_member" });
});

test("legacy groups grant only the recorded creator with a missing role and no recorded owner", async () => {
  const f = await fixture();
  f.rewrite((state, room) => { delete room.kind; delete room.members[f.owner.principal.id].role; });
  assert.deepEqual((await f.call(f.owner, f.base + "/profile")).permissions, { can_edit: true, reason: "legacy_creator" });
  await f.patch("profile", { base_revision: 1, name: "Legacy updated" });
  f.rewrite((state, room) => { room.members[f.owner.principal.id].role = "member"; });
  await assert.rejects(f.patch("profile", { base_revision: 2, name: "Do not promote explicit member" }), { code: "owner_required" });
  f.rewrite((state, room) => { delete room.members[f.owner.principal.id].role; room.members[f.agent.principal.id].role = "owner"; });
  await assert.rejects(f.patch("profile", { base_revision: 2, name: "Do not override owner" }), { code: "owner_required" });
  await f.patch("profile", { base_revision: 2, name: "Current Agent owner" }, f.agent);
  f.rewrite((state, room) => { delete room.created_by; delete room.members[f.agent.principal.id].role; });
  for (const who of [f.owner, f.agent]) await assert.rejects(f.patch("profile", { base_revision: 3, name: "Do not infer owner" }, who), { code: "owner_required" });
});

test("invalid changes remain atomic and direct conversations cannot become editable groups", async () => {
  const f = await fixture(), before = fs.readFileSync(f.file, "utf8");
  for (const input of [{ name: "No version" }, { base_revision: "1", name: "String version" }, { base_revision: 1 }, { base_revision: 1, name: " " }, { base_revision: 1, name: "a".repeat(101) }, { base_revision: 1, name: "Must not partly save", description: "d".repeat(4001) }, { base_revision: 1, owner_id: f.peer.principal.id }, { base_revision: 1, description: null }]) {
    await assert.rejects(f.patch("profile", input), { status: 422 }); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  }
  for (const input of [{ base_revision: 1 }, { base_revision: 1, content: null }, { base_revision: 1, content: "a".repeat(20001) }, { base_revision: 1, content: "valid", revision: 10 }]) {
    await assert.rejects(f.patch("announcement", input), { status: 422 }); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  }
  const { room } = await f.call(f.owner, "/rooms/direct", "POST", { principal_id: f.agent.principal.id });
  for (const field of ["profile", "announcement"]) for (const method of ["GET", "PATCH"]) {
    await assert.rejects(f.call(f.owner, "/rooms/" + room.id + "/" + field, method, { base_revision: 1, content: "No conversion" }), { code: "group_required" });
  }
});

test("full announcements and version audits remain visible in exports and Agent context; edits invalidate captured work", async () => {
  const f = await fixture(), content = "Full announcement\n" + "正文".repeat(9000) + "\nlast line";
  await f.patch("announcement", { base_revision: 1, content });
  const detail = (await f.call(f.owner, f.base)).room; assert.equal(detail.announcement_preview.length, 280);
  await f.call(f.owner, f.base + "/messages", "POST", { client_id: "context", content: "Review the group announcement", mentions: [f.agent.principal.id] });
  const claimed = await f.call(f.agent, f.base + "/turns/claim", "POST", { model: "fixture", reasoning_effort: "medium" });
  assert.equal(claimed.context.room_details.announcement.content, content); assert.equal(claimed.context.room_details.profile.name, "Initial group");
  const exported = await f.call(f.owner, f.base + "/export"); assert.ok(exported.includes(content)); assert.ok(exported.includes("群资料与公告修订审计"));
  const events = (await f.call(f.agent, "/events")).events.filter((entry) => entry.type === "room.announcement.updated");
  assert.equal(events[0].announcement.content, content); assert.equal(events[0].previous.content, ""); assert.equal(events[0].actor_id, f.owner.principal.id);
  assert.equal((await f.call(f.outside, "/events")).events.some((entry) => entry.room_id === f.room.id), false);
  await f.patch("profile", { base_revision: 1, description: "Changed instructions" });
  await assert.rejects(f.call(f.agent, f.base + "/turns/" + claimed.turn.id + "/finish", "POST", { lease_token: claimed.turn.lease_token, action: "reply", content: "Stale result", rationale: "Fixture", model: "fixture", reasoning_effort: "medium" }), { status: 409, code: "stale_context" });
  const finished = await f.call(f.agent, f.base + "/turns/" + claimed.turn.id);
  assert.equal(finished.turn.status, "stale"); assert.equal((await f.call(f.owner, f.base)).messages.some((message) => message.content === "Stale result"), false);
});

test("MCP group metadata and personal pin tools share the native API and reject stale Agent owner edits", async () => {
  const f = await fixture(), { room } = await f.call(f.agent, "/rooms", "POST", { name: "MCP group" });
  const mcp = async (who, name, args) => {
    const result = await nativeMCP(f.im, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, who.token);
    return { error: result.result.isError, value: JSON.parse(result.result.content[0].text) };
  };
  for (const name of ["im_update_room_profile", "im_update_room_announcement"]) assert.ok(publicTools.find((tool) => tool.name === name).inputSchema.required.includes("base_revision"));
  assert.equal((await mcp(f.agent, "im_room_profile", { room_id: room.id })).value.permissions.can_edit, true);
  assert.equal((await mcp(f.agent, "im_update_room_profile", { room_id: room.id, base_revision: 1, name: "MCP rename" })).value.profile.revision, 2);
  assert.equal((await mcp(f.agent, "im_update_room_announcement", { room_id: room.id, base_revision: 1, content: "MCP announcement" })).value.announcement.revision, 2);
  const stale = await mcp(f.agent, "im_update_room_announcement", { room_id: room.id, base_revision: 1, content: "Stale" }); assert.equal(stale.error, true); assert.deepEqual(stale.value, { status: 409, code: "conflict" });
  assert.equal((await mcp(f.agent, "im_room_announcement", { room_id: room.id })).value.announcement.content, "MCP announcement");
  const pinned = await mcp(f.agent, "im_preferences", { room_id: f.room.id, pinned: true }); assert.equal(pinned.value.room.is_pinned, true); assert.equal(pinned.value.room.is_favorite, false);
});

test("personal pins persist independently of favorites, mute, room ACL and other participants", async () => {
  const f = await fixture(), before = (await f.call(f.owner, f.base)).room.revision;
  assert.equal((await f.call(f.owner, f.base)).room.is_pinned, false);
  await f.patch("preferences", { pinned: true, muted: true });
  await f.patch("preferences", { favorite: true });
  await f.patch("preferences", { pinned: false });
  const owner = (await f.call(f.owner, f.base)).room;
  assert.equal(owner.is_pinned, false); assert.equal(owner.is_favorite, true); assert.equal(owner.muted, true); assert.equal(owner.revision, before);
  assert.equal((await f.call(f.agent, f.base)).room.muted, false);
  await f.patch("preferences", { pinned: true }, f.agent); f.restart();
  const agent = (await f.call(f.agent, "/rooms")).rooms.find((room) => room.id === f.room.id);
  assert.equal(agent.is_pinned, true); assert.equal(agent.preferences.pinned, true); assert.equal(agent.is_favorite, false);
  await assert.rejects(f.patch("preferences", { pinned: "true" }), { status: 422 });
  await assert.rejects(f.patch("preferences", { pinned: true }, f.outside), { code: "not_a_member" });
});

test("IM app restrictions cover metadata, events and A2A receipts; removed members cannot reuse prior access", async () => {
  const f = await fixture(); await f.patch("announcement", { base_revision: 1, content: "Scoped announcement" });
  const gateway = createNativeA2A({ file: path.join(directory, crypto.randomUUID() + "-a2a.json"), im: f.im, invokeTool: callNativeTool, publicTools });
  const receipt = await gateway.handle({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { messageId: "announcement", role: "user", parts: [{ kind: "data", data: { operation: "im_room_announcement", arguments: { room_id: f.room.id } } }] } } }, f.agent.token);
  assert.equal(receipt.result.status.state, "completed");
  await f.call(f.owner, f.base + "/members/" + f.agent.principal.id, "DELETE");
  const denied = await gateway.handle({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: receipt.result.id } }, f.agent.token); assert.equal(denied.error.data.code, "not_a_member");
  await f.call(f.admin, "/admin/enterprise/bootstrap", "POST", { principal_id: f.owner.principal.id });
  await f.call(f.owner, "/enterprise/admin/apps/im", "PATCH", { base_revision: 1, enabled: true, denied_principal_ids: [f.peer.principal.id] });
  for (const field of ["profile", "announcement"]) await assert.rejects(f.call(f.peer, f.base + "/" + field), { code: "app_policy_denied" });
  assert.equal((await f.call(f.peer, "/events")).events.some((entry) => entry.type === "room.announcement.updated"), false);
});

test("failed persistence stops service and preserves the prior group state; malformed persisted metadata never resets", async () => {
  const f = await fixture(), before = await f.call(f.owner, f.base + "/profile"), rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === f.file) throw new Error("Fixture write failure"); return rename(source, target); };
  try { await assert.rejects(f.patch("profile", { base_revision: 1, name: "Must not persist" }), { code: "storage_failed" }); } finally { fs.renameSync = rename; }
  await assert.rejects(f.call(f.owner, f.base), { code: "storage_failed" }); f.restart(); assert.deepEqual(await f.call(f.owner, f.base + "/profile"), before);
  assert.throws(() => f.rewrite((state, room) => { room.announcement = { revision: 2, content: null, updated_at: "now", updated_by: f.owner.principal.id }; }), /Room details are corrupt/);
});

test("single-message lookup opens older search hits with authors and reply parents, and confines IDs to the current room", async () => {
  const f = await fixture();
  const { message: parent } = await f.call(f.owner, f.base + "/messages", "POST", { client_id: "parent", content: "Old parent text" });
  const { message: reply } = await f.call(f.agent, f.base + "/messages", "POST", { client_id: "reply", content: "Old searchable original " + "x".repeat(500), reply_to: parent.id });
  for (let i = 0; i < 201; i++) await f.call(f.owner, f.base + "/messages", "POST", { client_id: "newer-" + i, content: "New message " + i });
  assert.equal((await f.call(f.peer, f.base)).messages.some((message) => message.id === reply.id), false);
  const detail = await callNativeTool(f.im, "im_read_message", { room_id: f.room.id, message_id: reply.id }, f.peer.token);
  assert.equal(detail.message.content, reply.content); assert.equal(detail.message.author.kind, "agent"); assert.equal(detail.reply_parent.content, parent.content); assert.equal(detail.reply_parent.author.id, f.owner.principal.id); assert.equal("history" in detail.message, false);
  await assert.rejects(f.call(f.outside, f.base + "/messages/" + reply.id), { code: "not_a_member" });
  const { room } = await f.call(f.peer, "/rooms", "POST", { name: "Other room" });
  await assert.rejects(f.call(f.peer, "/rooms/" + room.id + "/messages/" + reply.id), { status: 404, code: "not_found" });
});

test("single-message and reply-parent tombstones never expose retracted prose, revision history or attachment metadata", async () => {
  const f = await fixture();
  const { attachment } = await f.call(f.owner, f.base + "/attachments", "POST", { client_id: "secret-attachment", filename: "private-filename.txt", mime_type: "text/plain", data_base64: Buffer.from("fixture bytes").toString("base64") });
  const { message: parent } = await f.call(f.owner, f.base + "/messages", "POST", { client_id: "parent", content: "Original confidential prose", attachment_ids: [attachment.id], mentions: [f.agent.principal.id] });
  const { message: reply } = await f.call(f.peer, f.base + "/messages", "POST", { client_id: "reply", content: "Reply confidential prose", reply_to: parent.id });
  await f.call(f.owner, f.base + "/messages/" + parent.id, "PATCH", { base_revision: 1, content: "Edited confidential prose" });
  await f.call(f.owner, f.base + "/messages/" + parent.id, "DELETE", { base_revision: 2 });
  let detail = await f.call(f.agent, f.base + "/messages/" + reply.id);
  assert.equal(detail.reply_parent.content, ""); assert.deepEqual(detail.reply_parent.attachments, []); assert.deepEqual(detail.reply_parent.attachment_ids, []); assert.deepEqual(detail.reply_parent.mentions, []); assert.equal("history" in detail.reply_parent, false);
  for (const hidden of ["Original confidential prose", "Edited confidential prose", "private-filename.txt", attachment.id]) assert.equal(JSON.stringify(detail).includes(hidden), false);
  await f.call(f.peer, f.base + "/messages/" + reply.id, "DELETE", { base_revision: 1 });
  detail = await f.call(f.agent, f.base + "/messages/" + reply.id); assert.equal(detail.message.content, ""); assert.equal("history" in detail.message, false); assert.equal(JSON.stringify(detail).includes("Reply confidential prose"), false);
});
