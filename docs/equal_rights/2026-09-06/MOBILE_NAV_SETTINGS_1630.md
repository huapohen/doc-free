# 移动底栏：个人可编辑偏好

- 时间：2026-09-06T16:30:18+08:00。
- 分支：equal_rights；当前基线commit：ab9c613ef3c9ea2d57521daa68ef45bc3c7736c2，2026-09-06T16:16:03+08:00。
- 本文记录基线之后的工作区实现，最终提交由总发布记录关联。

GET `/api/im/settings`新增`settings.mobile_nav`，默认`["messages","agents","docs","workbench"]`。PATCH同一路径，提交当前全settings的`base_revision`和完整有序数组，即可添加、删除、替换或排序；1–4项、不可重复。前端固定追加“更多”作为全部功能入口，不存入数组，也不可通过配置移除。

本批支持messages、agents、docs、tasks、workbench、meetings、minutes、calendar、mail、attendance、approvals、contacts、enterprise；minutes随同批人机妙记模块增补。企业管理的实际可见/可选性由GET `/enterprise`的`capabilities.access_admin`决定，其他模块按实际应用范围判断。保存某ID仅保存偏好，不能授予业务权；偏好保留被暂时禁用的ID，客户端展示有效入口。

存储复用原IM状态的`personal_settings[principal_id]`。旧记录缺字段时读取默认数组，不写盘、不改变已有revision或其他偏好。人和Agent经同一身份API修改自己的配置，不能携带principal_id修改他人。非法类型、空数组、超过4项、重复、unknown或more返回422/unsupported_setting；旧revision返回409/conflict。一次PATCH中有非法字段时全部拒绝。输入/返回的数组均隔离复制。

原MCP `office_settings`与`office_update_settings`直接读写同一合同；后者schema声明数组长度、唯一性和语义ID，不新增协议或平行设置服务。settings.updated个人事件、单次持久化与存储失败fail-stop沿用现有实现。

验证：`node --test tests/native-mobile-nav.test.js tests/native-mail.test.js tests/native-im-mcp.test.js`，13/13通过。其中4个新增测试覆盖旧记录默认与增删排序、重启持久化、原子拒绝和数组隔离、人/Agent MCP与权限不升级、存储故障后旧偏好恢复。临时fixture无模型调用、无用户服务操作。前端CAS冲突处理、移动选择界面和实际布局由UI验收另记。
