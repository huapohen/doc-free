'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeSettings} = require('../native-settings');
test('desktop collapse is a personal boolean with revision and audience isolation', async () => {
 const state = {}, events=[];
 const settings=createNativeSettings({state,stamp:()=> '2026-09-06T15:00:00Z',persist(){},publishPersonalEvent:(...args)=>events.push(args)});
 for(const kind of ['human','agent']) {
   const principal={id:kind,kind};
   assert.equal((await settings.handle('GET','/api/im/settings',{},principal)).settings.desktop_nav_collapsed,false);
   const changed=await settings.handle('PATCH','/api/im/settings',{base_revision:1,desktop_nav_collapsed:true},principal);
   assert.equal(changed.settings.desktop_nav_collapsed,true);
   assert.equal(changed.settings.revision,2);
   assert.deepEqual(events.at(-1).at(-1),[kind]);
   await assert.rejects(settings.handle('PATCH','/api/im/settings',{base_revision:1,desktop_nav_collapsed:false},principal),error=>error.code==='conflict');
   await assert.rejects(settings.handle('PATCH','/api/im/settings',{base_revision:2,desktop_nav_collapsed:'true'},principal),error=>error.code==='unsupported_setting');
 }
 const outsider=await settings.handle('GET','/api/im/settings',{}, {id:'unrelated',kind:'human'});
 assert.equal(outsider.settings.desktop_nav_collapsed,false);
});
