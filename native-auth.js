"use strict";

// OIDC authorization-code broker. Remote tokens never leave this module and
// never become IM credentials. Only an explicitly bound issuer+subject can be
// exchanged for a separately revocable local session by native-accounts.
const crypto = require("node:crypto");
const fs = require("node:fs");
const { problem } = require("./work-protocol");
const FLOW_MS = 10 * 60 * 1000;
const CODE_MS = 2 * 60 * 1000;
const random = () => crypto.randomBytes(32).toString("base64url");
const hash = (s) => crypto.createHash("sha256").update(s).digest("base64url");
const equal = (a, b) => typeof a === "string" && typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const rejected = () => problem(401, "oidc_authorization_failed", "企业登录校验失败，请重新发起登录");
const htmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function readAuthConfig(env = process.env) {
  if (!env.DOC_FREE_AUTH_CONFIG) return {};
  try {
    const file = env.DOC_FREE_AUTH_CONFIG;
    if (!require("node:path").isAbsolute(file) || fs.statSync(file).size > 65536)
      throw new Error("invalid file");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { throw new Error("Cannot read DOC_FREE_AUTH_CONFIG: use a valid absolute JSON config path"); }
}
function createNativeAuth({ config = {}, env = process.env, now = Date.now, fetchImpl = fetch,
  allowInsecureLoopback = false } = {}) {
  const configError = () => new Error("Invalid authentication configuration; refusing to start");
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some((key) => !["local_password", "oidc"].includes(key)) ||
      (config.local_password !== undefined && typeof config.local_password !== "boolean") ||
      (config.oidc !== undefined && (!config.oidc || typeof config.oidc !== "object" || Array.isArray(config.oidc))))
    throw configError();
  if (config.oidc && Object.keys(config.oidc).some((key) => key !== "providers")) throw configError();
  const localPassword = config.local_password !== false;
  const rawProviders = config.oidc?.providers === undefined ? [] : config.oidc.providers;
  if (!Array.isArray(rawProviders) || rawProviders.length > 8) throw configError();
  function safeURL(value) {
    if (typeof value !== "string" || value.length > 2048) throw configError();
    let url; try { url = new URL(value); } catch { throw configError(); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || url.search ||
        !(url.protocol === "https:" || (allowInsecureLoopback && loopback && url.protocol === "http:"))) throw configError();
    return url;
  }
  const providers = new Map();
  for (const raw of rawProviders) {
    if (!raw || typeof raw !== "object" || !/^[a-z][a-z0-9_-]{0,39}$/.test(raw.id) || providers.has(raw.id) ||
        Object.keys(raw).some((key) => !["id", "label", "issuer", "authorization_endpoint", "token_endpoint", "jwks_uri",
          "redirect_uri", "client_id", "allowed_algorithms", "token_endpoint_auth_method", "client_secret_env", "scopes"].includes(key)) ||
        typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 100 ||
        typeof raw.client_id !== "string" || !raw.client_id || raw.client_id.length > 500)
      throw configError();
    safeURL(raw.issuer);
    const issuer = raw.issuer; // Issuer comparison is exact, including trailing slash.
    const authorization = safeURL(raw.authorization_endpoint), token = safeURL(raw.token_endpoint), jwks = safeURL(raw.jwks_uri);
    const redirect = safeURL(raw.redirect_uri);
    if (redirect.pathname !== `/api/im/auth/oidc/${raw.id}/callback`) throw configError();
    const algorithms = raw.allowed_algorithms === undefined ? ["RS256"] : raw.allowed_algorithms;
    if (!Array.isArray(algorithms) || algorithms.length !== 1 || algorithms[0] !== "RS256") throw configError();
    const authMethod = raw.token_endpoint_auth_method === undefined ? "none" : raw.token_endpoint_auth_method;
    if (!["none", "client_secret_basic"].includes(authMethod)) throw configError();
    let secret = "";
    if (authMethod === "client_secret_basic") {
      if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(raw.client_secret_env || "")) throw configError();
      secret = env[raw.client_secret_env];
      if (typeof secret !== "string" || !secret || secret.length > 8192) throw configError();
    } else if (raw.client_secret_env) throw configError();
    if (raw.client_secret !== undefined) throw configError();
    const scopes = raw.scopes === undefined ? ["openid"] : raw.scopes;
    if (!Array.isArray(scopes) || !scopes.includes("openid") || scopes.length > 10 ||
        scopes.some((s) => typeof s !== "string" || !/^[A-Za-z0-9:._/-]{1,100}$/.test(s) || s === "offline_access"))
      throw configError();
    providers.set(raw.id, { id: raw.id, label: raw.label, issuer, authorization, token, jwks, redirect,
      clientId:raw.client_id, authMethod, secret, scopes });
  }
  const flows = new Map(), codes = new Map(), limits = new Map(), keys = new Map();
  function provider(id) {
    const p = providers.get(id);
    if (!p) throw problem(404, "auth_provider_unavailable", "登录方式未配置或已停用");
    return p;
  }
  function cleanup() {
    for (const [key, f] of flows) if (f.expires <= now()) flows.delete(key);
    for (const [key, c] of codes) if (c.expires <= now()) codes.delete(key);
    for (const [key, value] of limits) if (value.window !== Math.floor(now() / 60000)) limits.delete(key);
  }
  function limit(name, maximum) {
    cleanup();
    const window = Math.floor(now() / 60000);
    const value = limits.get(name) || { window, count: 0 };
    limits.set(name, value);
    if (++value.count > maximum) throw problem(429, "login_rate_limited", "登录请求过于频繁，请稍后再试");
  }
  function discovery() {
    return { local_password: { enabled: localPassword }, machine_token: { enabled: true },
      providers: [...providers.values()].map((p) => ({ id:p.id, label:p.label, protocol:"oidc",
        start_endpoint:`/api/im/auth/oidc/${p.id}/start` })) };
  }
  function start(id, input) {
    const p = provider(id); limit("start", 60);
    if (typeof input.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge))
      throw problem(422, "invalid_pkce_challenge", "需要 SHA-256 PKCE challenge");
    if (flows.size >= 500 || codes.size >= 500) throw problem(429, "login_rate_limited", "登录请求过于频繁，请稍后再试");
    const state = random(), launch = random();
    flows.set(hash(state), { providerId:id, state, launchHash:hash(launch), clientChallenge:input.code_challenge,
      verifier:random(), nonce:random(), started:now(), expires:now()+FLOW_MS, used:false, launched:false });
    const url = new URL(`/api/im/auth/oidc/${id}/authorize`, p.redirect.origin);
    url.searchParams.set("ticket", launch);
    return { authorization_url:url.href, expires_in:FLOW_MS/1000 };
  }
  async function requestJSON(url, options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
    let reader;
    try {
      const response = await fetchImpl(url.href, {...options, redirect:"error", signal:controller.signal});
      if (!response.ok || !response.body) throw rejected();
      reader = response.body.getReader();
      const chunks = []; let total = 0;
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        total += value.byteLength; if (total > 131072) throw rejected();
        chunks.push(Buffer.from(value));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result)) throw rejected();
      return result;
    } catch { throw rejected(); }
    finally { clearTimeout(timeout); if (reader) { try { await reader.cancel(); } catch {} } }
  }
  async function signingKey(p, kid) {
    let cached = keys.get(p.id);
    if (!cached || cached.expires <= now() || (!cached.keys.some((k) => k.kid === kid) && cached.fetched + 30000 <= now())) {
      const result = await requestJSON(p.jwks);
      if (!Array.isArray(result.keys) || result.keys.length > 32) throw rejected();
      cached = {keys:result.keys, fetched:now(), expires:now()+5*60000}; keys.set(p.id, cached);
    }
    const matching = cached.keys.filter((k) => k && k.kid === kid);
    if (matching.length !== 1) throw rejected();
    const key = matching[0];
    if (key.kty !== "RSA" || (key.alg && key.alg !== "RS256") || (key.use && key.use !== "sig") ||
        (key.key_ops && (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))) || key.d ||
        typeof key.n !== "string" || typeof key.e !== "string") throw rejected();
    try {
      const publicKey = crypto.createPublicKey({key:{kty:"RSA",n:key.n,e:key.e},format:"jwk"});
      if (publicKey.asymmetricKeyDetails.modulusLength < 2048) throw rejected();
      return publicKey;
    } catch { throw rejected(); }
  }
  async function validateToken(p, raw, f, response, authorizationCode) {
    if (typeof raw !== "string" || raw.length > 32768) throw rejected();
    const parts = raw.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw rejected();
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], "base64url")); claims = JSON.parse(Buffer.from(parts[1], "base64url")); }
    catch { throw rejected(); }
    if (!header || !claims || header.alg !== "RS256" || (header.typ && header.typ !== "JWT") ||
        header.crit !== undefined || header.jku || header.jwk || header.x5u ||
        typeof header.kid !== "string" || !header.kid || header.kid.length > 200) throw rejected();
    const key = await signingKey(p, header.kid);
    if (!crypto.verify("RSA-SHA256", Buffer.from(parts[0]+"."+parts[1]), key, Buffer.from(parts[2],"base64url"))) throw rejected();
    const seconds = now()/1000;
    const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    if (claims.iss !== p.issuer || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 500 ||
        !Array.isArray(audience) || !audience.length || audience.some((a) => typeof a !== "string") || !audience.includes(p.clientId) ||
        (audience.length > 1 && claims.azp !== p.clientId) || (claims.azp !== undefined && claims.azp !== p.clientId) ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= seconds || !Number.isSafeInteger(claims.iat) ||
        claims.iat > seconds + 60 || claims.iat < f.started/1000 - 60 || claims.exp <= claims.iat ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds+60)) ||
        !equal(claims.nonce, f.nonce)) throw rejected();
    for (const [claim, value] of [["at_hash",response.access_token],["c_hash",authorizationCode]]) {
      if (claims[claim] !== undefined && (typeof value !== "string" ||
          !equal(claims[claim], crypto.createHash("sha256").update(value).digest().subarray(0,16).toString("base64url")))) throw rejected();
    }
    return {provider_id:p.id, issuer:p.issuer, subject:claims.sub};
  }
  function cookieName(p) { return `${p.redirect.protocol === "https:" ? "__Host-" : ""}docfree_oidc_${p.id}`; }
  function cookie(p, value, maxAge) {
    return `${cookieName(p)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${p.redirect.protocol === "https:" ? "; Secure" : ""}`;
  }
  function cookieValue(req, p) {
    const values = (req.headers.cookie || "").split(";").map((s) => s.trim()).filter((s) => s.startsWith(cookieName(p)+"="));
    return values.length === 1 ? values[0].slice(cookieName(p).length+1) : "";
  }
  function html(res, p, status, title, content) {
    res.writeHead(status, {"content-type":"text/html; charset=utf-8", "cache-control":"no-store", "referrer-policy":"no-referrer",
      "x-content-type-options":"nosniff", "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "set-cookie":cookie(p,"",0)});
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font:18px system-ui;max-width:680px;margin:10vh auto;padding:24px;color:#152d3a;background:#f3f7fa}code{display:block;overflow-wrap:anywhere;user-select:all;padding:24px;background:white;border:1px solid #c5d5df;border-radius:12px}p{line-height:1.65}</style><h1>${htmlEscape(title)}</h1>${content}</html>`);
  }
  async function handleBrowser(req, res, url) {
    const match = url.pathname.match(/^\/api\/im\/auth\/oidc\/([a-z][a-z0-9_-]{0,39})\/(authorize|callback)$/);
    if (!match) return false;
    if (req.method !== "GET") throw problem(405,"method_not_allowed","企业授权回调只接受 GET");
    const p = provider(match[1]); cleanup();
    if (match[2] === "authorize") {
      const ticket = url.searchParams.get("ticket");
      if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || url.searchParams.getAll("ticket").length !== 1) throw rejected();
      const flow = [...flows.values()].find((f) => f.providerId === p.id && !f.launched && equal(f.launchHash,hash(ticket)));
      if (!flow) throw rejected();
      flow.launched = true; flow.browserSecret = random(); delete flow.launchHash;
      const target = new URL(p.authorization.href);
      for (const [key,value] of Object.entries({response_type:"code",client_id:p.clientId,redirect_uri:p.redirect.href,
        scope:p.scopes.join(" "),state:flow.state,nonce:flow.nonce,code_challenge:hash(flow.verifier),code_challenge_method:"S256"})) target.searchParams.set(key,value);
      res.writeHead(302, {location:target.href,"set-cookie":cookie(p,flow.browserSecret,FLOW_MS/1000),"cache-control":"no-store","referrer-policy":"no-referrer"});
      res.end(); return true;
    }
    try {
      limit("callback", 120);
      const state = url.searchParams.get("state"), code = url.searchParams.get("code");
      const f = typeof state === "string" && /^[A-Za-z0-9_-]{43}$/.test(state) ? flows.get(hash(state)) : null;
      if (!f || f.providerId !== p.id || !f.launched || f.used || !equal(f.browserSecret,cookieValue(req,p)) ||
          url.searchParams.getAll("state").length !== 1) throw rejected();
      f.used = true; flows.delete(hash(state));
      if (url.searchParams.has("error") || typeof code !== "string" || !code || code.length > 4096 || url.searchParams.getAll("code").length !== 1 ||
          (url.searchParams.has("iss") && (url.searchParams.getAll("iss").length !== 1 || url.searchParams.get("iss") !== p.issuer))) throw rejected();
      const form = new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:p.redirect.href,client_id:p.clientId,code_verifier:f.verifier});
      const headers = {"content-type":"application/x-www-form-urlencoded",accept:"application/json"};
      if (p.authMethod === "client_secret_basic") {
        const encode = (v) => new URLSearchParams({v}).toString().slice(2);
        headers.authorization = "Basic " + Buffer.from(`${encode(p.clientId)}:${encode(p.secret)}`).toString("base64");
      }
      const response = await requestJSON(p.token,{method:"POST",headers,body:form.toString()});
      const identity = await validateToken(p,response.id_token,f,response,code);
      if (now() >= f.expires || codes.size >= 500) throw rejected();
      const exchangeCode = random();
      codes.set(hash(exchangeCode),{...identity,challenge:f.clientChallenge,expires:now()+CODE_MS});
      html(res,p,200,"企业身份验证完成",`<p>返回刚才发起登录的 Active Agent App，粘贴下面的一次性登录码。登录码 2 分钟后过期，只能由发起登录的 App 兑换。</p><code>${htmlEscape(exchangeCode)}</code><p>请勿把登录码发送给其他人。企业成员权限仍由本实例管理员配置。</p>`);
    } catch { html(res,p,401,"企业登录未完成","<p>授权已过期、被取消或无法验证。请返回 App 重新发起登录。</p>"); }
    return true;
  }
  function exchange(id, input) {
    provider(id); limit("exchange", 120);
    if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.code) ||
        typeof input.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) throw rejected();
    const key = hash(input.code), identity = codes.get(key);
    if (!identity || identity.provider_id !== id || !equal(identity.challenge,hash(input.code_verifier))) throw rejected();
    codes.delete(key);
    return {provider_id:identity.provider_id,issuer:identity.issuer,subject:identity.subject};
  }
  function bindingProvider(id) { const p = provider(id); return {id:p.id,issuer:p.issuer}; }
  return { localPassword, discovery, start, exchange, handleBrowser, bindingProvider };
}
module.exports = {createNativeAuth,readAuthConfig,FLOW_MS,CODE_MS};
