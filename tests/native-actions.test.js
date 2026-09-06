"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-actions-tests-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
async function setup(documentAdapter) {
  const file = path.join(temporary, crypto.randomUUID()+".json"), admin = crypto.randomBytes(32).toString("hex");
  let clock = Date.parse("2026-09-06T01:00:00Z");
  const document = { id: "document-evidence", title: "Delivery", content: "Verified acceptance report.", revision: 1, content_hash: "hash-1" };
  let onRead;
  const options = { file, adminToken: admin, now: () => clock, workspace: { nativeActions: documentAdapter, handle: async () => { if (onRead) onRead(); return { ...document }; } } };
  let im = createNativeIM(options);
  const call = (token, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im"+route);
    return im.handle(method,url.pathname,input,token,url.searchParams);
  };
  const make = (name, kind="agent") => call(admin,"/admin/principals","POST",{name,kind});
  const human=await make("Human","human"), a=await make("Design colleague"), b=await make("Research colleague"), peer=await make("Peer","human");
  await call(admin,"/admin/enterprise/bootstrap","POST",{principal_id:human.principal.id});
  const {room}=await call(human.token,"/rooms","POST",{name:"Visible native actions"});
  const base="/rooms/"+room.id;
  for(const p of [a,b,peer]) await call(human.token,base+"/members","POST",{principal_id:p.principal.id});
  const send = (content="Advance actual office work") => call(human.token,base+"/messages","POST",{client_id:crypto.randomUUID(),content});
  const take = (actor=a) => call(actor.token,base+"/turns/claim","POST",{instructions:"Fixture plan",model:"fixture",reasoning_effort:"medium",lease_seconds:30});
  function body(claim,steps,extra={}) {
    const source=claim.context.messages.at(-1);
    return {lease_token:claim.turn.lease_token,context_hash:claim.context.context_hash,model:"fixture",reasoning_effort:"medium",summary:"Visible bounded plan",
      final_result:{action:"reply",content:"Plan processed; see server receipts.",rationale:"Visible request.",mentions:[],artifact:null},
      steps:steps.map((s,i)=>({key:"step-"+i,evidence:[{kind:"message",id:source.id,revision:source.revision,quote:source.content}],...s})),...extra};
  }
  const plan = (claim,steps,actor=a,extra={}) => call(actor.token,base+"/turns/"+claim.turn.id+"/plan","POST",body(claim,steps,extra));
  const execute = (claim,plan,index,actor=a) => call(actor.token,base+"/turns/"+claim.turn.id+"/operations/"+plan.steps[index].operation_id+"/execute","POST",{lease_token:claim.turn.lease_token,plan_hash:plan.hash});
  const finish=(claim,final,actor=a)=>call(actor.token,base+"/turns/"+claim.turn.id+"/finish","POST",{...final,lease_token:claim.turn.lease_token,model:"fixture",reasoning_effort:"medium"});
  const createTask = (assignee=b.principal.id) => ({operation:"im_create_task",arguments:{title:"A real handoff",assignee_id:assignee}});
  return {file,admin,human,a,b,peer,room,base,call,make,send,take,body,plan,execute,finish,createTask,document,
    advance:(ms)=>clock+=ms,readHook:(fn)=>onRead=fn,restart:()=>im=createNativeIM(options)};
}

test("frozen sequential actions commit real tasks calendar contacts and advance only their own manifest",async()=>{
  const f=await setup();await f.send();const c=await f.take();const original=JSON.stringify(c.context);
  assert.equal(c.context.actions.operations.length,6);assert.equal(c.context.actions.max_steps,4);
  const steps=[f.createTask(),{operation:"im_update_task",arguments:{task_id:{step_key:"step-0",field:"resource_id"},base_revision:1,status:"doing"}},
    {operation:"office_create_event",arguments:{title:"Review",starts_at:"2026-09-06T10:00:00+08:00",ends_at:"2026-09-06T10:30:00+08:00",attendee_ids:[f.a.principal.id,f.b.principal.id]}},
    {operation:"im_add_contact",arguments:{principal_id:f.b.principal.id}}];
  const p=await f.plan(c,steps);assert.equal((await f.plan(c,steps)).duplicate,true);
  await assert.rejects(f.plan(c,steps,f.a,{summary:"Different plan"}),{code:"plan_conflict"});
  await assert.rejects(f.execute(c,p.plan,1),{code:"operation_order"});
  for(let i=0;i<4;i++) assert.equal((await f.execute(c,p.plan,i)).receipt.status,"committed");
  const duplicate=await f.execute(c,p.plan,0);assert.equal(duplicate.duplicate,true);
  const room=await f.call(f.a.token,f.base);assert.equal(room.tasks.length,1);assert.equal(room.tasks[0].revision,2);
  assert.equal((await f.call(f.a.token,"/calendar")).events.length,1);
  assert.equal((await f.call(f.a.token,"/contacts")).contacts[0].id,f.b.principal.id);
  const final=await f.finish(c,p.plan.final_result);assert.equal(final.turn.status,"replied");assert.equal(final.turn.result.action_summary.length,4);
  assert.equal(JSON.stringify(final.turn.context),original);assert.equal(final.turn.execution_manifest.tasks[0].revision,2);
  assert.ok(final.message.content.includes("[服务端动作回执]"));
  assert.equal((await f.finish(c,p.plan.final_result)).duplicate,true);
  const serialized=JSON.stringify(await f.call(f.a.token,f.base+"/turns/"+c.turn.id+"/plan"));
  assert.ok(!serialized.includes(c.turn.lease_token));assert.ok(!serialized.includes(f.a.token));assert.ok(!serialized.includes('"duplicate":true'));
});

test("restart resumes the frozen plan without redoing committed work and rejects old lease",async()=>{
  const f=await setup();await f.send();const c=await f.take(),p=await f.plan(c,[f.createTask(),{operation:"im_add_contact",arguments:{principal_id:f.b.principal.id}}]);
  await f.execute(c,p.plan,0);f.restart();f.advance(31000);const resumed=await f.take();
  assert.equal(resumed.turn.id,c.turn.id);assert.deepEqual(resumed.turn.action_plan,p.plan);assert.equal(resumed.turn.action_receipts.length,1);
  await assert.rejects(f.execute(c,p.plan,1),{code:"lease_expired"});
  assert.equal((await f.execute(resumed,p.plan,0)).duplicate,true);await f.execute(resumed,p.plan,1);
  assert.equal((await f.call(f.a.token,f.base)).tasks.length,1);
  await f.finish(resumed,p.plan.final_result);f.restart();assert.equal((await f.call(f.a.token,f.base)).tasks.length,1);
});

test("foreign edits stop later steps and preserve partial committed receipts",async()=>{
  const f=await setup();await f.send();const c=await f.take(),p=await f.plan(c,[f.createTask(),f.createTask()]);
  const first=await f.execute(c,p.plan,0);
  await f.call(f.human.token,f.base+"/tasks/"+first.receipt.resource_id,"PATCH",{base_revision:1,title:"Human revision"});
  const result=await f.execute(c,p.plan,1);assert.equal(result.receipt.status,"rejected");assert.equal(result.receipt.error_code,"stale_context");
  assert.equal(result.receipts[0].status,"committed");assert.equal((await f.call(f.a.token,f.base)).tasks.length,1);
  await assert.rejects(f.finish(c,{action:"blocked",rationale:"Conflict"}),{code:"stale_context"});
  const visible=(await f.call(f.human.token,f.base+"/turns/"+c.turn.id)).turn;assert.equal(visible.status,"stale");assert.equal(visible.action_receipts[0].status,"committed");
});

test("pause removal identity disable and app policy fence the next action with no partial rollback",async()=>{
  for(const revoke of ["pause","remove","disable","policy"]){
    const f=await setup();await f.send();const c=await f.take(),p=await f.plan(c,[f.createTask(),f.createTask()]);await f.execute(c,p.plan,0);
    if(revoke==="pause")await f.call(f.human.token,f.base+"/participation","PATCH",{principal_id:f.a.principal.id,mode:"paused"});
    if(revoke==="remove")await f.call(f.human.token,f.base+"/members/"+f.a.principal.id,"DELETE");
    if(revoke==="disable"){const {member}=await f.call(f.human.token,"/enterprise/admin/members/"+f.a.principal.id);await f.call(f.human.token,"/enterprise/admin/members/"+f.a.principal.id,"PATCH",{base_revision:member.revision,status:"disabled"});}
    if(revoke==="policy")await f.call(f.human.token,"/enterprise/admin/apps/tasks","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.a.principal.id]});
    await assert.rejects(f.execute(c,p.plan,1));assert.equal((await f.call(f.human.token,f.base)).tasks.length,1);
    assert.equal((await f.call(f.human.token,f.base+"/turns/"+c.turn.id)).turn.action_receipts[0].status,"committed");
  }
});

test("rejected plans cannot invent evidence targets capabilities or completed deliverables",async()=>{
  const f=await setup();await f.send();const c=await f.take();
  for(const step of [{operation:"office_send_mail",arguments:{}},{...f.createTask(),evidence:[{kind:"message",id:c.context.messages[0].id,revision:1,quote:"invented"}]},
    {operation:"im_update_task",arguments:{task_id:"foreign-task",base_revision:1,status:"doing"}},
    {...f.createTask(),arguments:{...f.createTask().arguments,actor_id:f.human.principal.id}},
    {operation:"im_add_contact",arguments:{principal_id:"not-captured"}}])await assert.rejects(f.plan(c,[step]));
  const body=f.body(c,[f.createTask()]);body.context_hash="forged";await assert.rejects(f.call(f.a.token,f.base+"/turns/"+c.turn.id+"/plan","POST",body),{code:"invocation_mismatch"});
  assert.equal((await f.call(f.a.token,f.base)).tasks.length,0);
});

test("calendar action reuses creator invitation and revision authorization",async()=>{
  const f=await setup();const {event}=await f.call(f.human.token,f.base+"/calendar","POST",{client_id:"event",title:"Invitation",starts_at:"2026-09-06T02:00:00Z",ends_at:"2026-09-06T03:00:00Z",attendee_ids:[f.a.principal.id]});
  await f.send();const c=await f.take(),p=await f.plan(c,[{operation:"office_respond_event",arguments:{event_id:event.id,base_revision:1,response:"accepted"}},
    {operation:"office_update_event",arguments:{event_id:event.id,base_revision:2,title:"Cannot change owner event"}}]);
  assert.equal((await f.execute(c,p.plan,0)).receipt.after_revision,2);
  assert.equal((await f.execute(c,p.plan,1)).receipt.error_code,"creator_required");
  assert.equal((await f.call(f.a.token,"/calendar/"+event.id)).event.responses[f.a.principal.id],"accepted");
});

test("atomic persistence failure cannot leave a business effect without its receipt",async()=>{
  const f=await setup();await f.send();const c=await f.take(),p=await f.plan(c,[f.createTask()]);
  const original=fs.renameSync;fs.renameSync=(a,b)=>{if(b===f.file)throw new Error("fixture storage fault");return original(a,b);};
  try{await assert.rejects(f.execute(c,p.plan,0),{code:"storage_failed"});}finally{fs.renameSync=original;}
  await assert.rejects(f.call(f.a.token,f.base),{code:"storage_failed"});f.restart();
  assert.equal((await f.call(f.a.token,f.base)).tasks.length,0);assert.equal((await f.execute(c,p.plan,0)).receipt.status,"committed");
  f.restart();assert.equal((await f.execute(c,p.plan,0)).duplicate,true);assert.equal((await f.call(f.a.token,f.base)).tasks.length,1);
});

test("lease is checked again after canonical I/O and ledger corruption refuses replay",async()=>{
  const f=await setup();await f.call(f.admin,"/admin/import","POST",{room_id:f.room.id,document_id:f.document.id});await f.send();
  const c=await f.take(),p=await f.plan(c,[f.createTask()]);f.readHook(()=>f.advance(31000));await assert.rejects(f.execute(c,p.plan,0),{code:"lease_expired"});f.readHook(null);
  assert.equal((await f.call(f.a.token,f.base)).tasks.length,0);
  const raw=JSON.parse(fs.readFileSync(f.file));raw.rooms[0].turns[0].action_plan.steps[0].arguments.title="tampered";fs.writeFileSync(f.file,JSON.stringify(raw));
  assert.throws(f.restart,/ledger is corrupt/);
});

test("each colleague has revisioned autonomy and deterministic pending-work reviews without new messages",async()=>{
  const f=await setup();let {room}=await f.call(f.a.token,f.base);
  await assert.rejects(f.call(f.peer.token,f.base+"/participation","PATCH",{principal_id:f.a.principal.id,base_revision:room.revision,autonomy:{enabled:false}}),{code:"owner_required"});
  const update=await f.call(f.a.token,f.base+"/participation","PATCH",{base_revision:room.revision,autonomy:{enabled:true,max_steps:1,allowed_operations:["im_create_task"],review_interval_seconds:60}});
  assert.equal(update.member.autonomy.max_steps,1);
  await assert.rejects(f.call(f.a.token,f.base+"/participation","PATCH",{base_revision:room.revision,autonomy:{enabled:false}}),{code:"conflict"});
  await f.call(f.human.token,f.base+"/tasks","POST",{title:"Assigned pending work",assignee_id:f.a.principal.id});
  const first=await f.take();assert.equal(first.context.trigger.type,"task.created");assert.equal(first.context.actions.operations.length,1);
  await f.finish(first,{action:"silent",rationale:"Waiting for scheduled review"});assert.equal((await f.take()).turn,null);
  f.advance(61000);const review=await f.take();assert.equal(review.context.trigger.type,"agent.review");assert.notEqual(review.turn.root_id,first.turn.root_id);
  await f.finish(review,{action:"silent",rationale:"No update needed"});assert.equal((await f.take()).turn,null);
  assert.equal((await f.take(f.b)).turn,null);
});

test("task handoffs retain cause across independent colleagues and cannot cycle back",async()=>{
  const f=await setup();await f.send();const a=await f.take(),ap=await f.plan(a,[f.createTask()]);await f.execute(a,ap.plan,0);await f.finish(a,ap.plan.final_result);
  const b=await f.take(f.b);assert.equal(b.context.trigger.type,"task.created");assert.equal(b.turn.root_id,a.turn.root_id);assert.equal(b.turn.depth,2);
  const bp=await f.plan(b,[f.createTask(f.a.principal.id)],f.b);await f.execute(b,bp.plan,0,f.b);await f.finish(b,bp.plan.final_result,f.b);
  assert.equal((await f.take()).turn,null);assert.equal((await f.call(f.human.token,f.base)).tasks.length,2);
});

test("100-template catalog installs hyphenated professional identities without spawning every entry",async()=>{
  const f=await setup(),catalog=await f.call(f.human.token,"/agent-store");assert.equal(catalog.agents.length,100);assert.equal(new Set(catalog.agents.map((a)=>a.id)).size,100);
  const template=catalog.agents.find((a)=>a.id.includes("-")),a=await f.call(f.human.token,"/agent-store/"+template.id+"/install","POST");
  assert.equal(a.principal.profession,template.profession);assert.equal(a.principal.source_organization_name,template.organization_name);
  assert.equal((await f.call(f.human.token,"/agent-store/"+template.id+"/install","POST")).duplicate,true);
  assert.equal((await f.call(f.admin,"/admin/workers")).workers.length,1);
  assert.ok((await f.call(f.human.token,"/search?q="+encodeURIComponent(template.name))).results.some((r)=>r.type==="store"&&r.id===template.id));
});

test("the shared causal root reserves at most twelve actions across independent Agent plans",async()=>{
  const f=await setup(),agents=[f.a,f.b];
  for(let i=0;i<3;i++){const a=await f.make("Independent "+i);agents.push(a);await f.call(f.human.token,f.base+"/members","POST",{principal_id:a.principal.id});}
  await f.send();let root;
  for(const actor of agents.slice(0,4)){
    const c=await f.take(actor);root ||= c.turn.root_id;assert.equal(c.turn.root_id,root);
    const p=await f.plan(c,[f.createTask(f.human.principal.id),f.createTask(f.human.principal.id),f.createTask(f.human.principal.id)],actor);
    for(let i=0;i<3;i++)await f.execute(c,p.plan,i,actor);await f.finish(c,p.plan.final_result,actor);
  }
  const last=await f.take(agents[4]);assert.equal(last.turn.root_id,root);
  await assert.rejects(f.plan(last,[f.createTask()],agents[4]),{code:"action_budget"});
  assert.equal((await f.call(f.human.token,f.base)).tasks.length,12);
});

test("unconfirmed document writes stay applying and recover their receipt without repeating apply",async()=>{
  let unavailable=true,applies=0;
  const adapter={prepare(input,actor){return{...input,actor_id:actor,document_id:"document-evidence"};},
    async apply(){applies++;throw new Error("fixture disconnected after a possible commit");},
    async recover(){if(unavailable)throw new Error("fixture receipt service unavailable");return{resource_id:"document-evidence",before_revision:null,after_revision:1,content_hash:"hash-1",committed_at:"2026-09-06T01:00:00Z"};}};
  const f=await setup(adapter);await f.send();const c=await f.take(),p=await f.plan(c,[{operation:"im_create_document",arguments:{title:"Delivery",content:"Verified acceptance report."}},f.createTask()]);
  await assert.rejects(f.execute(c,p.plan,0),{code:"outcome_pending"});
  const saved=JSON.parse(fs.readFileSync(f.file)).rooms[0].turns[0];assert.equal(saved.action_receipts[0].status,"applying");assert.ok(saved.document_intents[p.plan.steps[0].operation_id]);
  await assert.rejects(f.execute(c,p.plan,1),{code:"plan_stopped"});
  await assert.rejects(f.finish(c,{action:"blocked",rationale:"Waiting"}),{code:"outcome_pending"});
  unavailable=false;f.restart();const recovered=await f.call(f.a.token,f.base+"/turns/"+c.turn.id+"/plan");
  assert.equal(recovered.receipts[0].status,"committed");assert.equal(applies,1);
  assert.equal((await f.execute(c,p.plan,0)).duplicate,true);await f.execute(c,p.plan,1);
  assert.equal((await f.finish(c,p.plan.final_result)).turn.status,"replied");assert.equal(applies,1);
});

test("finish reconciles a recovered canonical receipt before deriving its public summary",async()=>{
  let unavailable=true;
  const adapter={prepare(input,actor){return{...input,actor_id:actor,document_id:"document-evidence"};},
    async apply(){throw new Error("fixture disconnected");},
    async recover(){if(unavailable)throw new Error("fixture unavailable");return{resource_id:"document-evidence",before_revision:null,after_revision:1,content_hash:"hash-1",committed_at:"2026-09-06T01:00:00Z"};}};
  const f=await setup(adapter);await f.send();const c=await f.take(),p=await f.plan(c,[{operation:"im_create_document",arguments:{title:"Delivery",content:"Verified acceptance report."}}]);
  await assert.rejects(f.execute(c,p.plan,0),{code:"outcome_pending"});unavailable=false;
  const finished=await f.finish(c,p.plan.final_result);
  assert.equal(finished.turn.result.action_summary[0].status,"committed");
  assert.match(finished.message.content,/im_create_document: committed/);
  assert.equal((await f.finish(c,p.plan.final_result)).duplicate,true);
});
