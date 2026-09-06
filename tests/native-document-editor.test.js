"use strict";
const {test,before,after}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),http=require("node:http"),crypto=require("node:crypto");
const {spawn}=require("node:child_process"),{once}=require("node:events");
const Y=require("yjs"),{HocuspocusProvider}=require("@hocuspocus/provider"),WebSocket=require("ws");
const {createNativeDocumentEditor}=require("../native-document-editor");
const {contractDocument}=require("../work-protocol");
const random=()=>crypto.randomBytes(32).toString("base64url"),pause=(ms)=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,message,timeout=5000){const start=Date.now();while(Date.now()-start<timeout){if(await predicate())return;await pause(20);}assert.fail(message);}
function editorFixture(){
  let clock=1000,allowed=true,contract=null;
  const calls=[],credential=random();
  const im={handle:async(...args)=>{calls.push(args);if(!allowed)throw Object.assign(new Error("revoked"),{status:401});return{document:{id:"doc-one",title:"Shared",content:"Initial",contract}};},
    authorizeDocument:(token,room,doc)=>{assert.equal(token,credential);assert.equal(room,"room-one");assert.equal(doc,"doc-one");if(!allowed)throw Object.assign(new Error("revoked"),{status:401});return{id:"human-one",kind:"human",name:"Fixture"};}};
  const editor=createNativeDocumentEditor({im,now:()=>clock});return{editor,credential,calls,advance:(ms)=>clock+=ms,revoke:()=>allowed=false,setContract:()=>contract={protocol:"active-doc/v1",kind:"mission"}};
}
test("editor issues one-use fragment tickets and document-only expiring capabilities without exposing the source credential",async()=>{
  const f=editorFixture(),link=await f.editor.issue(f.credential,"room-one","doc-one");
  assert.equal(link.scope,"single_document");assert.equal(link.expires_in,60);
  assert.ok(!JSON.stringify(link).includes(f.credential));assert.match(link.path,/^\/office-document#open=[A-Za-z0-9_-]{43}$/);
  const ticket=link.path.split("#open=")[1],session=f.editor.exchange(ticket);
  assert.ok(!JSON.stringify(session).includes(f.credential));assert.match(session.access_token,/^office-doc_[A-Za-z0-9_-]{43}$/);
  assert.throws(()=>f.editor.exchange(ticket),{code:"editor_ticket_expired"});
  assert.throws(()=>f.editor.authorize(session.access_token,"doc-another"),{code:"document_scope"});
  assert.equal((await f.editor.read(session.access_token)).document.id,"doc-one");
  f.advance(30*60000);assert.throws(()=>f.editor.authorize(session.access_token,"doc-doc-one"),{code:"editor_session_expired"});
});
test("ticket expiry, source revocation, contract refusal and explicit close fail closed",async()=>{
  const f=editorFixture(),expired=await f.editor.issue(f.credential,"room-one","doc-one");f.advance(60000);
  assert.throws(()=>f.editor.exchange(expired.path.split("#open=")[1]),{code:"editor_ticket_expired"});
  const opened=f.editor.exchange((await f.editor.issue(f.credential,"room-one","doc-one")).path.split("#open=")[1]);
  f.editor.close(opened.access_token);await assert.rejects(f.editor.read(opened.access_token),{code:"editor_session_expired"});
  const revoked=await f.editor.issue(f.credential,"room-one","doc-one");f.revoke();assert.throws(()=>f.editor.exchange(revoked.path.split("#open=")[1]),{status:401});
  const contract=editorFixture();contract.setContract();await assert.rejects(contract.editor.issue(contract.credential,"room-one","doc-one"),{code:"immutable_record"});
});
test("editor bounds pending capabilities and rejects live sessions after source revocation",async()=>{
  const f=editorFixture();for(let i=0;i<1000;i++)await f.editor.issue(f.credential,"room-one","doc-one");
  await assert.rejects(f.editor.issue(f.credential,"room-one","doc-one"),{code:"editor_capacity"});
  f.advance(60000);const issued=await f.editor.issue(f.credential,"room-one","doc-one"),session=f.editor.exchange(issued.path.split("#open=")[1]);
  f.revoke();await assert.rejects(f.editor.read(session.access_token),{status:401});
});

const root=path.resolve(__dirname,".."),temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-editor-http-")),stage=path.join(temporary,"server"),admin=random(),secrets=[admin],clients=[],children=[];
let child,base,collabURL,environment,apiRequests=0,governanceOwner;
async function freePort(){const s=http.createServer().listen(0,"127.0.0.1");await once(s,"listening");const port=s.address().port;await new Promise(r=>s.close(r));assert.notEqual(port,3218);return port;}
before(async()=>{
  fs.mkdirSync(stage);for(const e of fs.readdirSync(root,{withFileTypes:true}))if(e.isFile()&&(/\.(js|html|css)$/.test(e.name)||e.name==="native-emoji-catalog.json"))fs.copyFileSync(path.join(root,e.name),path.join(stage,e.name));
  if(fs.existsSync(path.join(root,"public")))fs.cpSync(path.join(root,"public"),path.join(stage,"public"),{recursive:true});
  fs.symlinkSync(path.join(root,"node_modules"),path.join(stage,"node_modules"),process.platform==="win32"?"junction":"dir");
  const port=await freePort(),collabPort=await freePort();base=`http://127.0.0.1:${port}`;collabURL=`http://127.0.0.1:${collabPort}`;
  environment={PATH:process.env.PATH||"",PORT:String(port),HOST:"127.0.0.1",COLLAB_PORT:String(collabPort),COLLAB_HOST:"127.0.0.1",COLLAB_URL:collabURL,DOC_FREE_TOKEN:admin,
    DOC_FREE_EMBED_COLLAB:"1",DOC_FREE_PUBLIC_URL:base,DOC_FREE_DATA:path.join(temporary,"data.json"),DOC_FREE_IM_DATA:path.join(temporary,"im.json"),DOC_FREE_CRDT_DIR:path.join(temporary,"crdt")};
  await startServer();
});
async function startServer(){
  const processChild=spawn(process.execPath,["server.js"],{cwd:stage,env:environment,stdio:["ignore","pipe","pipe"]});processChild.output="";
  children.push(processChild);child=processChild;
  for(const stream of [processChild.stdout,processChild.stderr])stream.on("data",chunk=>processChild.output+=chunk.toString());
  await until(async()=>{if(child.exitCode!==null)assert.fail("isolated embedded editor server exited");try{return(await fetch(base+"/health",{signal:AbortSignal.timeout(200)})).ok;}catch{return false;}},"embedded editor server did not start");
  await until(async()=>{try{return(await fetch(collabURL+"/health",{signal:AbortSignal.timeout(200)})).ok;}catch{return false;}},"embedded CRDT listener did not start");
}
after(async(t)=>{
  for(const client of clients){client.provider.destroy();client.doc.destroy();}
  for(const processChild of children){
    if(processChild.exitCode===null&&processChild.signalCode===null){processChild.kill();await once(processChild,"exit");}
    for(const secret of secrets)assert.ok(!processChild.output.includes(secret),"server output leaked a credential");
  }
  fs.rmSync(temporary,{recursive:true,force:true});
  t.diagnostic(`isolated editor HTTP requests: ${apiRequests}; plus real Hocuspocus WebSocket traffic`);
});
async function request(route,{token="",method="GET",body,status=200}={}){
  apiRequests++;const response=await fetch(base+route,{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal(response.status,status,`${method} ${route.split("?")[0]} status`);return{response,value:await response.json()};
}
async function api(token,route,method="GET",body,status=200){return(await request("/api/im"+route,{token,method,body,status})).value;}
async function setup(){
  const owner=await api(admin,"/admin/principals","POST",{name:"Editor owner",kind:"human"});secrets.push(owner.token);
  if(!governanceOwner){await api(admin,"/admin/enterprise/bootstrap","POST",{principal_id:owner.principal.id});governanceOwner=owner;}
  const peer=await api(admin,"/admin/principals","POST",{name:"Editor agent",kind:"agent"});secrets.push(peer.token);
  const password=random(),username="editor-"+random().slice(0,12);secrets.push(password);
  await api(admin,"/admin/accounts","POST",{principal_id:peer.principal.id,username,password});
  const login=await api("","/auth/login","POST",{username,password});secrets.push(login.token);
  const {room}=await api(owner.token,"/rooms","POST",{name:"Visible collaborative work"});
  await api(owner.token,`/rooms/${room.id}/members`,"POST",{principal_id:peer.principal.id});
  const {document}=await api(owner.token,`/rooms/${room.id}/documents`,"POST",{title:"Shared fixture",content:"Initial paragraph."});
  const {document:other}=await api(owner.token,`/rooms/${room.id}/documents`,"POST",{title:"Different fixture",content:"Other private paragraph."});
  const route=`/rooms/${room.id}/documents/${document.id}`;
  const open=async(token=login.token,doc=document)=>{
    const link=await api(token,`/rooms/${room.id}/documents/${doc.id}/editor-session`,"POST",{});
    assert.ok(!JSON.stringify(link).includes(token));
    const ticket=link.path.split("#open=")[1];secrets.push(ticket);
    const result=await request("/api/office-document/session",{method:"POST",body:{ticket}});
    assert.equal(result.response.headers.get("cache-control"),"no-store");
    secrets.push(result.value.access_token);return result.value;
  };
  return{owner,peer,login,room,document,other,route,open};
}
function client(access,documentId){
  const state={doc:new Y.Doc(),synced:false,failed:false,disconnected:false,updates:0,presenceNames:new Set()};
  state.provider=new HocuspocusProvider({url:base.replace("http","ws")+"/collab",name:"doc-"+documentId,token:access,document:state.doc,WebSocketPolyfill:WebSocket,
    onSynced:({state:ready})=>{if(ready)state.synced=true;},onAuthenticationFailed:()=>{state.failed=true;},onDisconnect:()=>{state.disconnected=true;},onClose:()=>{state.disconnected=true;},
    onAwarenessUpdate:({states})=>{for(const value of states)if(value.user?.name)state.presenceNames.add(value.user.name);}});
  state.doc.on("update",()=>state.updates++);clients.push(state);return state;
}
const text=(c)=>c.doc.getXmlFragment("default").toString();
function append(c,value){const paragraph=new Y.XmlElement("paragraph"),inline=new Y.XmlText();inline.insert(0,value);paragraph.insert(0,[inline]);c.doc.getXmlFragment("default").push([paragraph]);}
async function synced(...values){await until(()=>values.every(v=>v.synced),"real Hocuspocus clients did not synchronize");}
async function closed(c){await until(()=>c.failed||c.disconnected,"revoked editor connection did not close");c.provider.destroy();}

test("two real Hocuspocus/Y.Doc clients collaborate through the actual server and export canonical revisions",async()=>{
  const f=await setup(),a=await f.open(f.owner.token),b=await f.open(),first=client(a.access_token,f.document.id),second=client(b.access_token,f.document.id);
  await synced(first,second);assert.match(text(first),/Initial paragraph/);assert.match(text(second),/Initial paragraph/);
  append(first,"Human concurrent material.");append(second,"Agent concurrent material.");
  await until(()=>text(first).includes("Agent concurrent material")&&text(second).includes("Human concurrent material"),"concurrent human/agent edits did not merge");
  const read=await request("/api/office-document",{token:a.access_token});assert.match(read.value.document.content,/Human concurrent material/);assert.match(read.value.document.content,/Agent concurrent material/);assert.ok(read.value.document.revision>1);
  second.provider.awareness.setLocalStateField("user",{name:"Forged owner",kind:"human",principal_id:f.owner.principal.id});
  await until(()=>[...first.provider.awareness.getStates().values()].some(s=>s.user?.principal_id===f.peer.principal.id),"server-bound editor presence was not delivered");
  const presence=[...first.provider.awareness.getStates().values()].find(s=>s.user?.principal_id===f.peer.principal.id).user;
  assert.equal(presence.kind,"agent");assert.equal(presence.name,f.peer.principal.name);
  await api(a.access_token,"/me","GET",undefined,401);
  const wrong=client(a.access_token,f.other.id);await until(()=>wrong.failed,"single-document capability authenticated another document");wrong.provider.destroy();
  const source=client(f.login.token,f.document.id);await until(()=>source.failed,"raw member source session authenticated the document transport");source.provider.destroy();
  await request("/api/workspace",{token:a.access_token,status:401});
  const internal=await fetch(collabURL+"/internal/read",{method:"POST",headers:{authorization:"Bearer "+a.access_token,"content-type":"application/json"},body:JSON.stringify({document_id:f.document.id})});assert.equal(internal.status,401);
  first.provider.destroy();second.provider.destroy();
});

for(const mode of ["logout","remove","docs-disabled"])for(const direction of ["inbound","outbound"])test(`source ${mode} blocks ${direction} data for already connected editors`,async()=>{
  const f=await setup(),session=await f.open(),victim=client(session.access_token,f.document.id),observer=client(admin,f.document.id);
  await synced(victim,observer);const prior=text(victim);
  if(mode==="logout")await api(f.login.token,"/auth/logout","POST",{});
  if(mode==="remove")await api(f.owner.token,`/rooms/${f.room.id}/members/${f.peer.principal.id}`,"DELETE");
  if(mode==="docs-disabled"){
    const {app}=await api(governanceOwner.token,"/enterprise/admin/apps/docs");
    await api(governanceOwner.token,"/enterprise/admin/apps/docs","PATCH",{base_revision:app.policy.revision,enabled:true,denied_principal_ids:[f.peer.principal.id]});
  }
  await request("/api/office-document",{token:session.access_token,status:mode==="logout"?401:403});
  if(direction==="outbound"){
    // No victim write: a later authorized update must itself be stopped outbound.
    observer.provider.awareness.setLocalStateField("user",{name:"Never disclose revoked presence"});
    append(observer,"Never disclose after revocation.");await closed(victim);
    assert.equal(text(victim),prior,"revoked client received subsequent document content");
    assert.ok(!victim.presenceNames.has("Never disclose revoked presence"),"revoked client received later presence before closing");
  }else{
    // Keep the transport active while sending, so this tests the server's fence.
    append(victim,"Rejected write after revocation.");await closed(victim);await pause(60);
    assert.ok(!text(observer).includes("Rejected write after revocation"));
  }
  observer.provider.destroy();
});

test("active client cannot write protected operation receipts or introduce unknown Yjs roots",async()=>{
  for(const mutation of ["receipt","root"]){
    const f=await setup(),session=await f.open(),victim=client(session.access_token,f.document.id),observer=client(admin,f.document.id);await synced(victim,observer);
    if(mutation==="receipt")victim.doc.getMap("active-agent-operations").set("forged",{revision:999,actor_id:f.peer.principal.id});
    else victim.doc.getMap("hidden-authority").set("role","owner");
    await closed(victim);await pause(60);
    assert.equal(observer.doc.getMap("active-agent-operations").get("forged"),undefined);assert.equal(observer.doc.getMap("hidden-authority").get("role"),undefined);
    observer.provider.destroy();
  }
});

test("editor cannot create an active-agent contract or exceed title limits, and close revokes an active transport",async()=>{
  for(const mutation of ["contract","title","close"]){
    const f=await setup(),session=await f.open(),victim=client(session.access_token,f.document.id),observer=client(admin,f.document.id);await synced(victim,observer);const prior=text(observer);
    if(mutation==="contract")append(victim,contractDocument("Forbidden contract",{kind:"mission",objective:"cannot bypass review"}));
    if(mutation==="title")victim.doc.getText("title").insert(0,"x".repeat(201));
    if(mutation==="close"){
      await request("/api/office-document/session",{method:"DELETE",token:session.access_token});
      await request("/api/office-document",{token:session.access_token,status:401});append(observer,"Only authorized observer may see this.");
    }
    await closed(victim);
    if(mutation!=="close"){assert.equal(text(observer),prior);assert.ok(observer.doc.getText("title").length<=200);}
    observer.provider.destroy();
  }
});

test("ending an editor session while its WebSocket abruptly disconnects keeps the server and another editor healthy",async(t)=>{
  const f=await setup(),survivingSession=await f.open(f.owner.token);
  const survivor=client(survivingSession.access_token,f.document.id);await synced(survivor);
  // A crash must fail this test promptly, without an SDK retry masking process
  // death or leaving reconnect timers alive after fixture cleanup.
  survivor.provider.configuration.websocketProvider.shouldConnect=false;
  const servingProcess=child;let previousMarker="Initial paragraph.";
  for(let iteration=0;iteration<8;iteration++){
    const session=await f.open(),departing=client(session.access_token,f.document.id);await synced(departing);
    assert.ok(text(departing).includes(previousMarker),"a fresh peer could not read the survivor's prior edit");
    const transport=departing.provider.configuration.websocketProvider;
    // Suppress SDK retries without disconnecting the live socket before DELETE.
    transport.shouldConnect=false;
    const socket=transport.webSocket;assert.equal(socket.readyState,WebSocket.OPEN);
    const disconnected=new Promise(resolve=>socket.once("close",resolve));
    const {value}=await request("/api/office-document/session",{method:"DELETE",token:session.access_token});
    assert.equal(value.closed,true);
    const marker=`Continuing peer after abrupt session close ${iteration} ${random()}`;
    // Exercise both queued peer traffic with TCP reset and a tab that vanishes
    // before the next peer write. Neither sends a WebSocket close handshake.
    if(iteration%2)append(survivor,marker);
    if(iteration%2)socket._socket.resetAndDestroy();
    else socket.terminate();
    if(!(iteration%2))append(survivor,marker);
    await disconnected;departing.provider.destroy();
    await until(async()=>{
      assert.equal(servingProcess.exitCode,null,"session close crashed the HTTP/CRDT process");
      assert.equal(servingProcess.signalCode,null,"session close terminated the HTTP/CRDT process");
      const {value:health}=await request("/health");assert.equal(health.ok,true);
      const {value:read}=await request("/api/office-document",{token:survivingSession.access_token});
      return read.document.content.includes(marker);
    },"surviving editor could not persist and read an edit after peer disconnect");
    await request("/api/office-document",{token:session.access_token,status:401});
    assert.equal(survivor.disconnected,false,"unrelated editor transport was disconnected");
    previousMarker=marker;
  }
  const freshSession=await f.open(),fresh=client(freshSession.access_token,f.document.id);await synced(fresh);
  const reply="Fresh peer writes after all abrupt closes "+random();append(fresh,reply);
  await until(()=>text(survivor).includes(reply),"other peers could not continue bidirectional editing");
  assert.equal((await request("/health")).value.ok,true);
  fresh.provider.destroy();survivor.provider.destroy();
  t.diagnostic("8 real DELETE + abrupt WebSocket disconnect/TCP reset races; same process health, capability revocation and surviving bidirectional CRDT edits verified");
});

test("a peer-visible CRDT edit survives immediate SIGKILL before any canonical read or debounce and remains editable after restart",async(t)=>{
  const f=await setup(),authorSession=await f.open(f.owner.token),peerSession=await f.open();
  const author=client(authorSession.access_token,f.document.id),peer=client(peerSession.access_token,f.document.id);await synced(author,peer);
  // Keep these sockets fully live, but do not schedule SDK reconnect timers
  // when the process is killed. Recovery below deliberately uses fresh caps.
  author.provider.configuration.websocketProvider.shouldConnect=false;
  peer.provider.configuration.websocketProvider.shouldConnect=false;
  const marker="Durable peer-visible edit "+random(),beforeRequests=apiRequests,dying=child,exited=once(dying,"exit");
  let delivered=false,signalSent=false;
  const received=()=>{
    if(delivered||!text(peer).includes(marker))return;
    delivered=true;
    // Kill inside the peer's update callback: no read endpoint, timer, provider
    // disconnect or graceful onStore has an opportunity to cause persistence.
    signalSent=dying.kill("SIGKILL");
  };
  peer.doc.on("update",received);
  append(author,marker);
  const timeout=setTimeout(()=>{if(!delivered)dying.kill("SIGKILL");},5000);
  const [,signal]=await exited;clearTimeout(timeout);peer.doc.off("update",received);
  assert.equal(delivered,true,"peer never observed the edit before the crash");assert.equal(signalSent,true);assert.equal(signal,"SIGKILL");
  assert.equal(apiRequests,beforeRequests,"a canonical HTTP read occurred before SIGKILL");
  author.provider.destroy();peer.provider.destroy();
  // Also inspect the crash artifact before restarting, so startup cannot mask
  // a lost update by rebuilding from a stale canonical projection.
  const disk=new Y.Doc();Y.applyUpdate(disk,fs.readFileSync(path.join(environment.DOC_FREE_CRDT_DIR,encodeURIComponent("doc-"+f.document.id)+".bin")));
  assert.ok(disk.getXmlFragment("default").toString().includes(marker));disk.destroy();
  await startServer();
  await request("/api/office-document",{token:authorSession.access_token,status:401});
  const reopened=await f.open(f.owner.token),partner=await f.open();
  const first=client(reopened.access_token,f.document.id),second=client(partner.access_token,f.document.id);await synced(first,second);
  assert.ok(text(first).includes(marker));assert.ok(text(second).includes(marker));
  const canonical=(await request("/api/office-document",{token:reopened.access_token})).value.document;
  assert.ok(canonical.content.includes(marker));assert.equal(canonical.revision,f.document.revision+1);
  assert.equal((await request("/api/office-document",{token:reopened.access_token})).value.document.revision,canonical.revision,"repeated read created an extra revision");
  const continuation="Post-restart collaborative edit "+random();append(second,continuation);
  await until(()=>text(first).includes(continuation),"restarted document could not be edited collaboratively");
  const next=(await request("/api/office-document",{token:reopened.access_token})).value.document;
  assert.ok(next.content.includes(marker)&&next.content.includes(continuation));assert.equal(next.revision,canonical.revision+1);
  first.provider.destroy();second.provider.destroy();
  t.diagnostic("SIGKILL sent synchronously from peer Y.Doc update; crash file inspected before restart; no canonical read before kill");
});
