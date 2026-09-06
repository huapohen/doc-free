"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im");
const {nativeMCP,callNativeTool,publicTools}=require("../native-im-mcp");
const {createNativeA2A}=require("../native-a2a");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"membership-profile-"));
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(directory,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex");
  const options={file,adminToken:admin,workspace:{handle:async()=>{throw new Error("Unexpected document operation");}}};
  let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{
    const url=new URL("http://fixture/api/im"+route);
    return im.handle(method,url.pathname,input,who.token??who,url.searchParams);
  };
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await enroll("Stable Human"),agent=await enroll("Stable Agent","agent"),peer=await enroll("Peer"),outsider=await enroll("Outside");
  const {room}=await call(human,"/rooms","POST",{name:"Nickname room"}),base="/rooms/"+room.id;
  for(const who of [agent,peer])await call(human,base+"/members","POST",{principal_id:who.principal.id});
  const {room:other}=await call(human,"/rooms","POST",{name:"Other room"});
  await call(human,"/rooms/"+other.id+"/members","POST",{principal_id:agent.principal.id});
  const read=(who=human)=>call(who,base+"/membership-profile");
  const patch=(nickname,base_revision=1,who=human)=>call(who,base+"/membership-profile","PATCH",{nickname,base_revision});
  const send=(who,content,extra={},target=base)=>call(who,target+"/messages","POST",{client_id:crypto.randomUUID(),content,...extra});
  const rewrite=update=>{const state=JSON.parse(fs.readFileSync(file));update(state,state.rooms.find(r=>r.id===room.id));fs.writeFileSync(file,JSON.stringify(state));im=createNativeIM(options);};
  return {file,admin,human,agent,peer,outsider,room,other,base,call,read,patch,send,rewrite,restart:()=>im=createNativeIM(options),get im(){return im;}};
}
test("group-visible self nicknames preserve principal names, roles, other people and other rooms",async()=>{
  const f=await fixture(),original=fs.readFileSync(f.file,"utf8"),start=await f.read();
  assert.equal(start.membership_profile.nickname,"");assert.equal(start.membership_profile.display_name,"Stable Human");assert.equal(start.membership_profile.revision,1);
  assert.equal(fs.readFileSync(f.file,"utf8"),original);
  const roomRevision=(await f.call(f.human,f.base)).room.revision;
  const saved=await f.patch("  群内策划  ");assert.equal(saved.membership_profile.nickname,"群内策划");assert.equal(saved.membership_profile.revision,2);
  const visible=(await f.call(f.agent,f.base)).members.find(m=>m.principal_id===f.human.principal.id);
  assert.equal(visible.nickname,"群内策划");assert.equal(visible.display_name,"群内策划");assert.equal(visible.name,"Stable Human");assert.equal(visible.role,"owner");assert.equal(visible.membership_profile_revision,2);
  assert.equal((await f.call(f.human,"/me")).principal.name,"Stable Human");
  assert.equal((await f.call(f.human,"/rooms/"+f.other.id)).members.find(m=>m.principal_id===f.human.principal.id).nickname,"");
  assert.equal((await f.read(f.agent)).membership_profile.nickname,"");
  assert.equal((await f.call(f.human,f.base)).room.revision,roomRevision);
  f.restart();assert.deepEqual(await f.read(),saved);
  const cleared=await f.patch(" ",2);assert.equal(cleared.membership_profile.display_name,"Stable Human");assert.equal(cleared.membership_profile.nickname,"");
});
test("human and Agent members edit only themselves; even a group owner cannot target another member",async()=>{
  const f=await fixture();
  for(const who of [f.human,f.agent,f.peer]){
    assert.equal((await f.read(who)).permissions.can_edit,true);
    assert.equal((await f.patch(who.principal.kind+" colleague",1,who)).membership_profile.principal_id,who.principal.id);
  }
  await assert.rejects(f.call(f.human,f.base+"/membership-profile","PATCH",{nickname:"Forced",base_revision:2,principal_id:f.agent.principal.id}),{status:422});
  assert.equal((await f.read(f.agent)).membership_profile.nickname,"agent colleague");
  await assert.rejects(f.read(f.outsider),{code:"not_a_member"});await assert.rejects(f.patch("Intruder",1,f.outsider),{code:"not_a_member"});
  const {room}=await f.call(f.human,"/rooms/direct","POST",{principal_id:f.agent.principal.id});
  for(const method of ["GET","PATCH"])await assert.rejects(f.call(f.human,"/rooms/"+room.id+"/membership-profile",method,{nickname:"No direct alias",base_revision:1}),{code:"group_required"});
});
test("independent nickname CAS permits one concurrent edit, preserves stale drafts and rejects invalid input atomically",async()=>{
  const f=await fixture(),results=await Promise.allSettled([f.patch("First"),f.patch("Stale")]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.find(r=>r.status==="rejected").reason.code,"conflict");
  await f.patch("Agent own revision",1,f.agent);
  const saved=fs.readFileSync(f.file,"utf8");await f.patch("First",2);assert.equal(fs.readFileSync(f.file,"utf8"),saved);
  for(const input of [{nickname:"Missing version"},{nickname:"Bad version",base_revision:"2"},{nickname:"x".repeat(41),base_revision:2},{nickname:"line\nbreak",base_revision:2},{nickname:null,base_revision:2},{nickname:"Bad role",base_revision:2,role:"owner"}]){
    await assert.rejects(f.call(f.human,f.base+"/membership-profile","PATCH",input),{status:422});assert.equal(fs.readFileSync(f.file,"utf8"),saved);
  }
  await assert.rejects(f.patch("Lost draft",1),{status:409,code:"conflict"});assert.equal((await f.read()).membership_profile.nickname,"First");
});
test("current nicknames decorate old messages, parents, pins, search and mutation receipts without rewriting send history",async()=>{
  const f=await fixture();await f.patch("发时昵称");
  const original=await f.send(f.human,"nickname-search original"),reply=await f.send(f.agent,"Reply",{reply_to:original.message.id});
  await f.call(f.peer,f.base+"/messages/"+original.message.id+"/pin","POST",{pinned:true});
  const stored=JSON.parse(fs.readFileSync(f.file)),sent=stored.rooms.find(r=>r.id===f.room.id).messages[0];
  assert.equal(sent.author.display_name,"发时昵称");assert.equal(sent.author.display_name_basis,"sent_room_nickname");
  await f.patch("当前昵称",2);
  const detail=await f.call(f.peer,f.base),history=await f.call(f.peer,f.base+"/messages"),pins=await f.call(f.peer,f.base+"/pins");
  const single=await f.call(f.agent,f.base+"/messages/"+reply.message.id);
  const search=await f.call(f.peer,"/search?"+new URLSearchParams({q:"nickname-search",type:"message",room_id:f.room.id}));
  const reacted=await f.call(f.peer,f.base+"/messages/"+original.message.id+"/reactions","POST",{emoji:"👍"});
  for(const message of [detail.messages[0],detail.pins[0],history.messages[0],pins.messages[0],single.reply_parent,search.results[0],reacted.message]){
    assert.equal(message.author.display_name,"当前昵称");assert.equal(message.author.nickname,"当前昵称");assert.equal(message.author.name,"Stable Human");assert.equal(message.author.id,f.human.principal.id);assert.equal(message.author.display_name_basis,"current_room_nickname");
  }
  const after=JSON.parse(fs.readFileSync(f.file));assert.equal(after.rooms.find(r=>r.id===f.room.id).messages[0].author.display_name,"发时昵称");
  assert.deepEqual(after.events.find(e=>e.type==="message.created"&&e.message.id===original.message.id),stored.events.find(e=>e.type==="message.created"&&e.message.id===original.message.id));
  const last=await f.send(f.human,"Latest");await f.patch("更新昵称",3);
  const listed=(await f.call(f.agent,"/rooms")).rooms.find(r=>r.id===f.room.id);assert.equal(listed.last_message.id,last.message.id);assert.equal(listed.last_message.author.display_name,"更新昵称");
  await f.call(f.human,f.base+"/messages/"+last.message.id,"DELETE",{base_revision:1});
  const tombstone=await f.call(f.agent,f.base+"/messages/"+last.message.id);assert.equal(tombstone.message.content,"");assert.equal(tombstone.message.author.display_name,"更新昵称");assert.equal("history" in tombstone.message,false);
});
test("forwarding uses target-room sender nickname and duplicate receipts never import source-room labels",async()=>{
  const f=await fixture();await f.patch("Source Agent",1,f.agent);
  await f.call(f.agent,"/rooms/"+f.other.id+"/membership-profile","PATCH",{nickname:"Target Agent",base_revision:1});
  const source=await f.send(f.human,"Forward me"),route=f.base+"/messages/"+source.message.id+"/forward";
  const input={client_id:"same-forward",target_room_id:f.other.id,base_revision:1};
  const first=await f.call(f.agent,route,"POST",input);assert.equal(first.message.author.display_name,"Target Agent");
  await f.call(f.agent,"/rooms/"+f.other.id+"/membership-profile","PATCH",{nickname:"Target renamed",base_revision:2});
  const retried=await f.call(f.agent,route,"POST",input);assert.equal(retried.duplicate,true);assert.equal(retried.message.id,first.message.id);assert.equal(retried.message.author.display_name,"Target renamed");
});
test("returned nickname authors deeply isolate skills and device metadata from messages, events and captured context",async()=>{
  const f=await fixture();
  f.rewrite(state=>{
    const agent=state.principals.find(person=>person.id===f.agent.principal.id);
    agent.store_template_id="desktop-companion";agent.skills=["Review","Plan"];
  });
  const sent=await f.send(f.agent,"author-isolation fixture"),messageId=sent.message.id;
  const listed=(await f.call(f.human,"/rooms")).rooms.find(room=>room.id===f.room.id).last_message;
  await f.call(f.human,f.base+"/messages/"+messageId+"/pin","POST",{pinned:true});
  await f.send(f.human,"Capture this context",{mentions:[f.agent.principal.id]});
  const claimed=await f.call(f.agent,f.base+"/turns/claim","POST",{model:"fixture",reasoning_effort:"medium"});
  const expected=JSON.parse(fs.readFileSync(f.file)),originalRoom=expected.rooms.find(room=>room.id===f.room.id);
  const originalMessage=originalRoom.messages.find(message=>message.id===messageId);
  const expectedEvent=expected.events.find(event=>event.type==="message.created"&&event.message.id===messageId);
  const pick=messages=>messages.find(message=>message.id===messageId);
  const detail=await f.call(f.human,f.base),history=await f.call(f.human,f.base+"/messages");
  const pins=await f.call(f.human,f.base+"/pins"),single=await f.call(f.human,f.base+"/messages/"+messageId);
  const search=await f.call(f.human,"/search?"+new URLSearchParams({q:"author-isolation",type:"message",room_id:f.room.id}));
  for(const view of [sent.message,listed,pick(detail.messages),pick(history.messages),pick(pins.messages),single.message,search.results[0],pick(claimed.context.messages)]){
    view.author.skills.push("caller mutation");
    view.author.device_capabilities.supported_modes[0].platforms.push("caller mutation");
    view.author.device_capabilities.runtime_requirements[0]="caller mutation";
    const current=(await f.call(f.human,f.base+"/messages/"+messageId)).message;
    assert.deepEqual(current.author.skills,originalMessage.author.skills);
    assert.deepEqual(current.author.device_capabilities,originalMessage.author.device_capabilities);
  }
  // Force a later write and restart: poisoned response references must never
  // leak into the durable message, original audit event, principal or turn.
  await f.patch("Fresh nickname",1,f.agent);
  const after=JSON.parse(fs.readFileSync(f.file)),room=after.rooms.find(room=>room.id===f.room.id);
  assert.deepEqual(pick(room.messages).author,originalMessage.author);
  assert.deepEqual(after.events.find(event=>event.type==="message.created"&&event.message.id===messageId),expectedEvent);
  assert.deepEqual(room.turns.find(turn=>turn.id===claimed.turn.id).context,originalRoom.turns.find(turn=>turn.id===claimed.turn.id).context);
  assert.deepEqual(after.principals.find(person=>person.id===f.agent.principal.id).skills,["Review","Plan"]);
  f.restart();
  const restarted=(await f.call(f.human,f.base+"/messages/"+messageId)).message;
  assert.deepEqual(restarted.author.skills,originalMessage.author.skills);
  assert.deepEqual(restarted.author.device_capabilities,originalMessage.author.device_capabilities);
});
test("captured Agent context and immutable nickname events stay auditable while future reads use current labels",async()=>{
  const f=await fixture();await f.patch("Review lead");await f.patch("Research Agent",1,f.agent);
  await f.send(f.human,"Review nickname fixture",{mentions:[f.agent.principal.id]});
  const claimed=await f.call(f.agent,f.base+"/turns/claim","POST",{model:"fixture",reasoning_effort:"medium"});
  assert.equal(claimed.context.participants.find(p=>p.principal_id===f.human.principal.id).display_name,"Review lead");assert.equal(claimed.context.messages.at(-1).author.display_name,"Review lead");
  await f.patch("New lead",2);
  const turn=await f.call(f.agent,f.base+"/turns/"+claimed.turn.id);assert.equal(turn.turn.context.messages.at(-1).author.display_name,"Review lead");
  const events=(await f.call(f.peer,"/events")).events.filter(e=>e.type==="membership_profile.updated");
  assert.equal(events[0].membership_profile.nickname,"Review lead");assert.equal(events[0].previous.nickname,"");assert.equal(events[0].actor_id,f.human.principal.id);
  assert.equal((await f.call(f.outside??f.outsider,"/events")).events.some(e=>e.type==="membership_profile.updated"),false);
  const exported=await f.call(f.peer,f.base+"/export");assert.ok(exported.includes("群昵称变更审计"));assert.ok(exported.includes('"sent_author"'));assert.ok(exported.includes('"current_author"'));assert.ok(exported.includes("New lead"));
});
test("leave clears nickname with a version tombstone, rejects stale rejoin edits and protects self or owner removal",async()=>{
  const f=await fixture();await f.patch("Temporary member",1,f.agent);const sent=await f.send(f.agent,"Before leaving");
  await f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE");
  await assert.rejects(f.read(f.agent),{code:"not_a_member"});
  assert.equal((await f.call(f.peer,f.base+"/messages/"+sent.message.id)).message.author.display_name,"Stable Agent");
  await f.call(f.human,f.base+"/members","POST",{principal_id:f.agent.principal.id});
  const rejoined=await f.read(f.agent);assert.equal(rejoined.membership_profile.nickname,"");assert.equal(rejoined.membership_profile.revision,3);
  await assert.rejects(f.patch("Stale revival",2,f.agent),{code:"conflict"});await f.patch("Fresh member",3,f.agent);
  f.rewrite((state,room)=>{room.members[f.agent.principal.id].role="owner";});
  await assert.rejects(f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE"),{code:"owner_required"});
  await assert.rejects(f.call(f.agent,f.base+"/members/"+f.agent.principal.id,"DELETE"),{code:"owner_required"});
  await assert.rejects(f.call(f.agent,f.base+"/members/"+f.human.principal.id,"DELETE"),{code:"owner_required"});
});
test("MCP uses current caller and CAS; A2A nickname receipts and events require current room and app access",async()=>{
  const f=await fixture(),mcp=(who,name,args)=>nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  const parse=result=>JSON.parse(result.result.content[0].text);
  for(const who of [f.human,f.agent]){
    const current=parse(await mcp(who,"im_membership_profile",{room_id:f.room.id}));assert.equal(current.membership_profile.principal_id,who.principal.id);
    const saved=await mcp(who,"im_update_membership_profile",{room_id:f.room.id,nickname:who.principal.kind+" MCP",base_revision:1});assert.equal(saved.result.isError,false);
    const stale=await mcp(who,"im_update_membership_profile",{room_id:f.room.id,nickname:"Stale",base_revision:1});assert.deepEqual(parse(stale),{status:409,code:"conflict"});
  }
  const gateway=createNativeA2A({file:path.join(directory,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const result=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"nickname",role:"user",parts:[{kind:"data",data:{operation:"im_membership_profile",arguments:{room_id:f.room.id}}}]}}},f.agent.token);assert.equal(result.result.status.state,"completed");
  await f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE");
  const denied=await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:result.result.id}},f.agent.token);assert.equal(denied.error.data.code,"not_a_member");
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.peer.principal.id]});
  await assert.rejects(f.read(f.peer),{code:"app_policy_denied"});await assert.rejects(f.patch("Denied",1,f.peer),{code:"app_policy_denied"});
  assert.equal((await f.call(f.peer,"/events")).events.some(e=>e.type==="membership_profile.updated"),false);
});
test("nickname save failure stops service and corrupt saved profiles never reset silently",async()=>{
  const f=await fixture();await f.patch("Durable");const before=await f.read(),rename=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("Fixture save failure");return rename(source,target);};
  try{await assert.rejects(f.patch("Lost",2),{code:"storage_failed"});}finally{fs.renameSync=rename;}
  await assert.rejects(f.read(),{code:"storage_failed"});f.restart();assert.deepEqual(await f.read(),before);
  assert.throws(()=>f.rewrite((state,room)=>{room.membership_profiles[f.human.principal.id].revision="2";}),/Membership profiles are corrupt/);
});
