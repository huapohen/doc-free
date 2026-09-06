"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const { SESSION_MS, accountPasswordPolicyFromEnvironment } = require("../native-accounts");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "native-account-tests-"),
);
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const PASSWORD = "Fixture-password-123";
async function setup(overrides = {}) {
  const admin = crypto.randomBytes(32).toString("hex"),
    file = path.join(temporary, crypto.randomUUID() + ".json");
  let clock = Date.parse("2026-09-06T01:00:00Z");
  const options = {
    file,
    adminToken: admin,
    now: () => clock,
    workspace: {
      handle: async () => {
        throw new Error("unexpected document");
      },
    },
    ...overrides,
  };
  let im = createNativeIM(options);
  const call = (credential, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im" + route);
    return im.handle(method, url.pathname, input, credential, url.searchParams);
  };
  const owner = await call(admin, "/admin/principals", "POST", {
    name: "Human",
    kind: "human",
  });
  const agent = await call(admin, "/admin/principals", "POST", {
    name: "Agent",
    kind: "agent",
  });
  const enroll = (person, username) =>
    call(admin, "/admin/accounts", "POST", {
      principal_id: person.principal.id,
      username,
      password: PASSWORD,
    });
  const login = (username, password = PASSWORD) =>
    call("", "/auth/login", "POST", { username, password });
  return {
    file,
    admin,
    call,
    owner,
    agent,
    enroll,
    login,
    advance: (ms) => {
      clock += ms;
    },
    restart: (changes = {}) => {
      im = createNativeIM({ ...options, ...changes });
    },
  };
}
const rejects = (promise, code) => assert.rejects(promise, { code });

const LOCAL_PASSWORD = "Dev!42";
const LOCAL_POLICY = { development: true, listenHost: "127.0.0.1", minimumLength: 6 };

test("default password policy rejects short enrollment and ignores client policy overrides", async () => {
  const f = await setup();
  for (const [credential, route, extra] of [
    [f.admin, "/admin/accounts", { principal_id: f.owner.principal.id }],
    [f.agent.token, "/auth/account", {}],
  ]) {
    await rejects(f.call(credential, route, "POST", {
      ...extra, username: "short.account", password: LOCAL_PASSWORD,
      passwordPolicy: LOCAL_POLICY, accountPasswordPolicy: LOCAL_POLICY,
      minimumLength: 6, development: true,
    }), "weak_password");
  }
  assert.equal((await f.call(f.owner.token, "/auth/account")).account, null);
  assert.equal((await f.call(f.agent.token, "/auth/account")).account, null);
});

test("explicit development loopback policy permits independent human and Agent logins", async () => {
  const f = await setup({ accountPasswordPolicy: LOCAL_POLICY });
  for (const [person, name] of [[f.owner, "local.human"], [f.agent, "local.agent"]]) {
    await f.call(f.admin, "/admin/accounts", "POST", {
      principal_id: person.principal.id, username: name, password: LOCAL_PASSWORD,
    });
    const login = await f.login(name, LOCAL_PASSWORD);
    assert.equal(login.principal.id, person.principal.id);
    assert.equal((await f.call(login.token, "/me")).principal.kind, person.principal.kind);
    await f.call(login.token, "/auth/logout", "POST");
    await rejects(f.call(login.token, "/me"), "unauthorized");
  }
  await rejects(f.call(f.admin, "/admin/accounts", "POST", {
    principal_id: f.agent.principal.id, username: "local.agent", password: "12345",
  }), "weak_password");
});

test("invalid or nonlocal short-password configuration fails before startup", async () => {
  for (const policy of [
    { minimumLength: 6 },
    { ...LOCAL_POLICY, development: false },
    { ...LOCAL_POLICY, listenHost: "0.0.0.0" },
    { ...LOCAL_POLICY, listenHost: "::" },
    { ...LOCAL_POLICY, listenHost: "192.168.1.10" },
    { ...LOCAL_POLICY, listenHost: "127.attacker.test" },
    { ...LOCAL_POLICY, listenHost: "127.0.0.1.attacker.test" },
    { ...LOCAL_POLICY, minimumLength: 5 },
    { ...LOCAL_POLICY, minimumLength: "6" },
    { ...LOCAL_POLICY, minimumLength: 6.5 },
    { ...LOCAL_POLICY, development: "true" },
    { ...LOCAL_POLICY, extra: true },
    null, [],
  ]) await assert.rejects(setup({ accountPasswordPolicy: policy }), /Invalid local password policy/);
});

test("environment bridge defaults to ten and gates a shorter minimum by development plus listener", () => {
  assert.equal(accountPasswordPolicyFromEnvironment({}).minimumLength, 10);
  assert.equal(accountPasswordPolicyFromEnvironment({ NODE_ENV: "production" }).minimumLength, 10);
  for (const HOST of ["127.0.0.1", "127.0.0.2", "localhost", "::1"])
    assert.equal(accountPasswordPolicyFromEnvironment({ NODE_ENV: "development", HOST,
      DOC_FREE_LOCAL_PASSWORD_MIN_LENGTH: "6" }).minimumLength, 6);
  for (const env of [
    { DOC_FREE_LOCAL_PASSWORD_MIN_LENGTH: "6" },
    { NODE_ENV: "production", HOST: "127.0.0.1", DOC_FREE_LOCAL_PASSWORD_MIN_LENGTH: "6" },
    { NODE_ENV: "development", HOST: "0.0.0.0", DOC_FREE_LOCAL_PASSWORD_MIN_LENGTH: "6" },
    { NODE_ENV: "development", HOST: "::", DOC_FREE_LOCAL_PASSWORD_MIN_LENGTH: "6" },
    { NODE_ENV: "development", DOC_FREE_LOCAL_PASSWORD_MIN_LENGTH: "" },
    { NODE_ENV: "development", DOC_FREE_LOCAL_PASSWORD_MIN_LENGTH: "NaN" },
  ]) assert.throws(() => accountPasswordPolicyFromEnvironment(env), /Invalid local password policy/);
});

test("restoring default policy preserves enrolled accounts and existing sessions", async () => {
  const f = await setup({ accountPasswordPolicy: LOCAL_POLICY });
  await f.call(f.admin, "/admin/accounts", "POST", {
    principal_id: f.owner.principal.id, username: "retained.human", password: LOCAL_PASSWORD,
  });
  const before = await f.login("retained.human", LOCAL_PASSWORD);
  const account = (await f.call(before.token, "/auth/account")).account;
  f.restart({ accountPasswordPolicy: undefined });
  assert.equal((await f.call(before.token, "/me")).principal.id, f.owner.principal.id);
  assert.deepEqual((await f.call(before.token, "/auth/account")).account, account);
  const after = await f.login("retained.human", LOCAL_PASSWORD);
  assert.notEqual(after.token, before.token);
  await rejects(f.call(f.admin, "/admin/accounts", "POST", {
    principal_id: f.agent.principal.id, username: "new.agent", password: LOCAL_PASSWORD,
  }), "weak_password");
  await f.call(after.token, "/auth/logout", "POST");
  assert.equal((await f.call(before.token, "/me")).principal.id, f.owner.principal.id);
});

test("password enrollment uses salted scrypt, canonical usernames and generic login failures", async () => {
  const f = await setup();
  await f.enroll(f.owner, " Owner.Example ");
  await f.enroll(f.agent, "agent@example.test");
  const user = await f.login("OWNER.EXAMPLE");
  assert.equal(user.principal.id, f.owner.principal.id);
  assert.ok(user.expires_at);
  assert.equal(
    (await f.call(user.token, "/me")).principal.id,
    f.owner.principal.id,
  );
  const stored = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(stored.accounts.identities[0].username, "owner.example");
  assert.equal(stored.accounts.identities[0].kdf, "scrypt");
  assert.equal(stored.accounts.identities[0].parameters.N, 32768);
  assert.notEqual(
    stored.accounts.identities[0].salt,
    stored.accounts.identities[1].salt,
  );
  assert.notEqual(
    stored.accounts.identities[0].password_hash,
    stored.accounts.identities[1].password_hash,
  );
  assert.equal(JSON.stringify(stored).includes(PASSWORD), false);
  assert.equal(JSON.stringify(stored).includes(user.token), false);
  let missing, wrong;
  try {
    await f.login("unknown.example");
  } catch (error) {
    missing = error;
  }
  try {
    await f.login("owner.example", "wrong-password");
  } catch (error) {
    wrong = error;
  }
  assert.equal(missing.code, "invalid_credentials");
  assert.equal(missing.message, wrong.message);
  await rejects(
    f.call(f.admin, "/admin/accounts", "POST", {
      principal_id: f.agent.principal.id,
      username: "Owner.Example",
      password: PASSWORD,
    }),
    "username_taken",
  );
  await rejects(
    f.call(f.admin, "/admin/accounts", "POST", {
      principal_id: f.owner.principal.id,
      username: "owner.example",
      password: "          ",
    }),
    "weak_password",
  );
});

test("self enrollment/change requires current password, revokes login sessions and preserves machine credentials", async () => {
  const f = await setup();
  await f.call(f.owner.token, "/auth/account", "POST", {
    username: "self.owner",
    password: PASSWORD,
  });
  const before = await f.login("self.owner");
  await rejects(
    f.call(before.token, "/auth/account", "POST", {
      username: "self.owner",
      password: "New-password-456",
    }),
    "invalid_credentials",
  );
  const changed = await f.call(before.token, "/auth/account", "POST", {
    username: "self.owner",
    password: "New-password-456",
    current_password: PASSWORD,
  });
  assert.equal(changed.sessions_revoked, true);
  assert.equal(changed.machine_token_unchanged, true);
  await rejects(f.call(before.token, "/me"), "unauthorized");
  assert.equal(
    (await f.call(f.owner.token, "/me")).principal.id,
    f.owner.principal.id,
  );
  await rejects(f.login("self.owner"), "invalid_credentials");
  const next = await f.login("self.owner", "New-password-456");
  const list = await f.call(next.token, "/auth/sessions");
  assert.equal(
    list.sessions.some((session) => "token_hash" in session),
    false,
  );
  await f.call(next.token, "/auth/logout", "POST");
  await rejects(f.call(next.token, "/me"), "unauthorized");
  await rejects(
    f.call(f.owner.token, "/auth/logout", "POST"),
    "login_session_required",
  );
});

test("sessions survive restart, expire and can only be revoked by their own identity", async () => {
  const f = await setup();
  await f.enroll(f.owner, "owner.login");
  await f.enroll(f.agent, "agent.login");
  const user = await f.login("owner.login"),
    agent = await f.login("agent.login");
  f.restart();
  assert.equal(
    (await f.call(user.token, "/me")).principal.id,
    f.owner.principal.id,
  );
  await rejects(
    f.call(agent.token, `/auth/sessions/${user.session_id}`, "DELETE"),
    "not_found",
  );
  await f.call(f.owner.token, `/auth/sessions/${user.session_id}`, "DELETE");
  await rejects(f.call(user.token, "/me"), "unauthorized");
  const renewed = await f.login("owner.login");
  f.advance(SESSION_MS + 1);
  await rejects(f.call(renewed.token, "/me"), "unauthorized");
  assert.equal(
    (await f.call(f.owner.token, "/me")).principal.id,
    f.owner.principal.id,
  );
  f.advance(60000);
  const agentSession = await f.login("agent.login");
  const { room } = await f.call(agentSession.token, "/rooms", "POST", {
    name: "Agent password session owns room",
  });
  assert.equal(room.created_by, f.agent.principal.id);
});

test("password reset and principal revocation invalidate already-waiting session subscriptions", async () => {
  const f = await setup();
  await f.enroll(f.owner, "owner.wait");
  const user = await f.login("owner.wait");
  await f.call(user.token, "/rooms", "POST", { name: "Waiting" });
  const cursor = (await f.call(user.token, "/events")).cursor;
  const waiting = f.call(user.token, `/events?after=${cursor}&wait=20`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.call(f.admin, "/admin/accounts", "POST", {
    principal_id: f.owner.principal.id,
    username: "owner.wait",
    password: "Reset-password-456",
  });
  await rejects(waiting, "unauthorized");
  const next = await f.login("owner.wait", "Reset-password-456");
  await f.call(f.admin, "/admin/revoke", "POST", {
    principal_id: f.owner.principal.id,
  });
  await rejects(f.call(next.token, "/me"), "unauthorized");
  await rejects(
    f.login("owner.wait", "Reset-password-456"),
    "invalid_credentials",
  );
});

test("login failures are bounded per normalized username without exposing account existence", async () => {
  const f = await setup();
  for (let index = 0; index < 6; index++)
    await rejects(
      f.login("nobody.example", "incorrect"),
      "invalid_credentials",
    );
  await rejects(f.login("NOBODY.EXAMPLE", "incorrect"), "login_rate_limited");
  f.advance(60001);
  await rejects(f.login("nobody.example", "incorrect"), "invalid_credentials");
});
