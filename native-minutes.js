"use strict";
const crypto = require("node:crypto");
const { problem, requireText } = require("./work-protocol");
const copy = value => JSON.parse(JSON.stringify(value));
const owns = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
const id = prefix => `${prefix}-${crypto.randomUUID()}`;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function createNativeMinutes({state,stamp,persist,event,roomById,member,active,policies,attachments}) {
  state.minutes ||= {records:[],create_keys:{}};
  const store = state.minutes;
  if (!Array.isArray(store.records) || !store.create_keys || store.records.some(m => !m.id || !m.room_id || !Number.isSafeInteger(m.revision) || !Array.isArray(m.transcript)))
    throw new Error("Minutes state is corrupt; refusing to reset shared records");
  function authorize(mid,p) {
    policies.requirePlugins(["minutes"],p);
    const minute = store.records.find(m=>m.id===mid);
    if(!minute)throw problem(404,"not_found","妙记不存在");
    const room=roomById(minute.room_id);member(room,p);return {minute,room};
  }
  function fields(input,current,room,p) {
    const result={};
    for(const key of Object.keys(input)) if(!["client_id","base_revision","title","meeting_id","audio_attachment_id","transcript","document_id","task_ids"].includes(key))
      throw problem(422,"invalid_minutes","妙记包含不支持的字段");
    if(!current||input.title!==undefined)result.title=requireText(input.title,"title",200);
    for(const field of ["meeting_id","audio_attachment_id","document_id"])
      if(input[field]!==undefined){
        if(input[field]!==null&&(typeof input[field]!=="string"||!input[field]||input[field].length>100))throw problem(422,"invalid_minutes","关联资源ID无效");
        result[field]=input[field];
      }
    if(result.meeting_id){
      policies.requireMeeting(p);
      if(!state.office.meetings.some(m=>m.id===result.meeting_id&&m.room_id===room.id))throw problem(403,"meeting_scope","会议不属于当前会话");
    }
    if(result.audio_attachment_id){
      policies.requirePlugins(["im"],p);
      const audio=attachments.forMessage(room,[result.audio_attachment_id])[0];
      // Generic attachments intentionally download as octet-stream. Filename
      // is only a user-supplied media hint, never a codec/transcription claim.
      if(!/^audio\//.test(audio.mime_type)&&! /\.(mp3|wav|m4a|aac|ogg|opus|flac|webm)$/i.test(audio.filename))throw problem(422,"invalid_audio_attachment","请选择当前会话中的音频附件");
    }
    if(result.document_id){
      policies.requirePlugins(["docs"],p);
      if(!room.document_ids.includes(result.document_id))throw problem(403,"document_scope","纪要文档未共享到当前会话");
    }
    if(input.task_ids!==undefined){
      if(!Array.isArray(input.task_ids)||input.task_ids.length>30||new Set(input.task_ids).size!==input.task_ids.length||input.task_ids.some(t=>typeof t!=="string"))throw problem(422,"invalid_minutes","关联任务最多30项且不可重复");
      if(input.task_ids.length)policies.requirePlugins(["tasks"],p);
      if(input.task_ids.some(tid=>!room.tasks.some(t=>t.id===tid)))throw problem(403,"task_scope","关联任务不属于当前会话");
      result.task_ids=[...input.task_ids];
    }
    if(input.transcript!==undefined){
      if(!Array.isArray(input.transcript)||input.transcript.length>200)throw problem(422,"invalid_transcript","逐字稿最多200段");
      let total=0,previous=0;const used=new Set();
      result.transcript=input.transcript.map(segment=>{
        if(!segment||typeof segment!=="object"||Array.isArray(segment)||Object.keys(segment).some(k=>!["id","speaker_id","speaker_label","offset_ms","text"].includes(k)))throw problem(422,"invalid_transcript","逐字稿段落格式无效");
        if(!Number.isSafeInteger(segment.offset_ms)||segment.offset_ms<previous||segment.offset_ms>86400000)throw problem(422,"invalid_transcript","时间需为0至24小时内非递减的毫秒数");
        previous=segment.offset_ms;
        const text=requireText(segment.text,"text",4000);total+=text.length;
        if(total>100000)throw problem(422,"invalid_transcript","逐字稿总长度超过100000字符");
        const speaker_id=segment.speaker_id??null;
        if(speaker_id!==null){if(typeof speaker_id!=="string")throw problem(422,"invalid_speaker","发言人无效");active(speaker_id);if(!owns(room.members,speaker_id))throw problem(403,"speaker_scope","已识别发言人必须是当前会话成员");}
        const speaker_label=segment.speaker_label===undefined||segment.speaker_label===""?"未标注发言人":requireText(segment.speaker_label,"speaker_label",100);
        if(segment.id!==undefined&&(!current?.transcript.some(s=>s.id===segment.id)||used.has(segment.id)))throw problem(422,"invalid_segment","段落ID不属于当前修订或重复");
        const sid=segment.id||id("segment");used.add(sid);
        return{id:sid,speaker_id,speaker_label:speaker_id?active(speaker_id).name:speaker_label,offset_ms:segment.offset_ms,text};
      });
    }
    return result;
  }
  function view(minute,p,full=true){
    const result=copy(minute);
    if(!["meetings","calendar","docs"].every(id=>policies.allowed(id,p.id)))result.meeting_id=null;
    if(!policies.allowed("docs",p.id))result.document_id=null;
    if(!policies.allowed("tasks",p.id))result.task_ids=[];
    result.audio_attachment=null;
    if(result.audio_attachment_id&&policies.allowed("im",p.id)){
      try{result.audio_attachment=attachments.forMessage(roomById(minute.room_id),[result.audio_attachment_id])[0];}
      catch{result.audio_attachment_id=null;}
    }else result.audio_attachment_id=null;
    result.transcription={status:"provider_not_configured",provider:null};
    result.summary={status:"not_generated"};
    result.transcript_source="manual_or_imported";
    result.segment_count=minute.transcript.length;
    result.transcript_count=minute.transcript.length;
    if(!full)delete result.transcript;
    return result;
  }
  async function handle(method,pathname,input,p,params=new URLSearchParams()){
    const collection=pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/minutes$/);
    if((pathname==="/api/im/minutes"||collection)&&method==="GET"){
      policies.requirePlugins(["minutes"],p);
      const rid=collection?.[1]||params.get("room_id");if(rid)member(roomById(rid),p);
      const query=params.get("q")?requireText(params.get("q"),"q",100).toLocaleLowerCase():"";
      const values=store.records.filter(m=>{
        try{member(roomById(m.room_id),p);}catch{return false;}
        return(!rid||m.room_id===rid)&&(!query||`${m.title}\n${m.transcript.map(s=>s.text).join("\n")}`.toLocaleLowerCase().includes(query));
      }).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
      return{minutes:values.slice(0,200).map(m=>view(m,p,false)),truncated:values.length>200};
    }
    if(collection&&method==="POST"){
      policies.requirePlugins(["minutes"],p);const room=roomById(collection[1]);member(room,p);
      const client=requireText(input.client_id,"client_id",160),key=`${p.id}:${room.id}:${client}`,hash=digest(input);
      if(owns(store.create_keys,key)){
        const known=store.create_keys[key];if(known.hash!==hash)throw problem(409,"idempotency_conflict","相同请求标识的妙记内容不同");
        return{minute:view(authorize(known.id,p).minute,p),duplicate:true};
      }
      if(store.records.length>=2000||store.records.filter(m=>m.room_id===room.id).length>=200)throw problem(409,"limit_reached","妙记数量达到本机预览上限");
      const changes=fields(input,null,room,p);
      const minute={id:id("minute"),room_id:room.id,meeting_id:null,audio_attachment_id:null,document_id:null,task_ids:[],transcript:[],
        ...changes,revision:1,created_by:p.id,updated_by:p.id,created_at:stamp(),updated_at:stamp()};
      store.records.push(minute);store.create_keys[key]={id:minute.id,hash};
      event(room,"minute.created",p.id,{minute_id:minute.id,revision:minute.revision});persist();return{minute:view(minute,p),duplicate:false};
    }
    const detail=pathname.match(/^\/api\/im\/minutes\/(minute-[a-f0-9-]+)$/);
    if(!detail)return undefined;
    const {minute,room}=authorize(detail[1],p);
    if(method==="GET")return{minute:view(minute,p)};
    if(method!=="PATCH")throw problem(405,"method_not_allowed","妙记支持读取和修订");
    if(!Number.isSafeInteger(input.base_revision))throw problem(422,"version_required","请提供base_revision");
    if(input.base_revision!==minute.revision)throw problem(409,"conflict","妙记已更新，请保留本地编辑并读取最新版本");
    const changes=fields(input,minute,room,p);Object.assign(minute,changes,{revision:minute.revision+1,updated_by:p.id,updated_at:stamp()});
    event(room,"minute.updated",p.id,{minute_id:minute.id,revision:minute.revision});persist();return{minute:view(minute,p)};
  }
  return{handle,authorize};
}
module.exports={createNativeMinutes};
