"use strict";
const {problem}=require("./work-protocol");

function mentionAllValue(room,value=false){
  if(typeof value!=="boolean")throw problem(422,"invalid_mentions","mention_all 必须为布尔值");
  if(value&&room.kind==="direct")throw problem(409,"group_required","@所有人仅适用于群聊");
  return value;
}
function mentionAllFields(room,authorId,input,previous){
  if(Object.hasOwn(input,"mention_all_ids"))throw problem(422,"invalid_mentions","@所有人目标由服务端按当前群成员生成");
  const enabled=mentionAllValue(room,input.mention_all===undefined?previous?.mention_all===true:input.mention_all);
  return {mention_all:enabled,mention_all_ids:!enabled?[]:previous?.mention_all===true
    ? [...(previous.mention_all_ids||[])]:Object.keys(room.members).filter(id=>id!==authorId).sort()};
}
function mentionKinds(message,principalId){
  const eligible=!message.retracted_at&&message.author_id!==principalId;
  return {explicit:eligible&&message.mentions?.includes(principalId)===true,
    all:eligible&&message.mention_all===true&&message.mention_all_ids?.includes(principalId)===true};
}
function isMentioned(message,principalId,preferences){
  const kinds=mentionKinds(message,principalId);
  return kinds.explicit||(kinds.all&&!preferences.mute_all_mentions);
}
function notificationCounts(room,principalId,preferences){
  let unread_count=0,mention_count=0,explicit_mention_count=0,all_mention_count=0;
  for(const message of room.messages){
    if(message.retracted_at||message.author_id===principalId||message.seq<=preferences.read_seq)continue;
    unread_count++;
    const kinds=mentionKinds(message,principalId);
    if(kinds.explicit)explicit_mention_count++;
    if(kinds.all)all_mention_count++;
    if(isMentioned(message,principalId,preferences))mention_count++;
  }
  return {unread_count,mention_count,explicit_mention_count,all_mention_count,
    notification_count:preferences.folded?0:preferences.muted?mention_count:unread_count};
}
module.exports={mentionAllValue,mentionAllFields,isMentioned,notificationCounts};
