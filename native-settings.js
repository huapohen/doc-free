"use strict";
const { problem } = require("./work-protocol");
const MOBILE_NAV_IDS = Object.freeze(["messages", "agents", "docs", "tasks", "workbench", "meetings", "minutes", "calendar", "mail", "attendance", "approvals", "contacts", "enterprise"]);
const DESKTOP_NAV_IDS = Object.freeze(["messages", "agents", "contacts", "docs", "tasks", "workbench", "meetings", "calendar", "mail", "attendance", "approvals", "minutes"]);
const DEFAULTS = Object.freeze({ message_alignment: "split", send_shortcut: "enter", text_scale: 1, show_message_preview: true, time_format: "24h",
  mobile_nav: Object.freeze(["messages", "agents", "docs", "workbench"]), desktop_nav: DESKTOP_NAV_IDS });
const view = (settings) => structuredClone(settings);
function createNativeSettings({ state, stamp, persist, publishPersonalEvent = () => {} }) {
  state.personal_settings ||= {};
  async function handle(method, pathname, input, p) {
    if (pathname !== "/api/im/settings") return undefined;
    // Old preferences gain the new default without rewriting state or bumping
    // their revision. This is presentation preference, never a permission grant.
    const previous = { ...DEFAULTS, revision: 1, updated_at: null, ...state.personal_settings[p.id] };
    if (method === "GET") return { settings: view(previous) };
    if (method !== "PATCH") throw problem(405, "method_not_allowed", "不支持此设置操作");
    if (input.base_revision !== previous.revision) throw problem(409, "conflict", "个人设置已变化，请读取最新版本");
    const changes = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "base_revision") continue;
      const valid = (key === "message_alignment" && ["split", "left"].includes(value)) ||
        (key === "send_shortcut" && ["enter", "mod_enter"].includes(value)) ||
        (key === "text_scale" && typeof value === "number" && Number.isFinite(value) && value >= .85 && value <= 1.3) ||
        (key === "show_message_preview" && typeof value === "boolean") ||
        (key === "time_format" && ["24h", "12h"].includes(value)) ||
        (key === "mobile_nav" && Array.isArray(value) && value.length >= 1 && value.length <= 4 &&
          new Set(value).size === value.length && value.every((id) => MOBILE_NAV_IDS.includes(id))) ||
        (key === "desktop_nav" && Array.isArray(value) && value.length >= 1 && value.length <= 12 &&
          new Set(value).size === value.length && value.every((id) => DESKTOP_NAV_IDS.includes(id)));
      if (!valid) throw problem(422, "unsupported_setting", "设置值无效或尚未支持");
      changes[key] = ["mobile_nav", "desktop_nav"].includes(key) ? [...value] : value;
    }
    const settings = { ...previous, ...changes, revision: previous.revision + 1, updated_at: stamp() };
    state.personal_settings[p.id] = settings;
    publishPersonalEvent("settings.updated", p.id, {revision:settings.revision}, [p.id]); persist();
    return { settings: view(settings) };
  }
  return { handle };
}
module.exports = { createNativeSettings, DEFAULTS, MOBILE_NAV_IDS, DESKTOP_NAV_IDS };
