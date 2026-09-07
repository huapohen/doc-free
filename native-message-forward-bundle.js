"use strict";
const crypto=require("node:crypto");
const {normalizeRichText}=require("./native-rich-text");
const {problem,requireText}=require("./work-protocol");
const {messageHidden,forwardingBlocked}=require("./native-message-personal");
const copy=value=>JSON.parse(JSON.stringify(value));
const hash=value=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
function createMessageForwardBundle({state,stamp,persist,roomById,member,active,mentionsFor,appendMessage,messageView,messageAuthor,attachments}){
  state.message_forward_bundles??=[];state.message_forward_bundle_keys??={};
  if(!Array.isArray(state.message_forward_bundles)||!object(state.message_forward_bundle_keys)||
      state.message_forward_bundles.some(record=>!object(record)||!Array.isArray(record.items)||!Array.isArray(record.deliveries)||!Array.isArray(record.source_message_ids)||record.snapshot_hash!==hash(record.items))||
      Object.values(state.message_forward_bundle_keys).some(key=>!object(key)||!state.message_forward_bundles.some(record=>record.id===key.id)))throw new Error("Message forward bundle ledger is corrupt");
  function descriptor(record){return {id:record.id,title:record.title,message_count:record.items.length,created_by:record.created_by,created_at:record.created_at};}
  function find(id){const record=state.message_forward_bundles.find(record=>record.id===id);if(!record)throw problem(404,"not_found","合并转发记录不存在");return record;}
  function authorizeRead(room,message,p){
    member(room,p);
    if(!message)throw problem(404,"not_found","合并消息不在当前会话");
    if(messageHidden(state,p.id,message))throw problem(409,"message_hidden","请先恢复本人隐藏的合并消息");
    if(message.retracted_at)throw problem(409,"message_retracted","合并消息已撤回");
    if(!message.forward_bundle?.id)throw problem(422,"not_forward_bundle","此消息不是原生合并转发卡片");
    const record=find(message.forward_bundle.id),delivery=record.deliveries.find(delivery=>delivery.room_id===room.id&&delivery.message_id===message.id);
    if(!delivery)throw problem(403,"bundle_scope","当前消息不是本次分享的接收副本");
    return {record,delivery};
  }
  function sharedItems(record,delivery){
    const mapping=delivery.attachment_map||{};
    function project(item){
      const result=copy(item);
      result.attachments=item.attachments.map(original=>{
        const id=mapping[original.id],current=state.attachments.find(attachment=>attachment.id===id&&attachment.room_id===delivery.room_id);
        if(!id)throw problem(503,"bundle_corrupt","合并消息附件映射不完整");
        const status=current?attachments.contextMetadata({attachment_ids:[id]})[0].availability:"attachment_missing";
        return {id,room_id:delivery.room_id,filename:original.filename,mime_type:original.mime_type,size:original.size,sha256:original.sha256,
          availability:status,download_path:`/api/im/rooms/${delivery.room_id}/attachments/${id}/content`};
      });
      if(item.forward_bundle)result.forward_bundle={...copy(item.forward_bundle),items:item.forward_bundle.items.map(project)};
      return result;
    }
    return record.items.map(project);
  }
  function read(room,message,p){
    const {record,delivery}=authorizeRead(room,message,p);
    return {bundle:{...descriptor(record),snapshot_policy:"shared_copy",items:sharedItems(record,delivery)},message_id:message.id,room_id:room.id};
  }
  function receipt(record,p){
    if(record.created_by!==p.id)throw problem(403,"bundle_receipt_scope","只能读取本人合并转发批次回执");
    member(roomById(record.source_room_id),p);
    const deliveries=record.deliveries.map(delivery=>{
      const room=roomById(delivery.room_id);member(room,p);
      const message=room.messages.find(message=>message.id===delivery.message_id);
      if(!message)throw problem(409,"resource_unavailable","已分享的合并消息不再存在");
      return {room_id:room.id,message:messageView(room,message,p)};
    });
    return {client_id:record.client_id,bundle:descriptor(record),deliveries,created_at:record.created_at};
  }
  function snapshot(room,message,p){
    const author=messageAuthor(room,message.author_id,message.author);
    const richText=normalizeRichText(message.rich_text,message.content);
    const item={source_message_id:message.id,source_revision:message.revision||1,source_at:message.at,
      ...(richText?{rich_text:richText}:{}),
      author:{id:message.author_id,name:author.name,display_name:author.display_name||author.name,kind:author.kind},
      kind:message.forward_bundle?"forward_bundle":"text",content:message.content,
      attachments:message.forward_bundle?[]:attachments.forMessage(room,message.attachment_ids||[],{maxItems:400}).map(attachment=>({id:attachment.id,filename:attachment.filename,mime_type:attachment.mime_type,size:attachment.size,sha256:attachment.sha256}))};
    if(message.forward_bundle){const nested=read(room,message,p).bundle;item.forward_bundle={title:nested.title,message_count:nested.message_count,items:nested.items};}
    return item;
  }
  function forward(room,p,input){
    member(room,p);
    if(Object.keys(input).some(key=>!["client_id","message_ids","base_revisions","target_room_ids","comment","mentions"].includes(key)))throw problem(422,"invalid_input","合并转发只接受来源版本、目标、附言和原生提及");
    const clientId=requireText(input.client_id,"client_id",160),ids=input.message_ids,revisions=input.base_revisions,targetIds=input.target_room_ids;
    if(!Array.isArray(ids)||ids.length<1||ids.length>50||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"))throw problem(422,"invalid_message_sources","请选择1到50条不重复消息");
    if(!object(revisions)||Object.keys(revisions).length!==ids.length||Object.keys(revisions).some(id=>!ids.includes(id))||ids.some(id=>!Number.isSafeInteger(revisions[id])||revisions[id]<1))throw problem(422,"version_required","base_revisions必须精确包含全部来源消息版本");
    if(!Array.isArray(targetIds)||!targetIds.length||targetIds.length>20||new Set(targetIds).size!==targetIds.length||targetIds.some(id=>typeof id!=="string"))throw problem(422,"invalid_targets","请选择1到20个不重复的当前可发会话");
    const comment=input.comment??"";
    if(typeof comment!=="string"||comment.length>12000)throw problem(422,"invalid_comment","附言最多12000字符");
    const targets=[...targetIds].sort().map(id=>{const target=roomById(id);member(target,p);return target;});
    const mentions=mentionsFor(targets[0],input.mentions);
    for(const target of targets)mentionsFor(target,mentions);
    for(const id of mentions)active(id);
    const sources=ids.map(id=>{
      const message=room.messages.find(message=>message.id===id);
      if(!message)throw problem(404,"not_found","来源消息不在当前会话");
      if(messageHidden(state,p.id,message))throw problem(409,"message_hidden","请先恢复本人隐藏的来源");
      if(message.retracted_at)throw problem(409,"message_retracted","已撤回来源不能合并转发");
      if(forwardingBlocked(state,room,message))throw problem(403,"forwarding_disabled","来源消息或来源链禁止转发");
      if((message.revision||1)!==revisions[id])throw problem(409,"conflict","来源版本变化，请刷新后确认");
      attachments.forMessage(room,message.attachment_ids||[],{maxItems:400});
      return message;
    }).sort((a,b)=>a.seq-b.seq);
    const digest=hash({source_room_id:room.id,sources:sources.map(source=>({id:source.id,revision:source.revision||1})),targets:targets.map(target=>target.id),comment,mentions}),key=`${p.id}:${room.id}:${clientId}`,previous=state.message_forward_bundle_keys[key];
    if(previous){if(previous.hash!==digest)throw problem(409,"idempotency_conflict","同一client_id对应不同合并转发意图");const result=receipt(find(previous.id),p);return {bundle:result.bundle,deliveries:result.deliveries,duplicate:true};}
    if(state.message_forward_bundles.length>=2000)throw problem(409,"limit_reached","本地合并转发批次数达到上限");
    const items=sources.map(message=>snapshot(room,message,p));let count=0;
    function bounds(items,depth=1){if(depth>3)throw problem(422,"bundle_too_deep","合并转发最多3层");for(const item of items){if(++count>200)throw problem(422,"bundle_too_large","展开后最多200个来源项");if(item.forward_bundle)bounds(item.forward_bundle.items,depth+1);}}
    bounds(items);
    if(Buffer.byteLength(JSON.stringify(items))>1024*1024)throw problem(422,"bundle_too_large","合并快照超过1MiB，请减少所选消息");
    const attachmentIds=[...new Set(sources.flatMap(source=>source.attachment_ids||[]))];
    if(attachmentIds.length>400)throw problem(422,"invalid_attachments","单批最多400个去重来源附件");
    const prepared=attachments.prepareForwardBatch(room,targets,p,attachmentIds);
    const record={id:`bundle-${crypto.randomUUID()}`,client_id:clientId,title:"聊天记录",source_room_id:room.id,
      source_message_ids:sources.map(source=>source.id),created_by:p.id,created_at:stamp(),items,snapshot_hash:hash(items),deliveries:[]};
    // All rejection conditions are checked under the IM serial lock above.
    // Attachment references, every target card and batch key share one persist.
    prepared.commit();state.message_forward_bundles.push(record);
    for(const target of targets){
      const plan=prepared.plan.find(plan=>plan.room_id===target.id);
      const attachmentMap=Object.fromEntries(plan.attachments.map(item=>[item.original_id,item.attachment.id]));
      const message=appendMessage(target,p,{content:comment,mentions,attachment_ids:plan.attachments.map(item=>item.attachment.id),
        forward_bundle:{id:record.id,title:record.title,message_count:items.length,preview:items.slice(0,3).map(item=>({author_name:item.author.display_name||item.author.name,content:(item.kind==="forward_bundle"?"[聊天记录] ":"")+item.content.slice(0,120)}))}});
      record.deliveries.push({room_id:target.id,message_id:message.id,attachment_map:attachmentMap});
    }
    state.message_forward_bundle_keys[key]={id:record.id,hash:digest};persist();
    const result=receipt(record,p);return {bundle:result.bundle,deliveries:result.deliveries,duplicate:false};
  }
  function handle(method,pathname,input,p,params){
    const create=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/messages\/forward-bundle$/);
    const receipts=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/messages\/forward-bundle-receipts$/);
    const detail=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/messages\/(msg-[a-f0-9-]+)\/forward-bundle$/);
    if(!create&&!receipts&&!detail)return undefined;
    const room=roomById((create||receipts||detail)[1]);member(room,p);
    if(create&&method==="POST")return forward(room,p,input);
    if(receipts&&method==="GET"){
      if([...params.keys()].some(key=>key!=="client_id"))throw problem(422,"invalid_input","合并回执仅支持client_id检索");
      const clientId=requireText(params.get("client_id"),"client_id",160),key=state.message_forward_bundle_keys[`${p.id}:${room.id}:${clientId}`];
      return {receipts:key?[receipt(find(key.id),p)]:[],truncated:false};
    }
    if(detail&&method==="GET")return read(room,room.messages.find(message=>message.id===detail[2]),p);
    throw problem(405,"method_not_allowed","不支持此合并转发操作");
  }
  return {handle,forward,read,authorizeRead};
}
module.exports={createMessageForwardBundle};
