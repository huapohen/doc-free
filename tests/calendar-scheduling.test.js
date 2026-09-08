"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-scheduling-"));
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

const create = async (f, extra = {}) => (await f.call(f.owner.token, `/rooms/${f.room.id}/calendar`, "POST", { title: "日历实例", client_id: crypto.randomUUID(), starts_at: "2026-09-06T09:00:00Z", ends_at: "2026-09-06T10:00:00Z", timezone: "Asia/Shanghai", recurrence: { frequency: "daily", count: 5 }, attendee_ids: [f.owner.principal.id, f.agent.principal.id], ...extra })).event;
const list = (f, from = "2026-09-06T00:00:00Z", to = "2026-09-12T00:00:00Z", person = f.owner, extra = {}) => f.call(person.token, `/calendar/occurrences?${new URLSearchParams({ from, to, ...extra })}`);
const mutate = (f, e, input, method = "PATCH", person = f.owner) => f.call(person.token, `/calendar/${e.id}`, method, { base_revision: e.revision, client_id: crypto.randomUUID(), ...input });

test("all-day and recurring masters persist, list only scoped instances, and do not store expansion", async () => {
  const f = await setup();
  const payload = { title: "两天全天", all_day: true, start_date: "2026-09-06", end_date: "2026-09-08", timezone: "Asia/Shanghai", recurrence: { frequency: "weekly", count: 3 }, client_id: "all-day", attendee_ids: [f.agent.principal.id] };
  const { event: e } = await f.call(f.owner.token, `/rooms/${f.room.id}/calendar`, "POST", payload);
  assert.equal(e.all_day, true);
  const p = await list(f);
  assert.equal(p.occurrences.length, 1);
  assert.equal(p.occurrences[0].end_date, "2026-09-08");
  assert.equal((await list(f, undefined, undefined, f.outside)).occurrences.length, 0);
  const before = fs.readFileSync(f.file, "utf8");
  await list(f, "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  f.restart();
  assert.equal((await list(f)).occurrences[0].occurrence_id, p.occurrences[0].occurrence_id);
  assert.equal(JSON.parse(before).office.calendar.length, 1);
  assert.equal((await f.call(f.owner.token, `/rooms/${f.room.id}/calendar`, "POST", payload)).duplicate, true);
  const caps = await f.call(f.agent.token, "/capabilities");
  assert.equal(caps.calendar_scheduling.overlap_policy, "earlier");
  assert.equal(caps.calendar_scheduling.following_scope, false);
});
test("explicit nulls and all-day timestamp inputs reject without any durable or memory mutation", async () => {
  const f = await setup(), e = await create(f), before = fs.readFileSync(f.file, "utf8");
  for (const input of [{ all_day: null }, { timezone: null }, { starts_at: null }, { recurrence: { frequency: "daily", count: null } }]) await assert.rejects(mutate(f, e, { scope: "series", ...input }));
  for (const input of [{ all_day: null }, { timezone: null }, { all_day: true, start_date: "2026-09-06", end_date: "2026-09-07" }]) await assert.rejects(create(f, input));
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal((await f.call(f.owner.token, `/calendar/${e.id}`)).event.revision, e.revision);
});
test("instance move uses final interval, stable origin, aggregate CAS and immutable retry receipt", async () => {
  const f = await setup(), e = await create(f), source = (await list(f)).occurrences[0];
  const payload = { scope: "occurrence", occurrence_id: source.occurrence_id, base_revision: 1, client_id: "move-one", starts_at: "2026-10-08T09:00:00Z", ends_at: "2026-10-08T10:00:00Z" };
  const moved = await mutate(f, e, payload);
  assert.equal(moved.series.revision, 2);
  assert.equal(moved.event.occurrence_id, source.occurrence_id);
  assert.equal((await list(f)).occurrences.length, 4);
  assert.equal((await list(f, "2026-10-08T00:00:00Z", "2026-10-09T00:00:00Z")).occurrences[0].original_start, source.original_start);
  await rejects(mutate(f, e, { scope: "series", title: "stale" }), "conflict");
  const edited = await mutate(f, moved.series, { scope: "series", title: "后来改名" });
  assert.equal(edited.event.revision, 3);
  const before = fs.readFileSync(f.file, "utf8");
  assert.deepEqual(await mutate(f, e, payload), moved);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  await rejects(mutate(f, e, { ...payload, title: "不同请求" }), "idempotency_conflict");
  f.restart();
  assert.deepEqual(await mutate(f, e, payload), moved);
  await rejects(mutate(f, edited.event, { scope: "series", recurrence: { frequency: "weekly" } }), "exceptions_reset_required");
  const reset = await mutate(f, edited.event, { scope: "series", recurrence: { frequency: "weekly" }, reset_exceptions: true });
  assert.equal(reset.event.recurrence_generation, 2);
  assert.equal(reset.event.exception_archives[0].exceptions[source.occurrence_id].overrides.starts_at, "2026-10-08T09:00:00.000Z");
  assert.deepEqual(await mutate(f, e, payload), moved);
  await rejects(f.call(f.owner.token, `/calendar/${e.id}?occurrence_id=${source.occurrence_id}`), "stale_occurrence");
});
test("series RSVP defaults, instance RSVP override and reschedule invalidation are authentic self", async () => {
  const f = await setup(); let e = await create(f);
  const response = (input, person = f.agent) => f.call(person.token, `/calendar/${e.id}/respond`, "POST", { base_revision: e.revision, client_id: crypto.randomUUID(), ...input });
  e = (await response({ scope: "series", response: "accepted", principal_id: f.owner.principal.id })).event;
  let rows = (await list(f)).occurrences;
  assert.equal(rows[0].responses[f.agent.principal.id], "accepted");
  assert.equal(rows[0].responses[f.owner.principal.id], undefined);
  const chosen = rows[1];
  e = (await response({ scope: "occurrence", occurrence_id: chosen.occurrence_id, response: "declined" })).series;
  rows = (await list(f)).occurrences;
  assert.equal(rows[0].responses[f.agent.principal.id], "accepted");
  assert.equal(rows[1].responses[f.agent.principal.id], "declined");
  const moved = await mutate(f, e, { scope: "occurrence", occurrence_id: chosen.occurrence_id, starts_at: "2026-09-07T11:00:00Z", ends_at: "2026-09-07T12:00:00Z" }); e = moved.series;
  assert.deepEqual(moved.event.responses, {});
  assert.equal((await list(f)).occurrences[0].responses[f.agent.principal.id], "accepted");
  await rejects(response({ scope: "series", response: "accepted" }, f.peer), "not_invited");
  await rejects(mutate(f, e, { scope: "series", title: "无权修改" }, "PATCH", f.agent), "creator_required");
});
test("occurrence and series cancellation keep tombstones, current auth before receipt and no duplicate event", async () => {
  const f = await setup(), e = await create(f), row = (await list(f)).occurrences[0];
  const payload = { scope: "occurrence", occurrence_id: row.occurrence_id, client_id: "cancel-one", base_revision: 1 };
  const cancelled = await mutate(f, e, payload, "DELETE");
  assert.equal(cancelled.event.status, "cancelled");
  assert.equal((await list(f)).occurrences.length, 4);
  assert.equal((await f.call(f.agent.token, `/calendar/${e.id}?occurrence_id=${row.occurrence_id}`)).event.status, "cancelled");
  assert.deepEqual(await mutate(f, e, payload, "DELETE"), cancelled);
  const series = await mutate(f, cancelled.series, { scope: "series", client_id: "cancel-series" }, "DELETE");
  assert.equal(series.event.status, "cancelled");
  assert.equal((await list(f)).occurrences.length, 0);
  assert.equal((await f.call(f.owner.token, "/calendar")).events.length, 1);
  await rejects(f.call(f.agent.token, `/calendar/${e.id}/respond`, "POST", { scope: "series", client_id: "late", base_revision: 3, response: "accepted" }), "event_cancelled");
  await rejects(mutate(f, e, payload, "DELETE", f.outside), "not_a_member");
  const persisted = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(persisted.events.filter((v) => v.type === "calendar.cancelled").length, 2);
});
test("meeting-linked events reject all-day, recurrence and cancellation before mutation", async () => {
  const f = await setup(), meeting = await f.meeting(), e = (await f.call(f.owner.token, `/calendar/${meeting.calendar_event_id}`)).event, before = fs.readFileSync(f.file, "utf8");
  for (const payload of [{ scope: "series", all_day: true, start_date: "2026-09-06", end_date: "2026-09-07" }, { scope: "series", recurrence: { frequency: "daily" } }]) await rejects(mutate(f, e, payload), "meeting_schedule_mode_unsupported");
  await rejects(mutate(f, e, { scope: "series" }, "DELETE"), "meeting_schedule_mode_unsupported");
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});
test("pagination invalidates after revision changes and identity switch without leaking records", async () => {
  const f = await setup(), e = await create(f), first = await list(f, undefined, undefined, f.owner, { limit: "2" });
  assert.equal(first.truncated, true);
  const second = await list(f, undefined, undefined, f.owner, { limit: "2", cursor: first.next_cursor });
  assert.equal(second.occurrences[0].starts_at, "2026-09-08T09:00:00.000Z");
  await rejects(list(f, undefined, undefined, f.agent, { limit: "2", cursor: first.next_cursor }), "stale_cursor");
  await rejects(list(f, undefined, undefined, f.outside, { limit: "2", cursor: first.next_cursor }), "stale_cursor");
  await mutate(f, e, { scope: "series", title: "新修订" });
  await rejects(list(f, undefined, undefined, f.owner, { limit: "2", cursor: first.next_cursor }), "stale_cursor");
});

test("active colleague reviews upcoming occurrences after the master first event has ended", async () => {
  const f = await setup(), base = `/rooms/${f.room.id}`;
  const { room } = await f.call(f.agent.token, base);
  await f.call(f.agent.token, `${base}/participation`, "PATCH", { base_revision: room.revision, autonomy: { enabled: true, review_interval_seconds: 60 } });
  await create(f, { starts_at: "2026-09-04T09:00:00Z", ends_at: "2026-09-04T10:00:00Z" });
  const claim = () => f.call(f.agent.token, `${base}/turns/claim`, "POST", { model: "fixture", reasoning_effort: "medium" });
  const finish = (turn) => f.call(f.agent.token, `${base}/turns/${turn.id}/finish`, "POST", { lease_token: turn.lease_token, action: "silent", rationale: "待下一次日程复核", model: "fixture", reasoning_effort: "medium" });
  const first = await claim();
  assert.equal(first.context.trigger.type, "calendar.created");
  assert.ok(first.context.office.upcoming_calendar.occurrences.some((e) => e.starts_at === "2026-09-06T09:00:00.000Z"));
  assert.equal(first.context.office.calendar[0].starts_at, "2026-09-04T09:00:00.000Z");
  await finish(first.turn);
  assert.equal((await claim()).turn, null);
  f.advance(61000);
  const review = await claim();
  assert.equal(review.context.trigger.type, "agent.review");
  assert.equal(review.context.office.upcoming_calendar.range.timezone, "UTC");
  await finish(review.turn);
});

test("RSVP retry rechecks current invitation after a series generation reset", async () => {
  const f = await setup(); let e = await create(f);
  const occurrence = (await list(f)).occurrences[0];
  const payload = { scope: "occurrence", occurrence_id: occurrence.occurrence_id, base_revision: e.revision, client_id: "rsvp-stable", response: "accepted" };
  const call = () => f.call(f.agent.token, `/calendar/${e.id}/respond`, "POST", payload);
  const accepted = await call(); e = accepted.series;
  e = (await mutate(f, e, { scope: "series", recurrence: { frequency: "weekly" }, reset_exceptions: true })).event;
  assert.deepEqual(await call(), accepted);
  e = (await mutate(f, e, { scope: "series", attendee_ids: [f.owner.principal.id] })).event;
  const before = fs.readFileSync(f.file, "utf8");
  await rejects(call(), "not_invited");
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("series cancellation reaches an Agent invited to only one occurrence", async () => {
  const f = await setup(); let e = await create(f, { attendee_ids: [f.owner.principal.id] });
  const occurrence = (await list(f)).occurrences[0];
  e = (await mutate(f, e, { scope: "occurrence", occurrence_id: occurrence.occurrence_id, attendee_ids: [f.owner.principal.id, f.agent.principal.id] })).series;
  const base = `/rooms/${f.room.id}`, first = await f.call(f.agent.token, `${base}/turns/claim`, "POST");
  assert.equal(first.context.trigger.type, "calendar.updated");
  await f.call(f.agent.token, `${base}/turns/${first.turn.id}/finish`, "POST", { lease_token: first.turn.lease_token, action: "silent", rationale: "收到单次邀请", model: "fixture", reasoning_effort: "medium" });
  await mutate(f, e, { scope: "series" }, "DELETE");
  const cancelled = await f.call(f.agent.token, `${base}/turns/claim`, "POST");
  assert.equal(cancelled.context.trigger.type, "calendar.cancelled");
  assert.equal(cancelled.context.office.upcoming_calendar.occurrences.length, 0);
});

test("committed create retry survives another attendee leaving but rejects tampering and revoked actor access", async () => {
  const f = await setup(), base = `/rooms/${f.room.id}`;
  const payload = { title: "既成全天邀请", client_id: "committed-invite", all_day: true, start_date: "2026-09-08", end_date: "2026-09-09", timezone: "Asia/Shanghai", recurrence: { frequency: "weekly", count: 3 }, attendee_ids: [f.owner.principal.id, f.agent.principal.id, f.peer.principal.id] };
  const call = (input = payload) => f.call(f.peer.token, `${base}/calendar`, "POST", input);
  const created = await call();
  await f.call(f.owner.token, `${base}/members/${f.agent.principal.id}`, "DELETE");
  const before = fs.readFileSync(f.file, "utf8");
  const retry = await call();
  assert.deepEqual(retry, { ...created, duplicate: true });
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  await rejects(call({ ...payload, title: "篡改既成请求" }), "idempotency_conflict");
  await rejects(call({ ...payload, attendee_ids: [f.outside.principal.id] }), "idempotency_conflict");
  await rejects(call({ ...payload, attendee_ids: [{ principal_id: f.agent.principal.id }] }), "invalid_attendees");
  await rejects(call({ ...payload, client_id: "new-invite-after-removal" }), "invalid_attendees");
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  f.restart();
  assert.deepEqual(await call(), retry);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).office.calendar.length, 1);
  await f.call(f.owner.token, `${base}/members/${f.peer.principal.id}`, "DELETE");
  const revoked = fs.readFileSync(f.file, "utf8");
  await rejects(call(), "not_a_member");
  assert.equal(fs.readFileSync(f.file, "utf8"), revoked);
});
