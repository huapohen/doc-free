"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "office-features-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
async function setup() {
  const admin = crypto.randomBytes(32).toString("hex"),
    file = path.join(directory, crypto.randomUUID() + ".json");
  let clock = Date.parse("2026-09-06T01:00:00Z");
  const document = {
    id: "meeting-notes",
    title: "共同纪要",
    content: "## Agenda\n\nReview",
    revision: 1,
    content_hash: "hash-r1",
  };
  const options = {
    file,
    adminToken: admin,
    now: () => clock,
    workspace: {
      handle: async (method, route) => {
        if (
          method === "GET" &&
          route === "/api/workspace/documents/meeting-notes"
        )
          return { ...document };
        throw new Error("Unexpected document operation");
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
  const owner = await make("会议负责人"),
    agent = await make("Agent 同事", "agent"),
    peer = await make("参会同事"),
    outside = await make("其他团队");
  const { room } = await call(owner.token, "/rooms", "POST", {
    name: "Project room",
  });
  for (const person of [agent, peer])
    await call(owner.token, `/rooms/${room.id}/members`, "POST", {
      principal_id: person.principal.id,
    });
  const meeting = async (extra = {}, creator = owner) =>
    (
      await call(creator.token, `/rooms/${room.id}/meetings`, "POST", {
        title: "项目评审",
        client_id: crypto.randomUUID(),
        ...extra,
      })
    ).meeting;
  const join = (person, item, device = "browser") =>
    call(person.token, `/meetings/${item.id}/join`, "POST", {
      device_id: device,
    });
  return {
    admin,
    file,
    call,
    make,
    owner,
    agent,
    peer,
    outside,
    room,
    meeting,
    join,
    document,
    advance: (ms) => {
      clock += ms;
    },
    restart: () => {
      im = createNativeIM(options);
    },
  };
}
const rejects = (promise, code) => assert.rejects(promise, { code });

test("meetings are scoped, idempotent, kind-neutral and linked to canonical notes/calendar", async () => {
  const f = await setup();
  await f.call(f.admin, "/admin/import", "POST", {
    room_id: f.room.id,
    document_id: f.document.id,
  });
  const payload = {
    title: "Agent 主持评审",
    client_id: "stable-meeting",
    starts_at: "2026-09-06T02:00:00Z",
    duration_minutes: 45,
    document_id: f.document.id,
  };
  const first = await f.call(
    f.agent.token,
    `/rooms/${f.room.id}/meetings`,
    "POST",
    payload,
  );
  assert.equal(first.meeting.created_by, f.agent.principal.id);
  assert.equal(first.meeting.status, "scheduled");
  assert.equal(first.meeting.notes_document.revision, 1);
  assert.equal(
    (
      await f.call(
        f.agent.token,
        `/rooms/${f.room.id}/meetings`,
        "POST",
        payload,
      )
    ).duplicate,
    true,
  );
  await rejects(
    f.call(f.agent.token, `/rooms/${f.room.id}/meetings`, "POST", {
      ...payload,
      title: "changed",
    }),
    "idempotency_conflict",
  );
  await rejects(
    f.call(f.outside.token, `/meetings/${first.meeting.id}`),
    "not_a_member",
  );
  assert.equal((await f.call(f.outside.token, "/meetings")).meetings.length, 0);
  assert.equal(
    (await f.call(f.agent.token, "/calendar")).events[0].meeting_id,
    first.meeting.id,
  );
  f.document.revision = 2;
  f.document.content_hash = "hash-r2";
  const detail = await f.call(f.owner.token, `/meetings/${first.meeting.id}`);
  assert.equal(detail.meeting.notes_document.revision, 1);
  assert.equal(detail.meeting.notes_document_current.revision, 2);
  await rejects(
    f.call(f.peer.token, `/meetings/${first.meeting.id}`, "PATCH", {
      base_revision: 1,
      document_id: null,
    }),
    "creator_required",
  );
  await rejects(
    f.call(f.agent.token, `/meetings/${first.meeting.id}`, "PATCH", {
      base_revision: 1,
      document_id: "foreign-doc",
    }),
    "document_scope",
  );
  const updated = await f.call(
    f.agent.token,
    `/meetings/${first.meeting.id}`,
    "PATCH",
    { base_revision: 1, document_id: f.document.id },
  );
  assert.equal(updated.meeting.notes_document.revision, 2);
  await rejects(
    f.call(f.agent.token, `/meetings/${first.meeting.id}`, "PATCH", {
      base_revision: 1,
      document_id: null,
    }),
    "conflict",
  );
});

test("WebRTC signal relay binds sender and recipient sessions and never persists SDP/ICE", async () => {
  const f = await setup(),
    meeting = await f.meeting();
  const a = await f.join(f.owner, meeting),
    b = await f.join(f.agent, meeting),
    c = await f.join(f.peer, meeting);
  assert.equal(
    (await f.join(f.owner, meeting)).session_id,
    a.session_id,
    "same device joins idempotently",
  );
  const marker = "synthetic-sdp-" + crypto.randomUUID();
  const sent = await f.call(
    f.owner.token,
    `/meetings/${meeting.id}/signals`,
    "POST",
    {
      session_id: a.session_id,
      to: b.session_id,
      kind: "offer",
      payload: { type: "offer", sdp: marker },
      from: c.session_id,
    },
  );
  assert.equal(sent.signal.from, a.session_id);
  const read = await f.call(
    f.agent.token,
    `/meetings/${meeting.id}/signals?session_id=${b.session_id}&after=0`,
  );
  assert.equal(read.signals.length, 1);
  assert.equal(read.signals[0].payload.sdp, marker);
  assert.equal(
    (
      await f.call(
        f.peer.token,
        `/meetings/${meeting.id}/signals?session_id=${c.session_id}&after=0`,
      )
    ).signals.length,
    0,
  );
  await rejects(
    f.call(f.agent.token, `/meetings/${meeting.id}/signals`, "POST", {
      session_id: a.session_id,
      to: c.session_id,
      kind: "candidate",
      payload: {},
    }),
    "session_expired",
  );
  const another = await f.meeting(),
    foreign = await f.join(f.peer, another);
  await rejects(
    f.call(f.owner.token, `/meetings/${meeting.id}/signals`, "POST", {
      session_id: a.session_id,
      to: foreign.session_id,
      kind: "candidate",
      payload: {},
    }),
    "invalid_recipient",
  );
  await rejects(
    f.call(
      f.outside.token,
      `/meetings/${meeting.id}/signals?session_id=${b.session_id}&after=0`,
    ),
    "not_a_member",
  );
  assert.equal(fs.readFileSync(f.file, "utf8").includes(marker), false);
  assert.equal(fs.readFileSync(f.file, "utf8").includes(a.session_id), false);
  const exported = await f.call(f.owner.token, `/rooms/${f.room.id}/export`);
  assert.equal(exported.includes(marker), false);
  f.restart();
  assert.equal(
    (await f.call(f.owner.token, "/meetings")).meetings.length,
    2,
    "meeting metadata survives restart",
  );
  const reset = await f.call(
    f.agent.token,
    `/meetings/${meeting.id}/signals?session_id=${b.session_id}&after=${read.cursor}`,
  );
  assert.equal(reset.reset_required, true);
  assert.equal(reset.signals.length, 0);
});

test("meeting signals long poll rechecks removal and revocation; end immediately fences sessions", async () => {
  const f = await setup(),
    meeting = await f.meeting();
  const a = await f.join(f.owner, meeting),
    b = await f.join(f.agent, meeting);
  const waiting = f.call(
    f.agent.token,
    `/meetings/${meeting.id}/signals?session_id=${b.session_id}&after=0&wait=20`,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/members/${f.agent.principal.id}`,
    "DELETE",
  );
  await rejects(waiting, "not_a_member");
  await rejects(
    f.call(f.owner.token, `/meetings/${meeting.id}/signals`, "POST", {
      session_id: a.session_id,
      to: b.session_id,
      kind: "offer",
      payload: {},
    }),
    "invalid_recipient",
  );
  await f.call(f.owner.token, `/rooms/${f.room.id}/members`, "POST", {
    principal_id: f.agent.principal.id,
  });
  const fresh = await f.join(f.agent, meeting);
  const revoking = f.call(
    f.agent.token,
    `/meetings/${meeting.id}/signals?session_id=${fresh.session_id}&after=0&wait=20`,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.call(f.admin, "/admin/revoke", "POST", {
    principal_id: f.agent.principal.id,
  });
  await rejects(revoking, "unauthorized");
  await rejects(
    f.call(f.peer.token, `/meetings/${meeting.id}/end`, "POST"),
    "creator_required",
  );
  const ended = await f.call(
    f.owner.token,
    `/meetings/${meeting.id}/end`,
    "POST",
  );
  assert.equal(ended.meeting.status, "ended");
  assert.deepEqual(ended.participants, []);
  await rejects(
    f.call(f.owner.token, `/meetings/${meeting.id}/heartbeat`, "POST", {
      session_id: a.session_id,
      audio: true,
    }),
    "meeting_ended",
  );
  await rejects(f.join(f.peer, meeting), "meeting_ended");
});

test("media sessions expire after 45 seconds, bound concurrent devices and expose real mute/camera state", async () => {
  const f = await setup(),
    meeting = await f.meeting();
  const a = await f.join(f.owner, meeting, "a");
  for (let i = 0; i < 5; i++) await f.join(f.agent, meeting, String(i));
  await rejects(f.join(f.peer, meeting, "over-cap"), "meeting_full");
  const state = await f.call(
    f.owner.token,
    `/meetings/${meeting.id}/heartbeat`,
    "POST",
    { session_id: a.session_id, audio: true, video: false, sharing: true },
  );
  assert.equal(
    state.participants.find((item) => item.session_id === a.session_id).sharing,
    true,
  );
  await rejects(
    f.call(f.agent.token, `/meetings/${meeting.id}/leave`, "POST", {
      session_id: a.session_id,
    }),
    "session_owner",
  );
  f.advance(45001);
  assert.equal(
    (await f.call(f.owner.token, `/meetings/${meeting.id}`)).participants
      .length,
    0,
  );
  await rejects(
    f.call(f.owner.token, `/meetings/${meeting.id}/heartbeat`, "POST", {
      session_id: a.session_id,
    }),
    "session_expired",
  );
  assert.ok((await f.join(f.peer, meeting, "after-expiry")).session_id);
});

test("calendar invitations are scoped, idempotent, revision-checked and respond as the authenticated attendee", async () => {
  const f = await setup();
  const body = {
    title: "里程碑评审",
    client_id: "calendar-stable",
    starts_at: "2026-09-06T03:00:00Z",
    ends_at: "2026-09-06T04:00:00Z",
    attendee_ids: [f.agent.principal.id],
  };
  const made = await f.call(
      f.peer.token,
      `/rooms/${f.room.id}/calendar`,
      "POST",
      body,
    ),
    item = made.event;
  assert.equal(
    (await f.call(f.peer.token, `/rooms/${f.room.id}/calendar`, "POST", body))
      .duplicate,
    true,
  );
  await rejects(
    f.call(f.peer.token, `/rooms/${f.room.id}/calendar`, "POST", {
      ...body,
      title: "Another",
    }),
    "idempotency_conflict",
  );
  await rejects(
    f.call(f.owner.token, `/calendar/${item.id}/respond`, "POST", {
      response: "accepted",
    }),
    "not_invited",
  );
  const responded = await f.call(
    f.agent.token,
    `/calendar/${item.id}/respond`,
    "POST",
    { response: "accepted", principal_id: f.owner.principal.id },
  );
  assert.equal(responded.event.responses[f.agent.principal.id], "accepted");
  assert.equal(responded.event.responses[f.owner.principal.id], undefined);
  await rejects(
    f.call(f.agent.token, `/calendar/${item.id}`, "PATCH", {
      base_revision: 2,
      title: "Unauthorized",
    }),
    "creator_required",
  );
  await rejects(
    f.call(f.peer.token, `/calendar/${item.id}`, "PATCH", {
      base_revision: 1,
      title: "Stale",
    }),
    "conflict",
  );
  const moved = await f.call(f.owner.token, `/calendar/${item.id}`, "PATCH", {
    base_revision: 2,
    starts_at: "2026-09-06T05:00:00Z",
    ends_at: "2026-09-06T06:00:00Z",
  });
  assert.deepEqual(
    moved.event.responses,
    {},
    "rescheduling invalidates prior acceptance",
  );
  assert.equal((await f.call(f.outside.token, "/calendar")).events.length, 0);
  await rejects(
    f.call(f.peer.token, `/rooms/${f.room.id}/calendar`, "POST", {
      ...body,
      client_id: "invalid-people",
      attendee_ids: [f.outside.principal.id],
    }),
    "invalid_attendees",
  );
  await rejects(
    f.call(f.peer.token, `/rooms/${f.room.id}/calendar`, "POST", {
      ...body,
      client_id: "invalid-time",
      ends_at: body.starts_at,
    }),
    "invalid_datetime",
  );
  f.restart();
  assert.equal(
    (await f.call(f.agent.token, `/calendar/${item.id}`)).event.revision,
    3,
  );
});

test("workbench favorites persist per identity and unavailable modules stay unavailable; real read positions are shared", async () => {
  const f = await setup();
  const apps = await f.call(f.owner.token, "/workbench");
  assert.equal(
    apps.apps.find((app) => app.id === "approvals").available,
    false,
  );
  await rejects(
    f.call(f.owner.token, "/workbench", "PATCH", { favorites: ["reports"] }),
    "invalid_favorites",
  );
  await f.call(f.agent.token, "/workbench", "PATCH", {
    favorites: ["meetings", "calendar"],
  });
  assert.deepEqual((await f.call(f.agent.token, "/workbench")).favorites, [
    "meetings",
    "calendar",
  ]);
  assert.notDeepEqual((await f.call(f.owner.token, "/workbench")).favorites, [
    "meetings",
    "calendar",
  ]);
  const { message } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/messages`,
    "POST",
    { client_id: "receipt", content: "实际已读" },
  );
  await f.call(f.agent.token, `/rooms/${f.room.id}/preferences`, "PATCH", {
    read_seq: message.seq,
  });
  const room = await f.call(f.owner.token, `/rooms/${f.room.id}`);
  assert.equal(
    room.members.find((person) => person.principal_id === f.agent.principal.id)
      .read_seq,
    message.seq,
  );
  f.restart();
  assert.deepEqual((await f.call(f.agent.token, "/workbench")).favorites, [
    "meetings",
    "calendar",
  ]);
});

test("meeting date overflow is rejected before mutating durable or in-memory scheduling state", async () => {
  const f = await setup();
  await rejects(
    f.meeting({
      client_id: "overflow",
      starts_at: "+275760-09-13T00:00:00.000Z",
      duration_minutes: 30,
    }),
    "invalid_datetime",
  );
  assert.equal((await f.call(f.owner.token, "/meetings")).meetings.length, 0);
  assert.equal((await f.call(f.owner.token, "/calendar")).events.length, 0);
  f.restart();
  assert.equal((await f.call(f.owner.token, "/meetings")).meetings.length, 0);
});

test("visible office context records exact scheduling revisions and fences changed calendar input", async () => {
  const f = await setup();
  const { event: item } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/calendar`,
    "POST",
    {
      client_id: "context-calendar",
      title: "共享安排",
      starts_at: "2026-09-06T03:00:00Z",
      ends_at: "2026-09-06T04:00:00Z",
    },
  );
  await f.call(f.owner.token, `/rooms/${f.room.id}/messages`, "POST", {
    client_id: "read-calendar",
    content: "请检查我们的会议安排",
  });
  const { turn, context } = await f.call(
    f.agent.token,
    `/rooms/${f.room.id}/turns/claim`,
    "POST",
  );
  assert.equal(context.office.calendar[0].id, item.id);
  assert.equal(context.office.manifest.calendar[0].revision, 1);
  await f.call(f.owner.token, `/calendar/${item.id}`, "PATCH", {
    base_revision: 1,
    description: "新的约束",
  });
  await rejects(
    f.call(
      f.agent.token,
      `/rooms/${f.room.id}/turns/${turn.id}/finish`,
      "POST",
      {
        lease_token: turn.lease_token,
        action: "reply",
        content: "Old schedule",
        rationale: "fixture",
        model: "fixture",
        reasoning_effort: "medium",
      },
    ),
    "stale_context",
  );
  const recorded = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/turns/${turn.id}`,
  );
  assert.equal(recorded.turn.context.office.calendar[0].revision, 1);
  const exported = await f.call(f.owner.token, `/rooms/${f.room.id}/export`);
  assert.ok(exported.includes("## 会议与日程"));
  assert.ok(exported.includes("新的约束"));
});
