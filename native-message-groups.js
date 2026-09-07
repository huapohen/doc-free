"use strict";
const crypto=require("node:crypto");
const {messageHidden,personalMessagePreferences}=require("./native-message-personal");
const {problem,requireText}=require("./work-protocol");
const copy=value=>JSON.parse(JSON.stringify(value));
const owns=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const BUILTINS=Object.freeze([
  {id:"messages",name:"消息",description:"全部当前可见会话",fixed:true},
  {id:"unread",name:"未读",description:"有未读消息的会话"},
  {id:"marked",name:"标记",description:"本人标记的会话或包含本人已标记消息的会话，与顶部收藏独立"},
  {id:"mentions",name:"@我",description:"包含未撤回且提及本人的消息"},
  {id:"labels",name:"标签",description:"已归入本人任一个个人标签的会话；展开后按个人标签顺序显示"},
  {id:"direct",name:"单聊",description:"人与Agent的双人会话"},
  {id:"groups",name:"群组",description:"由人或Agent参与的群会话"},
  {id:"documents",name:"云文档",description:"已共享doc_free云文档且本人有文档访问权限的会话"},
  {id:"topics",name:"话题",description:"已明确创建且本人可见的消息话题所在会话，普通回复不会自动成为话题"},
  {id:"completed",name:"已完成",description:"本人标为完成的会话，不修改任务状态"},
  {id:"muted",name:"免打扰",description:"本人已开启免打扰的会话"},
  {id:"agents",name:"Agent单聊",description:"另一位参与者是Agent的双人会话"},
].map(Object.freeze));
const MAX_LABELS=20;
const DISPLAY_RULES=["always","unread","important","never"];
function labelContainerOrder(order,labels){
  const labelIds=new Set(labels.map(label=>label.id)),children=order.filter(id=>labelIds.has(id)),topLevel=order.filter(id=>!labelIds.has(id));
  topLevel.splice(topLevel.indexOf("labels")+1,0,...children);
  return topLevel;
}
// Add newly shipped filters without reordering an existing identity's choices.
// Reads project this additive schema; a successful personal write persists it.
function completeBuiltinOrder(current){
  const order=[...current.order];
  for(const id of ["labels","documents","topics"]){
    if(order.includes(id))continue;
    const preceding=BUILTINS.slice(0,BUILTINS.findIndex(group=>group.id===id)).map(group=>group.id).reverse().find(value=>order.includes(value));
    order.splice(order.indexOf(preceding)+1,0,id);
  }
  return {...current,layout_version:2,message_display_rules:current.message_display_rules||{},order:labelContainerOrder(order,current.labels)};
}
const empty=()=>({layout_version:2,revision:1,updated_at:null,order:BUILTINS.map(g=>g.id),hidden_ids:["muted","agents"],shortcut_ids:["messages","unread","mentions"],message_display_rules:{},labels:[],room_settings:{},create_keys:{}});
function createMessageGroups({state,stamp,persist,publishPersonalEvent,roomById,member,preferencesFor,isMentioned,notificationCounts,policies,pendingUrgentMessageIds,topicCount}){
  state.message_groups ||= {};
  for(const value of Object.values(state.message_groups))if(!Number.isSafeInteger(value.revision)||!Array.isArray(value.order)||!Array.isArray(value.hidden_ids)||!Array.isArray(value.shortcut_ids)||!Array.isArray(value.labels)||!value.room_settings||!value.create_keys)throw new Error("Personal message groups are corrupt; refusing to reset preferences");
  for(const value of Object.values(state.message_groups))if(value.message_display_rules!==undefined&&(!value.message_display_rules||typeof value.message_display_rules!=="object"||Array.isArray(value.message_display_rules)||Object.entries(value.message_display_rules).some(([id,rule])=>id==="messages"||!BUILTINS.some(group=>group.id===id)&&!value.labels.some(label=>label.id===id)||!DISPLAY_RULES.includes(rule))))throw new Error("Personal message display rules are corrupt; refusing to reset preferences");
  const record=p=>state.message_groups[p.id]?completeBuiltinOrder(state.message_groups[p.id]):empty();
  function authorizedRooms(p){return state.rooms.filter(room=>{try{member(room,p);return true;}catch{return false;}});}
  function grouping(room,p,current=record(p)){
    const saved=current.room_settings[room.id]||{},manual=(saved.group_ids||[]).filter(id=>current.labels.some(label=>label.id===id));
    const matched=current.labels.filter(label=>label.name_contains && room.name.toLocaleLowerCase().includes(label.name_contains.toLocaleLowerCase())).map(label=>label.id);
    const marked_message_count=room.messages.filter(message=>!message.retracted_at&&!messageHidden(state,p.id,message)&&personalMessagePreferences(state,p.id,message.id).marked).length;
    return {protocol:"message-grouping/v1",principal_id:p.id,room_id:room.id,group_ids:[...new Set([...manual,...matched])],manual_group_ids:[...manual],matched_group_ids:matched,marked:saved.marked===true,conversation_marked:saved.marked===true,marked_message_count,completed:saved.completed===true};
  }
  function snapshot(p,current=record(p)){
    const documentsAvailable=policies.allowed("docs",p.id);
    const rooms=authorizedRooms(p),groupings=new Map(rooms.map(room=>[room.id,grouping(room,p,current)]));
    const roomCounts=new Map(rooms.map(room=>[room.id,notificationCounts({...room,messages:room.messages.filter(message=>!messageHidden(state,p.id,message))},p.id,preferencesFor(room,p.id))]));
    const importantCounts=new Map(rooms.map(room=>{
      const preferences=preferencesFor(room,p.id),ids=new Set(room.messages.filter(message=>message.seq>preferences.read_seq&&!messageHidden(state,p.id,message)&&isMentioned(message,p.id,preferences)).map(message=>message.id));
      for(const id of pendingUrgentMessageIds(room,p))ids.add(id);
      return [room.id,ids.size];
    }));
    const unread=room=>roomCounts.get(room.id).unread_count;
    const matches=(id,room)=>{
      const personal=groupings.get(room.id);
      if(id==="messages"){
        const rules=current.message_display_rules||{},specific=personal.group_ids.filter(id=>owns(rules,id));
        const candidates=specific.length?specific:BUILTINS.filter(group=>group.id!=="messages"&&owns(rules,group.id)&&matches(group.id,room)).map(group=>group.id);
        const strictest=candidates.reduce((rank,id)=>Math.max(rank,DISPLAY_RULES.indexOf(rules[id])),0);
        return strictest===0||strictest===1&&unread(room)>0||strictest===2&&importantCounts.get(room.id)>0;
      }
      if(id==="unread")return unread(room)>0;
      if(id==="marked")return personal.marked||personal.marked_message_count>0;
      if(id==="completed")return personal.completed;
      if(id==="mentions")return room.messages.some(message=>!messageHidden(state,p.id,message)&&isMentioned(message,p.id,preferencesFor(room,p.id)));
      if(id==="labels")return personal.group_ids.length>0;
      if(id==="direct")return room.kind==="direct";
      if(id==="groups")return room.kind!=="direct";
      if(id==="documents")return documentsAvailable&&room.document_ids.length>0;
      if(id==="topics")return topicCount(room,p)>0;
      if(id==="muted")return preferencesFor(room,p.id).muted;
      if(id==="agents")return room.kind==="direct"&&Object.keys(room.members).some(pid=>pid!==p.id&&state.principals.some(person=>person.id===pid&&person.kind==="agent"));
      return personal.group_ids.includes(id);
    };
    const groups=current.order.map(id=>{
      const builtin=BUILTINS.find(group=>group.id===id),label=current.labels.find(group=>group.id===id),definition=builtin||label;
      if(!definition)throw new Error("Personal message group order references an unknown group");
      const selected=rooms.filter(room=>matches(id,room));
      return {id,name:definition.name,description:definition.description||"个人标签，不修改会话成员与权限",type:builtin?"builtin":"label",fixed:builtin?.fixed===true,visible:!current.hidden_ids.includes(id),available:id!=="documents"||documentsAvailable,
        ...(label?{parent_id:"labels"}:{}),
        message_display_rule:current.message_display_rules?.[id]||"always",
        name_contains:label?.name_contains||null,room_ids:selected.map(room=>room.id),room_count:selected.length,unread_count:selected.reduce((sum,room)=>sum+unread(room),0),
        mention_count:selected.reduce((sum,room)=>sum+roomCounts.get(room.id).mention_count,0),
        important_count:selected.reduce((sum,room)=>sum+importantCounts.get(room.id),0),
        notification_count:selected.reduce((sum,room)=>sum+roomCounts.get(room.id).notification_count,0)};
    });
    return {protocol:"message-groups/v1",layout_version:2,principal_id:p.id,revision:current.revision,updated_at:current.updated_at,order:[...current.order],hidden_ids:[...current.hidden_ids],shortcut_ids:[...current.shortcut_ids],message_display_rules:{...current.message_display_rules},groups};
  }
  function fields(input,allowed){if(Object.keys(input).some(key=>!allowed.includes(key)))throw problem(422,"invalid_message_groups","分组配置包含不支持的字段");}
  function revision(input,current){if(!Number.isSafeInteger(input.base_revision))throw problem(422,"version_required","请提供个人分组base_revision");if(input.base_revision!==current.revision)throw problem(409,"conflict","个人分组已变化，请保留本地编辑并读取最新版本");}
  function list(value,allowed,max,field){if(!Array.isArray(value)||value.length>max||new Set(value).size!==value.length||value.some(id=>typeof id!=="string"||!allowed.includes(id)))throw problem(422,"invalid_message_groups",`${field}必须为有效且不重复的分组ID列表`);return [...value];}
  function labelFields(input,current){
    const name=input.name===undefined&&current?current.name:requireText(input.name,"name",40);
    const name_contains=input.name_contains===undefined?(current?.name_contains||null):input.name_contains===null?null:requireText(input.name_contains,"name_contains",100);
    return {name,name_contains};
  }
  function uniqueName(current,name,except){if(current.labels.some(label=>label.id!==except&&label.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw problem(409,"group_name_exists","你已创建同名标签");}
  function commit(p,next,extra={}){
    next.layout_version=2;next.order=labelContainerOrder(next.order,next.labels);
    next.revision++;next.updated_at=stamp();state.message_groups[p.id]=next;
    publishPersonalEvent("message_groups.updated",p.id,{revision:next.revision},[p.id]);persist();
    return {...snapshot(p,next),...extra};
  }
  async function handle(method,pathname,input,p){
    const route=pathname==="/api/im/message-groups",labelRoute=pathname.match(/^\/api\/im\/message-groups\/(label-[a-f0-9-]+)$/),roomRoute=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/message-groups$/);
    if(!route&&!labelRoute&&!roomRoute)return undefined;
    const current=record(p);
    if(route&&method==="GET")return snapshot(p,current);
    if(roomRoute){
      const room=roomById(roomRoute[1]);member(room,p);
      if(method==="GET")return {revision:current.revision,room_grouping:grouping(room,p,current)};
      if(method!=="PATCH")throw problem(405,"method_not_allowed","会话分组支持读取与个人配置更新");
      fields(input,["base_revision","group_ids","marked","completed"]);revision(input,current);
      const saved={...current.room_settings[room.id]};
      if(input.group_ids!==undefined)saved.group_ids=list(input.group_ids,current.labels.map(label=>label.id),20,"group_ids");
      for(const field of ["marked","completed"])if(input[field]!==undefined){if(typeof input[field]!=="boolean")throw problem(422,"invalid_message_groups",`${field}必须为布尔值`);saved[field]=input[field];}
      const next=copy(current);next.room_settings[room.id]=saved;
      return commit(p,next,{room_grouping:grouping(room,p,next)});
    }
    if(route&&method==="POST"){
      fields(input,["base_revision","client_id","name","name_contains"]);
      const client=requireText(input.client_id,"client_id",160),key="intent:"+client,changes=labelFields(input),hash=crypto.createHash("sha256").update(JSON.stringify(changes)).digest("hex");
      if(owns(current.create_keys,key)){
        const known=current.create_keys[key];if(known.hash!==hash)throw problem(409,"idempotency_conflict","相同标签请求标识对应不同内容");
        if(!current.labels.some(label=>label.id===known.id))throw problem(409,"group_deleted","该请求创建的标签已经删除，不自动复活");
        return {...snapshot(p,current),created_group_id:known.id,duplicate:true};
      }
      revision(input,current);uniqueName(current,changes.name);
      if(current.labels.length>=20||Object.keys(current.create_keys).length>=500)throw problem(409,"limit_reached","最多20个个人标签，创建记录达到500次时需要新的工作空间");
      const next=copy(current),label={id:"label-"+crypto.randomUUID(),...changes};
      next.labels.push(label);next.order.push(label.id);next.create_keys[key]={id:label.id,hash};
      return commit(p,next,{created_group_id:label.id,duplicate:false});
    }
    if(route&&method==="PATCH"){
      fields(input,["base_revision","order","hidden_ids","shortcut_ids","message_display_rules"]);revision(input,current);const next=copy(current);
      if(input.order!==undefined){next.order=list(input.order,current.order,BUILTINS.length+MAX_LABELS,"order");if(next.order.length!==current.order.length||next.order[0]!=="messages")throw problem(422,"invalid_message_groups","排序须包含全部分组，消息固定首位");}
      if(input.hidden_ids!==undefined){next.hidden_ids=list(input.hidden_ids,current.order,BUILTINS.length+MAX_LABELS-1,"hidden_ids");if(next.hidden_ids.includes("messages"))throw problem(422,"fixed_group","消息分组不可隐藏");}
      if(input.shortcut_ids!==undefined){next.shortcut_ids=list(input.shortcut_ids,current.order,8,"shortcut_ids");if(next.shortcut_ids[0]!=="messages")throw problem(422,"fixed_group","常用分组须以消息开始");}
      if(input.message_display_rules!==undefined){
        const rules=input.message_display_rules;
        if(!rules||typeof rules!=="object"||Array.isArray(rules)||Object.entries(rules).some(([id,rule])=>id==="messages"||!current.order.includes(id)||!DISPLAY_RULES.includes(rule)))throw problem(422,"invalid_message_groups","消息展示规则须为现有分类ID与always/unread/important/never映射，不能配置消息自身");
        next.message_display_rules={...rules};
      }
      return commit(p,next);
    }
    if(labelRoute){
      const label=current.labels.find(label=>label.id===labelRoute[1]);if(!label)throw problem(404,"not_found","个人标签不存在");
      if(method==="GET")return {protocol:"message-groups/v1",principal_id:p.id,revision:current.revision,group:snapshot(p,current).groups.find(group=>group.id===label.id)};
      if(!["PATCH","DELETE"].includes(method))throw problem(405,"method_not_allowed","个人标签支持读取、修改与删除");
      fields(input,method==="PATCH"?["base_revision","name","name_contains","add_room_ids","remove_room_ids"]:["base_revision"]);revision(input,current);const next=copy(current);
      if(method==="PATCH"){
        const changes=labelFields(input,label);uniqueName(current,changes.name,label.id);
        const roomIds=field=>{
          const ids=input[field]===undefined?[]:input[field];
          if(!Array.isArray(ids)||ids.length>500||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"))throw problem(422,"invalid_message_groups",`${field}必须为不重复的会话ID列表`);
          for(const rid of ids)member(roomById(rid),p);
          return ids;
        };
        const additions=roomIds("add_room_ids"),removals=roomIds("remove_room_ids");
        if(additions.some(rid=>removals.includes(rid)))throw problem(422,"invalid_message_groups","同一会话不能同时添加和移除");
        Object.assign(next.labels.find(item=>item.id===label.id),changes);
        for(const rid of [...additions,...removals]){
          const saved=next.room_settings[rid]||{};saved.group_ids=(saved.group_ids||[]).filter(id=>id!==label.id);
          if(additions.includes(rid))saved.group_ids.push(label.id);next.room_settings[rid]=saved;
        }
      }else{
        next.labels=next.labels.filter(item=>item.id!==label.id);next.order=next.order.filter(id=>id!==label.id);next.hidden_ids=next.hidden_ids.filter(id=>id!==label.id);next.shortcut_ids=next.shortcut_ids.filter(id=>id!==label.id);
        delete next.message_display_rules[label.id];
        for(const settings of Object.values(next.room_settings))settings.group_ids=(settings.group_ids||[]).filter(id=>id!==label.id);
      }
      return commit(p,next,method==="DELETE"?{deleted_group_id:label.id}:{});
    }
    throw problem(405,"method_not_allowed","不支持此分组操作");
  }
  return {handle,grouping};
}
module.exports={createMessageGroups,BUILTINS};
