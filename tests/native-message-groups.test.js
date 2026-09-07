"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im");
const {nativeMCP,callNativeTool,publicTools}=require("../native-im-mcp");
const {createNativeA2A}=require("../native-a2a");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"message-groups-"));after(()=>fs.rmSync(directory,{recursive:true,force:true}));
async function fixture({documents=false}={}){
  const file=path.join(directory,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex");
  const docs=new Map();
  const options={file,adminToken:admin,workspace:{handle:async(method,route,input)=>{
    if(!documents)throw new Error("No document operation expected");
    if(method==="POST"){
      const document={id:crypto.randomUUID().slice(0,8),title:input.title,content:input.content,revision:1,content_hash:crypto.createHash("sha256").update(input.content).digest("hex")};docs.set(document.id,document);return {...document};
    }
    if(method==="GET")return {...docs.get(route.split("/").at(-1))};
    throw new Error("Unexpected document operation");
  }}};let im=createNativeIM(options);
  const call=(who,route="/message-groups",method="GET",input={})=>im.handle(method,"/api/im"+route,input,who.token??who);
  const make=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await make("Human"),agent=await make("Agent","agent"),outside=await make("Outside");
  const {room}=await call(human,"/rooms","POST",{name:"Project Alpha"});await call(human,`/rooms/${room.id}/members`,"POST",{principal_id:agent.principal.id});
  const {room:direct}=await call(human,"/rooms/direct","POST",{principal_id:agent.principal.id});
  const create=async(name,extra={},who=human)=>call(who,"/message-groups","POST",{base_revision:(await call(who)).revision,client_id:crypto.randomUUID(),name,...extra});
  const patch=async(route,input,who=human)=>call(who,route,"PATCH",{base_revision:(await call(who)).revision,...input});
  return {file,admin,human,agent,outside,room,direct,call,create,patch,get im(){return im;},restart:()=>im=createNativeIM(options)};
}
const group=(snapshot,id)=>snapshot.groups.find(group=>group.id===id);

test("personal group defaults read without persistence; sidebar and mobile shortcuts order independently with CAS",async()=>{
  const f=await fixture(),before=fs.readFileSync(f.file,"utf8"),initial=await f.call(f.human);
  assert.equal(initial.revision,1);assert.equal(fs.readFileSync(f.file,"utf8"),before);assert.equal(group(initial,"messages").fixed,true);
  assert.equal(group(initial,"messages").room_count,2);assert.equal(group(initial,"direct").room_count,1);assert.equal(group(initial,"agents").room_count,1);assert.equal(group(initial,"groups").room_count,1);
  const order=["messages",...initial.order.slice(1).reverse()];
  const saved=await f.patch("/message-groups",{order,hidden_ids:["direct"],shortcut_ids:["messages","direct","unread"]});
  assert.deepEqual(saved.order,order);assert.equal(group(saved,"direct").visible,false);assert.ok(saved.shortcut_ids.includes("direct"));
  await assert.rejects(f.call(f.human,"/message-groups","PATCH",{base_revision:1,hidden_ids:[]}),{code:"conflict"});
  assert.deepEqual((await f.call(f.agent)).order,initial.order);f.restart();assert.deepEqual(await f.call(f.human),saved);
  const stable=fs.readFileSync(f.file,"utf8");
  for(const input of [{hidden_ids:["messages"]},{order:initial.order.slice(1)},{order:[...initial.order,"unread"]},{shortcut_ids:[]},{shortcut_ids:["direct"]},{shortcut_ids:["messages","unknown"]},{owner_id:f.agent.principal.id}]){
    await assert.rejects(f.patch("/message-groups",input));assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  }
});

test("labels create idempotently, rename, reorder and delete only personal references without resurrecting deleted intents",async()=>{
  const f=await fixture(),created=await f.create("My label",{client_id:"__proto__"}),id=created.created_group_id;
  assert.equal(created.duplicate,false);assert.equal((await f.create("My label",{client_id:"__proto__"})).created_group_id,id);
  await assert.rejects(f.create("Different",{client_id:"__proto__"}),{code:"idempotency_conflict"});
  await assert.rejects(f.create("my LABEL"),{code:"group_name_exists"});
  await f.patch(`/rooms/${f.room.id}/message-groups`,{group_ids:[id]});
  await f.patch(`/message-groups/${id}`,{name:"Renamed"});
  const current=await f.call(f.human);await f.patch("/message-groups",{order:["messages",id,...current.order.filter(value=>!["messages",id].includes(value))],shortcut_ids:["messages",id]});
  const other=await f.create("Other label",{},f.agent);await f.patch(`/rooms/${f.room.id}/message-groups`,{group_ids:[other.created_group_id]},f.agent);
  const deleted=await f.call(f.human,`/message-groups/${id}`,"DELETE",{base_revision:(await f.call(f.human)).revision});
  assert.equal(deleted.deleted_group_id,id);assert.ok(!deleted.order.includes(id));assert.ok(!deleted.shortcut_ids.includes(id));
  assert.deepEqual((await f.call(f.human,`/rooms/${f.room.id}`)).room.message_grouping.group_ids,[]);
  assert.deepEqual((await f.call(f.agent,`/rooms/${f.room.id}`)).room.message_grouping.group_ids,[other.created_group_id]);
  assert.equal((await f.call(f.human,"/rooms")).rooms.length,2);
  await assert.rejects(f.create("My label",{client_id:"__proto__"}),{code:"group_deleted"});
  f.restart();await assert.rejects(f.call(f.human,`/message-groups/${id}`),{code:"not_found"});
});

test("manual multi-label assignment and simple automatic name rules are explicit, live and atomic over multiple room IDs",async()=>{
  const f=await fixture(),first=await f.create("Alpha rule",{name_contains:"ALPHA"}),a=first.created_group_id;
  const second=await f.create("Manual"),b=second.created_group_id;
  assert.deepEqual(group(await f.call(f.human),a).room_ids,[f.room.id]);
  const assigned=await f.patch(`/rooms/${f.room.id}/message-groups`,{group_ids:[b]});
  assert.deepEqual(assigned.room_grouping.manual_group_ids,[b]);assert.deepEqual(assigned.room_grouping.matched_group_ids,[a]);assert.deepEqual(new Set(assigned.room_grouping.group_ids),new Set([a,b]));
  const multi=await f.patch(`/message-groups/${b}`,{add_room_ids:[f.room.id,f.direct.id]});assert.equal(group(multi,b).room_count,2);
  const {room:foreign}=await f.call(f.outside,"/rooms","POST",{name:"Project Alpha foreign"});
  const before=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.patch(`/message-groups/${b}`,{name:"Must not rename",remove_room_ids:[f.room.id],add_room_ids:[foreign.id]}),{code:"not_a_member"});assert.equal(fs.readFileSync(f.file,"utf8"),before);
  await assert.rejects(f.patch(`/message-groups/${b}`,{add_room_ids:[f.room.id],remove_room_ids:[f.room.id]}),{code:"invalid_message_groups"});
  const withoutRule=await f.patch(`/message-groups/${a}`,{name_contains:null});assert.equal(group(withoutRule,a).room_count,0);
  await assert.rejects(f.patch(`/rooms/${f.room.id}/message-groups`,{group_ids:["messages"]}),{code:"invalid_message_groups"});
  await assert.rejects(f.patch(`/message-groups/${a}`,{name_contains:""}),{code:"invalid_input"});
});

test("marked and completed are personal conversation states, while unread mentions direct/group and mute use real current records",async()=>{
  const f=await fixture();const sent=await f.call(f.agent,`/rooms/${f.room.id}/messages`,"POST",{client_id:"mention",content:"需要你查看",mentions:[f.human.principal.id]});
  await f.call(f.human,`/rooms/${f.room.id}/tasks`,"POST",{title:"Still open"});
  const snapshot=await f.patch(`/rooms/${f.room.id}/message-groups`,{marked:true,completed:true});
  for(const id of ["unread","mentions","marked","completed"])assert.deepEqual(group(snapshot,id).room_ids,[f.room.id]);
  const detail=await f.call(f.human,`/rooms/${f.room.id}`);assert.equal(detail.tasks[0].status,"open");assert.equal(detail.room.is_favorite,false);
  assert.equal(group(await f.call(f.agent),"completed").room_count,0);
  await f.call(f.human,`/rooms/${f.room.id}/preferences`,"PATCH",{read_seq:sent.message.seq,muted:true});
  const read=await f.call(f.human);assert.equal(group(read,"unread").room_count,0);assert.equal(group(read,"mentions").room_count,1);assert.equal(group(read,"muted").room_count,1);
  await f.call(f.agent,`/rooms/${f.room.id}/messages/${sent.message.id}`,"DELETE",{base_revision:1});assert.equal(group(await f.call(f.human),"mentions").room_count,0);
});

test("removed room references stay private, human and Agent events/receipts honor current identity and enterprise policies",async()=>{
  const f=await fixture(),created=await f.create("Private",{},f.agent),id=created.created_group_id;
  const assigned=await f.patch(`/rooms/${f.room.id}/message-groups`,{group_ids:[id]},f.agent);
  const operation={method:"GET",pathname:"/api/im/message-groups",input:{},receipt:assigned};
  await f.im.authorizeStoredOperation(operation,f.agent.token);await assert.rejects(f.im.authorizeStoredOperation(operation,f.human.token),{code:"personal_group_scope"});
  assert.equal((await f.call(f.human,"/events")).events.some(event=>event.type==="message_groups.updated"),false);
  assert.ok((await f.call(f.agent,"/events")).events.some(event=>event.type==="message_groups.updated"));
  await f.call(f.human,`/rooms/${f.room.id}/members/${f.agent.principal.id}`,"DELETE");
  assert.deepEqual(group(await f.call(f.agent),id).room_ids,[]);await assert.rejects(f.im.authorizeStoredOperation(operation,f.agent.token),{code:"not_a_member"});
  await assert.rejects(f.patch(`/rooms/${f.room.id}/message-groups`,{group_ids:[]},f.agent),{code:"not_a_member"});
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  await assert.rejects(f.call(f.agent),{code:"app_policy_denied"});await assert.rejects(f.im.authorizeStoredOperation(operation,f.agent.token),{code:"app_policy_denied"});
});

test("same MCP/A2A group tools operate for humans and Agents; A2A read receipts are revoked with room access",async()=>{
  const f=await fixture(),mcp=(who,name,args={})=>nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  for(const who of [f.human,f.agent]){
    const result=await mcp(who,"im_create_message_group",{base_revision:1,client_id:"mcp",name:"Personal"});assert.equal(result.result.isError,false);
    const created=JSON.parse(result.result.content[0].text),id=created.created_group_id;
    const assigned=await mcp(who,"im_set_room_message_groups",{room_id:f.room.id,base_revision:2,group_ids:[id]});assert.equal(assigned.result.isError,false);
    assert.equal(JSON.parse((await mcp(who,"im_message_groups")).result.content[0].text).groups.find(g=>g.id===id).room_count,1);
  }
  const gateway=createNativeA2A({file:path.join(directory,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const response=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"groups",role:"user",parts:[{kind:"data",data:{operation:"im_message_groups",arguments:{}}}]}}},f.agent.token);
  assert.equal(response.result.status.state,"completed");
  await f.call(f.human,`/rooms/${f.room.id}/members/${f.agent.principal.id}`,"DELETE");
  const denied=await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:response.result.id}},f.agent.token);assert.equal(denied.error.data.code,"not_a_member");
});

test("label persistence failure fail-stops, then restart recovers the exact prior configuration without a partial multi-room change",async()=>{
  const f=await fixture(),created=await f.create("Stable"),id=created.created_group_id,before=await f.call(f.human),original=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("Fixture persistence failure");return original(source,target);};
  try{await assert.rejects(f.patch(`/message-groups/${id}`,{name:"Failed",add_room_ids:[f.room.id,f.direct.id]}),{code:"storage_failed"});}finally{fs.renameSync=original;}
  await assert.rejects(f.call(f.human),{code:"storage_failed"});f.restart();assert.deepEqual(await f.call(f.human),before);
});

test("layout v2 migrates old cross-section labels without writes, preserving builtin/child intent, visibility and shortcuts",async()=>{
  const f=await fixture(),a=(await f.create("First")).created_group_id,b=(await f.create("Second")).created_group_id;
  const state=JSON.parse(fs.readFileSync(f.file,"utf8")),saved=state.message_groups[f.human.principal.id];
  const legacy=["messages",b,"unread","marked","mentions","direct",a,"groups","completed","muted","agents"];
  saved.order=legacy;saved.hidden_ids=["muted",a];saved.shortcut_ids=["messages",b,"agents"];delete saved.layout_version;delete saved.message_display_rules;
  fs.writeFileSync(f.file,JSON.stringify(state));f.restart();const before=fs.readFileSync(f.file,"utf8"),snapshot=await f.call(f.human);
  assert.equal(snapshot.layout_version,2);assert.equal(snapshot.revision,saved.revision);assert.equal(snapshot.updated_at,saved.updated_at);
  assert.deepEqual(snapshot.order,["messages","unread","marked","mentions","labels",b,a,"direct","groups","documents","topics","completed","muted","agents"]);
  assert.deepEqual(snapshot.hidden_ids,saved.hidden_ids);assert.deepEqual(snapshot.shortcut_ids,saved.shortcut_ids);assert.deepEqual(snapshot.message_display_rules,{});
  assert.equal(group(snapshot,a).parent_id,"labels");assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const committed=await f.patch("/message-groups",{hidden_ids:["labels","documents"],shortcut_ids:["messages","labels"]});
  assert.equal(committed.revision,saved.revision+1);f.restart();assert.deepEqual(await f.call(f.human),committed);
  const changed=["messages",a,"topics","labels","direct",b,...committed.order.filter(id=>!["messages",a,"topics","labels","direct",b].includes(id))];
  const canonical=await f.patch("/message-groups",{order:changed});
  assert.deepEqual(canonical.order.slice(0,6),["messages","topics","labels",a,b,"direct"]);
});

test("labels container is a real union without double counting and all twenty children fit layout and visibility limits",async()=>{
  const f=await fixture(),a=(await f.create("Automatic",{name_contains:"Alpha"})).created_group_id,b=(await f.create("Manual")).created_group_id;
  await f.patch(`/message-groups/${b}`,{add_room_ids:[f.room.id,f.direct.id]});
  await f.call(f.agent,`/rooms/${f.room.id}/messages`,"POST",{client_id:"unread",content:"One unread"});
  const snapshot=await f.call(f.human);assert.equal(group(snapshot,"labels").room_count,2);assert.equal(group(snapshot,"labels").unread_count,1);
  assert.equal(group(await f.call(f.agent),"labels").room_count,0);
  for(let index=2;index<20;index++)await f.create(`Label ${index}`);
  const all=await f.call(f.human),saved=await f.patch("/message-groups",{order:all.order,hidden_ids:all.order.slice(1),shortcut_ids:["messages","labels",a,b]});
  assert.equal(saved.order.length,32);assert.equal(saved.hidden_ids.length,31);
  await assert.rejects(f.create("Too many"),{code:"limit_reached"});
});

test("documents group uses actual shared docs, denies disabled document access and revokes cached MCP/A2A receipts",async()=>{
  const f=await fixture({documents:true});
  await f.call(f.human,`/rooms/${f.direct.id}/messages`,"POST",{client_id:"link-text",content:"A text mentioning document or https://example.test/doc is not a shared document"});
  assert.equal(group(await f.call(f.human),"documents").room_count,0);
  await f.call(f.human,`/rooms/${f.room.id}/documents`,"POST",{title:"Shared",content:"Readable collaboration"});
  for(const who of [f.human,f.agent]){
    const response=await nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"im_message_groups",arguments:{}}},who.token);
    const snapshot=JSON.parse(response.result.content[0].text);assert.deepEqual(group(snapshot,"documents").room_ids,[f.room.id]);assert.equal(group(snapshot,"documents").available,true);
  }
  assert.equal(group(await f.call(f.outside),"documents").room_count,0);
  const gateway=createNativeA2A({file:path.join(directory,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const cached=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"doc-groups",role:"user",parts:[{kind:"data",data:{operation:"im_message_groups",arguments:{}}}]}}},f.agent.token);
  assert.equal(cached.result.status.state,"completed");
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/docs","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  const denied=group(await f.call(f.agent),"documents");assert.equal(denied.available,false);assert.deepEqual(denied.room_ids,[]);assert.equal(denied.unread_count,0);
  const replay=await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:cached.result.id}},f.agent.token);assert.equal(replay.error.data.code,"app_policy_denied");
  assert.equal(group(await f.call(f.human),"documents").room_count,1);
});

test("message display rules filter only messages, use explicit label precedence and strictest overlap, and isolate identity",async()=>{
  const f=await fixture(),a=(await f.create("Alpha",{name_contains:"Alpha"})).created_group_id,b=(await f.create("Other")).created_group_id;
  let snapshot=await f.patch("/message-groups",{message_display_rules:{groups:"never"}});
  assert.deepEqual(group(snapshot,"messages").room_ids,[f.direct.id]);assert.equal(group(snapshot,"groups").room_count,1);assert.equal(group(snapshot,a).room_count,1);
  assert.equal(group(await f.call(f.agent),"messages").room_count,2);
  snapshot=await f.patch("/message-groups",{message_display_rules:{groups:"never",[a]:"always"}});assert.equal(group(snapshot,"messages").room_count,2);
  await f.patch(`/rooms/${f.room.id}/message-groups`,{group_ids:[b]});
  snapshot=await f.patch("/message-groups",{message_display_rules:{groups:"always",[a]:"always",[b]:"never"}});assert.deepEqual(group(snapshot,"messages").room_ids,[f.direct.id]);
  const stale=snapshot.revision;
  snapshot=await f.call(f.human,`/message-groups/${b}`,"DELETE",{base_revision:stale});assert.equal(group(snapshot,"messages").room_count,2);assert.equal(snapshot.message_display_rules[b],undefined);
  await assert.rejects(f.call(f.human,"/message-groups","PATCH",{base_revision:stale,message_display_rules:{}}),{code:"conflict"});
  const stable=fs.readFileSync(f.file,"utf8");
  for(const rules of [null,[],"always",{messages:"never"},{groups:"sometimes"},{unknown:"never"}]){
    await assert.rejects(f.patch("/message-groups",{message_display_rules:rules}),{code:"invalid_message_groups"});assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  }
  snapshot=await f.patch("/message-groups",{message_display_rules:{groups:"unread"}});assert.deepEqual(group(snapshot,"messages").room_ids,[f.direct.id]);
  const sent=await f.call(f.agent,`/rooms/${f.room.id}/messages`,"POST",{client_id:"new",content:"Unread"});assert.equal(group(await f.call(f.human),"messages").room_count,2);
  await f.call(f.human,`/rooms/${f.room.id}/preferences`,"PATCH",{read_seq:sent.message.seq});assert.equal(group(await f.call(f.human),"messages").room_count,1);
  snapshot=await f.patch("/message-groups",{message_display_rules:{}});f.restart();assert.deepEqual(await f.call(f.human),snapshot);
});

test("important means valid unread mentions or actionable private urgency, never ordinary unread or stale urgency",async()=>{
  const f=await fixture(),base=`/rooms/${f.room.id}`;
  const send=async(content,extra={})=>(await f.call(f.agent,base+"/messages","POST",{client_id:crypto.randomUUID(),content,...extra})).message;
  await f.patch("/message-groups",{message_display_rules:{groups:"important"}});
  const plain=await send("ordinary");assert.equal(group(await f.call(f.human),"messages").room_count,1);
  const all=await send("all",{mention_all:true});assert.equal(group(await f.call(f.human),"messages").room_count,2);
  await f.call(f.human,base+"/preferences","PATCH",{mute_all_mentions:true});assert.equal(group(await f.call(f.human),"messages").room_count,1);
  const explicit=await send("explicit",{mentions:[f.human.principal.id]});assert.equal(group(await f.call(f.human),"groups").important_count,1);
  await f.call(f.human,base+"/preferences","PATCH",{read_seq:explicit.seq});assert.equal(group(await f.call(f.human),"messages").room_count,1);
  const urgency=await f.call(f.agent,base+`/messages/${plain.id}/urgencies`,"POST",{client_id:"urgent",base_revision:1,channel:"in_app",recipient_ids:[f.human.principal.id]});
  assert.equal(group(await f.call(f.human),"messages").room_count,2);assert.equal(group(await f.call(f.human),"groups").important_count,1);
  assert.equal(group(await f.call(f.agent),"groups").important_count,0);
  await f.call(f.human,base+`/urgencies/${urgency.urgency.id}/ack`,"POST",{});assert.equal(group(await f.call(f.human),"messages").room_count,1);
  await f.call(f.agent,base+`/messages/${all.id}/urgencies`,"POST",{client_id:"second",base_revision:1,channel:"in_app",recipient_ids:[f.human.principal.id]});
  await f.call(f.human,base+`/messages/${all.id}/preferences`,"PATCH",{hidden:true});assert.equal(group(await f.call(f.human),"messages").room_count,1);
  await f.call(f.human,base+`/messages/${all.id}/preferences`,"PATCH",{hidden:false});assert.equal(group(await f.call(f.human),"messages").room_count,2);
  await f.call(f.agent,base+`/messages/${all.id}`,"PATCH",{base_revision:1,content:"Changed source"});assert.equal(group(await f.call(f.human),"messages").room_count,1);
});

test("Human and Agent use display rules through the same MCP and A2A operations",async()=>{
  const f=await fixture();
  for(const who of [f.human,f.agent]){
    const response=await nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"im_configure_message_groups",arguments:{base_revision:1,message_display_rules:{groups:"never"},shortcut_ids:["messages","labels","documents","topics","agents"]}}},who.token);
    assert.equal(response.result.isError,false);assert.equal(group(JSON.parse(response.result.content[0].text),"messages").room_count,1);
  }
  const gateway=createNativeA2A({file:path.join(directory,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const response=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"rules",role:"user",parts:[{kind:"data",data:{operation:"im_configure_message_groups",arguments:{base_revision:2,message_display_rules:{}}}}]}}},f.agent.token);
  assert.equal(response.result.status.state,"completed");assert.equal(group(await f.call(f.agent),"messages").room_count,2);assert.equal(group(await f.call(f.human),"messages").room_count,1);
});
