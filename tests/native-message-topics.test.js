"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im");
const {nativeMCP,callNativeTool,publicTools}=require("../native-im-mcp");
const {createNativeA2A}=require("../native-a2a");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-message-topics-"));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(temporary,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex");
  const options={file,adminToken:admin,workspace:{handle:async()=>{throw Error("No document operation expected");}}};let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await enroll("Human"),agent=await enroll("Agent","agent"),outside=await enroll("Outside");
  const {room}=await call(human,"/rooms","POST",{name:"Explicit topics"}),base="/rooms/"+room.id;
  await call(human,base+"/members","POST",{principal_id:agent.principal.id});
  const send=async(who,content,extra={})=>(await call(who,base+"/messages","POST",{client_id:crypto.randomUUID(),content,...extra})).message;
  const create=(who,message,extra={})=>call(who,base+`/messages/${message.id}/topic`,"POST",{client_id:crypto.randomUUID(),base_revision:message.revision,...extra});
  const grouped=async who=>(await call(who,"/message-groups")).groups.find(group=>group.id==="topics");
  return {file,admin,human,agent,outside,room,base,call,send,create,grouped,get im(){return im;},restart:()=>im=createNativeIM(options)};
}

test("only explicit Human/Agent topic creation changes topics; ordinary replies, reads and execution roots do not",async()=>{
  const f=await fixture(),root=await f.send(f.human,"A source"),reply=await f.send(f.agent,"Ordinary reply",{reply_to:root.id});
  assert.equal((await f.grouped(f.human)).room_count,0);assert.equal((await f.call(f.human,f.base)).room.topic_count,0);
  await f.call(f.human,f.base+`/messages/${root.id}/thread`);assert.deepEqual((await f.call(f.human,f.base+"/topics")).topics,[]);
  const before=(await f.call(f.human,f.base)).room;
  const created=await f.create(f.agent,root,{client_id:"create"});
  assert.equal(created.duplicate,false);assert.equal(created.topic.protocol,"message-topic/v1");assert.equal(created.topic.created_by,f.agent.principal.id);
  assert.equal(created.topic.root_message_id,root.id);assert.equal(created.topic.room_id,f.room.id);assert.ok(created.topic.created_at);
  const after=(await f.call(f.human,f.base)).room;assert.equal(after.topic_count,1);assert.equal(after.message_count,before.message_count);assert.equal(after.read_seq,before.read_seq);
  for(const who of [f.human,f.agent])assert.deepEqual((await f.grouped(who)).room_ids,[f.room.id]);
  assert.equal((await f.grouped(f.outside)).room_count,0);
  const second=await f.create(f.human,reply);assert.equal(second.topic.root_message_id,reply.id);assert.equal((await f.call(f.human,f.base)).room.topic_count,2);
  const state=JSON.parse(fs.readFileSync(f.file,"utf8"));assert.equal(state.message_topics.length,2);assert.equal(state.message_topics[0].content,undefined);
  f.restart();assert.equal((await f.call(f.human,f.base+"/topics")).topics.length,2);
});

test("topic creation serializes root uniqueness, validates intent and versions, and replays without duplicates",async()=>{
  const f=await fixture(),root=await f.send(f.human,"One root");
  const pair=await Promise.all([f.create(f.human,root,{client_id:"human"}),f.create(f.agent,root,{client_id:"agent"})]);
  assert.equal(pair[0].topic.id,pair[1].topic.id);assert.deepEqual(pair.map(result=>result.duplicate),[false,true]);
  const retry=await f.create(f.human,root,{client_id:"human"});assert.equal(retry.topic.id,pair[0].topic.id);assert.equal(retry.duplicate,true);
  const other=await f.send(f.human,"Other root"),stable=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.create(f.human,other,{client_id:"human"}),{code:"idempotency_conflict"});
  await assert.rejects(f.create(f.human,other,{base_revision:9}),{code:"conflict"});
  await assert.rejects(f.create(f.human,other,{created_by:f.agent.principal.id}),{code:"invalid_topic"});
  await assert.rejects(f.create(f.outside,other),{code:"not_a_member"});assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  await f.call(f.human,f.base+`/messages/${root.id}`,"PATCH",{base_revision:1,content:"Updated current root"});
  const editedRetry=await f.create(f.human,root,{client_id:"human"});assert.equal(editedRetry.duplicate,true);assert.equal(editedRetry.root_message.content,"Updated current root");
  assert.equal((await f.call(f.human,"/events")).events.filter(event=>event.type==="message.topic.created").length,1);
});

test("topic visibility and old receipts follow personal hiding, root recall and current membership",async()=>{
  const f=await fixture(),root=await f.send(f.human,"Visible root"),created=await f.create(f.human,root),path=f.base+`/topics/${created.topic.id}`;
  const operation={method:"GET",pathname:"/api/im"+path,input:{},receipt:created};await f.im.authorizeStoredOperation(operation,f.agent.token);
  await f.call(f.agent,f.base+`/messages/${root.id}/preferences`,"PATCH",{hidden:true});
  assert.equal((await f.grouped(f.agent)).room_count,0);assert.equal((await f.call(f.agent,f.base)).room.topic_count,0);assert.equal((await f.call(f.agent,f.base+"/topics")).topics.length,0);
  assert.equal((await f.grouped(f.human)).room_count,1);assert.equal((await f.call(f.agent,"/events")).events.some(event=>event.type==="message.topic.created"),false);
  await assert.rejects(f.call(f.agent,path),{code:"message_hidden"});await assert.rejects(f.create(f.agent,root),{code:"message_hidden"});await assert.rejects(f.im.authorizeStoredOperation(operation,f.agent.token),{code:"message_hidden"});
  await f.call(f.agent,f.base+`/messages/${root.id}/preferences`,"PATCH",{hidden:false});assert.equal((await f.call(f.agent,path)).topic.id,created.topic.id);
  await f.call(f.human,f.base+`/members/${f.agent.principal.id}`,"DELETE");
  assert.equal((await f.grouped(f.agent)).room_count,0);await assert.rejects(f.im.authorizeStoredOperation(operation,f.agent.token),{code:"not_a_member"});
  await f.call(f.human,f.base+`/messages/${root.id}`,"DELETE",{base_revision:1});
  assert.equal((await f.grouped(f.human)).room_count,0);await assert.rejects(f.call(f.human,path),{code:"message_retracted"});await assert.rejects(f.create(f.human,root),{code:"message_retracted"});
});

test("explicit topic list paginates with stable cursors and cannot read a different room through a topic ID",async()=>{
  const f=await fixture(),created=[];
  for(let i=0;i<3;i++)created.push(await f.create(f.human,await f.send(f.human,`Root ${i}`)));
  const first=await f.call(f.agent,f.base+"/topics?limit=2");assert.equal(first.topics.length,2);assert.equal(first.has_more,true);
  const second=await f.call(f.agent,f.base+`/topics?limit=2&before=${first.next_before}`);assert.equal(second.topics.length,1);assert.equal(second.has_more,false);assert.equal(second.topics[0].id,created[0].topic.id);
  for(const query of ["limit=0","limit=201","before=-1","q=text"])await assert.rejects(f.call(f.human,f.base+"/topics?"+query),{code:"invalid_topic"});
  const {room}=await f.call(f.human,"/rooms","POST",{name:"Different room"});
  await assert.rejects(f.call(f.human,`/rooms/${room.id}/topics/${created[0].topic.id}`),{code:"not_found"});
});

test("Human/Agent MCP and A2A create and read the same explicit topics and revoke cached content after hiding or app denial",async()=>{
  const f=await fixture(),root=await f.send(f.human,"Protocol root");
  const mcp=(who,name,args)=>nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  for(const who of [f.human,f.agent]){
    const response=await mcp(who,"im_create_topic",{room_id:f.room.id,message_id:root.id,client_id:"protocol",base_revision:1});assert.equal(response.result.isError,false);
    const list=await mcp(who,"im_topics",{room_id:f.room.id});assert.equal(JSON.parse(list.result.content[0].text).topics.length,1);
  }
  const topic=(await f.call(f.human,f.base+"/topics")).topics[0];
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const request={jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"read-topic",role:"user",parts:[{kind:"data",data:{operation:"im_topic",arguments:{room_id:f.room.id,topic_id:topic.id}}}]}}};
  const response=await gateway.handle(request,f.agent.token);assert.equal(response.result.status.state,"completed");
  await f.call(f.agent,f.base+`/messages/${root.id}/preferences`,"PATCH",{hidden:true});
  let denied=await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:response.result.id}},f.agent.token);assert.equal(denied.error.data.code,"message_hidden");
  await f.call(f.agent,f.base+`/messages/${root.id}/preferences`,"PATCH",{hidden:false});
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  denied=await gateway.handle({jsonrpc:"2.0",id:3,method:"tasks/get",params:{id:response.result.id}},f.agent.token);assert.equal(denied.error.data.code,"app_policy_denied");
  const humanRead=await mcp(f.human,"im_topic",{room_id:f.room.id,topic_id:topic.id});assert.equal(humanRead.result.isError,false);
});

test("topic persistence failure fail-stops without leaving a topic or creation receipt after restart",async()=>{
  const f=await fixture(),root=await f.send(f.human,"Persistent root"),before=fs.readFileSync(f.file,"utf8"),original=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===f.file)throw Error("Fixture topic persistence failure");return original(source,target);};
  try{await assert.rejects(f.create(f.agent,root,{client_id:"recover"}),{code:"storage_failed"});}finally{fs.renameSync=original;}
  assert.equal(fs.readFileSync(f.file,"utf8"),before);await assert.rejects(f.call(f.human,f.base+"/topics"),{code:"storage_failed"});
  f.restart();assert.equal((await f.call(f.human,f.base+"/topics")).topics.length,0);
  const recovered=await f.create(f.agent,root,{client_id:"recover"});assert.equal(recovered.duplicate,false);assert.equal((await f.call(f.human,f.base+"/topics")).topics.length,1);
});
