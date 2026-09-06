"use strict";

// Password login issues independent expiring sessions. It never replaces or
// reveals the principal's machine credential, which remains separately managed.
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { problem, requireText } = require("./work-protocol");
const scrypt = promisify(crypto.scrypt);
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const sameHash = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const SESSION_MS = 12 * 60 * 60 * 1000;
const PARAMETERS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function createAccounts({ state, now, stamp, persist, active, principalView }) {
  state.accounts ||= { identities: [], sessions: [], audit: [] };
  const store = state.accounts;
  if (
    !Array.isArray(store.identities) ||
    !Array.isArray(store.sessions) ||
    !Array.isArray(store.audit) ||
    store.identities.some(
      (account) =>
        !account.principal_id ||
        !/^[a-f0-9]{32}$/.test(account.salt) ||
        !/^[a-f0-9]{128}$/.test(account.password_hash),
    ) ||
    store.sessions.some(
      (session) =>
        !session.principal_id ||
        !/^[a-f0-9]{64}$/.test(session.token_hash) ||
        !Number.isFinite(session.expires_at),
    )
  )
    throw new Error(
      "Account state is corrupt; refusing to initialize empty authentication data",
    );
  const attempts = new Map();
  const dummySalt = crypto.randomBytes(16).toString("hex");
  function username(value) {
    const text = requireText(value, "username", 100).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._@+-]{2,99}$/.test(text))
      throw problem(
        422,
        "invalid_username",
        "用户名需为 3–100 位字母、数字或 . _ @ + -",
      );
    return text;
  }
  function password(value) {
    if (
      typeof value !== "string" ||
      value.length < 10 ||
      value.length > 256 ||
      !value.trim()
    )
      throw problem(
        422,
        "weak_password",
        "密码需要 10–256 个字符且不能全为空白",
      );
    return value;
  }
  async function passwordHash(value, salt) {
    return (
      await scrypt(value, Buffer.from(salt, "hex"), 64, PARAMETERS)
    ).toString("hex");
  }
  function audit(action, actorId, details = {}) {
    store.audit.push({ action, actor_id: actorId, at: stamp(), ...details });
    store.audit = store.audit.slice(-5000);
  }
  function revokeAll(pid, actorId) {
    for (const session of store.sessions)
      if (session.principal_id === pid && !session.revoked_at)
        session.revoked_at = stamp();
    audit("sessions.revoked", actorId, { principal_id: pid });
  }
  function accountView(account) {
    return {
      principal_id: account.principal_id,
      username: account.username,
      created_at: account.created_at,
      updated_at: account.updated_at,
      revision: account.revision,
    };
  }
  function sessionView(session) {
    return {
      id: session.id,
      principal_id: session.principal_id,
      created_at: session.created_at,
      expires_at: new Date(session.expires_at).toISOString(),
      revoked_at: session.revoked_at || null,
      active: !session.revoked_at && session.expires_at > now(),
    };
  }
  function sessionFor(token) {
    if (typeof token !== "string" || !token) return null;
    const hashed = digest(token);
    return (
      store.sessions.find(
        (session) =>
          !session.revoked_at &&
          session.expires_at > now() &&
          sameHash(session.token_hash, hashed),
      ) || null
    );
  }
  function authenticate(token) {
    const session = sessionFor(token);
    if (!session) return null;
    try {
      return active(session.principal_id);
    } catch {
      return null;
    }
  }
  function limit(name) {
    const window = Math.floor(now() / 60000);
    for (const [key, entry] of attempts)
      if (entry.window !== window) attempts.delete(key);
    for (const [key, max] of [
      ["global", 60],
      [`account:${name}`, 6],
    ]) {
      const entry = attempts.get(key) || { window, count: 0 };
      entry.count += 1;
      attempts.set(key, entry);
      if (entry.count > max)
        throw problem(
          429,
          "login_rate_limited",
          "登录请求过于频繁，请稍后再试",
        );
    }
  }
  async function handlePublic(method, pathname, input) {
    if (pathname !== "/api/im/auth/login" || method !== "POST")
      return undefined;
    const rawName =
      typeof input.username === "string"
        ? input.username.trim().toLowerCase().slice(0, 100)
        : "";
    limit(rawName);
    let name;
    try {
      name = username(input.username);
    } catch {
      name = "";
    }
    const candidate =
      typeof input.password === "string" && input.password.length <= 256
        ? input.password
        : "";
    const account = store.identities.find((item) => item.username === name);
    const computed = await passwordHash(candidate, account?.salt || dummySalt);
    let p;
    try {
      p = account && active(account.principal_id);
    } catch {}
    if (!account || !p || !sameHash(account.password_hash, computed))
      throw problem(401, "invalid_credentials", "用户名或密码不正确");
    const live = store.sessions.filter(
      (session) =>
        session.principal_id === p.id &&
        !session.revoked_at &&
        session.expires_at > now(),
    );
    if (live.length >= 20)
      throw problem(409, "session_limit", "有效登录会话已达上限，请撤销旧会话");
    // Keep recent ended sessions for inspection while bounding the operational log.
    const ended = store.sessions
      .filter((session) => session.revoked_at || session.expires_at <= now())
      .slice(-1000);
    const running = store.sessions.filter(
      (session) => !session.revoked_at && session.expires_at > now(),
    );
    if (running.length >= 10000)
      throw problem(409, "session_limit", "实例有效登录会话已达上限");
    const token = crypto.randomBytes(32).toString("base64url");
    const session = {
      id: `session-${crypto.randomUUID()}`,
      principal_id: p.id,
      token_hash: digest(token),
      created_at: stamp(),
      expires_at: now() + SESSION_MS,
    };
    store.sessions = [...ended, ...running, session];
    audit("session.created", p.id, { session_id: session.id });
    persist();
    return {
      principal: principalView(p),
      token,
      expires_at: new Date(session.expires_at).toISOString(),
      session_id: session.id,
    };
  }
  async function setAccount(p, input, actorId, admin = false) {
    const name = username(input.username),
      secret = password(input.password);
    const existing = store.identities.find(
      (account) => account.principal_id === p.id,
    );
    if (
      store.identities.some(
        (account) => account.username === name && account.principal_id !== p.id,
      )
    )
      throw problem(409, "username_taken", "用户名已被使用");
    if (existing && !admin) {
      const current =
        typeof input.current_password === "string" &&
        input.current_password.length <= 256
          ? input.current_password
          : "";
      if (
        !sameHash(
          await passwordHash(current, existing.salt),
          existing.password_hash,
        )
      )
        throw problem(401, "invalid_credentials", "当前密码不正确");
    }
    const salt = crypto.randomBytes(16).toString("hex"),
      password_hash = await passwordHash(secret, salt);
    const account = {
      principal_id: p.id,
      username: name,
      salt,
      password_hash,
      kdf: "scrypt",
      parameters: { N: PARAMETERS.N, r: PARAMETERS.r, p: PARAMETERS.p },
      created_at: existing?.created_at || stamp(),
      updated_at: stamp(),
      revision: (existing?.revision || 0) + 1,
    };
    if (existing) Object.assign(existing, account);
    else store.identities.push(account);
    revokeAll(p.id, actorId);
    audit(admin ? "account.admin_set" : "account.self_set", actorId, {
      principal_id: p.id,
    });
    persist();
    return {
      account: accountView(account),
      sessions_revoked: true,
      machine_token_unchanged: true,
    };
  }
  async function handleAdmin(method, pathname, input) {
    if (pathname === "/api/im/admin/accounts" && method === "POST")
      return setAccount(active(input.principal_id), input, "admin", true);
    return undefined;
  }
  async function handle(method, pathname, input, p, credential) {
    if (pathname === "/api/im/auth/account") {
      if (method === "POST") return setAccount(p, input, p.id);
      if (method === "GET") {
        const account = store.identities.find(
          (item) => item.principal_id === p.id,
        );
        return { account: account ? accountView(account) : null };
      }
    }
    if (pathname === "/api/im/auth/sessions" && method === "GET")
      return {
        sessions: store.sessions
          .filter((session) => session.principal_id === p.id)
          .slice(-100)
          .map(sessionView),
      };
    if (pathname === "/api/im/auth/logout" && method === "POST") {
      const session = sessionFor(credential);
      if (!session || session.principal_id !== p.id)
        throw problem(
          409,
          "login_session_required",
          "此操作只退出密码登录会话，机器凭据需另行撤销",
        );
      session.revoked_at = stamp();
      audit("session.logged_out", p.id, { session_id: session.id });
      persist();
      return { logged_out: true };
    }
    const match = pathname.match(
      /^\/api\/im\/auth\/sessions\/(session-[a-f0-9-]+)$/,
    );
    if (match && method === "DELETE") {
      const session = store.sessions.find(
        (item) => item.id === match[1] && item.principal_id === p.id,
      );
      if (!session) throw problem(404, "not_found", "登录会话不存在");
      if (!session.revoked_at) {
        session.revoked_at = stamp();
        audit("session.revoked", p.id, { session_id: session.id });
        persist();
      }
      return { revoked: true };
    }
    return undefined;
  }
  return {
    authenticate,
    handlePublic,
    handleAdmin,
    handle,
    revokePrincipal: (pid) => revokeAll(pid, "admin"),
  };
}
module.exports = { createAccounts, SESSION_MS };
