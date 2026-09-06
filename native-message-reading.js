"use strict";
const {messageHidden}=require("./native-message-personal");
const {problem,requireText}=require("./work-protocol");
const membershipKey=member=>member.joined_seq!==undefined?`seq:${member.joined_seq}`:`legacy:${member.joined_at||"unknown"}`;
const number=(value,fallback,min=0)=>{
  const parsed=value===null||value===undefined?fallback:Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<min||parsed>Number.MAX_SAFE_INTEGER)throw problem(422,"invalid_input","无效消息窗口游标");
  return parsed;
};
const limitFor=params=>{const value=number(params.get("limit"),100,1);if(value>200)throw problem(422,"invalid_input","消息窗口最多200条");return value;};
function createMessageReading({state,stamp,preferencesFor,messageView,currentMessageView}){
  function recipients(room,authorId){
    const snapshots=Object.keys(room.members).filter(pid=>pid!==authorId).sort().map(pid=>{
      const person=state.principals.find(value=>value.id===pid);
      return {principal_id:pid,name:person?.name||"",kind:person?.kind||null,membership_key:membershipKey(room.members[pid])};
    });
    return {recipient_snapshot_version:1,recipient_ids:snapshots.map(value=>value.principal_id),recipient_snapshots:snapshots};
  }
  function acknowledgement(room,pid,key=membershipKey(room.members[pid])){
    return room.read_acknowledgements?.[pid]?.[key]||{read_seq:0,at:null};
  }
  function acknowledge(room,pid,sequence){
    const key=membershipKey(room.members[pid]),previous=acknowledgement(room,pid,key);
    if(sequence<=previous.read_seq)return false;
    room.read_acknowledgements||={};room.read_acknowledgements[pid]||={};
    room.read_acknowledgements[pid][key]={read_seq:sequence,at:stamp()};
    return true;
  }
  function receipt(room,message){
    const known=message.recipient_snapshot_version===1&&Array.isArray(message.recipient_snapshots)&&!message.retracted_at;
    if(!known)return {known:false,basis:message.retracted_at?"message_retracted":"legacy_unknown",eligible_count:null,read_count:null,unread_count:null,unknown_count:null};
    const read=message.recipient_snapshots.filter(recipient=>acknowledgement(room,recipient.principal_id,recipient.membership_key).read_seq>=message.seq).length;
    return {known:true,basis:"explicit_read_ack",eligible_count:message.recipient_snapshots.length,read_count:read,unread_count:message.recipient_snapshots.length-read,unknown_count:0};
  }
  function readers(room,message){
    const summary=receipt(room,message);
    return {message_id:message.id,receipt_summary:summary,readers:!summary.known?[]:message.recipient_snapshots.map(recipient=>{
      const ack=acknowledgement(room,recipient.principal_id,recipient.membership_key),read=ack.read_seq>=message.seq;
      const member=room.members[recipient.principal_id];
      return {principal_id:recipient.principal_id,name:recipient.name,kind:recipient.kind,status:read?"read":"unread",read,
        current_member:Boolean(member),same_membership:Boolean(member&&membershipKey(member)===recipient.membership_key),
        read_ack_seq:ack.read_seq,acknowledged_at:read?ack.at:null};
    })};
  }
  const unread=(room,pid)=>room.messages.filter(message=>!messageHidden(state,pid,message)&&!message.retracted_at&&message.author_id!==pid&&message.seq>preferencesFor(room,pid).read_seq);
  function window(room,pid,params){
    const limit=limitFor(params),first=params.get("first_unread");
    if(first!==null&&!["true","false"].includes(first))throw problem(422,"invalid_input","first_unread必须为布尔值");
    const firstUnread=first==="true",modes=["before","after","around"].filter(key=>params.has(key));
    if(modes.length+Number(firstUnread)>1)throw problem(422,"invalid_input","消息窗口定位参数不能混用");
    if(params.has("q")&&(firstUnread||params.has("around")))throw problem(422,"invalid_input","未读或锚点窗口不与正文搜索混用");
    const query=params.has("q")?requireText(params.get("q"),"q",100).trim().toLocaleLowerCase():null;
    const messages=room.messages.filter(message=>!messageHidden(state,pid,message)&&(query===null||(!message.retracted_at&&message.content.toLocaleLowerCase().includes(query))));
    const pending=unread(room,pid),first_unread_seq=pending[0]?.seq??null;
    let start=0,end=messages.length,anchor_seq=null,emptyBoundary=0;
    const nextIndex=(seq,inclusive)=>{const index=messages.findIndex(message=>inclusive?message.seq>=seq:message.seq>seq);return index<0?messages.length:index;};
    if(firstUnread&&first_unread_seq!==null){
      start=nextIndex(first_unread_seq,true);end=Math.min(messages.length,start+limit);anchor_seq=first_unread_seq;
    }else if(params.has("around")){
      const requested=number(params.get("around"),null,1);
      const index=Math.min(nextIndex(requested,true),messages.length-1);
      if(index>=0){anchor_seq=messages[index].seq;start=Math.max(0,index-Math.floor((limit-1)/2));end=Math.min(messages.length,start+limit);start=Math.max(0,end-limit);}
    }else if(params.has("after")){
      const after=number(params.get("after"),null);emptyBoundary=after;
      start=nextIndex(after,false);end=Math.min(messages.length,start+limit);
    }else{
      const before=number(params.get("before"),Number.MAX_SAFE_INTEGER,1);emptyBoundary=before-1;
      end=nextIndex(before,true);start=Math.max(0,end-limit);
    }
    const selected=messages.slice(start,end),last=selected.at(-1)?.seq??emptyBoundary;
    return {messages:selected.map(message=>messageView(room,message,{id:pid})),has_more:start>0,
      has_more_before:start>0,has_more_after:end<messages.length,before_cursor:selected[0]?.seq??null,after_cursor:selected.at(-1)?.seq??null,
      anchor_seq,first_unread_seq,read_seq:preferencesFor(room,pid).read_seq,unread_count:pending.length,
      remaining_unread_after:pending.filter(message=>message.seq>last).length};
  }
  function thread(room,root,params,pid){
    if([...params.keys()].some(key=>!["after","limit"].includes(key)))throw problem(422,"invalid_input","话题读取只支持after和limit");
    const limit=limitFor(params),after=number(params.get("after"),0),ids=new Set([root.id]),replies=[];
    // reply_to is immutable and must reference an already-existing message in
    // this room. Agent execution root_id is deliberately not the reply graph.
    for(const message of room.messages)if(message.id!==root.id&&ids.has(message.reply_to)){ids.add(message.id);replies.push(message);}
    const visibleReplies=replies.filter(message=>!messageHidden(state,pid,message));
    const remaining=visibleReplies.filter(message=>message.seq>after),selected=remaining.slice(0,limit),has_more=remaining.length>limit;
    return {root_message:currentMessageView(room,root,{id:pid}),messages:selected.map(message=>currentMessageView(room,message,{id:pid})),total_replies:visibleReplies.length,
      has_more,next_after:has_more?selected.at(-1).seq:null,after_cursor:selected.at(-1)?.seq??after};
  }
  return {recipients,acknowledgement,acknowledge,receipt,readers,window,thread};
}
module.exports={createMessageReading};
