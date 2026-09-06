"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im");
const {nativeMCP,publicTools}=require("../native-im-mcp");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"native-time-format-"));
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(directory,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex");
  const options={file,adminToken:admin,workspace:{handle:async()=>{throw new Error("No document operation expected");}}};
  let im=createNativeIM(options);
  const call=(who,route="/settings",method="GET",input={})=>im.handle(method,"/api/im"+route,input,who.token??who);
  const human=await call(admin,"/admin/principals","POST",{name:"Human",kind:"human"});
  const agent=await call(admin,"/admin/principals","POST",{name:"Agent",kind:"agent"});
  const mcp=(who,name,args={})=>nativeMCP(im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  return {file,human,agent,call,mcp,restart:()=>im=createNativeIM(options)};
}

test("legacy five-field settings gain a read-only 24h default and preserve existing fields and revision",async()=>{
  const f=await fixture(),raw=JSON.parse(fs.readFileSync(f.file));
  const legacy={message_alignment:"left",send_shortcut:"mod_enter",text_scale:1.15,show_message_preview:false,mobile_nav:["mail","messages"],revision:7,updated_at:"2026-09-06T01:00:00Z"};
  raw.personal_settings[f.human.principal.id]=legacy;fs.writeFileSync(f.file,JSON.stringify(raw));f.restart();
  const before=fs.readFileSync(f.file,"utf8"),settings=(await f.call(f.human)).settings;
  assert.deepEqual(settings,{...legacy,time_format:"24h"});assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const saved=(await f.call(f.human,"/settings","PATCH",{base_revision:7,time_format:"12h"})).settings;
  assert.equal(saved.time_format,"12h");assert.equal(saved.revision,8);
  for(const key of ["message_alignment","send_shortcut","text_scale","show_message_preview","mobile_nav"])assert.deepEqual(saved[key],legacy[key]);
  f.restart();assert.deepEqual((await f.call(f.human)).settings,saved);
  assert.equal((await f.call(f.agent)).settings.time_format,"24h");assert.equal((await f.call(f.agent)).settings.revision,1);
});

test("Human and Agent settings isolate time format, reject stale CAS and atomically reject invalid or foreign fields",async()=>{
  const f=await fixture();
  for(const who of [f.human,f.agent]){
    const saved=(await f.call(who,"/settings","PATCH",{base_revision:1,time_format:"12h"})).settings;
    assert.equal(saved.revision,2);assert.equal(saved.time_format,"12h");
    await assert.rejects(f.call(who,"/settings","PATCH",{base_revision:1,time_format:"24h"}),{status:409,code:"conflict"});
  }
  await f.call(f.human,"/settings","PATCH",{base_revision:2,time_format:"24h"});
  assert.equal((await f.call(f.agent)).settings.time_format,"12h");
  const before=fs.readFileSync(f.file,"utf8");
  for(const value of ["24","12","auto","",24,null,true,{},["12h"]]){
    await assert.rejects(f.call(f.agent,"/settings","PATCH",{base_revision:2,message_alignment:"left",time_format:value}),{status:422,code:"unsupported_setting"});
    assert.equal(fs.readFileSync(f.file,"utf8"),before);
  }
  await assert.rejects(f.call(f.agent,"/settings","PATCH",{base_revision:2,time_format:"24h",principal_id:f.human.principal.id}),{status:422,code:"unsupported_setting"});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const persisted=JSON.parse(before);
  const event=persisted.events.filter(e=>e.type==="settings.updated").at(-1);
  assert.deepEqual(event.audience_ids,[f.human.principal.id]);
});

test("MCP publishes the exact time-format enum and preserves caller CAS and validation through the native API",async()=>{
  const f=await fixture(),schema=publicTools.find(tool=>tool.name==="office_update_settings").inputSchema;
  assert.deepEqual(schema.properties.time_format,{type:"string",enum:["24h","12h"]});
  assert.ok(schema.required.includes("base_revision"));
  const parse=result=>JSON.parse(result.result.content[0].text);
  for(const who of [f.human,f.agent]){
    assert.equal(parse(await f.mcp(who,"office_settings")).settings.time_format,"24h");
    const saved=await f.mcp(who,"office_update_settings",{base_revision:1,time_format:"12h"});
    assert.equal(saved.result.isError,false);assert.equal(parse(saved).settings.time_format,"12h");
    const stale=await f.mcp(who,"office_update_settings",{base_revision:1,time_format:"24h"});
    assert.equal(stale.result.isError,true);assert.deepEqual(parse(stale),{status:409,code:"conflict"});
    const invalid=await f.mcp(who,"office_update_settings",{base_revision:2,time_format:"auto"});
    assert.equal(invalid.result.isError,true);assert.equal(parse(invalid).status,422);
    assert.equal(parse(await f.mcp(who,"office_settings")).settings.time_format,"12h");
  }
});
