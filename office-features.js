"use strict";

// Durable office scheduling uses the native IM transaction boundary. Media
// presence and WebRTC signaling are short-lived, scoped process memory only.
const crypto = require("node:crypto");
const { problem, requireText } = require("./work-protocol");
const { normalizeSchedule, scheduleSignature, occurrenceById, occurrencesPage, CALENDAR_CAPABILITIES } = require("./calendar-recurrence");
const copy = (value) => JSON.parse(JSON.stringify(value));
const owns = (object, key) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
const keyHash = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const APPS = [
  {
    id: "messages",
    name: "消息",
    description: "人和 Agent 的私聊与群聊",
    available: true,
  },
  {
    id: "agents",
    name: "Agent 同事",
    description: "专属 Agent 商店与好友",
    available: true,
  },
  {
    id: "docs",
    name: "文档",
    description: "Doc Free 共享工作资料",
    available: true,
  },
  {
    id: "tasks",
    name: "任务",
    description: "共享责任、进度和交付物",
    available: true,
  },
  {
    id: "meetings",
    name: "视频会议",
    description: "房间内最多六个实时媒体会话",
    available: true,
  },
  {
    id: "minutes",
    name: "人机妙记",
    description: "共享逐字稿、录音资料和纪要任务；转写服务未配置",
    available: true,
  },
  {
    id: "calendar",
    name: "日历",
    description: "团队日程与邀请回应",
    available: true,
  },
  {
    id: "approvals",
    name: "审批",
    description: "指定审批人审核申请与补卡",
    available: true,
  },
  {
    id: "attendance",
    name: "打卡",
    description: "本人考勤与有审计的补卡申请",
    available: true,
  },
  {
    id: "mail",
    name: "邮箱",
    description: "工作区内部邮件与草稿",
    available: true,
  },
  {
    id: "reports",
    name: "报表",
    description: "办公报表模块尚未实现",
    available: false,
  },
  {
    id: "enterprise",
    name: "企业管理",
    description: "按企业角色管理成员、部门与操作审计",
    available: true,
  },
].map((app) => ({ ...app, route: `/office#${app.id}` }));
const TTL = 45000;
const MAX_RECENT_APPS = 32;
function createOfficeFeatures({
  state,
  now,
  stamp,
  persist,
  serial,
  principal,
  active,
  principalView,
  roomById,
  member,
  event,
  readDocument,
  requireMeetingPolicy = () => {},
  requireWorkbenchApp = () => {},
  publishPersonalEvent = () => {},
}) {
  state.office ||= {
    meetings: [],
    calendar: [],
    workbench_preferences: {},
    meeting_keys: {},
    calendar_keys: {},
  };
  const office = state.office;
  if (
    !Array.isArray(office.meetings) ||
    !Array.isArray(office.calendar) ||
    !office.workbench_preferences ||
    !office.meeting_keys ||
    !office.calendar_keys
  )
    throw new Error(
      "Native office state is corrupt; refusing to initialize empty scheduling data",
    );
  for (const preference of Object.values(office.workbench_preferences)) {
    if (
      !preference ||
      typeof preference !== "object" ||
      Array.isArray(preference) ||
      (preference.recents !== undefined &&
        (!Array.isArray(preference.recents) ||
          preference.recents.length > MAX_RECENT_APPS ||
          preference.recents.some((id) => typeof id !== "string") ||
          new Set(preference.recents).size !== preference.recents.length))
    )
      throw new Error("Native workbench preferences are corrupt; refusing to reset personal history");
  }
  function workbenchAppAvailable(app, p) {
    if (!app.available) return false;
    try {
      requireWorkbenchApp(app.id, p);
      return true;
    } catch (error) {
      if (error.code === "app_policy_denied") return false;
      throw error;
    }
  }
  function workbenchView(p) {
    const preference = office.workbench_preferences[p.id] || {};
    const apps = APPS.map((app) => ({
      ...copy(app),
      available: workbenchAppAvailable(app, p),
    }));
    const available = new Set(apps.filter((app) => app.available).map((app) => app.id));
    return {
      apps,
      favorites: copy(preference.favorites || ["messages", "agents", "docs", "tasks"]),
      recents: (preference.recents || []).filter((id) => available.has(id)),
    };
  }
  function authorizeWorkbenchReceipt(receipt, p) {
    const ids = new Set([
      ...(receipt?.recents || []),
      ...(receipt?.apps || []).filter((app) => app.available === true).map((app) => app.id),
    ]);
    for (const id of ids) {
      const app = APPS.find((entry) => entry.id === id);
      if (!app?.available)
        throw problem(403, "receipt_scope_revoked", "旧工作台回执包含当前不可用应用，请重新读取");
      requireWorkbenchApp(app.id, p);
    }
  }
  const media = new Map();
  const expires = (session) => session.last_seen + TTL;
  function runtime(meetingId) {
    if (!media.has(meetingId)) {
      for (const [mid, rt] of media)
        if (
          ![...rt.sessions.values()].some(
            (session) => expires(session) > now(),
          ) &&
          rt.waiters.size === 0
        )
          media.delete(mid);
      if (media.size >= 50)
        throw problem(409, "media_capacity", "本地活跃会议数量已达上限");
      media.set(meetingId, {
        sequence: 0,
        sessions: new Map(),
        signals: [],
        waiters: new Set(),
      });
    }
    return media.get(meetingId);
  }
  function meetingById(mid) {
    const meeting = office.meetings.find((item) => item.id === mid);
    if (!meeting) throw problem(404, "not_found", "会议不存在");
    return meeting;
  }
  function authorizeMeeting(mid, p) {
    const meeting = meetingById(mid),
      room = roomById(meeting.room_id);
    member(room, p);
    return { meeting, room };
  }
  function personCurrent(pid, room) {
    try {
      const p = active(pid);
      requireMeetingPolicy(p);
      return owns(room.members, pid) ? p : null;
    } catch {
      return null;
    }
  }
  function sweep(meeting) {
    const rt = media.get(meeting.id) || {
        sequence: 0,
        sessions: new Map(),
        signals: [],
        waiters: new Set(),
      },
      room = roomById(meeting.room_id);
    let changed = false;
    for (const [sid, session] of rt.sessions)
      if (
        meeting.status === "ended" ||
        expires(session) <= now() ||
        !personCurrent(session.principal_id, room)
      ) {
        rt.sessions.delete(sid);
        changed = true;
      }
    if (changed) {
      rt.signals = rt.signals.filter(
        (signal) => rt.sessions.has(signal.to) && rt.sessions.has(signal.from),
      );
      for (const wake of rt.waiters) wake();
    }
    return rt;
  }
  function participants(meeting) {
    const rt = sweep(meeting);
    return [...rt.sessions.values()].map((session) => {
      const p = active(session.principal_id);
      return {
        ...session,
        name: p.name,
        kind: p.kind,
        expires_at: expires(session),
      };
    });
  }
  function ownSession(meeting, p, sessionId) {
    const rt = sweep(meeting),
      session = rt.sessions.get(sessionId);
    if (meeting.status === "ended")
      throw problem(409, "meeting_ended", "会议已结束");
    if (!session || session.principal_id !== p.id)
      throw problem(409, "session_expired", "媒体会话已失效，请重新加入");
    return { rt, session };
  }
  function boundedInteger(value, fallback, min, max) {
    const n = value === undefined || value === null ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw problem(422, "invalid_input", "无效数值");
    return n;
  }
  function iso(value, field) {
    requireText(value, field, 80);
    if (
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw problem(
        422,
        "invalid_datetime",
        `${field} 必须为带时区的 ISO 日期时间`,
      );
    return new Date(value).toISOString();
  }
  function attendees(room, value, fallback, validateMembership = true) {
    const list = value === undefined ? fallback : value;
    if (
      !Array.isArray(list) ||
      list.length > 100 ||
      list.some((pid) =>
        typeof pid !== "string" || !pid.length || pid.length > 100 ||
        (validateMembership && !owns(room.members, pid)))
    )
      throw problem(422, "invalid_attendees", "日程参与者必须是当前会话成员");
    return [...new Set(list)].sort();
  }
  function calendarInput(room, p, input, current, validateMembership = true) {
    const title = requireText(input.title ?? current?.title, "title", 200);
    const schedule = normalizeSchedule(input, current);
    const description = input.description ?? current?.description ?? "",
      location = input.location ?? current?.location ?? "";
    if (
      typeof description !== "string" ||
      description.length > 8000 ||
      typeof location !== "string" ||
      location.length > 300
    )
      throw problem(422, "invalid_input", "日程说明或地点超出限制");
    return {
      title,
      ...schedule,
      description,
      location,
      attendee_ids: attendees(
        room,
        input.attendee_ids,
        current?.attendee_ids || [p.id],
        validateMembership,
      ),
    };
  }
  function eventById(eid, p) {
    const item = office.calendar.find((entry) => entry.id === eid);
    if (!item) throw problem(404, "not_found", "日程不存在");
    const room = roomById(item.room_id);
    member(room, p);
    return { item, room };
  }
  async function notesReference(room, p, documentId) {
    if (documentId === null || documentId === undefined) return null;
    if (!room.document_ids.includes(documentId))
      throw problem(403, "document_scope", "会议纪要文档必须共享到当前会话");
    const document = await readDocument(documentId, p.id);
    return {
      id: document.id,
      title: document.title,
      revision: document.revision,
      content_hash: document.content_hash,
    };
  }
  function createCalendar(room, p, payload, meetingId = null, cause = {}) {
    if (office.calendar.length >= 5000)
      throw problem(409, "limit_reached", "本地日程数量已达上限");
    const item = {
      id: uid("calendar"),
      room_id: room.id,
      ...payload,
      created_by: p.id,
      created_at: stamp(),
      updated_at: stamp(),
      revision: 1,
      responses: {},
      recurrence_generation: 1,
      exceptions: {},
      status: "scheduled",
      ...(meetingId ? { meeting_id: meetingId } : {}),
    };
    office.calendar.push(item);
    event(room, "calendar.created", p.id, { event_id: item.id, event: copy(item), ...cause });
    return item;
  }
  // Shared mutation reducer: caller owns the single persistence boundary.
  // Receipts are scoped to the current principal/room and checked only after
  // current membership/role/invitation authorization, before CAS.
  function reduceCalendar(operation, room, p, input, cause = {}) {
    member(room, p);
    if (operation === "create") {
      const clientId = requireText(input.client_id, "client_id", 160);
      const key = `${room.id}:${p.id}:${clientId}`, previous = office.calendar_keys[key];
      // Current actor membership was checked above. For a committed creation,
      // normalize the original intent without requiring other historical
      // attendees to remain members; the complete digest must still match.
      // A new intent always validates every current attendee before any write.
      const payload = calendarInput(room, p, input, undefined, !previous), digest = keyHash(payload);
      if (previous) {
        const legacy = { ...payload };
        for (const field of ["all_day", "timezone", "start_date", "end_date", "recurrence"]) delete legacy[field];
        if (previous.hash !== digest && !(previous.protocol === undefined && !payload.all_day && !payload.recurrence && previous.hash === keyHash(legacy)))
          throw problem(409, "idempotency_conflict", "相同 client_id 对应不同日程");
        return copy(previous.result || office.calendar.find((item) => item.id === previous.id));
      }
      const item = createCalendar(room, p, payload, null, cause);
      office.calendar_keys[key] = { id: item.id, hash: digest, protocol: 2, result: copy(item) };
      return item;
    }
    const found = eventById(input.event_id, p), item = found.item;
    if (found.room.id !== room.id) throw problem(403, "calendar_scope", "日程不属于当前会话");
    const suppliedClientId = input.client_id === undefined ? null : requireText(input.client_id, "client_id", 160);
    const key = suppliedClientId ? `mutation:${room.id}:${p.id}:${item.id}:${suppliedClientId}` : null;
    const previous = key && office.calendar_keys[key];
    const scope = input.scope ?? previous?.scope ?? (item.recurrence ? undefined : "series");
    if (!["series", "occurrence"].includes(scope)) throw problem(422, "scope_required", "请指定 series 或 occurrence 作用域");
    if (scope === "series" && input.occurrence_id !== undefined) throw problem(422, "invalid_occurrence", "系列操作不能携带 occurrence_id");
    let target = item;
    if (scope === "occurrence") {
      try { target = occurrenceById(item, input.occurrence_id); }
      catch (error) {
        // A committed receipt still describes a valid old generation. Managers
        // retain their receipt; RSVP retries require the current series invite
        // when that old instance no longer exists. A receipt never grants access.
        if (!previous || !["stale_occurrence", "occurrence_not_found"].includes(error.code)) throw error;
      }
    }
    if (["update", "cancel"].includes(operation)) {
      if (item.created_by !== p.id && room.members[p.id].role !== "owner") throw problem(403, "creator_required", "只有创建者或会话所有者能修改日程");
    } else if (operation === "respond") {
      if (!target.attendee_ids.includes(p.id)) throw problem(403, "not_invited", "只有受邀成员可以回应");
      if (!["accepted", "declined", "tentative"].includes(input.response)) throw problem(422, "invalid_response", "无效日程回应");
    } else throw problem(422, "invalid_action", "无效日程动作");
    if (!suppliedClientId && (item.recurrence || scope === "occurrence" || operation === "cancel")) throw problem(422, "invalid_input", "请提供 client_id");
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value;
    const digest = keyHash(canonical({ operation, ...input, scope }));
    if (previous) {
      if (previous.hash !== digest) throw problem(409, "idempotency_conflict", "相同 client_id 对应不同日程操作");
      return copy(previous.result);
    }
    const versionRequired = operation !== "respond" || !!item.recurrence || scope === "occurrence";
    if (versionRequired && !Number.isInteger(input.base_revision)) throw problem(422, "version_required", "请提供 base_revision");
    if (input.base_revision !== undefined && input.base_revision !== item.revision) throw problem(409, "conflict", "日程版本已变化");
    if (item.status === "cancelled" || target.status === "cancelled") throw problem(409, "event_cancelled", "已取消日程不能继续修改或回应");
    if (item.meeting_id && (operation === "cancel" || scope === "occurrence" || input.all_day === true || input.recurrence)) throw problem(422, "meeting_schedule_mode_unsupported", "关联视频会议暂不支持全天、重复或单次取消，请使用会议结束操作");
    const recipients = scope === "occurrence" ? new Set(target.attendee_ids) : new Set([...item.attendee_ids, ...Object.values(item.exceptions || {}).flatMap((exception) => exception.overrides?.attendee_ids || [])]);
    if (scope === "occurrence") {
      if (input.recurrence !== undefined || input.reset_exceptions !== undefined) throw problem(422, "invalid_recurrence", "单次操作不能修改系列规则");
      if (!owns(item.exceptions || {}, input.occurrence_id) && Object.keys(item.exceptions || {}).length >= 1000) throw problem(409, "limit_reached", "单个日程系列最多保留 1000 个例外");
      const exception = copy(item.exceptions?.[input.occurrence_id] || { original_start: target.original_start, overrides: {}, responses: {} });
      if (operation === "cancel") exception.cancelled = true;
      else if (operation === "respond") exception.responses[p.id] = input.response;
      else {
        const payload = calendarInput(room, p, { ...input, recurrence: null }, target);
        const before = { ...target, recurrence: null };
        const rescheduled = scheduleSignature(payload) !== scheduleSignature(before);
        for (const field of ["title", "description", "location", "attendee_ids"]) if (input[field] !== undefined) exception.overrides[field] = payload[field];
        if (rescheduled) {
          for (const field of ["all_day", "timezone", "start_date", "end_date", "starts_at", "ends_at"]) exception.overrides[field] = payload[field];
          exception.responses = {};
          exception.reset_responses = true;
        }
        exception.responses = Object.fromEntries(Object.entries(exception.responses).filter(([pid]) => payload.attendee_ids.includes(pid)));
      }
      exception.updated_at = stamp(); exception.updated_by = p.id;
      item.exceptions ||= {};
      item.exceptions[input.occurrence_id] = exception;
    } else if (operation === "cancel") {
      item.status = "cancelled"; item.cancelled_at = stamp(); item.cancelled_by = p.id;
    } else if (operation === "respond") item.responses[p.id] = input.response;
    else {
      const payload = calendarInput(room, p, input, item), rescheduled = scheduleSignature(item) !== scheduleSignature(payload);
      const existing = Object.keys(item.exceptions || {}).length;
      if (rescheduled && existing && input.reset_exceptions !== true) throw problem(409, "exceptions_reset_required", "改动系列时间或规则须明确 reset_exceptions=true，以免错误重映射单次例外");
      if (input.reset_exceptions !== undefined && typeof input.reset_exceptions !== "boolean") throw problem(422, "invalid_input", "reset_exceptions 必须为布尔值");
      if (rescheduled && existing && (item.exception_archives || []).length >= 20) throw problem(409, "limit_reached", "例外归档已达上限，请新建系列以保留完整历史");
      if (item.meeting_id) {
        const meeting = meetingById(item.meeting_id), minutes = (Date.parse(payload.ends_at) - Date.parse(payload.starts_at)) / 60000;
        if (meeting.status === "ended") throw problem(409, "meeting_ended", "已结束会议不能改期");
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) throw problem(422, "invalid_duration", "会议长度必须为 1–480 分钟");
        meeting.title = payload.title; meeting.starts_at = payload.starts_at; meeting.duration_minutes = minutes; meeting.revision += 1;
      }
      if (rescheduled) {
        if (existing) { item.exception_archives ||= []; item.exception_archives.push({ generation: item.recurrence_generation || 1, archived_at: stamp(), archived_by: p.id, exceptions: copy(item.exceptions) }); }
        item.exceptions = {}; item.recurrence_generation = (item.recurrence_generation || 1) + 1;
      }
      Object.assign(item, payload);
      item.responses = rescheduled ? {} : Object.fromEntries(Object.entries(item.responses).filter(([pid]) => item.attendee_ids.includes(pid)));
    }
    item.revision += 1; item.updated_at = stamp();
    const effectiveEvent = scope === "occurrence" ? occurrenceById(item, input.occurrence_id) : item;
    for (const pid of effectiveEvent.attendee_ids) recipients.add(pid);
    event(room, `calendar.${operation === "update" ? "updated" : operation === "cancel" ? "cancelled" : "responded"}`, p.id, { event_id: item.id, scope, recipient_ids: [...recipients].filter((pid) => owns(room.members, pid)).sort(), ...(scope === "occurrence" ? { occurrence_id: input.occurrence_id } : {}), ...(operation === "respond" ? { response: input.response } : {}), event: copy(effectiveEvent), ...cause });
    if (key) office.calendar_keys[key] = { id: item.id, hash: digest, scope, protocol: 2, result: copy(item) };
    return item;
  }
  function signalPage(meetingId, p, sessionId, after) {
    requireMeetingPolicy(p);
    const { meeting } = authorizeMeeting(meetingId, p),
      rt = sweep(meeting);
    const session = rt.sessions.get(sessionId);
    if (!session || session.principal_id !== p.id || meeting.status === "ended")
      return {
        signals: [],
        cursor: 0,
        participants: participants(meeting),
        reset_required: true,
      };
    const oldest = rt.signals.at(0)?.seq || rt.sequence + 1,
      effectiveAfter = Math.max(after, session.joined_sequence);
    const reset_required =
      after > rt.sequence || (effectiveAfter < oldest - 1 && rt.sequence > 0);
    const signals = rt.signals
      .filter(
        (signal) => signal.seq > effectiveAfter && signal.to === sessionId,
      )
      .slice(0, 100);
    return {
      signals: copy(signals),
      cursor: signals.length === 100 ? signals.at(-1).seq : rt.sequence,
      participants: participants(meeting),
      reset_required,
    };
  }
  async function poll(mid, credential, params, signal) {
    const sid = requireText(params.get("session_id"), "session_id", 100);
    const after = boundedInteger(
        params.get("after"),
        0,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      wait = boundedInteger(params.get("wait"), 0, 0, 25);
    let result = await serial(() =>
      signalPage(mid, principal(credential), sid, after),
    );
    if (
      !result.signals.length &&
      !result.reset_required &&
      wait > 0 &&
      !signal?.aborted
    ) {
      const rt = runtime(mid);
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          rt.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(
            wait * 1000,
            Math.max(
              1,
              expires(rt.sessions.get(sid) || { last_seen: 0 }) - now(),
            ),
          ),
        );
        rt.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
        if (rt.sequence > result.cursor || !rt.sessions.has(sid)) done();
      });
      result = await serial(() =>
        signalPage(mid, principal(credential), sid, after),
      );
    }
    return result;
  }
  async function handle(method, pathname, input, p, params) {
    if (pathname === "/api/im/workbench") {
      if (method === "GET") return workbenchView(p);
      if (method === "PATCH") {
        if (
          !Array.isArray(input.favorites) ||
          input.favorites.length > APPS.length ||
          input.favorites.some(
            (value) => !APPS.some((app) => app.id === value && app.available),
          )
        )
          throw problem(
            422,
            "invalid_favorites",
            "只能收藏当前已实现的内部应用",
          );
        const favorites = [...new Set(input.favorites)];
        office.workbench_preferences[p.id] = {
          ...office.workbench_preferences[p.id],
          favorites,
        };
        persist();
        return workbenchView(p);
      }
    }
    if (pathname === "/api/im/workbench/recents") {
      if (method === "POST") {
        const appId = requireText(input.app_id, "app_id", 80);
        const app = APPS.find((entry) => entry.id === appId);
        if (!app) throw problem(404, "app_not_found", "工作台应用不存在");
        if (!app.available)
          throw problem(422, "app_unavailable", "此应用尚未实现，不能记录为最近使用");
        requireWorkbenchApp(app.id, p);
        const preference = office.workbench_preferences[p.id] || {};
        office.workbench_preferences[p.id] = {
          ...preference,
          recents: [app.id, ...(preference.recents || []).filter((id) => id !== app.id)]
            .slice(0, MAX_RECENT_APPS),
        };
        publishPersonalEvent("application.recents.updated", p.id, { app_id: app.id }, [p.id]);
        persist();
        return workbenchView(p);
      }
      if (method === "DELETE") {
        office.workbench_preferences[p.id] = {
          ...office.workbench_preferences[p.id],
          recents: [],
        };
        publishPersonalEvent("application.recents.cleared", p.id, {}, [p.id]);
        persist();
        return workbenchView(p);
      }
    }
    if (pathname === "/api/im/meetings" && method === "GET") {
      const meetings = office.meetings
        .filter((meeting) => {
          try {
            member(roomById(meeting.room_id), p);
            return true;
          } catch {
            return false;
          }
        })
        .slice(-200)
        .reverse();
      return {
        meetings: meetings.map((meeting) => ({
          ...copy(meeting),
          participant_count: participants(meeting).length,
        })),
      };
    }
    if (pathname === "/api/im/calendar/occurrences" && method === "GET") {
      const visible = office.calendar.filter((item) => { try { member(roomById(item.room_id), p); return true; } catch { return false; } });
      return occurrencesPage(visible, Object.fromEntries(params), p.id);
    }
    if (pathname === "/api/im/calendar" && method === "GET") {
      const query = params.has("q")
        ? requireText(params.get("q"), "q", 100).toLocaleLowerCase()
        : "";
      return {
        events: office.calendar
          .filter((item) => {
            try {
              member(roomById(item.room_id), p);
              return (
                !query ||
                `${item.title}\n${item.description || ""}\n${item.location || ""}`
                  .toLocaleLowerCase()
                  .includes(query)
              );
            } catch {
              return false;
            }
          })
          .slice(-500)
          .map(copy),
      };
    }
    const roomRoute = pathname.match(
      /^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/(meetings|calendar)$/,
    );
    if (roomRoute && method === "POST") {
      const room = roomById(roomRoute[1]);
      member(room, p);
      const clientId = requireText(input.client_id, "client_id", 160),
        key = `${room.id}:${p.id}:${clientId}`;
      if (roomRoute[2] === "calendar") {
        const duplicate = !!office.calendar_keys[key];
        const item = reduceCalendar("create", room, p, input);
        if (!duplicate) persist();
        return { event: copy(item), duplicate };
      }
      const payload = {
        title: requireText(input.title, "title", 200),
        starts_at:
          input.starts_at === undefined
            ? null
            : iso(input.starts_at, "starts_at"),
        duration_minutes: boundedInteger(input.duration_minutes, 30, 1, 480),
        document_id: input.document_id || null,
      };
      const digest = keyHash(payload),
        previous = office.meeting_keys[key];
      if (previous) {
        if (previous.hash !== digest)
          throw problem(
            409,
            "idempotency_conflict",
            "相同 client_id 对应不同会议",
          );
        return { meeting: copy(meetingById(previous.id)), duplicate: true };
      }
      if (office.meetings.length >= 2000 || office.calendar.length >= 5000)
        throw problem(409, "limit_reached", "本地会议或日程数量已达上限");
      const notes = await notesReference(room, p, payload.document_id);
      const startsAt = payload.starts_at || stamp();
      let endsAt;
      try {
        endsAt = new Date(
          Date.parse(startsAt) + payload.duration_minutes * 60000,
        ).toISOString();
      } catch {
        throw problem(422, "invalid_datetime", "会议结束时间超出可表示范围");
      }
      const meeting = {
        id: uid("meeting"),
        room_id: room.id,
        ...payload,
        starts_at: startsAt,
        notes_document: notes,
        created_by: p.id,
        created_at: stamp(),
        status:
          payload.starts_at && Date.parse(payload.starts_at) > now()
            ? "scheduled"
            : "active",
        revision: 1,
        ended_at: null,
      };
      office.meetings.push(meeting);
      office.meeting_keys[key] = { id: meeting.id, hash: digest };
      const item = createCalendar(
        room,
        p,
        {
          title: meeting.title,
          starts_at: meeting.starts_at,
          ends_at: endsAt,
          description: "会话视频会议",
          location: "原生视频会议",
          attendee_ids: Object.keys(room.members).sort(),
        },
        meeting.id,
      );
      meeting.calendar_event_id = item.id;
      event(room, "meeting.created", p.id, { meeting_id: meeting.id });
      persist();
      return { meeting: copy(meeting), duplicate: false };
    }
    const calendarRoute = pathname.match(
      /^\/api\/im\/calendar\/(calendar-[a-f0-9-]+)(?:\/(respond))?$/,
    );
    if (calendarRoute) {
      const { item, room } = eventById(calendarRoute[1], p);
      if (!calendarRoute[2] && method === "GET") {
        const occurrenceId = params.get("occurrence_id");
        return occurrenceId ? { event: occurrenceById(item, occurrenceId), series: copy(item) } : { event: copy(item) };
      }
      const operation = !calendarRoute[2] && method === "PATCH" ? "update" : !calendarRoute[2] && method === "DELETE" ? "cancel" : calendarRoute[2] === "respond" && method === "POST" ? "respond" : null;
      if (operation) {
        const revision = item.revision;
        const result = reduceCalendar(operation, room, p, { ...input, event_id: item.id });
        if (item.revision !== revision) persist();
        return input.scope === "occurrence" ? { event: occurrenceById(result, input.occurrence_id), series: copy(result) } : { event: copy(result) };
      }
    }
    const meetingRoute = pathname.match(
      /^\/api\/im\/meetings\/(meeting-[a-f0-9-]+)(?:\/(join|heartbeat|leave|end|signals))?$/,
    );
    if (meetingRoute) {
      const { meeting, room } = authorizeMeeting(meetingRoute[1], p),
        action = meetingRoute[2];
      if (!action && method === "GET")
        return {
          meeting: {
            ...copy(meeting),
            notes_document_current: await notesReference(
              room,
              p,
              meeting.document_id,
            ),
          },
          participants: participants(meeting),
        };
      if (!action && method === "PATCH") {
        if (meeting.created_by !== p.id && room.members[p.id].role !== "owner")
          throw problem(
            403,
            "creator_required",
            "只有会议创建者或会话所有者能绑定纪要",
          );
        if (!Number.isInteger(input.base_revision))
          throw problem(422, "version_required", "请提供 base_revision");
        if (input.base_revision !== meeting.revision)
          throw problem(409, "conflict", "会议版本已变化");
        if (!owns(input, "document_id"))
          throw problem(
            422,
            "invalid_input",
            "请提供 document_id，null 可解除绑定",
          );
        const notes = await notesReference(room, p, input.document_id);
        meeting.document_id = input.document_id;
        meeting.notes_document = notes;
        meeting.revision += 1;
        event(room, "meeting.notes", p.id, {
          meeting_id: meeting.id,
          document_id: input.document_id,
        });
        persist();
        return { meeting: copy(meeting) };
      }
      if (action === "join" && method === "POST") {
        if (meeting.status === "ended")
          throw problem(409, "meeting_ended", "会议已结束");
        const deviceId = requireText(input.device_id, "device_id", 100),
          rt = runtime(meeting.id);
        sweep(meeting);
        let session = [...rt.sessions.values()].find(
          (entry) =>
            entry.principal_id === p.id && entry.device_id === deviceId,
        );
        if (!session) {
          if (rt.sessions.size >= 6)
            throw problem(409, "meeting_full", "最多六个并发媒体会话");
          session = {
            session_id: uid("media"),
            principal_id: p.id,
            device_id: deviceId,
            audio: false,
            video: false,
            sharing: false,
            last_seen: now(),
            joined_sequence: rt.sequence,
          };
          rt.sessions.set(session.session_id, session);
        }
        session.last_seen = now();
        if (meeting.status === "scheduled") {
          meeting.status = "active";
          meeting.revision += 1;
          event(room, "meeting.started", p.id, { meeting_id: meeting.id });
          persist();
        }
        const joined = participants(meeting);
        for (const wake of rt.waiters) wake();
        return {
          meeting: copy(meeting),
          session_id: session.session_id,
          cursor: rt.sequence,
          participants: joined,
          peers: joined.filter(
            (entry) => entry.session_id !== session.session_id,
          ),
        };
      }
      if (action === "heartbeat" && method === "POST") {
        const { session, rt } = ownSession(meeting, p, input.session_id);
        const changed = ["audio", "video", "sharing"].some(
          (field) =>
            input[field] !== undefined && input[field] !== session[field],
        );
        for (const field of ["audio", "video", "sharing"])
          if (input[field] !== undefined && typeof input[field] !== "boolean")
            throw problem(422, "invalid_input", "媒体状态必须是布尔值");
        for (const field of ["audio", "video", "sharing"])
          if (input[field] !== undefined) session[field] = input[field];
        session.last_seen = now();
        if (changed) for (const wake of rt.waiters) wake();
        return { participants: participants(meeting) };
      }
      if (action === "leave" && method === "POST") {
        const rt = sweep(meeting),
          session = rt.sessions.get(input.session_id);
        if (session && session.principal_id !== p.id)
          throw problem(403, "session_owner", "不能退出其他参与者的媒体会话");
        if (session) {
          rt.sessions.delete(input.session_id);
          rt.signals = rt.signals.filter(
            (signal) =>
              signal.from !== input.session_id &&
              signal.to !== input.session_id,
          );
        }
        for (const wake of rt.waiters) wake();
        return { left: true, participants: participants(meeting) };
      }
      if (action === "end" && method === "POST") {
        if (meeting.created_by !== p.id && room.members[p.id].role !== "owner")
          throw problem(
            403,
            "creator_required",
            "只有会议创建者或会话所有者能结束会议",
          );
        if (meeting.status !== "ended") {
          meeting.status = "ended";
          meeting.ended_at = stamp();
          meeting.revision += 1;
          const item = office.calendar.find(
            (entry) => entry.id === meeting.calendar_event_id,
          );
          if (item) {
            item.status = "completed";
            item.revision += 1;
            item.updated_at = stamp();
          }
          event(room, "meeting.ended", p.id, { meeting_id: meeting.id });
          persist();
        }
        sweep(meeting);
        return { meeting: copy(meeting), participants: [] };
      }
      if (action === "signals" && method === "POST") {
        const { rt, session } = ownSession(meeting, p, input.session_id),
          recipient = rt.sessions.get(input.to);
        if (!recipient || recipient.session_id === session.session_id)
          throw problem(
            422,
            "invalid_recipient",
            "信令接收方必须是同一会议的另一活跃会话",
          );
        if (
          !["offer", "answer", "candidate"].includes(input.kind) ||
          !input.payload ||
          typeof input.payload !== "object" ||
          Array.isArray(input.payload)
        )
          throw problem(422, "invalid_signal", "无效信令类型或负载");
        if (Buffer.byteLength(JSON.stringify(input.payload), "utf8") > 65536)
          throw problem(413, "too_large", "信令负载超过 64 KiB");
        const signal = {
          seq: ++rt.sequence,
          from: session.session_id,
          to: recipient.session_id,
          kind: input.kind,
          payload: copy(input.payload),
          at: stamp(),
        };
        rt.signals.push(signal);
        rt.signals = rt.signals.slice(-1000);
        let bytes = rt.signals.reduce(
          (total, item) =>
            total + Buffer.byteLength(JSON.stringify(item), "utf8"),
          0,
        );
        while (bytes > 2 * 1024 * 1024 && rt.signals.length > 1)
          bytes -= Buffer.byteLength(
            JSON.stringify(rt.signals.shift()),
            "utf8",
          );
        for (const wake of rt.waiters) wake();
        return { signal: copy(signal) };
      }
    }
    return undefined;
  }
  function membershipChanged() {
    for (const meeting of office.meetings)
      if (media.has(meeting.id)) {
        const rt = sweep(meeting);
        for (const wake of rt.waiters) wake();
      }
  }
  function roomRecords(roomId) {
    return {
      meetings: office.meetings
        .filter((meeting) => meeting.room_id === roomId)
        .map(copy),
      calendar: office.calendar
        .filter((item) => item.room_id === roomId)
        .map(copy),
    };
  }
  function manifest(roomId) {
    return {
      meetings: office.meetings
        .filter((meeting) => meeting.room_id === roomId)
        .map((meeting) => ({ id: meeting.id, revision: meeting.revision })),
      calendar: office.calendar
        .filter((item) => item.room_id === roomId)
        .map((item) => ({ id: item.id, revision: item.revision })),
    };
  }
  function upcomingOccurrences(roomId, principalId, days = 1) {
    const records = office.calendar.filter((item) => item.room_id === roomId);
    const result = occurrencesPage(records, { from: stamp(), to: new Date(now() + days * 86400000).toISOString(), timezone: "UTC", limit: 100 }, roomId, (item) => !principalId || item.attendee_ids.includes(principalId));
    return result;
  }
  function contextSnapshot(roomId) {
    const records = roomRecords(roomId),
      selected = { meetings: [], calendar: [] };
    let budget = 20000;
    for (const type of ["meetings", "calendar"])
      for (const item of [...records[type]].reverse()) {
        const size = JSON.stringify(item).length;
        if (selected[type].length >= 30 || size > budget) continue;
        selected[type].unshift(item);
        budget -= size;
      }
    const upcoming = upcomingOccurrences(roomId, null, 7), occurrenceRecords = [];
    for (const item of upcoming.occurrences) {
      const size = JSON.stringify(item).length;
      if (size > budget) continue;
      occurrenceRecords.push(item); budget -= size;
    }
    return {
      ...selected,
      upcoming_calendar: { occurrences: occurrenceRecords, range: upcoming.range, truncated: upcoming.truncated || occurrenceRecords.length < upcoming.occurrences.length },
      calendar_capabilities: CALENDAR_CAPABILITIES,
      manifest: manifest(roomId),
      omissions: {
        meetings: records.meetings.length - selected.meetings.length,
        calendar: records.calendar.length - selected.calendar.length,
      },
      character_budget: 20000,
    };
  }
  return {
    handle,
    authorizeWorkbenchReceipt,
    poll,
    membershipChanged,
    roomRecords,
    contextSnapshot,
    manifest,
    reduceCalendar,
    upcomingOccurrences,
  };
}
module.exports = { createOfficeFeatures };
