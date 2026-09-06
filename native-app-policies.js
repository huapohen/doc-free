"use strict";
const { problem } = require("./work-protocol");
const copy = (value) => JSON.parse(JSON.stringify(value));
const own = (object, key) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
const CONTEXT_PLUGINS = ["im", "docs", "tasks", "meetings", "calendar"];
const MEETING_PLUGINS = ["meetings", "calendar", "docs"];
const CORE = new Set(["settings", "enterprise"]);

function createNativeAppPolicies({
  state,
  stamp,
  persist,
  catalog,
  authorizeAdmin,
  departmentOf,
  departments,
  audit,
  publishPersonalEvent,
  changed,
}) {
  state.enterprise.app_policies ||= {};
  const policies = state.enterprise.app_policies;
  if (
    !policies ||
    typeof policies !== "object" ||
    Array.isArray(policies) ||
    Object.values(policies).some(
      (entry) =>
        !entry ||
        !Number.isSafeInteger(entry.revision) ||
        entry.revision < 1 ||
        typeof entry.enabled !== "boolean" ||
        !["all", "restricted"].includes(entry.scope_mode) ||
        !Array.isArray(entry.allowed_principal_ids) ||
        !Array.isArray(entry.allowed_department_ids) ||
        !Array.isArray(entry.denied_principal_ids),
    )
  )
    throw new Error(
      "Application policy state is corrupt; refusing to reset access restrictions",
    );
  function plugin(id) {
    const value = catalog().find((entry) => entry.id === id);
    if (!value) throw problem(404, "not_found", "应用插件不存在");
    return value;
  }
  function policy(id) {
    plugin(id);
    return own(policies, id)
      ? policies[id]
      : {
          revision: 1,
          enabled: true,
          scope_mode: "all",
          allowed_principal_ids: [],
          allowed_department_ids: [],
          denied_principal_ids: [],
          updated_at: null,
          updated_by: null,
        };
  }
  function effective(id, pid) {
    const value = policy(id);
    let allowed = true,
      reason = "allowed";
    if (!CORE.has(id)) {
      if (!value.enabled) {
        allowed = false;
        reason = "disabled";
      } else if (value.denied_principal_ids.includes(pid)) {
        allowed = false;
        reason = "explicitly_denied";
      } else if (
        value.scope_mode === "restricted" &&
        !value.allowed_principal_ids.includes(pid) &&
        !value.allowed_department_ids.includes(departmentOf(pid))
      ) {
        allowed = false;
        reason = "not_in_scope";
      }
    }
    return {
      enterprise_allowed: allowed,
      enterprise_policy_revision: value.revision,
      enterprise_policy_reason: reason,
    };
  }
  function allowed(id, pid) {
    return effective(id, pid).enterprise_allowed;
  }
  function requirePlugins(ids, p) {
    for (const id of ids)
      if (!allowed(id, p.id)) {
        const error = problem(
          403,
          "app_policy_denied",
          "企业应用策略不允许当前身份使用此模块",
        );
        error.plugin_id = id;
        throw error;
      }
  }
  // Only native module roots and known room subresources are mapped. These are
  // capability dependencies, never a caller-provided URL/pattern allowlist.
  function routePlugins(pathname) {
    if (!pathname.startsWith("/api/im/")) return [];
    const parts = pathname.slice(8).split("/"),
      root = parts[0];
    if (
      [
        "me",
        "auth",
        "enterprise",
        "settings",
        "plugins",
        "capabilities",
        "search",
        "library",
        "events",
      ].includes(root)
    )
      return [];
    if (
      [
        "principals",
        "contacts",
        "agents",
        "agent-store",
        "message-groups",
        "presence",
        "attachments",
      ].includes(root)
    )
      return ["im"];
    if (root === "meetings") return MEETING_PLUGINS;
    if (root === "calendar") return ["calendar"];
    if (root === "minutes") return ["minutes"];
    if (root === "attendance") return ["attendance"];
    if (["approvals", "approval-templates"].includes(root))
      return ["approvals"];
    if (root === "mail") return ["mail"];
    if (root === "workbench") return ["workbench"];
    if (root === "rooms") {
      const module = parts[2];
      if (module === "documents") return ["docs"];
      if (module === "tasks") return ["tasks"];
      if (module === "meetings") return MEETING_PLUGINS;
      if (module === "calendar") return ["calendar"];
      if (module === "minutes") return ["minutes"];
      if (module === "attendance")
        return parts[3] === "corrections"
          ? ["attendance", "approvals"]
          : ["attendance"];
      if (module === "approvals") return ["approvals"];
      if (["turns", "export"].includes(module)) return CONTEXT_PLUGINS;
      return ["im"];
    }
    return [];
  }
  function eventAllowed(entry, p) {
    const root = entry.type.split(".")[0];
    const ids =
      root === "mail"
        ? ["mail"]
        : root === "minute"
          ? ["minutes"]
        : root === "approval"
          ? ["approvals"]
          : root === "attendance"
            ? ["attendance"]
            : root === "document"
              ? ["docs"]
              : root === "task"
                ? ["tasks"]
                : root === "calendar"
                  ? ["calendar"]
                  : root === "meeting"
                    ? MEETING_PLUGINS
                    : root === "turn"
                      ? CONTEXT_PLUGINS
                      : [
                            "plugin",
                            "settings",
                            "enterprise",
                            "application",
                          ].includes(root)
                        ? []
                        : ["im"];
    return ids.every((id) => allowed(id, p.id));
  }
  function appView(entry, p) {
    return {
      ...copy(entry),
      execution: entry.builtin ? "native_authorized_handler" : "not_connected",
      policy: copy(policy(entry.id)),
      protected_core: CORE.has(entry.id),
      ...effective(entry.id, p.id),
      required_plugins: entry.id === "meetings" ? MEETING_PLUGINS : [entry.id],
    };
  }
  function presentation(id, pid) {
    const required_plugins = id === "meetings" ? MEETING_PLUGINS : [id];
    const blocked_dependency_ids = required_plugins.filter(
      (dependency) => !allowed(dependency, pid),
    );
    return {
      ...effective(id, pid),
      required_plugins: [...required_plugins],
      blocked_dependency_ids,
      dependencies_allowed: blocked_dependency_ids.length === 0,
    };
  }
  function ids(value, field, previous) {
    if (value === undefined) return previous;
    const limit = field === "allowed_department_ids" ? 200 : 1000;
    if (
      !Array.isArray(value) ||
      value.length > limit ||
      value.some((id) => typeof id !== "string")
    )
      throw problem(
        422,
        "invalid_app_scope",
        "应用范围须为有效成员或部门 ID 列表",
      );
    const known = new Set(
      field === "allowed_department_ids"
        ? departments().map((entry) => entry.id)
        : state.principals
            .filter((entry) => !entry.revoked_at)
            .map((entry) => entry.id),
    );
    if (value.some((id) => !known.has(id)))
      throw problem(
        422,
        "invalid_app_scope",
        "应用范围包含不存在或已撤销的成员/部门",
      );
    return [...new Set(value)].sort();
  }
  async function handle(method, pathname, input, p, params) {
    if (
      pathname !== "/api/im/enterprise/admin/apps" &&
      !pathname.startsWith("/api/im/enterprise/admin/apps/")
    )
      return undefined;
    authorizeAdmin(p);
    if (pathname === "/api/im/enterprise/admin/apps" && method === "GET") {
      const q = params.get("q") || "";
      if (q.length > 100)
        throw problem(422, "invalid_input", "检索词最多 100 字符");
      return {
        apps: catalog()
          .filter((entry) =>
            `${entry.id}\n${entry.name}`
              .toLocaleLowerCase()
              .includes(q.trim().toLocaleLowerCase()),
          )
          .map((entry) => appView(entry, p)),
      };
    }
    const match = pathname.match(
      /^\/api\/im\/enterprise\/admin\/apps\/([a-z][a-z0-9_-]{1,49})$/,
    );
    if (!match) throw problem(404, "not_found", "应用策略接口不存在");
    const entry = plugin(match[1]),
      previous = policy(entry.id);
    if (method === "GET") return { app: appView(entry, p) };
    if (method !== "PATCH")
      throw problem(405, "method_not_allowed", "不支持此应用策略操作");
    if (!Number.isSafeInteger(input.base_revision))
      throw problem(422, "version_required", "请提供 base_revision");
    if (input.base_revision !== previous.revision)
      throw problem(409, "conflict", "企业应用策略已变化，请读取最新版本");
    if (
      Object.keys(input).some(
        (key) =>
          ![
            "base_revision",
            "enabled",
            "scope_mode",
            "allowed_principal_ids",
            "allowed_department_ids",
            "denied_principal_ids",
          ].includes(key),
      ) ||
      typeof input.enabled !== "boolean"
    )
      throw problem(
        422,
        "invalid_app_policy",
        "应用策略只允许启用开关与明确可用范围",
      );
    const scope_mode =
      input.scope_mode ??
      (input.allowed_principal_ids !== undefined ||
      input.allowed_department_ids !== undefined
        ? "restricted"
        : previous.scope_mode);
    if (!["all", "restricted"].includes(scope_mode))
      throw problem(
        422,
        "invalid_app_policy",
        "范围模式必须为 all 或 restricted",
      );
    const value = {
      enabled: input.enabled,
      scope_mode,
      allowed_principal_ids: ids(
        input.allowed_principal_ids,
        "allowed_principal_ids",
        previous.allowed_principal_ids,
      ),
      allowed_department_ids: ids(
        input.allowed_department_ids,
        "allowed_department_ids",
        previous.allowed_department_ids,
      ),
      denied_principal_ids: ids(
        input.denied_principal_ids,
        "denied_principal_ids",
        previous.denied_principal_ids,
      ),
      revision: previous.revision + 1,
      updated_at: stamp(),
      updated_by: p.id,
    };
    if (
      CORE.has(entry.id) &&
      (!value.enabled ||
        value.scope_mode !== "all" ||
        value.allowed_principal_ids.length ||
        value.allowed_department_ids.length ||
        value.denied_principal_ids.length)
    )
      throw problem(
        409,
        "app_policy_protected",
        "核心设置与企业管理入口必须保留全员恢复路径",
      );
    policies[entry.id] = value;
    audit(p, "application.policy_updated", "application", entry.id, {
      before: copy(previous),
      after: copy(value),
    });
    const audience = state.principals
      .filter((entry) => !entry.revoked_at && !entry.disabled_at)
      .map((entry) => entry.id);
    if (audience.length)
      publishPersonalEvent(
        "application.policy_changed",
        p.id,
        { plugin_id: entry.id, revision: value.revision },
        audience,
      );
    changed(p.id);
    persist();
    return { app: appView(entry, p) };
  }
  return {
    allowed,
    effective,
    presentation,
    requirePlugins,
    routePlugins,
    eventAllowed,
    handle,
    contextAllowed: (pid) => CONTEXT_PLUGINS.every((id) => allowed(id, pid)),
    requireMeeting: (p) => requirePlugins(MEETING_PLUGINS, p),
  };
}
module.exports = { createNativeAppPolicies, CONTEXT_PLUGINS, MEETING_PLUGINS };
