"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP,callNativeTool,publicTools}=require("../native-im-mcp"),{createNativeA2A}=require("../native-a2a");
const {parseWave,voiceConfiguration}=require("../native-voice"),{wave,chunk}=require("./voice-fixture");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-voice-"));after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(extra={}){
  const file=path.join(temporary,crypto.randomUUID(),"im.json"),admin=crypto.randomBytes(32).toString("hex"),docs=new Map();
  const options={file,adminToken:admin,...extra,workspace:{handle:async(method,route,input)=>{
    if(method==="POST"){const doc={id:crypto.randomUUID().slice(0,8),title:input.title,content:input.content,revision:1,content_hash:crypto.createHash("sha256").update(input.content).digest("hex")};docs.set(doc.id,doc);return {...doc};}
    if(method==="GET")return {...docs.get(route.split("/").at(-1))};throw Error("Unexpected document operation");
  }}};let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await enroll("Human"),agent=await enroll("Agent","agent"),outside=await enroll("Target only");
  const make=async(name)=>(await call(human,"/rooms","POST",{name})).room;
  const source=await make("Voice sources"),target=await make("Target"),second=await make("Nested target");
  for(const room of [source,target,second])await call(human,`/rooms/${room.id}/members`,"POST",{principal_id:agent.principal.id});
  for(const room of [target,second])await call(human,`/rooms/${room.id}/members`,"POST",{principal_id:outside.principal.id});
  const upload=async(bytes=wave().bytes,who=human,room=source,fields={})=>(await call(who,`/rooms/${room.id}/attachments`,"POST",{client_id:crypto.randomUUID(),filename:"recording.wav",mime_type:"audio/wav",data_base64:bytes.toString("base64"),...fields})).attachment;
  const send=async(attachment,who=human,room=source,fields={})=>call(who,`/rooms/${room.id}/messages`,"POST",{client_id:crypto.randomUUID(),voice:{attachment_id:attachment.id},...fields});
  const read=(who,room,message)=>call(who,`/rooms/${room.id}/messages/${message.id}`);
  const download=(who,room,attachmentId)=>call(who,`/rooms/${room.id}/attachments/${attachmentId}/content`);
  const forward=(message,from=source,to=target,who=human)=>call(who,`/rooms/${from.id}/messages/${message.id}/forward`,"POST",{client_id:crypto.randomUUID(),base_revision:message.revision,target_room_id:to.id});
  const merge=(messages,from=source,to=[target],who=human)=>call(who,`/rooms/${from.id}/messages/forward-bundle`,"POST",{client_id:crypto.randomUUID(),message_ids:messages.map(message=>message.id),base_revisions:Object.fromEntries(messages.map(message=>[message.id,message.revision])),target_room_ids:to.map(room=>room.id)});
  return {file,admin,human,agent,outside,source,target,second,call,make,upload,send,read,download,forward,merge,get im(){return im;},restart:(changed={})=>im=createNativeIM(Object.assign(options,changed))};
}

test("real PCM16 WAV parsing accepts whole RIFF chunks, padding and 16/18/extensible fmt with exact sample-derived duration",()=>{
  for(const sampleRate of [8000,16000,44100,48000])for(const format of [16,18,40]){
    const value=wave({sampleRate,frames:sampleRate,format,extraChunks:true}),parsed=parseWave(value.bytes);
    assert.equal(parsed.duration_ms,1000);assert.equal(parsed.sample_rate,sampleRate);assert.equal(parsed.frame_count,sampleRate);assert.equal(parsed.channels,1);assert.equal(parsed.codec,"pcm_s16le");
  }
  assert.equal(parseWave(wave({frames:1,sampleRate:48000}).bytes).duration_ms,1000/48000);
  assert.equal(parseWave(wave({frames:48000*60,sampleRate:48000}).bytes,{maxDurationMs:60000}).duration_ms,60000);
  assert.throws(()=>parseWave(wave({frames:48000*60+1,sampleRate:48000}).bytes,{maxDurationMs:60000}),{code:"voice_too_long"});
  const valid=wave().bytes;
  const mutate=(offset,value,bytes=2)=>{const result=Buffer.from(valid);result.writeUIntLE(value,offset,bytes);return result;};
  const bad=[Buffer.from("not a wav"),valid.subarray(0,43),Buffer.concat([valid,Buffer.alloc(1)]),mutate(20,3),mutate(22,2),mutate(24,7999,4),mutate(24,48001,4),mutate(28,1,4),mutate(32,4),mutate(34,8),mutate(40,1,4),wave({frames:0}).bytes];
  const duplicate=Buffer.concat([valid,chunk("fmt ",valid.subarray(20,36))]);duplicate.writeUInt32LE(duplicate.length-8,4);bad.push(duplicate);
  const doubleData=Buffer.concat([valid,chunk("data",Buffer.alloc(2))]);doubleData.writeUInt32LE(doubleData.length-8,4);bad.push(doubleData);
  const brokenExtension=wave({format:40}).bytes;brokenExtension[44]=3;bad.push(brokenExtension);
  for(const value of bad)assert.throws(()=>parseWave(value),{code:"invalid_voice_audio"});
  for(const max of [0,999,60001,1.5,NaN,"60000"])assert.throws(()=>voiceConfiguration(max));
});

test("upload derives audio from bytes, not names or MIME claims, and preserves long WAV as ordinary file",async()=>{
  const f=await fixture(),bytes=wave({sampleRate:44100,format:18,extraChunks:true}).bytes;
  const attachment=await f.upload(bytes,f.human,f.source,{filename:"not-audio.bin",mime_type:"application/octet-stream"});
  assert.equal(attachment.mime_type,"audio/wav");assert.equal(attachment.audio.sample_rate,44100);assert.equal(attachment.audio.frame_count,1600);
  assert.ok((await f.download(f.agent,f.source,attachment.id))._native_binary.content.equals(bytes));
  await assert.rejects(f.upload(Buffer.from("fake")),{code:"invalid_voice_audio"});
  const ordinary=(await f.call(f.human,`/rooms/${f.source.id}/messages`,"POST",{client_id:"file",attachment_ids:[attachment.id]})).message;assert.equal(ordinary.kind,undefined);assert.equal(ordinary.voice,undefined);
  const long=await f.upload(wave({frames:16000*61}).bytes);assert.equal(long.audio.duration_ms,61000);
  const before=fs.readFileSync(f.file,"utf8");await assert.rejects(f.send(long),{code:"voice_too_long"});assert.equal(fs.readFileSync(f.file,"utf8"),before);
});

test("Human and Agent send canonical voice with empty text, stable intent, real readback and current configuration",async()=>{
  const f=await fixture({voiceMaxDurationMs:1000}),attachment=await f.upload(wave({frames:16000}).bytes);
  for(const who of [f.human,f.agent]){
    const response=await f.send(attachment,who,f.source,{client_id:"voice-intent"}),message=response.message;
    assert.equal(message.kind,"voice");assert.equal(message.content,"");assert.deepEqual(message.attachment_ids,[attachment.id]);assert.equal(message.voice.duration_ms,1000);assert.equal(message.voice.sha256,attachment.sha256);assert.equal(message.voice.availability,"active");
    assert.equal((await f.send(attachment,who,f.source,{client_id:"voice-intent",attachment_ids:[attachment.id]})).duplicate,true);
    const detail=await f.read(who,f.source,message);assert.deepEqual(detail.message.voice,message.voice);
    const history=await f.call(who,`/rooms/${f.source.id}/messages`);assert.equal(history.messages.find(item=>item.id===message.id).kind,"voice");
    const config=(await f.call(who,"/capabilities")).voice_media;assert.equal(config.max_duration_ms,1000);assert.equal(config.sample_rate_max,48000);assert.equal(config.enabled,true);
  }
  const over=await f.upload(wave({frames:16001}).bytes);await assert.rejects(f.send(over),{code:"voice_too_long"});
  f.restart();assert.equal((await f.call(f.agent,`/rooms/${f.source.id}`)).messages[0].voice.duration_ms,1000);
});

test("voice input rejects forged metadata, wrong room, malformed audio and incompatible rich text before any message write",async()=>{
  const f=await fixture(),attachment=await f.upload(),foreign=await f.upload(wave().bytes,f.human,f.target);
  const badFile=await f.upload(Buffer.from("not audio"),f.human,f.source,{mime_type:"application/octet-stream",filename:"fake.wav"});
  const before=fs.readFileSync(f.file,"utf8");
  for(const fields of [{voice:{attachment_id:attachment.id,duration_ms:1}},{voice:null},{voice:{attachment_id:attachment.id,codec:"mp3"}},{kind:"voice"},{voice:{attachment_id:foreign.id}},{voice:{attachment_id:badFile.id}},{content:"caption",rich_text:{version:1,spans:[{start:0,end:1,styles:["bold"]}]}}])await assert.rejects(f.send(attachment,f.human,f.source,fields));
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  await assert.rejects(f.send(attachment,f.outside),{code:"not_a_member"});
});

test("voice captions can edit but media identity cannot change; hidden and recalled tombstones remove playable metadata",async()=>{
  const f=await fixture(),attachment=await f.upload(),message=(await f.send(attachment)).message,base=`/rooms/${f.source.id}/messages/${message.id}`;
  for(const extra of [{voice:{attachment_id:attachment.id}},{kind:"text"},{attachment_ids:[]},{rich_text:{version:1,spans:[{start:0,end:1,styles:["bold"]}]}}])await assert.rejects(f.call(f.human,base,"PATCH",{base_revision:1,content:"caption",...extra}));
  const edited=(await f.call(f.human,base,"PATCH",{base_revision:1,content:"Caption"})).message;assert.equal(edited.voice.sha256,message.voice.sha256);assert.equal(edited.kind,"voice");
  await f.call(f.agent,base+"/preferences","PATCH",{hidden:true});assert.equal((await f.read(f.agent,f.source,message)).message.voice,undefined);
  await assert.rejects(f.download(f.agent,f.source,attachment.id),{code:"message_hidden"});
  assert.ok((await f.download(f.human,f.source,attachment.id))._native_binary.content.length>44);
  await f.call(f.human,base,"DELETE",{base_revision:2});
  for(const who of [f.human,f.agent]){const read=await f.read(who,f.source,message);assert.equal(read.message.voice,undefined);assert.deepEqual(read.message.attachments,[]);}
  const room=await f.call(f.human,`/rooms/${f.source.id}`);assert.equal(room.messages[0].voice,undefined);assert.deepEqual(room.messages[0].attachments,[]);
  await assert.rejects(f.download(f.human,f.source,attachment.id),{code:"attachment_recalled"});
});

test("ordinary forwarding remaps voice to target resource and survives source deletion and recall",async()=>{
  const f=await fixture(),attachment=await f.upload(),source=(await f.send(attachment)).message,target=(await f.forward(source)).message;
  assert.equal(target.kind,"voice");assert.notEqual(target.voice.attachment_id,source.voice.attachment_id);assert.equal(target.voice.attachment_id,target.attachments[0].id);assert.equal(target.attachments[0].room_id,f.target.id);assert.equal(target.attachments[0].audio.duration_ms,100);
  await f.call(f.human,`/rooms/${f.source.id}/messages/${source.id}`,"DELETE",{base_revision:1});
  await f.call(f.human,`/rooms/${f.source.id}/attachments/${attachment.id}`,"DELETE");
  assert.ok((await f.download(f.outside,f.target,target.voice.attachment_id))._native_binary.content.equals(wave().bytes));
  const nested=(await f.forward(target,f.target,f.second,f.agent)).message;assert.notEqual(nested.voice.attachment_id,target.voice.attachment_id);assert.ok((await f.download(f.outside,f.second,nested.voice.attachment_id))._native_binary.content.equals(wave().bytes));
});

test("merged and nested forwarding rewrite each voice ID with actual target copies and source protection remains effective",async()=>{
  const f=await fixture(),source=(await f.send(await f.upload())).message;
  const result=await f.merge([source],f.source,[f.target,f.second]);
  for(const delivery of result.deliveries){
    const detail=await f.call(f.outside,`/rooms/${delivery.room_id}/messages/${delivery.message.id}/forward-bundle`),item=detail.bundle.items[0];
    assert.equal(item.kind,"voice");assert.equal(item.voice.attachment_id,item.attachments[0].id);assert.notEqual(item.voice.attachment_id,source.voice.attachment_id);assert.equal(item.attachments[0].audio.duration_ms,100);
    assert.ok((await f.download(f.outside,{id:delivery.room_id},item.voice.attachment_id))._native_binary.content.equals(wave().bytes));
  }
  const card=result.deliveries.find(item=>item.room_id===f.target.id).message;
  const nested=(await f.merge([card],f.target,[f.second],f.agent)).deliveries[0].message;
  const expanded=await f.call(f.outside,`/rooms/${f.second.id}/messages/${nested.id}/forward-bundle`),voice=expanded.bundle.items[0].forward_bundle.items[0];
  assert.equal(voice.voice.attachment_id,voice.attachments[0].id);assert.equal(voice.attachments[0].room_id,f.second.id);assert.ok(nested.attachment_ids.includes(voice.voice.attachment_id));
  await f.call(f.human,`/rooms/${f.source.id}/messages/${source.id}/forwarding`,"PATCH",{base_revision:1,no_forward:true});
  await assert.rejects(f.forward({...source,revision:2}),{code:"forwarding_disabled"});await assert.rejects(f.merge([{...source,revision:2}]),{code:"forwarding_disabled"});
  await assert.rejects(f.send({id:source.voice.attachment_id}),{code:"forwarding_disabled"});
});

test("missing or corrupt audio rejects send and both forwarding paths before target state mutation",async()=>{
  const f=await fixture(),attachment=await f.upload(),source=(await f.send(attachment)).message,card=(await f.merge([source])).deliveries[0].message,before=fs.readFileSync(f.file,"utf8");
  fs.writeFileSync(path.join(path.dirname(f.file),"attachments",attachment.sha256),Buffer.alloc(attachment.size));
  await assert.rejects(f.send(attachment),{code:"attachment_storage"});await assert.rejects(f.forward(source),{code:"attachment_storage"});await assert.rejects(f.merge([source]),{code:"attachment_storage"});
  await assert.rejects(f.merge([card],f.target,[f.second]),{code:"attachment_storage"});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
});

test("voice native MCP/A2A share current member and media authorization; revocation blocks cached playable references",async()=>{
  const f=await fixture(),attachment=await f.upload();
  for(const who of [f.human,f.agent]){
    const response=await nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"im_send",arguments:{room_id:f.source.id,client_id:"mcp-voice",voice:{attachment_id:attachment.id}}}},who.token);
    assert.equal(response.result.isError,false);assert.equal(JSON.parse(response.result.content[0].text).message.kind,"voice");
  }
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const response=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"a2a-voice",role:"user",parts:[{kind:"data",data:{operation:"im_send",arguments:{room_id:f.source.id,client_id:"a2a-voice",voice:{attachment_id:attachment.id}}}}]}}},f.agent.token);assert.equal(response.result.status.state,"completed");
  await f.call(f.human,`/rooms/${f.source.id}/attachments/${attachment.id}`,"DELETE");
  const denied=await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:response.result.id}},f.agent.token);assert.equal(denied.error.data.code,"attachment_deleted");
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  assert.equal((await f.call(f.agent,"/capabilities")).voice_media.enabled,false);
  const revoked=await gateway.handle({jsonrpc:"2.0",id:3,method:"tasks/get",params:{id:response.result.id}},f.agent.token);assert.equal(revoked.error.data.code,"app_policy_denied");
});

test("voice exports keep source metadata and shared nested IDs without claiming audio transcription",async()=>{
  const f=await fixture(),source=(await f.send(await f.upload())).message;
  const doc=await f.call(f.human,`/rooms/${f.source.id}/messages/export-document`,"POST",{client_id:"doc",title:"Voice provenance",message_ids:[source.id],base_revisions:{[source.id]:1}});
  assert.ok(doc.document.content.includes(source.voice.attachment_id));assert.ok(doc.document.content.includes('"codec": "pcm_s16le"'));assert.ok(doc.document.content.includes('"duration_ms": 100'));
  const exported=await f.call(f.human,`/rooms/${f.source.id}/export`);assert.ok(exported.includes('"voice"'));assert.ok(exported.includes(source.voice.attachment_id));
  const card=(await f.merge([source])).deliveries[0].message;
  const expanded=await f.call(f.outside,`/rooms/${f.target.id}/messages/${card.id}/forward-bundle`),id=expanded.bundle.items[0].voice.attachment_id;
  const nestedDoc=await f.call(f.outside,`/rooms/${f.target.id}/messages/export-document`,"POST",{client_id:"shared-doc",title:"Shared voice",message_ids:[card.id],base_revisions:{[card.id]:1}});
  assert.ok(nestedDoc.document.content.includes(id));assert.equal(nestedDoc.document.content.includes(source.voice.attachment_id),false);
});

test("voice message persistence failure leaves only the previously committed upload and stable retry recovers after restart",async()=>{
  const f=await fixture(),attachment=await f.upload(),before=fs.readFileSync(f.file,"utf8"),rename=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===f.file)throw Error("voice persistence fixture");return rename(from,to);};
  try{await assert.rejects(f.send(attachment,f.agent,f.source,{client_id:"recover"}),{code:"storage_failed"});}finally{fs.renameSync=rename;}
  assert.equal(fs.readFileSync(f.file,"utf8"),before);f.restart();assert.equal((await f.call(f.agent,`/rooms/${f.source.id}`)).messages.length,0);
  assert.equal((await f.send(attachment,f.agent,f.source,{client_id:"recover"})).duplicate,false);assert.equal((await f.send(attachment,f.agent,f.source,{client_id:"recover"})).duplicate,true);
});

test("lowering recording duration preserves committed idempotent voice receipts while blocking new over-limit sends",async()=>{
  const f=await fixture(),attachment=await f.upload(wave({frames:32000}).bytes),first=await f.send(attachment,f.human,f.source,{client_id:"long-before-policy"});
  f.restart({voiceMaxDurationMs:1000});
  const retry=await f.send(attachment,f.human,f.source,{client_id:"long-before-policy"});assert.equal(retry.duplicate,true);assert.equal(retry.message.id,first.message.id);
  await assert.rejects(f.send(attachment),{code:"voice_too_long"});
  assert.equal((await f.forward(first.message)).message.voice.duration_ms,2000);
});
