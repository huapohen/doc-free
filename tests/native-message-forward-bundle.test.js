"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP,publicTools,callNativeTool}=require("../native-im-mcp"),{createNativeA2A}=require("../native-a2a");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-forward-bundle-"));after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
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
test("Human and Agent atomically share actual selected snapshots as one immutable typed card per target",async()=>{
  const f=await fixture(),first=await f.send(f.human,"First selected"),privateMessage=await f.send(f.peer,"Unselected must not leak"),last=await f.send(f.agent,"Last selected");
  await f.call(f.human,`/rooms/${f.source.id}/messages/${first.id}/preferences`,"PATCH",{marked:true});
  const result=await f.merge(f.human,[last,first],[f.second,f.target],{comment:"Review selected context",mentions:[f.outside.principal.id]});
  assert.equal(result.duplicate,false);assert.equal(result.bundle.message_count,2);assert.equal(result.deliveries.length,2);
  for(const delivery of result.deliveries){
    const room=delivery.room_id===f.target.id?f.target:f.second,message=delivery.message;
    assert.equal(message.kind,"forward_bundle");assert.equal(message.content,"Review selected context");assert.deepEqual(message.mentions,[f.outside.principal.id]);assert.equal(message.forward_bundle.message_count,2);
    assert.equal(message.forward_bundle.detail_path,`/api/im/rooms/${room.id}/messages/${message.id}/forward-bundle`);
    assert.equal((await f.call(f.outside,`/rooms/${room.id}`)).messages.length,1,"one real card, not N ordinary messages");
    const expanded=await f.read(f.outside,room,message);assert.equal(expanded.bundle.snapshot_policy,"shared_copy");
    assert.deepEqual(expanded.bundle.items.map(item=>item.source_message_id),[first.id,last.id]);
    assert.deepEqual(expanded.bundle.items.map(item=>item.author.kind),["human","agent"]);
    assert.equal(JSON.stringify(expanded).includes(privateMessage.id),false);assert.equal(JSON.stringify(expanded).includes("personal_preferences"),false);assert.equal("deliveries" in expanded.bundle,false);
  }
  await assert.rejects(f.call(f.outside,`/rooms/${f.source.id}`),{code:"not_a_member"});
  const agentShare=await f.merge(f.agent,[first],[f.target],{client_id:"agent-batch"});assert.equal(agentShare.bundle.created_by,f.agent.principal.id);
  assert.equal((await f.call(f.human,`/rooms/${f.source.id}/messages/${first.id}/readers`)).receipt_summary.read_count,0);
  f.restart();assert.equal((await f.read(f.outside,f.target,result.deliveries.find(item=>item.room_id===f.target.id).message)).bundle.items[0].content,"First selected");
});
test("all source/target/mention checks reject the whole batch before any event, message or attachment write",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Whole batch validation"),deniedTarget=await f.create(f.outside,"Not joined target");
  const before=fs.readFileSync(f.file,"utf8");
  for(const extra of [{target_room_ids:[f.target.id,deniedTarget.id]},{message_ids:[message.id,message.id]},{base_revisions:{}},{base_revisions:{[message.id]:9}},{mentions:[f.peer.principal.id]},{comment:42},{snapshot:{content:"forged"}}]){
    await assert.rejects(f.call(f.human,`/rooms/${f.source.id}/messages/forward-bundle`,"POST",{...f.args([message]),...extra}));
    assert.equal(fs.readFileSync(f.file,"utf8"),before);
  }
  await f.call(f.human,`/rooms/${f.source.id}/messages/${message.id}/preferences`,"PATCH",{hidden:true});
  await assert.rejects(f.merge(f.human,[message]),{code:"message_hidden"});
  await f.call(f.human,`/rooms/${f.source.id}/messages/${message.id}/preferences`,"PATCH",{hidden:false});
  await f.call(f.human,`/rooms/${f.source.id}/messages/${message.id}`,"DELETE",{base_revision:1});
  await assert.rejects(f.merge(f.human,[message]),{code:"message_retracted"});
  await assert.rejects(f.send(f.human,"Forged card",{kind:"forward_bundle",forward_bundle:{id:"bundle-forged"}}),{code:"invalid_input"});
});
test("batch client_id is stable across target order and source edits recover through scoped read-only receipts",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Version one"),args=f.args([message],[f.target,f.second],{client_id:"stable-batch"});
  const first=await f.call(f.human,`/rooms/${f.source.id}/messages/forward-bundle`,"POST",args),stable=fs.readFileSync(f.file,"utf8");
  const repeat=await f.call(f.human,`/rooms/${f.source.id}/messages/forward-bundle`,"POST",{...args,target_room_ids:[...args.target_room_ids].reverse()});
  assert.equal(repeat.duplicate,true);assert.deepEqual(repeat.deliveries.map(value=>value.message.id),first.deliveries.map(value=>value.message.id));assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  await assert.rejects(f.merge(f.human,[message],[f.target],{client_id:"stable-batch"}),{code:"idempotency_conflict"});
  await f.call(f.human,`/rooms/${f.source.id}/messages/${message.id}`,"PATCH",{base_revision:1,content:"Version two"});
  await assert.rejects(f.call(f.human,`/rooms/${f.source.id}/messages/forward-bundle`,"POST",args),{code:"conflict"});
  const receiptPath=`/rooms/${f.source.id}/messages/forward-bundle-receipts?client_id=stable-batch`;
  assert.equal((await f.call(f.human,receiptPath)).receipts[0].bundle.id,first.bundle.id);
  assert.deepEqual((await f.call(f.agent,receiptPath)).receipts,[]);
  for(const delivery of first.deliveries){const expanded=await f.read(f.outside,{id:delivery.room_id},delivery.message);assert.equal(expanded.bundle.items[0].content,"Version one");assert.equal(expanded.bundle.items[0].source_revision,1);}
  await f.call(f.human,`/rooms/${f.source.id}/messages/${message.id}`,"DELETE",{base_revision:2});
  assert.equal((await f.call(f.human,receiptPath)).receipts[0].bundle.id,first.bundle.id,"historical receipt survives source retraction without resending");
});
test("target attachments are real independent download resources and quota failure leaves every target untouched",async()=>{
  const f=await fixture(),attachment=(await f.call(f.human,`/rooms/${f.source.id}/attachments`,"POST",{client_id:"file",filename:"selected.txt",mime_type:"text/plain",data_base64:Buffer.from("Selected bytes").toString("base64")})).attachment;
  const message=await f.send(f.human,"Attachment selected",{attachment_ids:[attachment.id]});
  const result=await f.merge(f.human,[message],[f.target,f.second]);
  const copied=[];
  for(const delivery of result.deliveries){
    const item=(await f.read(f.outside,{id:delivery.room_id},delivery.message)).bundle.items[0].attachments[0];copied.push(item.id);
    assert.notEqual(item.id,attachment.id);assert.equal(item.room_id,delivery.room_id);assert.equal(item.availability,"active");
    const binary=await f.call(f.outside,item.download_path.replace("/api/im",""));assert.equal(binary._native_binary.content.toString(),"Selected bytes");
  }
  assert.equal(new Set(copied).size,2);
  const durable=JSON.parse(fs.readFileSync(f.file)),template=durable.attachments.find(item=>item.room_id===f.second.id);
  for(let i=1;i<200;i++)durable.attachments.push({...template,id:"attachment-"+crypto.randomUUID(),message_ids:[]});
  fs.writeFileSync(f.file,JSON.stringify(durable));f.restart();const unchanged=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.merge(f.human,[message],[f.target,f.second]),{code:"attachment_quota"});assert.equal(fs.readFileSync(f.file,"utf8"),unchanged);
});
test("ordinary im_forward_message preserves nested cards and later origin protection blocks all further copies, not existing readers",async()=>{
  const f=await fixture(),attachment=(await f.call(f.human,`/rooms/${f.source.id}/attachments`,"POST",{client_id:"nested-file",filename:"nested.txt",data_base64:Buffer.from("Nested bytes").toString("base64")})).attachment;
  const original=await f.send(f.human,"Nested original source",{attachment_ids:[attachment.id]});
  const card=(await f.merge(f.human,[original])).deliveries[0].message;
  const rpc=async(who,name,args)=>{const response=await nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);assert.equal(response.result.isError,false);return JSON.parse(response.result.content[0].text);};
  const nested=(await rpc(f.agent,"im_forward_message",{room_id:f.target.id,message_id:card.id,base_revision:1,target_room_id:f.second.id,client_id:"ordinary-nested"})).message;
  assert.equal(nested.kind,"forward_bundle");assert.equal(nested.content,"");
  const detail=await f.read(f.outside,f.second,nested),inner=detail.bundle.items[0];assert.equal(inner.kind,"forward_bundle");assert.equal(inner.forward_bundle.items[0].content,"Nested original source");
  const cloned=inner.forward_bundle.items[0].attachments[0];assert.equal(cloned.room_id,f.second.id);assert.equal((await f.call(f.outside,cloned.download_path.replace("/api/im","")))._native_binary.content.toString(),"Nested bytes");
  await f.protect(f.human,f.source,original,true);
  for(const [room,message] of [[f.target,card],[f.second,nested]]){
    assert.equal((await f.call(f.agent,`/rooms/${room.id}/messages/${message.id}`)).message.no_forward,true);
    await assert.rejects(f.merge(f.agent,[message],[f.source],{},room),{code:"forwarding_disabled"});
    await assert.rejects(f.send(f.agent,"Cannot reuse protected cloned file",{attachment_ids:message.attachment_ids},room),{code:"forwarding_disabled"});
  }
  assert.equal((await f.read(f.outside,f.second,nested)).bundle.items[0].forward_bundle.items[0].content,"Nested original source");
});
test("target source-card hiding/retraction and membership revocation fence direct, MCP and cached A2A snapshot reads",async()=>{
  const f=await fixture(),source=await f.send(f.human,"Shared snapshot scope"),card=(await f.merge(f.human,[source])).deliveries[0].message;
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-bundle-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const task=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"read-bundle",role:"user",parts:[{kind:"data",data:{operation:"im_read_forward_bundle",arguments:{room_id:f.target.id,message_id:card.id}}}]}}},f.outside.token);
  assert.equal(task.result?.status.state,"completed","target-only reader need not be a source member");
  const cardPath=`/rooms/${f.target.id}/messages/${card.id}`;
  await f.call(f.outside,cardPath+"/preferences","PATCH",{hidden:true});
  await assert.rejects(f.read(f.outside,f.target,card),{code:"message_hidden"});
  assert.equal((await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:task.result.id}},f.outside.token)).error?.data.code,"message_hidden");
  assert.equal("forward_bundle" in (await f.call(f.outside,cardPath)).message,false);
  await f.call(f.outside,cardPath+"/preferences","PATCH",{hidden:false});
  await f.call(f.human,cardPath,"DELETE",{base_revision:1});
  await assert.rejects(f.read(f.outside,f.target,card),{code:"message_retracted"});
  assert.equal("forward_bundle" in (await f.call(f.outside,`/rooms/${f.target.id}`)).messages[0],false);
  assert.equal((await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:task.result.id}},f.outside.token)).error?.data.code,"message_retracted");
  await f.call(f.human,`/rooms/${f.target.id}/members/${f.outside.principal.id}`,"DELETE");
  await assert.rejects(f.read(f.outside,f.target,card),{code:"not_a_member"});
});
test("multi-target persistence failure fails closed and restart has no partial cards or attachment copies",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Atomic persistent batch"),before=fs.readFileSync(f.file,"utf8");fs.mkdirSync(f.file+".tmp");
  await assert.rejects(f.merge(f.human,[message],[f.target,f.second]),{code:"storage_failed"});await assert.rejects(f.call(f.human,`/rooms/${f.target.id}`),{code:"storage_failed"});
  fs.rmdirSync(f.file+".tmp");assert.equal(fs.readFileSync(f.file,"utf8"),before);f.restart();
  assert.equal((await f.call(f.human,`/rooms/${f.target.id}`)).messages.length,0);assert.equal((await f.call(f.agent,`/rooms/${f.second.id}`)).messages.length,0);
});

test("nested depth and cardinality bounds reject atomically while Human and Agent use the same MCP batch and receipt",async()=>{
  const f=await fixture(),original=await f.send(f.human,"Bounded shared snapshot");
  const rpc=async(who,name,args)=>{const response=await nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);assert.equal(response.result.isError,false);return JSON.parse(response.result.content[0].text);};
  const first=await rpc(f.agent,"im_forward_bundle",{room_id:f.source.id,...f.args([original],[f.target],{client_id:"native-bundle-contract"})});
  const card=first.deliveries[0].message;
  assert.equal((await rpc(f.outside,"im_read_forward_bundle",{room_id:f.target.id,message_id:card.id})).bundle.items[0].content,original.content);
  const receipt=await rpc(f.agent,"im_forward_bundle_receipts",{room_id:f.source.id,client_id:"native-bundle-contract"});
  assert.equal(receipt.receipts[0].bundle.id,first.bundle.id);
  assert.equal((await rpc(f.human,"im_forward_bundle_receipts",{room_id:f.source.id,client_id:"native-bundle-contract"})).receipts.length,0);
  const second=(await f.merge(f.agent,[card],[f.second],{},f.target)).deliveries[0].message;
  const third=(await f.merge(f.human,[second],[f.source],{},f.second)).deliveries[0].message;
  let before=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.merge(f.agent,[third]),{code:"bundle_too_deep"});assert.equal(fs.readFileSync(f.file,"utf8"),before);
  for(const extra of [{message_ids:Array.from({length:51},(_,index)=>`msg-${index}`)},{target_room_ids:Array.from({length:21},(_,index)=>`room-${index}`)}]){
    await assert.rejects(f.call(f.human,`/rooms/${f.source.id}/messages/forward-bundle`,"POST",{...f.args([original]),...extra}),{status:422});
    assert.equal(fs.readFileSync(f.file,"utf8"),before);
  }
  await f.call(f.human,`/rooms/${f.target.id}/members/${f.agent.principal.id}`,"DELETE");
  before=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.call(f.agent,`/rooms/${f.source.id}/messages/forward-bundle-receipts?client_id=native-bundle-contract`),{code:"not_a_member"});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
});
