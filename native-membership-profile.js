"use strict";
const { problem } = require("./work-protocol");
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function createMembershipProfiles({ state, member, roomById, stamp, event, persist }) {
  for (const room of state.rooms) {
    if (!owns(room, "membership_profiles")) continue;
    const profiles = room.membership_profiles;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles) ||
        Object.values(profiles).some((value) => !value || typeof value !== "object" ||
          typeof value.nickname !== "string" || value.nickname.length > 40 ||
          !Number.isSafeInteger(value.revision) || value.revision < 1 ||
          typeof value.updated_at !== "string" || typeof value.updated_by !== "string"))
      throw new Error("Membership profiles are corrupt; refusing to reset group nicknames");
  }

  function saved(room, pid) {
    return owns(room.membership_profiles || {}, pid) ? room.membership_profiles[pid]
      : { nickname: "", revision: 1, updated_at: null, updated_by: null };
  }
  function nickname(room, pid) {
    return room.kind !== "direct" && owns(room.members, pid) ? saved(room, pid).nickname : "";
  }
  function profile(room, pid) {
    const person = state.principals.find((entry) => entry.id === pid), current = saved(room, pid);
    const label = nickname(room, pid);
    return { room_id: room.id, principal_id: pid, name: person?.name || "", nickname: label,
      display_name: label || person?.name || "", revision: current.revision,
      updated_at: current.updated_at, updated_by: current.updated_by };
  }
  function author(room, pid, identity, basis = "current_room_nickname") {
    const label = nickname(room, pid);
    const person = state.principals.find((entry) => entry.id === pid);
    return { ...identity, nickname: label, display_name: label || person?.name || identity?.name || "",
      display_name_basis: basis };
  }
  function change(room, pid, nextNickname, actorId, reason) {
    const previous = profile(room, pid), current = saved(room, pid);
    room.membership_profiles ||= {};
    room.membership_profiles[pid] = { nickname: nextNickname, revision: current.revision + 1,
      updated_at: stamp(), updated_by: actorId };
    const next = profile(room, pid);
    event(room, "membership_profile.updated", actorId, {
      principal_id: pid, reason, previous, membership_profile: next,
    });
    return next;
  }
  function removed(room, pid, actorId) {
    // Retain a version tombstone across leave/rejoin so an old editor cannot
    // revive a nickname with a reused initial base_revision.
    if (room.kind !== "direct") change(room, pid, "", actorId, "membership_removed");
  }
  async function handle(method, pathname, input, p) {
    const match = pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/membership-profile$/);
    if (!match) return undefined;
    const room = roomById(match[1]); member(room, p);
    if (room.kind === "direct") throw problem(409, "group_required", "群昵称仅适用于群聊");
    const current = profile(room, p.id), permissions = { can_edit: true };
    if (method === "GET") return { membership_profile: current, permissions };
    if (method !== "PATCH") throw problem(405, "method_not_allowed", "群昵称支持本人读取与修改");
    if (Object.keys(input).some((key) => !["nickname", "base_revision"].includes(key)))
      throw problem(422, "invalid_input", "只能修改当前身份本人的群昵称");
    if (!Number.isSafeInteger(input.base_revision) || input.base_revision < 1)
      throw problem(422, "version_required", "请提供本人群昵称的 base_revision");
    if (input.base_revision !== current.revision)
      throw problem(409, "conflict", "群昵称已变化，请保留输入并读取最新版本");
    if (typeof input.nickname !== "string" || input.nickname.length > 40 || /[\u0000-\u001f\u007f]/u.test(input.nickname))
      throw problem(422, "invalid_input", "群昵称最多40字符，不支持换行或控制字符");
    const value = input.nickname.trim();
    if (value === current.nickname) return { membership_profile: current, permissions };
    const next = change(room, p.id, value, p.id, "self_updated");
    persist();
    return { membership_profile: next, permissions };
  }
  return { handle, profile, author, removed };
}

module.exports = { createMembershipProfiles };
