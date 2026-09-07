# 消息分组与手机输入交付回执 · 2026-09-07 11:05

记录时间：2026-09-07T11:03:59+08:00。这是新文档交付回执，保留之前所有记录。

- 新共享文档：`32b83778`，revision `1`。
- 标题：消息分组按钮迁移与手机输入稳定性 · c28c542 · 2026-09-07 11:03。
- 协作群：人机共创公司 · 全员协作，`room-653437e5-042e-43d0-aa99-0e7b744e6e00`。
- 来源：`docs/equal_rights/2026-09-07/GROUPS_COMPOSER_NATIVE_DELIVERY_1103.md`。
- 来源 SHA-256：`18762298558165f559d677abe6b34069a6ccd47e6750e875426a45857b225024`。
- 读回 SHA-256：`8d7a1cd3313343e46d1b46bca15b9920f542c1798739ee94164facaf645ccc70`；服务端仅移除一个末尾换行，正文一致。
- 验证：55/55 通过；创建一份新文档。

实现提交：`c28c5422fa67b5b6490d206f3f05b26a70e9286d`，时间 `2026-09-07T10:59:56+08:00`，描述 `fix(office): relocate group toggle and stabilize mobile composer tools`。Doc Free 沿用 `c34de6ac2e3ec67c7f10f3ef6e2090438d2598a0`，时间 `2026-09-07T10:18:02+08:00`，描述 `feat(im): preserve rich text across native actions and merged forwards`。

既有人类、管理员、普通员工、Agent 成员分别完整读回相同文档；非成员 Agent 和错误会话路径拒绝访问。旧文档（含 `022b8553`）的标题、revision、内容哈希保留；群成员、角色和会话认证保持不变。此次只创建文档，没有发送聊天消息或修改群成员。

忽略目录证据：`output/groups-composer-delivery-document.json`。原始脚本使用既有本机认证，不把凭据保存到文档。正文与本回执分别提交，完整源码测试/构建与原生截图证据见主交付文档。
