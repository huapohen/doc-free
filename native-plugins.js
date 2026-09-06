"use strict";

// The registry declares discoverable features and personal preferences. It is
// never an authority source or an arbitrary remote-code/HTTP execution engine.
const { problem, requireText } = require("./work-protocol");
const copy = (value) => JSON.parse(JSON.stringify(value));
const own = (object, key) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const cap = (id, name, authorization) => ({ id, name, authorization });
const BUILTINS = [
  {
    id: "im",
    name: "原生消息",
    description: "身份、联系人、会话与持久消息",
    capabilities: [
      cap("im.identity", "独立身份与会话", "authenticated_self"),
      cap("im.contacts", "个人通讯录", "authenticated_self"),
      cap("im.rooms", "会话与成员管理", "current_member_or_owner"),
      cap("im.messages", "消息、搜索与回放", "current_member"),
      cap("im.agents", "Agent 同事与参与策略", "self_or_room_owner"),
      cap("im.attachments", "受控附件", "current_member"),
    ],
  },
  {
    id: "docs",
    name: "协作文档",
    description: "人和 Agent 共同可见的版本化文档",
    capabilities: [
      cap(
        "docs.documents",
        "读取、编辑与导出文档",
        "current_member_and_document_binding",
      ),
    ],
  },
  {
    id: "tasks",
    name: "共享任务",
    description: "版本化任务、负责人和交付",
    capabilities: [cap("tasks.tasks", "共享任务管理", "current_member")],
  },
  {
    id: "meetings",
    name: "会议",
    description: "预约、共同纪要和 WebRTC 信令",
    capabilities: [
      cap("meetings.meetings", "会议协调", "current_member_or_meeting_creator"),
      cap(
        "meetings.media",
        "短期媒体会话与信令",
        "current_member_and_own_media_session",
      ),
    ],
  },
  {
    id: "calendar",
    name: "日历",
    description: "共享日程和本人邀请回应",
    capabilities: [
      cap(
        "calendar.events",
        "日程管理与回应",
        "current_member_and_creator_or_attendee",
      ),
    ],
  },
  {
    id: "workbench",
    name: "工作台",
    description: "可用办公应用与个人收藏",
    capabilities: [
      cap(
        "workbench.preferences",
        "工作台目录与个人收藏",
        "authenticated_self",
      ),
    ],
  },
  {
    id: "attendance",
    name: "考勤",
    description: "本人打卡与可审计补卡",
    capabilities: [
      cap("attendance.records", "本人打卡与历史", "self_or_room_owner"),
      cap("attendance.corrections", "补卡申请", "self_with_named_approver"),
    ],
  },
  {
    id: "approvals",
    name: "审批",
    description: "私密申请、指定审批人和审计导出",
    capabilities: [
      cap(
        "approvals.requests",
        "审批申请与导出",
        "requester_named_approver_or_room_owner",
      ),
      cap("approvals.decisions", "审批决定", "named_approver_only"),
    ],
  },
  {
    id: "mail",
    name: "工作区邮件",
    description: "内部投递与个人邮箱",
    capabilities: [cap("mail.messages", "内部草稿、投递与邮箱", "own_mailbox")],
  },
  {
    id: "settings",
    name: "设置",
    description: "版本化个人偏好与插件配置",
    capabilities: [
      cap("settings.preferences", "个人设置", "authenticated_self"),
      cap("settings.plugins", "插件发现与个人开关", "authenticated_self"),
    ],
  },
  {
    id: "enterprise",
    name: "企业管理",
    description: "单工作区组织、固定角色、部门与脱敏管理审计",
    capabilities: [
      cap("enterprise.identity", "本人企业成员身份", "authenticated_self"),
      cap("enterprise.overview", "企业管理概览", "enterprise_admin_or_owner"),
      cap(
        "enterprise.members",
        "成员状态与部门归属",
        "enterprise_admin_for_members_owner_for_roles",
      ),
      cap(
        "enterprise.departments",
        "部门层级管理",
        "enterprise_admin_or_owner",
      ),
      cap("enterprise.roles", "固定角色能力目录", "enterprise_admin_or_owner"),
      cap(
        "enterprise.apps",
        "企业应用启用与成员可用范围",
        "enterprise_admin_or_owner",
      ),
      cap(
        "enterprise.audit",
        "管理审计与文档导出",
        "enterprise_admin_or_owner",
      ),
    ],
  },
].map((entry) => ({
  ...entry,
  builtin: true,
  kind: "builtin",
  available: true,
  revision: 1,
  config_schema: {},
}));
const forbiddenKey =
  /(?:password|secret|token|authorization|credential|api.?key)/i;
const identifier = /^[a-z][a-z0-9_-]{1,49}$/;

function createNativePlugins({
  state,
  stamp,
  persist,
  publishPersonalEvent,
  enterprisePolicy = () => ({
    enterprise_allowed: true,
    enterprise_policy_revision: 1,
    enterprise_policy_reason: "allowed",
  }),
}) {
  state.plugins ||= { registered: [], preferences: {} };
  const store = state.plugins;
  if (
    !Array.isArray(store.registered) ||
    !object(store.preferences) ||
    store.registered.some(
      (entry) =>
        !identifier.test(entry.id) ||
        !Array.isArray(entry.capabilities) ||
        !object(entry.config_schema) ||
        entry.builtin !== false ||
        entry.available !== false,
    )
  )
    throw new Error(
      "Plugin state is corrupt; refusing to initialize an empty registry",
    );

  function schema(value = {}) {
    if (!object(value) || Object.keys(value).length > 20)
      throw problem(
        422,
        "invalid_plugin_schema",
        "插件配置最多包含 20 个声明字段",
      );
    const result = {};
    for (const [key, descriptor] of Object.entries(value)) {
      if (
        !identifier.test(key) ||
        forbiddenKey.test(key) ||
        !object(descriptor) ||
        !["string", "boolean", "number"].includes(descriptor.type) ||
        Object.keys(descriptor).some(
          (key) => !["type", "label", "default", "enum"].includes(key),
        )
      )
        throw problem(
          422,
          "invalid_plugin_schema",
          "配置字段必须声明基本类型，凭据不能存入插件配置",
        );
      const clean = {
        type: descriptor.type,
        label: requireText(descriptor.label || key, "label", 100),
      };
      if (descriptor.enum !== undefined) {
        if (
          !Array.isArray(descriptor.enum) ||
          !descriptor.enum.length ||
          descriptor.enum.length > 30
        )
          throw problem(422, "invalid_plugin_schema", "枚举需要 1–30 个基本值");
        clean.enum = descriptor.enum.map((value) => configValue(value, clean));
      }
      if (descriptor.default !== undefined)
        clean.default = configValue(descriptor.default, clean);
      result[key] = clean;
    }
    return result;
  }
  function configValue(value, descriptor) {
    if (
      typeof value !== descriptor.type ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length > 1000) ||
      (descriptor.enum && !descriptor.enum.includes(value))
    )
      throw problem(
        422,
        "invalid_plugin_config",
        "插件配置值不符合声明类型或枚举",
      );
    return value;
  }
  function manifest(input) {
    if (
      !object(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            "id",
            "name",
            "description",
            "kind",
            "capabilities",
            "config_schema",
            "adapter",
          ].includes(key),
      ) ||
      !identifier.test(input.id) ||
      BUILTINS.some((entry) => entry.id === input.id) ||
      !["integration", "hardware"].includes(input.kind)
    )
      throw problem(
        422,
        "invalid_plugin_manifest",
        "扩展插件需要独立标识、名称和 integration/hardware 类型",
      );
    if (
      !Array.isArray(input.capabilities) ||
      input.capabilities.length > 32 ||
      !input.capabilities.length
    )
      throw problem(422, "invalid_plugin_manifest", "插件需要声明 1–32 项能力");
    const capabilities = input.capabilities.map((entry) => {
      if (
        !object(entry) ||
        Object.keys(entry).some((key) => !["id", "name"].includes(key)) ||
        typeof entry.id !== "string" ||
        !entry.id.startsWith(input.id + ".") ||
        !/^[a-z][a-z0-9_.-]{2,99}$/.test(entry.id)
      )
        throw problem(
          422,
          "invalid_plugin_manifest",
          "能力标识必须位于本插件命名空间",
        );
      return cap(
        entry.id,
        requireText(entry.name, "capability.name", 100),
        "adapter_not_connected",
      );
    });
    if (
      new Set(capabilities.map((entry) => entry.id)).size !==
      capabilities.length
    )
      throw problem(422, "invalid_plugin_manifest", "能力标识不能重复");
    let adapter = null;
    if (input.adapter !== undefined) {
      if (
        !object(input.adapter) ||
        Object.keys(input.adapter).some(
          (key) => !["transport", "endpoint"].includes(key),
        ) ||
        !["api", "mcp", "a2a", "device"].includes(input.adapter.transport)
      )
        throw problem(
          422,
          "invalid_plugin_manifest",
          "适配器仅声明 api/mcp/a2a/device 传输",
        );
      adapter = { transport: input.adapter.transport };
      if (input.adapter.endpoint !== undefined) {
        let url;
        try {
          url = new URL(requireText(input.adapter.endpoint, "endpoint", 2000));
        } catch {}
        if (
          !url ||
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw problem(
            422,
            "invalid_plugin_manifest",
            "端点须为不含凭据、查询参数和片段的 HTTP(S) URL",
          );
        adapter.endpoint = url.href;
      }
    }
    return {
      id: input.id,
      name: requireText(input.name, "name", 100),
      description:
        input.description === undefined
          ? ""
          : requireText(input.description, "description", 1000),
      kind: input.kind,
      builtin: false,
      available: false,
      capabilities,
      config_schema: schema(input.config_schema),
      adapter,
    };
  }
  function all() {
    return [...BUILTINS, ...store.registered];
  }
  function find(id) {
    const plugin = all().find((entry) => entry.id === id);
    if (!plugin) throw problem(404, "not_found", "插件不存在");
    return plugin;
  }
  function view(plugin, pid) {
    const preference = own(store.preferences[pid] || {}, plugin.id)
      ? store.preferences[pid][plugin.id]
      : null;
    const config = {};
    for (const [key, descriptor] of Object.entries(plugin.config_schema))
      if (preference && own(preference.config, key)) {
        try {
          config[key] = configValue(preference.config[key], descriptor);
        } catch {
          if (descriptor.default !== undefined)
            config[key] = descriptor.default;
        }
      } else if (descriptor.default !== undefined)
        config[key] = descriptor.default;
    const governance = enterprisePolicy(plugin.id, pid);
    return {
      ...copy(plugin),
      manifest_revision: plugin.revision,
      ...governance,
      effective_enabled:
        (preference?.enabled ?? plugin.builtin) &&
        governance.enterprise_allowed &&
        governance.dependencies_allowed !== false &&
        plugin.available,
      revision: preference?.revision || 1,
      enabled: preference?.enabled ?? plugin.builtin,
      config,
      updated_at: preference?.updated_at || null,
      configuration_scope: "principal_preference",
      execution: plugin.builtin ? "native_authorized_handler" : "not_connected",
    };
  }
  function pluginExport(pid) {
    const plugins = all().map((entry) => view(entry, pid));
    return (
      "# 可见插件配置\n\n个人开关不授予权限；扩展适配器仅登记，未连接执行。\n\n" +
      plugins
        .map(
          (entry) =>
            `## ${entry.name}\n\n标识：${entry.id}；个人启用：${entry.enabled}；企业允许：${entry.enterprise_allowed}；实际可用：${entry.effective_enabled}；企业策略版本：${entry.enterprise_policy_revision}；受限依赖：${(entry.blocked_dependency_ids || []).join(", ") || "无"}；配置版本：${entry.revision}；声明版本：${entry.manifest_revision}\n\n${entry.description}\n\n` +
            entry.capabilities
              .map(
                (capability) =>
                  `- ${capability.id}：${capability.name}；权限：${capability.authorization}`,
              )
              .join("\n") +
            "\n\n配置：\n\n```json\n" +
            JSON.stringify(entry.config, null, 2).replace(/`/g, "\\u0060") +
            "\n```",
        )
        .join("\n\n")
    );
  }
  async function handleAdmin(method, pathname, input) {
    if (pathname === "/api/im/admin/plugins" && method === "GET")
      return { plugins: copy(all()) };
    if (pathname === "/api/im/admin/plugins" && method === "POST") {
      const clean = manifest(input.manifest);
      const existing = store.registered.find((entry) => entry.id === clean.id);
      if (existing && input.base_revision !== existing.revision)
        throw problem(409, "conflict", "插件声明已变化，请读取最新版本");
      if (!existing && store.registered.length >= 100)
        throw problem(409, "limit_reached", "扩展插件已达本地预览上限");
      const plugin = {
        ...clean,
        revision: (existing?.revision || 0) + 1,
        created_at: existing?.created_at || stamp(),
        updated_at: stamp(),
      };
      if (existing) Object.assign(existing, plugin);
      else store.registered.push(plugin);
      persist();
      return { plugin: copy(plugin) };
    }
    return undefined;
  }
  async function handle(method, pathname, input, p) {
    if (pathname === "/api/im/plugins" && method === "GET")
      return { plugins: all().map((entry) => view(entry, p.id)) };
    if (pathname === "/api/im/plugins/export" && method === "GET")
      return pluginExport(p.id);
    if (pathname === "/api/im/capabilities" && method === "GET")
      return {
        protocol: "active-im/v1",
        identity_model: "human_agent_equal",
        configuration_scope: "principal_preference",
        capabilities: all().flatMap((plugin) => {
          const configured = view(plugin, p.id);
          return plugin.capabilities.map((capability) => ({
            ...capability,
            plugin_id: plugin.id,
            enabled: configured.enabled,
            available: plugin.available,
            execution: configured.execution,
            enterprise_allowed: configured.enterprise_allowed,
            enterprise_policy_revision: configured.enterprise_policy_revision,
            effective_enabled: configured.effective_enabled,
          }));
        }),
      };
    const match = pathname.match(
      /^\/api\/im\/plugins\/([a-z][a-z0-9_-]{1,49})$/,
    );
    if (!match) return undefined;
    const plugin = find(match[1]),
      previous = view(plugin, p.id);
    if (method === "GET") return { plugin: previous };
    if (method !== "PATCH")
      throw problem(405, "method_not_allowed", "不支持此插件操作");
    if (input.base_revision !== previous.revision)
      throw problem(409, "conflict", "个人插件配置已变化，请读取最新版本");
    if (
      Object.keys(input).some(
        (key) => !["base_revision", "enabled", "config"].includes(key),
      ) ||
      (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
      (input.config !== undefined && !object(input.config))
    )
      throw problem(
        422,
        "invalid_plugin_config",
        "只支持个人启用开关和声明过的配置字段",
      );
    const config = { ...previous.config };
    for (const [key, value] of Object.entries(input.config || {})) {
      if (!own(plugin.config_schema, key))
        throw problem(
          422,
          "invalid_plugin_config",
          "配置字段未在插件声明中定义",
        );
      config[key] = configValue(value, plugin.config_schema[key]);
    }
    store.preferences[p.id] ||= {};
    store.preferences[p.id][plugin.id] = {
      enabled: input.enabled ?? previous.enabled,
      config,
      revision: previous.revision + 1,
      updated_at: stamp(),
    };
    publishPersonalEvent(
      "plugin.configured",
      p.id,
      { plugin_id: plugin.id, revision: previous.revision + 1 },
      [p.id],
    );
    persist();
    return { plugin: view(plugin, p.id) };
  }
  return { handle, handleAdmin, catalog: () => copy(all()) };
}
module.exports = { createNativePlugins, BUILTINS };
