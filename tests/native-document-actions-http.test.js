"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),net=require("node:net"),crypto=require("node:crypto");
const {spawn}=require("node:child_process"),{once}=require("node:events");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"native-document-actions-http-")),root=path.resolve(__dirname,"..");
const admin=crypto.randomBytes(32).toString("hex"),imFile=path.join(directory,"im.json"),children=[];
let base,environment,server;
const pause=(ms)=>new Promise((r)=>setTimeout(r,ms));
async function port(){const s=net.createServer().listen(0,"127.0.0.1");await once(s,"listening");const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function start(script){const p=spawn(process.execPath,[script],{cwd:root,env:environment,stdio:["ignore","ignore","pipe"]});p.stderr.resume();children.push(p);return p;}
async function ready(url,p){for(let i=0;i<100;i++){if(p.exitCode!==null)throw new Error("isolated fixture process exited");try{const r=await fetch(url,{signal:AbortSignal.timeout(200)});if(r.ok)return;}catch{}await pause(50);}throw new Error("isolated fixture startup timeout");}
async function stop(p){if(p.exitCode===null&&p.signalCode===null){p.kill();await once(p,"exit");}}
before(async()=>{const httpPort=await port(),collabPort=await port();base="http://127.0.0.1:"+httpPort;
  environment={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:os.tmpdir(),PORT:String(httpPort),COLLAB_PORT:String(collabPort),COLLAB_URL:"http://127.0.0.1:"+collabPort,DOC_FREE_TOKEN:admin,
    DOC_FREE_DATA:path.join(directory,"documents.json"),DOC_FREE_CRDT_DIR:path.join(directory,"crdt"),DOC_FREE_IM_DATA:imFile};
  const collab=start("collab-server.js");await ready(environment.COLLAB_URL+"/health",collab);server=start("server.js");await ready(base+"/health",server);
});
after(async()=>{for(const p of children)await stop(p);fs.rmSync(directory,{recursive:true,force:true});});
async function call(token,route,method="GET",body,status=200){const r=await fetch(base+"/api/im"+route,{method,headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();assert.equal(r.status,status,JSON.stringify({error:v.error}));return v;}
async function setup(){const human=await call(admin,"/admin/principals","POST",{name:"Fixture human",kind:"human"}),agent=await call(admin,"/admin/principals","POST",{name:"Fixture author",kind:"agent"});
  const {room}=await call(human.token,"/rooms","POST",{name:"Canonical recovery fixture"}),base="/rooms/"+room.id;
  await call(human.token,base+"/members","POST",{principal_id:agent.principal.id});
  const {message}=await call(human.token,base+"/messages","POST",{client_id:crypto.randomUUID(),content:"Publish a shared delivery and create the follow-up task."});
  const c=await call(agent.token,base+"/turns/claim","POST",{model:"fixture",reasoning_effort:"medium",instructions:"Fixture only; no model call.",lease_seconds:30});
  const route=base+"/turns/"+c.turn.id;
  const freeze=async(steps)=>call(agent.token,route+"/plan","POST",{lease_token:c.turn.lease_token,context_hash:c.context.context_hash,model:"fixture",reasoning_effort:"medium",summary:"Publish actual canonical work",
    final_result:{action:"reply",content:"See canonical delivery and operation receipts.",rationale:"Captured request",mentions:[],artifact:null},
    steps:steps.map((step,i)=>({key:"step-"+i,evidence:[{kind:"message",id:message.id,revision:1,quote:message.content}],...step}))});
  const execute=(plan,i)=>call(agent.token,route+"/operations/"+plan.steps[i].operation_id+"/execute","POST",{lease_token:c.turn.lease_token,plan_hash:plan.hash});
  return{human,agent,room,base,c,route,freeze,execute};
}

test("actual HTTP and CRDT create-update receipts produce one canonical document and a real task",async()=>{
  const f=await setup();assert.ok(f.c.context.actions.operations.some(o=>o.name==="im_create_document"));
  const {plan}=await f.freeze([{operation:"im_create_document",arguments:{title:"Shared delivery",content:"# Delivery\n\nInitial verified material."}},
    {operation:"im_update_document",arguments:{document_id:{step_key:"step-0",field:"resource_id"},base_revision:1,content:"# Delivery\n\nFinal shared material."}},
    {operation:"im_create_task",arguments:{title:"Review actual shared delivery",assignee_id:f.human.principal.id}}]);
  const first=await f.execute(plan,0);assert.equal(first.receipt.status,"committed");assert.equal((await f.execute(plan,0)).duplicate,true);
  assert.equal((await f.execute(plan,1)).receipt.status,"committed");assert.equal((await f.execute(plan,2)).receipt.status,"committed");
  const document=(await call(f.human.token,f.base+"/documents/"+first.receipt.resource_id)).document;
  assert.equal(document.revision,2);assert.equal(document.content,"# Delivery\n\nFinal shared material.");
  const finished=await call(f.agent.token,f.route+"/finish","POST",{...plan.final_result,lease_token:f.c.turn.lease_token,model:"fixture",reasoning_effort:"medium"});
  assert.equal(finished.turn.status,"replied");assert.equal(finished.turn.action_receipts.length,3);
  const room=await call(f.human.token,f.base);assert.equal(room.documents.length,1);assert.equal(room.tasks.length,1);
  await stop(server);server=start("server.js");await ready(baseGlobal()+"/health",server);
  const read=await call(f.agent.token,f.route+"/plan");assert.equal(read.receipts[0].resource_id,document.id);assert.equal(read.receipts[1].after_revision,2);
});
function baseGlobal(){return base;}

test("a persisted applying crash snapshot reconciles actual CRDT receipt without overwriting later human edits",async()=>{
  const f=await setup(),{plan}=await f.freeze([{operation:"im_create_document",arguments:{title:"Recover once",content:"Original canonical delivery."}},
    {operation:"im_create_task",arguments:{title:"Follow up",assignee_id:f.agent.principal.id}}]);
  const before=JSON.parse(fs.readFileSync(imFile)),first=await f.execute(plan,0),afterCommit=JSON.parse(fs.readFileSync(imFile));
  await call(f.human.token,f.base+"/documents/"+first.receipt.resource_id,"PUT",{base_revision:1,content:"Human edit after canonical commit."});
  await stop(server);
  // Model the precise IM crash window with a durable applying intent while the real
  // independent CRDT process retains its committed receipt and a later human edit.
  const saved=afterCommit.rooms.find(r=>r.id===f.room.id).turns.find(t=>t.id===f.c.turn.id),interrupted=before.rooms.find(r=>r.id===f.room.id).turns.find(t=>t.id===f.c.turn.id);
  interrupted.document_intents=saved.document_intents;
  interrupted.action_receipts=[{...saved.action_receipts[0],status:"applying",resource_id:null,after_revision:null,after_hash:undefined,committed_at:null}];
  fs.writeFileSync(imFile,JSON.stringify(before));server=start("server.js");await ready(base+"/health",server);
  const recovered=await call(f.agent.token,f.route+"/plan");assert.equal(recovered.receipts[0].status,"committed");assert.equal(recovered.receipts[0].after_revision,1);
  const current=(await call(f.human.token,f.base+"/documents/"+first.receipt.resource_id)).document;assert.equal(current.revision,2);assert.equal(current.content,"Human edit after canonical commit.");
  const next=await f.execute(plan,1);assert.equal(next.receipt.status,"rejected");assert.equal(next.receipt.error_code,"stale_context");
  const room=await call(f.human.token,f.base);assert.equal(room.documents.length,1);assert.equal(room.tasks.length,0);
});
