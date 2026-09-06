"use strict";
const { problem, requireText } = require("./work-protocol");
const TYPES = ["message", "task", "document", "person", "agent", "store", "mail", "approval", "calendar"];
const BUDGETS = { message: 10000, task: 2000, document: 100, person: 5000, agent: 5000, store: 100, mail: 2000, approval: 2000, calendar: 2000 };
const copy = (value) => JSON.parse(JSON.stringify(value));
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function timestamp(value, name) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw problem(422, "invalid_search_filter", `${name} 需要带时区的 ISO 时间`);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
    throw problem(422, "invalid_search_filter", `${name} 日期无效`);
  return new Date(value).toISOString();
}
function filtersFor(params) {
  const type = params.get("type") || "all";
  if (type !== "all" && !TYPES.includes(type)) throw problem(422, "invalid_search_filter", "无效搜索类型");
  const room_id = params.get("room_id") || null, author_id = params.get("author_id") || null;
  if ([room_id, author_id].some((v) => v && (v.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(v))))
    throw problem(422, "invalid_search_filter", "无效会话或作者过滤");
  const after = timestamp(params.get("after"), "after"), before = timestamp(params.get("before"), "before");
  if (after && before && Date.parse(after) >= Date.parse(before)) throw problem(422, "invalid_search_filter", "开始时间必须早于结束时间");
  return { type, room_id, author_id, after, before };
}
function dateValue(value) {
  const number = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(number) ? new Date(number).toISOString() : null;
}

function createNativeSearch({state, workspace, docRoute, principalView, messageAuthor, messageReceipt, policies, workforce, mailbox, agentStore}) {
  return async function search(p, params) {
    const query = requireText(params.get("q"), "q", 100).trim(), needle = query.toLocaleLowerCase();
    const filters = filtersFor(params), results = [], budgets = {...BUDGETS};
    const allowed = new Set(TYPES.filter((type) => policies.allowed(({document:"docs",task:"tasks",mail:"mail",approval:"approvals",calendar:"calendar"})[type] || "im", p.id)));
    let truncated = false;
    const include = (type) => allowed.has(type) && (filters.type === "all" || filters.type === type);
    const matches = (value) => {
      if (!include(value.type)) return false;
      if (filters.room_id && value.room_id !== filters.room_id) return false;
      if (filters.author_id && value.author_id !== filters.author_id) return false;
      if (filters.after && (!value.at || Date.parse(value.at) < Date.parse(filters.after))) return false;
      if (filters.before && (!value.at || Date.parse(value.at) >= Date.parse(filters.before))) return false;
      return true;
    };
    // Structural predicates precede both the per-domain content budget and
    // the shared result cap. Filtered-out domains cannot starve later types.
    const consider = (value, body) => {
      if (!matches(value)) return;
      if (budgets[value.type]-- <= 0) { truncated = true; return; }
      const text = typeof body === "function" ? body() : body;
      const at = text.toLocaleLowerCase().indexOf(needle);
      if (at < 0) return;
      if (results.length >= 200) { truncated = true; return; }
      const snippet = text.slice(Math.max(0, at - 100), at + needle.length + 200);
      results.push({...value, content:snippet, snippet});
    };
    const rooms = state.rooms.filter((room) => owns(room.members, p.id) && (!filters.room_id || room.id === filters.room_id))
      .sort((a,b) => (b.messages.at(-1)?.seq || 0) - (a.messages.at(-1)?.seq || 0));
    if (filters.room_id && !rooms.length) {
      if (state.rooms.some((room) => room.id === filters.room_id)) throw problem(403,"not_a_member","需要当前会话成员资格");
      throw problem(404,"not_found","会话不存在");
    }
    for (const room of rooms) {
      if (include("message")) for (const message of [...room.messages].reverse()) {
        if (message.retracted_at) continue;
        consider({type:"message",room_id:room.id,id:message.id,title:room.name,revision:message.revision || 1,
          mentions:[...(message.mentions||[])],mention_all:message.mention_all===true,mention_all_ids:[...(message.mention_all_ids||[])],
          ...(messageReceipt?{receipt_summary:messageReceipt(room,message)}:{}),
          author_id:message.author_id,author:messageAuthor(room,message.author_id,message.author),at:dateValue(message.at),time_basis:"sent_at"}, message.content);
      }
      if (include("task")) for (const task of [...room.tasks].reverse())
        consider({type:"task",room_id:room.id,id:task.id,title:task.title,revision:task.revision,
          author_id:task.created_by || null,at:dateValue(task.created_at),time_basis:"created_at"}, () => `${task.title}\n${task.description || ""}`);
      if (include("document")) for (const did of room.document_ids) {
        if (budgets.document <= 0 && !filters.author_id && !filters.after && !filters.before) { truncated = true; continue; }
        // The canonical snapshot supplies the actual content time. Fetching
        // metadata is not counted as scanning a nonmatching document body.
        const document = await workspace.handle("GET",docRoute(did),{},p.id);
        const source = state.events.findLast((event) => event.room_id === room.id && event.document_id === did &&
          ["document.created","document.updated"].includes(event.type) && event.revision === document.revision && event.content_hash === document.content_hash);
        const author = document.updated_by || source?.actor_id;
        const author_id = state.principals.some((person) => person.id === author) ? author : null;
        consider({type:"document",room_id:room.id,id:document.id,title:document.title,revision:document.revision,
          author_id,at:dateValue(document.updated_at),time_basis:"updated_at"}, () => `${document.title}\n${document.content}`);
      }
    }
    for (const person of state.principals) {
      if (person.revoked_at || person.disabled_at) continue;
      const type = person.kind === "agent" ? "agent" : "person";
      if (!include(type)) continue;
      consider({type,id:person.id,title:person.name,principal:principalView(person),author_id:null,at:null,time_basis:null},
        () => `${person.name}\n${person.kind}\n${(person.skills || []).join(" ")}`);
    }
    if (include("store")) for (const agent of agentStore)
      consider({type:"store",id:agent.id,title:agent.name,agent:copy(agent),author_id:null,at:null,time_basis:null},
        () => `${agent.name}\n${agent.description}\n${agent.skills.join(" ")}`);
    if (include("mail") && !filters.room_id) for (const item of mailbox.searchCandidates(p)) {
      const {body,...mail} = item;
      consider({type:"mail",id:item.id,title:item.subject || "无主题",mail,revision:item.revision,
        author_id:item.sender_id,at:dateValue(item.created_at),time_basis:"created_at"}, () => `${item.subject}\n${body}\n${item.sender.name}`);
    }
    if (include("approval")) for (const request of [...state.workforce.approvals].reverse()) {
      try { workforce.authorizeRequest(request.id,p); } catch { continue; }
      const previous = results.length;
      consider({type:"approval",room_id:request.room_id,id:request.id,title:request.title,request:copy(request),revision:request.revision,
        author_id:request.created_by,at:dateValue(request.created_at),time_basis:"created_at"}, () => `${request.title}\n${request.description}\n${JSON.stringify(request.payload)}`);
      if (results.length > previous) {
        // Preserve the ordinary read route's due-date transition rather than
        // presenting an already expired request as still pending in search.
        const current = (await workforce.handle("GET", `/api/im/approvals/${request.id}`, {}, p, new URLSearchParams())).request;
        results.at(-1).request = current;
        results.at(-1).revision = current.revision;
      }
    }
    if (include("calendar")) for (const entry of [...state.office.calendar].reverse()) {
      if (!rooms.some((room) => room.id === entry.room_id)) continue;
      consider({type:"calendar",room_id:entry.room_id,id:entry.id,title:entry.title,event:copy(entry),revision:entry.revision,
        author_id:entry.created_by,at:dateValue(entry.created_at),time_basis:"created_at"}, () => `${entry.title}\n${entry.description || ""}\n${entry.location || ""}`);
    }
    return {query,results,truncated,filters,time_bounds:"after_inclusive_before_exclusive",supported_types:TYPES};
  };
}
module.exports = {createNativeSearch};
