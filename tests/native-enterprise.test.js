"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "native-enterprise-tests-"),
);
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
async function setup(bootstrap = true) {
  const file = path.join(temporary, crypto.randomUUID() + ".json"),
    admin = crypto.randomBytes(32).toString("hex");
  const options = {
    file,
    adminToken: admin,
    workspace: {
      handle: async () => {
        throw new Error("unexpected document read");
      },
    },
  };
  let im = createNativeIM(options);
  const call = (token, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im" + route);
    return im.handle(method, url.pathname, input, token, url.searchParams);
  };
  const make = (name, kind = "human") =>
    call(admin, "/admin/principals", "POST", { name, kind });
  const owner = await make("Owner"),
    agent = await make("Administrator Agent", "agent"),
    employee = await make("Employee"),
    peer = await make("Peer");
  if (bootstrap)
    await call(admin, "/admin/enterprise/bootstrap", "POST", {
      principal_id: owner.principal.id,
      name: "Visible enterprise",
    });
  const getMember = (person) =>
    call(owner.token, `/enterprise/admin/members/${person.principal.id}`);
  const patch = async (person, input, actor = owner) => {
    const { member } = await getMember(person);
    return call(
      actor.token,
      `/enterprise/admin/members/${person.principal.id}`,
      "PATCH",
      { base_revision: member.revision, ...input },
    );
  };
  return {
    admin,
    file,
    call,
    make,
    owner,
    agent,
    employee,
    peer,
    getMember,
    patch,
    restart: () => {
      im = createNativeIM(options);
    },
  };
}
const rejects = (value, code) => assert.rejects(value, { code });

test("legacy principals including room owners migrate only to ordinary membership; bootstrap alone assigns initial ownership", async () => {
  const f = await setup(false);
  await f.call(f.agent.token, "/rooms", "POST", { name: "Agent owned group" });
  const stored = JSON.parse(fs.readFileSync(f.file, "utf8"));
  delete stored.enterprise;
  fs.writeFileSync(f.file, JSON.stringify(stored));
  f.restart();
  for (const person of [f.owner, f.agent]) {
    const result = await f.call(person.token, "/enterprise");
    assert.equal(result.membership.role, "member");
    assert.equal(result.enterprise.scope, "single_workspace");
    assert.equal(result.capabilities.access_admin, false);
    await rejects(
      f.call(person.token, "/enterprise/admin/overview"),
      "enterprise_admin_required",
    );
  }
  await rejects(
    f.call(f.agent.token, "/admin/enterprise/bootstrap", "POST", {
      principal_id: f.agent.principal.id,
    }),
    "unauthorized",
  );
  const bootstrap = await f.call(
    f.admin,
    "/admin/enterprise/bootstrap",
    "POST",
    { principal_id: f.agent.principal.id },
  );
  assert.equal(bootstrap.membership.role, "owner");
  assert.equal(bootstrap.membership.kind, "agent");
  assert.equal(
    (
      await f.call(f.admin, "/admin/enterprise/bootstrap", "POST", {
        principal_id: f.agent.principal.id,
      })
    ).duplicate,
    true,
  );
  await rejects(
    f.call(f.admin, "/admin/enterprise/bootstrap", "POST", {
      principal_id: f.owner.principal.id,
    }),
    "enterprise_initialized",
  );
  f.restart();
  assert.equal(
    (await f.call(f.agent.token, "/enterprise/admin/overview")).counts.owners,
    1,
  );
});

test("human and Agent administrators share role capabilities; self-promotion and room privilege escalation are rejected", async () => {
  const f = await setup();
  await rejects(
    f.call(f.employee.token, "/enterprise/admin/members"),
    "enterprise_admin_required",
  );
  await f.patch(f.agent, { role: "admin" });
  const info = await f.call(f.agent.token, "/enterprise/admin/overview");
  assert.equal(info.capabilities.manage_members, true);
  assert.equal(info.capabilities.assign_owner, false);
  await rejects(
    f.patch(f.agent, { role: "owner" }, f.agent),
    "enterprise_owner_required",
  );
  await rejects(
    f.patch(f.employee, { role: "admin" }, f.agent),
    "enterprise_owner_required",
  );
  await rejects(
    f.patch(f.owner, { name: "Spoof" }, f.agent),
    "enterprise_owner_required",
  );
  await rejects(
    f.call(
      f.agent.token,
      `/enterprise/admin/members/${f.agent.principal.id}/revoke`,
      "POST",
      { base_revision: 2 },
    ),
    "enterprise_owner_required",
  );
  assert.equal(
    (await f.patch(f.agent, { name: "Updated own name" }, f.agent)).member.name,
    "Updated own name",
  );
  const { room } = await f.call(f.owner.token, "/rooms", "POST", {
    name: "Private room",
  });
  await rejects(f.call(f.agent.token, `/rooms/${room.id}`), "not_a_member");
  await f.patch(f.agent, { role: "member" });
  await rejects(
    f.call(f.agent.token, "/enterprise/admin/audit"),
    "enterprise_admin_required",
  );
  const events = (await f.call(f.agent.token, "/events")).events;
  assert.ok(
    events.some((entry) => entry.type === "enterprise.membership_changed"),
  );
});

test("last active owner protection applies to demotion, disable, both revoke paths and concurrent ownership transfers", async () => {
  const f = await setup();
  await rejects(f.patch(f.owner, { role: "member" }), "last_enterprise_owner");
  await rejects(
    f.patch(f.owner, { status: "disabled" }),
    "last_enterprise_owner",
  );
  await rejects(
    f.call(f.admin, "/admin/revoke", "POST", {
      principal_id: f.owner.principal.id,
    }),
    "last_enterprise_owner",
  );
  await rejects(
    f.call(
      f.owner.token,
      `/enterprise/admin/members/${f.owner.principal.id}/revoke`,
      "POST",
      { base_revision: 2 },
    ),
    "last_enterprise_owner",
  );
  await f.patch(f.agent, { role: "owner" });
  const outcomes = await Promise.allSettled([
    f.call(
      f.owner.token,
      `/enterprise/admin/members/${f.owner.principal.id}`,
      "PATCH",
      { base_revision: 2, role: "member" },
    ),
    f.call(
      f.agent.token,
      `/enterprise/admin/members/${f.agent.principal.id}`,
      "PATCH",
      { base_revision: 2, role: "member" },
    ),
  ]);
  assert.equal(
    outcomes.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.find((entry) => entry.status === "rejected").reason.code,
    "last_enterprise_owner",
  );
  f.restart();
  const role = await f.call(f.agent.token, "/enterprise");
  assert.equal(role.membership.role, "owner");
  await rejects(
    f.call(f.admin, "/admin/revoke", "POST", {
      principal_id: f.agent.principal.id,
    }),
    "last_enterprise_owner",
  );
});

test("departments have versioned membership, reject cycles and nonempty deletion, and record each authorized change", async () => {
  const f = await setup();
  await f.patch(f.agent, { role: "admin" });
  const create = (input) =>
    f.call(f.agent.token, "/enterprise/admin/departments", "POST", {
      client_id: crypto.randomUUID(),
      ...input,
    });
  const root = (await create({ name: "Engineering" })).department;
  const child = (await create({ name: "Research", parent_id: root.id }))
    .department;
  await rejects(
    f.call(f.agent.token, `/enterprise/admin/departments/${root.id}`, "PATCH", {
      base_revision: 1,
      parent_id: child.id,
    }),
    "department_cycle",
  );
  await rejects(
    f.call(
      f.agent.token,
      `/enterprise/admin/departments/${child.id}`,
      "PATCH",
      { base_revision: 1, parent_id: child.id },
    ),
    "department_cycle",
  );
  await rejects(
    f.call(
      f.agent.token,
      `/enterprise/admin/departments/${root.id}`,
      "DELETE",
      { base_revision: 1 },
    ),
    "department_not_empty",
  );
  await f.patch(f.employee, { department_id: child.id }, f.agent);
  assert.equal(
    (await f.call(f.agent.token, `/enterprise/admin/departments/${child.id}`))
      .department.member_count,
    1,
  );
  await rejects(
    f.call(
      f.agent.token,
      `/enterprise/admin/departments/${child.id}`,
      "DELETE",
      { base_revision: 1 },
    ),
    "department_not_empty",
  );
  const renamed = await f.call(
    f.agent.token,
    `/enterprise/admin/departments/${child.id}`,
    "PATCH",
    { base_revision: 1, name: "Applied research" },
  );
  assert.equal(renamed.department.revision, 2);
  await rejects(
    f.call(
      f.agent.token,
      `/enterprise/admin/departments/${child.id}`,
      "PATCH",
      { base_revision: 1, name: "Stale" },
    ),
    "conflict",
  );
  assert.equal(
    (
      await f.call(
        f.agent.token,
        `/enterprise/admin/members?department_id=${child.id}`,
      )
    ).total,
    1,
  );
  await f.patch(f.employee, { department_id: null }, f.agent);
  await f.call(
    f.agent.token,
    `/enterprise/admin/departments/${child.id}`,
    "DELETE",
    { base_revision: 2 },
  );
  await f.call(
    f.agent.token,
    `/enterprise/admin/departments/${root.id}`,
    "DELETE",
    { base_revision: 1 },
  );
  assert.equal(
    (await f.call(f.agent.token, "/enterprise/admin/departments")).departments
      .length,
    0,
  );
  const audit = await f.call(
    f.agent.token,
    "/enterprise/admin/audit?q=department.deleted&page_size=1",
  );
  assert.equal(audit.total, 2);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].actor_kind, "agent");
});

test("disabling a principal revokes password sessions, fences tokens and waiting events/media, and cancels agent work", async () => {
  const f = await setup();
  const password = crypto.randomBytes(24).toString("base64url");
  await f.call(f.admin, "/admin/accounts", "POST", {
    principal_id: f.agent.principal.id,
    username: "disabled-agent",
    password,
  });
  const login = await f.call("", "/auth/login", "POST", {
    username: "disabled-agent",
    password,
  });
  const { room } = await f.call(f.owner.token, "/rooms", "POST", {
    name: "Agent work",
  });
  await f.call(f.owner.token, `/rooms/${room.id}/members`, "POST", {
    principal_id: f.agent.principal.id,
  });
  await f.call(f.owner.token, `/rooms/${room.id}/messages`, "POST", {
    client_id: "trigger",
    content: "Please review this visible work",
  });
  const { turn } = await f.call(
    f.agent.token,
    `/rooms/${room.id}/turns/claim`,
    "POST",
  );
  assert.equal(turn.status, "running");
  const { meeting } = await f.call(
    f.owner.token,
    `/rooms/${room.id}/meetings`,
    "POST",
    { client_id: "meeting", title: "Review" },
  );
  const joined = await f.call(
    login.token,
    `/meetings/${meeting.id}/join`,
    "POST",
    { device_id: "preview" },
  );
  const cursor = (await f.call(login.token, "/events")).cursor;
  const waiting = f
    .call(login.token, `/events?after=${cursor}&wait=25`)
    .catch((error) => error);
  const signaling = f
    .call(
      login.token,
      `/meetings/${meeting.id}/signals?session_id=${joined.session_id}&after=${joined.cursor}&wait=25`,
    )
    .catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.patch(f.agent, { status: "disabled" });
  assert.equal((await waiting).code, "unauthorized");
  assert.equal((await signaling).code, "unauthorized");
  for (const token of [f.agent.token, login.token])
    await rejects(f.call(token, "/me"), "unauthorized");
  await rejects(
    f.call("", "/auth/login", "POST", { username: "disabled-agent", password }),
    "invalid_credentials",
  );
  const stopped = await f.call(
    f.owner.token,
    `/rooms/${room.id}/turns/${turn.id}`,
  );
  assert.equal(stopped.turn.status, "cancelled");
  assert.equal(
    (await f.call(f.owner.token, `/meetings/${meeting.id}`)).participants
      .length,
    0,
  );
  f.restart();
  await rejects(f.call(f.agent.token, "/me"), "unauthorized");
  await f.patch(f.agent, { status: "active" });
  assert.equal((await f.call(f.agent.token, "/me")).principal.disabled, false);
  await rejects(f.call(login.token, "/me"), "unauthorized");
  assert.ok(
    (
      await f.call("", "/auth/login", "POST", {
        username: "disabled-agent",
        password,
      })
    ).token,
  );
});

test("member creation is retry-safe with one-time credentials, directory filters are bounded and organization exports contain no secrets", async () => {
  const f = await setup();
  const input = {
    client_id: "same-create-intent",
    name: "New native colleague",
    kind: "agent",
  };
  const created = await f.call(
    f.owner.token,
    "/enterprise/admin/members",
    "POST",
    input,
  );
  assert.equal(created.member.role, "member");
  assert.ok(created.token);
  assert.equal(created.credential_returned, true);
  const stored = fs.readFileSync(f.file, "utf8");
  assert.ok(!stored.includes(created.token));
  f.restart();
  const duplicate = await f.call(
    f.owner.token,
    "/enterprise/admin/members",
    "POST",
    input,
  );
  assert.equal(duplicate.member.id, created.member.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.token, null);
  await rejects(
    f.call(f.owner.token, "/enterprise/admin/members", "POST", {
      ...input,
      name: "changed",
    }),
    "idempotency_conflict",
  );
  await rejects(
    f.call(f.owner.token, "/enterprise/admin/members", "POST", {
      ...input,
      client_id: "elevated",
      role: "owner",
    }),
    "invalid_input",
  );
  const filtered = await f.call(
    f.owner.token,
    "/enterprise/admin/members?q=native&page_size=1&role=member&status=active",
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.members[0].id, created.member.id);
  await rejects(
    f.call(f.owner.token, "/enterprise/admin/members?page_size=101"),
    "invalid_pagination",
  );
  assert.equal(
    (await f.call(f.owner.token, "/enterprise/admin/roles?q=owner")).roles
      .length,
    1,
  );
  const exported = await f.call(f.owner.token, "/enterprise/admin/export");
  assert.ok(exported.includes(created.member.id));
  for (const forbidden of [
    created.token,
    f.owner.token,
    f.admin,
    "token_hash",
    "password_hash",
    "salt",
    "accounts",
    "sessions",
  ])
    assert.ok(!exported.includes(forbidden));
  const overview = await f.call(f.owner.token, "/enterprise/admin/overview");
  assert.equal(overview.counts.members, 5);
  assert.equal(overview.counts.agents, 2);
});

test("department creation keeps the same intent across lost responses and never resurrects deleted departments", async () => {
  const f = await setup(),
    input = { name: "Stable department", client_id: "department-intent" };
  const first = await f.call(
    f.owner.token,
    "/enterprise/admin/departments",
    "POST",
    input,
  );
  assert.equal(first.duplicate, false);
  f.restart();
  const retry = await f.call(
    f.owner.token,
    "/enterprise/admin/departments",
    "POST",
    input,
  );
  assert.equal(retry.department.id, first.department.id);
  assert.equal(retry.duplicate, true);
  await rejects(
    f.call(f.owner.token, "/enterprise/admin/departments", "POST", {
      ...input,
      name: "Changed",
    }),
    "idempotency_conflict",
  );
  await f.call(
    f.owner.token,
    `/enterprise/admin/departments/${first.department.id}`,
    "DELETE",
    { base_revision: 1 },
  );
  await rejects(
    f.call(f.owner.token, "/enterprise/admin/departments", "POST", input),
    "operation_target_removed",
  );
  assert.equal(
    (await f.call(f.owner.token, "/enterprise/admin/departments")).departments
      .length,
    0,
  );
});

test("enterprise writes fail stop atomically and corrupt hierarchy fails closed across restart", async () => {
  const f = await setup(),
    rename = fs.renameSync;
  try {
    fs.renameSync = (source, destination) => {
      if (destination === f.file) throw new Error("injected enterprise fault");
      return rename(source, destination);
    };
    await rejects(
      f.patch(f.agent, { role: "admin", status: "disabled" }),
      "storage_failed",
    );
    await rejects(
      f.call(f.owner.token, "/enterprise/admin/overview"),
      "storage_failed",
    );
  } finally {
    fs.renameSync = rename;
  }
  f.restart();
  assert.equal((await f.getMember(f.agent)).member.status, "active");
  assert.equal((await f.getMember(f.agent)).member.role, "member");
  const { department } = await f.call(
    f.owner.token,
    "/enterprise/admin/departments",
    "POST",
    { name: "Valid department", client_id: "valid-department" },
  );
  const state = JSON.parse(fs.readFileSync(f.file, "utf8"));
  state.enterprise.departments[0].parent_id = department.id;
  fs.writeFileSync(f.file, JSON.stringify(state));
  assert.throws(() => f.restart(), /Enterprise state is corrupt/);
});
