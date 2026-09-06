"use strict";
const {problem}=require("./work-protocol");
const catalog=require("./native-emoji-catalog.json");
const entries=new Map(catalog.entries.map(entry=>[entry.id,entry]));
if(entries.size!==catalog.entries.length||catalog.count!==entries.size)
  throw new Error("Native emoji catalog has duplicate IDs or an invalid count");
const normalize=value=>value.normalize("NFKC").toLocaleLowerCase();
const searchable=catalog.entries.map(entry=>({entry,search:normalize([entry.id,entry.code,entry.name,entry.text,entry.category,entry.group,entry.subgroup,...entry.aliases].filter(Boolean).join(" "))}));
const QUICK_REACTIONS=Object.freeze(["👍","❤️","🎉","👀","✅","🙏"]);
const validateEmoji=emoji=>{
  if(typeof emoji!=="string"||!entries.has(emoji))throw problem(422,"invalid_reaction","请从表情目录选择有效的表情ID");
  return emoji;
};
function createNativeEmoji({state,stamp,persist,publishPersonalEvent}){
  function recents(p){
    const saved=state.emoji_recents?.[p.id];
    const emoji_ids=[...new Set((saved?.emoji_ids||[]).filter(id=>entries.has(id)))].slice(0,32);
    return {emoji_ids,entries:emoji_ids.map(id=>structuredClone(entries.get(id))),limit:32,updated_at:saved?.updated_at||null};
  }
  // Called within the IM's serialized mutation queue; the caller persists once
  // with the message mutation so reaction and private recents are atomic.
  function remember(p,emoji){
    validateEmoji(emoji);
    const previous=recents(p);
    if(previous.emoji_ids[0]===emoji)return false;
    state.emoji_recents||={};
    state.emoji_recents[p.id]={emoji_ids:[emoji,...previous.emoji_ids.filter(id=>id!==emoji)].slice(0,32),updated_at:stamp()};
    publishPersonalEvent("emoji.recents.updated",p.id,{},[p.id]);
    return true;
  }
  async function handle(method,pathname,input,p,params=new URLSearchParams()){
    if(pathname!=="/api/im/emoji"&&pathname!=="/api/im/emoji/recents")return undefined;
    if(pathname.endsWith("/recents")){
      if([...params.keys()].length)throw problem(422,"invalid_input","最近表情只属于当前登录身份，不接受查询参数");
      if(method==="GET")return recents(p);
      if(method==="DELETE"){
        if(Object.keys(input).length)throw problem(422,"invalid_input","清空最近表情不接受目标身份或其它字段");
        if(recents(p).emoji_ids.length){
          state.emoji_recents[p.id]={emoji_ids:[],updated_at:stamp()};
          publishPersonalEvent("emoji.recents.updated",p.id,{},[p.id]);persist();
        }
        return recents(p);
      }
      if(method!=="POST")throw problem(405,"method_not_allowed","不支持此表情操作");
      if(Object.keys(input).some(key=>key!=="emoji"))throw problem(422,"invalid_input","只能更新本人最近使用的表情");
      if(remember(p,input.emoji))persist();
      return recents(p);
    }
    if(method!=="GET")throw problem(405,"method_not_allowed","表情目录只读");
    if([...params.keys()].some(key=>!["q","category","offset","limit"].includes(key)))throw problem(422,"invalid_input","无效表情目录查询参数");
    const q=params.get("q")||"",category=params.get("category")||null;
    if(q.length>100||category!==null&&!catalog.categories.includes(category))throw problem(422,"invalid_input","无效表情搜索或分类");
    const offset=params.has("offset")?Number(params.get("offset")):0,limit=params.has("limit")?Number(params.get("limit")):100;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)
      throw problem(422,"invalid_input","表情目录offset必须非负，limit为1到200");
    const words=normalize(q).trim().split(/\s+/).filter(Boolean);
    const matches=searchable.filter(({entry,search})=>(category===null||entry.category===category)&&words.every(word=>search.includes(word)));
    const page=matches.slice(offset,offset+limit),has_more=offset+page.length<matches.length;
    return {version:catalog.version,unicode_version:catalog.unicode_version,categories:[...catalog.categories],catalog_count:catalog.count,
      total:matches.length,offset,limit,has_more,next_offset:has_more?offset+page.length:null,entries:page.map(({entry})=>structuredClone(entry))};
  }
  return {handle,remember};
}
module.exports={createNativeEmoji,validateEmoji,QUICK_REACTIONS};
