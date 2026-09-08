"use strict";
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {createNativeIM} = require('../native-im');
const {nativeMCP, callNativeTool, publicTools, resolveNativeTool} = require('../native-im-mcp');
const {createNativeA2A} = require('../native-a2a');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-protocol-'));
after(() => fs.rmSync(temporary, {recursive:true, force:true}));
async function fixture() {
  const directory = path.join(temporary, crypto.randomUUID()), admin = crypto.randomBytes(32).toString('hex');
  const im = createNativeIM({file:path.join(directory, 'im.json'), adminToken:admin,
    workspace:{handle:async()=>{throw Error('No document access expected');}}});
  const raw = (person, route, method='GET', data={}) => {
    const url = new URL('http://fixture/api/im'+route);
    return im.handle(method,url.pathname,data,person.token ?? person,url.searchParams);
  };
  const human = await raw(admin,'/admin/principals','POST',{name:'Human calendar owner',kind:'human'});
  const agent = await raw(admin,'/admin/principals','POST',{name:'Calendar colleague',kind:'agent'});
  const outsider = await raw(admin,'/admin/principals','POST',{name:'Outside',kind:'human'});
  const {room} = await raw(human,'/rooms','POST',{name:'Shared calendar protocol'});
  await raw(human,`/rooms/${room.id}/members`,'POST',{principal_id:agent.principal.id});
  const mcp = async (person,name,args={}) => {
    const response = await nativeMCP(im,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},person.token);
    assert.equal(response.result.isError,false,JSON.stringify(response.result));
    return JSON.parse(response.result.content[0].text);
  };
  const a2a = createNativeA2A({file:path.join(directory,'a2a.json'),im,invokeTool:callNativeTool,publicTools});
  return {im,raw,human,agent,outsider,room,mcp,a2a};
}
const window = {from:'2026-09-01T00:00:00+08:00',to:'2026-10-01T00:00:00+08:00',timezone:'Asia/Shanghai'};

test('calendar MCP schemas expose real dates scopes queries and nested recurrence validation',()=>{
  const tools = new Map(publicTools.map(t=>[t.name,t]));
  const create = tools.get('office_create_event').inputSchema;
  assert.equal(create.properties.all_day.type,'boolean');
  assert.ok(create.anyOf.some(x=>x.required.includes('start_date')));
  assert.equal(tools.get('office_cancel_event').annotations.destructiveHint,true);
  assert.ok(tools.get('office_respond_event').inputSchema.properties.base_revision);
  assert.deepEqual(tools.get('im_configure_autonomy').inputSchema.properties.autonomy.properties.allowed_operations.items.enum,
    [...require('../native-actions').OPERATIONS]);
  const list = resolveNativeTool('office_calendar',{q:'企业 & Agent'});
  assert.equal(list.params.get('q'),'企业 & Agent');
  const read = resolveNativeTool('office_read_event',{event_id:'calendar-id',occurrence_id:'opaque/+=='});
  assert.equal(read.params.get('occurrence_id'),'opaque/+==');
  assert.deepEqual(read.input,{});
  for (const recurrence of [
    {frequency:'weekly',weekdays:[true]},
    {frequency:'weekly',weekdays:[1,1]},
    {frequency:'monthly',ordinal_weekday:{ordinal:0,weekday:1}},
    {frequency:'daily',interval:1000},
    {frequency:'daily',count:10001},
    {frequency:'daily',actor_id:'invented'},
  ]) assert.throws(()=>resolveNativeTool('office_create_event',{room_id:'room-id',title:'Invalid',client_id:'once',recurrence}),{code:'invalid_calendar_argument'});
  assert.throws(()=>resolveNativeTool('office_calendar_occurrences',{...window,limit:501}),{code:'invalid_calendar_argument'});
});

test('MCP human and Agent share recurring all-day creation occurrence RSVP edit cancellation and CAS',async()=>{
  const f=await fixture();
  const input={room_id:f.room.id,title:'团队复核',client_id:'all-day-once',all_day:true,timezone:'Asia/Shanghai',
    start_date:'2026-09-07',end_date:'2026-09-08',recurrence:{frequency:'daily',interval:1,count:3},
    attendee_ids:[f.human.principal.id,f.agent.principal.id]};
  const created=await f.mcp(f.agent,'office_create_event',input), event=created.event;
  assert.equal(event.all_day,true);assert.equal(event.created_by,f.agent.principal.id);
  assert.equal((await f.mcp(f.agent,'office_create_event',input)).duplicate,true);
  assert.equal((await f.mcp(f.human,'office_calendar',{q:'团队复核'})).events.length,1);
  const first=await f.mcp(f.human,'office_calendar_occurrences',{...window,limit:1});
  assert.equal(first.occurrences.length,1);assert.equal(first.truncated,true);assert.ok(first.next_cursor);
  const second=await f.mcp(f.human,'office_calendar_occurrences',{...window,limit:1,cursor:first.next_cursor});
  assert.equal(second.occurrences[0].start_date,'2026-09-08');
  const occurrence_id=first.occurrences[0].occurrence_id;
  const viewed=await f.mcp(f.agent,'office_read_event',{event_id:event.id,occurrence_id});
  assert.equal(viewed.event.occurrence_id,occurrence_id);
  const response=await f.mcp(f.human,'office_respond_event',{event_id:event.id,base_revision:1,client_id:'rsvp-once',
    scope:'occurrence',occurrence_id,response:'accepted'});
  assert.equal(response.event.responses[f.human.principal.id],'accepted');assert.equal(response.series.revision,2);
  const edit={event_id:event.id,base_revision:2,client_id:'edit-once',scope:'occurrence',occurrence_id,title:'本次复核'};
  const changed=await f.mcp(f.agent,'office_update_event',edit);
  assert.equal(changed.event.title,'本次复核');assert.equal(changed.series.title,'团队复核');
  assert.deepEqual(await f.mcp(f.agent,'office_update_event',edit),changed);
  await assert.rejects(callNativeTool(f.im,'office_update_event',{...edit,client_id:'stale-edit'},f.agent.token),{code:'conflict'});
  await assert.rejects(callNativeTool(f.im,'office_read_event',{event_id:event.id},f.outsider.token),{code:'not_a_member'});
  const cancel=await f.mcp(f.agent,'office_cancel_event',{event_id:event.id,base_revision:3,client_id:'cancel-one',scope:'occurrence',occurrence_id});
  assert.equal(cancel.event.status,'cancelled');assert.equal(cancel.series.status,'scheduled');
  assert.equal((await f.mcp(f.human,'office_calendar_occurrences',window)).occurrences.length,2);
  const canceled=await f.mcp(f.agent,'office_cancel_event',{event_id:event.id,base_revision:4,client_id:'cancel-series',scope:'series'});
  assert.equal(canceled.event.status,'cancelled');
  assert.equal((await f.mcp(f.human,'office_calendar_occurrences',window)).occurrences.length,0);
});

test('A2A exports the same calendar contract and persists one series creation and cancellation receipt',async()=>{
  const f=await fixture();
  const skills=new Set(f.a2a.agentCard('https://office.example').skills.map(x=>x.id));
  for(const name of ['office_calendar','office_calendar_occurrences','office_create_event','office_read_event','office_update_event','office_cancel_event','office_respond_event'])assert.ok(skills.has(name));
  const send=(operation,args,messageId)=>({jsonrpc:'2.0',id:1,method:'message/send',params:{message:{messageId,role:'user',
    parts:[{kind:'data',data:{operation,arguments:args}}]}}});
  const input={room_id:f.room.id,title:'每周Agent协调',client_id:'weekly-once',all_day:true,timezone:'Asia/Shanghai',
    start_date:'2026-09-07',end_date:'2026-09-08',recurrence:{frequency:'weekly',interval:1,weekdays:[1],count:2},attendee_ids:[f.agent.principal.id]};
  const creation=send('office_create_event',input,'create-recurring-event');
  const result=await f.a2a.handle(creation,f.agent.token);
  assert.equal(result.result.status.state,'completed',JSON.stringify(result));
  const event=result.result.artifacts[0].parts[0].data.result.event;
  assert.equal((await f.a2a.handle(creation,f.agent.token)).result.id,result.result.id);
  assert.equal((await f.raw(f.human,'/calendar')).events.length,1);
  const cancelled=await f.a2a.handle(send('office_cancel_event',{event_id:event.id,base_revision:1,client_id:'weekly-cancel',scope:'series'},'cancel-recurring-event'),f.agent.token);
  assert.equal(cancelled.result.status.state,'completed',JSON.stringify(cancelled));
  assert.equal(cancelled.result.artifacts[0].parts[0].data.result.event.status,'cancelled');
  assert.equal((await f.raw(f.human,'/calendar/'+event.id)).event.status,'cancelled');
});

test('MCP series structure reset is explicit and retries preserve the original mutation receipt',async()=>{
  const f=await fixture();
  const {event}=await f.mcp(f.agent,'office_create_event',{room_id:f.room.id,title:'Reset test',client_id:'reset-create',
    all_day:true,timezone:'Asia/Shanghai',start_date:'2026-09-07',end_date:'2026-09-08',recurrence:{frequency:'daily',count:3},attendee_ids:[f.agent.principal.id]});
  const page=await f.mcp(f.agent,'office_calendar_occurrences',window), occurrence_id=page.occurrences[0].occurrence_id;
  const edit={event_id:event.id,base_revision:1,client_id:'instance-title',scope:'occurrence',occurrence_id,title:'Instance title'};
  const edited=await f.mcp(f.agent,'office_update_event',edit);
  const reset={event_id:event.id,base_revision:2,client_id:'series-dates',scope:'series',start_date:'2026-09-08',end_date:'2026-09-09'};
  await assert.rejects(callNativeTool(f.im,'office_update_event',reset,f.agent.token),{code:'exceptions_reset_required'});
  const changed=await f.mcp(f.agent,'office_update_event',{...reset,reset_exceptions:true});
  assert.equal(changed.event.revision,3);
  await assert.rejects(callNativeTool(f.im,'office_read_event',{event_id:event.id,occurrence_id},f.agent.token),{code:'stale_occurrence'});
  assert.deepEqual(await f.mcp(f.agent,'office_update_event',edit),edited);
  assert.equal((await f.mcp(f.agent,'office_read_event',{event_id:event.id})).event.revision,3);
});
