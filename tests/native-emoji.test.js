"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im"),{nativeMCP,publicTools}=require("../native-im-mcp");
const catalog=require("../native-emoji-catalog.json");
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-emoji-"));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(temporary,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex");
  const options={file,adminToken:admin,workspace:{handle:async()=>{throw new Error("Unexpected document operation");}}};
  let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>{const url=new URL("http://fixture/api/im"+route);return im.handle(method,url.pathname,input,who.token??who,url.searchParams);};
  const enroll=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await enroll("Human"),agent=await enroll("Agent","agent"),outside=await enroll("Outside");
  const recent=(who=human)=>call(who,"/emoji/recents");
  const use=(who,emoji)=>call(who,"/emoji/recents","POST",{emoji});
  const mcp=(who,name,args={})=>nativeMCP(im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  return {file,admin,human,agent,outside,call,recent,use,mcp,restart:()=>im=createNativeIM(options)};
}
test("catalog is a complete read-only paginated directory searchable by Chinese, English, exact IDs and category for both actors",async()=>{
  const f=await fixture(),before=fs.readFileSync(f.file,"utf8"),ids=[];
  let offset=0;
  do{
    const page=await f.call(f.agent,"/emoji?limit=200&offset="+offset);
    assert.equal(page.version,catalog.version);assert.equal(page.catalog_count,4126);assert.equal(page.total,catalog.count);
    assert.ok(page.entries.length<=200);ids.push(...page.entries.map(entry=>entry.id));
    assert.equal(page.has_more,page.next_offset!==null);offset=page.next_offset;
  }while(offset!==null);
  assert.equal(new Set(ids).size,catalog.count);assert.deepEqual(ids,catalog.entries.map(entry=>entry.id));
  for(const who of [f.human,f.agent]){
    for(const q of ["feishu:SMILE","嘿嘿","grinning face","😀"]){
      const result=await f.call(who,"/emoji?"+new URLSearchParams({q}));assert.ok(result.total>0);
      assert.ok(result.entries.some(entry=>q==="feishu:SMILE"?entry.id===q:entry.id==="😀"));
    }
    const classic=await f.call(who,"/emoji?"+new URLSearchParams({category:"经典表情",limit:"200"}));
    assert.equal(classic.total,182);assert.ok(classic.entries.every(entry=>entry.id.startsWith("feishu:")));
    assert.equal(classic.entries.find(entry=>entry.id==="feishu:SMILE").asset,"assets/emoji/feishu/SMILE.png");
  }
  assert.deepEqual(await f.recent(),{emoji_ids:[],entries:[],limit:32,updated_at:null});
  assert.equal(fs.readFileSync(f.file,"utf8"),before,"legacy reads never add state or a new revision");
  const source=await f.call(f.human,"/emoji?limit=1");source.entries[0].aliases.length=0;source.entries[0].id="changed";source.categories.length=0;
  assert.deepEqual((await f.call(f.human,"/emoji?limit=1")).entries[0],catalog.entries[0]);
});
test("catalog and recents reject malformed input and cross-principal selectors without altering any stored state",async()=>{
  const f=await fixture(),before=fs.readFileSync(f.file,"utf8");
  for(const query of ["offset=-1","offset=1.5","limit=0","limit=201","limit=Infinity","category=made-up","principal_id=x","q="+"a".repeat(101)])
    await assert.rejects(f.call(f.human,"/emoji?"+query),{status:422,code:"invalid_input"});
  for(const emoji of [null,{},["👍"],true,"__proto__","feishu:DOES_NOT_EXIST","text","",":feishu:SMILE:"])
    await assert.rejects(f.use(f.human,emoji),{status:422,code:"invalid_reaction"});
  await assert.rejects(f.call(f.human,"/emoji/recents?principal_id="+f.agent.principal.id),{status:422});
  await assert.rejects(f.call(f.human,"/emoji/recents","POST",{emoji:"👍",principal_id:f.agent.principal.id}),{status:422});
  await assert.rejects(f.call(f.human,"/emoji","POST",{emoji:"👍"}),{status:405});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
});
test("personal recents retain 32 distinct IDs, promote reuse, persist across restart and publish only to the current identity",async()=>{
  const f=await fixture(),ids=catalog.entries.slice(0,35).map(entry=>entry.id);
  for(const emoji of ids)await f.use(f.human,emoji);
  const expected=ids.slice(3).reverse();assert.deepEqual((await f.recent()).emoji_ids,expected);
  const repeated=await f.use(f.human,expected[5]);assert.deepEqual(repeated.emoji_ids,[expected[5],...expected.filter(id=>id!==expected[5])]);
  const stable=fs.readFileSync(f.file,"utf8");await f.use(f.human,expected[5]);assert.equal(fs.readFileSync(f.file,"utf8"),stable,"front duplicate is a no-op");
  assert.deepEqual((await f.recent(f.agent)).emoji_ids,[]);
  await Promise.all([f.use(f.agent,"🎉"),f.use(f.agent,"😀"),f.use(f.agent,"🎉")]);
  assert.deepEqual((await f.recent(f.agent)).emoji_ids,["🎉","😀"]);assert.deepEqual(await f.recent(),repeated);
  const visible=(await f.call(f.agent,"/events")).events.filter(event=>event.type==="emoji.recents.updated");
  assert.equal(visible.length,3);assert.ok(visible.every(event=>event.actor_id===f.agent.principal.id&&event.audience_ids.length===1&&event.audience_ids[0]===f.agent.principal.id));
  repeated.emoji_ids.length=0;repeated.entries[0].name="Caller mutation";f.restart();
  assert.equal((await f.recent()).emoji_ids.length,32);assert.notEqual((await f.recent()).entries[0].name,"Caller mutation");
});
test("Unicode variants and classic reactions use the same actor recents and retain member and application permissions",async()=>{
  const f=await fixture(),{room}=await f.call(f.human,"/rooms","POST",{name:"Emoji recipients"}),base="/rooms/"+room.id;
  await f.call(f.human,base+"/members","POST",{principal_id:f.agent.principal.id});
  const {message}=await f.call(f.human,base+"/messages","POST",{content:"React here",client_id:crypto.randomUUID()}),route=base+"/messages/"+message.id+"/reactions";
  const variant=catalog.entries.find(entry=>entry.id.includes("🏽")&&entry.id.includes("‍")).id;
  for(const who of [f.human,f.agent])for(const emoji of ["👍",variant,"feishu:SMILE"]){
    const response=await f.call(who,route,"POST",{emoji});assert.ok(response.message.reactions[emoji].includes(who.principal.id));assert.equal((await f.recent(who)).emoji_ids[0],emoji);
  }
  await f.use(f.human,"🎉");await f.call(f.human,route,"POST",{emoji:"feishu:SMILE"});
  assert.equal((await f.recent()).emoji_ids[0],"🎉","reaction removal does not promote the removed emoji");
  assert.deepEqual((await f.call(f.human,base+"/messages/"+message.id)).message.reactions["feishu:SMILE"],[f.agent.principal.id]);
  const before=fs.readFileSync(f.file,"utf8");
  await assert.rejects(f.call(f.outside,route,"POST",{emoji:"😀"}),{code:"not_a_member"});
  await assert.rejects(f.call(f.human,route,"POST",{emoji:"not-an-emoji"}),{code:"invalid_reaction"});assert.equal(fs.readFileSync(f.file,"utf8"),before);
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  for(const route of ["/emoji","/emoji/recents"])await assert.rejects(f.call(f.agent,route),{code:"app_policy_denied"});
  await assert.rejects(f.use(f.agent,"😀"),{code:"app_policy_denied"});
  await assert.rejects(f.call(f.agent,route,"POST",{emoji:"😀"}),{code:"app_policy_denied"});
});
test("Human and Agent MCP discover emoji by search without a huge schema enum and update only their own recents",async()=>{
  const f=await fixture(),parse=response=>JSON.parse(response.result.content[0].text);
  assert.deepEqual(publicTools.find(tool=>tool.name==="im_react").inputSchema.properties.emoji,{type:"string"});
  assert.ok(JSON.stringify(publicTools.filter(tool=>/emoji|im_react/.test(tool.name))).length<6500);
  for(const who of [f.human,f.agent]){
    const search=await f.mcp(who,"im_emoji_catalog",{q:"feishu:SMILE",limit:1});assert.equal(search.result.isError,false);assert.equal(parse(search).entries[0].id,"feishu:SMILE");
    const used=await f.mcp(who,"im_use_emoji",{emoji:"feishu:SMILE"});assert.equal(used.result.isError,false);assert.deepEqual(parse(used).emoji_ids,["feishu:SMILE"]);
    assert.deepEqual(parse(await f.mcp(who,"im_recent_emoji")).emoji_ids,["feishu:SMILE"]);
    assert.equal((await f.mcp(who,"im_use_emoji",{emoji:"😀",principal_id:f.outside.principal.id})).result.isError,true);
  }
  assert.deepEqual((await f.recent(f.outside)).emoji_ids,[]);
});
test("reaction and recents fail-stop together when persistence fails and restart restores their last durable values",async()=>{
  const f=await fixture(),{room}=await f.call(f.human,"/rooms","POST",{name:"Atomic reaction"}),base="/rooms/"+room.id;
  const {message}=await f.call(f.human,base+"/messages","POST",{content:"Keep durable",client_id:crypto.randomUUID()});
  await f.use(f.human,"🎉");const before=await f.recent(),rename=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("Fixture emoji save failure");return rename(source,target);};
  try{await assert.rejects(f.call(f.human,base+"/messages/"+message.id+"/reactions","POST",{emoji:"feishu:SMILE"}),{code:"storage_failed"});}finally{fs.renameSync=rename;}
  await assert.rejects(f.recent(),{code:"storage_failed"});f.restart();assert.deepEqual(await f.recent(),before);
  assert.deepEqual((await f.call(f.human,base+"/messages/"+message.id)).message.reactions,{});
});

test("Human and Agent clear only their own recents through HTTP and MCP, without changing reactions or committing failed clears",async()=>{
  const f=await fixture(),before=fs.readFileSync(f.file,"utf8");
  assert.deepEqual((await f.call(f.human,"/emoji/recents","DELETE")).emoji_ids,[]);assert.equal(fs.readFileSync(f.file,"utf8"),before);
  await f.use(f.human,"😀");await f.use(f.agent,"feishu:SMILE");const originalAgent=await f.recent(f.agent);
  const {room}=await f.call(f.human,"/rooms","POST",{name:"Clear recents preserves reactions"}),base="/rooms/"+room.id;
  const {message}=await f.call(f.human,base+"/messages","POST",{content:"Retain reaction",client_id:crypto.randomUUID()});
  await f.call(f.human,base+"/messages/"+message.id+"/reactions","POST",{emoji:"😀"});
  await assert.rejects(f.call(f.human,"/emoji/recents","DELETE",{principal_id:f.agent.principal.id}),{status:422});
  await assert.rejects(f.call(f.human,"/emoji/recents?principal_id="+f.agent.principal.id,"DELETE"),{status:422});
  assert.deepEqual((await f.call(f.human,"/emoji/recents","DELETE")).emoji_ids,[]);assert.deepEqual(await f.recent(f.agent),originalAgent);
  assert.deepEqual((await f.call(f.human,base+"/messages/"+message.id)).message.reactions["😀"],[f.human.principal.id]);
  const stable=fs.readFileSync(f.file,"utf8");await f.call(f.human,"/emoji/recents","DELETE");assert.equal(fs.readFileSync(f.file,"utf8"),stable);
  const rename=fs.renameSync;fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("Fixture clear save failure");return rename(source,target);};
  try{await assert.rejects(f.call(f.agent,"/emoji/recents","DELETE"),{code:"storage_failed"});}finally{fs.renameSync=rename;}
  f.restart();assert.deepEqual(await f.recent(f.agent),originalAgent);
  const response=await f.mcp(f.agent,"im_clear_recent_emoji");assert.equal(response.result.isError,false);assert.deepEqual(JSON.parse(response.result.content[0].text).emoji_ids,[]);
  f.restart();assert.deepEqual((await f.recent()).emoji_ids,[]);assert.deepEqual((await f.recent(f.agent)).emoji_ids,[]);
  const events=(await f.call(f.agent,"/events")).events.filter(event=>event.type==="emoji.recents.updated");
  assert.equal(events.length,2);assert.ok(events.every(event=>event.actor_id===f.agent.principal.id));
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  await assert.rejects(f.call(f.agent,"/emoji/recents","DELETE"),{code:"app_policy_denied"});
});
