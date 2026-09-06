"use strict";

// One deployment is one enterprise workspace. Enterprise roles are a separate
// authority domain from conversation ownership and never depend on human/agent.
const crypto = require("node:crypto");
const { problem, requireText } = require("./work-protocol");
const copy = (value) => JSON.parse(JSON.stringify(value));
const own = (object, key) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
const roles = ["owner", "admin", "member"];
const status = (person) =>
  person.revoked_at ? "revoked" : person.disabled_at ? "disabled" : "active";
const flags = (role) => ({
  access_admin: role !== "member",
  manage_members: role !== "member",
  manage_departments: role !== "member",
  manage_organizations: role !== "member",
  manage_apps: role !== "member",
  assign_admin: role === "owner",
  assign_owner: role === "owner",
  view_audit: role !== "member",
  manage_enterprise: role === "owner",
});
const ROLES = roles.map((id) => ({
  id,
  name: { owner: "企业所有者", admin: "企业管理员", member: "普通成员" }[id],
  capabilities: flags(id),
}));
function createNativeEnterprise({
  state,
  stamp,
  persist,
  active,
  onDisabled,
  onRevoked,
  publishPersonalEvent,
  onMembershipChanged = () => {},
}) {
  state.enterprise ||= {
    id: "enterprise-workspace",
    name: "当前工作空间",
    revision: 1,
    initialized: false,
    created_at: stamp(),
    updated_at: stamp(),
    memberships: {},
    departments: [],
    audit: [],
    sequence: 0,
  };
  const enterprise = state.enterprise;
  enterprise.create_keys ||= {};
  enterprise.department_keys ||= {};
  enterprise.organizations ||= [];
  enterprise.organization_keys ||= {};
  if (
    !enterprise.memberships ||
    typeof enterprise.memberships !== "object" ||
    Array.isArray(enterprise.memberships) ||
    !Array.isArray(enterprise.departments) ||
    !Array.isArray(enterprise.organizations) ||
    !Array.isArray(enterprise.audit) ||
    !Number.isSafeInteger(enterprise.sequence) ||
    !Number.isSafeInteger(enterprise.revision) ||
    enterprise.revision < 1 ||
    Object.values(enterprise.memberships).some(
      (entry) =>
        !entry ||
        !roles.includes(entry.role) ||
        !Number.isSafeInteger(entry.revision) ||
        entry.revision < 1,
    )
  )
    throw new Error(
      "Enterprise state is corrupt; refusing to reset organization authority",
    );
  function record(pid) {
    if (!own(enterprise.memberships, pid))
      enterprise.memberships[pid] = {
        principal_id: pid,
        role: "member",
        department_id: null,
        revision: 1,
      };
    const membership = enterprise.memberships[pid];
    membership.organization_id ??= null;
    membership.profession ??= "";
    membership.job_title ??= "";
    return membership;
  }
  // The only migration is ordinary membership; a room owner or a managed Agent
  // owner is never silently promoted to enterprise administration.
  for (const person of state.principals) record(person.id);
  function enterpriseView() {
    return {
      id: enterprise.id,
      name: enterprise.name,
      revision: enterprise.revision,
      initialized: enterprise.initialized,
      created_at: enterprise.created_at,
      updated_at: enterprise.updated_at,
      scope: "single_workspace",
    };
  }
  function person(pid) {
    const found = state.principals.find((entry) => entry.id === pid);
    if (!found) throw problem(404, "not_found", "企业成员不存在");
    return found;
  }
  function memberView(entry) {
    const membership = record(entry.id),
      department = enterprise.departments.find(
        (item) => item.id === membership.department_id,
      );
    return {
      id: entry.id,
      principal_id: entry.id,
      name: entry.name,
      kind: entry.kind,
      role: membership.role,
      status: status(entry),
      department_id: membership.department_id,
      department_name: department?.name || null,
      organization_id: membership.organization_id,
      organization_name: enterprise.organizations.find((item) => item.id === membership.organization_id)?.name || null,
      profession: membership.profession || entry.profession || "",
      job_title: membership.job_title || entry.job_title || "",
      source_organization_name: entry.source_organization_name || null,
      revision: membership.revision,
      created_at: entry.created_at,
      disabled_at: entry.disabled_at || null,
      revoked_at: entry.revoked_at || null,
    };
  }
  function ownView(p) {
    const membership = memberView(p);
    return {
      enterprise: enterpriseView(),
      membership,
      capabilities: flags(membership.role),
    };
  }
  function authorize(p, owner = false) {
    if (status(p) !== "active")
      throw problem(401, "unauthorized", "企业身份已停用");
    const role = record(p.id).role;
    if (role === "member" || (owner && role !== "owner"))
      throw problem(
        403,
        owner ? "enterprise_owner_required" : "enterprise_admin_required",
        owner ? "需要企业所有者权限" : "需要企业管理员权限",
      );
    return role;
  }
  function mayManage(p, target, input = {}, allowSelfName = false) {
    const role = authorize(p),
      targetRole = record(target.id).role;
    if (role === "admin") {
      const ownNameOnly =
        allowSelfName &&
        p.id === target.id &&
        Object.keys(input).every((key) =>
          ["base_revision", "name"].includes(key),
        );
      if (targetRole !== "member" && !ownNameOnly)
        throw problem(
          403,
          "enterprise_owner_required",
          "只有企业所有者能管理管理员或所有者",
        );
      if (input.role !== undefined && input.role !== targetRole)
        throw problem(
          403,
          "enterprise_owner_required",
          "只有企业所有者能分配企业角色",
        );
    }
    return role;
  }
  function guardOwner(pid, nextRole = "member", nextStatus = "revoked") {
    const current = person(pid);
    if (
      record(pid).role !== "owner" ||
      status(current) !== "active" ||
      (nextRole === "owner" && nextStatus === "active")
    )
      return;
    const liveOwners = state.principals.filter(
      (entry) =>
        status(entry) === "active" && record(entry.id).role === "owner",
    );
    if (liveOwners.length <= 1)
      throw problem(
        409,
        "last_enterprise_owner",
        "必须保留至少一位有效企业所有者",
      );
  }
  function version(input, current) {
    if (!Number.isSafeInteger(input.base_revision))
      throw problem(422, "version_required", "请提供 base_revision");
    if (input.base_revision !== current)
      throw problem(409, "conflict", "企业记录已变化，请读取最新版本");
  }
  function audit(actor, action, targetType, targetId, details = {}) {
    const entry = {
      id: `enterprise-audit-${crypto.randomUUID()}`,
      seq: ++enterprise.sequence,
      at: stamp(),
      actor_id: actor?.id || "bootstrap",
      actor_kind: actor?.kind || "bootstrap",
      action,
      target_type: targetType,
      target_id: targetId,
      details: copy(details),
    };
    enterprise.audit.push(entry);
    enterprise.audit = enterprise.audit.slice(-10000);
    return entry;
  }
  function notifyMember(pid, action, revision) {
    if (status(person(pid)) === "active")
      publishPersonalEvent(
        "enterprise.membership_changed",
        pid,
        { action, principal_id: pid, revision },
        [pid],
      );
  }
  function department(did) {
    const entry = enterprise.departments.find((item) => item.id === did);
    if (!entry) throw problem(422, "invalid_department", "部门不存在");
    return entry;
  }
  function departmentView(entry) {
    return {
      ...copy(entry),
      member_count: state.principals.filter(
        (person) => record(person.id).department_id === entry.id,
      ).length,
    };
  }
  function organization(oid) {
    const entry = enterprise.organizations.find((item) => item.id === oid);
    if (!entry) throw problem(422, "invalid_organization", "组织不存在");
    return entry;
  }
  function organizationView(entry) {
    return { ...copy(entry), member_count: state.principals.filter(
      (person) => record(person.id).organization_id === entry.id).length };
  }
  function optionalText(value, field, max = 100) {
    if (value === undefined || value === "") return "";
    return requireText(value, field, max);
  }
  function parentFor(value, self = null) {
    if (value === undefined || value === null) return null;
    let parent = department(value),
      seen = new Set(self ? [self] : []);
    while (parent) {
      if (seen.has(parent.id))
        throw problem(409, "department_cycle", "部门层级不能循环引用");
      seen.add(parent.id);
      parent = parent.parent_id === null ? null : department(parent.parent_id);
    }
    return value;
  }
  try {
    if (
      new Set(enterprise.departments.map((entry) => entry.id)).size !==
      enterprise.departments.length
    )
      throw new Error("duplicate");
    for (const entry of enterprise.departments) {
      if (!entry.id || !Number.isSafeInteger(entry.revision))
        throw new Error("invalid");
      parentFor(entry.parent_id, entry.id);
    }
    if (new Set(enterprise.organizations.map((entry) => entry.id)).size !== enterprise.organizations.length)
      throw new Error("duplicate organization");
    for (const entry of enterprise.organizations) {
      if (!/^organization-[a-f0-9-]+$/.test(entry.id) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 ||
          typeof entry.name !== "string" || !entry.name.trim() || typeof entry.description !== "string")
        throw new Error("invalid organization");
    }
    for (const entry of Object.values(enterprise.memberships)) {
      if (entry.department_id !== null) department(entry.department_id);
      if (entry.organization_id != null) organization(entry.organization_id);
      if (typeof entry.profession !== "string" || typeof entry.job_title !== "string") throw new Error("invalid profession");
    }
    if (
      enterprise.initialized &&
      !state.principals.some(
        (entry) =>
          status(entry) === "active" && record(entry.id).role === "owner",
      )
    )
      throw new Error("missing owner");
  } catch {
    throw new Error(
      "Enterprise state is corrupt; refusing invalid roles or department hierarchy",
    );
  }
  function pagination(params) {
    const page = Number(params.get("page") || 1),
      pageSize = Number(params.get("page_size") || 25);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      throw problem(422, "invalid_pagination", "分页参数无效");
    return { page, page_size: pageSize };
  }
  function paged(items, params, key) {
    const paging = pagination(params);
    return {
      [key]: items.slice(
        (paging.page - 1) * paging.page_size,
        paging.page * paging.page_size,
      ),
      total: items.length,
      ...paging,
    };
  }
  function query(params) {
    const q = params.get("q") || "";
    if (q.length > 100)
      throw problem(422, "invalid_input", "检索词最多 100 字符");
    return q.trim().toLocaleLowerCase();
  }
  function exportOrganization(p) {
    const value = {
      protocol: "active-im/v1",
      kind: "enterprise_administration",
      exported_at: stamp(),
      exported_by: p.id,
      enterprise: enterpriseView(),
      roles: copy(ROLES),
      members: state.principals.map(memberView),
      departments: enterprise.departments.map(departmentView),
      organizations: enterprise.organizations.map(organizationView),
      application_policies: copy(enterprise.app_policies || {}),
      audit: copy(enterprise.audit),
    };
    const json = JSON.stringify(value, null, 2),
      fence = "`".repeat(
        Math.max(
          3,
          ...[...json.matchAll(/`+/g)].map((entry) => entry[0].length + 1),
        ),
      );
    return `# ${enterprise.name} · 企业管理记录\n\n单工作区组织；角色、部门和管理审计对授权管理员可见。导出不含密码摘要、令牌、登录会话或模型凭据。\n\n${fence}active-enterprise\n${json}\n${fence}\n`;
  }
  async function handleAdmin(method, pathname, input) {
    if (pathname !== "/api/im/admin/enterprise/bootstrap" || method !== "POST")
      return undefined;
    const owner = active(input.principal_id),
      membership = record(owner.id);
    if (enterprise.initialized) {
      if (
        enterprise.bootstrap_principal_id === owner.id &&
        membership.role === "owner"
      )
        return { ...ownView(owner), duplicate: true };
      throw problem(
        409,
        "enterprise_initialized",
        "企业已有初始所有者，请使用企业角色管理",
      );
    }
    const name =
      input.name === undefined
        ? enterprise.name
        : requireText(input.name, "name", 100);
    enterprise.initialized = true;
    enterprise.bootstrap_principal_id = owner.id;
    enterprise.name = name;
    enterprise.revision++;
    enterprise.updated_at = stamp();
    membership.role = "owner";
    membership.revision++;
    audit(null, "enterprise.bootstrapped", "member", owner.id, {
      role: "owner",
      name,
    });
    notifyMember(owner.id, "role", membership.revision);
    persist();
    return { ...ownView(owner), duplicate: false };
  }
  async function handle(
    method,
    pathname,
    input,
    p,
    params = new URLSearchParams(),
  ) {
    if (pathname === "/api/im/enterprise" && method === "GET")
      return ownView(p);
    if (!pathname.startsWith("/api/im/enterprise/admin/")) return undefined;
    authorize(p);
    const route = pathname.slice("/api/im/enterprise/admin/".length);
    if (route === "overview" && method === "GET") {
      const members = state.principals.map(memberView);
      return {
        ...ownView(p),
        counts: {
          members: members.length,
          active: members.filter((entry) => entry.status === "active").length,
          disabled: members.filter((entry) => entry.status === "disabled")
            .length,
          revoked: members.filter((entry) => entry.status === "revoked").length,
          humans: members.filter((entry) => entry.kind === "human").length,
          agents: members.filter((entry) => entry.kind === "agent").length,
          departments: enterprise.departments.length,
          organizations: enterprise.organizations.length,
          owners: members.filter(
            (entry) => entry.role === "owner" && entry.status === "active",
          ).length,
          admins: members.filter(
            (entry) => entry.role === "admin" && entry.status === "active",
          ).length,
        },
      };
    }
    if (route === "export" && method === "GET") return exportOrganization(p);
    if (route === "profile" && method === "PATCH") {
      authorize(p, true);
      version(input, enterprise.revision);
      if (
        Object.keys(input).some(
          (key) => !["base_revision", "name"].includes(key),
        )
      )
        throw problem(422, "invalid_input", "只支持企业名称设置");
      const name = requireText(input.name, "name", 100),
        previous = enterprise.name;
      enterprise.name = name;
      enterprise.revision++;
      enterprise.updated_at = stamp();
      audit(p, "enterprise.updated", "enterprise", enterprise.id, {
        before: { name: previous },
        after: { name },
      });
      persist();
      return { enterprise: enterpriseView() };
    }
    if (route === "roles" && method === "GET") {
      const q = query(params);
      return {
        roles: copy(
          ROLES.filter((entry) =>
            `${entry.id}\n${entry.name}`.toLocaleLowerCase().includes(q),
          ),
        ),
      };
    }
    const roleRoute = route.match(/^roles\/(owner|admin|member)$/);
    if (roleRoute && method === "GET")
      return { role: copy(ROLES.find((entry) => entry.id === roleRoute[1])) };
    if (route === "audit" && method === "GET") {
      const q = query(params);
      return paged(
        [...enterprise.audit]
          .reverse()
          .filter((entry) =>
            JSON.stringify(entry).toLocaleLowerCase().includes(q),
          ),
        params,
        "entries",
      );
    }
    if (route === "members" && method === "GET") {
      const q = query(params),
        selectedStatus = params.get("status") || "all",
        selectedRole = params.get("role") || "all",
        did = params.get("department_id"),
        oid = params.get("organization_id");
      if (
        !["all", "active", "disabled", "revoked"].includes(selectedStatus) ||
        !["all", ...roles].includes(selectedRole)
      )
        throw problem(422, "invalid_filter", "无效成员筛选条件");
      if (did) department(did);
      if (oid) organization(oid);
      const members = state.principals
        .map(memberView)
        .filter(
          (entry) =>
            (!q ||
              `${entry.name}\n${entry.id}\n${entry.kind}\n${entry.profession}\n${entry.job_title}\n${entry.organization_name}\n${entry.department_name}`
                .toLocaleLowerCase()
                .includes(q)) &&
            (selectedStatus === "all" || entry.status === selectedStatus) &&
            (selectedRole === "all" || entry.role === selectedRole) &&
            (!did || entry.department_id === did) &&
            (!oid || entry.organization_id === oid),
        );
      return paged(members, params, "members");
    }
    if (route === "members" && method === "POST") {
      if (
        Object.keys(input).some(
          (key) =>
            !["name", "kind", "department_id", "organization_id", "profession", "job_title", "client_id"].includes(key),
        ) ||
        !["human", "agent"].includes(input.kind)
      )
        throw problem(
          422,
          "invalid_input",
          "新成员需要 name 和 human/agent 类型，角色默认普通成员",
        );
      const name = requireText(input.name, "name", 100),
        did = input.department_id ?? null,
        oid = input.organization_id ?? null,
        profession = optionalText(input.profession, "profession"),
        job_title = optionalText(input.job_title, "job_title"),
        clientId = requireText(input.client_id, "client_id", 160),
        key = `${p.id}:${clientId}`;
      const digest = crypto
        .createHash("sha256")
        .update(JSON.stringify({ name, kind: input.kind, department_id: did, organization_id: oid, profession, job_title }))
        .digest("hex");
      if (own(enterprise.create_keys, key)) {
        const receipt = enterprise.create_keys[key];
        const legacyDigest = crypto.createHash("sha256").update(JSON.stringify({ name, kind: input.kind, department_id: did })).digest("hex");
        if (receipt.hash !== digest && !(oid === null && !profession && !job_title && receipt.hash === legacyDigest))
          throw problem(
            409,
            "idempotency_conflict",
            "相同 client_id 对应不同创建请求",
          );
        return {
          member: memberView(person(receipt.id)),
          token: null,
          duplicate: true,
          credential_returned: false,
        };
      }
      if (state.principals.length >= 1000)
        throw problem(409, "limit_reached", "企业成员已达本地预览上限");
      if (did !== null) department(did);
      if (oid !== null) organization(oid);
      const token = crypto.randomBytes(32).toString("base64url"),
        principal = {
          id: `principal-${crypto.randomUUID()}`,
          name,
          kind: input.kind,
          token_hash: crypto.createHash("sha256").update(token).digest("hex"),
          created_at: stamp(),
        };
      state.principals.push(principal);
      const membership = record(principal.id);
      membership.department_id = did;
      membership.organization_id = oid;
      membership.profession = profession;
      membership.job_title = job_title;
      enterprise.create_keys[key] = { id: principal.id, hash: digest };
      audit(p, "member.created", "member", principal.id, {
        name,
        kind: principal.kind,
        role: "member",
        department_id: did, organization_id: oid, profession, job_title,
      });
      persist();
      return {
        member: memberView(principal),
        token,
        duplicate: false,
        credential_returned: true,
      };
    }
    const memberRoute = route.match(
      /^members\/(principal-[a-f0-9-]+)(?:\/(revoke))?$/,
    );
    if (memberRoute) {
      const target = person(memberRoute[1]),
        membership = record(target.id);
      if (!memberRoute[2] && method === "GET")
        return { member: memberView(target) };
      if (memberRoute[2] === "revoke" && method === "POST") {
        mayManage(p, target, input);
        version(input, membership.revision);
        guardOwner(target.id);
        if (status(target) === "revoked")
          return { member: memberView(target), duplicate: true };
        onRevoked(target, p.id);
        membership.revision++;
        audit(p, "member.revoked", "member", target.id);
        persist();
        return { member: memberView(target), duplicate: false };
      }
      if (memberRoute[2] || method !== "PATCH")
        throw problem(405, "method_not_allowed", "不支持此成员操作");
      mayManage(p, target, input, true);
      version(input, membership.revision);
      if (
        Object.keys(input).some(
          (key) =>
            ![
              "base_revision",
              "name",
              "role",
              "status",
              "department_id",
              "organization_id",
              "profession",
              "job_title",
            ].includes(key),
        ) ||
        (input.role !== undefined && !roles.includes(input.role)) ||
        (input.status !== undefined &&
          !["active", "disabled"].includes(input.status))
      )
        throw problem(422, "invalid_input", "无效成员管理字段");
      if (
        status(target) === "revoked" &&
        (input.status !== undefined || input.role !== undefined)
      )
        throw problem(409, "member_revoked", "已撤销身份不能恢复或重分配角色");
      const name =
          input.name === undefined
            ? target.name
            : requireText(input.name, "name", 100),
        nextRole = input.role ?? membership.role,
        nextStatus = input.status ?? status(target),
        did =
          input.department_id === undefined
            ? membership.department_id
            : input.department_id,
        oid = input.organization_id === undefined ? membership.organization_id : input.organization_id,
        profession = input.profession === undefined ? membership.profession : optionalText(input.profession, "profession"),
        job_title = input.job_title === undefined ? membership.job_title : optionalText(input.job_title, "job_title");
      if (did !== null) department(did);
      if (oid !== null) organization(oid);
      guardOwner(target.id, nextRole, nextStatus);
      const before = {
        name: target.name,
        role: membership.role,
        status: status(target),
        department_id: membership.department_id,
        organization_id: membership.organization_id, profession: membership.profession, job_title: membership.job_title,
      };
      target.name = name;
      membership.role = nextRole;
      membership.department_id = did;
      membership.organization_id = oid;
      membership.profession = profession;
      membership.job_title = job_title;
      membership.revision++;
      if (nextStatus === "disabled" && !target.disabled_at) {
        target.disabled_at = stamp();
        onDisabled(target, p.id);
      }
      if (nextStatus === "active" && target.disabled_at)
        delete target.disabled_at;
      audit(p, "member.updated", "member", target.id, {
        before,
        after: { name, role: nextRole, status: nextStatus, department_id: did, organization_id: oid, profession, job_title },
      });
      notifyMember(target.id, "updated", membership.revision);
      onMembershipChanged(p.id);
      persist();
      return { member: memberView(target) };
    }
    if (route === "departments" && method === "GET") {
      const q = query(params);
      return {
        departments: enterprise.departments
          .filter((entry) => entry.name.toLocaleLowerCase().includes(q))
          .map(departmentView),
      };
    }
    if (route === "departments" && method === "POST") {
      if (
        Object.keys(input).some(
          (key) => !["name", "parent_id", "client_id"].includes(key),
        )
      )
        throw problem(422, "invalid_input", "无效部门字段");
      const name = requireText(input.name, "name", 100),
        clientId = requireText(input.client_id, "client_id", 160),
        key = `${p.id}:${clientId}`;
      const digest = crypto
        .createHash("sha256")
        .update(JSON.stringify({ name, parent_id: input.parent_id ?? null }))
        .digest("hex");
      if (own(enterprise.department_keys, key)) {
        const receipt = enterprise.department_keys[key];
        if (receipt.hash !== digest)
          throw problem(
            409,
            "idempotency_conflict",
            "相同 client_id 对应不同创建部门请求",
          );
        const existing = enterprise.departments.find(
          (entry) => entry.id === receipt.id,
        );
        if (!existing)
          throw problem(
            409,
            "operation_target_removed",
            "原部门已删除，不能通过重试重新创建",
          );
        return { department: departmentView(existing), duplicate: true };
      }
      if (enterprise.departments.length >= 200)
        throw problem(409, "limit_reached", "部门已达本地预览上限");
      const parent_id = parentFor(input.parent_id);
      if (
        enterprise.departments.some(
          (entry) => entry.parent_id === parent_id && entry.name === name,
        )
      )
        throw problem(409, "department_exists", "同一层级已存在同名部门");
      const entry = {
        id: `department-${crypto.randomUUID()}`,
        name,
        parent_id,
        revision: 1,
        created_at: stamp(),
        updated_at: stamp(),
      };
      enterprise.departments.push(entry);
      enterprise.department_keys[key] = { id: entry.id, hash: digest };
      audit(p, "department.created", "department", entry.id, {
        name,
        parent_id,
      });
      persist();
      return { department: departmentView(entry), duplicate: false };
    }
    const departmentRoute = route.match(
      /^departments\/(department-[a-f0-9-]+)$/,
    );
    if (departmentRoute) {
      const entry = department(departmentRoute[1]);
      if (method === "GET") return { department: departmentView(entry) };
      if (!["PATCH", "DELETE"].includes(method))
        throw problem(405, "method_not_allowed", "不支持此部门操作");
      version(input, entry.revision);
      if (method === "DELETE") {
        if (
          enterprise.departments.some((item) => item.parent_id === entry.id) ||
          state.principals.some(
            (item) => record(item.id).department_id === entry.id,
          )
        )
          throw problem(
            409,
            "department_not_empty",
            "请先迁移成员并移除子部门",
          );
        enterprise.departments = enterprise.departments.filter(
          (item) => item.id !== entry.id,
        );
        audit(p, "department.deleted", "department", entry.id, {
          name: entry.name,
          parent_id: entry.parent_id,
        });
        persist();
        return { removed: true };
      }
      if (
        Object.keys(input).some(
          (key) => !["base_revision", "name", "parent_id"].includes(key),
        )
      )
        throw problem(422, "invalid_input", "无效部门字段");
      const name =
          input.name === undefined
            ? entry.name
            : requireText(input.name, "name", 100),
        parent_id =
          input.parent_id === undefined
            ? entry.parent_id
            : parentFor(input.parent_id, entry.id);
      if (
        enterprise.departments.some(
          (item) =>
            item.id !== entry.id &&
            item.parent_id === parent_id &&
            item.name === name,
        )
      )
        throw problem(409, "department_exists", "同一层级已存在同名部门");
      const before = { name: entry.name, parent_id: entry.parent_id };
      entry.name = name;
      entry.parent_id = parent_id;
      entry.revision++;
      entry.updated_at = stamp();
      audit(p, "department.updated", "department", entry.id, {
        before,
        after: { name, parent_id },
      });
      persist();
      return { department: departmentView(entry) };
    }
    if (route === "organizations" && method === "GET") {
      const q = query(params);
      return {
        organizations: enterprise.organizations
          .filter((entry) => `${entry.name}\n${entry.description}`.toLocaleLowerCase().includes(q))
          .map(organizationView),
      };
    }
    if (route === "organizations" && method === "POST") {
      if (
        Object.keys(input).some(
          (key) => !["name", "description", "client_id"].includes(key),
        )
      )
        throw problem(422, "invalid_input", "无效组织字段");
      const name = requireText(input.name, "name", 100),
        clientId = requireText(input.client_id, "client_id", 160),
        key = `${p.id}:${clientId}`;
      const digest = crypto
        .createHash("sha256")
        .update(JSON.stringify({ name, description: optionalText(input.description, "description", 2000) }))
        .digest("hex");
      if (own(enterprise.organization_keys, key)) {
        const receipt = enterprise.organization_keys[key];
        if (receipt.hash !== digest)
          throw problem(
            409,
            "idempotency_conflict",
            "相同 client_id 对应不同创建组织请求",
          );
        const existing = enterprise.organizations.find(
          (entry) => entry.id === receipt.id,
        );
        if (!existing)
          throw problem(
            409,
            "operation_target_removed",
            "原组织已删除，不能通过重试重新创建",
          );
        return { organization: organizationView(existing), duplicate: true };
      }
      if (enterprise.organizations.length >= 200)
        throw problem(409, "limit_reached", "组织已达本地预览上限");
      const description = optionalText(input.description, "description", 2000);
      if (
        enterprise.organizations.some(
          (entry) => entry.name === name,
        )
      )
        throw problem(409, "organization_exists", "已存在同名组织");
      const entry = {
        id: `organization-${crypto.randomUUID()}`,
        name,
        description,
        revision: 1,
        created_at: stamp(),
        updated_at: stamp(),
      };
      enterprise.organizations.push(entry);
      enterprise.organization_keys[key] = { id: entry.id, hash: digest };
      audit(p, "organization.created", "organization", entry.id, {
        name,
        description,
      });
      persist();
      return { organization: organizationView(entry), duplicate: false };
    }
    const organizationRoute = route.match(
      /^organizations\/(organization-[a-f0-9-]+)$/,
    );
    if (organizationRoute) {
      const entry = organization(organizationRoute[1]);
      if (method === "GET") return { organization: organizationView(entry) };
      if (!["PATCH", "DELETE"].includes(method))
        throw problem(405, "method_not_allowed", "不支持此组织操作");
      version(input, entry.revision);
      if (method === "DELETE") {
        if (Object.keys(input).some((key) => key !== "base_revision")) throw problem(422, "invalid_input", "无效删除组织字段");
        if (
          state.principals.some(
            (item) => record(item.id).organization_id === entry.id,
          )
        )
          throw problem(
            409,
            "organization_not_empty",
            "请先迁移组织内的成员",
          );
        enterprise.organizations = enterprise.organizations.filter(
          (item) => item.id !== entry.id,
        );
        audit(p, "organization.deleted", "organization", entry.id, {
          name: entry.name,
          description: entry.description,
        });
        persist();
        return { removed: true };
      }
      if (
        Object.keys(input).some(
          (key) => !["base_revision", "name", "description"].includes(key),
        )
      )
        throw problem(422, "invalid_input", "无效组织字段");
      const name =
          input.name === undefined
            ? entry.name
            : requireText(input.name, "name", 100),
        description = input.description === undefined ? entry.description : optionalText(input.description, "description", 2000);
      if (
        enterprise.organizations.some(
          (item) =>
            item.id !== entry.id &&
            item.name === name,
        )
      )
        throw problem(409, "organization_exists", "已存在同名组织");
      const before = { name: entry.name, description: entry.description };
      entry.name = name;
      entry.description = description;
      entry.revision++;
      entry.updated_at = stamp();
      audit(p, "organization.updated", "organization", entry.id, {
        before,
        after: { name, description },
      });
      persist();
      return { organization: organizationView(entry) };
    }
    throw problem(404, "not_found", "企业管理接口不存在");
  }
  function externalRevoke(pid) {
    guardOwner(pid);
    const membership = record(pid);
    membership.revision++;
    audit(null, "member.revoked", "member", pid, { source: "bootstrap_admin" });
  }
  function registerPrincipal(pid, actor = null, source = "bootstrap_admin") {
    const existing = own(enterprise.memberships, pid),
      membership = record(pid);
    if (!existing) {
      const entry = person(pid);
      audit(actor, "member.created", "member", pid, {
        source,
        name: entry.name,
        kind: entry.kind,
        role: "member",
      });
    }
    return membership;
  }
  return {
    handle,
    handleAdmin,
    professionalView: (pid) => {
      const v = memberView(person(pid));
      return Object.fromEntries(["organization_id", "organization_name", "department_id", "department_name", "profession", "job_title"].map((key) => [key, v[key]]));
    },
    registerPrincipal,
    guardOwner,
    externalRevoke,
    authorizeAdmin: authorize,
    departmentOf: (pid) => record(pid).department_id,
    departments: () => copy(enterprise.departments),
    auditManagement: audit,
  };
}
module.exports = { createNativeEnterprise, ROLES };
