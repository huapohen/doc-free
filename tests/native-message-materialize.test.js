"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP}=require("../native-im-mcp");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-message-materialize-"));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture({beforeDocument,failAfterDocument=false}={}){
  const file=path.join(temporary,crypto.randomUUID(),"im.json"),admin=crypto.randomBytes(32).toString("hex"),docs=new Map();let creates=0;
  const options={file,adminToken:admin,workspace:{handle:async(method,route,input,actor)=>{
    if(method==="POST"){
      creates++;await beforeDocument?.();
      const document={id:crypto.randomUUID().slice(0,8),title:input.title,content:input.content,revision:1,content_hash:crypto.createHash("sha256").update(input.content).digest("hex"),updated_by:actor};
      docs.set(document.id,document);
      if(failAfterDocument)throw Error("Canonical response lost after actual create");
      return {...document};
    }
    if(method==="GET")return {...docs.get(route.split("/").at(-1))};
    throw Error("Unexpected document operation");
  }}};
  let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await enroll("Human"),peer=await enroll("Peer"),agent=await enroll("Agent","agent"),outside=await enroll("Outside");
  const {room}=await call(human,"/rooms","POST",{name:"Source conversion fixture"}),base="/rooms/"+room.id;
  for(const who of [peer,agent])await call(human,base+"/members","POST",{principal_id:who.principal.id});
  const send=async(who,content,extra={})=>(await call(who,base+"/messages","POST",{client_id:crypto.randomUUID(),content,...extra})).message;
  const request=(messages,extra={})=>({client_id:crypto.randomUUID(),message_ids:messages.map(message=>message.id),base_revisions:Object.fromEntries(messages.map(message=>[message.id,message.revision])),title:"Message-derived work",...extra});
  return {file,admin,human,peer,agent,outside,room,base,call,send,request,docs,restart:()=>im=createNativeIM(options),get creates(){return creates;},get im(){return im;}};
}

test("Human and Agent atomically create source tasks with exact snapshots, stable retry IDs and no chat broadcast",async()=>{
  const f=await fixture(),a=await f.send(f.human,"First source"),b=await f.send(f.peer,"Second source");
  for(const who of [f.human,f.agent]){
    const input=f.request([a,b],{description:"Supplement only",assignee_id:f.agent.principal.id});
    const created=await f.call(who,f.base+"/messages/create-task","POST",input);
    assert.equal(created.duplicate,false);assert.deepEqual(created.task.source_message_ids,[a.id,b.id]);assert.deepEqual(created.task.source_message_revisions,input.base_revisions);
    for(const text of [a.content,b.content,a.id,b.id,a.at,"Supplement only"])assert.ok(created.task.description.includes(text));
    assert.equal(created.task.created_by,who.principal.id);
    f.restart();const retry=await f.call(who,f.base+"/messages/create-task","POST",input);assert.equal(retry.duplicate,true);assert.equal(retry.task.id,created.task.id);
    await assert.rejects(f.call(who,f.base+"/messages/create-task","POST",{...input,title:"Changed intent"}),{code:"idempotency_conflict"});
  }
  const detail=await f.call(f.human,f.base);assert.equal(detail.messages.length,2);assert.equal(detail.tasks.length,2);
  const events=await f.call(f.agent,"/events?after=0");assert.equal(events.events.filter(event=>event.type==="message.created").length,2);assert.equal(events.events.filter(event=>event.type==="task.created"&&event.task.source_message_ids?.length===2).length,2);
});

test("source validation rejects stale/retracted/hidden/protected/nonmember/wrong-room requests without creating tasks or documents",async()=>{
  const f=await fixture(),a=await f.send(f.human,"Mutable source"),b=await f.send(f.peer,"Visible source");
  const commands=["create-task","export-document"];
  for(const operation of commands){
    const send=(who,input)=>f.call(who,f.base+"/messages/"+operation,"POST",input),valid=f.request([a,b]);
    for(const invalid of [{...valid,message_ids:[]},{...valid,message_ids:[a.id,a.id]},{...valid,base_revisions:{[a.id]:1}},{...valid,base_revisions:{...valid.base_revisions,extra:1}},{...valid,base_revisions:{[a.id]:"1",[b.id]:1}},{...valid,principal_id:f.agent.principal.id}])await assert.rejects(send(f.agent,invalid),{status:422});
    await assert.rejects(send(f.outside,valid),{code:"not_a_member"});
    await assert.rejects(send(f.agent,{...valid,message_ids:["msg-00000000-0000-0000-0000-000000000000"],base_revisions:{"msg-00000000-0000-0000-0000-000000000000":1}}),{code:"not_found"});
    await f.call(f.agent,f.base+"/messages/"+a.id+"/preferences","PATCH",{hidden:true});await assert.rejects(send(f.agent,valid),{code:"message_hidden"});await f.call(f.agent,f.base+"/messages/"+a.id+"/preferences","PATCH",{hidden:false});
    await f.call(f.human,f.base+"/messages/"+a.id+"/forwarding","PATCH",{base_revision:a.revision,no_forward:true});a.revision++;
    await assert.rejects(send(f.agent,valid),{code:"forwarding_disabled"});await f.call(f.human,f.base+"/messages/"+a.id+"/forwarding","PATCH",{base_revision:a.revision,no_forward:false});a.revision++;
    await assert.rejects(send(f.agent,valid),{code:"conflict"});
  }
  await f.call(f.human,f.base+"/messages/"+a.id,"DELETE",{base_revision:a.revision});
  for(const operation of commands)await assert.rejects(f.call(f.agent,f.base+"/messages/"+operation,"POST",f.request([a,b])),{code:"message_retracted"});
  assert.equal((await f.call(f.human,f.base)).tasks.length,0);assert.equal(f.creates,0);assert.equal((await f.call(f.human,f.base)).room.document_count,0);
});

test("source document command copies exact server content once and records durable provenance shared with the room",async()=>{
  const f=await fixture(),source=await f.send(f.peer,"Original text\n```\n# Nested heading");
  const input=f.request([source],{content:"My additional explanation"});
  const result=await f.call(f.agent,f.base+"/messages/export-document","POST",input);
  assert.equal(result.duplicate,false);assert.equal(result.document.updated_by,f.agent.principal.id);assert.ok(result.document.content.includes(source.content));assert.ok(result.document.content.includes("My additional explanation"));assert.ok(result.document.content.includes(source.id));assert.deepEqual(result.document.source_message_ids,[source.id]);
  assert.equal(result.document.content.includes("````text"),true,"source code fences cannot escape their generated provenance container");
  f.restart();const duplicate=await f.call(f.agent,f.base+"/messages/export-document","POST",input);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.document.id,result.document.id);assert.equal(f.creates,1);
  const view=await f.call(f.human,f.base+"/documents/"+result.document.id);assert.deepEqual(view.document.source_message_ids,[source.id]);
  const stored=JSON.parse(fs.readFileSync(f.file)),room=stored.rooms[0];assert.deepEqual(room.document_sources[result.document.id].source_message_ids,[source.id]);assert.equal(room.messages.length,1);assert.equal(room.document_ids.length,1);
});

test("source document creation and a concurrent edit linearize under the IM lock with no GET-to-POST race",async()=>{
  let started,release;const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await fixture({beforeDocument:async()=>{started();await gate;}}),source=await f.send(f.human,"Snapshot before edit");
  const creating=f.call(f.agent,f.base+"/messages/export-document","POST",f.request([source]));await entered;
  const editing=f.call(f.human,f.base+"/messages/"+source.id,"PATCH",{base_revision:1,content:"Changed after linearization"});release();
  const [result,edited]=await Promise.all([creating,editing]);assert.ok(result.document.content.includes(source.content));assert.equal(result.document.content.includes("Changed after linearization"),false);assert.equal(edited.message.revision,2);
  await assert.rejects(f.call(f.agent,f.base+"/messages/export-document","POST",f.request([source])),{code:"conflict"});assert.equal(f.creates,1);
});

test("lost canonical document response remains durable pending and never creates another document on retry",async()=>{
  const f=await fixture({failAfterDocument:true}),source=await f.send(f.human,"Pending source"),input=f.request([source]);
  await assert.rejects(f.call(f.agent,f.base+"/messages/export-document","POST",input),{code:"outcome_pending"});assert.equal(f.docs.size,1);assert.equal(f.creates,1);
  f.restart();await assert.rejects(f.call(f.agent,f.base+"/messages/export-document","POST",input),{code:"outcome_pending"});assert.equal(f.creates,1);
  const pending=Object.values(JSON.parse(fs.readFileSync(f.file)).message_materializations)[0];assert.equal(pending.status,"pending");assert.deepEqual(pending.source_message_ids,[source.id]);
  const status=await f.call(f.agent,f.base+"/messages/source-operations?"+new URLSearchParams({client_id:input.client_id,operation:"export-document"}));assert.equal(status.operations[0].status,"pending");assert.equal("hash" in status.operations[0],false);assert.equal(JSON.stringify(status).includes(source.content),false);
  assert.equal((await f.call(f.human,f.base+"/messages/source-operations")).operations.length,0);
  await assert.rejects(f.call(f.agent,f.base+"/messages/source-operations?principal_id="+f.human.principal.id),{status:422});
});

test("source commands require destination app policy as well as IM and expose the same MCP action to both principal kinds",async()=>{
  const f=await fixture(),source=await f.send(f.human,"Policy source");
  for(const who of [f.human,f.agent]){
    const response=await nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"im_messages_create_task",arguments:{room_id:f.room.id,...f.request([source])}}},who.token);assert.equal(response.result.isError,false);
  }
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  for(const [app,operation] of [["docs","export-document"],["tasks","create-task"]]){
    await f.call(f.human,"/enterprise/admin/apps/"+app,"PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
    await assert.rejects(f.call(f.agent,f.base+"/messages/"+operation,"POST",f.request([source])),{code:"app_policy_denied"});
  }
  assert.equal(f.creates,0);assert.equal((await f.call(f.human,f.base)).tasks.length,2);
});

test("merged-message task and document export include nested shared text, authors, revisions and target attachment paths",async()=>{
  const f=await fixture();
  const attachment=(await f.call(f.peer,f.base+"/attachments","POST",{client_id:"bundle-materialize-file",filename:"shared.txt",data_base64:Buffer.from("Shared file bytes").toString("base64")})).attachment;
  const original=await f.send(f.peer,"Original shared text\n```\n# Quoted heading",{attachment_ids:[attachment.id]});
  const unselected=await f.send(f.peer,"Unselected private source text");
  const target=(await f.call(f.outside,"/rooms","POST",{name:"Received shared record"})).room;
  for(const who of [f.human,f.agent])await f.call(f.outside,`/rooms/${target.id}/members`,"POST",{principal_id:who.principal.id});
  const first=(await f.call(f.human,f.base+"/messages/forward-bundle","POST",{client_id:"first-materialize-copy",message_ids:[original.id],base_revisions:{[original.id]:1},target_room_ids:[target.id],comment:"First bundle comment"})).deliveries[0].message;
  const nested=(await f.call(f.outside,`/rooms/${target.id}/messages/${first.id}/forward`,"POST",{client_id:"nested-materialize-copy",target_room_id:target.id,base_revision:1})).message;
  await f.call(f.peer,f.base+"/messages/"+original.id,"PATCH",{base_revision:1,content:"Later source version must not replace shared copy"});
  await assert.rejects(f.call(f.outside,f.base),{code:"not_a_member"});
  const shared=(await f.call(f.outside,`/rooms/${target.id}/messages/${nested.id}/forward-bundle`)).bundle.items[0].forward_bundle.items[0];
  for(const who of [f.outside,f.agent])for(const operation of ["create-task","export-document"]){
    const result=await f.call(who,`/rooms/${target.id}/messages/${operation}`,"POST",f.request([nested]));
    const content=operation==="create-task"?result.task.description:result.document.content;
    for(const value of [original.content,original.id,original.at,f.peer.principal.id,"Peer","First bundle comment",first.id,nested.id,shared.attachments[0].download_path,'"source_revision": 1',"shared_copy"])assert.ok(content.includes(value),`missing source material ${value}`);
    for(const absent of [unselected.content,unselected.id,"Later source version must not replace shared copy",attachment.download_path])assert.equal(content.includes(absent),false);
    assert.equal(content.includes("````text"),true,"nested source fences are escaped too");
  }
  const room=await f.call(f.outside,`/rooms/${target.id}`);assert.equal(room.messages.length,2);assert.equal(room.tasks.length,2);assert.equal(room.room.document_count,2);
});

test("merged-message materialization rejects expanded content limits before creating empty or truncated work",async()=>{
  const f=await fixture(),sources=[];
  for(let index=0;index<20;index++)sources.push(await f.send(f.human,`Source ${index}: `+"x".repeat(11000)));
  const target=(await f.call(f.outside,"/rooms","POST",{name:"Oversize shared record"})).room;
  await f.call(f.outside,`/rooms/${target.id}/members`,"POST",{principal_id:f.human.principal.id});
  const card=(await f.call(f.human,f.base+"/messages/forward-bundle","POST",{client_id:"large-materialize-copy",message_ids:sources.map(message=>message.id),base_revisions:Object.fromEntries(sources.map(message=>[message.id,1])),target_room_ids:[target.id]})).deliveries[0].message;
  const before=fs.readFileSync(f.file,"utf8");
  for(const operation of ["create-task","export-document"]){
    await assert.rejects(f.call(f.outside,`/rooms/${target.id}/messages/${operation}`,"POST",f.request([card])),{code:"source_content_too_large"});
    assert.equal(fs.readFileSync(f.file,"utf8"),before);
  }
  assert.equal(f.creates,0);assert.equal((await f.call(f.outside,`/rooms/${target.id}`)).tasks.length,0);
});
