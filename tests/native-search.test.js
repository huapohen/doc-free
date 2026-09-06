"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "native-search-tests-"),
);
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
async function setup() {
  const admin = crypto.randomBytes(32).toString("hex");
  const file = path.join(temporary, crypto.randomUUID() + ".json"), documents = new Map();
  let clock = Date.parse("2026-09-06T01:00:00Z"), reads = 0;
  const options = {
    file,
    adminToken: admin,
    now: () => clock,
    workspace: {
      handle: async (method, route, input) => {
        const documentId = route.split("/").at(-1);
        if (method === "POST") {
          const document = {id:"document-"+crypto.randomUUID(), title:input.title, content:input.content, revision:1, updated_at:clock, content_hash:crypto.createHash("sha256").update(input.content).digest("hex")};
          documents.set(document.id, document); return {...document};
        }
        reads++;
        if (!documents.has(documentId)) throw new Error("unexpected document read");
        return {...documents.get(documentId)};
      },
    },
  };
  let im = createNativeIM(options);
  const call = (token, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im" + route);
    return im.handle(method, url.pathname, input, token, url.searchParams);
  };
  const make = (name, kind = "human") =>
    call(admin, "/admin/principals", "POST", { name, kind });
  const owner = await make("产品负责人"),
    reviewer = await make("产品Agent", "agent"),
    peer = await make("Peer"),
    outside = await make("Outside");
  const { room } = await call(owner.token, "/rooms", "POST", {
    name: "Product room",
  });
  for (const person of [reviewer, peer])
    await call(owner.token, `/rooms/${room.id}/members`, "POST", {
      principal_id: person.principal.id,
    });
  return { admin, call, make, owner, reviewer, peer, outside, room, file, documents,
    restart:()=>im=createNativeIM(options), advance:(ms)=>clock+=ms, reads:()=>reads };
}

test("unified search finds contacts/store and authorized office work while protecting private approvals and blind mail recipients", async () => {
  const f = await setup();
  const { request } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/approvals`,
    "POST",
    {
      client_id: "approval-search",
      template_id: "general",
      title: "产品隐私审批",
      approver_id: f.reviewer.principal.id,
      payload: { note: "restricted" },
    },
  );
  const { event } = await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/calendar`,
    "POST",
    {
      client_id: "calendar-search",
      title: "产品排期",
      starts_at: "2027-01-01T01:00:00Z",
      ends_at: "2027-01-01T02:00:00Z",
    },
  );
  const { draft } = await f.call(f.owner.token, "/mail/drafts", "POST", {
    client_id: "mail-search",
    to_ids: [f.reviewer.principal.id],
    bcc_ids: [f.peer.principal.id],
    subject: "Brief",
    body: "Long introduction ".repeat(30) + "产品内部邮件证据",
  });
  await f.call(f.owner.token, `/mail/${draft.id}/send`, "POST", {
    client_id: "send-search",
    base_revision: 1,
  });
  await f.call(f.owner.token, "/mail/drafts", "POST", {
    client_id: "private-draft",
    subject: "产品私有草稿",
    body: "never visible to reviewer",
  });
  const search = (person, query = "产品") =>
    f.call(person.token, "/search?q=" + encodeURIComponent(query));
  const result = await search(f.reviewer);
  assert.deepEqual(
    new Set(result.results.map((entry) => entry.type)),
    new Set(["person", "agent", "store", "mail", "approval", "calendar"]),
  );
  assert.ok(
    result.results.every(
      (entry) => entry.id && entry.title && typeof entry.snippet === "string",
    ),
  );
  const mail = result.results.find((entry) => entry.type === "mail");
  assert.match(mail.snippet, /产品内部邮件证据/);
  assert.equal(mail.mail.bcc_ids, undefined);
  assert.equal(
    result.results.find((entry) => entry.type === "approval").request.id,
    request.id,
  );
  assert.equal(
    result.results.find((entry) => entry.type === "calendar").event.id,
    event.id,
  );
  assert.ok(!JSON.stringify(result).includes("never visible to reviewer"));
  assert.ok(
    !(await search(f.peer)).results.some((entry) => entry.type === "approval"),
  );
  assert.deepEqual(
    new Set((await search(f.outside)).results.map((entry) => entry.type)),
    new Set(["person", "agent", "store"]),
  );
  assert.deepEqual((await search(f.outside, crypto.randomUUID())).results, []);
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/members/${f.reviewer.principal.id}`,
    "DELETE",
  );
  const removed = await search(f.reviewer);
  assert.ok(
    !removed.results.some((entry) =>
      ["approval", "calendar"].includes(entry.type),
    ),
  );
  assert.ok(
    removed.results.some((entry) => entry.type === "mail"),
    "personal delivery survives room removal",
  );
});

test("global search caps all domains at two hundred and excludes revoked directory identities", async () => {
  const f = await setup();
  for (let index = 0; index < 205; index++)
    await f.make(`boundedquery ${index}`, index % 2 ? "agent" : "human");
  const revoked = await f.make("uniquerevokedquery");
  await f.call(f.admin, "/admin/revoke", "POST", {
    principal_id: revoked.principal.id,
  });
  const result = await f.call(f.owner.token, "/search?q=boundedquery");
  assert.equal(result.results.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(
    (await f.call(f.owner.token, "/search?q=uniquerevokedquery")).results
      .length,
    0,
  );
});

test("type author room and half-open dates filter before both content budgets and result truncation", async () => {
  const f = await setup(), base = `/rooms/${f.room.id}`;
  const {message:target} = await f.call(f.owner.token,base+"/messages","POST",{client_id:"target",content:"deepquery older author target"});
  f.advance(60000);
  const {message:noise} = await f.call(f.peer.token,base+"/messages","POST",{client_id:"noise",content:"deepquery newer other author"});
  const {task} = await f.call(f.owner.token,base+"/tasks","POST",{title:"deepquery task",assignee_id:f.reviewer.principal.id});
  // Seed a large historical workload without ten thousand unrelated fsyncs.
  const raw=JSON.parse(fs.readFileSync(f.file));
  const room=raw.rooms.find((r)=>r.id===f.room.id);
  room.messages=[target,...Array.from({length:10010},(_,i)=>({...noise,id:"msg-noise-"+i,seq:noise.seq+i}))];
  fs.writeFileSync(f.file,JSON.stringify(raw));f.restart();
  const search=(filters)=>f.call(f.owner.token,"/search?"+new URLSearchParams({q:"deepquery",...filters}));
  const scoped=await search({type:"message",author_id:f.owner.principal.id,room_id:f.room.id,after:target.at,before:noise.at});
  assert.deepEqual(scoped.results.map((v)=>v.id),[target.id]);assert.equal(scoped.truncated,false);
  assert.equal(scoped.results[0].at,target.at);assert.equal(scoped.results[0].author_id,f.owner.principal.id);
  assert.equal(scoped.time_bounds,"after_inclusive_before_exclusive");
  assert.equal((await search({type:"message",before:target.at})).results.length,0);
  const tasks=await search({type:"task"});assert.deepEqual(tasks.results.map((v)=>v.id),[task.id]);assert.equal(tasks.truncated,false);
  assert.equal(tasks.results[0].time_basis,"created_at");assert.equal(tasks.results[0].author_id,f.owner.principal.id);
  const unfiltered=await search({type:"message"});assert.equal(unfiltered.results.length,200);assert.equal(unfiltered.truncated,true);
  await assert.rejects(f.call(f.outside.token,"/search?"+new URLSearchParams({q:"deepquery",room_id:f.room.id})),{code:"not_a_member"});
  for(const filters of [{type:"unknown"},{after:"2026-09-06"},{after:"2026-02-30T00:00:00Z"},{after:noise.at,before:target.at}])
    await assert.rejects(search(filters),{code:"invalid_search_filter"});
});

test("document filtering uses actual content time and only verified revision authors", async () => {
  const f=await setup(),base=`/rooms/${f.room.id}`;
  const {document}=await f.call(f.owner.token,base+"/documents","POST",{title:"deepdoc",content:"canonical body"});
  const search=(filters={})=>f.call(f.peer.token,"/search?"+new URLSearchParams({q:"deepdoc",type:"document",...filters}));
  let result=await search({author_id:f.owner.principal.id,after:"2026-09-06T01:00:00Z",before:"2026-09-06T01:01:00Z"});
  assert.equal(result.results[0].id,document.id);assert.equal(result.results[0].at,"2026-09-06T01:00:00.000Z");assert.equal(result.results[0].time_basis,"updated_at");
  f.documents.set(document.id,{...document,revision:2,content:"external current version",content_hash:"changed",updated_at:Date.parse("2026-09-06T01:02:00Z")});
  assert.equal((await search({author_id:f.owner.principal.id})).results.length,0);
  result=await search();assert.equal(result.results[0].author_id,null);assert.equal(result.results[0].at,"2026-09-06T01:02:00.000Z");
  const reads=f.reads();await f.call(f.peer.token,"/search?q=deepdoc&type=message");assert.equal(f.reads(),reads);
});

test("structured search reaches authorized mailbox matches beyond its old one-hundred-item prefix", async () => {
  const f=await setup();
  const {draft}=await f.call(f.owner.token,"/mail/drafts","POST",{client_id:"target",subject:"deepmail target",body:"mail evidence",to_ids:[f.peer.principal.id]});
  await f.call(f.owner.token,`/mail/${draft.id}/send`,"POST",{client_id:"send",base_revision:1});
  const {draft:noise}=await f.call(f.peer.token,"/mail/drafts","POST",{client_id:"noise",subject:"deepmail noise",body:"irrelevant author"});
  const raw=JSON.parse(fs.readFileSync(f.file)),template=raw.mail.messages.find((m)=>m.id===noise.id);
  for(let i=0;i<210;i++)raw.mail.messages.push({...template,id:"mail-noise-"+i});
  fs.writeFileSync(f.file,JSON.stringify(raw));f.restart();
  const result=await f.call(f.peer.token,"/search?"+new URLSearchParams({q:"deepmail",type:"mail",author_id:f.owner.principal.id}));
  assert.equal(result.results.length,1);assert.equal(result.results[0].mail.message_id,draft.id);assert.equal(result.truncated,false);
  assert.equal(result.results[0].author_id,f.owner.principal.id);assert.equal(result.results[0].mail.bcc_ids,undefined);
  assert.equal((await f.call(f.peer.token,"/search?"+new URLSearchParams({q:"deepmail",type:"mail",room_id:f.room.id}))).results.length,0);
});
