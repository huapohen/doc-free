"use strict";

const { problem, requireText } = require("./work-protocol");
const copy = (value) => JSON.parse(JSON.stringify(value));
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function createRoomDetails({ state, stamp, persist, event, roomById, member }) {
  // Missing metadata is an old room, never an invitation to replace corrupt data.
  for (const room of state.rooms) {
    for (const field of ["profile_metadata", "announcement"]) {
      if (!owns(room, field)) continue;
      const value = room[field];
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          !Number.isSafeInteger(value.revision) || value.revision < 1 ||
          typeof value.updated_at !== "string" || typeof value.updated_by !== "string" ||
          (field === "announcement" && (typeof value.content !== "string" || value.content.length > 20000)))
        throw new Error("Room details are corrupt; refusing to reset group metadata");
    }
  }

  function permissions(room, p) {
    const membership = member(room, p);
    if (room.kind === "direct") return { can_edit: false, reason: "group_required" };
    if (membership.role === "owner") return { can_edit: true, reason: "owner" };
    // A missing legacy role may use the explicit creator only when no owner is
    // recorded. An explicit member role, other users and enterprise admins do not.
    if (!owns(membership, "role") && room.created_by === p.id &&
        !Object.values(room.members).some((entry) => entry.role === "owner"))
      return { can_edit: true, reason: "legacy_creator" };
    return { can_edit: false, reason: "owner_required" };
  }

  function profile(room) {
    return {
      room_id: room.id,
      name: room.name,
      description: room.description || "",
      revision: room.profile_metadata?.revision ?? 1,
      updated_by: room.profile_metadata?.updated_by ?? room.created_by ?? null,
      updated_at: room.profile_metadata?.updated_at ?? room.created_at ?? null,
    };
  }

  function announcement(room) {
    return {
      room_id: room.id,
      content: room.announcement?.content ?? "",
      revision: room.announcement?.revision ?? 1,
      updated_by: room.announcement?.updated_by ?? null,
      updated_at: room.announcement?.updated_at ?? null,
    };
  }

  function snapshot(room) {
    return room.kind === "direct" ? null : { profile: profile(room), announcement: announcement(room) };
  }

  function revision(input, current) {
    if (!Number.isSafeInteger(input.base_revision) || input.base_revision < 1)
      throw problem(422, "version_required", "请提供当前群资料或公告的 base_revision");
    if (input.base_revision !== current.revision)
      throw problem(409, "conflict", "群资料或公告已变化，请保留本地编辑并读取最新版本");
  }

  function optionalText(value, field, limit) {
    if (typeof value !== "string" || value.length > limit)
      throw problem(422, "invalid_input", `${field} 必须是最多 ${limit} 字符的文本`);
    return value;
  }

  async function handle(method, pathname, input, p) {
    const match = pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/(profile|announcement)$/);
    if (!match) return undefined;
    const room = roomById(match[1]), field = match[2], access = permissions(room, p);
    if (room.kind === "direct") throw problem(409, "group_required", "群资料与公告仅适用于群聊");
    const read = field === "profile" ? profile : announcement;
    const current = read(room);
    if (method === "GET") return { [field]: current, permissions: access };
    if (method !== "PATCH") throw problem(405, "method_not_allowed", "群资料与公告支持读取和版本化更新");
    if (!access.can_edit) throw problem(403, "owner_required", "需要当前群主权限");
    const allowed = field === "profile" ? ["base_revision", "name", "description"] : ["base_revision", "content"];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      throw problem(422, "invalid_input", "群资料或公告包含不支持的字段");
    revision(input, current);
    let changes;
    if (field === "profile") {
      if (input.name === undefined && input.description === undefined)
        throw problem(422, "invalid_input", "至少提供群名或群描述");
      changes = {
        name: input.name === undefined ? current.name : requireText(input.name, "name", 100),
        description: input.description === undefined ? current.description : optionalText(input.description, "description", 4000),
      };
    } else {
      changes = { content: optionalText(input.content, "content", 20000) };
    }
    if (Object.entries(changes).every(([key, value]) => current[key] === value))
      return { [field]: current, permissions: access };
    const metadata = { revision: current.revision + 1, updated_by: p.id, updated_at: stamp() };
    if (field === "profile") {
      room.name = changes.name;
      room.description = changes.description;
      room.profile_metadata = metadata;
    } else {
      room.announcement = { ...metadata, ...changes };
    }
    room.revision += 1;
    const next = read(room);
    event(room, `room.${field}.updated`, p.id, { revision: next.revision, previous: current, [field]: next });
    persist();
    return { [field]: copy(next), permissions: access };
  }

  return { handle, profile, announcement, snapshot };
}

module.exports = { createRoomDetails };
