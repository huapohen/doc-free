"use strict";

// Durable office scheduling uses the native IM transaction boundary. Media
// presence and WebRTC signaling are short-lived, scoped process memory only.
const crypto = require("node:crypto");
const { problem, requireText } = require("./work-protocol");
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
  function attendees(room, value, fallback) {
    const list = value === undefined ? fallback : value;
    if (
      !Array.isArray(list) ||
      list.length > 100 ||
      list.some((pid) => !owns(room.members, pid))
    )
      throw problem(422, "invalid_attendees", "日程参与者必须是当前会话成员");
    return [...new Set(list)].sort();
  }
  function calendarInput(room, p, input, current) {
    const title = requireText(input.title ?? current?.title, "title", 200);
    const starts_at = iso(input.starts_at ?? current?.starts_at, "starts_at"),
      ends_at = iso(input.ends_at ?? current?.ends_at, "ends_at");
    if (Date.parse(ends_at) <= Date.parse(starts_at))
      throw problem(422, "invalid_datetime", "结束时间必须晚于开始时间");
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
      starts_at,
      ends_at,
      description,
      location,
      attendee_ids: attendees(
        room,
        input.attendee_ids,
        current?.attendee_ids || [p.id],
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
      status: "scheduled",
      ...(meetingId ? { meeting_id: meetingId } : {}),
    };
    office.calendar.push(item);
    event(room, "calendar.created", p.id, { event_id: item.id, event: copy(item), ...cause });
    return item;
  }
  // Shared mutation reducer: caller owns the single persistence boundary.
  function reduceCalendar(operation, room, p, input, cause = {}) {
    member(room, p);
    if (operation === "create") return createCalendar(room, p, calendarInput(room, p, input), null, cause);
    const found = eventById(input.event_id, p), item = found.item;
    if (found.room.id !== room.id) throw problem(403, "calendar_scope", "日程不属于当前会话");
    if (operation === "update") {
        if (item.created_by !== p.id && room.members[p.id].role !== "owner")
          throw problem(
            403,
            "creator_required",
            "只有创建者或会话所有者能修改日程",
          );
        if (!Number.isInteger(input.base_revision))
          throw problem(422, "version_required", "请提供 base_revision");
        if (input.base_revision !== item.revision)
          throw problem(409, "conflict", "日程版本已变化");
        const payload = calendarInput(room, p, input, item);
        if (item.meeting_id) {
          const meeting = meetingById(item.meeting_id),
            minutes =
              (Date.parse(payload.ends_at) - Date.parse(payload.starts_at)) /
              60000;
          if (meeting.status === "ended")
            throw problem(409, "meeting_ended", "已结束会议不能改期");
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480)
            throw problem(422, "invalid_duration", "会议长度必须为 1–480 分钟");
          meeting.title = payload.title;
          meeting.starts_at = payload.starts_at;
          meeting.duration_minutes = minutes;
          meeting.revision += 1;
        }
        const rescheduled =
          item.starts_at !== payload.starts_at ||
          item.ends_at !== payload.ends_at;
        Object.assign(item, payload);
        item.revision += 1;
        item.updated_at = stamp();
        item.responses = rescheduled
          ? {}
          : Object.fromEntries(
              Object.entries(item.responses).filter(([pid]) =>
                item.attendee_ids.includes(pid),
              ),
            );
        event(room, "calendar.updated", p.id, { event_id: item.id, event: copy(item), ...cause });

    } else if (operation === "respond") {
      if (input.base_revision !== undefined && input.base_revision !== item.revision)
        throw problem(409, "conflict", "日程版本已变化");
        if (!item.attendee_ids.includes(p.id))
          throw problem(403, "not_invited", "只有受邀成员可以回应");
        if (!["accepted", "declined", "tentative"].includes(input.response))
          throw problem(422, "invalid_response", "无效日程回应");
        item.responses[p.id] = input.response;
        item.revision += 1;
        item.updated_at = stamp();
        event(room, "calendar.responded", p.id, {
          event_id: item.id,
          response: input.response,
          event: copy(item), ...cause,
        });

    } else throw problem(422, "invalid_action", "无效日程动作");
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
      if (method === "GET")
        return {
          apps: copy(APPS),
          favorites: office.workbench_preferences[p.id]?.favorites || [
            "messages",
            "agents",
            "docs",
            "tasks",
          ],
        };
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
        office.workbench_preferences[p.id] = { favorites };
        persist();
        return { apps: copy(APPS), favorites };
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
        const payload = calendarInput(room, p, input),
          digest = keyHash(payload),
          previous = office.calendar_keys[key];
        if (previous) {
          if (previous.hash !== digest)
            throw problem(
              409,
              "idempotency_conflict",
              "相同 client_id 对应不同日程",
            );
          return {
            event: copy(
              office.calendar.find((item) => item.id === previous.id),
            ),
            duplicate: true,
          };
        }
        const item = reduceCalendar("create", room, p, input);
        office.calendar_keys[key] = { id: item.id, hash: digest };
        persist();
        return { event: copy(item), duplicate: false };
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
      if (!calendarRoute[2] && method === "GET") return { event: copy(item) };
      if (!calendarRoute[2] && method === "PATCH") {
        reduceCalendar("update", room, p, { ...input, event_id: item.id });
        persist();
        return { event: copy(item) };
      }
      if (calendarRoute[2] === "respond" && method === "POST") {
        reduceCalendar("respond", room, p, { ...input, event_id: item.id });
        persist();
        return { event: copy(item) };
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
    return {
      ...selected,
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
    poll,
    membershipChanged,
    roomRecords,
    contextSnapshot,
    manifest,
    reduceCalendar,
  };
}
module.exports = { createOfficeFeatures };
