"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP,callNativeTool,publicTools}=require("../native-im-mcp"),{createNativeA2A}=require("../native-a2a");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-message-urgency-"));after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(temporary,crypto.randomUUID(),"im.json"),admin=crypto.randomBytes(32).toString("hex"),options={file,adminToken:admin,workspace:{handle:async()=>{throw Error("No document operation expected");}}};let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind}),human=await enroll("Human"),agent=await enroll("Agent","agent"),peer=await enroll("Peer"),bystander=await enroll("Bystander"),outside=await enroll("Outside");
  const {room}=await call(human,"/rooms","POST",{name:"Urgency fixture"}),base="/rooms/"+room.id;for(const who of [agent,peer,bystander])await call(human,base+"/members","POST",{principal_id:who.principal.id});
  const send=async(who,content)=>(await call(who,base+"/messages","POST",{client_id:crypto.randomUUID(),content})).message;
  const urge=(who,message,recipients,extra={})=>call(who,base+"/messages/"+message.id+"/urgencies","POST",{client_id:crypto.randomUUID(),base_revision:message.revision,channel:"in_app",recipient_ids:recipients.map(person=>person.principal.id),...extra});
  const read=(who,urgency)=>call(who,base+"/urgencies/"+urgency.id),ack=(who,urgency,input={})=>call(who,base+"/urgencies/"+urgency.id+"/ack","POST",input);
  return {file,admin,human,agent,peer,bystander,outside,room,base,call,send,urge,read,ack,restart:()=>im=createNativeIM(options),get im(){return im;}};
}
test("in-app urgency has real selected Human/Agent recipients, durable idempotence and precise private event audiences",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Please review this source"),first=await f.urge(f.human,message,[f.agent,f.peer],{client_id:"one-intent"}),urgency=first.urgency;
  assert.equal(first.duplicate,false);assert.equal(urgency.channel,"in_app");assert.equal(urgency.status,"pending");assert.deepEqual(urgency.counts,{total:2,acknowledged:0,pending:2,unavailable:0});assert.equal(urgency.summary_scope,"sender");assert.equal(urgency.can_ack,false);
  const stable=fs.readFileSync(f.file,"utf8"),repeat=await f.urge(f.human,message,[f.peer,f.agent],{client_id:"one-intent"});assert.equal(repeat.duplicate,true);assert.equal(repeat.urgency.id,urgency.id);assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  await assert.rejects(f.urge(f.human,message,[f.agent],{client_id:"one-intent"}),{code:"idempotency_conflict"});
  for(const who of [f.human,f.agent,f.peer]){
    const events=await f.call(who,"/events?after=0"),urgent=events.events.filter(event=>event.type==="message.urgency.created");assert.equal(urgent.length,1);assert.deepEqual(urgent[0].audience_ids,[who.principal.id]);assert.equal(urgent[0].message_id,message.id);assert.equal("message" in urgent[0],false);
  }
  assert.equal((await f.call(f.bystander,"/events?after=0")).events.some(event=>event.urgency_id===urgency.id),false);
  await assert.rejects(f.read(f.bystander,urgency),{code:"urgency_scope"});await assert.rejects(f.read(f.outside,urgency),{code:"not_a_member"});
  const recipient=(await f.read(f.agent,urgency)).urgency;assert.equal(recipient.summary_scope,"self");assert.deepEqual(recipient.recipients.map(value=>value.principal_id),[f.agent.principal.id]);assert.equal(recipient.counts.total,1);assert.equal(JSON.stringify(recipient.recipients).includes(f.peer.principal.id),false);
  recipient.recipients[0].acknowledged_at="Invented acknowledgement";assert.equal((await f.read(f.agent,urgency)).urgency.recipients[0].acknowledged_at,null);
  f.restart();assert.equal((await f.read(f.human,urgency)).urgency.id,urgency.id);assert.equal((await f.call(f.agent,f.base+"/urgencies?box=inbox&status=pending")).items.length,1);
});
test("only source authors create urgencies and invalid channels, stale versions or forged recipients create no state",async()=>{
  const f=await fixture(),humanMessage=await f.send(f.human,"Human source"),agentMessage=await f.send(f.agent,"Agent source");
  const created=await f.urge(f.agent,agentMessage,[f.human]);assert.equal(created.urgency.created_by,f.agent.principal.id);assert.equal((await f.read(f.human,created.urgency)).urgency.can_ack,true);
  await assert.rejects(f.urge(f.peer,humanMessage,[f.agent]),{code:"author_required"});
  for(const extra of [{channel:"sms"},{channel:"telephone"},{channel:undefined},{recipient_ids:[]},{recipient_ids:[f.human.principal.id]},{recipient_ids:[f.agent.principal.id,f.agent.principal.id]},{recipient_ids:[f.outside.principal.id]},{principal_id:f.peer.principal.id},{base_revision:undefined}])await assert.rejects(f.urge(f.human,humanMessage,[f.agent],extra),{status:422});
  await f.call(f.human,f.base+"/messages/"+humanMessage.id,"PATCH",{base_revision:1,content:"Changed source"});await assert.rejects(f.urge(f.human,humanMessage,[f.agent]),{code:"conflict"});
  assert.equal(JSON.parse(fs.readFileSync(f.file)).message_urgencies.length,1);
});
test("explicit urgency confirmation is individual, idempotent and independent of message reading",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Independent acknowledgements"),{urgency}=await f.urge(f.human,message,[f.agent,f.peer]);
  await f.call(f.agent,f.base+"/preferences","PATCH",{read_seq:message.seq});assert.equal((await f.read(f.agent,urgency)).urgency.can_ack,true);
  const confirmed=await f.ack(f.peer,urgency);assert.equal(confirmed.duplicate,false);assert.equal(confirmed.urgency.status,"acknowledged");assert.equal(confirmed.urgency.can_ack,false);
  const readers=await f.call(f.human,f.base+"/messages/"+message.id+"/readers");assert.equal(readers.readers.find(reader=>reader.principal_id===f.peer.principal.id).read,false);assert.equal(readers.readers.find(reader=>reader.principal_id===f.agent.principal.id).read,true);
  const stable=fs.readFileSync(f.file,"utf8");assert.equal((await f.ack(f.peer,urgency)).duplicate,true);assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  const sender=(await f.read(f.human,urgency)).urgency;assert.deepEqual(sender.counts,{total:2,acknowledged:1,pending:1,unavailable:0});
  await assert.rejects(f.ack(f.human,urgency),{code:"urgency_recipient_required"});await assert.rejects(f.ack(f.agent,urgency,{principal_id:f.peer.principal.id}),{status:422});await assert.rejects(f.ack(f.bystander,urgency),{code:"urgency_scope"});
  const agentEvents=await f.call(f.agent,"/events?after=0"),peerEvents=await f.call(f.peer,"/events?after=0");assert.equal(agentEvents.events.some(event=>event.type==="message.urgency.acknowledged"),false);assert.equal(peerEvents.events.filter(event=>event.type==="message.urgency.acknowledged").length,1);
  f.restart();assert.equal((await f.read(f.human,urgency)).urgency.counts.acknowledged,1);
});
test("personal hiding suppresses recipient notifications without exposing that preference to the sender; restoring can confirm",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Hidden urgency source"),{urgency}=await f.urge(f.human,message,[f.agent]);
  await f.call(f.agent,f.base+"/messages/"+message.id+"/preferences","PATCH",{hidden:true});
  const hidden=(await f.read(f.agent,urgency)).urgency;assert.equal(hidden.status,"source_hidden");assert.equal(hidden.source_status,"hidden");assert.equal(hidden.message.content,"");assert.equal(hidden.can_ack,false);assert.equal("history" in hidden.message,false);
  assert.equal((await f.read(f.human,urgency)).urgency.status,"pending");assert.equal((await f.read(f.human,urgency)).urgency.recipients[0].status,"pending");
  assert.equal((await f.call(f.agent,"/events?after=0")).events.some(event=>event.urgency_id===urgency.id),false);await assert.rejects(f.ack(f.agent,urgency),{code:"message_hidden"});
  await f.call(f.agent,f.base+"/messages/"+message.id+"/preferences","PATCH",{hidden:false});assert.equal((await f.read(f.agent,urgency)).urgency.can_ack,true);await f.ack(f.agent,urgency);assert.equal((await f.read(f.human,urgency)).urgency.status,"acknowledged");
});
test("edited and retracted sources invalidate pending urgencies while preserving earlier acknowledgements",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Urgency captured version"),{urgency}=await f.urge(f.human,message,[f.agent,f.peer]);await f.ack(f.peer,urgency);
  await f.call(f.human,f.base+"/messages/"+message.id,"PATCH",{base_revision:1,content:"Source revision two"});
  const changed=(await f.read(f.human,urgency)).urgency;assert.equal(changed.status,"source_changed");assert.equal(changed.source_status,"changed");assert.equal(changed.counts.acknowledged,1);assert.equal(changed.counts.pending,0);await assert.rejects(f.ack(f.agent,urgency),{code:"conflict"});
  assert.equal((await f.ack(f.peer,urgency)).duplicate,true,"a completed own acknowledgement is not erased by a later source edit");
  await f.call(f.human,f.base+"/messages/"+message.id,"DELETE",{base_revision:2});const retracted=(await f.read(f.agent,urgency)).urgency;assert.equal(retracted.status,"source_retracted");assert.equal(retracted.message.content,"");assert.equal("history" in retracted.message,false);await assert.rejects(f.ack(f.agent,urgency),{code:"message_retracted"});
});
test("leaving and rejoining does not reassign an old urgency or inherit its confirmation",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Membership-scoped urgency"),{urgency}=await f.urge(f.human,message,[f.agent,f.peer]);await f.ack(f.peer,urgency);
  await f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE");assert.equal((await f.read(f.human,urgency)).urgency.recipients.find(recipient=>recipient.principal_id===f.agent.principal.id).status,"unavailable");await assert.rejects(f.ack(f.agent,urgency),{code:"not_a_member"});
  await f.call(f.human,f.base+"/members","POST",{principal_id:f.agent.principal.id});await assert.rejects(f.read(f.agent,urgency),{code:"urgency_scope"});await assert.rejects(f.ack(f.agent,urgency),{code:"urgency_scope"});assert.equal((await f.call(f.agent,f.base+"/urgencies?box=inbox")).items.length,0);assert.equal((await f.call(f.agent,"/events?after=0")).events.some(event=>event.urgency_id===urgency.id),false);
  const sender=(await f.read(f.human,urgency)).urgency;assert.equal(sender.counts.acknowledged,1);assert.equal(sender.counts.unavailable,1);assert.equal(sender.recipients.find(recipient=>recipient.principal_id===f.agent.principal.id).same_membership,false);
  const next=await f.urge(f.human,message,[f.agent]);assert.equal((await f.read(f.agent,next.urgency)).urgency.can_ack,true);await f.ack(f.agent,next.urgency);
  const agentSource=await f.send(f.agent,"Sender later leaves"),pending=await f.urge(f.agent,agentSource,[f.peer]);await f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE");assert.equal((await f.read(f.peer,pending.urgency)).urgency.status,"sender_unavailable");await assert.rejects(f.ack(f.peer,pending.urgency),{code:"sender_unavailable"});
});
test("a named Agent in mentions mode receives urgency as a proactive trigger with the actual older source and no implicit ACK",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Old but explicitly urgent source");for(let i=0;i<45;i++)await f.send(f.peer,"Later unrelated message "+i);
  await f.call(f.agent,f.base+"/participation","PATCH",{mode:"mentions"});const {urgency}=await f.urge(f.human,message,[f.agent,f.peer]);
  const claimed=await f.call(f.agent,f.base+"/turns/claim","POST",{model:"synthetic",reasoning_effort:"medium"});assert.ok(claimed.turn);assert.equal(claimed.turn.context.trigger.type,"message.urgency.created");assert.equal(claimed.turn.context.trigger.message.id,message.id);assert.ok(claimed.turn.context.messages.some(item=>item.id===message.id));assert.ok(claimed.turn.context.messages.length<=40);assert.deepEqual(claimed.turn.context.trigger.audience_ids,[f.agent.principal.id]);
  assert.equal((await f.read(f.agent,urgency)).urgency.can_ack,true);assert.equal((await f.call(f.human,f.base+"/messages/"+message.id+"/readers")).receipt_summary.read_count,0);
  await f.call(f.agent,f.base+"/turns/"+claimed.turn.id+"/finish","POST",{lease_token:claimed.turn.lease_token,action:"silent",rationale:"Urgency observed, not confirmed",model:"synthetic",reasoning_effort:"medium"});
  await f.call(f.agent,f.base+"/participation","PATCH",{mode:"paused"});await f.urge(f.human,message,[f.agent]);assert.equal((await f.call(f.agent,f.base+"/turns/claim","POST",{model:"synthetic",reasoning_effort:"medium"})).turn,null);
});
test("MCP urgency, per-person pagination, current app policy and A2A cached receipt authorization use the same native authority",async()=>{
  const f=await fixture(),message=await f.send(f.agent,"MCP source"),rpc=(who,name,args)=>nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  const response=await rpc(f.agent,"im_urge_message",{room_id:f.room.id,message_id:message.id,base_revision:1,client_id:"mcp-urgent",recipient_ids:[f.peer.principal.id],channel:"in_app"});assert.equal(response.result.isError,false);const urgency=JSON.parse(response.result.content[0].text).urgency;
  await f.urge(f.agent,message,[f.peer]);const page=await f.call(f.peer,f.base+"/urgencies?box=inbox&limit=1");assert.equal(page.has_more,true);assert.equal((await f.call(f.peer,f.base+"/urgencies?box=inbox&limit=1&before="+page.next_before)).items[0].id,urgency.id);
  for(const query of ["limit=0","limit=201","box=unknown","status=done","before=-1","principal_id="+f.agent.principal.id])await assert.rejects(f.call(f.peer,f.base+"/urgencies?"+query),{status:422});
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools}),task=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"read-urgent",role:"user",parts:[{kind:"data",data:{operation:"im_read_urgency",arguments:{room_id:f.room.id,urgency_id:urgency.id}}}]}}},f.peer.token);assert.equal(task.result.status.state,"completed");
  await f.call(f.human,f.base+"/members/"+f.peer.principal.id,"DELETE");await f.call(f.human,f.base+"/members","POST",{principal_id:f.peer.principal.id});assert.equal((await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:task.result.id}},f.peer.token)).error.data.code,"urgency_scope");
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});await assert.rejects(f.call(f.agent,f.base+"/urgencies"),{code:"app_policy_denied"});
});
test("urgency persistence failure cannot manufacture a durable confirmation",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Durable confirmation"),{urgency}=await f.urge(f.human,message,[f.agent]);fs.mkdirSync(f.file+".tmp");await assert.rejects(f.ack(f.agent,urgency),{code:"storage_failed"});await assert.rejects(f.read(f.human,urgency),{code:"storage_failed"});fs.rmdirSync(f.file+".tmp");f.restart();assert.equal((await f.read(f.agent,urgency)).urgency.can_ack,true);assert.equal((await f.read(f.human,urgency)).urgency.counts.acknowledged,0);
});
test("private urgency runs stay private across summaries, plans, events, exports and cached A2A receipts",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Private assignment source");
  await f.call(f.agent,f.base+"/participation","PATCH",{mode:"mentions"});
  const {urgency}=await f.urge(f.human,message,[f.agent,f.peer]);
  const {turn}=await f.call(f.agent,f.base+"/turns/claim","POST",{model:"synthetic",reasoning_effort:"medium"});
  assert.equal(turn.context.trigger.urgency_id,urgency.id);assert.equal(turn.root_id.includes(urgency.id),false);
  const turnPath=f.base+"/turns/"+turn.id;
  for(const who of [f.human,f.agent]){
    assert.equal((await f.call(who,turnPath)).turn.id,turn.id);
    assert.equal((await f.call(who,f.base)).runs.some(run=>run.id===turn.id),true);
    assert.equal((await f.call(who,"/events?after=0")).events.some(event=>event.type==="turn.claimed"&&event.turn_id===turn.id),true);
    assert.ok((await f.call(who,f.base+"/export")).includes("### "+turn.id+" · "));
  }
  for(const who of [f.peer,f.bystander]){
    await assert.rejects(f.call(who,turnPath),{code:"urgency_scope"});
    await assert.rejects(f.call(who,turnPath+"/plan"),{code:"urgency_scope"});
    assert.equal((await f.call(who,f.base)).runs.some(run=>run.id===turn.id),false);
    assert.equal((await f.call(who,"/events?after=0")).events.some(event=>event.type==="turn.claimed"&&event.turn_id===turn.id),false);
    assert.equal((await f.call(who,f.base+"/export")).includes(urgency.id),false);
  }
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-turn-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const cached=[];
  for(const operation of ["im_run_record","im_export"]){
    const response=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:operation,role:"user",parts:[{kind:"data",data:{operation,arguments:{room_id:f.room.id,...(operation==="im_run_record"?{turn_id:turn.id}:{})}}}]}}},f.agent.token);
    assert.equal(response.result?.status.state,"completed");cached.push(response.result.id);
  }
  await f.call(f.agent,turnPath+"/finish","POST",{lease_token:turn.lease_token,action:"reply",content:"Shared deliverable",rationale:"Private work complete",model:"synthetic",reasoning_effort:"medium"});
  const publicEvents=(await f.call(f.bystander,"/events?after=0")).events;
  assert.equal(publicEvents.some(event=>event.type==="turn.finished"&&event.turn_id===turn.id),false);
  const publicMessage=(await f.call(f.bystander,f.base)).messages.find(item=>item.content==="Shared deliverable");
  assert.ok(publicMessage);assert.equal(JSON.stringify(publicMessage).includes(urgency.id),false);
  assert.equal(publicEvents.some(event=>event.type==="message.created"&&event.message.id===publicMessage.id),true);
  await f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE");
  await f.call(f.human,f.base+"/members","POST",{principal_id:f.agent.principal.id});
  await assert.rejects(f.call(f.agent,turnPath),{code:"urgency_scope"});
  assert.equal((await f.call(f.agent,f.base)).runs.some(run=>run.id===turn.id),false);
  for(const id of cached)assert.equal((await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id}},f.agent.token)).error?.data.code,"urgency_scope");
});
test("missing source is an explicit null view and corrupt urgency ledgers fail closed",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Source removed externally"),{urgency}=await f.urge(f.human,message,[f.agent]);
  const saved=JSON.parse(fs.readFileSync(f.file));saved.rooms.find(room=>room.id===f.room.id).messages=[];
  fs.writeFileSync(f.file,JSON.stringify(saved));f.restart();
  const missing=(await f.read(f.agent,urgency)).urgency;assert.equal(missing.source_status,"missing");assert.equal(missing.message,null);assert.equal(missing.can_ack,false);
  for(const corrupt of [{message_urgency_keys:null},{message_urgency_keys:[]},{message_urgency_keys:{key:{id:"nonexistent",hash:"hash"}}},{message_urgencies:[null]}]){
    fs.writeFileSync(f.file,JSON.stringify({...saved,...corrupt}));assert.throws(()=>f.restart(),/Message urgency state is corrupt/);
  }
});
test("multiple pending urgencies are claimed separately even after the newest event advances the shared cursor",async()=>{
  const f=await fixture(),first=await f.send(f.human,"First assignment"),second=await f.send(f.human,"Second assignment");
  await f.call(f.agent,f.base+"/participation","PATCH",{mode:"paused"});
  const a=(await f.urge(f.human,first,[f.agent])).urgency,b=(await f.urge(f.human,second,[f.agent])).urgency;
  assert.equal((await f.call(f.agent,f.base+"/turns/claim","POST",{})).turn,null);
  await f.call(f.agent,f.base+"/participation","PATCH",{mode:"mentions"});
  const claimed=[];
  for(let i=0;i<2;i++){
    const {turn}=await f.call(f.agent,f.base+"/turns/claim","POST",{model:"synthetic",reasoning_effort:"medium"});
    assert.ok(turn);claimed.push(turn.context.trigger.urgency_id);
    await f.call(f.agent,f.base+"/turns/"+turn.id+"/finish","POST",{lease_token:turn.lease_token,action:"silent",rationale:"Observe this distinct assignment",model:"synthetic",reasoning_effort:"medium"});
  }
  assert.deepEqual(claimed,[b.id,a.id]);
  assert.equal((await f.call(f.agent,f.base+"/turns/claim","POST",{})).turn,null,"same pending urgency root does not start an unbounded loop");
  assert.equal((await f.read(f.agent,a)).urgency.can_ack,true);assert.equal((await f.read(f.agent,b)).urgency.can_ack,true);
});
test("sender audit projects executor preferences and private cancellation causes while preserving own captured input",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Visible source, private executor preferences");
  const messagePath=f.base+"/messages/"+message.id;
  await f.call(f.agent,messagePath+"/preferences","PATCH",{marked:true});
  await f.call(f.agent,f.base+"/preferences","PATCH",{muted:true,folded:true});
  await f.call(f.agent,f.base+"/participation","PATCH",{mode:"mentions"});
  const {urgency}=await f.urge(f.human,message,[f.agent]);
  const {turn}=await f.call(f.agent,f.base+"/turns/claim","POST",{model:"synthetic",reasoning_effort:"medium"});
  const turnPath=f.base+"/turns/"+turn.id;
  assert.equal(turn.context.trigger.message.personal_preferences.marked,true);
  assert.equal(turn.context.room.last_message.personal_preferences.marked,true);
  assert.equal(turn.context.room.message_grouping.marked_message_count,1);
  assert.equal(turn.context.room.preferences.muted,true);
  const stored=fs.readFileSync(f.file,"utf8"),sender=(await f.call(f.human,turnPath)).turn;
  assert.equal(sender.context.trigger.message.content,message.content);
  assert.equal(sender.private_context_omitted,true);
  assert.equal("personal_preferences" in sender.context.trigger.message,false);
  assert.equal("personal_preferences" in sender.context.room.last_message,false);
  for(const key of ["preferences","message_grouping","muted","folded","read_seq","notification_count"])
    assert.equal(key in sender.context.room,false,key);
  assert.equal(sender.context.context_hash,turn.context.context_hash,"projection never rewrites immutable input hash");
  assert.equal(fs.readFileSync(f.file,"utf8"),stored,"view projection never changes captured private input");
  assert.equal((await f.call(f.human,messagePath)).message.personal_preferences.marked,false);
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-projected-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const task=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"sender-projected-turn",role:"user",parts:[{kind:"data",data:{operation:"im_run_record",arguments:{room_id:f.room.id,turn_id:turn.id}}}]}}},f.human.token);
  assert.equal(task.result?.status.state,"completed","valid shared audit is not rejected as another person's private grouping");
  const cached=task.result.artifacts[0].parts[0].data.result.turn;
  assert.equal("personal_preferences" in cached.context.trigger.message,false);
  await f.call(f.agent,messagePath+"/preferences","PATCH",{hidden:true});
  const cancelled=(await f.call(f.human,turnPath)).turn;
  assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.result.rationale.includes("隐藏"),false);
  assert.equal(cancelled.result.rationale,"本次运行已取消，请由执行者检查当前上下文后继续。");
  assert.equal((await f.call(f.human,f.base)).runs.find(run=>run.id===turn.id).result.rationale,cancelled.result.rationale);
  const exported=await f.call(f.human,f.base+"/export");
  assert.equal(exported.includes("本人已隐藏上下文消息"),false);
  assert.equal((await f.read(f.human,urgency)).urgency.status,"pending","sender still cannot infer recipient's hidden preference from urgency state");
  await assert.rejects(f.call(f.agent,turnPath),{code:"urgency_scope"});
  await f.call(f.agent,messagePath+"/preferences","PATCH",{hidden:false});
  const own=(await f.call(f.agent,turnPath)).turn;
  assert.equal(own.context.trigger.message.personal_preferences.marked,true);
  assert.equal(own.result.rationale,"本人已隐藏上下文消息，重新获取可见上下文后继续");
  await f.call(f.human,messagePath+"/preferences","PATCH",{hidden:true});
  await assert.rejects(f.call(f.human,turnPath),{code:"urgency_scope"},"projection never bypasses sender's source visibility fence");
});
test("old cached turn and Markdown receipts cannot replay executor-private fields to the sender",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Prior private audit receipt");
  await f.call(f.agent,f.base+"/messages/"+message.id+"/preferences","PATCH",{marked:true});
  await f.call(f.agent,f.base+"/participation","PATCH",{mode:"mentions"});await f.urge(f.human,message,[f.agent]);
  const claimed=await f.call(f.agent,f.base+"/turns/claim","POST",{model:"synthetic",reasoning_effort:"medium"});
  const turnPath=f.base+"/turns/"+claimed.turn.id;
  const old=(await f.call(f.agent,turnPath)).turn;
  const direct={pathname:"/api/im"+turnPath,input:{},receipt:{turn:old}};
  await assert.rejects(f.im.authorizeStoredOperation(direct,f.human.token),{code:"receipt_scope_revoked"});
  await f.im.authorizeStoredOperation(direct,f.agent.token);
  const markdown=turn=>`## 运行与精确上下文\n\n### ${turn.id} · ${turn.status}\n\n\`\`\`json\n${JSON.stringify(turn,null,2)}\n\`\`\`\n`;
  const exported={pathname:"/api/im"+f.base+"/export",input:{},receipt:markdown(old)};
  await assert.rejects(f.im.authorizeStoredOperation(exported,f.human.token),{code:"receipt_scope_revoked"});
  await f.im.authorizeStoredOperation(exported,f.agent.token);
  const safe=(await f.call(f.human,turnPath)).turn;
  await f.im.authorizeStoredOperation({...direct,receipt:{turn:safe}},f.human.token);
  await f.im.authorizeStoredOperation({...exported,receipt:markdown(safe)},f.human.token);
  await f.im.authorizeStoredOperation({...exported,receipt:"## 共享文档\n\n"+markdown(old)+"\n"+markdown(safe)},f.human.token);
  const priorCancellation={...safe,status:"cancelled",result:{action:"blocked",rationale:"本人已隐藏上下文消息，重新获取可见上下文后继续"}};
  await assert.rejects(f.im.authorizeStoredOperation({...direct,receipt:{turn:priorCancellation}},f.human.token),{code:"receipt_scope_revoked"});
  await assert.rejects(f.im.authorizeStoredOperation({...exported,receipt:markdown(priorCancellation)},f.human.token),{code:"receipt_scope_revoked"});
});
