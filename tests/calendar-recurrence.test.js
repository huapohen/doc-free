"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSchedule, occurrencesPage, occurrenceById } = require("../calendar-recurrence");
const event = (input) => ({ id: "calendar-fixture", revision: 1, responses: {}, attendee_ids: ["human", "agent"], status: "scheduled", ...normalizeSchedule(input) });
const timed = (extra = {}) => event({ starts_at: "2026-01-31T09:00:00Z", ends_at: "2026-01-31T10:00:00Z", ...extra });
const page = (e, from, to, more = {}) => occurrencesPage([e], { from, to, ...more });

test("all-day uses exclusive real dates, timezone display projection and multi-day overlap", () => {
  const e = event({ all_day: true, timezone: "Pacific/Auckland", start_date: "2026-09-08", end_date: "2026-09-10" });
  assert.equal(e.starts_at, "2026-09-07T12:00:00.000Z");
  const values = page(e, "2026-09-09T00:00Z", "2026-09-10T00:00Z", { timezone: "UTC" }).occurrences;
  assert.equal(values.length, 1);
  assert.equal(values[0].end_date, "2026-09-10");
  assert.equal(page(e, "2026-09-10T00:00Z", "2026-09-11T00:00Z").occurrences.length, 0);
  assert.equal(page(e, "2026-09-07T12:00Z", "2026-09-08T00:00Z", { timezone: "Pacific/Auckland" }).occurrences.length, 1);
});
test("daily local recurrence skips DST gaps without consuming COUNT and resolves overlap earlier", () => {
  const gap = timed({ starts_at: "2026-03-07T07:30Z", ends_at: "2026-03-07T08:30Z", timezone: "America/New_York", recurrence: { frequency: "daily", count: 3 } });
  assert.deepEqual(page(gap, "2026-03-06T00:00Z", "2026-03-12T00:00Z").occurrences.map((e) => e.starts_at), ["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  const overlap = timed({ starts_at: "2026-10-31T05:30Z", ends_at: "2026-10-31T06:30Z", timezone: "America/New_York", recurrence: { frequency: "daily", count: 3 } });
  assert.deepEqual(page(overlap, "2026-10-31T00:00Z", "2026-11-04T00:00Z").occurrences.map((e) => e.starts_at), ["2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  assert.throws(() => timed({ starts_at: "2026-11-01T06:30Z", ends_at: "2026-11-01T07:30Z", timezone: "America/New_York", recurrence: { frequency: "daily" } }), { code: "invalid_datetime" });
  const legacy = timed({ starts_at: "2026-11-01T06:30Z", ends_at: "2026-11-01T07:30Z", timezone: "America/New_York" });
  assert.equal(page(legacy, "2026-11-01T00:00Z", "2026-11-02T00:00Z").occurrences[0].starts_at, "2026-11-01T06:30:00.000Z");
});
test("month ends, leap years, last/ordinal weekdays skip impossible local dates", () => {
  const monthly = timed({ recurrence: { frequency: "monthly", count: 3 } });
  assert.deepEqual(page(monthly, "2026-01-01T00:00Z", "2026-06-01T00:00Z").occurrences.map((e) => e.starts_at.slice(0, 10)), ["2026-01-31", "2026-03-31", "2026-05-31"]);
  const leap = timed({ starts_at: "2024-02-29T09:00Z", ends_at: "2024-02-29T10:00Z", recurrence: { frequency: "yearly", count: 2 } });
  assert.equal(page(leap, "2028-01-01T00:00Z", "2029-01-01T00:00Z").occurrences[0].starts_at, "2028-02-29T09:00:00.000Z");
  assert.equal(page(leap, "2032-01-01T00:00Z", "2033-01-01T00:00Z").occurrences.length, 0);
  const ordinal = timed({ starts_at: "2026-01-30T09:00Z", ends_at: "2026-01-30T10:00Z", recurrence: { frequency: "monthly", ordinal_weekday: { ordinal: -1, weekday: 5 }, until_date: "2026-03-27" } });
  assert.deepEqual(page(ordinal, "2026-01-01T00:00Z", "2026-05-01T00:00Z").occurrences.map((e) => e.starts_at.slice(0, 10)), ["2026-01-30", "2026-02-27", "2026-03-27"]);
});
test("weekly intervals anchor Monday, COUNT includes valid first and weekdays remain sorted", () => {
  const e = timed({ starts_at: "2026-09-08T09:00Z", ends_at: "2026-09-08T10:00Z", recurrence: { frequency: "weekly", interval: 2, weekdays: [5, 2], count: 4 } });
  assert.deepEqual(page(e, "2026-09-01T00:00Z", "2026-10-01T00:00Z").occurrences.map((v) => v.starts_at.slice(0, 10)), ["2026-09-08", "2026-09-11", "2026-09-22", "2026-09-25"]);
});
test("far-future unbounded lookup seeks periods and never materializes instances into master", () => {
  const e = timed({ starts_at: "1900-01-01T09:00Z", ends_at: "1900-01-01T10:00Z", recurrence: { frequency: "daily" } });
  const before = JSON.stringify(e);
  assert.equal(page(e, "9000-01-01T00:00Z", "9000-01-03T00:00Z").occurrences.length, 2);
  assert.equal(JSON.stringify(e), before);
});
test("moved exceptions are included by final time and preserve stable original identity", () => {
  const e = timed({ recurrence: { frequency: "daily", count: 3 } });
  const source = page(e, "2026-01-31T00:00Z", "2026-02-01T00:00Z").occurrences[0];
  e.exceptions = { [source.occurrence_id]: { original_start: source.original_start, overrides: { starts_at: "2026-06-01T09:00:00.000Z", ends_at: "2026-06-01T10:00:00.000Z" }, reset_responses: true, responses: { agent: "accepted" } } };
  assert.equal(page(e, "2026-01-31T00:00Z", "2026-02-01T00:00Z").occurrences.length, 0);
  const moved = page(e, "2026-06-01T00:00Z", "2026-06-02T00:00Z").occurrences[0];
  assert.equal(moved.occurrence_id, source.occurrence_id);
  assert.equal(moved.original_start, "2026-01-31T09:00:00.000Z");
  assert.deepEqual(moved.responses, { agent: "accepted" });
  assert.equal(occurrenceById(e, source.occurrence_id).starts_at, moved.starts_at);
  e.exceptions[source.occurrence_id].cancelled = true;
  assert.equal(page(e, "2026-06-01T00:00Z", "2026-06-02T00:00Z").occurrences.length, 0);
  assert.equal(occurrenceById(e, source.occurrence_id).status, "cancelled");
});
test("paging is deterministic, duplicate-free and invalidated by identity/range/revisions", () => {
  const e = timed({ recurrence: { frequency: "daily", count: 5 } }), range = { from: "2026-01-31T00:00Z", to: "2026-02-08T00:00Z", limit: 2 };
  const a = occurrencesPage([e], range, "person"), b = occurrencesPage([e], { ...range, cursor: a.next_cursor }, "person"), c = occurrencesPage([e], { ...range, cursor: b.next_cursor }, "person");
  assert.deepEqual([a.occurrences.length, b.occurrences.length, c.occurrences.length], [2, 2, 1]);
  assert.equal(c.next_cursor, null);
  assert.equal(new Set([...a.occurrences, ...b.occurrences, ...c.occurrences].map((v) => v.occurrence_id)).size, 5);
  assert.throws(() => occurrencesPage([e], { ...range, cursor: a.next_cursor }, "agent"), { code: "stale_cursor" });
  e.revision++;
  assert.throws(() => occurrencesPage([e], { ...range, cursor: a.next_cursor }, "person"), { code: "stale_cursor" });
  e.recurrence_generation = 2;
  assert.throws(() => occurrenceById(e, a.occurrences[0].occurrence_id), { code: "stale_occurrence" });
});
test("strict malformed dates, zones, recurrence combinations, window bounds and forged IDs reject", () => {
  for (const extra of [ { starts_at: "2026-02-30T00:00Z" }, { timezone: "+08:00" }, { recurrence: { frequency: "daily", count: 1, until_date: "2026-02-01" } }, { recurrence: { frequency: "daily", weekdays: [1] } }, { recurrence: { frequency: "weekly", weekdays: [1] } }, { recurrence: { frequency: "monthly", month_day: 30 } }, { recurrence: { frequency: "monthly", month_day: 31, ordinal_weekday: { ordinal: -1, weekday: 6 } } } ]) assert.throws(() => timed(extra));
  assert.throws(() => page(timed(), "2026-01-01T00:00Z", "2028-01-01T00:00Z"), { code: "invalid_range" });
  const e = timed(), id = page(e, "2026-01-31T00:00Z", "2026-02-01T00:00Z").occurrences[0].occurrence_id;
  assert.throws(() => occurrenceById({ ...e, id: "another" }, id), { code: "invalid_occurrence" });
});
