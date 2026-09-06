"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im");
const {nativeMCP,publicTools}=require("../native-im-mcp");
const {DEFAULTS,DESKTOP_NAV_IDS,MOBILE_NAV_IDS}=require("../native-settings");
const expectedDesktop=["messages","agents","contacts","docs","tasks","workbench","meetings","calendar","mail","attendance","approvals","minutes"];
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"native-desktop-nav-"));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(temporary,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex");
  const options={file,adminToken:admin,workspace:{handle:async()=>{throw new Error("Unexpected document operation");}}};
  let im=createNativeIM(options);
  const call=(who,route="/settings",method="GET",input={})=>im.handle(method,"/api/im"+route,input,who.token??who);
  const human=await call(admin,"/admin/principals","POST",{name:"Human",kind:"human"});
  const agent=await call(admin,"/admin/principals","POST",{name:"Agent",kind:"agent"});
  const mcp=(who,name,args={})=>nativeMCP(im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  const read=async(who=human)=>(await call(who)).settings;
  const patch=async(who,base_revision,changes)=>(await call(who,"/settings","PATCH",{base_revision,...changes})).settings;
  return {file,admin,human,agent,call,mcp,read,patch,restart:()=>im=createNativeIM(options)};
}

test("legacy settings gain the exact desktop sidebar read-only and permit removing Messages and Agents without touching mobile order",async()=>{
  const f=await fixture(),state=JSON.parse(fs.readFileSync(f.file));
  const legacy={message_alignment:"left",send_shortcut:"mod_enter",text_scale:1.15,show_message_preview:false,time_format:"12h",mobile_nav:["mail","enterprise"],revision:9,updated_at:"2026-09-06T01:00:00Z"};
  state.personal_settings[f.human.principal.id]=legacy;fs.writeFileSync(f.file,JSON.stringify(state));f.restart();
  const before=fs.readFileSync(f.file,"utf8"),initial=await f.read();
  assert.deepEqual(DESKTOP_NAV_IDS,expectedDesktop);assert.deepEqual(initial,{...legacy,desktop_nav:expectedDesktop});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  let saved=initial;
  for(const desktop_nav of [["mail"],["tasks","docs","messages"],[...expectedDesktop].reverse(),expectedDesktop]){
    saved=await f.patch(f.human,saved.revision,{desktop_nav});assert.deepEqual(saved.desktop_nav,desktop_nav);
    for(const [key,value] of Object.entries(legacy))if(!["revision","updated_at"].includes(key))assert.deepEqual(saved[key],value);
  }
  assert.equal(saved.revision,13);f.restart();assert.deepEqual(await f.read(),saved);
  assert.deepEqual((await f.read(f.agent)).desktop_nav,expectedDesktop);assert.equal((await f.read(f.agent)).revision,1);
});

test("desktop and mobile retain independent values while sharing one per-identity CAS and private update events",async()=>{
  const f=await fixture();
  const human=await f.patch(f.human,1,{desktop_nav:["mail","contacts"]});
  assert.deepEqual(human.mobile_nav,DEFAULTS.mobile_nav);
  const mobile=await f.patch(f.human,2,{mobile_nav:["enterprise","tasks"]});
  assert.deepEqual(mobile.desktop_nav,["mail","contacts"]);
  const agent=await f.patch(f.agent,1,{desktop_nav:["minutes"],mobile_nav:["calendar"]});
  assert.equal(agent.revision,2);assert.deepEqual((await f.read()).desktop_nav,["mail","contacts"]);
  const race=await Promise.allSettled([
    f.patch(f.human,3,{desktop_nav:["docs"]}),
    f.patch(f.human,3,{mobile_nav:["messages"]}),
  ]);
  assert.equal(race.filter(result=>result.status==="fulfilled").length,1);
  assert.equal(race.find(result=>result.status==="rejected").reason.code,"conflict");
  const current=await f.read();assert.equal(current.revision,4);
  if(race[0].status==="fulfilled")assert.deepEqual(current.mobile_nav,mobile.mobile_nav);
  else assert.deepEqual(current.desktop_nav,mobile.desktop_nav);
  assert.deepEqual(await f.read(f.agent),agent);
  const visible=(await f.call(f.agent,"/events")).events.filter(event=>event.type==="settings.updated");
  assert.equal(visible.length,1);assert.deepEqual(visible[0].audience_ids,[f.agent.principal.id]);
  const all=JSON.parse(fs.readFileSync(f.file)).events.filter(event=>event.type==="settings.updated");
  assert.equal(all.length,4);assert.ok(all.every(event=>event.audience_ids.length===1&&event.audience_ids[0]===event.actor_id));
});

test("desktop navigation rejects malformed or privileged IDs atomically and all input/response arrays are deeply isolated",async()=>{
  const f=await fixture(),input=["docs","calendar"];
  const response=await f.patch(f.human,1,{desktop_nav:input});input.push("mail");response.desktop_nav.reverse();response.mobile_nav.length=0;
  const expected=await f.read();assert.deepEqual(expected.desktop_nav,["docs","calendar"]);assert.deepEqual(expected.mobile_nav,DEFAULTS.mobile_nav);
  const before=fs.readFileSync(f.file,"utf8");
  for(const desktop_nav of [[],["docs","docs"],[...expectedDesktop,"mail"],["enterprise"],["settings"],["more"],["unknown"],["Messages"],null,true,"docs",[1],[{}]]){
    await assert.rejects(f.patch(f.human,2,{desktop_nav,time_format:"12h"}),{status:422,code:"unsupported_setting"});
    assert.deepEqual(await f.read(),expected);assert.equal(fs.readFileSync(f.file,"utf8"),before);
  }
  await assert.rejects(f.patch(f.human,1,{desktop_nav:["tasks"]}),{code:"conflict"});
  await assert.rejects(f.call(f.human,"/settings","PATCH",{desktop_nav:["tasks"]}),{code:"conflict"});
  await assert.rejects(f.patch(f.human,2,{desktop_nav:["tasks"],principal_id:f.agent.principal.id}),{code:"unsupported_setting"});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  expected.desktop_nav.length=0;expected.mobile_nav.push("caller-mutation");
  const saved=await f.patch(f.human,2,{time_format:"12h"});
  assert.deepEqual(saved.desktop_nav,["docs","calendar"]);assert.deepEqual(saved.mobile_nav,DEFAULTS.mobile_nav);
  const fresh=await f.read(f.agent);fresh.desktop_nav.reverse();fresh.mobile_nav.length=0;
  assert.deepEqual((await f.read(f.agent)).desktop_nav,expectedDesktop);assert.deepEqual(DEFAULTS.desktop_nav,expectedDesktop);
  f.restart();assert.deepEqual(await f.read(),saved);
});

test("Human and Agent MCP desktop menus share schema and CAS but never grant or revoke application permissions",async()=>{
  const f=await fixture(),schema=publicTools.find(tool=>tool.name==="office_update_settings").inputSchema;
  assert.deepEqual(schema.properties.desktop_nav,{type:"array",minItems:1,maxItems:12,uniqueItems:true,items:{type:"string",enum:expectedDesktop}});
  assert.deepEqual(schema.properties.mobile_nav,{type:"array",minItems:1,maxItems:4,uniqueItems:true,items:{type:"string",enum:MOBILE_NAV_IDS}});
  assert.ok(schema.required.includes("base_revision"));
  const parse=response=>JSON.parse(response.result.content[0].text);
  for(const who of [f.human,f.agent]){
    assert.deepEqual(parse(await f.mcp(who,"office_settings")).settings.desktop_nav,expectedDesktop);
    const saved=await f.mcp(who,"office_update_settings",{base_revision:1,desktop_nav:["mail"]});
    assert.equal(saved.result.isError,false);assert.deepEqual(parse(saved).settings.desktop_nav,["mail"]);
    assert.deepEqual(parse(saved).settings.mobile_nav,DEFAULTS.mobile_nav);
    const stale=await f.mcp(who,"office_update_settings",{base_revision:1,desktop_nav:["tasks"]});
    assert.equal(stale.result.isError,true);assert.deepEqual(parse(stale),{status:409,code:"conflict"});
    for(const desktop_nav of [[],["enterprise"],["docs","docs"]])assert.equal((await f.mcp(who,"office_update_settings",{base_revision:2,desktop_nav})).result.isError,true);
  }
  const {room}=await f.call(f.human,"/rooms","POST",{name:"Menus are not permissions"});
  assert.equal((await f.call(f.human,"/rooms/"+room.id+"/tasks","POST",{title:"Hidden menu still authorized"})).task.title,"Hidden menu still authorized");
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/mail","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  await assert.rejects(f.call(f.agent,"/mail/folders"),{code:"app_policy_denied"});
  await assert.rejects(f.call(f.agent,"/enterprise/admin/members"),{code:"enterprise_admin_required"});
  assert.deepEqual(parse(await f.mcp(f.agent,"office_settings")).settings.desktop_nav,["mail"]);
});

test("failed combined desktop/mobile persistence fail-stops and restart restores both last committed orders",async()=>{
  const f=await fixture(),before=await f.patch(f.agent,1,{desktop_nav:["docs"],mobile_nav:["tasks"]}),rename=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("Fixture save failure");return rename(source,target);};
  try{await assert.rejects(f.patch(f.agent,2,{desktop_nav:["mail"],mobile_nav:["calendar"]}),{code:"storage_failed"});}finally{fs.renameSync=rename;}
  await assert.rejects(f.read(f.agent),{code:"storage_failed"});f.restart();assert.deepEqual(await f.read(f.agent),before);
});
