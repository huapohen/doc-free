"use strict";
const {problem}=require("./work-protocol");
const personalMessagePreferences=(state,pid,mid)=>({marked:false,hidden:false,updated_at:null,...(state.message_preferences?.[pid]?.[mid]||{})});
const messageHidden=(state,pid,message)=>Boolean(pid&&message&&personalMessagePreferences(state,pid,message.id).hidden);
function forwardingBlocked(state,room,message,visited=new Set()){
  if(!message||visited.has(message.id))return false;
  visited.add(message.id);
  if(message.no_forward)return true;
  const origin=message.forwarded_from;
  if(!origin)return false;
  const source=state.rooms.find(value=>value.id===origin.room_id);
  return Boolean(source&&forwardingBlocked(state,source,source.messages.find(value=>value.id===origin.message_id),visited));
}
function createMessagePersonal({state,stamp,persist,publishPersonalEvent,messageView,cancelRunning}){
  state.message_preferences||={};
  if(typeof state.message_preferences!=="object"||Array.isArray(state.message_preferences)||Object.values(state.message_preferences).some(owner=>!owner||typeof owner!=="object"||Array.isArray(owner)||Object.values(owner).some(value=>!value||typeof value.marked!=="boolean"||typeof value.hidden!=="boolean")))throw new Error("Native personal message preferences are corrupt");
  function update(room,message,p,input){
    const keys=Object.keys(input);
    if(!keys.length||keys.some(key=>!["marked","hidden"].includes(key)||typeof input[key]!=="boolean"))
      throw problem(422,"invalid_input","只能设置本人消息标记或隐藏状态，值必须为布尔值");
    if(input.marked===true&&message.retracted_at)throw problem(409,"message_retracted","已撤回消息不能添加标记");
    const previous=personalMessagePreferences(state,p.id,message.id),changed=keys.some(key=>previous[key]!==input[key]);
    if(changed){
      const current={...previous,...input,updated_at:stamp()};
      state.message_preferences[p.id]||={};state.message_preferences[p.id][message.id]=current;
      if(input.hidden===true)cancelRunning(room,p.id,p.id,"本人已隐藏上下文消息，重新获取可见上下文后继续");
      publishPersonalEvent("message.preferences.updated",p.id,{source_room_id:room.id,message_id:message.id,personal_preferences:current},[p.id]);
      persist();
    }
    return {message:messageView(room,message,p),personal_preferences:personalMessagePreferences(state,p.id,message.id),changed};
  }
  function list(p,kind,params){
    if([...params.keys()].some(key=>!["limit","before","room_id"].includes(key)))throw problem(422,"invalid_input","消息清单只支持limit、before和room_id");
    const limit=Number(params.get("limit")??50),before=Number(params.get("before")??Number.MAX_SAFE_INTEGER);
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)throw problem(422,"invalid_input","无效消息清单分页");
    const candidates=state.rooms.filter(room=>Object.hasOwn(room.members,p.id)&&(!params.has("room_id")||room.id===params.get("room_id"))).flatMap(room=>room.messages
      .filter(message=>message.seq<before&&personalMessagePreferences(state,p.id,message.id)[kind]&&(kind==="hidden"||!messageHidden(state,p.id,message)))
      .map(message=>({room_id:room.id,room_name:room.name,message}))).sort((a,b)=>b.message.seq-a.message.seq);
    const chosen=candidates.slice(0,limit);
    return {items:chosen.map(item=>({...item,message:messageView(state.rooms.find(room=>room.id===item.room_id),item.message,p)})),has_more:candidates.length>limit,next_before:candidates.length>limit?chosen.at(-1).message.seq:null};
  }
  return {update,list};
}
module.exports={createMessagePersonal,personalMessagePreferences,messageHidden,forwardingBlocked};
