"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im");
const {nativeMCP,callNativeTool,publicTools}=require("../native-im-mcp");
const {createNativeA2A}=require("../native-a2a");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-minutes-"));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function setup(){
  const file=path.join(temporary,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex"),documents=new Map();
  const options={file,adminToken:admin,workspace:{handle:async(method,route,input)=>{
    if(method==="POST"){
      const document={id:"document-"+crypto.randomUUID(),title:input.title,content:input.content,revision:1,content_hash:crypto.createHash("sha256").update(input.content).digest("hex")};
      documents.set(document.id,document);return {...document};
    }
    const document=documents.get(route.split("/").at(-1));assert.ok(document,"Fixture document must exist");return {...document};
  }}};
  let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://local/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const make=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await make("Human"),agent=await make("Agent","agent"),outside=await make("Outside");
  const {room}=await call(human,"/rooms","POST",{name:"Shared minutes"});
  await call(human,`/rooms/${room.id}/members`,"POST",{principal_id:agent.principal.id});
  await call(admin,"/admin/enterprise/bootstrap","POST",{principal_id:human.principal.id});
  const create=async(extra={},who=human,rid=room.id)=>(await call(who,`/rooms/${rid}/minutes`,"POST",{client_id:crypto.randomUUID(),title:"真实提供的逐字稿",...extra})).minute;
  const setPolicy=async(plugin,input)=>{const {app}=await call(human,`/enterprise/admin/apps/${plugin}`);return call(human,`/enterprise/admin/apps/${plugin}`,"PATCH",{base_revision:app.policy.revision,enabled:true,...input});};
  const mcp=(who,name,args={})=>nativeMCP(im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  return {file,admin,human,agent,outside,room,call,create,setPolicy,mcp,get im(){return im;},restart:()=>im=createNativeIM(options)};
}
const segment=(text="本段由成员手动提供",offset_ms=0,extra={})=>({text,offset_ms,...extra});

test("shared minutes give humans and Agents the same create/revise rights, durable idempotency and revision conflicts",async()=>{
  const f=await setup(),input={client_id:"stable",title:"Review",transcript:[segment("Agreed",0,{speaker_id:f.agent.principal.id,speaker_label:"Spoofed name"})]};
  const first=await f.create(input,f.agent);
  assert.equal(first.created_by,f.agent.principal.id);assert.equal(first.transcript[0].speaker_label,"Agent");
  assert.equal(first.transcription.status,"provider_not_configured");assert.equal(first.summary.status,"not_generated");
  const reordered={transcript:[{speaker_label:"Spoofed name",speaker_id:f.agent.principal.id,offset_ms:0,text:"Agreed"}],title:"Review",client_id:"stable"};
  const retry=await f.call(f.agent,`/rooms/${f.room.id}/minutes`,"POST",reordered);
  assert.equal(retry.duplicate,true);assert.equal(retry.minute.id,first.id);
  await assert.rejects(f.create({...input,title:"Different"},f.agent),{code:"idempotency_conflict"});
  const edited=(await f.call(f.human,`/minutes/${first.id}`,"PATCH",{base_revision:1,title:"Human revised",transcript:[...first.transcript,segment("Next",2000)]})).minute;
  assert.equal(edited.revision,2);assert.equal(edited.updated_by,f.human.principal.id);assert.equal(edited.transcript[0].id,first.transcript[0].id);
  await assert.rejects(f.call(f.agent,`/minutes/${first.id}`,"PATCH",{base_revision:1,title:"Overwrite"}),{status:409,code:"conflict"});
  const query=await f.call(f.agent,"/minutes?q=Next");assert.equal(query.minutes.length,1);assert.equal(query.minutes[0].transcript_count,2);assert.equal(query.minutes[0].transcript,undefined);
  assert.equal((await f.call(f.outside,"/minutes?q=Next")).minutes.length,0);
  await assert.rejects(f.call(f.outside,`/minutes/${first.id}`),{code:"not_a_member"});
  await assert.rejects(f.call(f.outside,`/rooms/${f.room.id}/minutes`),{code:"not_a_member"});
  f.restart();assert.deepEqual((await f.call(f.agent,`/minutes/${first.id}`)).minute,edited);
  assert.equal((await f.create(input,f.agent)).revision,2);
  const events=(await f.call(f.agent,"/events")).events.filter(e=>e.type.startsWith("minute."));
  assert.deepEqual(events.map(e=>e.type),["minute.created","minute.updated"]);
  assert.equal(events.at(-1).minute_id,first.id);assert.equal(events.at(-1).revision,2);
});

test("transcript bounds, verified member labels and cross-record IDs reject atomically",async()=>{
  const f=await setup(),first=await f.create({transcript:[segment()]}),other=await f.create({transcript:[segment()]});
  const before=fs.readFileSync(f.file,"utf8");
  const invalid=[null,"text",[null],[segment("text",-1)],[segment("text",86400001)],[segment("text",0.5)],
    [segment("late",2),segment("early",1)],[segment("")],[segment("x".repeat(4001))],Array.from({length:201},()=>segment()),
    Array.from({length:26},()=>segment("x".repeat(4000))),[segment("No spoof",0,{speaker_id:f.outside.principal.id})],
    [segment("Invalid",0,{speaker_id:42})],[segment("Invalid",0,{actor_id:f.agent.principal.id})],
    [{...other.transcript[0]}],[first.transcript[0],first.transcript[0]]];
  for(const transcript of invalid){
    await assert.rejects(f.call(f.agent,`/minutes/${first.id}`,"PATCH",{base_revision:1,title:"Must not persist",transcript}));
    assert.equal(fs.readFileSync(f.file,"utf8"),before);
  }
  await assert.rejects(f.call(f.agent,`/minutes/${first.id}`,"PATCH",{base_revision:1,created_by:f.human.principal.id}),{code:"invalid_minutes"});
  const supplied=[segment("Original")];const changed=(await f.call(f.agent,`/minutes/${first.id}`,"PATCH",{base_revision:1,transcript:supplied})).minute;
  supplied[0].text="Input alias";changed.transcript[0].text="Output alias";
  assert.equal((await f.call(f.human,`/minutes/${first.id}`)).minute.transcript[0].text,"Original");
});

test("real room documents/tasks/meetings and existing audio associate without pretending to transcribe or summarize",async()=>{
  const f=await setup(),{room:other}=await f.call(f.human,"/rooms","POST",{name:"Other room"});
  const resources=async(room)=>{
    const {document}=await f.call(f.human,`/rooms/${room.id}/documents`,"POST",{title:"Manual notes",content:"Manually provided transcript"});
    const {task}=await f.call(f.human,`/rooms/${room.id}/tasks`,"POST",{title:"Actual follow-up"});
    const {meeting}=await f.call(f.human,`/rooms/${room.id}/meetings`,"POST",{title:"Actual scheduled meeting",client_id:crypto.randomUUID(),document_id:document.id});
    const {attachment}=await f.call(f.human,`/rooms/${room.id}/attachments`,"POST",{client_id:crypto.randomUUID(),filename:"fixture.wav",mime_type:"audio/wav",data_base64:Buffer.from("Manual test attachment; no codec claim").toString("base64")});
    return {document_id:document.id,task_ids:[task.id],meeting_id:meeting.id,audio_attachment_id:attachment.id};
  };
  const local=await resources(f.room),foreign=await resources(other),first=await f.create({...local,transcript:[segment()]},f.agent);
  assert.equal(first.audio_attachment.mime_type,"application/octet-stream");assert.equal(first.audio_attachment.filename,"fixture.wav");
  assert.equal(first.audio_attachment.data_base64,undefined);assert.match(first.audio_attachment.download_path,/\/content$/);
  assert.equal(first.transcript_source,"manual_or_imported");assert.deepEqual(first.summary,{status:"not_generated"});
  for(const [key,value] of Object.entries(foreign))await assert.rejects(f.call(f.agent,`/minutes/${first.id}`,"PATCH",{base_revision:1,[key]:value}),{status:403});
  await assert.rejects(f.call(f.agent,`/minutes/${first.id}`,"PATCH",{base_revision:1,task_ids:[local.task_ids[0],local.task_ids[0]]}),{code:"invalid_minutes"});
  const {attachment}=await f.call(f.human,`/rooms/${f.room.id}/attachments`,"POST",{client_id:"not-audio",filename:"notes.txt",mime_type:"text/plain",data_base64:Buffer.from("Not audio").toString("base64")});
  await assert.rejects(f.create({audio_attachment_id:attachment.id}),{code:"invalid_audio_attachment"});
  const receipt={minute:first};const operation={method:"GET",pathname:`/api/im/minutes/${first.id}`,input:{},receipt};
  await f.im.authorizeStoredOperation(operation,f.agent.token);
  await f.call(f.human,`/rooms/${f.room.id}/attachments/${local.audio_attachment_id}`,"DELETE");
  assert.equal((await f.call(f.agent,`/minutes/${first.id}`)).minute.audio_attachment_id,null);
  await assert.rejects(f.im.authorizeStoredOperation(operation,f.agent.token),{code:"attachment_deleted"});
});

test("minutes policy revokes fresh reads, mutations and events; removal and identity revocation deny access",async()=>{
  const f=await setup(),first=await f.create();
  await f.setPolicy("minutes",{denied_principal_ids:[f.agent.principal.id]});
  for(const route of ["/minutes",`/minutes/${first.id}`,`/rooms/${f.room.id}/minutes`])await assert.rejects(f.call(f.agent,route),{code:"app_policy_denied",plugin_id:"minutes"});
  await assert.rejects(f.create({},f.agent),{code:"app_policy_denied"});
  assert.equal((await f.call(f.agent,"/events")).events.some(e=>e.type.startsWith("minute.")),false);
  assert.equal((await f.call(f.human,"/minutes")).minutes.length,1);
  await f.setPolicy("minutes",{denied_principal_ids:[]});
  await f.call(f.human,`/rooms/${f.room.id}/members/${f.agent.principal.id}`,"DELETE");
  await assert.rejects(f.call(f.agent,`/minutes/${first.id}`),{code:"not_a_member"});
  assert.equal((await f.call(f.agent,"/minutes")).minutes.length,0);
  await f.call(f.human,`/rooms/${f.room.id}/members`,"POST",{principal_id:f.agent.principal.id});
  await f.call(f.admin,"/admin/revoke","POST",{principal_id:f.agent.principal.id});
  await assert.rejects(f.call(f.agent,`/minutes/${first.id}`),{code:"unauthorized"});
});

test("linked application revocation hides fresh associations and fences previously authorized receipts",async()=>{
  const f=await setup();
  const {document}=await f.call(f.human,`/rooms/${f.room.id}/documents`,"POST",{title:"Notes",content:"Manual"});
  const {task}=await f.call(f.human,`/rooms/${f.room.id}/tasks`,"POST",{title:"Follow up"});
  const {meeting}=await f.call(f.human,`/rooms/${f.room.id}/meetings`,"POST",{client_id:"meeting",title:"Review"});
  const first=await f.create({document_id:document.id,task_ids:[task.id],meeting_id:meeting.id});
  const operation={method:"GET",pathname:`/api/im/minutes/${first.id}`,input:{},receipt:{minute:first}};
  for(const [plugin,key,hidden] of [["docs","document_id",null],["tasks","task_ids",[]],["meetings","meeting_id",null]]){
    await f.setPolicy(plugin,{denied_principal_ids:[f.agent.principal.id]});
    const fresh=(await f.call(f.agent,`/minutes/${first.id}`)).minute;assert.deepEqual(fresh[key],hidden);
    await assert.rejects(f.im.authorizeStoredOperation(operation,f.agent.token),{code:"app_policy_denied",plugin_id:plugin});
    await assert.rejects(f.call(f.agent,`/minutes/${first.id}`,"PATCH",{base_revision:1,[key]:first[key]}),{code:"app_policy_denied",plugin_id:plugin});
    await f.setPolicy(plugin,{denied_principal_ids:[]});
  }
});

test("MCP accepts structured transcript segments equally and A2A cached receipts recheck current scope",async()=>{
  const f=await setup(),parse=response=>JSON.parse(response.result.content[0].text);
  for(const who of [f.human,f.agent]){
    const created=await f.mcp(who,"office_create_minute",{room_id:f.room.id,client_id:"mcp",title:"MCP supplied",transcript:[segment("Exact supplied text",0,{speaker_id:who.principal.id})]});
    assert.equal(created.result.isError,false);const first=parse(created).minute;
    assert.equal(first.created_by,who.principal.id);assert.equal(first.transcript[0].text,"Exact supplied text");
    assert.equal((await f.mcp(who,"office_update_minute",{minute_id:first.id,base_revision:1,transcript:[segment("Revised")] })).result.isError,false);
    assert.equal(parse(await f.mcp(who,"office_read_minute",{minute_id:first.id})).minute.revision,2);
    assert.equal((await f.mcp(who,"office_create_minute",{room_id:f.room.id,client_id:"bad",title:"Invalid",transcript:["plain string"]})).result.isError,true);
  }
  const minute=await f.create();
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const request={jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"read-minute",role:"user",parts:[{kind:"data",data:{operation:"office_read_minute",arguments:{minute_id:minute.id}}}]}}};
  const first=await gateway.handle(request,f.agent.token);assert.equal(first.result.status.state,"completed");
  assert.equal(first.result.artifacts[0].parts[0].data.result.minute.id,minute.id);
  await f.setPolicy("minutes",{denied_principal_ids:[f.agent.principal.id]});
  const denied=await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:first.result.id}},f.agent.token);
  assert.equal(denied.error.data.code,"app_policy_denied");
  assert.ok((await gateway.handle(request,f.agent.token)).error);
});

test("failed minute persistence fail-stops and recovers exactly the prior committed revision",async()=>{
  const f=await setup(),first=await f.create({transcript:[segment("Durable")]});
  const original=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("Fixture persistence failure");return original(source,target);};
  try{await assert.rejects(f.call(f.agent,`/minutes/${first.id}`,"PATCH",{base_revision:1,transcript:[segment("Failed mutation")]}),{code:"storage_failed"});}
  finally{fs.renameSync=original;}
  await assert.rejects(f.call(f.human,`/minutes/${first.id}`),{code:"storage_failed"});
  f.restart();assert.deepEqual((await f.call(f.human,`/minutes/${first.id}`)).minute,first);
});
