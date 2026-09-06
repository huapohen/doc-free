"use strict";
const crypto=require("node:crypto");
const {problem,requireText}=require("./work-protocol");
const {messageHidden,forwardingBlocked}=require("./native-message-personal");
const copy=value=>JSON.parse(JSON.stringify(value));
const fence=text=>{const longest=Math.max(2,...[...text.matchAll(/`+/g)].map(match=>match[0].length));return `${"`".repeat(longest+1)}text\n${text}\n${"`".repeat(longest+1)}`;};
function createMessageMaterialize({state,stamp,persist,policies,active,reduceTask,createDocument,readDocument,messageAuthor}){
  state.message_materializations||={};
  if(!state.message_materializations||typeof state.message_materializations!=="object"||Array.isArray(state.message_materializations))throw new Error("Message source materializations are corrupt");
  async function materialize(room,p,operation,input){
    const documentOperation=operation==="export-document";
    policies.requirePlugins(["im",documentOperation?"docs":"tasks"],p);
    const allowed=["client_id","message_ids","base_revisions","title",...(documentOperation?["content"]:["description","assignee_id"])];
    if(Object.keys(input).some(key=>!allowed.includes(key)))throw problem(422,"invalid_input","消息来源操作包含不支持的字段");
    const clientId=requireText(input.client_id,"client_id",160),title=requireText(input.title,"title",200),providedIds=input.message_ids,revisions=input.base_revisions;
    if(!Array.isArray(providedIds)||providedIds.length<1||providedIds.length>50||new Set(providedIds).size!==providedIds.length||providedIds.some(id=>typeof id!=="string"))throw problem(422,"invalid_message_sources","需要1到50个不重复的当前会话消息ID");
    const ids=[...providedIds];
    if(!revisions||typeof revisions!=="object"||Array.isArray(revisions)||Object.keys(revisions).length!==ids.length||Object.keys(revisions).some(id=>!ids.includes(id))||ids.some(id=>!Object.hasOwn(revisions,id)||!Number.isSafeInteger(revisions[id])||revisions[id]<1))throw problem(422,"invalid_message_sources","base_revisions须精确包含每条来源消息的版本");
    const sources=ids.map(id=>{
      const message=room.messages.find(item=>item.id===id);
      if(!message)throw problem(404,"not_found","来源消息不存在于当前会话");
      if(messageHidden(state,p.id,message))throw problem(409,"message_hidden","请先恢复本人隐藏的来源消息");
      if(message.retracted_at)throw problem(409,"message_retracted","来源消息已撤回");
      if(forwardingBlocked(state,room,message))throw problem(403,"forwarding_disabled","来源消息禁止转发或导出");
      if((message.revision||1)!==revisions[id])throw problem(409,"conflict","来源消息已变化，请刷新并重新确认");
      return message;
    });
    const extra=input[documentOperation?"content":"description"]??"";
    if(typeof extra!=="string"||extra.length>(documentOperation?120000:12000))throw problem(422,"invalid_input","补充说明必须是长度受限的文字");
    if(!documentOperation&&input.assignee_id){active(input.assignee_id);if(!Object.hasOwn(room.members,input.assignee_id))throw problem(422,"invalid_assignee","负责人必须是当前会话成员");}
    const sourceRevisions=Object.fromEntries(ids.map(id=>[id,revisions[id]]));
    const digest=crypto.createHash("sha256").update(JSON.stringify({operation,room_id:room.id,ids,revisions:sourceRevisions,title,extra,assignee_id:input.assignee_id||null})).digest("hex");
    const key=`${p.id}:${room.id}:${operation}:${clientId}`,previous=state.message_materializations[key];
    if(previous){
      if(previous.hash!==digest)throw problem(409,"idempotency_conflict","相同client_id对应不同的消息来源操作");
      if(previous.status!=="completed")throw problem(503,"outcome_pending","前次文档创建结果未确认，请检查来源操作记录，不能自动重复创建");
      const resource=documentOperation?await readDocument(previous.resource_id,p,room):room.tasks.find(task=>task.id===previous.resource_id);
      if(!resource)throw problem(409,"resource_unavailable","已创建的来源资源不再可用");
      return {[documentOperation?"document":"task"]:copy(resource),source_message_ids:[...ids],source_message_revisions:{...sourceRevisions},duplicate:true};
    }
    const sourceBody=sources.map(message=>{
      const author=messageAuthor(room,message.author_id,message.author);
      const metadata={room_id:room.id,message_id:message.id,revision:message.revision||1,author_id:message.author_id,author:author.display_name||author.name,at:message.at,
        attachments:(message.attachments||[]).map(item=>({id:item.id,filename:item.filename,mime_type:item.mime_type,download_path:item.download_path}))};
      return `### ${String(metadata.author||"参与者").replace(/[\r\n]/g," ")} · ${message.at}\n\n${fence(message.content)}\n\n${fence(JSON.stringify(metadata,null,2))}`;
    }).join("\n\n");
    const body=`${extra.trim()?"## 补充说明\n\n"+extra+"\n\n":""}## 来源消息\n\n${sourceBody}`;
    if(body.length>(documentOperation?200000:12000))throw problem(422,"source_content_too_large",documentOperation?"来源正文过长，请减少所选消息":"来源内容超过任务描述上限，请减少消息或改为导出文档");
    const record={hash:digest,client_id:clientId,principal_id:p.id,room_id:room.id,operation,source_message_ids:ids,source_message_revisions:sourceRevisions,created_at:stamp(),status:"pending"};
    let resource;
    if(documentOperation){
      if(room.document_ids.length>=50)throw problem(409,"limit_reached","每个会话最多50篇文档");
      // Persist the intent before crossing the canonical-document boundary.
      // A lost response remains pending; retry never creates a second document.
      state.message_materializations[key]=record;persist();
      try{resource=await createDocument(room,p,{title,content:body},{source_message_ids:ids,source_message_revisions:sourceRevisions});}
      catch(error){record.last_error={code:error.code||"outcome_unknown",at:stamp()};persist();throw problem(503,"outcome_pending","文档创建结果未确认，保留来源意图以检查实际结果，不能自动重复创建");}
    }else{
      resource=reduceTask("create",room,p,{title,description:body,assignee_id:input.assignee_id},{source_message_ids:ids,source_message_revisions:sourceRevisions});
      state.message_materializations[key]=record;
    }
    Object.assign(record,{status:"completed",resource_id:resource.id,completed_at:stamp()});persist();
    return {[documentOperation?"document":"task"]:copy(resource),source_message_ids:[...ids],source_message_revisions:{...sourceRevisions},duplicate:false};
  }
  function operations(room,p,params){
    if([...params.keys()].some(key=>!["client_id","operation"].includes(key)))throw problem(422,"invalid_input","来源操作状态只支持client_id和operation");
    if(params.has("operation")&&!["export-document","create-task"].includes(params.get("operation")))throw problem(422,"invalid_input","无效来源操作类型");
    const records=Object.values(state.message_materializations).filter(record=>record.principal_id===p.id&&record.room_id===room.id&&(!params.has("client_id")||record.client_id===params.get("client_id"))&&(!params.has("operation")||record.operation===params.get("operation"))&&policies.allowed(record.operation==="export-document"?"docs":"tasks",p.id));
    return {operations:records.slice(-100).reverse().map(({hash,...record})=>copy(record)),truncated:records.length>100};
  }
  return {materialize,operations};
}
module.exports={createMessageMaterialize};
