"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP,callNativeTool,publicTools}=require("../native-im-mcp");
const {createNativeA2A}=require("../native-a2a");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-message-reading-"));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(temporary,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex");
  const options={file,adminToken:admin,workspace:{handle:async()=>{throw new Error("Unexpected document operation");}}};
  let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await enroll("Human"),peer=await enroll("Peer"),agent=await enroll("Agent","agent"),outside=await enroll("Late reader");
  const {room}=await call(human,"/rooms","POST",{name:"Reading fixture"}),base="/rooms/"+room.id;
  for(const who of [peer,agent])await call(human,base+"/members","POST",{principal_id:who.principal.id});
  const send=async(who,content,extra={},target=base)=>(await call(who,target+"/messages","POST",{client_id:crypto.randomUUID(),content,...extra})).message;
  const ack=(who,seq,target=base)=>call(who,target+"/preferences","PATCH",{read_seq:seq});
  const readers=(who,message,target=base)=>call(who,target+"/messages/"+message.id+"/readers");
  const rewrite=update=>{const state=JSON.parse(fs.readFileSync(file));update(state,state.rooms.find(item=>item.id===room.id));fs.writeFileSync(file,JSON.stringify(state));im=createNativeIM(options);};
  return {file,admin,human,peer,agent,outside,room,base,call,send,ack,readers,rewrite,restart:()=>im=createNativeIM(options),get im(){return im;}};
}

test("first unread can precede the detail tail; windows preserve unread until an explicit partial ACK",async()=>{
  const f=await fixture(),sent=[];
  for(let index=0;index<225;index++)sent.push(await f.send(f.peer,"Window message "+index));
  await f.send(f.human,"Own message is not unread");
  await f.ack(f.human,sent[4].seq);await f.ack(f.agent,sent[34].seq);
  await f.call(f.peer,f.base+"/messages/"+sent[5].id,"DELETE",{base_revision:1});
  const stable=fs.readFileSync(f.file,"utf8"),detail=await f.call(f.human,f.base);
  assert.equal(detail.messages.length,200);assert.equal(detail.room.first_unread_seq,sent[6].seq);
  assert.ok(!detail.messages.some(message=>message.id===sent[6].id));assert.equal(detail.room.unread_count,219);
  const first=await f.call(f.human,f.base+"/messages?first_unread=true&limit=20");
  assert.equal(first.messages[0].id,sent[6].id);assert.equal(first.anchor_seq,sent[6].seq);assert.equal(first.first_unread_seq,sent[6].seq);
  assert.equal(first.messages.length,20);assert.equal(first.before_cursor,sent[6].seq);assert.equal(first.after_cursor,sent[25].seq);
  assert.equal(first.has_more_before,true);assert.equal(first.has_more_after,true);assert.equal(first.remaining_unread_after,199);
  const next=await f.call(f.human,f.base+"/messages?after="+first.after_cursor+"&limit=20");
  assert.equal(next.messages[0].id,sent[26].id);assert.equal(new Set([...first.messages,...next.messages].map(message=>message.id)).size,40);
  const older=await f.call(f.human,f.base+"/messages?before="+first.before_cursor+"&limit=20");
  assert.equal(older.messages.length,6);assert.equal(older.has_more,false);assert.equal(older.has_more_after,true);
  const agent=await f.call(f.agent,f.base+"/messages?first_unread=true&limit=20");assert.equal(agent.first_unread_seq,sent[35].seq);
  assert.equal(fs.readFileSync(f.file,"utf8"),stable,"all GET windows and receipt derivations are read-only");
  await f.ack(f.human,first.messages[3].seq);
  const remaining=await f.call(f.human,f.base+"/messages?first_unread=true&limit=20");
  assert.equal(remaining.unread_count,215);assert.equal(remaining.first_unread_seq,sent[10].seq);
  assert.equal((await f.call(f.agent,f.base)).room.first_unread_seq,sent[35].seq);
});

test("around and after cursors handle gaps and boundaries; no unread falls back to tail without an anchor",async()=>{
  const f=await fixture(),messages=[];
  for(let index=0;index<9;index++)messages.push(await f.send(f.peer,"Searchable "+index));
  const middle=await f.call(f.human,f.base+"/messages?around="+messages[4].seq+"&limit=5");
  assert.deepEqual(middle.messages.map(message=>message.id),messages.slice(2,7).map(message=>message.id));assert.equal(middle.anchor_seq,messages[4].seq);
  const gap=await f.call(f.human,f.base+"/messages?around="+(messages[0].seq-1)+"&limit=3");assert.equal(gap.anchor_seq,messages[0].seq);
  const past=await f.call(f.human,f.base+"/messages?around="+(messages.at(-1).seq+100)+"&limit=3");assert.equal(past.anchor_seq,messages.at(-1).seq);assert.equal(past.has_more_after,false);
  const empty=await f.call(f.human,f.base+"/messages?after="+messages.at(-1).seq);assert.deepEqual(empty.messages,[]);assert.equal(empty.remaining_unread_after,0);
  await f.ack(f.human,messages.at(-1).seq);
  const stable=fs.readFileSync(f.file,"utf8"),read=await f.call(f.human,f.base+"/messages?first_unread=true&limit=3");
  assert.equal(read.anchor_seq,null);assert.equal(read.first_unread_seq,null);assert.equal(read.unread_count,0);assert.equal(read.messages.at(-1).id,messages.at(-1).id);
  const search=await f.call(f.human,f.base+"/messages?q=Searchable&before="+messages[4].seq+"&limit=2");
  assert.deepEqual(search.messages.map(message=>message.id),messages.slice(2,4).map(message=>message.id));assert.equal(search.has_more,true);
  for(const query of ["first_unread=1","first_unread=true&after=0","around=1&before=2","around=1&q=x","first_unread=true&q=x","after=-1","around=0","limit=201","limit=0","after=1.5"])
    await assert.rejects(f.call(f.human,f.base+"/messages?"+query),{status:422,code:"invalid_input"});
  assert.equal(fs.readFileSync(f.file,"utf8"),stable);
});

test("threads paginate the actual recursive reply graph, retain recalled roots and never acknowledge visible content",async()=>{
  const f=await fixture(),root=await f.send(f.human,"Root secret");
  const first=await f.send(f.peer,"First reply",{reply_to:root.id}),outside=await f.send(f.agent,"Unrelated");
  const nested=await f.send(f.human,"Human nested reply",{reply_to:first.id}),last=await f.send(f.agent,"Sibling",{reply_to:root.id});
  await f.send(f.peer,"Other topic",{reply_to:outside.id});
  assert.notEqual(nested.root_id,root.root_id,"human execution roots are not thread membership");
  const stable=fs.readFileSync(f.file,"utf8"),route=f.base+"/messages/"+root.id+"/thread";
  for(const who of [f.human,f.agent]){
    const page=await f.call(who,route+"?limit=2");
    assert.equal(page.root_message.id,root.id);assert.equal(page.total_replies,3);
    assert.deepEqual(page.messages.map(message=>message.id),[first.id,nested.id]);assert.equal(page.has_more,true);assert.equal(page.next_after,nested.seq);
    const next=await f.call(who,route+"?after="+page.next_after+"&limit=2");
    assert.deepEqual(next.messages.map(message=>message.id),[last.id]);assert.equal(next.has_more,false);assert.equal(next.next_after,null);assert.equal(next.after_cursor,last.seq);
  }
  assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  await f.call(f.human,f.base+"/messages/"+root.id,"DELETE",{base_revision:1});
  await f.call(f.peer,f.base+"/messages/"+first.id,"DELETE",{base_revision:1});
  const recalled=await f.call(f.agent,route);
  assert.equal(recalled.root_message.content,"");assert.equal(recalled.messages[0].content,"");assert.equal(recalled.total_replies,3);
  assert.ok(!JSON.stringify(recalled).includes("Root secret"));assert.ok(!JSON.stringify(recalled).includes("First reply"));
  assert.equal("history" in recalled.root_message,false);assert.equal(recalled.messages[1].content,"Human nested reply");
  for(const query of ["before=1","q=x","after=-1","limit=201"])await assert.rejects(f.call(f.agent,route+"?"+query),{status:422});
});

test("Human and Agent direct-message reads and Agent processing never imply receipt; explicit ACK alone creates the read check",async()=>{
  const f=await fixture(),{room}=await f.call(f.human,"/rooms/direct","POST",{principal_id:f.agent.principal.id}),base="/rooms/"+room.id;
  const message=await f.send(f.human,"Please observe without reading",{},base);
  assert.deepEqual(message.recipient_ids,[f.agent.principal.id]);assert.equal(message.receipt_summary.eligible_count,1);assert.equal(message.receipt_summary.read_count,0);
  await f.call(f.agent,base);await f.call(f.agent,base+"/messages/"+message.id);await f.call(f.agent,base+"/messages/"+message.id+"/thread");
  const claimed=await f.call(f.agent,base+"/turns/claim","POST",{model:"fixture",reasoning_effort:"medium"});assert.ok(claimed.turn);
  await f.call(f.agent,base+"/turns/"+claimed.turn.id+"/finish","POST",{lease_token:claimed.turn.lease_token,action:"silent",rationale:"Observed, not read",model:"fixture",reasoning_effort:"medium"});
  assert.equal((await f.readers(f.human,message,base)).receipt_summary.read_count,0);
  const member=(await f.call(f.human,base)).members.find(value=>value.principal_id===f.agent.principal.id);
  assert.ok(member.cursor>=message.seq);assert.equal(member.read_ack_seq,0);
  await f.ack(f.agent,message.seq,base);
  const seen=await f.readers(f.human,message,base);assert.equal(seen.receipt_summary.read_count,1);assert.equal(seen.readers[0].read,true);
  const reply=await f.send(f.agent,"Agent outgoing",{},base);assert.deepEqual(reply.recipient_ids,[f.human.principal.id]);
  assert.equal((await f.readers(f.agent,reply,base)).receipt_summary.read_count,0);await f.ack(f.human,reply.seq,base);
  assert.equal((await f.readers(f.agent,reply,base)).receipt_summary.read_count,1);
});

test("group receipt eligibility stays at sending time and cumulative ACKs remain separate across leave/rejoin cycles",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Original recipients");
  assert.deepEqual(message.recipient_ids,[f.peer.principal.id,f.agent.principal.id].sort());
  await f.call(f.human,f.base+"/members","POST",{principal_id:f.outside.principal.id});
  assert.ok((await f.call(f.outside,f.base)).room.read_seq>=message.seq);
  await f.ack(f.outside,message.seq);
  let readers=await f.readers(f.human,message);assert.equal(readers.receipt_summary.eligible_count,2);assert.equal(readers.receipt_summary.read_count,0);
  assert.ok(!readers.readers.some(person=>person.principal_id===f.outside.principal.id));
  await f.ack(f.peer,message.seq);
  await f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE");
  await f.call(f.human,f.base+"/members","POST",{principal_id:f.agent.principal.id});
  await f.ack(f.agent,message.seq);
  readers=await f.readers(f.human,message);assert.equal(readers.receipt_summary.read_count,1);
  assert.equal(readers.readers.find(person=>person.principal_id===f.agent.principal.id).same_membership,false);
  const next=await f.send(f.human,"Current membership recipients");await f.ack(f.agent,next.seq);
  assert.equal((await f.readers(f.human,next)).receipt_summary.read_count,1);
  assert.equal((await f.readers(f.human,message)).receipt_summary.read_count,1,"new membership ACK cannot read the old membership's messages");
  await f.call(f.human,f.base+"/members/"+f.peer.principal.id,"DELETE");
  f.restart();readers=await f.readers(f.human,message);
  const departed=readers.readers.find(person=>person.principal_id===f.peer.principal.id);assert.equal(departed.read,true);assert.equal(departed.current_member,false);
  assert.equal(readers.receipt_summary.read_count,1);
});

test("legacy recipient uncertainty is explicit and cannot become read merely from join watermarks or later ACKs",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Legacy unknown");
  f.rewrite((state,room)=>{
    const remove=value=>{delete value.recipient_ids;delete value.recipient_snapshots;delete value.recipient_snapshot_version;};
    remove(room.messages[0]);for(const event of state.events)if(event.message?.id===message.id)remove(event.message);
    room.preferences[f.peer.principal.id].read_seq=message.seq;
  });
  const before=fs.readFileSync(f.file,"utf8"),unknown=await f.readers(f.human,message);
  assert.deepEqual(unknown.receipt_summary,{known:false,basis:"legacy_unknown",eligible_count:null,read_count:null,unread_count:null,unknown_count:null});
  assert.deepEqual(unknown.readers,[]);assert.equal(fs.readFileSync(f.file,"utf8"),before);
  await f.ack(f.peer,message.seq);assert.deepEqual(await f.readers(f.human,message),unknown);
  const source=(await f.call(f.agent,f.base+"/messages/"+message.id)).message;assert.equal(source.receipt_summary.known,false);
  const exported=await f.call(f.human,f.base+"/export");assert.ok(exported.includes('"basis": "legacy_unknown"'));
});

test("explicit ACKs reject invalid writes atomically, stay monotonic, and recover correctly after persistence failure",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Read safely"),before=fs.readFileSync(f.file,"utf8");
  for(const read_seq of [-1,1.5,Number.MAX_SAFE_INTEGER])await assert.rejects(f.call(f.peer,f.base+"/preferences","PATCH",{read_seq,muted:true}),{status:422});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const rename=fs.renameSync;fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("Fixture ACK save failure");return rename(source,target);};
  try{await assert.rejects(f.ack(f.peer,message.seq),{code:"storage_failed"});}finally{fs.renameSync=rename;}
  await assert.rejects(f.readers(f.human,message),{code:"storage_failed"});f.restart();
  assert.equal((await f.readers(f.human,message)).receipt_summary.read_count,0);
  await f.ack(f.peer,message.seq);const read=await f.readers(f.human,message);assert.equal(read.receipt_summary.read_count,1);
  const stable=fs.readFileSync(f.file,"utf8");await f.ack(f.peer,0);assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  assert.deepEqual(await f.readers(f.human,message),read);
});

test("MCP windows threads and readers use equal current-member access and cached A2A reads are revoked with membership",async()=>{
  const f=await fixture(),message=await f.send(f.peer,"Shared evidence"),reply=await f.send(f.human,"Human reply",{reply_to:message.id});
  const rpc=(who,name,args)=>nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  const parse=result=>JSON.parse(result.result.content[0].text);
  assert.equal(publicTools.find(tool=>tool.name==="im_history").inputSchema.properties.first_unread.type,"boolean");
  const stable=fs.readFileSync(f.file,"utf8");
  for(const who of [f.human,f.agent]){
    const window=await rpc(who,"im_history",{room_id:f.room.id,first_unread:true,limit:1});assert.equal(window.result.isError,false);assert.equal(parse(window).anchor_seq,message.seq);
    const thread=await rpc(who,"im_thread",{room_id:f.room.id,message_id:message.id,limit:1});assert.equal(thread.result.isError,false);assert.equal(parse(thread).messages[0].id,reply.id);
    const read=await rpc(who,"im_message_readers",{room_id:f.room.id,message_id:message.id});assert.equal(read.result.isError,false);assert.equal(parse(read).receipt_summary.read_count,0);
  }
  assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const response=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"read-thread",role:"user",parts:[{kind:"data",data:{operation:"im_thread",arguments:{room_id:f.room.id,message_id:message.id}}}]}}},f.agent.token);
  assert.equal(response.result.status.state,"completed");
  await f.call(f.human,f.base+"/members/"+f.agent.principal.id,"DELETE");
  const denied=await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:response.result.id}},f.agent.token);assert.equal(denied.error.data.code,"not_a_member");
  for(const route of ["/messages?first_unread=true","/messages/"+message.id+"/thread","/messages/"+message.id+"/readers"])
    await assert.rejects(f.call(f.agent,f.base+route),{code:"not_a_member"});
  const {room}=await f.call(f.outside,"/rooms","POST",{name:"Wrong room"});
  await assert.rejects(f.call(f.outside,"/rooms/"+room.id+"/messages/"+message.id+"/thread"),{code:"not_found"});
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.peer.principal.id]});
  await assert.rejects(f.call(f.peer,f.base+"/messages/"+message.id+"/readers"),{code:"app_policy_denied"});
});

test("recipient and reader response mutation cannot corrupt eligibility, and forwarding captures the target room separately",async()=>{
  const f=await fixture(),message=await f.send(f.human,"receipt-search snapshot"),expected=[...message.recipient_ids];
  message.recipient_ids.length=0;message.recipient_snapshots[0].name="Caller mutation";message.receipt_summary.read_count=999;
  const raw=(await f.call(f.human,f.base+"/messages?limit=1")).messages[0];assert.deepEqual(raw.recipient_ids,expected);assert.equal(raw.receipt_summary.read_count,0);
  const readers=await f.readers(f.human,raw);readers.readers[0].name="Another mutation";
  assert.notEqual((await f.readers(f.human,raw)).readers[0].name,"Another mutation");
  await f.ack(f.agent,raw.seq);
  const search=await f.call(f.human,"/search?"+new URLSearchParams({q:"receipt-search",type:"message",room_id:f.room.id}));assert.equal(search.results[0].receipt_summary.read_count,1);
  const {room}=await f.call(f.human,"/rooms/direct","POST",{principal_id:f.outside.principal.id});
  const forwarded=await f.call(f.human,f.base+"/messages/"+raw.id+"/forward","POST",{client_id:"receipt-forward",target_room_id:room.id,base_revision:1});
  assert.deepEqual(forwarded.message.recipient_ids,[f.outside.principal.id]);assert.equal(forwarded.message.receipt_summary.read_count,0);
  const exported=await f.call(f.human,f.base+"/export");assert.ok(exported.includes('"recipient_snapshots"'));assert.ok(exported.includes('"basis": "explicit_read_ack"'));
});
