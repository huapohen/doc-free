"use strict";

// Attendance corrections and approval decisions share the native IM durable
// transaction. Reported place labels are notes, never verified location data.
const crypto = require("node:crypto");
const { problem, requireText } = require("./work-protocol");
const copy = (value) => JSON.parse(JSON.stringify(value));
const owns = (object, key) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const TEMPLATES = [
  {
    id: "general",
    name: "通用审批",
    description: "由明确的审批人审核一项团队申请",
    fields: ["title", "description", "approver_id"],
  },
  {
    id: "leave",
    name: "请假申请",
    description: "记录请假说明与人工审核结果，不自动更改薪资或假期余额",
    fields: ["title", "description", "approver_id", "payload"],
  },
  {
    id: "expense",
    name: "报销申请",
    description: "记录报销申请与审核，不执行付款",
    fields: ["title", "description", "approver_id", "payload"],
  },
  {
    id: "attendance_correction",
    name: "补卡申请",
    description: "指定审批人确认后，按原记录版本原子更正考勤",
    fields: [
      "date",
      "timezone",
      "check_in_at",
      "check_out_at",
      "reason",
      "approver_id",
    ],
    create_path: "/rooms/:room_id/attendance/corrections",
  },
];
function createWorkforce({
  state,
  now,
  stamp,
  persist,
  active,
  principalView,
  roomById,
  member,
  event,
}) {
  state.workforce ||= {
    records: [],
    approvals: [],
    attendance_keys: {},
    approval_keys: {},
    decision_keys: {},
  };
  const store = state.workforce;
  if (
    !Array.isArray(store.records) ||
    !Array.isArray(store.approvals) ||
    !store.attendance_keys ||
    !store.approval_keys ||
    !store.decision_keys
  )
    throw new Error(
      "Workforce state is corrupt; refusing to initialize empty attendance and approvals",
    );
  function timezone(value = "Asia/Shanghai") {
    if (typeof value !== "string" || value.length > 100)
      throw problem(422, "invalid_timezone", "无效时区");
    try {
      return new Intl.DateTimeFormat("en", {
        timeZone: value,
      }).resolvedOptions().timeZone;
    } catch {
      throw problem(422, "invalid_timezone", "请使用有效 IANA 时区");
    }
  }
  function dateAt(value, zone) {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value));
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  function day(value) {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
    )
      throw problem(422, "invalid_date", "日期必须为有效的 YYYY-MM-DD");
    return value;
  }
  function iso(value, field) {
    if (
      typeof value !== "string" ||
      value.length > 80 ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw problem(
        422,
        "invalid_datetime",
        `${field} 必须为带时区的 ISO 时间`,
      );
    return new Date(value).toISOString();
  }
  function note(value, max = 8000) {
    const text = value ?? "";
    if (typeof text !== "string" || text.length > max)
      throw problem(422, "invalid_input", "说明字段超出长度限制");
    return text;
  }
  function recordFor(room, p, date, zone) {
    return store.records.find(
      (record) =>
        record.room_id === room.id &&
        record.principal_id === p.id &&
        record.date === date &&
        record.timezone === zone,
    );
  }
  function recordView(record) {
    return {
      ...copy(record),
      principal: principalView(
        state.principals.find((person) => person.id === record.principal_id),
      ),
      location_verification: "self_reported_note_only",
    };
  }
  function requestRoom(request, p) {
    const room = roomById(request.room_id);
    member(room, p);
    if (
      request.created_by !== p.id &&
      request.approver_id !== p.id &&
      room.members[p.id].role !== "owner"
    )
      throw problem(
        403,
        "approval_scope",
        "只有申请人、指定审批人和会话所有者可以查看此申请",
      );
    return room;
  }
  function requestById(rid, p) {
    const request = store.approvals.find((item) => item.id === rid);
    if (!request) throw problem(404, "not_found", "申请不存在");
    const room = requestRoom(request, p);
    return { request, room };
  }
  function audit(request, action, actorId, comment = "") {
    request.audit.push({
      action,
      actor_id: actorId,
      at: stamp(),
      revision: request.revision,
      comment,
    });
  }
  function expire(request, room) {
    if (
      request.status === "pending" &&
      Date.parse(request.expires_at) <= now()
    ) {
      request.status = "expired";
      request.revision += 1;
      request.updated_at = stamp();
      audit(request, "expired", "server");
      event(room, "approval.expired", "server", { request_id: request.id });
      persist();
    }
  }
  function baseVersion(input, current) {
    if (!Number.isInteger(input.base_revision))
      throw problem(422, "version_required", "请提供 base_revision");
    if (input.base_revision !== current)
      throw problem(409, "conflict", "记录版本已变化，请刷新后确认");
  }
  function approvalPayload(room, p, input, template) {
    const approver = active(input.approver_id);
    if (!owns(room.members, approver.id))
      throw problem(422, "invalid_approver", "审批人必须为当前会话成员");
    if (approver.id === p.id)
      throw problem(422, "self_approval", "申请人不能指定自己审批");
    const expires_at =
      input.expires_at === undefined
        ? new Date(now() + 7 * 86400000).toISOString()
        : iso(input.expires_at, "expires_at");
    if (
      Date.parse(expires_at) <= now() ||
      Date.parse(expires_at) > now() + 90 * 86400000
    )
      throw problem(422, "invalid_deadline", "审批期限必须在未来 90 天内");
    const payload = input.payload ?? {};
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      JSON.stringify(payload).length > 12000
    )
      throw problem(
        422,
        "invalid_payload",
        "申请内容必须为不超过 12000 字符的 JSON 对象",
      );
    return {
      template_id: template,
      title: requireText(input.title, "title", 200),
      description: note(input.description),
      approver_id: approver.id,
      expires_at,
      payload: copy(payload),
    };
  }
  function newApproval(room, p, payload) {
    if (store.approvals.length >= 10000)
      throw problem(409, "limit_reached", "本地审批记录已达上限");
    const request = {
      id: id("approval"),
      room_id: room.id,
      ...payload,
      created_by: p.id,
      created_at: stamp(),
      updated_at: stamp(),
      revision: 1,
      status: "pending",
      audit: [],
    };
    audit(request, "created", p.id);
    store.approvals.push(request);
    event(room, "approval.created", p.id, {
      request_id: request.id,
      approver_id: request.approver_id,
    });
    return request;
  }
  function correctionPayload(room, p, input) {
    const zone = timezone(input.timezone),
      date = day(input.date);
    const existing = recordFor(room, p, date, zone);
    if (
      input.record_id !== undefined &&
      (!existing || existing.id !== input.record_id)
    )
      throw problem(
        403,
        "attendance_scope",
        "只能更正自己在当前会话的同一天记录",
      );
    if (input.base_revision !== undefined)
      baseVersion(input, existing?.revision || 0);
    const check_in_at = iso(
      input.check_in_at ?? existing?.check_in_at,
      "check_in_at",
    );
    const rawOut = owns(input, "check_out_at")
      ? input.check_out_at
      : existing?.check_out_at || null;
    const check_out_at = rawOut === null ? null : iso(rawOut, "check_out_at");
    if (
      dateAt(check_in_at, zone) !== date ||
      (check_out_at &&
        (Date.parse(check_out_at) < Date.parse(check_in_at) ||
          Date.parse(check_out_at) - Date.parse(check_in_at) > 48 * 3600000))
    )
      throw problem(
        422,
        "invalid_correction_time",
        "补卡上班时间需落在该时区日期内，下班时间需在其后 48 小时内",
      );
    if (
      Date.parse(check_in_at) > now() ||
      (check_out_at && Date.parse(check_out_at) > now())
    )
      throw problem(422, "future_attendance", "不能申请未来打卡时间");
    return {
      principal_id: p.id,
      date,
      timezone: zone,
      record_id: existing?.id || null,
      base_record_revision: existing?.revision || 0,
      check_in_at,
      check_out_at,
      reason: requireText(input.reason, "reason", 2000),
    };
  }
  function applyCorrection(request, room, actorId) {
    const payload = request.payload,
      person = active(payload.principal_id);
    if (!owns(room.members, person.id))
      throw problem(409, "attendance_scope", "申请人已离开会话，不能更正考勤");
    let record = recordFor(room, person, payload.date, payload.timezone);
    if (
      (record?.id || null) !== payload.record_id ||
      (record?.revision || 0) !== payload.base_record_revision
    )
      throw problem(
        409,
        "attendance_conflict",
        "考勤已在申请后变化，请重新申请补卡",
      );
    if (!record) {
      if (store.records.length >= 20000)
        throw problem(409, "limit_reached", "本地考勤记录已达上限");
      record = {
        id: id("attendance"),
        room_id: room.id,
        principal_id: person.id,
        date: payload.date,
        timezone: payload.timezone,
        check_in_at: null,
        check_out_at: null,
        check_in_note: "",
        check_out_note: "",
        created_at: stamp(),
        updated_at: stamp(),
        revision: 0,
        audit: [],
      };
      store.records.push(record);
    }
    const previous = {
      check_in_at: record.check_in_at,
      check_out_at: record.check_out_at,
      revision: record.revision,
    };
    record.check_in_at = payload.check_in_at;
    record.check_out_at = payload.check_out_at;
    record.revision += 1;
    record.updated_at = stamp();
    record.audit.push({
      action: "approved_correction",
      actor_id: actorId,
      requested_by: request.created_by,
      request_id: request.id,
      at: stamp(),
      previous,
      check_in_at: record.check_in_at,
      check_out_at: record.check_out_at,
      reason: payload.reason,
      revision: record.revision,
    });
    request.applied_record_id = record.id;
    event(room, "attendance.corrected", actorId, {
      record_id: record.id,
      request_id: request.id,
    });
  }
  async function handle(method, pathname, input, p, params) {
    if (pathname === "/api/im/approval-templates" && method === "GET")
      return { templates: copy(TEMPLATES) };
    if (pathname === "/api/im/approvals" && method === "GET") {
      const inbox = params.get("inbox") || "assigned";
      if (!["assigned", "created", "all"].includes(inbox))
        throw problem(422, "invalid_inbox", "无效审批收件箱");
      const query = params.has("q")
        ? requireText(params.get("q"), "q", 100).toLocaleLowerCase()
        : "";
      const requests = [];
      for (const request of [...store.approvals].reverse()) {
        let room;
        try {
          room = requestRoom(request, p);
        } catch {
          continue;
        }
        if (inbox === "assigned" && request.approver_id !== p.id) continue;
        if (inbox === "created" && request.created_by !== p.id) continue;
        if (
          query &&
          !`${request.title}\n${request.description}\n${JSON.stringify(request.payload)}`
            .toLocaleLowerCase()
            .includes(query)
        )
          continue;
        expire(request, room);
        requests.push(copy(request));
        if (requests.length >= 200) break;
      }
      return { requests };
    }
    if (
      ["/api/im/attendance", "/api/im/attendance/export"].includes(pathname) &&
      method === "GET"
    ) {
      const zone = timezone(params.get("timezone") || undefined),
        date = params.has("date")
          ? day(params.get("date"))
          : dateAt(now(), zone);
      const result = {
        date,
        timezone: zone,
        records: store.records
          .filter((record) => {
            if (
              record.principal_id !== p.id ||
              record.date !== date ||
              record.timezone !== zone
            )
              return false;
            try {
              member(roomById(record.room_id), p);
              return true;
            } catch {
              return false;
            }
          })
          .slice(-200)
          .map(recordView),
      };
      if (pathname.endsWith("/export")) {
        const json = JSON.stringify(
          {
            protocol: "active-im/v1",
            kind: "attendance",
            principal_id: p.id,
            ...result,
          },
          null,
          2,
        );
        const fence = "`".repeat(
          Math.max(
            3,
            ...[...json.matchAll(/`+/g)].map((item) => item[0].length + 1),
          ),
        );
        return `# 本人考勤 · ${date}\n\n时区：${zone}。仅包含本人当前会话记录；地点说明为本人自报，未经定位验证。\n\n${fence}active-attendance\n${json}\n${fence}\n`;
      }
      return result;
    }
    const roomRoute = pathname.match(
      /^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/(attendance(?:\/corrections)?|approvals)$/,
    );
    if (roomRoute) {
      const room = roomById(roomRoute[1]);
      const membership = member(room, p),
        route = roomRoute[2];
      if (route === "attendance" && method === "GET") {
        const zone = timezone(params.get("timezone") || undefined),
          date = params.has("date")
            ? day(params.get("date"))
            : dateAt(now(), zone);
        return {
          date,
          timezone: zone,
          records: store.records
            .filter(
              (record) =>
                record.room_id === room.id &&
                record.date === date &&
                record.timezone === zone &&
                (record.principal_id === p.id || membership.role === "owner"),
            )
            .slice(-200)
            .map(recordView),
        };
      }
      if (route === "attendance" && method === "POST") {
        if (!["check_in", "check_out"].includes(input.action))
          throw problem(422, "invalid_action", "只能上班或下班打卡");
        const zone = timezone(input.timezone),
          location = note(input.location_note, 500),
          clientId = requireText(input.client_id, "client_id", 160);
        const key = `${room.id}:${p.id}:${clientId}`,
          digest = hash({
            action: input.action,
            timezone: zone,
            location_note: location,
          }),
          receipt = store.attendance_keys[key];
        if (receipt) {
          if (receipt.hash !== digest)
            throw problem(
              409,
              "idempotency_conflict",
              "相同 client_id 对应不同打卡请求",
            );
          return {
            record: recordView(
              store.records.find((record) => record.id === receipt.id),
            ),
            duplicate: true,
          };
        }
        const date = dateAt(now(), zone);
        let record = recordFor(room, p, date, zone);
        if (input.action === "check_in" && record?.check_in_at)
          throw problem(
            409,
            "already_checked_in",
            "当日已上班打卡，更正请提交补卡申请",
          );
        if (input.action === "check_out" && !record?.check_in_at)
          throw problem(
            409,
            "check_in_required",
            "请先上班打卡；遗漏请提交补卡申请",
          );
        if (input.action === "check_out" && record.check_out_at)
          throw problem(
            409,
            "already_checked_out",
            "当日已下班打卡，更正请提交补卡申请",
          );
        if (record?.check_in_at && Date.parse(record.check_in_at) > now())
          throw problem(409, "invalid_clock", "服务器时间早于已有上班记录");
        if (!record) {
          if (store.records.length >= 20000)
            throw problem(409, "limit_reached", "本地考勤记录已达上限");
          record = {
            id: id("attendance"),
            room_id: room.id,
            principal_id: p.id,
            date,
            timezone: zone,
            check_in_at: null,
            check_out_at: null,
            check_in_note: "",
            check_out_note: "",
            created_at: stamp(),
            updated_at: stamp(),
            revision: 0,
            audit: [],
          };
          store.records.push(record);
        }
        record[input.action + "_at"] = stamp();
        record[input.action + "_note"] = location;
        record.revision += 1;
        record.updated_at = stamp();
        record.audit.push({
          action: input.action,
          actor_id: p.id,
          at: stamp(),
          source: "server_clock",
          location_note: location,
          revision: record.revision,
        });
        store.attendance_keys[key] = { id: record.id, hash: digest };
        event(room, "attendance.recorded", p.id, {
          record_id: record.id,
          action: input.action,
        });
        persist();
        return { record: recordView(record), duplicate: false };
      }
      if (
        method === "POST" &&
        ["approvals", "attendance/corrections"].includes(route)
      ) {
        const clientId = requireText(input.client_id, "client_id", 160),
          key = `${room.id}:${p.id}:${clientId}`;
        const isCorrection = route === "attendance/corrections";
        const template = isCorrection
          ? "attendance_correction"
          : input.template_id;
        if (
          !TEMPLATES.some((item) => item.id === template) ||
          (!isCorrection && template === "attendance_correction")
        )
          throw problem(
            422,
            "invalid_template",
            "请选择正确申请模板或补卡接口",
          );
        // Hash the submitted intent before resolving current record versions or
        // default deadlines, so retries return the original durable request.
        const digest = hash({ route, ...input }),
          previous = store.approval_keys[key];
        if (previous) {
          if (previous.hash !== digest)
            throw problem(
              409,
              "idempotency_conflict",
              "相同 client_id 对应不同申请",
            );
          return {
            request: copy(
              store.approvals.find((request) => request.id === previous.id),
            ),
            duplicate: true,
          };
        }
        const correction = isCorrection
          ? correctionPayload(room, p, input)
          : null;
        const payload = approvalPayload(
          room,
          p,
          {
            ...input,
            title: isCorrection ? `补卡申请 · ${correction.date}` : input.title,
            description: isCorrection ? correction.reason : input.description,
            payload: correction || input.payload,
          },
          template,
        );
        const request = newApproval(room, p, payload);
        store.approval_keys[key] = { id: request.id, hash: digest };
        persist();
        return { request: copy(request), duplicate: false };
      }
    }
    const route = pathname.match(
      /^\/api\/im\/approvals\/(approval-[a-f0-9-]+)(?:\/(decision|cancel|export))?$/,
    );
    if (route) {
      const { request, room } = requestById(route[1], p);
      expire(request, room);
      if (!route[2] && method === "GET") return { request: copy(request) };
      if (route[2] === "export" && method === "GET") {
        const json = JSON.stringify(request, null, 2),
          length = Math.max(
            3,
            ...[...json.matchAll(/`+/g)].map((item) => item[0].length + 1),
          ),
          fence = "`".repeat(length);
        return `# ${request.title}\n\n审批记录 · ${request.status} · r${request.revision}\n\n${fence}active-approval\n${JSON.stringify({ protocol: "active-im/v1", kind: "approval", ...request }, null, 2)}\n${fence}\n`;
      }
      if (["decision", "cancel"].includes(route[2]) && method === "POST") {
        const cancel = route[2] === "cancel",
          clientId = requireText(input.client_id, "client_id", 160),
          comment = note(input.comment, 2000);
        if (cancel) {
          if (
            p.id !== request.created_by &&
            room.members[p.id].role !== "owner"
          )
            throw problem(
              403,
              "creator_required",
              "只有申请人或会话所有者可以取消",
            );
        } else {
          if (p.id !== request.approver_id || p.id === request.created_by)
            throw problem(403, "approver_required", "必须由指定审批人本人审核");
          if (!["approved", "rejected"].includes(input.decision))
            throw problem(422, "invalid_decision", "无效审核结果");
        }
        const key = `${request.id}:${p.id}:${clientId}`,
          digest = hash({ action: route[2], ...input }),
          receipt = store.decision_keys[key];
        if (receipt) {
          if (receipt.hash !== digest)
            throw problem(
              409,
              "idempotency_conflict",
              "相同 client_id 对应不同审核动作",
            );
          return { request: copy(request), duplicate: true };
        }
        if (request.status !== "pending")
          throw problem(
            409,
            request.status === "expired"
              ? "approval_expired"
              : "approval_finished",
            "申请已结束，不能重复审核",
          );
        baseVersion(input, request.revision);
        if (
          !cancel &&
          input.decision === "approved" &&
          request.template_id === "attendance_correction"
        )
          applyCorrection(request, room, p.id);
        request.status = cancel ? "cancelled" : input.decision;
        request.revision += 1;
        request.updated_at = stamp();
        request.decided_by = p.id;
        request.decided_at = stamp();
        request.decision_comment = comment;
        audit(request, request.status, p.id, comment);
        store.decision_keys[key] = { hash: digest };
        event(room, "approval.decided", p.id, {
          request_id: request.id,
          status: request.status,
        });
        persist();
        return { request: copy(request), duplicate: false };
      }
    }
    return undefined;
  }
  function visibleEvent(entry, p) {
    if (entry.type.startsWith("approval.")) {
      const request = store.approvals.find(
        (item) => item.id === entry.request_id,
      );
      if (!request) return false;
      try {
        requestRoom(request, p);
        return true;
      } catch {
        return false;
      }
    }
    if (entry.type.startsWith("attendance.")) {
      const record = store.records.find((item) => item.id === entry.record_id);
      if (!record) return false;
      try {
        return (
          record.principal_id === p.id ||
          member(roomById(record.room_id), p).role === "owner"
        );
      } catch {
        return false;
      }
    }
    return true;
  }
  return {
    handle,
    visibleEvent,
    authorizeRequest: (rid, p) => {
      requestById(rid, p);
    },
  };
}
module.exports = { createWorkforce };
