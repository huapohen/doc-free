"use strict";
const {test,after}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {createNativeIM}=require("../native-im");
const {AGENT_STORE}=require("../native-agent-catalog");
const {nativeMCP}=require("../native-im-mcp");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"default-colleagues-"));
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
async function fixture(){
  const file=path.join(directory,crypto.randomUUID()+".json"),admin=crypto.randomBytes(32).toString("hex");
  const options={file,adminToken:admin,workspace:{handle:async()=>{throw new Error("No document operation expected");}}};
  let im=createNativeIM(options);
  const call=(who,route,method="GET",input={})=>im.handle(method,"/api/im"+route,input,who.token??who);
  const make=(name,kind="human")=>call(admin,"/admin/principals","POST",{name,kind});
  const human=await make("Human"),peer=await make("Peer"),agent=await make("Custom Agent","agent");
  return{file,admin,human,peer,agent,make,call,get im(){return im;},restart:(extra={})=>im=createNativeIM({...options,...extra})};
}

test("catalog preserves 100 professions plus two honest device templates and returns metadata on installed identities",async()=>{
  const f=await fixture(),catalog=await f.call(f.human,"/agent-store");
  assert.equal(catalog.agents.length,102);assert.equal(new Set(catalog.agents.map(t=>t.id)).size,102);
  assert.equal(catalog.agents.filter(t=>t.category_id!=="device-companions").length,100);
  assert.ok(catalog.agents.every(t=>t.proactive_capable));assert.equal(catalog.proactivity.execution_switch,"autonomy.enabled");
  for(const tid of ["desktop-companion","mobile-companion"]){
    const template=catalog.agents.find(t=>t.id===tid);assert.ok(template.profession && template.job_title && template.instructions && template.skills.length);
    const capability=template.device_capabilities;assert.equal(capability.template_only,true);assert.equal(capability.installation_grants_device_access,false);
    assert.equal(capability.input_policy,"isolated_session_only");assert.ok(capability.unsupported_modes.some(m=>m.id==="ios_cross_app"));
    assert.ok(capability.supported_modes.some(m=>m.status==="runtime_required"));
    const installed=await f.call(f.human,`/agent-store/${tid}/install`,"POST");assert.deepEqual(installed.principal.device_capabilities,capability);
    assert.equal(installed.principal.system_agent_key,undefined);assert.equal(installed.token,undefined);
    assert.equal((await f.call(f.human,`/agent-store/${tid}/install`,"POST")).duplicate,true);
    installed.principal.device_capabilities.supported_modes.length=0;
    assert.ok((await f.call(f.human,`/agent-store/${tid}/install`,"POST")).principal.device_capabilities.supported_modes.length>0);
  }
  assert.equal((await f.call(f.human,"/rooms")).rooms.length,0);
  assert.ok((await f.call(f.admin,"/admin/workers")).workers.every(w=>w.runnable_room_count===0));
  assert.ok(Object.isFrozen(AGENT_STORE.at(-1).device_capabilities.supported_modes));
});

test("each human gets the same two real default friends once; existing contacts, personal removals and restart are preserved",async()=>{
  const f=await fixture();await f.call(f.human,"/contacts","POST",{principal_id:f.agent.principal.id});
  const initial=await f.call(f.human,"/contacts"),defaults=initial.contacts.filter(p=>p.system_agent_key);
  assert.deepEqual(defaults.map(p=>p.name),["activate-agent","机伴"]);assert.equal(initial.contacts.length,3);assert.equal(initial.default_colleagues.seeded,true);
  const before=fs.readFileSync(f.file,"utf8");await f.call(f.human,"/contacts");await f.call(f.human,"/contacts/defaults","POST");assert.equal(fs.readFileSync(f.file,"utf8"),before);
  const peer=await f.call(f.peer,"/agents");assert.deepEqual(peer.agents.map(p=>p.id),defaults.map(p=>p.id));assert.ok(peer.agents.every(p=>p.relationship==="friend"));
  assert.equal((await f.call(f.agent,"/contacts")).contacts.length,0);
  await f.call(f.human,`/contacts/${defaults[0].id}`,"DELETE");f.restart();
  await f.call(f.human,"/contacts/defaults","POST");const after=await f.call(f.human,"/contacts");
  assert.equal(after.contacts.length,2);assert.ok(!after.contacts.some(p=>p.id===defaults[0].id));
  assert.equal((await f.call(f.peer,"/contacts")).contacts.length,2);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).principals.filter(p=>p.system_agent_key).length,2);
  assert.equal((await f.call(f.human,"/rooms")).rooms.length,0);
});

test("default managed colleagues have independent fleet credentials and only claim work in actual invited rooms",async()=>{
  const f=await fixture();const defaults=(await f.call(f.human,"/agents")).agents;
  const registry=(await f.call(f.admin,"/admin/workers")).workers;assert.equal(registry.length,2);
  for(const worker of registry){
    assert.equal(worker.runnable_room_count,0);assert.equal((await f.call(worker.token,"/me")).principal.id,worker.principal.id);
    await assert.rejects(f.call(worker.token,"/enterprise/admin/members"),{code:"enterprise_admin_required"});
  }
  const {room}=await f.call(f.human,"/rooms/direct","POST",{principal_id:defaults[0].id});
  await f.call(f.human,`/rooms/${room.id}/messages`,"POST",{client_id:"visible-work",content:"请整理下一步任务"});
  const worker=registry.find(w=>w.principal.id===defaults[0].id),other=registry.find(w=>w.principal.id!==defaults[0].id);
  const updated=(await f.call(f.admin,"/admin/workers")).workers;
  assert.equal(updated.find(w=>w.principal.id===worker.principal.id).runnable_room_count,1);
  assert.equal(updated.find(w=>w.principal.id===other.principal.id).runnable_room_count,0);
  await assert.rejects(f.call(other.token,`/rooms/${room.id}/turns/claim`,"POST",{instructions:"fixture",model:"fixture"}),{code:"not_a_member"});
  const claim=await f.call(worker.token,`/rooms/${room.id}/turns/claim`,"POST",{instructions:"fixture",model:"fixture",reasoning_effort:"medium"});
  assert.equal(claim.turn.status,"running");assert.equal(claim.context.policy.mode,"active");assert.ok(claim.context.actions.operations.length>0);
  assert.equal(claim.context.actions.operations.some(operation=>/mouse|device|browser/.test(operation.name)),false);
});

test("explicit startup adoption preserves legacy credentials, custom persona and unrelated names without creating a third default",async()=>{
  const f=await fixture(),legacy=await f.make("Active Agent","agent"),unrelated=await f.make("Active Agent","agent");
  const raw=JSON.parse(fs.readFileSync(f.file)),principal=raw.principals.find(p=>p.id===legacy.principal.id);
  principal.instructions="Existing custom persona";principal.skills=["Existing skill"];
  fs.writeFileSync(f.file,JSON.stringify(raw));f.restart({defaultActivateId:legacy.principal.id});
  const adopted=(await f.call(legacy,"/me")).principal;assert.equal(adopted.name,"activate-agent");assert.equal(adopted.system_agent_key,"activate-agent");
  assert.equal(adopted.managed,false);assert.equal(adopted.instructions,"Existing custom persona");assert.deepEqual(adopted.skills,["Existing skill"]);
  assert.equal((await f.call(unrelated,"/me")).principal.name,"Active Agent");
  const defaults=(await f.call(f.human,"/contacts")).contacts;assert.equal(defaults.length,2);assert.ok(defaults.some(p=>p.id===legacy.principal.id));
  assert.equal((await f.call(f.admin,"/admin/workers")).workers.length,1,"Adopted original machine credential is hosted by the existing local-primary worker");
  const before=fs.readFileSync(f.file,"utf8");f.restart({defaultActivateId:legacy.principal.id});assert.equal(fs.readFileSync(f.file,"utf8"),before);
  await assert.rejects(f.call(f.admin,"/admin/default-colleagues","POST",{legacy_activate_agent_id:unrelated.principal.id}),{code:"default_colleague_exists"});
  const custom=await fixture(),customLegacy=await custom.make("My chosen name","agent");custom.restart({defaultActivateId:customLegacy.principal.id});
  assert.equal((await custom.call(customLegacy,"/me")).principal.name,"My chosen name");
  await custom.call(custom.admin,"/admin/revoke","POST",{principal_id:customLegacy.principal.id});
  custom.restart({defaultActivateId:customLegacy.principal.id});
  await assert.rejects(custom.call(customLegacy,"/me"),{code:"unauthorized"});
  assert.equal((await custom.call(custom.human,"/contacts")).contacts.length,1);
});

test("revoked defaults are not revived, policy restrictions remain enforced and failed migration recovers without partial identities",async()=>{
  const f=await fixture(),defaults=(await f.call(f.human,"/agents")).agents;
  await f.call(f.admin,"/admin/revoke","POST",{principal_id:defaults[0].id});f.restart();
  assert.equal((await f.call(f.peer,"/agents")).agents.length,1);assert.equal(JSON.parse(fs.readFileSync(f.file)).principals.filter(p=>p.system_agent_key).length,2);
  await f.call(f.admin,"/admin/enterprise/bootstrap","POST",{principal_id:f.human.principal.id});
  await f.call(f.human,"/enterprise/admin/apps/im","PATCH",{base_revision:1,enabled:true,denied_principal_ids:[f.peer.principal.id]});
  await assert.rejects(f.call(f.peer,"/contacts/defaults","POST"),{code:"app_policy_denied"});
  const broken=await fixture(),original=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===broken.file)throw new Error("Fixture disk failure");return original(source,target);};
  try{await assert.rejects(broken.call(broken.human,"/contacts"),{code:"storage_failed"});}finally{fs.renameSync=original;}
  await assert.rejects(broken.call(broken.human,"/agents"),{code:"storage_failed"});
  assert.equal(JSON.parse(fs.readFileSync(broken.file)).principals.some(p=>p.system_agent_key),false);
  broken.restart();assert.equal((await broken.call(broken.human,"/contacts")).contacts.length,2);
});

test("participation mode CAS and autonomy execution switch stay separate for any Agent persona",async()=>{
  const f=await fixture(),{room}=await f.call(f.human,"/rooms/direct","POST",{principal_id:f.agent.principal.id});
  const path=`/rooms/${room.id}/participation`;
  const initial=(await f.call(f.human,`/rooms/${room.id}`)).room.revision;
  const changed=await f.call(f.human,path,"PATCH",{principal_id:f.agent.principal.id,base_revision:initial,mode:"mentions"});
  assert.equal(changed.member.mode,"mentions");assert.equal(changed.member.autonomy.enabled,true);
  await assert.rejects(f.call(f.human,path,"PATCH",{principal_id:f.agent.principal.id,base_revision:initial,mode:"active"}),{code:"conflict"});
  const disabled=await f.call(f.human,path,"PATCH",{principal_id:f.agent.principal.id,base_revision:changed.room_revision,autonomy:{enabled:false}});
  assert.equal(disabled.member.mode,"mentions");assert.equal(disabled.member.autonomy.enabled,false);
  assert.equal((await f.call(f.agent,"/me")).principal.proactive_capable,true);
  const mcp=await nativeMCP(f.im,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"im_initialize_default_contacts",arguments:{}}},f.human.token);
  assert.equal(mcp.result.isError,false);assert.equal(JSON.parse(mcp.result.content[0].text).default_colleagues.seeded,true);
});
