"use strict";

// Calendar arithmetic and IANA/DST resolution belong to Temporal, not millisecond
// offsets. Generated occurrences are views; only masters and exceptions persist.
const { Temporal: T } = require("@js-temporal/polyfill");
const crypto = require("node:crypto");
const { problem } = require("./work-protocol");
const DAY = 86400000;
const MAX_COUNT = 10000;
const MAX_STEPS = 200000;
const clone = (v) => JSON.parse(JSON.stringify(v));
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (code, message) => { throw problem(422, code, message); };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function date(value, field = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("invalid_date", `${field} 必须为 YYYY-MM-DD`);
  try { const d = T.PlainDate.from(value, { overflow: "reject" }); if (d.year < 1) throw Error(); return d; }
  catch { fail("invalid_date", `${field} 不是有效日期`); }
}
function instant(value, field = "datetime") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) fail("invalid_datetime", `${field} 必须为带时区的 ISO 日期时间`);
  try { const i = T.Instant.from(value); date(value.slice(0, 10)); return i; }
  catch { fail("invalid_datetime", `${field} 不是有效时间`); }
}
function zone(value = "UTC") {
  if (typeof value !== "string" || value.length > 100 || !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value)) fail("invalid_timezone", "timezone 必须为 IANA 时区");
  try { return T.Instant.from("2000-01-01T00:00Z").toZonedDateTimeISO(value).timeZoneId; }
  catch { fail("invalid_timezone", "未知 IANA 时区"); }
}
function integer(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) fail("invalid_recurrence", `${field} 超出有效范围`);
  return value;
}
function localInstant(local, timezone) {
  const z = local.toZonedDateTime(timezone, { disambiguation: "earlier" });
  // 'earlier' resolves a gap to a different wall time. RFC-style recurrences
  // omit that local occurrence instead of silently changing its clock time.
  return z.toPlainDateTime().equals(local) ? z.toInstant() : null;
}
function normalizeRule(value, start) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_recurrence", "recurrence 必须为对象或 null");
  const fields = ["frequency", "interval", "weekdays", "month_day", "ordinal_weekday", "month", "count", "until_date"];
  if (Object.keys(value).some((k) => !fields.includes(k))) fail("invalid_recurrence", "未知重复规则字段");
  const frequency = value.frequency;
  if (!["daily", "weekly", "monthly", "yearly"].includes(frequency)) fail("invalid_recurrence", "不支持的重复频率");
  const rule = { frequency, interval: integer(value.interval ?? 1, 1, 999, "interval") };
  if (value.count !== undefined && value.until_date !== undefined) fail("invalid_recurrence", "count 与 until_date 不能同时设置");
  if (value.count !== undefined) rule.count = integer(value.count, 1, MAX_COUNT, "count");
  if (value.until_date !== undefined) {
    if (T.PlainDate.compare(date(value.until_date, "until_date"), start) < 0) fail("invalid_recurrence", "截止日期不能早于开始日期");
    rule.until_date = value.until_date;
  }
  if (frequency === "weekly") {
    const days = value.weekdays ?? [start.dayOfWeek];
    if (!Array.isArray(days) || !days.length || days.length > 7) fail("invalid_recurrence", "weekdays 必须包含 1–7 个星期值");
    rule.weekdays = [...new Set(days.map((d) => integer(d, 1, 7, "weekday")))].sort();
  } else if (value.weekdays !== undefined) fail("invalid_recurrence", "weekdays 仅适用于 weekly");
  if (["monthly", "yearly"].includes(frequency)) {
    if (value.month_day !== undefined && value.ordinal_weekday !== undefined) fail("invalid_recurrence", "month_day 与 ordinal_weekday 不能同时设置");
    if (value.ordinal_weekday !== undefined) {
      const o = value.ordinal_weekday;
      if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => !["ordinal", "weekday"].includes(k))) fail("invalid_recurrence", "无效 ordinal_weekday");
      rule.ordinal_weekday = { ordinal: o.ordinal === -1 ? -1 : integer(o.ordinal, 1, 5, "ordinal"), weekday: integer(o.weekday, 1, 7, "weekday") };
    } else rule.month_day = value.month_day === -1 ? -1 : integer(value.month_day ?? start.day, 1, 31, "month_day");
    if (frequency === "yearly") rule.month = integer(value.month ?? start.month, 1, 12, "month");
    else if (value.month !== undefined) fail("invalid_recurrence", "month 仅适用于 yearly");
  } else if (["month", "month_day", "ordinal_weekday"].some((k) => value[k] !== undefined)) fail("invalid_recurrence", "当前频率不支持月份规则");
  return rule;
}
function normalizeSchedule(input, current = {}) {
  const all_day = own(input, "all_day") ? input.all_day : current.all_day ?? false;
  if (typeof all_day !== "boolean") fail("invalid_input", "all_day 必须为布尔值");
  const timezone = zone(own(input, "timezone") ? input.timezone : current.timezone ?? "UTC");
  let schedule, start;
  if (all_day) {
    if (own(input, "starts_at") || own(input, "ends_at")) fail("invalid_input", "全天日程只能提交 start_date/end_date，不接受时间戳投影");
    const s = date(own(input, "start_date") ? input.start_date : current.start_date, "start_date"), e = date(own(input, "end_date") ? input.end_date : current.end_date, "end_date");
    const days = s.until(e).days;
    if (days < 1 || days > 366) fail("invalid_date", "全天区间必须为 1–366 天，end_date 为不含结束日");
    start = s;
    schedule = { all_day, timezone, start_date: s.toString(), end_date: e.toString(), starts_at: s.toZonedDateTime(timezone).toInstant().toString({ smallestUnit: "millisecond" }), ends_at: e.toZonedDateTime(timezone).toInstant().toString({ smallestUnit: "millisecond" }) };
  } else {
    if (own(input, "start_date") || own(input, "end_date")) fail("invalid_input", "定时日程只能提交 starts_at/ends_at，不接受全天日期字段");
    const s = instant(own(input, "starts_at") ? input.starts_at : current.starts_at, "starts_at"), e = instant(own(input, "ends_at") ? input.ends_at : current.ends_at, "ends_at");
    if (e.epochMilliseconds <= s.epochMilliseconds || e.epochMilliseconds - s.epochMilliseconds > 366 * DAY) fail("invalid_datetime", "结束时间须晚于开始且区间不超过 366 天");
    start = s.toZonedDateTimeISO(timezone).toPlainDate();
    schedule = { all_day, timezone, start_date: null, end_date: null, starts_at: s.toString({ smallestUnit: "millisecond" }), ends_at: e.toString({ smallestUnit: "millisecond" }) };
  }
  schedule.recurrence = normalizeRule(own(input, "recurrence") ? input.recurrence : current.recurrence, start);
  if (schedule.recurrence) {
    const first = [...candidateDates(schedule, start, start)][0];
    if (!first || !first.equals(start)) fail("invalid_recurrence", "首个日程必须符合重复规则");
    if (!all_day) {
      const i = instant(schedule.starts_at), local = i.toZonedDateTimeISO(timezone).toPlainDateTime();
      if (!localInstant(local, timezone)?.equals(i)) fail("invalid_datetime", "重复日程的重叠本地时间必须选择较早时区偏移");
    }
  }
  return schedule;
}
function scheduleSignature(e) { return JSON.stringify([e.all_day ?? false, e.timezone ?? "UTC", e.starts_at, e.ends_at, e.start_date ?? null, e.end_date ?? null, e.recurrence ?? null]); }
function baseDate(e) { return e.all_day ? date(e.start_date) : instant(e.starts_at).toZonedDateTimeISO(e.timezone || "UTC").toPlainDate(); }
function inMonth(year, month, rule) {
  const first = T.PlainDate.from({ year, month, day: 1 });
  let day;
  if (rule.ordinal_weekday) {
    const { ordinal, weekday } = rule.ordinal_weekday;
    day = ordinal === -1 ? first.daysInMonth - ((first.with({ day: first.daysInMonth }).dayOfWeek - weekday + 7) % 7) : 1 + ((weekday - first.dayOfWeek + 7) % 7) + (ordinal - 1) * 7;
  } else day = rule.month_day === -1 ? first.daysInMonth : rule.month_day;
  return day <= first.daysInMonth ? first.with({ day }, { overflow: "reject" }) : null;
}
// Generate local dates by recurrence periods. Without COUNT, seek directly to
// the requested window; with COUNT, cap work and count only real local instants.
function* candidateDates(e, lower, upper) {
  const start = baseDate(e), r = e.recurrence;
  if (!r) { if (T.PlainDate.compare(start, lower) >= 0 && T.PlainDate.compare(start, upper) <= 0) yield start; return; }
  const anchor = r.frequency === "weekly" ? start.subtract({ days: start.dayOfWeek - 1 }) : start;
  let n = 0;
  if (!r.count) {
    const distance = r.frequency === "daily" ? anchor.until(lower).days : r.frequency === "weekly" ? Math.floor(anchor.until(lower).days / 7) : r.frequency === "monthly" ? (lower.year - anchor.year) * 12 + lower.month - anchor.month : lower.year - anchor.year;
    n = Math.max(0, Math.floor(distance / r.interval) - 1);
  }
  let emitted = 0, steps = 0;
  const localTime = !e.all_day ? instant(e.starts_at).toZonedDateTimeISO(e.timezone || "UTC").toPlainTime() : null;
  for (;; n++) {
    if (++steps > MAX_STEPS) fail("recurrence_expansion_limit", "重复规则展开超出单次计算上限");
    let period, dates;
    try {
      if (r.frequency === "daily") { period = anchor.add({ days: n * r.interval }); dates = [period]; }
      else if (r.frequency === "weekly") { period = anchor.add({ weeks: n * r.interval }); dates = r.weekdays.map((d) => period.add({ days: d - 1 })); }
      else if (r.frequency === "monthly") { period = anchor.with({ day: 1 }).add({ months: n * r.interval }); dates = [inMonth(period.year, period.month, r)]; }
      else { period = T.PlainDate.from({ year: anchor.year + n * r.interval, month: r.month, day: 1 }); dates = [inMonth(period.year, r.month, r)]; }
    } catch { return; }
    if (period.year > 9999 || T.PlainDate.compare(period, upper) > 0) return;
    for (const d of dates) {
      if (!d || T.PlainDate.compare(d, start) < 0) continue;
      if (r.until_date && T.PlainDate.compare(d, date(r.until_date)) > 0) return;
      if (localTime && !localInstant(d.toPlainDateTime(localTime), e.timezone || "UTC")) continue;
      if (++emitted > (r.count || Infinity)) return;
      if (T.PlainDate.compare(d, upper) > 0) return;
      if (T.PlainDate.compare(d, lower) >= 0) yield d;
    }
  }
}
function occurrenceId(e, original) {
  const generation = e.recurrence_generation || 1;
  return `occ-${generation}-${Buffer.from(original).toString("base64url")}-${hash([e.id, generation, original]).slice(0, 16)}`;
}
function baseOccurrence(e, d) {
  const timezone = e.timezone || "UTC";
  let fields, original;
  if (e.all_day) {
    const end = d.add({ days: date(e.start_date).until(date(e.end_date)).days });
    original = d.toString();
    fields = { start_date: original, end_date: end.toString(), starts_at: d.toZonedDateTime(timezone).toInstant().toString({ smallestUnit: "millisecond" }), ends_at: end.toZonedDateTime(timezone).toInstant().toString({ smallestUnit: "millisecond" }) };
  } else {
    const s = instant(e.starts_at), local = d.toPlainDateTime(s.toZonedDateTimeISO(timezone).toPlainTime()), generated = e.recurrence ? localInstant(local, timezone) : s;
    if (!generated) return null;
    original = generated.toString({ smallestUnit: "millisecond" });
    fields = { starts_at: original, ends_at: new Date(generated.epochMilliseconds + Date.parse(e.ends_at) - s.epochMilliseconds).toISOString(), start_date: null, end_date: null };
  }
  const { exceptions, exception_archives, ...master } = e;
  return { ...clone(master), ...fields, all_day: e.all_day || false, timezone, event_id: e.id, occurrence_id: occurrenceId(e, original), original_start: original, base_revision: e.revision, recurrence_generation: e.recurrence_generation || 1, exception_count: Object.keys(exceptions || {}).length, is_exception: false };
}
function effective(e, base) {
  const x = e.exceptions?.[base.occurrence_id];
  if (!x) return base;
  const value = { ...base, ...clone(x.overrides || {}), status: x.cancelled ? "cancelled" : base.status, is_exception: true };
  const defaults = x.reset_responses ? {} : base.responses || {};
  value.responses = Object.fromEntries(Object.entries({ ...defaults, ...(x.responses || {}) }).filter(([id]) => value.attendee_ids.includes(id)));
  return value;
}
function occurrenceById(e, id) {
  if (typeof id !== "string" || id.length > 256) fail("invalid_occurrence", "请提供服务端 occurrence_id");
  const match = /^occ-(\d+)-([A-Za-z0-9_-]+)-([a-f0-9]{16})$/.exec(id);
  if (!match || Number(match[1]) !== (e.recurrence_generation || 1)) throw problem(409, "stale_occurrence", "日程系列已改变，请重新读取实例");
  const original = Buffer.from(match[2], "base64url").toString("utf8");
  if (occurrenceId(e, original) !== id) fail("invalid_occurrence", "实例不属于该日程");
  const target = e.all_day ? date(original) : instant(original).toZonedDateTimeISO(e.timezone || "UTC").toPlainDate();
  for (const d of candidateDates(e, target, target)) {
    const base = baseOccurrence(e, d);
    if (base?.occurrence_id === id) return effective(e, base);
  }
  throw problem(404, "occurrence_not_found", "该实例不存在于重复规则中");
}
function normalizeRange(input) {
  const from = instant(input.from, "from").toString({ smallestUnit: "millisecond" }), to = instant(input.to, "to").toString({ smallestUnit: "millisecond" });
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * DAY) fail("invalid_range", "查询窗口必须为大于零且最多 366 天");
  const timezone = zone(input.timezone ?? "UTC");
  const limit = input.limit === undefined || input.limit === null ? 200 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("invalid_range", "limit 必须为 1–500");
  return { from, to, timezone, limit };
}
function bounds(e, timezone) {
  return e.all_day ? [date(e.start_date).toZonedDateTime(timezone).epochMilliseconds, date(e.end_date).toZonedDateTime(timezone).epochMilliseconds] : [Date.parse(e.starts_at), Date.parse(e.ends_at)];
}
function* eventOccurrences(e, range) {
  if (e.status === "cancelled") return;
  const lo = Date.parse(range.from), hi = Date.parse(range.to), timezone = e.all_day ? range.timezone : e.timezone || "UTC";
  const durationDays = e.all_day ? date(e.start_date).until(date(e.end_date)).days : Math.ceil((Date.parse(e.ends_at) - Date.parse(e.starts_at)) / DAY) + 2;
  const lower = instant(range.from).toZonedDateTimeISO(timezone).toPlainDate().subtract({ days: durationDays }), upper = instant(range.to).toZonedDateTimeISO(timezone).toPlainDate().add({ days: 1 });
  const visible = (value) => { const [s, end] = bounds(value, range.timezone); return value.status !== "cancelled" && s < hi && end > lo; };
  const moved = Object.keys(e.exceptions || {}).map((id) => occurrenceById(e, id)).filter(visible).sort((a, b) => compareKeys(key(a, range), key(b, range)));
  let index = 0;
  for (const d of candidateDates(e, lower, upper)) {
    const base = baseOccurrence(e, d);
    if (!base || e.exceptions?.[base.occurrence_id] || !visible(base)) continue;
    while (index < moved.length && compareKeys(key(moved[index], range), key(base, range)) <= 0) yield moved[index++];
    yield base;
  }
  while (index < moved.length) yield moved[index++];
}
function key(e, range) { return [bounds(e, range.timezone)[0], e.event_id, e.occurrence_id]; }
function compareKeys(a, b) { return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]); }
function occurrencesPage(events, input, identity = "", accept = () => true) {
  const range = normalizeRange(input), fingerprint = hash([identity, range, events.map((e) => [e.id, e.revision]).sort()]);
  let after;
  if (input.cursor) {
    if (typeof input.cursor !== "string" || input.cursor.length > 2048) fail("invalid_cursor", "无效日历分页游标");
    let cursor;
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { fail("invalid_cursor", "无效日历分页游标"); }
    if (cursor.fingerprint !== fingerprint) throw problem(409, "stale_cursor", "日历或身份已变化，请重新读取第一页");
    if (!Array.isArray(cursor.after) || cursor.after.length !== 3 || !Number.isFinite(cursor.after[0]) || cursor.after.slice(1).some((s) => typeof s !== "string")) fail("invalid_cursor", "无效日历分页游标");
    after = cursor.after;
  }
  const iterators = events.map((e) => eventOccurrences(e, range));
  const next = (iterator) => { let value; do { value = iterator.next(); } while (!value.done && (!accept(value.value) || (after && compareKeys(key(value.value, range), after) <= 0))); return value.done ? null : { iterator, value: value.value }; };
  const heads = iterators.map(next).filter(Boolean), occurrences = [];
  while (heads.length && occurrences.length <= range.limit) {
    let selected = 0;
    for (let i = 1; i < heads.length; i++) if (compareKeys(key(heads[i].value, range), key(heads[selected].value, range)) < 0) selected = i;
    const head = heads[selected]; occurrences.push(head.value);
    const value = next(head.iterator); if (value) heads[selected] = value; else heads.splice(selected, 1);
  }
  const truncated = occurrences.length > range.limit;
  if (truncated) occurrences.pop();
  return { occurrences, truncated, next_cursor: truncated ? Buffer.from(JSON.stringify({ fingerprint, after: key(occurrences.at(-1), range) })).toString("base64url") : null, range };
}
const CALENDAR_CAPABILITIES = Object.freeze({ all_day: true, recurrence: true, frequencies: ["daily", "weekly", "monthly", "yearly"], scopes: ["series", "occurrence"], following_scope: false, date_end_exclusive: true, gap_policy: "skip", overlap_policy: "earlier", max_range_days: 366, max_page_size: 500, max_recurrence_count: MAX_COUNT, meeting_recurrence: false });
module.exports = { normalizeSchedule, scheduleSignature, occurrenceById, occurrencesPage, eventOccurrences, normalizeRange, CALENDAR_CAPABILITIES };
