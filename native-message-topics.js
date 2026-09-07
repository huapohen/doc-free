"use strict";
const crypto=require("node:crypto");
const {problem,requireText}=require("./work-protocol");
const {messageHidden}=require("./native-message-personal");
const copy=value=>JSON.parse(JSON.stringify(value));

// Topics are explicit shared anchors. Ordinary reply_to edges and Agent
// execution root_id values never create or identify a topic.
function createMessageTopics({state,stamp,persist,event,roomById,member,messageView}){
  if(state.message_topics===undefined)state.message_topics=[];
  if(state.message_topic_keys===undefined)state.message_topic_keys={};
  const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
  if(!Array.isArray(state.message_topics)||!object(state.message_topic_keys)||state.message_topics.some(topic=>!object(topic)||typeof topic.id!=="string"||typeof topic.room_id!=="string"||typeof topic.root_message_id!=="string"||typeof topic.created_by!=="string"||typeof topic.created_at!=="string"||topic.revision!==1||!Number.isSafeInteger(topic.seq)||topic.seq<1)||new Set(state.message_topics.map(topic=>topic.id)).size!==state.message_topics.length||new Set(state.message_topics.map(topic=>`${topic.room_id}:${topic.root_message_id}`)).size!==state.message_topics.length||Object.values(state.message_topic_keys).some(key=>!object(key)||typeof key.hash!=="string"||!state.message_topics.some(topic=>topic.id===key.id)))throw new Error("Explicit message topics are corrupt; refusing to reset shared records");
  function source(room,messageId,p){
    const message=room.messages.find(message=>message.id===messageId);
    if(!message)throw problem(404,"not_found","话题根消息不存在于当前会话");
    if(messageHidden(state,p.id,message))throw problem(409,"message_hidden","本人已隐藏话题根消息");
    if(message.retracted_at)throw problem(409,"message_retracted","话题根消息已撤回");
    return message;
  }
  function authorize(id,p){
    const topic=state.message_topics.find(topic=>topic.id===id);
    if(!topic)throw problem(404,"not_found","话题不存在");
    const room=roomById(topic.room_id);member(room,p);
    return {topic,room,message:source(room,topic.root_message_id,p)};
  }
  const topicView=topic=>({protocol:"message-topic/v1",...copy(topic)});
  const result=(topic,room,message,p)=>({topic:topicView(topic),root_message:messageView(room,message,p)});
  function visible(room,p){
    return state.message_topics.filter(topic=>topic.room_id===room.id).filter(topic=>{try{source(room,topic.root_message_id,p);return true;}catch{return false;}});
  }
  function visibleEvent(entry,p){
    if(!entry.topic_id)return true;
    try{authorize(entry.topic_id,p);return true;}catch{return false;}
  }
  function handle(method,pathname,input,p,params){
    const create=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/messages\/(msg-[a-f0-9-]+)\/topic$/);
    const route=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/topics(?:\/(topic-[a-f0-9-]+))?$/);
    if(!create&&!route)return undefined;
    const room=roomById((create||route)[1]);member(room,p);
    if(create){
      if(method!=="POST")throw problem(405,"method_not_allowed","创建话题请使用POST，读取请使用话题清单");
      if(Object.keys(input).some(key=>!["client_id","base_revision"].includes(key)))throw problem(422,"invalid_topic","创建话题不接受额外字段或身份覆盖");
      const clientId=requireText(input.client_id,"client_id",160),message=source(room,create[2],p);
      if(!Number.isSafeInteger(input.base_revision)||input.base_revision<1)throw problem(422,"version_required","请提供话题根消息base_revision");
      const key=`${p.id}:${room.id}:${clientId}`,hash=crypto.createHash("sha256").update(JSON.stringify({root_message_id:message.id,base_revision:input.base_revision})).digest("hex"),known=state.message_topic_keys[key];
      if(known){
        if(known.hash!==hash)throw problem(409,"idempotency_conflict","同一client_id对应不同话题意图");
        const old=authorize(known.id,p);return {...result(old.topic,old.room,old.message,p),duplicate:true};
      }
      if((message.revision||1)!==input.base_revision)throw problem(409,"conflict","话题根消息已变化，请读取当前版本");
      if(Object.keys(state.message_topic_keys).filter(key=>key.startsWith(`${p.id}:${room.id}:`)).length>=1000)throw problem(409,"limit_reached","当前身份在此会话的话题创建记录已达1000条");
      let topic=state.message_topics.find(topic=>topic.room_id===room.id&&topic.root_message_id===message.id),duplicate=Boolean(topic);
      if(!topic){
        if(state.message_topics.filter(topic=>topic.room_id===room.id).length>=1000)throw problem(409,"limit_reached","每个会话最多1000个显式话题");
        topic={id:`topic-${crypto.randomUUID()}`,room_id:room.id,root_message_id:message.id,created_by:p.id,created_at:stamp(),revision:1,seq:state.sequence+1};
        state.message_topics.push(topic);
        event(room,"message.topic.created",p.id,{topic_id:topic.id,root_message_id:message.id});
      }
      state.message_topic_keys[key]={id:topic.id,hash};persist();
      return {...result(topic,room,message,p),duplicate};
    }
    if(method!=="GET")throw problem(405,"method_not_allowed","话题清单和话题详情仅支持读取");
    if(route[2]){
      const found=authorize(route[2],p);
      if(found.room.id!==room.id)throw problem(404,"not_found","话题不属于当前会话");
      return result(found.topic,room,found.message,p);
    }
    if([...params.keys()].some(key=>!["before","limit"].includes(key)))throw problem(422,"invalid_topic","话题清单仅支持before和limit");
    const before=Number(params.get("before")??Number.MAX_SAFE_INTEGER),limit=Number(params.get("limit")??100);
    if(!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(limit)||limit<1||limit>200)throw problem(422,"invalid_topic","无效话题分页参数");
    const all=visible(room,p).filter(topic=>topic.seq<before).sort((a,b)=>b.seq-a.seq),selected=all.slice(0,limit);
    return {room_id:room.id,topics:selected.map(topic=>({...topicView(topic),root_message:messageView(room,source(room,topic.root_message_id,p),p)})),has_more:all.length>limit,next_before:all.length>limit?selected.at(-1).seq:null};
  }
  return {handle,authorize,visibleEvent,count:(room,p)=>visible(room,p).length};
}
module.exports={createMessageTopics};
