"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP,callNativeTool,publicTools}=require("../native-im-mcp"),{createNativeA2A}=require("../native-a2a");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-message-highlights-"));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(temporary,crypto.randomUUID(),"im.json"),admin=crypto.randomBytes(32).toString("hex"),options={file,adminToken:admin,workspace:{handle:async()=>{throw Error("No document operation expected");}}};let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind}),human=await enroll("Human"),agent=await enroll("Agent","agent"),peer=await enroll("Peer"),outside=await enroll("Outside");
  const {room}=await call(human,"/rooms","POST",{name:"Highlights fixture"}),base="/rooms/"+room.id;
  for(const who of [agent,peer])await call(human,base+"/members","POST",{principal_id:who.principal.id});
  const send=async(who,content)=>(await call(who,base+"/messages","POST",{client_id:crypto.randomUUID(),content})).message;
  const set=(who,revision,message)=>call(who,base+"/highlights","PATCH",{base_revision:revision,message_id:message?.id??null,...(message?{message_revision:message.revision}:{} )});
  return {file,admin,human,agent,peer,outside,room,base,call,send,set,restart:()=>im=createNativeIM(options),get im(){return im;}};
}
test("malformed persisted highlight preferences fail closed instead of crashing later reads",async()=>{
  const f=await fixture(),saved=JSON.parse(fs.readFileSync(f.file));
  for(const highlights of [null,{revision:1,item:null,preferences:null},{revision:1,item:null,preferences:{person:null}},{revision:1,item:{message_id:"msg-missing"},preferences:{}}]){
    saved.rooms.find(room=>room.id===f.room.id).message_highlights=highlights;
    fs.writeFileSync(f.file,JSON.stringify(saved));assert.throws(()=>f.restart(),/Message highlights are corrupt/);
  }
});
test("Pin collection and room-top message are separate resources, equally managed by current Human and Agent members",async()=>{
  const advertised=await fixture();
  for(const who of [advertised.human,advertised.agent])assert.deepEqual((await advertised.call(who,advertised.base)).native_features,{message_highlights:true,message_urgencies:true});
  await assert.rejects(advertised.call(advertised.outside,advertised.base),{code:"not_a_member"});
  const f=await fixture(),first=await f.send(f.human,"Pin collection message"),second=await f.send(f.agent,"Room top message");
  await f.call(f.human,f.base+"/messages/"+first.id+"/pin","POST",{pinned:true});
  const initial=await f.call(f.agent,f.base+"/highlights");assert.deepEqual(initial.items,[]);assert.equal(initial.revision,1);assert.equal(initial.permissions.can_set,true);
  const changed=await f.set(f.agent,1,second);assert.equal(changed.revision,2);assert.equal(changed.items[0].message_id,second.id);assert.equal(changed.items[0].set_by,f.agent.principal.id);assert.equal(changed.items[0].message.pinned,false);
  assert.deepEqual((await f.call(f.peer,f.base+"/pins")).messages.map(message=>message.id),[first.id]);
  await f.set(f.peer,2,null);assert.equal((await f.call(f.agent,f.base+"/highlights")).items.length,0);assert.equal((await f.call(f.agent,f.base+"/pins")).messages.length,1);
  await assert.rejects(f.call(f.outside,f.base+"/highlights"),{code:"not_a_member"});await assert.rejects(f.set(f.outside,3,first),{code:"not_a_member"});
});
test("top revision and source revision guard concurrent edits and GET/idempotent intentions do not acknowledge reading",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Initial text");
  await f.set(f.human,1,message);const stable=fs.readFileSync(f.file,"utf8");
  for(const who of [f.agent,f.peer]){const response=await f.call(who,f.base+"/highlights");assert.equal(response.items[0].source_status,"current");assert.equal((await f.call(who,f.base)).highlights.revision,2);}
  await f.set(f.agent,2,message);assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  await assert.rejects(f.set(f.agent,1,null),{code:"conflict"});
  await f.call(f.human,f.base+"/messages/"+message.id,"PATCH",{base_revision:1,content:"Edited source"});
  await assert.rejects(f.set(f.agent,2,message),{code:"conflict"});const view=await f.call(f.agent,f.base+"/highlights");assert.equal(view.items[0].source_status,"updated");assert.equal(view.items[0].message.content,"Edited source");assert.equal(view.items[0].message_revision,1);
  const readers=await f.call(f.human,f.base+"/messages/"+message.id+"/readers");assert.equal(readers.receipt_summary.read_count,0);
  for(const input of [{message_id:message.id,message_revision:2},{base_revision:2,message_id:message.id},{base_revision:2,message_id:null,principal_id:f.agent.principal.id}])await assert.rejects(f.call(f.human,f.base+"/highlights","PATCH",input),{status:422});
});
test("collapse affects only its principal and top revision; hidden and recalled sources remain explicit without leaking history",async()=>{
  const f=await fixture(),first=await f.send(f.human,"First top secret"),second=await f.send(f.agent,"Replacement top");
  await f.set(f.human,1,first);await f.call(f.agent,f.base+"/highlights/preferences","PATCH",{base_revision:2,collapsed:true});
  assert.equal((await f.call(f.agent,f.base+"/highlights")).collapsed,true);assert.equal((await f.call(f.human,f.base+"/highlights")).collapsed,false);
  f.restart();assert.equal((await f.call(f.agent,f.base+"/highlights")).collapsed,true);
  const agentEvents=await f.call(f.agent,"/events?after=0"),humanEvents=await f.call(f.human,"/events?after=0");assert.equal(agentEvents.events.filter(event=>event.type==="message.highlight.preferences.updated").length,1);assert.equal(humanEvents.events.filter(event=>event.type==="message.highlight.preferences.updated").length,0);
  await f.set(f.peer,2,second);assert.equal((await f.call(f.agent,f.base+"/highlights")).collapsed,false);await assert.rejects(f.call(f.agent,f.base+"/highlights/preferences","PATCH",{base_revision:2,collapsed:true}),{code:"conflict"});
  await f.call(f.agent,f.base+"/messages/"+second.id+"/preferences","PATCH",{hidden:true});assert.equal((await f.call(f.agent,f.base+"/highlights")).items.length,0);assert.equal((await f.call(f.human,f.base+"/highlights")).items.length,1);await assert.rejects(f.set(f.agent,3,second),{code:"message_hidden"});
  await f.call(f.agent,f.base+"/messages/"+second.id+"/preferences","PATCH",{hidden:false});await f.call(f.agent,f.base+"/messages/"+second.id,"DELETE",{base_revision:1});
  const recalled=await f.call(f.human,f.base+"/highlights");assert.equal(recalled.items[0].source_status,"retracted");assert.equal(recalled.items[0].message.content,"");assert.equal("history" in recalled.items[0].message,false);await assert.rejects(f.set(f.human,3,second),{code:"message_retracted"});
  await f.set(f.agent,3,null);assert.equal((await f.call(f.human,f.base+"/highlights")).items.length,0);
});
test("highlight MCP is native for both identities and stale cached A2A reads lose room or application authority",async()=>{
  const f=await fixture(),message=await f.send(f.agent,"Native top source"),rpc=(who,name,args)=>nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  const changed=await rpc(f.agent,"im_set_highlight",{room_id:f.room.id,base_revision:1,message_id:message.id,message_revision:1});assert.equal(changed.result.isError,false);
  assert.equal((await rpc(f.human,"im_collapse_highlight",{room_id:f.room.id,base_revision:2,collapsed:true})).result.isError,false);
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools}),response=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"read-top",role:"user",parts:[{kind:"data",data:{operation:"im_highlights",arguments:{room_id:f.room.id}}}]}}},f.agent.token);
  assert.equal(response.result.status.state,"completed");await f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE");assert.equal((await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:response.result.id}},f.agent.token)).error.data.code,"not_a_member");
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.peer.principal.id]});await assert.rejects(f.call(f.peer,f.base+"/highlights"),{code:"app_policy_denied"});
});
test("failed highlight persistence fail-stops and restart retains the last durable top, never partial state",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Durable top");await f.set(f.human,1,message);
  fs.mkdirSync(f.file+".tmp");await assert.rejects(f.set(f.agent,2,null),{code:"storage_failed"});await assert.rejects(f.call(f.human,f.base+"/highlights"),{code:"storage_failed"});fs.rmdirSync(f.file+".tmp");f.restart();assert.equal((await f.call(f.human,f.base+"/highlights")).items[0].message_id,message.id);
});
