"use strict";
const crypto=require("node:crypto");
const {problem,requireText}=require("./work-protocol");
const {messageHidden}=require("./native-message-personal");
const copy=value=>JSON.parse(JSON.stringify(value));
const cycle=membership=>membership?.joined_seq!==undefined?`seq:${membership.joined_seq}`:`legacy:${membership?.joined_at||"unknown"}`;
function createMessageUrgency({state,stamp,persist,publishPersonalEvent,roomById,member,active,messageView}){
  if(state.message_urgencies===undefined)state.message_urgencies=[];
  if(state.message_urgency_keys===undefined)state.message_urgency_keys={};
  const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
  if(!Array.isArray(state.message_urgencies)||!object(state.message_urgency_keys)||
      state.message_urgencies.some(record=>!object(record)||typeof record.id!=="string"||!Number.isSafeInteger(record.seq)||record.seq<1||!Number.isSafeInteger(record.revision)||record.revision<1||!Number.isSafeInteger(record.message_revision)||record.message_revision<1||typeof record.creator_membership_key!=="string"||!Array.isArray(record.recipients)||!record.recipients.length||record.recipients.some(recipient=>!object(recipient)||typeof recipient.principal_id!=="string"||typeof recipient.membership_key!=="string"||recipient.acknowledged_at!==null&&typeof recipient.acknowledged_at!=="string")||record.channel!=="in_app")||
      new Set(state.message_urgencies.map(record=>record.id)).size!==state.message_urgencies.length||
      Object.values(state.message_urgency_keys).some(value=>!object(value)||typeof value.hash!=="string"||!state.message_urgencies.some(record=>record.id===value.id)))throw new Error("Message urgency state is corrupt");
  function find(id){const record=state.message_urgencies.find(record=>record.id===id);if(!record)throw problem(404,"not_found","加急请求不存在");return record;}
  function currentMembership(room,pid,membershipKey){
    const person=state.principals.find(person=>person.id===pid),membership=room.members[pid];
    return Boolean(person&&!person.disabled_at&&!person.revoked_at&&membership&&cycle(membership)===membershipKey);
  }
  function recipient(record,pid){return record.recipients.find(recipient=>recipient.principal_id===pid);}
  function authorize(record,p){
    const room=roomById(record.room_id);member(room,p);const own=recipient(record,p.id);
    if(record.created_by!==p.id&&(!own||!currentMembership(room,p.id,own.membership_key)))throw problem(403,"urgency_scope","仅发送者或本次成员周期的指定接收者可查看加急");
    return room;
  }
  function sourceState(room,record){
    const message=room.messages.find(message=>message.id===record.message_id);
    return {message,status:!message?"missing":message.retracted_at?"retracted":(message.revision||1)!==record.message_revision?"changed":"current"};
  }
  function view(record,p){
    const room=authorize(record,p),source=sourceState(room,record),sender=record.created_by===p.id;
    const senderAvailable=currentMembership(room,record.created_by,record.creator_membership_key),activeSource=source.status==="current"&&senderAvailable;
    const selected=sender?record.recipients:record.recipients.filter(recipient=>recipient.principal_id===p.id);
    const recipients=selected.map(recipient=>({principal_id:recipient.principal_id,name:recipient.name,kind:recipient.kind,acknowledged_at:recipient.acknowledged_at??null,
      current_member:Boolean(room.members[recipient.principal_id]),same_membership:currentMembership(room,recipient.principal_id,recipient.membership_key),
      status:recipient.acknowledged_at?"acknowledged":activeSource&&currentMembership(room,recipient.principal_id,recipient.membership_key)?"pending":"unavailable"}));
    const counts={total:recipients.length,acknowledged:recipients.filter(recipient=>recipient.status==="acknowledged").length,pending:recipients.filter(recipient=>recipient.status==="pending").length,unavailable:recipients.filter(recipient=>recipient.status==="unavailable").length};
    const hidden=messageHidden(state,p.id,source.message),status=hidden?"source_hidden":source.status!=="current"?"source_"+source.status:!senderAvailable?"sender_unavailable":counts.pending?"pending":counts.unavailable?"unavailable":"acknowledged";
    return {id:record.id,seq:record.seq,room_id:room.id,message_id:record.message_id,message_revision:record.message_revision,channel:record.channel,
      created_by:record.created_by,created_at:record.created_at,revision:record.revision,status,source_status:hidden?"hidden":source.status,
      message:source.message?messageView(room,source.message,p):null,recipients,counts,summary_scope:sender?"sender":"self",
      can_ack:!sender&&status==="pending"&&recipients[0]?.status==="pending"};
  }
  function visibleEvent(event,p){
    if(!event.urgency_id)return true;
    try{const record=find(event.urgency_id),room=authorize(record,p);return !messageHidden(state,p.id,room.messages.find(message=>message.id===record.message_id));}catch{return false;}
  }
  function authorizeTurn(turn,p){
    const urgencyId=turn.context?.trigger?.urgency_id;
    if(!urgencyId)return;
    const record=find(urgencyId),room=authorize(record,p);
    // A target may inspect its own run, never another target's assignment.
    if(p.id!==record.created_by&&p.id!==turn.principal_id)throw problem(403,"urgency_scope","私有加急运行仅属于发送者和本次执行者");
    if(messageHidden(state,p.id,room.messages.find(message=>message.id===record.message_id)))throw problem(403,"urgency_scope","本人已隐藏此私有加急运行的来源消息");
  }
  function visibleTurn(turn,p){try{authorizeTurn(turn,p);return true;}catch{return false;}}
  function trigger(room,p,event){
    if(event.type!=="message.urgency.created"||event.source_room_id!==room.id||!event.audience_ids?.includes(p.id))return null;
    try{
      const record=find(event.urgency_id),result=view(record,p);
      if(!result.can_ack)return null;
      const rootId="private-"+crypto.createHash("sha256").update(JSON.stringify([record.id,p.id])).digest("hex");
      return {...copy(event),room_id:room.id,event_room_id:null,audience_ids:[p.id],root_id:rootId,message:result.message,depth:0};
    }catch{return null;}
  }
  function list(room,p,params){
    if([...params.keys()].some(key=>!["box","status","limit","before"].includes(key)))throw problem(422,"invalid_input","加急清单仅支持box/status/limit/before");
    const box=params.get("box")||"all",status=params.get("status")||"all",limit=Number(params.get("limit")??50),before=Number(params.get("before")??Number.MAX_SAFE_INTEGER);
    if(!["all","inbox","sent"].includes(box)||!["all","pending"].includes(status)||!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)throw problem(422,"invalid_input","无效加急清单过滤或分页");
    const all=state.message_urgencies.filter(record=>record.room_id===room.id&&record.seq<before&&(box!=="sent"||record.created_by===p.id)&&(box!=="inbox"||record.created_by!==p.id)).flatMap(record=>{try{const result=view(record,p);return status==="pending"&&!result.can_ack&&!(result.summary_scope==="sender"&&result.status==="pending")?[]:[result];}catch{return [];}}).sort((a,b)=>b.seq-a.seq);
    const items=all.slice(0,limit);return {items,has_more:all.length>limit,next_before:all.length>limit?items.at(-1).seq:null};
  }
  function handle(method,pathname,input,p,params){
    const create=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/messages\/(msg-[a-f0-9-]+)\/urgencies$/);
    const route=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/urgencies(?:\/(urgency-[a-f0-9-]+)(?:\/(ack))?)?$/);
    if(!create&&!route)return undefined;
    const room=roomById((create||route)[1]);member(room,p);
    if(create){
      if(method!=="POST")throw problem(405,"method_not_allowed","请通过会话加急清单读取请求");
      if(Object.keys(input).some(key=>!["client_id","base_revision","recipient_ids","channel"].includes(key)))throw problem(422,"invalid_input","加急不接受身份覆盖或额外渠道字段");
      const clientId=requireText(input.client_id,"client_id",160),ids=input.recipient_ids;
      if(input.channel!=="in_app")throw problem(422,"unsupported_channel","目前仅实现站内加急，短信与电话渠道未连接");
      if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"||id===p.id||!Object.hasOwn(room.members,id)))throw problem(422,"invalid_recipients","请选择1到100位不重复的当前会话其他成员");
      const people=ids.map(active),source=room.messages.find(message=>message.id===create[2]);
      if(!source)throw problem(404,"not_found","来源消息不存在于当前会话");
      if(source.author_id!==p.id)throw problem(403,"author_required","只能对自己发送的消息发起加急");
      if(messageHidden(state,p.id,source))throw problem(409,"message_hidden","请先恢复本人隐藏的消息");
      if(source.retracted_at)throw problem(409,"message_retracted","已撤回消息不能加急");
      if(!Number.isSafeInteger(input.base_revision)||input.base_revision<1)throw problem(422,"version_required","请提供来源消息base_revision");
      if((source.revision||1)!==input.base_revision)throw problem(409,"conflict","来源消息已变化");
      const hash=crypto.createHash("sha256").update(JSON.stringify({room_id:room.id,message_id:source.id,revision:input.base_revision,recipient_ids:[...ids].sort(),channel:input.channel})).digest("hex"),key=`${p.id}:${room.id}:${clientId}`,old=state.message_urgency_keys[key];
      if(old){if(old.hash!==hash)throw problem(409,"idempotency_conflict","同一client_id对应不同加急意图");return {urgency:view(find(old.id),p),duplicate:true};}
      if(state.message_urgencies.filter(record=>record.room_id===room.id).length>=1000)throw problem(409,"limit_reached","当前会话已达本地加急记录上限");
      const record={id:`urgency-${crypto.randomUUID()}`,seq:state.sequence+1,room_id:room.id,message_id:source.id,message_revision:source.revision||1,channel:"in_app",created_by:p.id,created_at:stamp(),creator_membership_key:cycle(room.members[p.id]),revision:1,
        recipients:people.map(person=>({principal_id:person.id,name:person.name,kind:person.kind,membership_key:cycle(room.members[person.id]),acknowledged_at:null}))};
      state.message_urgencies.push(record);state.message_urgency_keys[key]={id:record.id,hash};
      publishPersonalEvent("message.urgency.created",p.id,{source_room_id:room.id,message_id:source.id,urgency_id:record.id,message_revision:record.message_revision,channel:"in_app"},[p.id,...ids]);persist();
      return {urgency:view(record,p),duplicate:false};
    }
    if(!route[2]&&method==="GET")return list(room,p,params);
    if(!route[2])throw problem(405,"method_not_allowed","加急清单仅支持读取");
    const record=find(route[2]);if(record.room_id!==room.id)throw problem(404,"not_found","加急请求不属于当前会话");authorize(record,p);
    if(!route[3]&&method==="GET")return {urgency:view(record,p)};
    if(route[3]==="ack"&&method==="POST"){
      if(Object.keys(input).length)throw problem(422,"invalid_input","确认加急仅属于当前身份，不接受覆盖字段");
      const own=recipient(record,p.id);if(!own)throw problem(403,"urgency_recipient_required","仅指定接收者可确认自己的加急");
      if(own.acknowledged_at)return {urgency:view(record,p),duplicate:true};
      const source=sourceState(room,record);
      if(messageHidden(state,p.id,source.message))throw problem(409,"message_hidden","请先恢复本人隐藏的来源消息");
      if(source.status==="retracted")throw problem(409,"message_retracted","来源消息已撤回，加急已失效");
      if(source.status!=="current")throw problem(409,"conflict","来源消息已变化，请发送者重新确认后发起加急");
      if(!currentMembership(room,record.created_by,record.creator_membership_key))throw problem(409,"sender_unavailable","发送者已离开本次会话成员周期，加急已失效");
      own.acknowledged_at=stamp();record.revision++;
      publishPersonalEvent("message.urgency.acknowledged",p.id,{source_room_id:room.id,message_id:record.message_id,urgency_id:record.id,urgency_revision:record.revision},[record.created_by,p.id]);persist();
      return {urgency:view(record,p),duplicate:false};
    }
    throw problem(405,"method_not_allowed","不支持此加急操作");
  }
  return {handle,view,find,authorize,visibleEvent,authorizeTurn,visibleTurn,trigger,list};
}
module.exports={createMessageUrgency};
