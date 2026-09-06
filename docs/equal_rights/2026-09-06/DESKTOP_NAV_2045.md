# 桌面侧栏个人排序与移除协议 · 2026-09-06 20:45

记录时间：2026-09-06T20:45:56+08:00，Asia/Shanghai。

本批独立于 20:35 的折叠与广播实现。代码基线为 `b8747976dc37a68eedd199a76054a33a53a1d978`（2026-09-06T20:35:03+08:00）；上批协议说明已单独保存为文档提交 `38b65df37f8f25f0c4506d1a052c26a0d50273cc`（2026-09-06T20:42:00+08:00）。写入本记录时桌面导航代码尚待汇总提交，不能将上述旧提交号当作本批实现版本。

## 新增个人设置

`GET /api/im/settings` 新增 `settings.desktop_nav`，默认顺序为：

```json
[
  "messages", "agents", "contacts", "docs", "tasks", "workbench",
  "meetings", "calendar", "mail", "attendance", "approvals", "minutes"
]
```

该数组表示当前身份桌面侧栏的通用功能及顺序。允许 **1–12 个唯一有效 ID**，可以移除“消息”或“Agent”，也可以把它们移到其它位置，没有固定首项。

“设置”和“更多”由桌面客户端固定追加，不存入数组；`settings`、`more` 均为非法设置值。`enterprise` 同样不属于桌面数组，企业管理入口仍由客户端在“我的”中按真实权限显示。

写入沿用原生设置接口与本人修订号：

```json
{
  "base_revision": 7,
  "desktop_nav": ["mail", "docs", "contacts"]
}
```

成功返回完整 `settings` 和新的 `revision`；缺少或过期版本返回 `409 conflict`。空数组、重复 ID、13 项、非数组、非字符串 ID、未知 ID、管理入口和固定追加入口都返回 `422 unsupported_setting`，同一请求的其它设置不部分写入。

## 与手机和权限的关系

- `desktop_nav` 与既有 `mobile_nav` 的值独立：改变桌面不会重新排序手机，改变手机也不会覆盖桌面。
- 两者仍属于同一身份的设置文档，共享一个 `settings.revision`。两个设备用相同旧版本分别修改桌面和手机时，只能一个写入成功，另一个须重新读取当前设置后处理冲突。
- `mobile_nav` 原有 1–4 项、已有有效 ID（包括 `enterprise`）和客户端追加“更多”的行为保持不变。
- 人类与 Agent 使用同一接口及校验；设置更新事件仅面向本人，不接受目标身份字段。
- 从侧栏移除一个功能不会撤销其接口权限；把一个功能加入侧栏也不能绕过企业应用禁用或管理权限。导航偏好不是授权配置。

旧存储读取时仅在返回视图补默认桌面顺序，不写文件、不重置既有设置、不改变 `revision` 或 `updated_at`。设置输入数组会复制；完整设置返回 `structuredClone`，默认值、持久设置、手机数组和桌面数组都不会被进程内调用者通过返回对象修改。

## MCP

沿用 `office_settings` / `office_update_settings`，不增加另一套身份或保存端点。写入工具新增：

```json
{
  "desktop_nav": {
    "type": "array",
    "minItems": 1,
    "maxItems": 12,
    "uniqueItems": true,
    "items": {"type": "string", "enum": ["messages", "agents", "contacts", "docs", "tasks", "workbench", "meetings", "calendar", "mail", "attendance", "approvals", "minutes"]}
  }
}
```

同一次 MCP 写入需要当前 `base_revision`，权限、冲突与原子校验和 HTTP 一致。

## 验证

新增 `tests/native-desktop-nav.test.js` 的 **5 项测试**，覆盖旧六字段设置只读迁移、桌面增减/重排和重启、手机独立与并发 CAS、个人事件、无效值原子拒绝、输入/返回深拷贝、Human/Agent MCP、导航不改变实际权限、双数组写入失败后的精确恢复。

桌面、手机和时间制针对回归 **12/12 通过**；后端全量 **257/257 通过，0 失败、0 跳过，12.92 秒**。日志为本机 `/tmp/doc-free-desktop-nav-full.log`。本后端批次没有修改 Active 客户端、重启服务、操作真实飞书或调用模型；桌面菜单的具体交互由客户端实现另行交付。
