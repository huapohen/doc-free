"use strict";
const { test, after } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const { nativeMCP, publicTools } = require("../native-im-mcp");
const { DEFAULTS, MOBILE_NAV_IDS } = require("../native-settings");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-mobile-nav-"));
after(() => fs.rmSync(temporary, {recursive:true, force:true}));

async function setup() {
  const file = path.join(temporary, crypto.randomUUID()+".json"), admin = crypto.randomBytes(32).toString("hex");
  const options = {file, adminToken:admin, workspace:{handle:async()=>{throw new Error("No document I/O expected");}}};
  let im = createNativeIM(options);
  const call = (who, route="/settings", method="GET", input={}) => im.handle(method,"/api/im"+route,input,who.token || who);
  const human = await call(admin,"/admin/principals","POST",{name:"Human",kind:"human"});
  const agent = await call(admin,"/admin/principals","POST",{name:"Agent",kind:"agent"});
  const mcp = (who,name,args={}) => nativeMCP(im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},who.token);
  return {file,admin,human,agent,call,mcp,restart:()=>im=createNativeIM(options)};
}

test("old personal preferences gain a read-only default and ordered add/remove/reorder persists",async()=>{
  const f=await setup(),raw=JSON.parse(fs.readFileSync(f.file));
  raw.personal_settings[f.human.principal.id]={message_alignment:"left",send_shortcut:"mod_enter",text_scale:1.1,show_message_preview:false,revision:7,updated_at:"2026-09-06T00:00:00Z"};
  fs.writeFileSync(f.file,JSON.stringify(raw));f.restart();const before=fs.readFileSync(f.file,"utf8");
  const initial=(await f.call(f.human)).settings;
  assert.deepEqual(initial.mobile_nav,["messages","agents","docs","workbench"]);assert.equal(initial.revision,7);
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  let current=initial;
  for(const mobile_nav of [["messages","tasks"],["messages","tasks","mail"],["mail","messages","tasks"],["mail"]]) {
    current=(await f.call(f.human,"/settings","PATCH",{base_revision:current.revision,mobile_nav})).settings;
    assert.deepEqual(current.mobile_nav,mobile_nav);
  }
  assert.equal(current.revision,11);assert.equal(current.message_alignment,"left");assert.equal(current.text_scale,1.1);
  f.restart();assert.deepEqual((await f.call(f.human)).settings,current);
  assert.deepEqual((await f.call(f.agent)).settings.mobile_nav,DEFAULTS.mobile_nav);
  const saved=JSON.parse(fs.readFileSync(f.file));assert.deepEqual(saved.personal_settings[f.human.principal.id].mobile_nav,["mail"]);
  assert.equal(saved.events.at(-1).type,"settings.updated");assert.deepEqual(saved.events.at(-1).audience_ids,[f.human.principal.id]);
});

test("invalid menus reject atomically and neither input nor returned arrays alias durable preferences",async()=>{
  const f=await setup(),mobile_nav=["tasks","calendar"];
  const changed=(await f.call(f.human,"/settings","PATCH",{base_revision:1,mobile_nav})).settings;
  mobile_nav.push("mail");changed.mobile_nav.reverse();
  const expected=(await f.call(f.human)).settings;assert.deepEqual(expected.mobile_nav,["tasks","calendar"]);
  const before=fs.readFileSync(f.file,"utf8");
  for(const value of [[],["tasks","tasks"],["messages","agents","docs","tasks","mail"],["more"],["unknown"],null,"tasks",[1],[{}]]) {
    await assert.rejects(f.call(f.human,"/settings","PATCH",{base_revision:2,message_alignment:"left",mobile_nav:value}),{status:422,code:"unsupported_setting"});
    assert.deepEqual((await f.call(f.human)).settings,expected);
  }
  await assert.rejects(f.call(f.human,"/settings","PATCH",{base_revision:1,mobile_nav:["docs"]}),{code:"conflict"});
  await assert.rejects(f.call(f.human,"/settings","PATCH",{base_revision:2,mobile_nav:["docs"],principal_id:f.agent.principal.id}),{code:"unsupported_setting"});
  assert.equal(fs.readFileSync(f.file,"utf8"),before);
  expected.mobile_nav.length=0;assert.deepEqual((await f.call(f.human)).settings.mobile_nav,["tasks","calendar"]);
});

test("human and Agent use the same existing MCP settings tool without granting app or management access",async()=>{
  const f=await setup(),schema=publicTools.find(t=>t.name==="office_update_settings").inputSchema.properties.mobile_nav;
  assert.equal(schema.minItems,1);assert.equal(schema.maxItems,4);assert.equal(schema.uniqueItems,true);assert.deepEqual(schema.items.enum,MOBILE_NAV_IDS);
  const parse=response=>JSON.parse(response.result.content[0].text);
  for(const who of [f.human,f.agent]) {
    const result=await f.mcp(who,"office_update_settings",{base_revision:1,mobile_nav:["enterprise","mail","tasks"]});
    assert.equal(result.result.isError,false);assert.equal(parse(result).settings.revision,2);
    assert.deepEqual(parse(await f.mcp(who,"office_settings")).settings.mobile_nav,["enterprise","mail","tasks"]);
  }
  assert.equal((await f.mcp(f.agent,"office_update_settings",{base_revision:2,mobile_nav:["more"]})).result.isError,true);
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/mail","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.agent.principal.id]});
  await assert.rejects(f.call(f.agent,"/mail/folders"),{status:403,code:"app_policy_denied"});
  await assert.rejects(f.call(f.agent,"/enterprise/admin/members"),{status:403,code:"enterprise_admin_required"});
  assert.deepEqual((await f.call(f.agent)).settings.mobile_nav,["enterprise","mail","tasks"]);
  await f.mcp(f.agent,"office_update_settings",{base_revision:2,mobile_nav:["contacts"]});
  assert.deepEqual((await f.call(f.human)).settings.mobile_nav,["enterprise","mail","tasks"]);
  assert.deepEqual((await f.call(f.agent)).settings.mobile_nav,["contacts"]);
});

test("failed menu persistence fail-stops and restart retains the last committed menu",async()=>{
  const f=await setup();await f.call(f.agent,"/settings","PATCH",{base_revision:1,mobile_nav:["calendar"]});
  const original=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===f.file)throw new Error("fixture persistence failure");return original(source,target);};
  try { await assert.rejects(f.call(f.agent,"/settings","PATCH",{base_revision:2,mobile_nav:["tasks"]}),{code:"storage_failed"}); }
  finally {fs.renameSync=original;}
  await assert.rejects(f.call(f.agent),{code:"storage_failed"});f.restart();
  const restored=(await f.call(f.agent)).settings;assert.deepEqual(restored.mobile_nav,["calendar"]);assert.equal(restored.revision,2);
});
