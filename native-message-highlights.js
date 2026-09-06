"use strict";
const {problem}=require("./work-protocol");
const {messageHidden}=require("./native-message-personal");
const copy=value=>JSON.parse(JSON.stringify(value));
function createMessageHighlights({state,stamp,persist,event,publishPersonalEvent,roomById,member,messageView}){
  for(const room of state.rooms){
    const value=room.message_highlights;
    if(value!==undefined&&(!value||!Number.isSafeInteger(value.revision)||value.revision<1||!value.preferences||typeof value.preferences!=="object"||Array.isArray(value.preferences)||Object.values(value.preferences).some(saved=>!saved||typeof saved!=="object"||Array.isArray(saved)||saved.collapsed_revision!==null&&(!Number.isSafeInteger(saved.collapsed_revision)||saved.collapsed_revision<1))||value.item!==null&&(!value.item||typeof value.item.message_id!=="string"||!Number.isSafeInteger(value.item.message_revision)||value.item.message_revision<1)))throw new Error("Message highlights are corrupt");
  }
  const record=room=>room.message_highlights||{revision:1,item:null,preferences:{}};
  function snapshot(room,p){
    const value=record(room),saved=value.preferences[p.id]||{},source=value.item&&room.messages.find(message=>message.id===value.item.message_id);
    const items=!source||messageHidden(state,p.id,source)?[]:[{...copy(value.item),message:messageView(room,source,p),source_status:source.retracted_at?"retracted":(source.revision||1)===value.item.message_revision?"current":"updated"}];
    return {revision:value.revision,items,collapsed:saved.collapsed_revision===value.revision,collapsed_revision:saved.collapsed_revision??null,max_items:1,
      permissions:{can_set:true,can_clear:true,basis:"current_room_member"}};
  }
  function expected(input,value){
    if(!Number.isSafeInteger(input.base_revision)||input.base_revision<1)throw problem(422,"version_required","请提供当前顶栏的base_revision");
    if(input.base_revision!==value.revision)throw problem(409,"conflict","顶栏消息已变化，请刷新后重试");
  }
  function handle(method,pathname,input,p){
    const match=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/highlights(?:\/(preferences))?$/);
    if(!match)return undefined;
    const room=roomById(match[1]);member(room,p);const value=record(room);
    if(method==="GET"&&!match[2])return snapshot(room,p);
    if(method!=="PATCH")throw problem(405,"method_not_allowed","顶栏支持读取和版本化修改");
    expected(input,value);
    if(match[2]){
      if(Object.keys(input).some(key=>!["base_revision","collapsed"].includes(key))||typeof input.collapsed!=="boolean")throw problem(422,"invalid_input","只能设置本人顶栏collapsed布尔值");
      if(input.collapsed&&!value.item)throw problem(409,"no_highlight","没有可收起的顶栏消息");
      const revision=input.collapsed?value.revision:null;
      if((value.preferences[p.id]?.collapsed_revision??null)!==revision){
        value.preferences[p.id]={collapsed_revision:revision,updated_at:stamp()};room.message_highlights=value;
        publishPersonalEvent("message.highlight.preferences.updated",p.id,{source_room_id:room.id,highlight_revision:value.revision,collapsed:input.collapsed},[p.id]);persist();
      }
    }else{
      if(Object.keys(input).some(key=>!["base_revision","message_id","message_revision"].includes(key))||!Object.hasOwn(input,"message_id")||(input.message_id!==null&&typeof input.message_id!=="string"))throw problem(422,"invalid_input","设置顶栏须指定消息ID，取消时传message_id:null");
      let item=null;
      if(input.message_id!==null){
        const source=room.messages.find(message=>message.id===input.message_id);
        if(!source)throw problem(404,"not_found","消息不在当前会话");
        if(messageHidden(state,p.id,source))throw problem(409,"message_hidden","请先恢复本人隐藏的消息");
        if(source.retracted_at)throw problem(409,"message_retracted","已撤回消息不能置顶");
        if(!Number.isSafeInteger(input.message_revision)||input.message_revision<1)throw problem(422,"version_required","请提供来源消息message_revision");
        if((source.revision||1)!==input.message_revision)throw problem(409,"conflict","来源消息已变化，请刷新后重试");
        item={message_id:source.id,message_revision:source.revision||1,set_by:p.id,set_at:stamp()};
      }else if(input.message_revision!==undefined)throw problem(422,"invalid_input","取消顶栏不接受message_revision");
      if(value.item?.message_id!==item?.message_id||value.item?.message_revision!==item?.message_revision){
        value.item=item;value.revision++;room.message_highlights=value;
        event(room,"message.highlight.updated",p.id,{highlight_revision:value.revision,message_id:item?.message_id??null});persist();
      }
    }
    return snapshot(room,p);
  }
  return {snapshot,handle};
}
module.exports={createMessageHighlights};
