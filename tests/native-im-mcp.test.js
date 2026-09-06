"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const { nativeMCP, publicTools } = require("../native-im-mcp");
test("an agent independently logs into MCP, owns a group, proactively mentions a human and assigns office work", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "im-mcp-")),
    admin = crypto.randomBytes(32).toString("hex");
  try {
    const im = createNativeIM({
      file: path.join(folder, "im.json"),
      adminToken: admin,
      workspace: {
        handle: async () => {
          throw Error("No document access in this fixture");
        },
      },
    });
    const enroll = async (name, kind) =>
      im.handle("POST", "/api/im/admin/principals", { name, kind }, admin);
    const human = await enroll("Office member", "human"),
      agent = await enroll("Independent agent", "agent"),
      stranger = await enroll("Other member", "human");
    const call = async (token, name, args = {}) =>
      nativeMCP(
        im,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
        token,
      );
    const parse = (r) => JSON.parse(r.result.content[0].text);
    const identity = parse(await call(agent.token, "im_identity"));
    assert.equal(identity.principal.id, agent.principal.id);
    const listed = await nativeMCP(
      im,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      agent.token,
    );
    assert.equal(listed.result.tools.length, publicTools.length);
    assert.ok(listed.result.tools.some((t) => t.name === "im_write_document"));
    assert.ok(!JSON.stringify(listed).includes("admin/workers"));
    const room = parse(
      await call(agent.token, "im_create_room", {
        name: "Agent initiated work",
      }),
    ).room;
    await call(agent.token, "im_invite", {
      room_id: room.id,
      principal_id: human.principal.id,
    });
    const sent = parse(
      await call(agent.token, "im_send", {
        room_id: room.id,
        client_id: "native-handoff",
        content: "Please review the shared task.",
        mentions: [human.principal.id],
      }),
    );
    assert.equal(sent.message.author_id, agent.principal.id);
    assert.deepEqual(sent.message.mentions, [human.principal.id]);
    const task = parse(
      await call(agent.token, "im_create_task", {
        room_id: room.id,
        title: "Review the brief",
        assignee_id: human.principal.id,
      }),
    ).task;
    assert.equal(task.created_by, agent.principal.id);
    const humanRead = parse(
      await call(human.token, "im_read_room", { room_id: room.id }),
    );
    assert.equal(humanRead.messages[0].id, sent.message.id);
    assert.equal(
      (await call(stranger.token, "im_read_room", { room_id: room.id })).result
        .isError,
      true,
    );
    assert.equal(
      (
        await call(agent.token, "im_send", {
          room_id: room.id,
          client_id: "bad",
          content: "spoof",
          actor_id: human.principal.id,
        })
      ).result.isError,
      true,
    );
    const response = await call(agent.token, "im_recall_message", {
      room_id: room.id,
      message_id: sent.message.id,
      base_revision: sent.message.revision,
    });
    assert.equal(response.result.isError, false);
    assert.ok(parse(response).message.retracted_at);
    await assert.rejects(
      nativeMCP(im, { jsonrpc: "2.0", id: 1, method: "tools/list" }, admin),
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
