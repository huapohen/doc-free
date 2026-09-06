"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const Y = require("yjs");
const {commitDocumentOperation, stateHash} = require("../collab-operations");
const {fingerprint} = require("../work-protocol");
const read = d => ({content:d.getText("content").toString(),title:d.getText("title").toString(),initialized:d.getMap("meta").get("initialized")===true});
const replace = (d,c,t) => {for(const [key,value] of [["content",c],["title",t]]) {const x=d.getText(key);x.delete(0,x.length);x.insert(0,value);}d.getMap("meta").set("initialized",true);};
test("failed persistence publishes neither replacement nor receipt to the shared Y document", () => {
  const d = new Y.Doc(); replace(d,"human","Title"); let updates=0;d.on("update",()=>updates++);
  const before=stateHash(d);
  assert.throws(()=>commitDocumentOperation({document:d,mode:"compare-replace",read,replace,input:{document_id:"test",title:"Title",content:"agent",expected_content:"human",operation_id:"op-1",input_hash:fingerprint("one"),result_revision:2,deadline_ms:100},now:()=>50,persist:()=>{throw new Error("disk failure");}}),/disk failure/);
  assert.equal(stateHash(d),before);assert.equal(read(d).content,"human");assert.equal(d.getMap("active-agent-operations").size,0);assert.equal(updates,0);d.destroy();
});
test("candidate preparation cannot bypass a deadline that expires before disk commit",()=>{
  const d=new Y.Doc(); let persisted=false, now=0;
  assert.throws(()=>commitDocumentOperation({document:d,mode:"create-once",read,replace:(...args)=>{replace(...args);now=100;},input:{document_id:"test",title:"Title",content:"agent",operation_id:"op-2",input_hash:fingerprint("two"),result_revision:1,deadline_ms:100},now:()=>now,persist:()=>{persisted=true;}}),{code:"commit_deadline_expired"});
  assert.equal(persisted,false);assert.equal(read(d).initialized,false);d.destroy();
});
