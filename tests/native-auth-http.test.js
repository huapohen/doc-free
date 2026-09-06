"use strict";
// Isolated copies of the actual server; no local .env, live state or 3218 port.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),http=require("node:http"),crypto=require("node:crypto");
const {spawn}=require("node:child_process"),{once}=require("node:events");
const root=path.resolve(__dirname,".."),random=()=>crypto.randomBytes(32).toString("base64url"),hash=(s)=>crypto.createHash("sha256").update(s).digest("base64url");
const pair=crypto.generateKeyPairSync("rsa",{modulusLength:2048});
async function freePort(){const s=http.createServer().listen(0,"127.0.0.1");await once(s,"listening");const p=s.address().port;await new Promise(r=>s.close(r));assert.notEqual(p,3218);return p;}
test("actual server OIDC discovery/login reaches REST, MCP and A2A, and binding revocation removes access",async(t)=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-auth-http-")),stage=path.join(temporary,"server");fs.mkdirSync(stage);
  const children=[],secrets=[],admin=random();secrets.push(admin);
  t.after(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,"exit");}for(const secret of secrets)assert.ok(!child.output.includes(secret),"child output must not contain credentials");}fs.rmSync(temporary,{recursive:true,force:true});});
  for(const e of fs.readdirSync(root,{withFileTypes:true}))if(e.isFile()&&(e.name.endsWith(".js")||e.name==="index.html"))fs.copyFileSync(path.join(root,e.name),path.join(stage,e.name));
  fs.symlinkSync(path.join(root,"node_modules"),path.join(stage,"node_modules"),process.platform==="win32"?"junction":"dir");
  const port=await freePort(),base=`http://127.0.0.1:${port}`,codes=new Map();let issuer;
  const provider=http.createServer(async(req,res)=>{
    const url=new URL(req.url,issuer);
    if(url.pathname==="/authorize"){
      const code=random();codes.set(code,Object.fromEntries(url.searchParams));
      const target=new URL(url.searchParams.get("redirect_uri"));target.searchParams.set("code",code);target.searchParams.set("state",url.searchParams.get("state"));
      res.writeHead(302,{location:target.href});return res.end();
    }
    if(url.pathname==="/token"){
      let body="";for await(const c of req)body+=c;
      const input=new URLSearchParams(body),flow=codes.get(input.get("code"));codes.delete(input.get("code"));
      if(!flow||flow.code_challenge!==hash(input.get("code_verifier"))){res.writeHead(401);return res.end();}
      const header=Buffer.from(JSON.stringify({alg:"RS256",kid:"http"})).toString("base64url");
      const payload=Buffer.from(JSON.stringify({iss:issuer,sub:"fixed-company-subject",aud:"fixture-http",nonce:flow.nonce,
        exp:Math.floor(Date.now()/1000)+300,iat:Math.floor(Date.now()/1000),role:"owner",kind:"agent"})).toString("base64url");
      const raw=header+"."+payload,idToken=raw+"."+crypto.sign("RSA-SHA256",Buffer.from(raw),pair.privateKey).toString("base64url");secrets.push(idToken);
      res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({id_token:idToken}));
    }
    if(url.pathname==="/jwks"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({keys:[{...pair.publicKey.export({format:"jwk"}),kid:"http"}]}));}
    res.writeHead(404);res.end();
  }).listen(0,"127.0.0.1");await once(provider,"listening");issuer=`http://127.0.0.1:${provider.address().port}`;
  t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const configFile=path.join(temporary,"auth-config.json");
  fs.writeFileSync(configFile,JSON.stringify({oidc:{providers:[{id:"company",label:"Isolated HTTP fixture",issuer,
    authorization_endpoint:issuer+"/authorize",token_endpoint:issuer+"/token",jwks_uri:issuer+"/jwks",client_id:"fixture-http",
    redirect_uri:base+"/api/im/auth/oidc/company/callback"}]}}));
  const environment={PATH:process.env.PATH||"",PORT:String(port),HOST:"127.0.0.1",DOC_FREE_TOKEN:admin,
    DOC_FREE_AUTH_CONFIG:configFile,DOC_FREE_AUTH_ALLOW_HTTP_LOOPBACK:"1",DOC_FREE_DATA:path.join(temporary,"data.json"),
    DOC_FREE_IM_DATA:path.join(temporary,"native-im.json"),DOC_FREE_PUBLIC_URL:base,COLLAB_URL:`http://127.0.0.1:${await freePort()}`};
  async function start(){
    const child=spawn(process.execPath,["server.js"],{cwd:stage,env:environment,stdio:["ignore","pipe","pipe"]});child.output="";
    for(const stream of [child.stdout,child.stderr])stream.on("data",c=>{child.output+=c.toString();});children.push(child);
    for(let attempt=0;attempt<100;attempt++){if(child.exitCode!==null)throw new Error("isolated auth server exited");
      try{await fetch(base+"/health",{signal:AbortSignal.timeout(200)});return child;}catch{}await new Promise(r=>setTimeout(r,30));}
    throw new Error("isolated auth server readiness timeout");
  }
  const child=await start();let requests=0;
  async function api(route,method="GET",input,token="",expected=200){requests++;const r=await fetch(base+"/api/im"+route,{method,
    headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:input?JSON.stringify(input):undefined});
    assert.equal(r.status,expected,`${method} ${route} status`);return r.json();}
  const discovery=await api("/auth/providers");assert.equal(discovery.providers.length,1);
  const human=await api("/admin/principals","POST",{name:"OIDC Human",kind:"human"},admin);secrets.push(human.token);
  const username="oidc-http",password=random();secrets.push(password);
  await api("/admin/accounts","POST",{principal_id:human.principal.id,username,password},admin);
  const local=await api("/auth/login","POST",{username,password});secrets.push(local.token);
  await api("/admin/auth/bindings","GET",undefined,local.token,401);
  const bound=await api("/admin/auth/bindings","POST",{provider_id:"company",subject:"fixed-company-subject",principal_id:human.principal.id},admin);
  assert.equal((await api("/admin/auth/bindings","GET",undefined,admin)).bindings.length,1);
  async function login(){
    const verifier=random(),flow=await api("/auth/oidc/company/start","POST",{code_challenge:hash(verifier)});
    const opened=await fetch(flow.authorization_url,{redirect:"manual"});assert.equal(opened.status,302);
    const cookie=opened.headers.get("set-cookie").split(";")[0];
    const granted=await fetch(opened.headers.get("location"),{redirect:"manual"});
    const callback=await fetch(granted.headers.get("location"),{headers:{cookie}});assert.equal(callback.status,200);
    const code=/<code>([A-Za-z0-9_-]{43})<\/code>/.exec(await callback.text())[1];secrets.push(code);
    const session=await api("/auth/oidc/company/exchange","POST",{code,code_verifier:verifier});secrets.push(session.token);return session;
  }
  const session=await login();assert.equal(session.principal.kind,"human");assert.equal(session.principal.id,human.principal.id);
  assert.equal((await api("/me","GET",undefined,session.token)).principal.id,human.principal.id);
  const rpc=(method,params)=>({jsonrpc:"2.0",id:random(),method,params});
  const mcp=await api("/mcp","POST",rpc("tools/call",{name:"im_identity",arguments:{}}),session.token);
  assert.equal(JSON.parse(mcp.result.content[0].text).principal.id,human.principal.id);
  const a2a=await api("/a2a","POST",rpc("message/send",{message:{messageId:random(),role:"user",parts:[{kind:"data",data:{operation:"im_identity",arguments:{}}}]}}),session.token);
  assert.equal(a2a.result.status.state,"completed");
  const legacy=await fetch(base+"/api/workspace/me",{headers:{authorization:"Bearer "+session.token}});assert.equal(legacy.status,401);
  await api("/admin/auth/bindings/"+bound.binding.id,"DELETE",undefined,admin);
  await api("/me","GET",undefined,session.token,401);
  await api("/mcp","POST",rpc("tools/call",{name:"im_identity",arguments:{}}),session.token,401);
  await api("/a2a","POST",rpc("tasks/get",{id:a2a.result.id}),session.token,401);
  assert.equal((await api("/me","GET",undefined,local.token)).principal.id,human.principal.id);
  assert.equal((await api("/me","GET",undefined,human.token)).principal.id,human.principal.id);
  const durable=fs.readFileSync(environment.DOC_FREE_IM_DATA,"utf8");for(const secret of secrets)assert.ok(!durable.includes(secret),"durable state must not contain raw credentials");
  child.kill();await once(child,"exit");fs.writeFileSync(configFile,JSON.stringify({local_password:false}));await start();
  assert.deepEqual(await api("/auth/providers"),{local_password:{enabled:false},machine_token:{enabled:true},providers:[]});
  await api("/me","GET",undefined,local.token,401);await api("/auth/login","POST",{username,password},"",403);
  assert.equal((await api("/me","GET",undefined,human.token)).principal.id,human.principal.id);
  t.diagnostic(`actual server authentication API requests: ${requests}; plus browser/provider round trips`);
});
