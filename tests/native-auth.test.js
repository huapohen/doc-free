"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const {createNativeAuth,FLOW_MS,CODE_MS} = require("../native-auth");
const {createAccounts} = require("../native-accounts");
const pair = crypto.generateKeyPairSync("rsa",{modulusLength:2048});
const pair2 = crypto.generateKeyPairSync("rsa",{modulusLength:2048});
const digest = (s) => crypto.createHash("sha256").update(s).digest("base64url");
const random = () => crypto.randomBytes(32).toString("base64url");
const json = (res,value,status=200) => {res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value));};
async function fixture(t, options={}) {
  let clock = Date.parse("2026-09-06T05:00:00Z"), origin, auth, accounts, saved;
  const state = {}, requests = {token:0,jwks:0}, authorizationCodes = new Map();
  const members = [{id:"human-1",name:"Human",kind:"human"},{id:"agent-1",name:"Agent",kind:"agent"}];
  const settings = {claims:{},header:{},signer:pair.privateKey,jwks:[{...pair.publicKey.export({format:"jwk"}),kid:"current",alg:"RS256",use:"sig"}],...options};
  const server = http.createServer(async(req,res) => {
    try {
      const url = new URL(req.url,origin);
      if (url.pathname === "/provider/authorize") {
        assert.equal(url.searchParams.get("response_type"),"code");
        assert.equal(url.searchParams.get("code_challenge_method"),"S256");
        assert.equal(url.searchParams.get("client_id"),"fixture-client");
        assert.equal(url.searchParams.get("redirect_uri"),origin+"/api/im/auth/oidc/company/callback");
        const code = random(); authorizationCodes.set(code,Object.fromEntries(url.searchParams));
        const target = new URL(url.searchParams.get("redirect_uri"));
        target.searchParams.set("code",code);target.searchParams.set("state",url.searchParams.get("state"));
        target.searchParams.set("iss",origin+"/provider");
        res.writeHead(302,{location:target.href});return res.end();
      }
      if (url.pathname === "/provider/token") {
        requests.token++; let raw="";for await (const chunk of req) raw+=chunk;
        const form = new URLSearchParams(raw), request = authorizationCodes.get(form.get("code"));
        authorizationCodes.delete(form.get("code"));
        assert.ok(request);assert.equal(form.get("grant_type"),"authorization_code");
        assert.equal(digest(form.get("code_verifier")),request.code_challenge);
        assert.equal(form.get("redirect_uri"),request.redirect_uri);
        if (settings.confidential) assert.equal(req.headers.authorization,"Basic "+Buffer.from("fixture-client:fixture-secret").toString("base64"));
        const claims = {iss:origin+"/provider",sub:"immutable-human",aud:"fixture-client",iat:Math.floor(clock/1000),exp:Math.floor(clock/1000)+300,
          nonce:request.nonce,email:"administrator@example.test",roles:["owner"],kind:"agent",...settings.claims};
        const header = {alg:"RS256",typ:"JWT",kid:"current",...settings.header};
        const payload = Buffer.from(JSON.stringify(header)).toString("base64url")+"."+Buffer.from(JSON.stringify(claims)).toString("base64url");
        const id_token = payload+"."+crypto.sign("RSA-SHA256",Buffer.from(payload),settings.signer).toString("base64url");
        if (settings.tokenResponse === "redirect") {res.writeHead(302,{location:origin+"/should-not-visit"});return res.end();}
        if (settings.tokenResponse === "large") return res.end("x".repeat(140000));
        if (settings.tokenResponse === "malformed") return res.end("bad json");
        if (settings.tokenResponse === "missing") return json(res,{access_token:"not-an-id-token"});
        if (settings.tokenResponse === "hang") return;
        return json(res,{id_token,access_token:"never-persisted-access-token",token_type:"Bearer"});
      }
      if (url.pathname === "/provider/jwks") {requests.jwks++;return json(res,{keys:settings.jwks});}
      if (await auth.handleBrowser(req,res,url)) return;
      let input={};if(req.method === "POST") {let raw="";for await(const chunk of req)raw+=chunk;input=JSON.parse(raw);}
      const result = await accounts.handlePublic(req.method,url.pathname,input);
      if(result === undefined)return json(res,{code:"not_found"},404);
      return json(res,result);
    } catch(e) { json(res,{code:e.code||"fixture_error",message:e.code?e.message:"fixture failed"},e.status||500); }
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  origin="http://127.0.0.1:"+server.address().port;
  const provider={id:"company",label:"Fixture company",issuer:origin+"/provider",authorization_endpoint:origin+"/provider/authorize",
    token_endpoint:origin+"/provider/token",jwks_uri:origin+"/provider/jwks",redirect_uri:origin+"/api/im/auth/oidc/company/callback",client_id:"fixture-client"};
  if(settings.confidential)Object.assign(provider,{token_endpoint_auth_method:"client_secret_basic",client_secret_env:"FIXTURE_CLIENT_SECRET"});
  const config={local_password:options.localPassword!==false,oidc:{providers:[provider]}};
  const makeAuth=(next=config)=>createNativeAuth({config:next,allowInsecureLoopback:true,now:()=>clock,env:{FIXTURE_CLIENT_SECRET:"fixture-secret"}});
  auth=makeAuth();
  const makeAccounts=()=>createAccounts({state,auth,now:()=>clock,stamp:()=>new Date(clock).toISOString(),persist:()=>{saved=JSON.stringify(state);},
    active:(id)=>{const member=members.find(p=>p.id===id&&!p.disabled);if(!member)throw new Error("inactive");return member;},principalView:(p)=>({...p})});
  accounts=makeAccounts();
  const post=async(route,body)=>{const r=await fetch(origin+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
  const begin=async()=>{
    const verifier=random(),start=await post("/api/im/auth/oidc/company/start",{code_challenge:digest(verifier)});
    assert.equal(start.status,200);
    const launched=await fetch(start.value.authorization_url,{redirect:"manual"});assert.equal(launched.status,302);
    const cookie=launched.headers.get("set-cookie").split(";")[0];
    assert.match(launched.headers.get("set-cookie"),/HttpOnly; SameSite=Lax/);
    const providerResponse=await fetch(launched.headers.get("location"),{redirect:"manual"});assert.equal(providerResponse.status,302);
    return {verifier,start:start.value,callback:providerResponse.headers.get("location"),cookie};
  };
  const finish=async(flow,url=flow.callback,cookie=flow.cookie)=>{
    const r=await fetch(url,{headers:{cookie},redirect:"manual"}),body=await r.text();
    return {status:r.status,body,code:/<code>([A-Za-z0-9_-]{43})<\/code>/.exec(body)?.[1],headers:r.headers};
  };
  const exchange=(flow,code)=>post("/api/im/auth/oidc/company/exchange",{code,code_verifier:flow.verifier});
  const bind=(id="human-1",subject="immutable-human")=>accounts.handleAdmin("POST","/api/im/admin/auth/bindings",{provider_id:"company",subject,principal_id:id});
  return {origin,config,settings,state,members,requests,begin,finish,exchange,post,bind,makeAuth,
    get accounts(){return accounts;},get auth(){return auth;},get saved(){return saved;},advance:(ms)=>{clock+=ms;},
    replaceConfig:(next)=>{auth=makeAuth(next);accounts=makeAccounts();}};
}

test("discovery defaults to password and machine credentials; invalid cloud configuration fails closed",()=>{
  assert.deepEqual(createNativeAuth().discovery(),{local_password:{enabled:true},machine_token:{enabled:true},providers:[]});
  for(const config of [null,[],{local_password:"false"},{oidc:[]},{oidc:{providers:null}},{oidc:{providers:[{}]}}])
    assert.throws(()=>createNativeAuth({config}),/Invalid authentication/);
});

test("real HTTP OIDC code + two PKCE boundaries bind immutable identity and never trust role/email/kind claims",async(t)=>{
  const f=await fixture(t,{confidential:true});await f.bind();
  const discovery=await (await fetch(f.origin+"/api/im/auth/providers")).json();
  assert.equal(discovery.providers[0].id,"company");
  assert.doesNotMatch(JSON.stringify(discovery),/issuer|client_id|secret|jwks|token_endpoint/);
  const flow=await f.begin(),result=await f.finish(flow);assert.equal(result.status,200);assert.ok(result.code);
  assert.match(result.headers.get("content-security-policy"),/frame-ancestors 'none'/);
  assert.equal(result.headers.get("cache-control"),"no-store");
  const session=await f.exchange(flow,result.code);assert.equal(session.status,200);
  assert.equal(session.value.principal.id,"human-1");assert.equal(session.value.principal.kind,"human");assert.equal(session.value.principal.roles,undefined);
  assert.equal(f.accounts.authenticate(session.value.token).id,"human-1");
  assert.doesNotMatch(f.saved,/never-persisted-access-token|fixture-secret|administrator@example/);
  assert.ok(!f.saved.includes(session.value.token));assert.ok(!f.saved.includes(result.code));
  assert.equal(f.requests.token,1);assert.equal(f.requests.jwks,1);
});

test("server rejects insecure endpoints, wrong redirect, secret-in-config and unapproved algorithms",async(t)=>{
  const f=await fixture(t),original=f.config.oidc.providers[0];
  assert.throws(()=>createNativeAuth({config:f.config}),/Invalid authentication/);
  for(const change of [{redirect_uri:f.origin+"/evil"},{authorization_endpoint:"https://user:pass@example.test/auth"},
    {jwks_uri:"https://example.test/keys?input=user"},{allowed_algorithms:["HS256"]},{client_secret:"hidden"},
    {token_endpoint_auth_method:"client_secret_basic",client_secret_env:"ABSENT"}]) {
    assert.throws(()=>f.makeAuth({oidc:{providers:[{...original,...change}]}}),/Invalid authentication/);
  }
});

test("launch, state, browser cookie and callback parameters resist replay and cross-provider mixup",async(t)=>{
  const f=await fixture(t);await f.bind();const flow=await f.begin();
  assert.equal((await fetch(flow.start.authorization_url,{redirect:"manual"})).status,401);
  assert.equal((await f.finish(flow,flow.callback,"")).status,401);
  const wrongState=new URL(flow.callback);wrongState.searchParams.set("state",random());
  assert.equal((await f.finish(flow,wrongState)).status,401);
  const duplicateState=new URL(flow.callback);duplicateState.searchParams.append("state",duplicateState.searchParams.get("state"));
  assert.equal((await f.finish(flow,duplicateState)).status,401);
  assert.equal(f.requests.token,0);
  assert.equal((await f.finish(flow)).status,200);
  assert.equal((await f.finish(flow)).status,401);
  const mixup=await f.begin(),badIssuer=new URL(mixup.callback);badIssuer.searchParams.set("iss","https://other.test");
  assert.equal((await f.finish(mixup,badIssuer)).status,401);assert.equal(f.requests.token,1);
});

test("one-time app code requires original verifier, expires, and cannot be replayed",async(t)=>{
  const f=await fixture(t);await f.bind();const flow=await f.begin(),result=await f.finish(flow);
  assert.equal((await f.post("/api/im/auth/oidc/company/exchange",{code:result.code,code_verifier:random()})).status,401);
  assert.equal((await f.exchange(flow,result.code)).status,200);assert.equal((await f.exchange(flow,result.code)).status,401);
  const next=await f.begin(),nextResult=await f.finish(next);f.advance(CODE_MS);
  assert.equal((await f.exchange(next,nextResult.code)).status,401);
  const expired=await f.begin();f.advance(FLOW_MS);
  assert.equal((await f.finish(expired)).status,401);
});

const invalidTokens=[
  ["unsigned algorithm",{header:{alg:"none"}}], ["symmetric algorithm",{header:{alg:"HS256"}}],
  ["unapproved type",{header:{typ:"at+jwt"}}], ["critical header",{header:{crit:["example"]}}],
  ["remote key header",{header:{jku:"https://attacker.test"}}], ["unknown key",{header:{kid:"unknown"}}],
  ["wrong signature",{signer:pair2.privateKey}], ["wrong issuer",{claims:{iss:"https://attacker.test"}}],
  ["wrong audience",{claims:{aud:"different-client"}}], ["multiple audiences without azp",{claims:{aud:["fixture-client","different-client"]}}],
  ["wrong azp",{claims:{azp:"different-client"}}], ["expired token",{claims:{exp:0}}],
  ["non-numeric expiry",{claims:{exp:"1900000000"}}], ["future issue time",{claims:{iat:1900000000}}],
  ["old issue time",{claims:{iat:0}}], ["future not-before",{claims:{nbf:1900000000}}],
  ["wrong nonce",{claims:{nonce:"incorrect"}}], ["missing subject",{claims:{sub:null}}],
  ["invalid access-token hash",{claims:{at_hash:"wrong"}}], ["invalid code hash",{claims:{c_hash:"wrong"}}],
];
for(const [name,mutation] of invalidTokens) test("OIDC rejects "+name,async(t)=>{
  const f=await fixture(t,mutation);await f.bind();const flow=await f.begin(),result=await f.finish(flow);
  assert.equal(result.status,401);assert.equal(result.code,undefined);assert.equal(f.state.accounts.sessions.length,0);
});

test("unbound email never provisions an account; explicit binding controls both humans and agents",async(t)=>{
  const f=await fixture(t);let flow=await f.begin(),result=await f.finish(flow);
  assert.equal((await f.exchange(flow,result.code)).value.code,"external_identity_unbound");
  assert.equal(f.state.accounts.identities.length,0);
  const binding=await f.bind("agent-1");
  await assert.rejects(f.bind("human-1"),{code:"external_identity_bound"});
  await assert.rejects(f.accounts.handleAdmin("POST","/api/im/admin/auth/bindings",{provider_id:"company",issuer:"https://other.test",subject:"other",principal_id:"human-1"}),{code:"invalid_identity_issuer"});
  flow=await f.begin();result=await f.finish(flow);const session=await f.exchange(flow,result.code);
  assert.equal(session.value.principal.id,"agent-1");
  await f.accounts.handleAdmin("DELETE","/api/im/admin/auth/bindings/"+binding.binding.id,{});
  assert.equal(f.accounts.authenticate(session.value.token),null);
});

test("disabled principal and disabled provider immediately invalidate external sessions",async(t)=>{
  const f=await fixture(t);await f.bind();let flow=await f.begin(),result=await f.finish(flow),session=await f.exchange(flow,result.code);
  f.members[0].disabled=true;assert.equal(f.accounts.authenticate(session.value.token),null);
  flow=await f.begin();result=await f.finish(flow);assert.equal((await f.exchange(flow,result.code)).value.code,"external_identity_unavailable");
  f.members[0].disabled=false;assert.equal(f.accounts.authenticate(session.value.token).id,"human-1");
  f.replaceConfig({});assert.equal(f.accounts.authenticate(session.value.token),null);
  assert.equal((await f.post("/api/im/auth/oidc/company/start",{code_challenge:digest(random())})).value.code,"auth_provider_unavailable");
});

test("local password provider can be disabled without enabling external login or machine credential changes",async(t)=>{
  const f=await fixture(t);await f.accounts.handleAdmin("POST","/api/im/admin/accounts",{principal_id:"human-1",username:"human",password:"fixture-password-123"});
  const session=await f.post("/api/im/auth/login",{username:"human",password:"fixture-password-123"});assert.equal(session.status,200);
  f.replaceConfig({local_password:false});assert.equal(f.accounts.authenticate(session.value.token),null);
  assert.equal((await f.post("/api/im/auth/login",{username:"human",password:"fixture-password-123"})).value.code,"auth_provider_disabled");
  await assert.rejects(f.accounts.handleAdmin("POST","/api/im/admin/accounts",{principal_id:"human-1",username:"human",password:"fixture-password-123"}),{code:"auth_provider_disabled"});
  assert.deepEqual(f.auth.discovery(),{local_password:{enabled:false},machine_token:{enabled:true},providers:[]});
});

for(const tokenResponse of ["redirect","large","malformed","missing"])test("OIDC token endpoint fails closed on "+tokenResponse,async(t)=>{
  const f=await fixture(t,{tokenResponse});const flow=await f.begin();assert.equal((await f.finish(flow)).status,401);assert.equal(f.requests.jwks,0);
});

test("JWKS rotation is bounded and duplicate/weak/non-signing keys fail closed",async(t)=>{
  const f=await fixture(t);await f.bind();const flow=await f.begin();assert.equal((await f.finish(flow)).status,200);assert.equal(f.requests.jwks,1);
  f.settings.header={kid:"rotated"};f.settings.signer=pair2.privateKey;
  f.settings.jwks=[{...pair2.publicKey.export({format:"jwk"}),kid:"rotated"}];
  let next=await f.begin();assert.equal((await f.finish(next)).status,401);assert.equal(f.requests.jwks,1);
  f.advance(30001);next=await f.begin();assert.equal((await f.finish(next)).status,200);assert.equal(f.requests.jwks,2);
  for(const jwks of [[...f.settings.jwks,...f.settings.jwks],[{...f.settings.jwks[0],use:"enc"}],
    [{...f.settings.jwks[0],key_ops:["sign"]}],[{...f.settings.jwks[0],d:"private-key-material"}]]) {
    f.settings.jwks=jwks;f.advance(5*60000+1);next=await f.begin();assert.equal((await f.finish(next)).status,401);
  }
});

test("public start has a bounded instance rate limit",async(t)=>{
  const f=await fixture(t);for(let i=0;i<60;i++)assert.equal((await f.post("/api/im/auth/oidc/company/start",{code_challenge:digest(random())})).status,200);
  assert.equal((await f.post("/api/im/auth/oidc/company/start",{code_challenge:digest(random())})).status,429);
  f.advance(60000);assert.equal((await f.post("/api/im/auth/oidc/company/start",{code_challenge:digest(random())})).status,200);
});

test("a stalled token endpoint aborts within the bounded transport timeout",async(t)=>{
  const f=await fixture(t,{tokenResponse:"hang"}),flow=await f.begin(),started=Date.now();
  assert.equal((await f.finish(flow)).status,401);
  assert.ok(Date.now()-started<7000);assert.equal(f.requests.jwks,0);
});

test("multiple audiences require the correct authorized party and RSA keys must be at least 2048 bits",async(t)=>{
  const f=await fixture(t,{claims:{aud:["fixture-client","second-audience"],azp:"fixture-client"}});
  let flow=await f.begin();assert.equal((await f.finish(flow)).status,200);
  const weak=crypto.generateKeyPairSync("rsa",{modulusLength:1024});
  f.settings.signer=weak.privateKey;f.settings.jwks=[{...weak.publicKey.export({format:"jwk"}),kid:"current"}];
  f.advance(5*60000+1);flow=await f.begin();assert.equal((await f.finish(flow)).status,401);
});
