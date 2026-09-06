"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const { MAX_BYTES } = require("../native-attachments");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "native-attachment-tests-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
async function fixture() {
  const dir = path.join(temp, crypto.randomUUID()),
    file = path.join(dir, "native-im.json"),
    admin = crypto.randomBytes(32).toString("hex");
  const options = {
    file,
    adminToken: admin,
    workspace: {
      handle: async () => {
        throw new Error("Unexpected document access");
      },
    },
  };
  let im = createNativeIM(options);
  const call = (token, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im" + route);
    return im.handle(method, url.pathname, input, token, url.searchParams);
  };
  const owner = await call(admin, "/admin/principals", "POST", {
    name: "上传者",
    kind: "human",
  });
  const agent = await call(admin, "/admin/principals", "POST", {
    name: "文件 Agent",
    kind: "agent",
  });
  const outside = await call(admin, "/admin/principals", "POST", {
    name: "其他会话",
    kind: "human",
  });
  const { room } = await call(owner.token, "/rooms", "POST", { name: "Files" });
  await call(owner.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: agent.principal.id,
  });
  const upload = (bytes, extra = {}, person = owner) =>
    call(person.token, `/rooms/${room.id}/attachments`, "POST", {
      client_id: crypto.randomUUID(),
      filename: "文件.txt",
      mime_type: "text/plain",
      data_base64: bytes.toString("base64"),
      ...extra,
    });
  return {
    dir,
    file,
    admin,
    owner,
    agent,
    outside,
    room,
    call,
    upload,
    restart: () => {
      im = createNativeIM(options);
    },
  };
}
const rejects = (value, code) => assert.rejects(value, { code });
const finish = (token) => ({
  lease_token: token,
  action: "reply",
  content: "已处理文件",
  rationale: "Fixture",
  model: "fixture",
  reasoning_effort: "medium",
});

test("authenticated attachment upload has idempotent hashes, safe storage, metadata and scoped downloads", async () => {
  const f = await fixture(),
    bytes = Buffer.from("Shared visible file"),
    data = { client_id: "stable-file" };
  const { attachment } = await f.upload(bytes, data);
  assert.equal(attachment.mime_type, "application/octet-stream");
  assert.equal(
    attachment.sha256,
    crypto.createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal((await f.upload(bytes, data)).duplicate, true);
  await rejects(
    f.upload(Buffer.from("Different content"), data),
    "idempotency_conflict",
  );
  const result = await f.call(
    f.agent.token,
    `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
  );
  assert.ok(result._native_binary.content.equals(bytes));
  assert.equal(
    fs.statSync(path.join(f.dir, "attachments", attachment.sha256)).mode &
      0o777,
    0o600,
  );
  await rejects(
    f.call(
      f.outside.token,
      `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
    ),
    "not_a_member",
  );
  await rejects(
    f.call(
      f.agent.token,
      `/rooms/${f.room.id}/attachments/${attachment.id}/content?token=forbidden`,
    ),
    "header_auth_required",
  );
  const { room: other } = await f.call(f.outside.token, "/rooms", "POST", {
    name: "Private",
  });
  await rejects(
    f.call(
      f.outside.token,
      `/rooms/${other.id}/attachments/${attachment.id}/content`,
    ),
    "attachment_scope",
  );
  f.restart();
  assert.ok(
    (
      await f.call(
        f.owner.token,
        `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
      )
    )._native_binary.content.equals(bytes),
  );
  await f.call(f.admin, "/admin/revoke", "POST", {
    principal_id: f.agent.principal.id,
  });
  await rejects(
    f.call(
      f.agent.token,
      `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
    ),
    "unauthorized",
  );
});

test("upload validates filename/base64/MIME/size and does not inline active document formats", async () => {
  const f = await fixture();
  await rejects(
    f.upload(Buffer.from("text"), { filename: "../escape.txt" }),
    "invalid_filename",
  );
  await rejects(
    f.upload(Buffer.from("text"), { filename: "header\r\nInjected" }),
    "invalid_filename",
  );
  await rejects(
    f.upload(Buffer.from("not-png"), {
      mime_type: "image/png",
      filename: "fake.png",
    }),
    "mime_mismatch",
  );
  await rejects(
    f.upload(Buffer.from("data"), { data_base64: "not base64!" }),
    "invalid_base64",
  );
  await rejects(
    f.upload(Buffer.from("data"), {
      data_base64: "A".repeat(Math.ceil(MAX_BYTES / 3) * 4 + 4),
    }),
    "too_large",
  );
  const svg = await f.upload(Buffer.from('<svg onload="unsafe()"/>'), {
    mime_type: "image/svg+xml",
    filename: "safe-download.svg",
  });
  assert.equal(svg.attachment.mime_type, "application/octet-stream");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  assert.equal(
    (await f.upload(png, { mime_type: "image/png", filename: "pixel.png" }))
      .attachment.mime_type,
    "image/png",
  );
});

test("attachment-only messages, pinning, audited forwarding and recall preserve explicit copy boundaries", async () => {
  const f = await fixture(),
    { attachment } = await f.upload(Buffer.from("Forwardable artifact"));
  const { message } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/messages`,
    "POST",
    { client_id: "file-message", content: "", attachment_ids: [attachment.id] },
  );
  assert.equal(message.attachments[0].download_path, attachment.download_path);
  await f.call(
    f.agent.token,
    `/rooms/${f.room.id}/messages/${message.id}/pin`,
    "POST",
    { pinned: true },
  );
  assert.equal(
    (await f.call(f.owner.token, `/rooms/${f.room.id}`)).pins[0].id,
    message.id,
  );
  const { room: target } = await f.call(f.owner.token, "/rooms", "POST", {
    name: "Explicit destination",
  });
  await f.call(f.owner.token, `/rooms/${target.id}/members`, "POST", {
    principal_id: f.outside.principal.id,
  });
  const payload = {
    target_room_id: target.id,
    client_id: "forward-one",
    base_revision: 1,
  };
  await rejects(
    f.call(
      f.agent.token,
      `/rooms/${f.room.id}/messages/${message.id}/forward`,
      "POST",
      payload,
    ),
    "not_a_member",
  );
  const sent = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/messages/${message.id}/forward`,
    "POST",
    payload,
  );
  assert.equal(sent.message.author_id, f.owner.principal.id);
  assert.equal(sent.message.forwarded_from.message_id, message.id);
  assert.notEqual(sent.message.attachment_ids[0], attachment.id);
  assert.equal(
    (
      await f.call(
        f.owner.token,
        `/rooms/${f.room.id}/messages/${message.id}/forward`,
        "POST",
        payload,
      )
    ).duplicate,
    true,
  );
  const copyId = sent.message.attachment_ids[0];
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/messages/${message.id}`,
    "DELETE",
    { base_revision: 1 },
  );
  assert.equal(
    (await f.call(f.owner.token, `/rooms/${f.room.id}/pins`)).messages.length,
    0,
  );
  await rejects(
    f.call(
      f.agent.token,
      `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
    ),
    "attachment_recalled",
  );
  assert.ok(
    (
      await f.call(
        f.outside.token,
        `/rooms/${target.id}/attachments/${copyId}/content`,
      )
    )._native_binary.content,
  );
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/attachments/${attachment.id}`,
    "DELETE",
  );
  assert.ok(
    (
      await f.call(
        f.outside.token,
        `/rooms/${target.id}/attachments/${copyId}/content`,
      )
    )._native_binary.content,
    "explicit forwarded copy survives source deletion",
  );
  await rejects(
    f.call(
      f.outside.token,
      `/rooms/${target.id}/attachments/${copyId}`,
      "DELETE",
    ),
    "creator_required",
  );
});

test("deleting an attachment fences pending inference; model context has metadata, not file bytes", async () => {
  const f = await fixture(),
    marker = "not-for-hidden-model-input-" + crypto.randomUUID();
  const { attachment } = await f.upload(Buffer.from(marker));
  await f.call(f.owner.token, `/rooms/${f.room.id}/messages`, "POST", {
    client_id: "inference-file",
    content: "请查看附件",
    attachment_ids: [attachment.id],
  });
  const { turn, context } = await f.call(
    f.agent.token,
    `/rooms/${f.room.id}/turns/claim`,
    "POST",
    {},
  );
  assert.equal(
    context.messages.at(-1).attachments[0].sha256,
    attachment.sha256,
  );
  assert.equal(JSON.stringify(context).includes(marker), false);
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/attachments/${attachment.id}`,
    "DELETE",
  );
  await rejects(
    f.call(
      f.agent.token,
      `/rooms/${f.room.id}/turns/${turn.id}/finish`,
      "POST",
      finish(turn.lease_token),
    ),
    "turn_finished",
  );
  assert.equal(
    (await f.call(f.owner.token, `/rooms/${f.room.id}`)).runs.at(-1).status,
    "stale",
  );
  await rejects(
    f.call(
      f.agent.token,
      `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
    ),
    "attachment_deleted",
  );
});

test("download fails closed for corrupted files or symlinks rather than serving unchecked bytes", async () => {
  const f = await fixture(),
    { attachment } = await f.upload(Buffer.from("Safe content"));
  const location = path.join(f.dir, "attachments", attachment.sha256);
  fs.writeFileSync(location, "Altered");
  await rejects(
    f.call(
      f.owner.token,
      `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
    ),
    "attachment_storage",
  );
  fs.unlinkSync(location);
  fs.symlinkSync(f.file, location);
  await rejects(
    f.call(
      f.owner.token,
      `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
    ),
    "attachment_storage",
  );
  const directory = path.join(f.dir, "attachments");
  fs.renameSync(directory, directory + "-preserved");
  fs.symlinkSync(directory + "-preserved", directory);
  await rejects(
    f.call(
      f.owner.token,
      `/rooms/${f.room.id}/attachments/${attachment.id}/content`,
    ),
    "attachment_storage",
  );
  await rejects(f.upload(Buffer.from("New bytes")), "attachment_storage");
});
