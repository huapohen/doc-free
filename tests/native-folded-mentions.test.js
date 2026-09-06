"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im");
const {nativeMCP,publicTools}=require("../native-im-mcp");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"folded-mentions-"));
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
  const human=await enroll("Human"),peer=await enroll("Peer"),agent=await enroll("Agent","agent"),bot=await enroll("Other Agent","agent"),outside=await enroll("Outside");
  const {room}=await call(human,"/rooms","POST",{name:"Broadcast fixture"}),base="/rooms/"+room.id;
  for(const person of [peer,agent,bot])await call(human,base+"/members","POST",{principal_id:person.principal.id});
  const prefs=(who,changes)=>call(who,base+"/preferences","PATCH",changes);
  const send=(who,content,extra={},target=base)=>call(who,target+"/messages","POST",{client_id:crypto.randomUUID(),content,...extra});
  const detail=(who=human)=>call(who,base);
  const mode=(who,value)=>call(who,base+"/participation","PATCH",{mode:value});
  const claim=(who=agent)=>call(who,base+"/turns/claim","POST",{model:"fixture",reasoning_effort:"medium"});
  const finish=(claimed,who=agent,extra={})=>call(who,base+"/turns/"+claimed.turn.id+"/finish","POST",{
    lease_token:claimed.turn.lease_token,action:"silent",rationale:"Checked fixture",model:"fixture",reasoning_effort:"medium",...extra});
  const rewrite=update=>{const state=JSON.parse(fs.readFileSync(file));update(state,state.rooms.find(value=>value.id===room.id));fs.writeFileSync(file,JSON.stringify(state));im=createNativeIM(options);};
  return {file,admin,human,peer,agent,bot,outside,room,base,call,prefs,send,detail,mode,claim,finish,rewrite,restart:()=>im=createNativeIM(options),get im(){return im;}};
}
const mentionsGroup=snapshot=>snapshot.groups.find(group=>group.id==="mentions");

test("legacy folded and broadcast preferences default read-only and remain personal without changing participation or read state",async()=>{
  const f=await fixture();
  f.rewrite((state,room)=>{for(const saved of Object.values(room.preferences)){delete saved.folded;delete saved.mute_all_mentions;}});
  const before=fs.readFileSync(f.file,"utf8"),initial=await f.detail(f.agent);
  assert.equal(initial.room.folded,false);assert.equal(initial.room.mute_all_mentions,false);
  assert.equal(initial.room.preferences.folded,false);assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const member=initial.members.find(value=>value.principal_id===f.agent.principal.id),read=initial.room.read_seq;
  const saved=await f.prefs(f.agent,{folded:true,mute_all_mentions:true});
  assert.equal(saved.room.folded,true);assert.equal(saved.preferences.mute_all_mentions,true);
  const after=await f.detail(f.agent);
  assert.deepEqual(after.members.find(value=>value.principal_id===f.agent.principal.id),member);
  assert.equal(after.room.revision,initial.room.revision);assert.equal(after.room.read_seq,read);
  assert.equal((await f.detail(f.human)).room.folded,false);
  f.restart();assert.equal((await f.detail(f.agent)).room.folded,true);
  const stable=fs.readFileSync(f.file,"utf8");
  for(const input of [{folded:"true"},{folded:null},{mute_all_mentions:1},{folded:true,principal_id:f.human.principal.id},{folded:true,mode:"paused"}]){
    await assert.rejects(f.prefs(f.agent,input),{status:422});assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  }
  const {room:direct}=await f.call(f.human,"/rooms/direct","POST",{principal_id:f.agent.principal.id});
  const directBase="/rooms/"+direct.id;
  assert.equal((await f.call(f.human,directBase+"/preferences","PATCH",{folded:true})).room.folded,true);
  await assert.rejects(f.call(f.human,directBase+"/preferences","PATCH",{mute_all_mentions:true}),{code:"group_required"});
});

test("broadcasts are explicit group-only booleans with one immutable recipient snapshot per send intent",async()=>{
  const f=await fixture(),ids=[f.peer,f.agent,f.bot].map(person=>person.principal.id).sort();
  const sent=await f.send(f.human,"Broadcast",{client_id:"stable",mention_all:true});
  assert.equal(sent.message.mention_all,true);assert.deepEqual(sent.message.mention_all_ids,ids);assert.deepEqual(sent.message.mentions,[]);
  await f.call(f.human,f.base+"/members","POST",{principal_id:f.outside.principal.id});
  const retry=await f.send(f.human,"Broadcast",{client_id:"stable",mention_all:true});
  assert.equal(retry.duplicate,true);assert.equal(retry.message.id,sent.message.id);assert.deepEqual(retry.message.mention_all_ids,ids);
  assert.equal(mentionsGroup(await f.call(f.outside,"/message-groups")).room_count,0);
  await assert.rejects(f.send(f.human,"Broadcast",{client_id:"stable",mention_all:false}),{code:"idempotency_conflict"});
  const selected=await f.send(f.human,"Explicit selected members",{mentions:ids});
  assert.equal(selected.message.mention_all,false);assert.deepEqual(selected.message.mention_all_ids,[]);
  const stable=fs.readFileSync(f.file,"utf8");
  for(const extra of [{mention_all:"true"},{mention_all:null},{mention_all:1},{mention_all_ids:ids}]){
    await assert.rejects(f.send(f.agent,"Invalid",extra),{status:422});assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  }
  const {room:direct}=await f.call(f.human,"/rooms/direct","POST",{principal_id:f.agent.principal.id});
  await assert.rejects(f.send(f.agent,"Direct broadcast",{mention_all:true},"/rooms/"+direct.id),{code:"group_required"});
  assert.equal((await f.send(f.agent,"Direct plain",{mention_all:false},"/rooms/"+direct.id)).message.mention_all,false);
  f.restart();assert.deepEqual((await f.call(f.human,f.base+"/messages/"+sent.message.id)).message.mention_all_ids,ids);
});

test("broadcast editing preserves old targets, versions changes atomically, and only an explicit fresh broadcast includes later members",async()=>{
  const f=await fixture(),sent=await f.send(f.agent,"Original",{mention_all:true,mentions:[f.human.principal.id]});
  const route=f.base+"/messages/"+sent.message.id,originalIds=[...sent.message.mention_all_ids];
  await f.call(f.human,f.base+"/members","POST",{principal_id:f.outside.principal.id});
  const bodyOnly=await f.call(f.agent,route,"PATCH",{base_revision:1,content:"Body edited"});
  assert.deepEqual(bodyOnly.message.mention_all_ids,originalIds);assert.deepEqual(bodyOnly.message.mentions,[f.human.principal.id]);
  const kept=await f.call(f.agent,route,"PATCH",{base_revision:2,content:"Still broadcast",mention_all:true});
  assert.deepEqual(kept.message.mention_all_ids,originalIds);
  assert.equal(mentionsGroup(await f.call(f.outside,"/message-groups")).room_count,0);
  const stable=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.call(f.human,route,"PATCH",{base_revision:3,content:"Owner cannot edit",mention_all:false}),{code:"author_required"});
  for(const input of [{base_revision:2,mention_all:false},{base_revision:3,mention_all:"true"},{base_revision:3,mention_all_ids:[f.outside.principal.id]}]){
    await assert.rejects(f.call(f.agent,route,"PATCH",{content:"Rejected",...input}));assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  }
  const cleared=await f.call(f.agent,route,"PATCH",{base_revision:3,content:"No broadcast",mention_all:false,mentions:[]});
  assert.equal(cleared.message.mention_all,false);assert.deepEqual(cleared.message.mention_all_ids,[]);
  const fresh=await f.call(f.agent,route,"PATCH",{base_revision:4,content:"Fresh broadcast",mention_all:true});
  assert.ok(fresh.message.mention_all_ids.includes(f.outside.principal.id));
  assert.equal(mentionsGroup(await f.call(f.outside,"/message-groups")).room_count,1);
  const state=JSON.parse(fs.readFileSync(f.file)),stored=state.rooms.find(room=>room.id===f.room.id).messages[0];
  assert.deepEqual(stored.history[0].mention_all_ids,originalIds);
  assert.deepEqual(state.events.find(event=>event.type==="message.created"&&event.message.id===sent.message.id).message.mention_all_ids,originalIds);
  await f.call(f.agent,route,"DELETE",{base_revision:5});
  const recalled=(await f.call(f.human,route)).message;
  assert.equal(recalled.mention_all,false);assert.deepEqual(recalled.mention_all_ids,[]);assert.deepEqual(recalled.mentions,[]);
  assert.equal(mentionsGroup(await f.call(f.outside,"/message-groups")).room_count,0);
});

test("real unread and reminder counts separate raw broadcasts, effective mentions, mute and folding",async()=>{
  const f=await fixture();
  await f.send(f.human,"Plain");
  const broadcast=await f.send(f.human,"All",{mention_all:true});
  const explicit=await f.send(f.human,"Explicit",{mentions:[f.peer.principal.id]});
  await f.send(f.human,"Both",{mention_all:true,mentions:[f.peer.principal.id]});
  await f.send(f.peer,"Own broadcast",{mention_all:true,mentions:[f.peer.principal.id]});
  const counts=async()=>{const {room}=await f.detail(f.peer);return Object.fromEntries(["unread_count","mention_count","explicit_mention_count","all_mention_count","notification_count"].map(key=>[key,room[key]]));};
  assert.deepEqual(await counts(),{unread_count:4,mention_count:3,explicit_mention_count:2,all_mention_count:2,notification_count:4});
  await f.prefs(f.peer,{mute_all_mentions:true});
  assert.deepEqual(await counts(),{unread_count:4,mention_count:2,explicit_mention_count:2,all_mention_count:2,notification_count:4});
  await f.prefs(f.peer,{muted:true});assert.equal((await counts()).notification_count,2);
  await f.prefs(f.peer,{folded:true});assert.equal((await counts()).notification_count,0);
  assert.equal((await counts()).unread_count,4);assert.equal((await counts()).mention_count,2);
  const grouped=await f.call(f.peer,"/message-groups");
  assert.equal(mentionsGroup(grouped).mention_count,2);assert.equal(mentionsGroup(grouped).notification_count,0);
  assert.equal(grouped.groups.find(group=>group.id==="messages").unread_count,4);
  await f.prefs(f.peer,{read_seq:broadcast.message.seq,folded:false});
  assert.deepEqual(await counts(),{unread_count:2,mention_count:2,explicit_mention_count:2,all_mention_count:1,notification_count:2});
  await f.call(f.human,f.base+"/messages/"+explicit.message.id,"DELETE",{base_revision:1});
  assert.deepEqual(await counts(),{unread_count:1,mention_count:1,explicit_mention_count:1,all_mention_count:1,notification_count:1});
  assert.equal((await f.detail(f.agent)).room.mute_all_mentions,false);
});

test("the historical @me filter uses effective mentions while muted broadcasts remain visible as ordinary unread messages",async()=>{
  const f=await fixture(),sent=await f.send(f.human,"Broadcast",{mention_all:true});
  assert.equal(mentionsGroup(await f.call(f.peer,"/message-groups")).room_count,1);
  await f.prefs(f.peer,{mute_all_mentions:true});
  assert.equal(mentionsGroup(await f.call(f.peer,"/message-groups")).room_count,0);
  assert.equal((await f.detail(f.peer)).room.unread_count,1);
  await f.prefs(f.peer,{read_seq:sent.message.seq,mute_all_mentions:false});
  const grouped=await f.call(f.peer,"/message-groups");
  assert.equal(mentionsGroup(grouped).room_count,1);assert.equal(mentionsGroup(grouped).mention_count,0);
  assert.equal((await f.detail(f.peer)).room.notification_count,0);
});

test("Agent mention wakeups respect broadcast mute but folding and ordinary mute never rewrite proactive participation",async()=>{
  const f=await fixture();await f.mode(f.agent,"mentions");await f.prefs(f.agent,{folded:true,muted:true});
  await f.send(f.human,"Ordinary");assert.equal((await f.claim()).turn,null);
  await f.send(f.human,"All colleagues",{mention_all:true});
  const broadcast=await f.claim();assert.ok(broadcast.turn);await f.finish(broadcast);
  await f.prefs(f.agent,{mute_all_mentions:true});
  await f.send(f.human,"Suppressed broadcast",{mention_all:true});assert.equal((await f.claim()).turn,null);
  await f.send(f.human,"Explicit beats broadcast mute",{mention_all:true,mentions:[f.agent.principal.id]});
  const explicit=await f.claim();assert.ok(explicit.turn);await f.finish(explicit);
  await f.mode(f.agent,"active");
  await f.send(f.human,"Active observation continues",{mention_all:true});
  const active=await f.claim();assert.ok(active.turn);await f.finish(active);
  await f.send(f.bot,"Agent broadcast without effective mention",{mention_all:true});assert.equal((await f.claim()).turn,null);
  await f.send(f.bot,"Explicit Agent collaboration",{mentions:[f.agent.principal.id],mention_all:true});
  const otherAgent=await f.claim();assert.ok(otherAgent.turn);await f.finish(otherAgent);
  await f.mode(f.agent,"paused");await f.send(f.human,"Paused stays paused",{mentions:[f.agent.principal.id]});assert.equal((await f.claim()).turn,null);
});

test("removed broadcast mentions cannot wake an Agent through an older queued message event",async()=>{
  const f=await fixture();await f.mode(f.agent,"mentions");
  const sent=await f.send(f.human,"Old mention",{mention_all:true});
  await f.call(f.human,f.base+"/messages/"+sent.message.id,"PATCH",{base_revision:1,content:"Now ordinary",mention_all:false});
  assert.equal((await f.claim()).turn,null);
  await f.call(f.human,f.base+"/messages/"+sent.message.id,"PATCH",{base_revision:2,content:"Fresh explicit",mentions:[f.agent.principal.id]});
  const next=await f.claim();assert.ok(next.turn);assert.equal(next.context.trigger.message.revision,3);
  assert.deepEqual(next.context.trigger.message.mentions,[f.agent.principal.id]);
});

test("MCP sends and edits true broadcasts for both identities and rejects forged recipients",async()=>{
  const f=await fixture(),rpc=(who,name,args)=>nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  const parse=result=>JSON.parse(result.result.content[0].text);
  for(const name of ["im_send","im_edit_message"])assert.equal(publicTools.find(tool=>tool.name===name).inputSchema.properties.mention_all.type,"boolean");
  assert.equal(publicTools.find(tool=>tool.name==="im_preferences").inputSchema.properties.folded.type,"boolean");
  for(const who of [f.human,f.agent]){
    const sent=await rpc(who,"im_send",{room_id:f.room.id,client_id:"mcp-broadcast",content:"MCP broadcast",mention_all:true});
    assert.equal(sent.result.isError,false);const message=parse(sent).message;assert.equal(message.mention_all,true);
    const edited=await rpc(who,"im_edit_message",{room_id:f.room.id,message_id:message.id,base_revision:1,content:"MCP edited",mention_all:false});
    assert.equal(edited.result.isError,false);assert.equal(parse(edited).message.mention_all,false);
    const preference=await rpc(who,"im_preferences",{room_id:f.room.id,folded:true,mute_all_mentions:true});
    assert.equal(preference.result.isError,false);assert.equal(parse(preference).room.notification_count,0);
    const invalid=await rpc(who,"im_send",{room_id:f.room.id,client_id:"forged",content:"No",mention_all_ids:[f.outside.principal.id]});assert.equal(invalid.result.isError,true);
  }
});

test("forward, search, frozen context, export and legacy retry preserve truthful broadcast semantics",async()=>{
  const f=await fixture();await f.mode(f.agent,"mentions");
  const sent=await f.send(f.human,"broadcast-search",{mention_all:true}),ids=[...sent.message.mention_all_ids];
  const search=await f.call(f.peer,"/search?"+new URLSearchParams({q:"broadcast-search",type:"message",room_id:f.room.id}));
  assert.equal(search.results[0].mention_all,true);assert.deepEqual(search.results[0].mention_all_ids,ids);
  search.results[0].mention_all_ids.push("caller-mutation");
  assert.deepEqual((await f.call(f.peer,f.base+"/messages/"+sent.message.id)).message.mention_all_ids,ids);
  const turn=await f.claim();assert.deepEqual(turn.context.trigger.message.mention_all_ids,ids);
  await f.finish(turn);
  const {room:target}=await f.call(f.human,"/rooms","POST",{name:"Forward target"});
  const forwarded=await f.call(f.human,f.base+"/messages/"+sent.message.id+"/forward","POST",{client_id:"forward",target_room_id:target.id,base_revision:1});
  assert.equal(forwarded.message.mention_all,false);assert.deepEqual(forwarded.message.mention_all_ids,[]);
  const exported=await f.call(f.human,f.base+"/export");assert.ok(exported.includes('"mention_all": true'));assert.ok(exported.includes('"mention_all_ids"'));
  const legacy=await f.send(f.human,"Legacy plain",{client_id:"legacy"});
  f.rewrite((state,room)=>{const message=room.messages.find(item=>item.id===legacy.message.id);delete message.mention_all;delete message.mention_all_ids;});
  const duplicate=await f.send(f.human,"Legacy plain",{client_id:"legacy",mention_all:false});
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.message.mention_all,false);assert.deepEqual(duplicate.message.mention_all_ids,[]);
});

test("Agent finish broadcasts preserve lease idempotency and a failed preference save fail-stops without losing durable state",async()=>{
  const f=await fixture();await f.mode(f.agent,"mentions");
  await f.send(f.human,"Please report",{mentions:[f.agent.principal.id]});
  const claimed=await f.claim(),extra={action:"reply",content:"Agent broadcast result",mention_all:true};
  const done=await f.finish(claimed,f.agent,extra);assert.equal(done.message.mention_all,true);
  const duplicate=await f.finish(claimed,f.agent,extra);assert.equal(duplicate.duplicate,true);assert.deepEqual(duplicate.message.mention_all_ids,done.message.mention_all_ids);
  await assert.rejects(f.finish(claimed,f.agent,{...extra,mention_all:false}),{code:"turn_finished"});
  await f.prefs(f.agent,{folded:true});const before=(await f.detail(f.agent)).room.preferences,rename=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("Fixture save failure");return rename(source,target);};
  try{await assert.rejects(f.prefs(f.agent,{folded:false,mute_all_mentions:true}),{code:"storage_failed"});}finally{fs.renameSync=rename;}
  await assert.rejects(f.detail(f.agent),{code:"storage_failed"});f.restart();assert.deepEqual((await f.detail(f.agent)).room.preferences,before);
});
