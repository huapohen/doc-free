"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP,publicTools,callNativeTool}=require("../native-im-mcp");
const {createNativeA2A}=require("../native-a2a");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-message-personal-"));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(temporary,crypto.randomUUID(),"im.json"),admin=crypto.randomBytes(32).toString("hex");
  const options={file,adminToken:admin,workspace:{handle:async()=>{throw new Error("Unexpected document operation");}}};
  let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await enroll("Human"),peer=await enroll("Peer"),agent=await enroll("Agent","agent"),outside=await enroll("Outsider");
  const {room}=await call(human,"/rooms","POST",{name:"Personal message fixture"}),base="/rooms/"+room.id;
  for(const who of [peer,agent])await call(human,base+"/members","POST",{principal_id:who.principal.id});
  const send=async(who,content,extra={},target=base)=>(await call(who,target+"/messages","POST",{client_id:crypto.randomUUID(),content,...extra})).message;
  const pref=(who,message,input)=>call(who,base+"/messages/"+message.id+"/preferences","PATCH",input);
  const protect=(who,message,no_forward,base_revision=message.revision)=>call(who,base+"/messages/"+message.id+"/forwarding","PATCH",{base_revision,no_forward});
  return {file,admin,human,peer,agent,outside,room,base,call,send,pref,protect,restart:()=>im=createNativeIM(options),get im(){return im;}};
}

test("personal marks are isolated, explicit idempotent intentions survive restart without acknowledging reading",async()=>{
  const f=await fixture(),first=await f.send(f.peer,"Mark me"),second=await f.send(f.human,"Agent can mark me");
  for(const who of [f.human,f.agent]){
    const initial=await f.call(who,f.base),marked=await f.pref(who,first,{marked:true});
    assert.equal(marked.message.personal_preferences.marked,true);assert.equal(marked.changed,true);
    const stable=fs.readFileSync(f.file,"utf8");assert.equal((await f.pref(who,first,{marked:true})).changed,false);assert.equal(fs.readFileSync(f.file,"utf8"),stable);
    const after=await f.call(who,f.base);assert.equal(after.room.read_seq,initial.room.read_seq);assert.deepEqual(after.messages[0].receipt_summary,initial.messages[0].receipt_summary);
  }
  await f.pref(f.agent,second,{marked:true});
  assert.deepEqual((await f.call(f.peer,"/message-marks")).items,[]);
  f.restart();
  const human=await f.call(f.human,"/message-marks"),agent=await f.call(f.agent,"/message-marks?limit=1");
  assert.deepEqual(human.items.map(item=>item.message.id),[first.id]);assert.equal(agent.items[0].message.id,second.id);assert.equal(agent.has_more,true);
  assert.deepEqual((await f.call(f.agent,"/message-marks?before="+agent.next_before)).items.map(item=>item.message.id),[first.id]);
  await f.pref(f.human,first,{marked:false});assert.equal((await f.call(f.human,"/message-marks")).items.length,0);assert.equal((await f.call(f.agent,"/message-marks")).items.length,2);
  for(const input of [{},{marked:"true"},{marked:true,principal_id:f.peer.principal.id},{hidden:true,owner_id:f.peer.principal.id}])await assert.rejects(f.pref(f.human,first,input),{status:422});
  await assert.rejects(f.pref(f.outside,first,{marked:true}),{status:403});
  for(const query of ["limit=0","limit=201","before=-1","principal_id="+f.agent.principal.id])await assert.rejects(f.call(f.human,"/message-marks?"+query),{status:422});
});

test("personal hide filters history, search, pins, threads, previews and events while preserving others and explicit receipt evidence",async()=>{
  const f=await fixture(),root=await f.send(f.peer,"Unique hidden body"),middle=await f.send(f.agent,"Unique hidden reply",{reply_to:root.id}),leaf=await f.send(f.peer,"Visible nested reply",{reply_to:middle.id});
  await f.call(f.human,f.base+"/messages/"+root.id+"/pin","POST",{pinned:true});
  await f.pref(f.human,root,{marked:true});await f.pref(f.human,root,{hidden:true});await f.pref(f.human,middle,{hidden:true});
  const detail=await f.call(f.human,f.base),thread=await f.call(f.human,f.base+"/messages/"+root.id+"/thread");
  assert.deepEqual(detail.messages.map(message=>message.id),[leaf.id]);assert.equal(detail.room.message_count,1);assert.equal(detail.room.unread_count,1);assert.equal(detail.room.first_unread_seq,leaf.seq);assert.equal(detail.pins.length,0);
  assert.deepEqual((await f.call(f.human,f.base+"/messages?first_unread=true")).messages.map(message=>message.id),[leaf.id]);
  assert.deepEqual((await f.call(f.human,f.base+"/messages?q=Unique")).messages,[]);
  assert.deepEqual((await f.call(f.human,"/search?type=message&q=Unique")).results,[]);
  assert.equal(thread.root_message.hidden,true);assert.equal(thread.root_message.content,"");assert.equal("history" in thread.root_message,false);assert.equal(thread.total_replies,1);assert.equal(thread.messages[0].id,leaf.id);
  const parent=(await f.call(f.human,f.base+"/messages/"+leaf.id)).reply_parent;assert.equal(parent.hidden,true);assert.equal(parent.content,"");
  assert.equal((await f.call(f.human,"/message-marks")).items.length,0);
  const hidden=await f.call(f.human,"/hidden-messages");assert.equal(hidden.items.length,2);assert.equal(JSON.stringify(hidden).includes("Unique hidden"),false);
  const events=await f.call(f.human,"/events?after=0");assert.equal(JSON.stringify(events).includes("Unique hidden"),false);assert.equal(events.events.filter(event=>event.type==="message.preferences.updated").length,3);
  const other=await f.call(f.agent,f.base);assert.equal(other.messages.length,3);assert.equal(other.pins.length,1);assert.equal((await f.call(f.agent,"/hidden-messages")).items.length,0);
  const read=await f.call(f.peer,f.base+"/messages/"+root.id+"/readers");assert.equal(read.receipt_summary.read_count,0);
  await f.call(f.human,f.base+"/preferences","PATCH",{read_seq:leaf.seq});const acknowledged=await f.call(f.peer,f.base+"/messages/"+root.id+"/readers");assert.equal(acknowledged.receipt_summary.read_count,1);
  await f.pref(f.human,root,{hidden:false});await f.pref(f.human,middle,{hidden:false});f.restart();
  assert.equal((await f.call(f.human,f.base)).messages.length,3);assert.equal((await f.call(f.human,"/message-marks")).items[0].message.id,root.id);assert.equal((await f.call(f.peer,f.base+"/messages/"+root.id+"/readers")).receipt_summary.read_count,1);
  const stored=JSON.parse(fs.readFileSync(f.file)).rooms[0].messages[0];assert.equal(stored.content,"Unique hidden body");assert.equal(stored.retracted_at,null);assert.deepEqual(stored.recipient_snapshots,root.recipient_snapshots);
});

test("hiding latest updates preview and is reversible after the author retracts; current hidden lists never leak recalled content",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Retracted secret");
  await f.pref(f.agent,message,{marked:true,hidden:true});
  assert.equal((await f.call(f.agent,f.base)).room.last_message,null);
  await f.call(f.human,f.base+"/messages/"+message.id,"DELETE",{base_revision:1});
  await f.pref(f.agent,message,{hidden:false});const list=await f.call(f.agent,"/message-marks");
  assert.equal(list.items[0].message.content,"");assert.equal("history" in list.items[0].message,false);assert.equal(JSON.stringify(list).includes("Retracted secret"),false);
  await assert.rejects(f.pref(f.peer,message,{marked:true}),{status:409,code:"message_retracted"});
});

test("Agent hiding removes triggering and frozen context output, cancels only its work, and retains the durable original evidence",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Agent hidden trigger",{mentions:[f.agent.principal.id]});
  const run=await f.call(f.agent,f.base+"/turns/claim","POST",{model:"fixture",reasoning_effort:"medium"});assert.ok(run.turn);
  await f.pref(f.agent,message,{hidden:true});
  const view=await f.call(f.agent,f.base+"/turns/"+run.turn.id);assert.equal(view.turn.status,"cancelled");assert.equal(JSON.stringify(view).includes("Agent hidden trigger"),false);
  assert.equal(JSON.stringify(await f.call(f.agent,f.base+"/export")).includes("Agent hidden trigger"),false);
  assert.equal(JSON.stringify(await f.call(f.human,f.base+"/export")).includes("Agent hidden trigger"),true);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).rooms[0].turns[0].context.trigger.message.content,"Agent hidden trigger");
  assert.equal((await f.call(f.agent,f.base+"/turns/claim","POST",{model:"fixture",reasoning_effort:"medium"})).turn,null);
});

test("author-only forwarding protection is CAS checked and blocks Human/Agent native forwarding including retries and descendants",async()=>{
  const f=await fixture(),message=await f.send(f.agent,"Protected origin"),{room:target}=await f.call(f.human,"/rooms","POST",{name:"Forward destination"});
  await f.call(f.human,"/rooms/"+target.id+"/members","POST",{principal_id:f.agent.principal.id});
  const request={target_room_id:target.id,client_id:"first-forward",base_revision:1};
  const copy=(await f.call(f.human,f.base+"/messages/"+message.id+"/forward","POST",request)).message;
  await assert.rejects(f.protect(f.human,message,true),{status:403,code:"author_required"});
  const changed=await f.protect(f.agent,message,true);assert.equal(changed.message.no_forward,true);assert.equal(changed.message.revision,2);
  await assert.rejects(f.protect(f.agent,message,false),{status:409,code:"conflict"});
  for(const who of [f.human,f.agent])await assert.rejects(f.call(who,f.base+"/messages/"+message.id+"/forward","POST",request),{status:403,code:"forwarding_disabled"});
  const inherited=(await f.call(f.human,"/rooms/"+target.id+"/messages/"+copy.id)).message;assert.equal(inherited.no_forward,true);assert.equal(inherited.forwarding_own_no_forward,false);
  await assert.rejects(f.call(f.human,"/rooms/"+target.id+"/messages/"+copy.id+"/forward","POST",{target_room_id:f.room.id,client_id:"chain",base_revision:1}),{status:403,code:"forwarding_disabled"});
  await f.call(f.human,"/rooms/"+target.id+"/messages/"+copy.id+"/forwarding","PATCH",{base_revision:1,no_forward:false});
  await assert.rejects(f.call(f.human,"/rooms/"+target.id+"/messages/"+copy.id+"/forward","POST",{target_room_id:f.room.id,client_id:"chain",base_revision:1}),{status:403});
  f.restart();assert.equal((await f.call(f.agent,f.base+"/messages/"+message.id)).message.no_forward,true);
  const restored=await f.protect(f.agent,message,false,2);assert.equal(restored.message.revision,3);
  const forwarded=await f.call(f.agent,f.base+"/messages/"+message.id+"/forward","POST",{target_room_id:target.id,client_id:"after-unprotect",base_revision:3});assert.equal(forwarded.message.content,message.content);
  await f.pref(f.human,message,{hidden:true});await assert.rejects(f.call(f.human,f.base+"/messages/"+message.id+"/forward","POST",{...request,client_id:"hidden-forward",base_revision:3}),{status:409,code:"message_hidden"});
});

test("protected attachment reuse cannot bypass native forwarding through an ordinary send or a previously forwarded attachment",async()=>{
  const f=await fixture(),attachment=(await f.call(f.human,f.base+"/attachments","POST",{client_id:"attachment",filename:"source.txt",mime_type:"text/plain",data_base64:Buffer.from("file body").toString("base64")})).attachment;
  const message=await f.send(f.human,"File origin",{attachment_ids:[attachment.id]});
  const {room:target}=await f.call(f.human,"/rooms","POST",{name:"Attachment destination"});
  const copy=(await f.call(f.human,f.base+"/messages/"+message.id+"/forward","POST",{target_room_id:target.id,client_id:"file-forward",base_revision:1})).message;
  await f.protect(f.human,message,true);
  for(const who of [f.human,f.agent])await assert.rejects(f.send(who,"Attachment bypass",{attachment_ids:[attachment.id]}),{status:403,code:"forwarding_disabled"});
  await assert.rejects(f.send(f.human,"Forwarded attachment bypass",{attachment_ids:copy.attachment_ids},"/rooms/"+target.id),{status:403,code:"forwarding_disabled"});
  assert.equal((await f.call(f.agent,f.base+"/attachments/"+attachment.id+"/content"))._native_binary.content.toString(),"file body","forwarding protection does not pretend to prevent authorized reading/copying");
  await f.protect(f.human,message,false,2);assert.equal((await f.send(f.agent,"Allowed again",{attachment_ids:[attachment.id]})).attachment_ids[0],attachment.id);
});

test("native MCP offers the same personal state and author permission for Human and Agent without owner spoofing",async()=>{
  const f=await fixture(),message=await f.send(f.agent,"MCP message");
  const call=(who,name,args={})=>nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  const parse=response=>JSON.parse(response.result.content[0].text);
  for(const name of ["im_message_preferences","im_message_marks","im_hidden_messages","im_message_forwarding"])assert.ok(publicTools.some(tool=>tool.name===name));
  for(const who of [f.human,f.agent]){
    const updated=await call(who,"im_message_preferences",{room_id:f.room.id,message_id:message.id,marked:true});assert.equal(updated.result.isError,false);
    assert.equal(parse(await call(who,"im_message_marks")).items[0].message.id,message.id);
  }
  const denied=await call(f.human,"im_message_forwarding",{room_id:f.room.id,message_id:message.id,base_revision:1,no_forward:true});assert.deepEqual(parse(denied),{status:403,code:"author_required"});
  assert.equal((await call(f.agent,"im_message_forwarding",{room_id:f.room.id,message_id:message.id,base_revision:1,no_forward:true})).result.isError,false);
  const forged=await call(f.agent,"im_message_preferences",{room_id:f.room.id,message_id:message.id,hidden:true,principal_id:f.human.principal.id});assert.equal(forged.result.isError,true);
  await call(f.agent,"im_message_preferences",{room_id:f.room.id,message_id:message.id,hidden:true});assert.equal(parse(await call(f.agent,"im_hidden_messages")).items.length,1);assert.equal(parse(await call(f.human,"im_hidden_messages")).items.length,0);
});

test("message mark grouping preserves manual room marks and remains separate from favorites; hidden/recalled message marks stop matching",async()=>{
  const f=await fixture(),message=await f.send(f.peer,"Grouped mark");
  await f.call(f.human,f.base+"/preferences","PATCH",{favorite:true});
  const group=async who=>(await f.call(who,"/message-groups")).groups.find(group=>group.id==="marked");
  assert.equal((await group(f.human)).room_count,0);
  await f.pref(f.human,message,{marked:true});
  assert.deepEqual((await group(f.human)).room_ids,[f.room.id]);assert.equal((await group(f.agent)).room_count,0);
  const grouping=(await f.call(f.human,f.base)).room.message_grouping;
  assert.equal(grouping.marked,false,"manual conversation mark stays independently editable");assert.equal(grouping.conversation_marked,false);assert.equal(grouping.marked_message_count,1);
  await f.pref(f.human,message,{hidden:true});assert.equal((await group(f.human)).room_count,0);
  await f.pref(f.human,message,{hidden:false});assert.equal((await group(f.human)).room_count,1);
  await f.call(f.peer,f.base+"/messages/"+message.id,"DELETE",{base_revision:1});assert.equal((await group(f.human)).room_count,0);
  const revision=(await f.call(f.human,"/message-groups")).revision;
  await f.call(f.human,f.base+"/message-groups","PATCH",{base_revision:revision,marked:true});
  assert.equal((await group(f.human)).room_count,1);assert.equal((await f.call(f.human,f.base)).room.message_grouping.conversation_marked,true);
});

test("cached A2A message results cannot bypass a later personal hide; restored receipts and denied application policies use current authority",async()=>{
  const f=await fixture(),message=await f.send(f.human,"Cached hidden content");
  const gateway=createNativeA2A({file:path.join(temporary,crypto.randomUUID()+"-a2a.json"),im:f.im,invokeTool:callNativeTool,publicTools});
  const response=await gateway.handle({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{messageId:"personal-read",role:"user",parts:[{kind:"data",data:{operation:"im_thread",arguments:{room_id:f.room.id,message_id:message.id}}}]}}},f.agent.token);
  assert.equal(response.result.status.state,"completed");
  await f.pref(f.agent,message,{hidden:true});
  const denied=await gateway.handle({jsonrpc:"2.0",id:2,method:"tasks/get",params:{id:response.result.id}},f.agent.token);
  assert.equal(denied.error.data.code,"receipt_scope_revoked");assert.equal(JSON.stringify(denied).includes("Cached hidden content"),false);
  await f.pref(f.agent,message,{hidden:false});assert.equal((await gateway.handle({jsonrpc:"2.0",id:3,method:"tasks/get",params:{id:response.result.id}},f.agent.token)).result.status.state,"completed");
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  for(const route of ["/message-marks","/hidden-messages"])await assert.rejects(f.call(f.agent,route),{code:"app_policy_denied"});
  await assert.rejects(f.pref(f.agent,message,{marked:true}),{code:"app_policy_denied"});
});
