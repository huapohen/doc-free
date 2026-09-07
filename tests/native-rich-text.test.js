"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP,publicTools,callNativeTool}=require("../native-im-mcp"),{createNativeA2A}=require("../native-a2a");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-rich-text-"));after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(temporary,crypto.randomUUID(),"im.json"),admin=crypto.randomBytes(32).toString("hex"),options={file,adminToken:admin,workspace:{handle:async()=>{throw Error("Unexpected document request");}}};let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind}),human=await enroll("Human"),agent=await enroll("Agent","agent"),peer=await enroll("Peer"),outside=await enroll("Target only");
  const create=async(who,name,others=[])=>(await call(who,"/rooms","POST",{name})).room;
  const source=await create(human,"Bundle sources"),target=await create(human,"First target"),second=await create(agent,"Second target");
  for(const who of [agent,peer])await call(human,`/rooms/${source.id}/members`,"POST",{principal_id:who.principal.id});
  for(const who of [agent,outside])await call(human,`/rooms/${target.id}/members`,"POST",{principal_id:who.principal.id});
  for(const who of [human,outside])await call(agent,`/rooms/${second.id}/members`,"POST",{principal_id:who.principal.id});
  const send=async(who,content,extra={},room=source)=>(await call(who,`/rooms/${room.id}/messages`,"POST",{client_id:crypto.randomUUID(),content,...extra})).message;
  const args=(messages,targets=[target],extra={})=>({client_id:crypto.randomUUID(),message_ids:messages.map(message=>message.id),base_revisions:Object.fromEntries(messages.map(message=>[message.id,message.revision])),target_room_ids:targets.map(room=>room.id),...extra});
  const merge=(who,messages,targets=[target],extra={},room=source)=>call(who,`/rooms/${room.id}/messages/forward-bundle`,"POST",args(messages,targets,extra));
  const read=(who,room,message)=>call(who,`/rooms/${room.id}/messages/${message.id}/forward-bundle`);
  const protect=(who,room,message,no_forward)=>call(who,`/rooms/${room.id}/messages/${message.id}/forwarding`,"PATCH",{base_revision:message.revision,no_forward});
  return {file,admin,human,agent,peer,outside,source,target,second,call,create,send,args,merge,read,protect,restart:()=>im=createNativeIM(options),get im(){return im;}};
}

const {normalizeRichText}=require("../native-rich-text");
const rich=(start=0,end=4,styles=["bold"])=>({version:1,spans:[{start,end,styles}]});
test("rich text is bounded canonical UTF-16 metadata, never HTML or arbitrary markup",()=>{
  assert.equal(normalizeRichText(null,"plain"),undefined);
  assert.equal(normalizeRichText({version:1,spans:[]},"plain"),undefined);
  assert.deepEqual(normalizeRichText({version:1,spans:[{start:2,end:4,styles:["underline","bold"]},{start:0,end:2,styles:["italic"]}]},"😀ab"),
    {version:1,spans:[{start:0,end:2,styles:["italic"]},{start:2,end:4,styles:["bold","underline"]}]});
  for(const value of [rich(0,1),rich(1,2),rich(-1,2),rich(0,99),rich(0,2,["html"]),{...rich(0,2),html:"unsafe"},{version:1,spans:Array(201).fill(rich(0,2).spans[0])}])
    assert.throws(()=>normalizeRichText(value,"😀ab"),{code:"invalid_rich_text"});
});
test("Human and Agent styled sends preserve plain content, canonical identity and immutable forwards",async()=>{
  const f=await fixture(),text="人机同权 abc",format=rich(0,4,["bold","underline"]);
  for(const who of [f.human,f.agent]){
    const message=await f.send(who,text,{rich_text:format});assert.deepEqual(message.rich_text,format);assert.equal(message.content,text);
    assert.equal((await f.call(who,`/rooms/${f.source.id}`)).native_features.message_rich_text,true);
    const forward=(await f.call(who,`/rooms/${f.source.id}/messages/${message.id}/forward`,"POST",{target_room_id:f.target.id,client_id:crypto.randomUUID(),base_revision:1})).message;
    assert.deepEqual(forward.rich_text,format);
    const card=(await f.merge(who,[message])).deliveries[0].message;
    assert.deepEqual((await f.read(f.outside,f.target,card)).bundle.items[0].rich_text,format);
    await f.call(who,`/rooms/${f.source.id}/messages/${message.id}`,"PATCH",{content:"changed",base_revision:1});
    assert.equal((await f.call(who,`/rooms/${f.source.id}/messages/${message.id}`)).message.rich_text,undefined);
    assert.deepEqual((await f.read(f.outside,f.target,card)).bundle.items[0].rich_text,format);
  }
  f.restart();assert.ok((await f.call(f.agent,`/rooms/${f.target.id}`)).messages.some(m=>m.rich_text));
});
test("invalid styled sends or edits do not write and formatting is part of idempotent intent",async()=>{
  const f=await fixture(),payload={client_id:"styled-intent",content:"ABCD",rich_text:rich()};
  const first=(await f.call(f.human,`/rooms/${f.source.id}/messages`,"POST",payload)).message;
  assert.equal((await f.call(f.human,`/rooms/${f.source.id}/messages`,"POST",payload)).duplicate,true);
  let before=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.call(f.human,`/rooms/${f.source.id}/messages`,"POST",{...payload,rich_text:rich(0,4,["italic"])}),{code:"idempotency_conflict"});
  await assert.rejects(f.send(f.human,"😀ab",{rich_text:rich(0,1)}),{code:"invalid_rich_text"});
  await assert.rejects(f.call(f.human,`/rooms/${f.source.id}/messages/${first.id}`,"PATCH",{content:"edit",base_revision:1,rich_text:rich(0,99)}),{code:"invalid_rich_text"});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const preserved=(await f.call(f.human,`/rooms/${f.source.id}/messages/${first.id}`,"PATCH",{content:"ABCD",base_revision:1})).message;
  assert.deepEqual(preserved.rich_text,rich());
  const cleared=(await f.call(f.human,`/rooms/${f.source.id}/messages/${first.id}`,"PATCH",{content:"ABCD",base_revision:2,rich_text:null})).message;
  assert.equal(cleared.rich_text,undefined);
  const restyled=(await f.call(f.human,`/rooms/${f.source.id}/messages/${first.id}`,"PATCH",{content:"EFGH",base_revision:3,rich_text:rich(0,2,["italic"])})).message;
  assert.deepEqual(restyled.rich_text,rich(0,2,["italic"]));
  await f.call(f.human,`/rooms/${f.source.id}/messages/${first.id}`,"DELETE",{base_revision:4});
  assert.equal((await f.call(f.agent,`/rooms/${f.source.id}/messages/${first.id}`)).message.rich_text,undefined);
});
test("native MCP and A2A carry the same validated Human and Agent style contract",async()=>{
  const f=await fixture();
  const rpc=await nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"im_send",arguments:{room_id:f.source.id,client_id:"mcp-rich",content:"native",rich_text:rich(0,6)}}},f.agent.token);
  assert.equal(rpc.result.isError,false);const message=JSON.parse(rpc.result.content[0].text).message;assert.deepEqual(message.rich_text,rich(0,6));
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-rich-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const task=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"styled-send",role:"user",parts:[{kind:"data",data:{operation:"im_send",arguments:{room_id:f.source.id,client_id:"a2a-rich",content:"native",rich_text:rich(0,6,["italic"])}}}]}}},f.human.token);
  assert.equal(task.result?.status.state,"completed");
  const messages=(await f.call(f.human,`/rooms/${f.source.id}`)).messages;
  assert.deepEqual(messages.at(-1).rich_text,rich(0,6,["italic"]));
  await f.call(f.human,`/rooms/${f.source.id}/messages/${message.id}/preferences`,"PATCH",{hidden:true});
  assert.equal((await f.call(f.human,`/rooms/${f.source.id}/messages/${message.id}`)).message.rich_text,undefined);
});

test("Agent turn completion validates and durably preserves styled output without bypassing result idempotency",async()=>{
  const f=await fixture();await f.send(f.human,"Please prepare a styled native reply");
  const claim=await f.call(f.agent,`/rooms/${f.source.id}/turns/claim`,"POST",{instructions:"Synthetic style contract check",model:"fixture-model",reasoning_effort:"medium",lease_seconds:60});
  assert.ok(claim.turn);
  const route=`/rooms/${f.source.id}/turns/${claim.turn.id}/finish`,input={lease_token:claim.turn.lease_token,action:"reply",content:"😀 Agent answer",rich_text:rich(0,2,["bold","italic"]),rationale:"Synthetic result, no model call",model:"fixture-model",reasoning_effort:"medium"};
  const before=fs.readFileSync(f.file,"utf8");
  for(const invalid of [{...input,rich_text:rich(0,1)},{...input,action:"silent"}]){
    await assert.rejects(f.call(f.agent,route,"POST",invalid),{code:"invalid_rich_text"});
    assert.equal(fs.readFileSync(f.file,"utf8"),before);
  }
  const completed=await f.call(f.agent,route,"POST",input);
  assert.deepEqual(completed.message.rich_text,input.rich_text);assert.deepEqual(completed.turn.result.rich_text,input.rich_text);
  assert.equal(completed.message.turn_id,claim.turn.id);assert.equal(completed.message.author_id,f.agent.principal.id);
  f.restart();const retry=await f.call(f.agent,route,"POST",input);assert.equal(retry.duplicate,true);assert.equal(retry.message.id,completed.message.id);
  await assert.rejects(f.call(f.agent,route,"POST",{...input,rich_text:rich(0,2,["underline"])}),{code:"turn_finished"});
});

test("canonical span ordering survives retry and source work retains nested style provenance",async()=>{
  const f=await fixture(),format={version:1,spans:[{start:0,end:4,styles:["bold","italic"]},{start:4,end:6,styles:["underline"]}]};
  const input={client_id:"canonical-format",content:"ABCD😀",rich_text:format};
  const first=(await f.call(f.human,`/rooms/${f.source.id}/messages`,"POST",input)).message;
  const duplicate=await f.call(f.human,`/rooms/${f.source.id}/messages`,"POST",{...input,rich_text:{version:1,spans:[format.spans[1],{...format.spans[0],styles:["italic","bold","bold"]},format.spans[0]]}});
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.message.id,first.id);
  const card=(await f.merge(f.human,[first])).deliveries[0].message;
  const nested=(await f.merge(f.agent,[card],[f.second],{},f.target)).deliveries[0].message;
  const detail=await f.read(f.outside,f.second,nested);assert.deepEqual(detail.bundle.items[0].forward_bundle.items[0].rich_text,format);
  const sourceTask=await f.call(f.agent,`/rooms/${f.source.id}/messages/create-task`,"POST",{client_id:"styled-source-task",message_ids:[first.id],base_revisions:{[first.id]:1},title:"Styled source provenance"});
  const nestedTask=await f.call(f.outside,`/rooms/${f.second.id}/messages/create-task`,"POST",{client_id:"styled-nested-task",message_ids:[nested.id],base_revisions:{[nested.id]:1},title:"Nested styled provenance"});
  for(const task of [sourceTask.task,nestedTask.task])for(const expected of ['"rich_text"','"bold"','"italic"','"underline"',input.content])assert.ok(task.description.includes(expected));
  for(const name of ["im_send","im_edit_message"]){const schema=publicTools.find(tool=>tool.name===name).inputSchema.properties.rich_text;assert.equal(schema.properties.version.const,1);assert.deepEqual(schema.type,["object","null"]);}
});

test("frozen action-plan final results preserve styles through real execution and server-appended receipts",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Create a task with a styled explanation");
  const claim=await f.call(f.agent,`/rooms/${f.source.id}/turns/claim`,"POST",{instructions:"Synthetic plan",model:"fixture-model",reasoning_effort:"medium",lease_seconds:60});
  const route=`/rooms/${f.source.id}/turns/${claim.turn.id}`;
  const final={action:"reply",content:"😀 Plan processed",rich_text:rich(0,2,["bold","italic"]),rationale:"Use native task receipt",mentions:[],artifact:null};
  const body={lease_token:claim.turn.lease_token,context_hash:claim.context.context_hash,model:"fixture-model",reasoning_effort:"medium",summary:"One real task",final_result:final,
    steps:[{key:"task",operation:"im_create_task",arguments:{title:"Styled plan task",assignee_id:f.agent.principal.id},evidence:[{kind:"message",id:message.id,revision:1,quote:message.content}]}]};
  const before=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.call(f.agent,route+"/plan","POST",{...body,final_result:{...final,rich_text:rich(0,1)}}),{code:"invalid_rich_text"});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const planned=await f.call(f.agent,route+"/plan","POST",body);
  assert.deepEqual(planned.plan.final_result.rich_text,final.rich_text);
  f.restart();assert.equal((await f.call(f.agent,route+"/plan","POST",body)).duplicate,true);
  await f.call(f.agent,route+"/operations/"+planned.plan.steps[0].operation_id+"/execute","POST",{lease_token:claim.turn.lease_token,plan_hash:planned.plan.hash});
  const finished=await f.call(f.agent,route+"/finish","POST",{...planned.plan.final_result,lease_token:claim.turn.lease_token,model:"fixture-model",reasoning_effort:"medium"});
  assert.deepEqual(finished.message.rich_text,final.rich_text);assert.ok(finished.message.content.startsWith(final.content));assert.ok(finished.message.content.includes("[服务端动作回执]"));
});
