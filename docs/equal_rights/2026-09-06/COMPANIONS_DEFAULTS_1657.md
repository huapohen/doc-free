# 机伴目录与默认人机好友

- 时间：2026-09-06T16:57:00+08:00。
- 分支：`equal_rights`。
- 基线 commit：`ab9c613ef3c9ea2d57521daa68ef45bc3c7736c2`，`2026-09-06T16:16:03+08:00`。
- 描述该基线之后本批实现，最终提交由总发布记录关联；设备执行运行时和 UI 验收另记。

## 默认两位同事与其他 Agent 的关系

人类账号的默认 Agent 好友是 **activate-agent** 与 **机伴**。前者是入门协作同事，并非唯一能主动工作的 Agent；所有 Agent 身份和商店模板都返回 `proactive_capable: true`。真实参与范围仍由其所在会话、企业应用策略、当前 mode 和 autonomy 决定。默认好友不会自动加入任何会话，也不取得管理员权限。

每个工作区创建或采用同一对真实身份，用 `system_agent_key` 分别标记 `activate-agent` 和 `desktop-companion`；`template_source` 为 `system_default`。activate-agent 使用内置入门配方，不增加一个商店模板；机伴使用 desktop-companion 配方。商店保留原 100 职业模板并增加 desktop-companion / mobile-companion，因此可安装目录为 **102** 项。用户单独安装机伴仍沿用按所有者隔离的专属同事；该身份与工作区共享默认机伴各自真实存在，不互相冒充。

新建默认同事为 `managed: true`，凭据沿用现有 managedToken 派生机制，仅管理端 `/admin/workers` 给本机 fleet 提供独立机器凭据；不会返回给人类目录/好友 API。未加入工作会话时 `runnable_room_count` 为 0。加入获准且未暂停的会话后，fleet 可按原机制运行该身份。该机制让默认同事能参与现有原生工具，不证明任何设备控制运行时已经安装。

## 初始化与历史保留

首次人类 `GET /api/im/contacts` 或 `GET /api/im/agents` 在现有串行事务里创建缺失的系统身份、添加当前账号缺失的两个默认好友，然后保存 `default_colleagues.seeded_humans` 标记。后续读取不重复写盘。也可以调用 `POST /api/im/contacts/defaults`，空对象输入；MCP 为 `im_initialize_default_contacts`。Agent 自身不自动获得这对人类入门好友。

现有联系人不替换，用户移除默认好友后不反复补回；工作区管理员已停用或撤销的默认身份不被复活。容量不足不挤掉旧联系人，初始化状态会显示未完成。列表返回原有真实列表与：

```json
{
  "default_colleagues": {
    "version": 1,
    "status": "ready",
    "seeded": true,
    "colleagues": [
      {
        "template_id": "activate-agent",
        "principal_id": "principal-...",
        "name": "activate-agent",
        "status": "available",
        "in_contacts": true
      }
    ]
  }
}
```

实际 colleagues 包含两个描述。名称使用当前真实身份名称；`status` 可以区分未创建、停用或撤销。`GET /agents` 继续列出真实好友、自己安装的同事与同会话同事，并用 `relationship` 区分，不能把全工作区目录当作好友。`im_contacts` 与 `im_agents` 的 MCP `readOnlyHint` 为 false，因为首次人类读取包含受限的默认初始化。

旧的本机开发默认身份只能通过**确切 ID**采用。启动管理配置 `DOC_FREE_DEFAULT_ACTIVATE_ID` 传给 `createNativeIM({defaultActivateId})`，在 server.listen 前完成采用，避免已登录 App 的并发读取抢先创建另一个默认入门身份。`scripts/dev_office.py` 从已有私有 access 文件取 `agent.principal.id` 注入；环境变量只含身份 ID。新工作区 provision 创建开发身份后调用管理端 `POST /api/im/admin/default-colleagues`，输入 `{legacy_activate_agent_id}`，在界面初始化前采用它并补现有所有人类账号。

只有上述显式指定的旧内置身份、且其当前名称恰为旧默认名 `Active Agent` 时，显示名才迁为 `activate-agent`；自定义名称保持。现有人格 instructions、skills、机器 token、登录账号和会话均保留。采用的旧身份仍由 fleet 原有 `AA_IM_TOKEN` 的 local-primary 运行；不转换或轮换其旧机器凭据。缺少显式 ID 时不会按名字猜，普通自建名为 Active Agent 的身份保持历史。若已经建立另一个默认身份再请求采用，返回 409，避免静默替换已有关系和工作历史。

## 机伴能力元数据

模板 ID 和名称为 `desktop-companion` / **机伴**、`mobile-companion` / **机伴·手机**。职位、职业、技能和指令明确说明设备、异步输入及执行回执边界。`device_capabilities` 在商店模板和已安装/默认机伴 principal 视图均返回：

| 字段 | 合同 |
| --- | --- |
| `schema_version` | 1 |
| `template_only` | true；目录是能力描述，不是实时设备探测 |
| `installation_grants_device_access` | false |
| `input_policy` | isolated_session_only |
| `supported_modes` | 每项含 id、label、platforms、status、description |
| `unsupported_modes` | 每项含 id、label、platforms、reason |
| `runtime_requirements` | 实际运行时、设备授权、输入隔离和可见回执要求 |

原生协作模式 `native_collaboration` 为 `member_permissions_required`，仍要求实际 Agent worker。桌面 `isolated_browser` 和手机 `isolated_android_device` 为 `runtime_required`，声明接入方向而非安装成功或设备授权。独立浏览器输入可以不移动用户实体鼠标；任意跨桌面应用要用各应用专用接口、隔离桌面或虚拟机。独立 Android 设备/模拟器可以避免争抢用户当前手机，但本模板没有实现 ADB、无障碍执行器或触控运行时。

明确不支持的范围包括 `shared_desktop_focus`、`ios_cross_app`、`hardware_control`；手机模板另有 `shared_mobile_input`。普通系统桌面共享输入焦点，画第二个光标不等于第二套系统输入。普通 iOS 应用受沙箱约束，不能任意读写或控制其他应用；应用自己的 URL、快捷指令或授权接口需单独接入。未来硬件需要真实适配器、设备协议及授权。本批没有运行 OS 控制 runner、移动实体鼠标、跨应用点击或添加虚假全局输入接口。

机伴指令要求先核对实际运行时能力，缺运行时则返回未连接并留下可见计划。聊天文字和模板描述不能被当作已点击、已输入、已控制设备的回执。

## 人格中的主动开关

现有 `PATCH /api/im/rooms/:room_id/participation` 继续按当前会话配置所有 Agent：`mode` 的 active/mentions/paused 决定参与触发；`autonomy.enabled` 控制工具执行与定时复核，关闭不等于移除身份或改变其他群设置。没有新增全局人格端点，前端应明确显示当前工作会话。

autonomy 修改强制 `base_revision`；本批补齐 mode-only 请求若携带 base_revision 也必须 CAS 匹配。成功响应的 `room_revision` 可用于下一次保存。旧客户端不传 revision 的单纯 mode 修改保留兼容。主动作开关不授予工具范围以外的设备访问或越权能力。

## 验证

新增 `tests/native-default-colleagues.test.js` 六项，覆盖102模板原目录保留、设备元数据不冒充运行时、默认好友与删除/重启、真实独立fleet凭据和获邀会话claim、启动前精确采用保留旧凭据/自定义人格/其他同名身份、撤销不复活与落盘失败恢复、mode和autonomy分离的CAS。测试中的 claim 仅进入原生运行状态，不调用真实模型或设备工具。

必要回归命令：

```sh
node --test tests/native-default-colleagues.test.js tests/native-actions.test.js tests/native-plugins.test.js tests/native-im.test.js tests/native-im-mcp.test.js
python3 -m unittest tests.test_company_scripts tests.test_im_fleet
```

Node 必要回归 **44/44** 通过；Python 回归 **7/7** 通过，dev_office 语法编译通过。收尾补充“已采用默认身份被撤销后，保留启动 ID 仍能重启且不复活”的验证，修正该边界后相关专项 **6/6** 再次通过。首轮 Node 43/44，唯一失败为旧测试仍期待人类没有默认好友，已按新增行为调整并重跑同一范围通过，不改变隔离断言。所有验证使用临时 fixture，没有操作用户实例、读取或输出真实凭据、运行模型或调用设备控制。

提交前完成 `npm test` 全量 Node 验证：**210/210 通过，0 失败、0 跳过**，包含原 193 项及本批移动菜单 4 项、妙记 7 项、默认同事 6 项。真实 HTTP、CRDT、MCP、A2A 回归使用隔离进程和临时数据，不操作已登录用户服务。
