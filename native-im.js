"use strict";

// Native IM is a local, single-writer office protocol. Credentials and leases are
// operational state; the complete work context is inspectable and exportable.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createOfficeFeatures } = require("./office-features");
const { createAttachments } = require("./native-attachments");
const { createAccounts } = require("./native-accounts");
const { createWorkforce } = require("./native-workforce");
const { createNativeMail } = require("./native-mail");
const { createNativeSettings } = require("./native-settings");
const { createNativeMinutes } = require("./native-minutes");
const { createMessageGroups } = require("./native-message-groups");
const { createRoomDetails } = require("./native-room-details");
const { createNativePlugins } = require("./native-plugins");
const { createNativeEnterprise } = require("./native-enterprise");
const { createNativeAppPolicies } = require("./native-app-policies");
const { problem, requireText, fingerprint } = require("./work-protocol");
const PROTOCOL = "active-im/v1";
const { AGENT_STORE, PROACTIVITY_CONTRACT, DEFAULT_COLLEAGUE_TEMPLATES } = require("./native-agent-catalog");
const { createNativeSearch } = require("./native-search");
const { createNativeActions, autonomy, validateAutonomy, digest, OPERATIONS } = require("./native-actions");
const REACTIONS = Object.freeze(["👍", "❤️", "🎉", "👀", "✅", "🙏"]);
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const copy = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const owns = (object, key) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
function equal(a, b) {
  const x = Buffer.from(hash(a || "")),
    y = Buffer.from(hash(b || ""));
  return crypto.timingSafeEqual(x, y);
}
function integer(value, fallback, min, max) {
  const number =
    value === null || value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw problem(422, "invalid_input", "无效数值或游标");
  return number;
}
function createNativeIM({
  file,
  adminToken,
  workspace,
  saveDocuments = () => {},
  now = Date.now,
  leaseMs = 180000,
  auth,
  defaultActivateId,
}) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      state.protocol !== PROTOCOL ||
      !Array.isArray(state.principals) ||
      !Array.isArray(state.rooms) ||
      !Array.isArray(state.events) ||
      !Number.isSafeInteger(state.sequence) ||
      state.sequence < 0 ||
      state.events.some((event, index) => event.seq !== index + 1) ||
      state.sequence !== state.events.length ||
      state.principals.some(
        (p) => !p.id || !/^[a-f0-9]{64}$/.test(p.token_hash),
      ) ||
      state.rooms.some(
        (r) =>
          !r.id ||
          !r.members ||
          !Array.isArray(r.messages) ||
          !Array.isArray(r.document_ids) ||
          !Array.isArray(r.tasks) ||
          !Array.isArray(r.turns),
      )
    )
      throw new Error("Invalid native IM state");
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Native IM state is corrupt; refusing to initialize an empty workspace",
      );
    state = {
      protocol: PROTOCOL,
      sequence: 0,
      principals: [],
      rooms: [],
      events: [],
    };
  }
  const waiters = new Set();
  const presence = new Map();
  state.friendships ||= {};
  state.default_colleagues ||= {version:1,identities:{},seeded_humans:{}};
  if (state.default_colleagues.version !== 1 || !state.default_colleagues.identities || !state.default_colleagues.seeded_humans ||
      Object.entries(state.default_colleagues.identities).some(([key,pid]) => !DEFAULT_COLLEAGUE_TEMPLATES.some(t=>t.id===key) || !state.principals.some(p=>p.id===pid && p.kind==="agent" && p.system_agent_key===key)))
    throw new Error("Default colleague state is corrupt; refusing to replace identities");
  let storageFailed = false;
  let durableSequence = state.sequence;
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue
      .catch(() => {})
      .then(() => {
        if (storageFailed)
          throw problem(
            503,
            "storage_failed",
            "持久化失败，服务已停止接受读写；请修复存储并重启",
          );
        return fn();
      });
    queue = run;
    return run;
  };
  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + ".tmp";
      const fd = fs.openSync(temporary, "w", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(state, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      if (state.sequence !== durableSequence)
        for (const wake of waiters) wake();
      durableSequence = state.sequence;
    } catch {
      // Fail stop: never serve a mutation that failed to become durable or
      // accidentally include it in a later unrelated successful transaction.
      storageFailed = true;
      for (const wake of waiters) wake();
      throw problem(
        503,
        "storage_failed",
        "持久化失败，服务已停止接受读写；请修复存储并重启",
      );
    }
  }
  const stamp = () => new Date(now()).toISOString();
  const managedToken = (pid) =>
    crypto
      .createHmac("sha256", adminToken)
      .update(`active-im/v1/managed-agent/${pid}`)
      .digest("base64url");
  function presenceView(pid) {
    const last = presence.get(pid);
    return {
      principal_id: pid,
      status: last && last.at + 60000 > now() ? last.status : "offline",
      at: last?.at || null,
      expires_at: last ? last.at + 60000 : null,
    };
  }
  const principalView = (p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    created_at: p.created_at,
    revoked: Boolean(p.revoked_at),
    disabled: Boolean(p.disabled_at),
    managed: Boolean(p.managed),
    proactive_capable: p.kind === "agent",
    ...(p.system_agent_key ? {system_agent_key:p.system_agent_key,template_source:"system_default"} : {}),
    ...Object.fromEntries(["category_id", "category_name", "source_organization_name", "source_department_name"].filter((key) => p[key] !== undefined).map((key) => [key, p[key]])),
    ...enterpriseFeatures.professionalView(p.id),
    ...(p.store_template_id
      ? {
          store_template_id: p.store_template_id,
          owner_id: p.owner_id,
          instructions: p.instructions,
          skills: p.skills || [],
          ...(AGENT_STORE.find(t=>t.id===p.store_template_id)?.device_capabilities ? {device_capabilities:copy(AGENT_STORE.find(t=>t.id===p.store_template_id).device_capabilities)} : {}),
        }
      : {}),
  });
  function principal(token) {
    const p = state.principals.find(
      (item) =>
        !item.revoked_at &&
        !item.disabled_at &&
        equal(item.token_hash, hash(token || "")),
    );
    const authenticated = p || accountFeatures.authenticate(token);
    if (!authenticated)
      throw problem(401, "unauthorized", "请使用有效的参与者凭据或登录会话");
    return authenticated;
  }
  function active(pid) {
    const p = state.principals.find(
      (item) => item.id === pid && !item.revoked_at && !item.disabled_at,
    );
    if (!p)
      throw problem(422, "invalid_principal", "参与者不存在、已停用或已撤销");
    return p;
  }
  function roomById(rid) {
    const room = state.rooms.find((r) => r.id === rid);
    if (!room) throw problem(404, "not_found", "会话不存在");
    return room;
  }
  function member(room, p, owner = false) {
    if (p.revoked_at || p.disabled_at)
      throw problem(401, "unauthorized", "凭据已停用或撤销");
    const m = owns(room.members, p.id) ? room.members[p.id] : null;
    if (!m) throw problem(403, "not_a_member", "需要当前会话成员资格");
    if (owner && m.role !== "owner")
      throw problem(403, "owner_required", "需要会话所有者权限");
    return m;
  }
  const memberView = (room, pid) => {
    const p = state.principals.find((item) => item.id === pid);
    return {
      principal_id: pid,
      name: p.name,
      kind: p.kind,
      disabled: Boolean(p.disabled_at),
      presence: presenceView(pid),
      read_seq: preferencesFor(room, pid).read_seq,
      ...room.members[pid],
      autonomy: autonomy(room.members[pid].autonomy),
      autonomy_available_operations: OPERATIONS.filter((name) => workspace.nativeActions || !name.endsWith("_document")),
    };
  };
  const members = (room) =>
    Object.keys(room.members).map((pid) => memberView(room, pid));
  const preferencesFor = (room, pid) => ({
    favorite: false,
    pinned: false,
    muted: false,
    read_seq: 0,
    ...(room.preferences?.[pid] || {}),
  });
  const roomView = (room, viewer) => ({
    id: room.id,
    name: room.name,
    description: room.description,
    created_by: room.created_by,
    created_at: room.created_at,
    revision: room.revision,
    ...(room.kind !== "direct" ? {
      profile_revision: roomDetails.profile(room).revision,
      announcement_revision: roomDetails.announcement(room).revision,
      announcement_preview: roomDetails.announcement(room).content.slice(0, 280),
    } : {}),
    message_count: room.messages.length,
    last_message: room.messages.at(-1) || null,
    document_count:
      !viewer || appPolicies.allowed("docs", viewer.id)
        ? room.document_ids.length
        : 0,
    task_count:
      !viewer || appPolicies.allowed("tasks", viewer.id)
        ? room.tasks.length
        : 0,
    kind: room.kind || "group",
    ...(viewer
      ? {
          preferences: preferencesFor(room, viewer.id),
          message_grouping: messageGroups.grouping(room,viewer),
          is_favorite: preferencesFor(room, viewer.id).favorite,
          is_pinned: preferencesFor(room, viewer.id).pinned,
          muted: preferencesFor(room, viewer.id).muted,
          read_seq: preferencesFor(room, viewer.id).read_seq,
          unread_count: room.messages.filter(
            (message) =>
              message.author_id !== viewer.id &&
              !message.retracted_at &&
              message.seq > preferencesFor(room, viewer.id).read_seq,
          ).length,
        }
      : {}),
  });
  function turnView(turn) {
    const { lease_hash, finished_lease_hash, finish_hash, document_intents, ...visible } = turn;
    return copy(visible);
  }
  function turnSummary(turn) {
    const { context, ...visible } = turnView(turn);
    const {
      captured_at,
      principal,
      model,
      reasoning_effort,
      document_manifest,
      task_manifest,
      message_manifest,
      office,
      policy,
      omissions,
      cursor,
    } = context;
    return {
      ...visible,
      context_available: true,
      context_summary: {
        captured_at,
        principal,
        model,
        reasoning_effort,
        document_manifest,
        task_manifest,
        message_manifest,
        ...(office
          ? {
              office: {
                manifest: office.manifest,
                omissions: office.omissions,
                character_budget: office.character_budget,
              },
            }
          : {}),
        policy,
        omissions,
        cursor,
      },
    };
  }
  function event(room, type, actor, payload = {}) {
    const e = {
      seq: ++state.sequence,
      type,
      room_id: room?.id || null,
      actor_id: actor,
      at: stamp(),
      ...copy(payload),
    };
    state.events.push(e);
    return e;
  }
  function publishPersonalEvent(kind, actorId, payload, audienceIds) {
    if (
      !Array.isArray(audienceIds) ||
      audienceIds.length < 1 ||
      audienceIds.length > 1000
    )
      throw problem(
        422,
        "invalid_event_audience",
        "个人事件需要明确的参与者接收范围",
      );
    const audience_ids = [...new Set(audienceIds.map((pid) => active(pid).id))];
    return event(null, kind, actorId, {
      ...payload,
      room_id: null,
      audience_ids,
    });
  }
  function cancelRunning(room, principalId, actorId, rationale) {
    for (const turn of room.turns) {
      if (turn.principal_id !== principalId || turn.status !== "running")
        continue;
      turn.status = "cancelled";
      turn.finished_at = stamp();
      turn.result = { action: "blocked", rationale };
      delete turn.lease_hash;
      event(room, "turn.finished", actorId, {
        turn_id: turn.id,
        status: turn.status,
      });
    }
  }
  function invalidateMessageRuns(room, messageId, actorId) {
    for (const turn of room.turns) {
      if (turn.status !== "running") continue;
      if (
        turn.context.trigger.message?.id !== messageId &&
        !turn.context.messages.some((message) => message.id === messageId)
      )
        continue;
      turn.status = "stale";
      turn.finished_at = stamp();
      turn.result = {
        action: "silent",
        rationale: "输入消息已编辑或撤回，本次运行已取消",
      };
      delete turn.lease_hash;
      event(room, "turn.finished", actorId, {
        turn_id: turn.id,
        status: turn.status,
      });
    }
  }
  function newRoom(p, input, peer) {
    if (state.rooms.length >= 500)
      throw problem(409, "limit_reached", "会话数量已达本地预览上限");
    const room = {
      id: id("room"),
      kind: peer ? "direct" : "group",
      name: requireText(input.name, "name", 100),
      description: String(input.description || "").slice(0, 4000),
      created_by: p.id,
      created_at: stamp(),
      revision: 1,
      members: {},
      preferences: {},
      messages: [],
      document_ids: [],
      document_versions: {},
      tasks: [],
      turns: [],
      idempotency: {},
    };
    for (const person of [p, ...(peer ? [peer] : [])]) {
      room.members[person.id] = {
        role: person.id === p.id ? "owner" : "member",
        mode: person.kind === "agent" ? "active" : "mentions",
        cursor: state.sequence,
        joined_at: stamp(),
      };
      room.preferences[person.id] = {
        favorite: false,
        muted: false,
        read_seq: state.sequence,
      };
    }
    if (peer) room.direct_pair = [p.id, peer.id].sort().join(":");
    state.rooms.push(room);
    event(room, "room.created", p.id);
    return room;
  }
  const messageManifest = (messages) =>
    messages.map((message) => ({
      id: message.id,
      revision: message.revision || 1,
      retracted_at: message.retracted_at || null,
    }));
  function messageContext(message) {
    const { history, reactions, ...visible } = message;
    return {
      ...copy(visible),
      attachments: attachmentFeatures.contextMetadata(message),
    };
  }
  function messageText(value, attachments = []) {
    const text = value === undefined ? "" : value;
    if (
      typeof text !== "string" ||
      text.length > 12000 ||
      (!text.trim() && attachments.length === 0)
    )
      throw problem(
        422,
        "invalid_input",
        "消息需要正文或附件，正文最多 12000 字符",
      );
    return text;
  }
  const docRoute = (did = "") =>
    `/api/workspace/documents${did ? "/" + did : ""}`;
  async function documents(room) {
    const result = [];
    for (const did of room.document_ids)
      result.push(
        await workspace.handle("GET", docRoute(did), {}, "native-im"),
      );
    return result;
  }
  async function observeDocuments(room) {
    const docs = await documents(room);
    let changed = false;
    room.document_versions ||= {};
    for (const doc of docs) {
      const signature = `${doc.revision}:${doc.content_hash}`;
      if (room.document_versions[doc.id] !== signature) {
        room.document_versions[doc.id] = signature;
        event(room, "document.updated", "collaborator", {
          document_id: doc.id,
          revision: doc.revision,
          content_hash: doc.content_hash,
        });
        changed = true;
      }
    }
    if (changed) persist();
    return docs;
  }
  function mentionsFor(room, value = []) {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some((pid) => !owns(room.members, pid))
    )
      throw problem(422, "invalid_mentions", "提及对象必须是当前会话成员");
    return [...new Set(value)].sort();
  }
  function appendMessage(room, p, input, cause) {
    const attachments = attachmentFeatures.forMessage(
      room,
      input.attachment_ids,
    );
    const parent = input.reply_to
      ? room.messages.find((m) => m.id === input.reply_to)
      : null;
    if (input.reply_to && !parent)
      throw problem(422, "invalid_reply", "回复消息不在当前会话");
    const message = {
      id: id("msg"),
      seq: state.sequence + 1,
      author_id: p.id,
      author: principalView(p),
      content: messageText(input.content, attachments),
      attachment_ids: attachments.map((attachment) => attachment.id),
      attachments,
      ...(input.forwarded_from
        ? { forwarded_from: copy(input.forwarded_from) }
        : {}),
      mentions: mentionsFor(room, input.mentions),
      reply_to: parent?.id || null,
      root_id: cause?.root_id || parent?.root_id || null,
      depth: cause
        ? cause.depth
        : p.kind === "human"
          ? 0
          : (parent?.depth || 0) + 1,
      at: stamp(),
      revision: 1,
      edited_at: null,
      retracted_at: null,
      history: [],
      reactions: {},
      pinned: false,
    };
    // Human turns establish a new bounded collaboration root, including replies.
    if (!cause && p.kind === "human") message.root_id = message.id;
    message.root_id ||= message.id;
    if (cause) message.turn_id = cause.turn_id;
    room.messages.push(message);
    attachmentFeatures.link(message);
    event(room, "message.created", p.id, { message });
    return message;
  }
  function addContact(p, pid) {
    const person = active(pid);
    if (person.id === p.id) throw problem(422, "invalid_principal", "请选择另一位参与者作为联系人");
    const current = state.friendships[p.id] || {}, duplicate = owns(current, person.id);
    if (!duplicate && Object.keys(current).length >= 100) throw problem(409, "limit_reached", "联系人已达本地预览上限");
    if (!duplicate) {
      state.friendships[p.id] ||= {};
      state.friendships[p.id][person.id] = true;
      publishPersonalEvent("contact.added", p.id, { principal_id: person.id }, [p.id]);
    }
    return { person, duplicate };
  }
  function defaultColleagueView(p, status) {
    const defaults = state.default_colleagues;
    return {version:1,status:status || (p && !owns(defaults.seeded_humans,p.id)?"not_seeded":"ready"),seeded:Boolean(p && owns(defaults.seeded_humans,p.id)),
      colleagues:DEFAULT_COLLEAGUE_TEMPLATES.map(template=>{
        const person=state.principals.find(v=>v.id===defaults.identities[template.id]);
        return {template_id:template.id,principal_id:person?.id || null,name:person?.name || template.name,
          status:!person?"not_created":person.revoked_at?"revoked":person.disabled_at?"disabled":"available",
          in_contacts:Boolean(p && person && owns(state.friendships[p.id] || {},person.id))};
      })};
  }
  function ensureDefaultColleagues(p, legacyId) {
    const defaults=state.default_colleagues;
    const missing=DEFAULT_COLLEAGUE_TEMPLATES.filter(t=>!owns(defaults.identities,t.id));
    let legacy;
    if(legacyId!==undefined){
      // An already-adopted colleague may later be disabled or revoked. Keep
      // that decision across restarts even when the startup ID remains set.
      legacy=defaults.identities["activate-agent"]===legacyId?state.principals.find(person=>person.id===legacyId):active(legacyId);
      if(legacy.kind!=="agent" || (legacy.system_agent_key && legacy.system_agent_key!=="activate-agent"))throw problem(422,"invalid_default_colleague","默认入门同事必须是明确指定的Agent身份");
      if(defaults.identities["activate-agent"] && defaults.identities["activate-agent"]!==legacyId)throw problem(409,"default_colleague_exists","默认入门身份已建立，不能隐式替换其关系或工作历史");
    }
    if(state.principals.length+missing.length-(legacy && missing.some(t=>t.id==="activate-agent")?1:0)>1000)return defaultColleagueView(p,"principal_capacity_reached");
    let changed=false;
    for(const template of missing){
      let person=template.id==="activate-agent" && legacy;
      if(person){
        person.system_agent_key=template.id;
        // Only an explicitly identified development default with its original
        // default label is renamed. Credentials and custom persona stay intact.
        if(person.name==="Active Agent")person.name="activate-agent";
        person.instructions ??= template.instructions;
        person.skills ??= copy(template.skills);
        person.store_template_id ??= template.id;
        enterpriseFeatures.auditManagement(null,"member.default_adopted","member",person.id,{system_agent_key:template.id,credential_preserved:true});
      }else{
        const pid=id("principal");
        person={id:pid,name:template.name,kind:"agent",created_at:stamp(),managed:true,system_agent_key:template.id,
          store_template_id:template.id,instructions:template.instructions,skills:copy(template.skills),
          ...Object.fromEntries(["category_id","category_name","profession","job_title","organization_name","department_name"].map(key=>[key,template[key]])),
          source_organization_name:template.organization_name,source_department_name:template.department_name,
          token_hash:hash(managedToken(pid))};
        state.principals.push(person);
        enterpriseFeatures.registerPrincipal(person.id,null,"default_colleague");
      }
      defaults.identities[template.id]=person.id;changed=true;
    }
    const humans=p?[p]:state.principals.filter(person=>person.kind==="human"&&!person.revoked_at&&!person.disabled_at);
    let status="ready";
    for(const human of humans){
      if(human.kind!=="human"||owns(defaults.seeded_humans,human.id))continue;
      const available=DEFAULT_COLLEAGUE_TEMPLATES.map(t=>state.principals.find(v=>v.id===defaults.identities[t.id])).filter(v=>v&&!v.revoked_at&&!v.disabled_at);
      const toAdd=available.filter(v=>!owns(state.friendships[human.id]||{},v.id));
      if(Object.keys(state.friendships[human.id]||{}).length+toAdd.length>100){status="contact_capacity_reached";continue;}
      for(const person of toAdd)addContact(human,person.id);
      defaults.seeded_humans[human.id]={at:stamp()};changed=true;
    }
    if(changed)persist();
    return defaultColleagueView(p,status);
  }
  function reduceTask(operation, room, p, input, cause = {}) {
    member(room, p);
    const current = operation === "update" ? room.tasks.find((t) => t.id === input.task_id) : null;
    if (operation === "update" && !current) throw problem(404, "not_found", "任务不存在");
    if (current && !Number.isInteger(input.base_revision)) throw problem(422, "version_required", "请提供 base_revision");
    if (current && current.revision !== input.base_revision) throw problem(409, "conflict", "任务版本已变化，请刷新后重试");
    if (!current && room.tasks.length >= 500) throw problem(409, "limit_reached", "每个会话最多 500 项任务");
    if (input.assignee_id) { active(input.assignee_id); if (!owns(room.members, input.assignee_id)) throw problem(422, "invalid_assignee", "负责人必须是会话成员"); }
    if (input.status !== undefined && !["open", "doing", "done"].includes(input.status)) throw problem(422, "invalid_status", "无效任务状态");
    const changes = {};
    if (!current || input.title !== undefined) changes.title = requireText(input.title, "title", 200);
    if (!current || input.description !== undefined) changes.description = String(input.description || "").slice(0, 12000);
    if (!current || input.assignee_id !== undefined) changes.assignee_id = input.assignee_id || null;
    if (input.status !== undefined && current) changes.status = input.status;
    const task = current || { id: id("task"), status: "open", revision: 0, created_by: p.id, created_at: stamp() };
    Object.assign(task, changes); task.revision += 1; task.updated_at = stamp();
    if (!current) room.tasks.push(task);
    event(room, current ? "task.updated" : "task.created", p.id, { task: copy(task), ...cause });
    return task;
  }
  function boundedContext(room, p, trigger, docs) {
    let remaining = 40000;
    const messages = [];
    for (const message of [...room.messages].reverse()) {
      if (messages.length === 40 || message.content.length > remaining) break;
      messages.unshift(messageContext(message));
      remaining -= message.content.length;
    }
    remaining = 60000;
    const selected = [],
      omitted = [];
    for (const doc of docs) {
      if (doc.content.length > remaining)
        omitted.push({
          id: doc.id,
          revision: doc.revision,
          content_hash: doc.content_hash,
          reason: "document_budget",
        });
      else {
        selected.push(copy(doc));
        remaining -= doc.content.length;
      }
    }
    remaining = 30000;
    const tasks = [];
    for (const task of [...room.tasks].reverse()) {
      const size = task.title.length + task.description.length;
      if (tasks.length === 100 || size > remaining) continue;
      tasks.unshift(copy(task));
      remaining -= size;
    }
    return {
      protocol: PROTOCOL,
      captured_at: stamp(),
      principal: principalView(p),
      room: roomView(room),
      room_details: roomDetails.snapshot(room),
      participants: members(room),
      trigger: copy(trigger),
      messages,
      message_manifest: messageManifest(messages),
      documents: selected,
      document_manifest: docs.map((doc) => ({
        id: doc.id,
        revision: doc.revision,
        content_hash: doc.content_hash,
      })),
      tasks,
      task_manifest: room.tasks.map((task) => ({
        id: task.id,
        revision: task.revision,
      })),
      office: officeFeatures.contextSnapshot(room.id),
      actions: actionFeatures.capabilities(room, p),
      policy: {
        autonomy: autonomy(room.members[p.id].autonomy),
        mode: room.members[p.id].mode,
        membership_revision: room.revision,
        max_depth: 3,
        max_replies_per_root: 12,
        context_messages: 40,
        document_chars: 60000,
        task_chars: 30000,
      },
      omissions: {
        messages: room.messages.length - messages.length,
        documents: omitted,
        tasks: room.tasks.length - tasks.length,
      },
      cursor: state.sequence,
    };
  }
  function eligible(room, p, m, e) {
    if (e.seq <= m.cursor || e.actor_id === p.id || e.room_id !== room.id)
      return false;
    if ((e.depth ?? e.message?.depth ?? 0) >= 3) return false;
    if (e.type === "agent.review") return m.mode === "active" && e.principal_id === p.id;
    if (e.type.startsWith("calendar.")) return m.mode === "active" && e.event?.attendee_ids?.includes(p.id);
    if (e.type === "message.created" || e.type === "message.updated") {
      const message = e.message;
      if (
        message.retracted_at ||
        room.messages.find((current) => current.id === message.id)?.retracted_at
      )
        return false;
      if (message.depth >= 3) return false;
      if (message.author.kind === "agent" && !message.mentions.includes(p.id))
        return false;
      if (m.mode === "mentions" && !message.mentions.includes(p.id))
        return false;
      return true;
    }
    if (e.type === "task.created" || e.type === "task.updated")
      return e.task.assignee_id === p.id && e.task.status !== "done";
    return m.mode === "active" && e.type.startsWith("document.");
  }
  async function claim(room, p, input) {
    const m = member(room, p);
    if (p.kind !== "agent")
      throw problem(
        403,
        "agent_required",
        "自动运行租约仅用于 Agent，文档、任务和消息权限与人相同",
      );
    if (m.mode === "paused") return { turn: null };
    const requestedLease =
      input.lease_seconds === undefined
        ? leaseMs
        : integer(input.lease_seconds, 180, 30, 360) * 1000;
    const invocation = {
      instructions:
        input.instructions === undefined
          ? ""
          : requireText(input.instructions, "instructions", 16000),
      model:
        input.model === undefined ? "" : requireText(input.model, "model", 200),
      reasoning_effort:
        input.reasoning_effort === undefined
          ? ""
          : requireText(input.reasoning_effort, "reasoning_effort", 40),
    };
    let pending = room.turns.find(
      (t) => t.principal_id === p.id && t.status === "running",
    );
    if (pending?.action_receipts?.some((r) => r.status === "applying")) await actionFeatures.read(room, p, pending.id);
    const docs = await observeDocuments(room);
    if (pending && pending.lease_expires_at > now()) return { turn: null };
    if (pending && pending.attempt >= 3) {
      pending.status = "blocked";
      pending.finished_at = stamp();
      pending.result = {
        action: "blocked",
        rationale: "运行租约连续三次到期，请检查执行器后发送新消息重试",
      };
      delete pending.lease_hash;
      event(room, "turn.finished", p.id, {
        turn_id: pending.id,
        status: pending.status,
      });
      persist();
      pending = null;
    }
    if (!pending) {
      const config = autonomy(m.autonomy);
      const reviewInitialized = m.last_review_at === undefined;
      if (m.mode === "active" && config.enabled && now() - (m.last_review_at ?? now()) >= config.review_interval_seconds * 1000 &&
          (room.tasks.some((task) => task.assignee_id === p.id && task.status !== "done") || state.office.calendar.some((item) => item.room_id === room.id && item.status === "scheduled" && item.attendee_ids.includes(p.id) && Date.parse(item.ends_at) > now() && Date.parse(item.starts_at) <= now() + 86400000))) {
        m.last_review_at = now();
        event(room, "agent.review", "scheduler", { principal_id: p.id, root_id: `review-${room.id}-${p.id}-${Math.floor(now() / (config.review_interval_seconds * 1000))}`, depth: 0 });
      }
      if (m.last_review_at === undefined) m.last_review_at = now();
      const candidates = state.events.filter((e) => eligible(room, p, m, e));
      let trigger;
      for (const candidate of candidates.reverse()) {
        const root =
          candidate.root_id ||
          candidate.message?.root_id ||
          `event-${candidate.seq}`;
        if (
          room.turns.some((t) => t.principal_id === p.id && t.root_id === root)
        )
          continue;
        if (room.turns.filter((t) => t.root_id === root).length >= 12) continue;
        trigger = candidate;
        break;
      }
      const cursorChanged = m.cursor !== state.sequence;
      m.cursor = state.sequence;
      if (!trigger) {
        if (cursorChanged || reviewInitialized) persist();
        return { turn: null };
      }
      pending = {
        id: id("turn"),
        principal_id: p.id,
        root_id:
          trigger.root_id || trigger.message?.root_id || `event-${trigger.seq}`,
        trigger_seq: trigger.seq,
        depth: (trigger.depth ?? trigger.message?.depth ?? 0) + 1,
        status: "running",
        attempt: 0,
        created_at: stamp(),
        context: { ...boundedContext(room, p, trigger, docs), ...invocation },
      };
      pending.context.context_hash = digest(pending.context);
      room.turns.push(pending);
    }
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    pending.lease_hash = hash(leaseToken);
    pending.lease_expires_at = now() + requestedLease;
    pending.attempt += 1;
    event(room, "turn.claimed", p.id, {
      turn_id: pending.id,
      attempt: pending.attempt,
    });
    persist();
    return {
      turn: { ...turnView(pending), lease_token: leaseToken },
      context: copy(pending.context),
    };
  }
  async function finish(room, p, tid, input) {
    const m = member(room, p);
    const turn = room.turns.find(
      (t) => t.id === tid && t.principal_id === p.id,
    );
    if (!turn) throw problem(404, "not_found", "运行不存在");
    if (!input.lease_token || typeof input.lease_token !== "string")
      throw problem(422, "lease_required", "缺少运行租约");
    if (!["reply", "silent", "blocked"].includes(input.action))
      throw problem(422, "invalid_action", "无效运行结果");
    const result = {
      action: input.action,
      rationale: requireText(input.rationale, "rationale", 8000),
      model: requireText(input.model, "model", 200),
      reasoning_effort: requireText(
        input.reasoning_effort,
        "reasoning_effort",
        40,
      ),
    };
    if (
      (turn.context.model && result.model !== turn.context.model) ||
      (turn.context.reasoning_effort &&
        result.reasoning_effort !== turn.context.reasoning_effort)
    )
      throw problem(
        409,
        "invocation_mismatch",
        "结果必须匹配调用前公开的模型与思考配置",
      );
    if (input.action === "reply") {
      result.content = requireText(input.content, "content", 12000);
      result.mentions = mentionsFor(room, input.mentions);
      if (input.artifact)
        result.artifact = {
          title: requireText(input.artifact.title, "artifact.title", 200),
          content: requireText(
            input.artifact.content,
            "artifact.content",
            60000,
          ),
        };
    }
    // Recover canonical commits before deriving the visible authoritative
    // summary. A transport failure must never be reported as completed work.
    if (turn.status === "running" && turn.action_receipts?.some((r) => r.status === "applying")) {
      if (!equal(turn.lease_hash || "", hash(input.lease_token)) || turn.lease_expires_at <= now())
        throw problem(409, "lease_expired", "租约已失效，旧执行器不能发布结果");
      await actionFeatures.read(room, p, turn.id);
      if (turn.action_receipts.some((r) => r.status === "applying")) throw problem(503, "outcome_pending", "文档结果未确认，不能结束运行");
    }
    if (turn.action_plan) {
      const receipts = turn.action_receipts || [];
      if (receipts.length < turn.action_plan.steps.length && !receipts.some((r) => r.status === "rejected") && input.action !== "blocked")
        throw problem(409, "plan_incomplete", "冻结动作尚未全部执行，不能报告完成");
      result.action_summary = actionFeatures.summary(turn);
      if (result.content) result.content += "\n\n[服务端动作回执]\n" + result.action_summary.map((r) =>
        `${r.operation}: ${r.status}${r.resource_id ? " · " + r.resource_id : ""}${r.after_revision ? " · r" + r.after_revision : ""}${r.error_code ? " · " + r.error_code : ""}`).join("\n");
    }
    const payloadHash = hash(JSON.stringify(result));
    if (turn.status !== "running") {
      if (
        turn.finish_hash === payloadHash &&
        equal(turn.finished_lease_hash || "", hash(input.lease_token))
      )
        return {
          turn: turnView(turn),
          message:
            room.messages.find((message) => message.turn_id === turn.id) ||
            null,
          duplicate: true,
        };
      throw problem(409, "turn_finished", "运行已结束，不能重复提交不同结果");
    }
    if (
      !equal(turn.lease_hash || "", hash(input.lease_token)) ||
      turn.lease_expires_at <= now()
    )
      throw problem(409, "lease_expired", "租约已失效，旧执行器不能发布结果");
    const docs = await observeDocuments(room);
    // Canonical document reads can wait on CRDT I/O; the lease must remain
    // valid at the actual commit boundary, not only at the request boundary.
    if (
      !equal(turn.lease_hash || "", hash(input.lease_token)) ||
      turn.lease_expires_at <= now()
    )
      throw problem(409, "lease_expired", "租约已失效，旧执行器不能发布结果");
    const stale =
      m.mode === "paused" ||
      room.revision !== turn.context.policy.membership_revision ||
      JSON.stringify((turn.execution_manifest?.documents || turn.context.document_manifest)) !==
        JSON.stringify(
          docs.map((doc) => ({
            id: doc.id,
            revision: doc.revision,
            content_hash: doc.content_hash,
          })),
        ) ||
      JSON.stringify((turn.execution_manifest?.tasks || turn.context.task_manifest)) !==
        JSON.stringify(
          room.tasks.map((task) => ({ id: task.id, revision: task.revision })),
        ) ||
      JSON.stringify(
        turn.context.message_manifest || messageManifest(turn.context.messages),
      ) !==
        JSON.stringify(
          messageManifest(
            turn.context.messages.map(
              (message) =>
                room.messages.find((current) => current.id === message.id) ||
                message,
            ),
          ),
        ) ||
      (turn.context.office &&
        JSON.stringify((turn.execution_manifest?.office || turn.context.office.manifest)) !==
          JSON.stringify(officeFeatures.manifest(room.id)));
    if (stale) {
      turn.status = "stale";
      turn.finished_at = stamp();
      turn.result = {
        action: "silent",
        rationale:
          "会话权限、参与状态、消息、文档、任务或日程已变化，本次输出未发布",
      };
      delete turn.lease_hash;
      event(room, "turn.finished", p.id, { turn_id: turn.id, status: "stale" });
      persist();
      throw problem(409, "stale_context", turn.result.rationale);
    }
    let message = null;
    if (result.action === "reply")
      message = appendMessage(
        room,
        p,
        {
          content: result.content,
          mentions: result.mentions,
          reply_to: turn.context.trigger.message?.id,
        },
        { root_id: turn.root_id, depth: turn.depth, turn_id: turn.id },
      );
    turn.status = result.action === "reply" ? "replied" : result.action;
    turn.result = result;
    turn.finished_at = stamp();
    turn.finish_hash = payloadHash;
    turn.finished_lease_hash = turn.lease_hash;
    delete turn.lease_hash;
    event(room, "turn.finished", p.id, {
      turn_id: turn.id,
      status: turn.status,
    });
    persist();
    return { turn: turnView(turn), message, duplicate: false };
  }
  function exportRoom(room, docs) {
    const contract = {
      protocol: PROTOCOL,
      kind: "office_room",
      ...roomView(room),
      room_details: roomDetails.snapshot(room),
      members: members(room),
      documents: docs.map((d) => ({
        id: d.id,
        title: d.title,
        revision: d.revision,
        content_hash: d.content_hash,
      })),
      tasks: room.tasks,
      cursor: state.sequence,
    };
    // Each JSON fence is longer than any sequence in the value, preventing a
    // document or model output from escaping its visible structured snapshot.
    const fence = (value, language = "json") => {
      const data =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const length = Math.max(
        3,
        ...[...data.matchAll(/`+/g)].map((m) => m[0].length + 1),
      );
      return `${"`".repeat(length)}${language}\n${data}\n${"`".repeat(length)}`;
    };
    return (
      `# ${room.name}\n\n${room.description}\n\n## 会话契约\n\n${fence(contract, "active-im")}\n\n` +
      (room.kind !== "direct" ? `## 群公告\n\n${fence(roomDetails.announcement(room).content || "暂无群公告", "text")}\n\n## 群资料与公告修订审计\n\n${fence(state.events.filter((entry) => entry.room_id === room.id && ["room.profile.updated", "room.announcement.updated"].includes(entry.type)))}\n\n` : "") +
      `## 当前消息记录\n\n${room.messages.map((m) => `### ${m.at} · ${m.author.name} (${m.author.kind}) · #${m.seq}\n\n${m.retracted_at ? "[消息已撤回]" : m.content}\n\n${fence({ id: m.id, author_id: m.author_id, revision: m.revision || 1, retracted_at: m.retracted_at || null, mentions: m.mentions, reply_to: m.reply_to, root_id: m.root_id, depth: m.depth, reactions: m.reactions || {} })}`).join("\n\n")}\n\n` +
      `## 消息修订审计（包含已撤回历史，当前正文以上方为准）\n\n${room.messages
        .filter((m) => m.history?.length)
        .map((m) => `### ${m.id}\n\n${fence(m.history)}`)
        .join("\n\n")}\n\n` +
      `## 共享文档\n\n${docs.map((d) => `### ${d.title} · r${d.revision}\n\n${d.content}`).join("\n\n")}\n\n` +
      `## 会议与日程\n\n${fence(officeFeatures.roomRecords(room.id))}\n\n` +
      `## 附件索引（下载仍需当前会话凭据）\n\n${fence(attachmentFeatures.roomRecords(room.id))}\n\n` +
      `## 运行与精确上下文\n\n${room.turns.map((t) => `### ${t.id} · ${t.status}\n\n${fence(turnView(t))}`).join("\n\n")}\n`
    );
  }
  function pageEvents(p, after) {
    const allowed = new Set(
      state.rooms.filter((room) => room.members[p.id]).map((room) => room.id),
    );
    const events = state.events
      .filter(
        (e) =>
          e.seq > after &&
          appPolicies.eventAllowed(e, p) &&
          ((e.room_id === null &&
            Array.isArray(e.audience_ids) &&
            e.audience_ids.includes(p.id)) ||
            (allowed.has(e.room_id) && workforce.visibleEvent(e, p))),
      )
      .slice(0, 200);
    return {
      events: copy(
        events.map((entry) =>
          entry.room_id === null ? { ...entry, audience_ids: [p.id] } : entry,
        ),
      ),
      cursor: events.length === 200 ? events.at(-1).seq : state.sequence,
      high_watermark: state.sequence,
      reset_required: after > state.sequence,
    };
  }
  const accountFeatures = createAccounts({
    state,
    now,
    stamp,
    persist,
    active,
    principalView,
    auth,
  });
  const workforce = createWorkforce({
    state,
    now,
    stamp,
    persist,
    active,
    principalView,
    roomById,
    member,
    event,
  });
  const mailbox = createNativeMail({
    state,
    stamp,
    persist,
    active,
    principalView,
    publishPersonalEvent,
  });
  const personalSettings = createNativeSettings({
    state,
    stamp,
    persist,
    publishPersonalEvent,
  });
  const pluginFeatures = createNativePlugins({
    state,
    stamp,
    persist,
    publishPersonalEvent,
    enterprisePolicy: (pluginId, pid) =>
      appPolicies.presentation(pluginId, pid),
  });
  const officeFeatures = createOfficeFeatures({
    state,
    now,
    stamp,
    persist,
    serial,
    principal,
    active,
    principalView,
    roomById,
    member,
    event,
    readDocument: (did, pid) => workspace.handle("GET", docRoute(did), {}, pid),
    requireMeetingPolicy: (p) => appPolicies.requireMeeting(p),
  });
  const attachmentFeatures = createAttachments({
    state,
    directory: path.join(path.dirname(file), "attachments"),
    stamp,
    persist,
    roomById,
    member,
    event,
    invalidateMessageRuns,
  });
  function stopPrincipalWork(person, actorId, revoked) {
    accountFeatures.revokePrincipal(person.id);
    presence.delete(person.id);
    for (const room of state.rooms)
      if (owns(room.members, person.id)) {
        if (revoked) delete room.members[person.id];
        room.revision++;
        cancelRunning(
          room,
          person.id,
          actorId,
          revoked
            ? "参与者凭据已撤销，运行已取消"
            : "企业成员已停用，运行已取消",
        );
        event(room, revoked ? "member.revoked" : "member.disabled", actorId, {
          principal_id: person.id,
        });
      }
    officeFeatures.membershipChanged();
    for (const wake of waiters) wake();
  }
  function revokePrincipal(person, actorId) {
    person.revoked_at = stamp();
    stopPrincipalWork(person, actorId, true);
  }
  const enterpriseFeatures = createNativeEnterprise({
    state,
    stamp,
    persist,
    active,
    publishPersonalEvent,
    onDisabled: (person, actorId) => stopPrincipalWork(person, actorId, false),
    onRevoked: revokePrincipal,
    onMembershipChanged: (actorId) => policyChanged(actorId),
  });
  function policyChanged(actorId) {
    for (const room of state.rooms)
      for (const turn of room.turns)
        if (
          turn.status === "running" &&
          !appPolicies.contextAllowed(turn.principal_id)
        )
          cancelRunning(
            room,
            turn.principal_id,
            actorId,
            "企业应用策略变化，混合工作上下文已不可用，运行已取消",
          );
    officeFeatures.membershipChanged();
    for (const wake of waiters) wake();
  }
  const appPolicies = createNativeAppPolicies({
    state,
    stamp,
    persist,
    catalog: pluginFeatures.catalog,
    authorizeAdmin: enterpriseFeatures.authorizeAdmin,
    departmentOf: enterpriseFeatures.departmentOf,
    departments: enterpriseFeatures.departments,
    audit: enterpriseFeatures.auditManagement,
    publishPersonalEvent,
    changed: policyChanged,
  });
  const actionFeatures = createNativeActions({ state, stamp, now, persist, event, member, active, policies: appPolicies,
    reduceTask, addContact, office: officeFeatures, equal, documentsAdapter: workspace.nativeActions,
    snapshot: async (room, t) => ({ membership_revision: room.revision,
      messages: messageManifest(t.context.messages.map((old) => room.messages.find((m) => m.id === old.id) || old)),
      documents: (await documents(room)).map((d) => ({ id: d.id, revision: d.revision, content_hash: d.content_hash })),
      tasks: room.tasks.map((t) => ({ id: t.id, revision: t.revision })), office: officeFeatures.manifest(room.id) }),
  });
  const minutesFeatures = createNativeMinutes({state,stamp,persist,event,roomById,member,active,policies:appPolicies,attachments:attachmentFeatures});
  const messageGroups = createMessageGroups({state,stamp,persist,publishPersonalEvent,roomById,member,preferencesFor});
  const roomDetails = createRoomDetails({state,stamp,persist,event,roomById,member});
  const searchFeatures = createNativeSearch({state, workspace, docRoute, principalView, policies:appPolicies, workforce, mailbox, agentStore:AGENT_STORE});
  // Embedded CRDT uses this synchronous read-only fence immediately before a
  // Y transaction and each outbound frame. Never enter the IM queue or read a
  // document here: both would permit stale authorization or a queue deadlock.
  function authorizeDocument(credential, roomId, documentId) {
    if (storageFailed) throw problem(503, "storage_failed", "持久化失败，服务已停止接受读写");
    const p = principal(credential), room = roomById(roomId);
    member(room, p);
    appPolicies.requirePlugins(["im", "docs"], p);
    if (!room.document_ids.includes(documentId))
      throw problem(403, "document_scope", "文档不在当前会话的授权范围");
    return principalView(p);
  }
  async function authorizeStoredOperation(operation, credential) {
    return serial(() => {
      const p = principal(credential),
        pathname = operation?.pathname;
      if (
        typeof pathname !== "string" ||
        !pathname.startsWith("/api/im/") ||
        pathname.startsWith("/api/im/admin/")
      )
        throw problem(
          403,
          "receipt_scope_unverifiable",
          "旧操作没有可验证的成员授权范围",
        );
      appPolicies.requirePlugins(appPolicies.routePlugins(pathname), p);
      if (pathname.startsWith("/api/im/enterprise/admin/"))
        enterpriseFeatures.authorizeAdmin(p);
      if (
        pathname === "/api/im/library" &&
        operation.receipt?.rooms?.length &&
        !["docs", "tasks", "attendance", "approvals", "calendar"].some((id) =>
          appPolicies.allowed(id, p.id),
        )
      )
        appPolicies.requirePlugins(["docs"], p);
      const checkRoom = (rid) => member(roomById(rid), p);
      const checkId = (id) => {
        if (typeof id !== "string") return;
        const room = state.rooms.find((entry) => entry.id === id);
        if (room) member(room, p);
        if (state.minutes.records.some((entry) => entry.id === id)) minutesFeatures.authorize(id,p);
        const approval = state.workforce.approvals.find(
          (entry) => entry.id === id,
        );
        if (approval) {
          appPolicies.requirePlugins(["approvals"], p);
          workforce.authorizeRequest(id, p);
        }
        const attendance = state.workforce.records.find(
          (entry) => entry.id === id,
        );
        if (attendance) {
          appPolicies.requirePlugins(["attendance"], p);
          const membership = member(roomById(attendance.room_id), p);
          if (attendance.principal_id !== p.id && membership.role !== "owner")
            throw problem(
              403,
              "attendance_scope",
              "旧考勤回执不在当前本人或所有者授权范围",
            );
        }
        const meeting = state.office.meetings.find((entry) => entry.id === id);
        if (meeting) {
          appPolicies.requireMeeting(p);
          checkRoom(meeting.room_id);
        }
        const calendar = state.office.calendar.find((entry) => entry.id === id);
        if (calendar) {
          appPolicies.requirePlugins(["calendar"], p);
          checkRoom(calendar.room_id);
        }
        const delivery = state.mail.deliveries.find((entry) => entry.id === id);
        if (delivery) {
          appPolicies.requirePlugins(["mail"], p);
          if (delivery.principal_id !== p.id)
            throw problem(403, "mailbox_scope", "旧回执不属于当前邮箱");
        }
        const mail = state.mail.messages.find((entry) => entry.id === id);
        if (mail) {
          appPolicies.requirePlugins(["mail"], p);
          if (
            mail.sender_id !== p.id &&
            !state.mail.deliveries.some(
              (entry) => entry.message_id === id && entry.principal_id === p.id,
            )
          )
            throw problem(403, "mailbox_scope", "旧回执不属于当前邮箱");
        }
      };
      const routedRoom = pathname.match(/^\/api\/im\/rooms\/(room-[a-f0-9-]+)/);
      if (routedRoom) checkRoom(routedRoom[1]);
      for (const part of pathname.split("/")) checkId(part);
      let nodes = 0;
      const inspect = (value, depth = 0) => {
        if (!value || typeof value !== "object" || Buffer.isBuffer(value))
          return;
        if (++nodes > 10000 || depth > 30)
          throw problem(
            403,
            "receipt_scope_unverifiable",
            "旧回执过于复杂，不能验证当前授权",
          );
        if (Array.isArray(value)) {
          for (const child of value) inspect(child, depth + 1);
          return;
        }
        if(["message-groups/v1","message-grouping/v1"].includes(value.protocol) && value.principal_id!==p.id)
          throw problem(403,"personal_group_scope","个人分组回执仅属于其当前登录身份");
        const resultDomain = {
          message: "im",
          person: "im",
          agent: "im",
          store: "im",
          document: "docs",
          task: "tasks",
          mail: "mail",
          approval: "approvals",
          calendar: "calendar",
        }[value.type];
        if (resultDomain) appPolicies.requirePlugins([resultDomain], p);
        if (typeof value.id === "string" && value.id.startsWith("minute-")) {
          minutesFeatures.authorize(value.id,p);
          if (value.document_id) appPolicies.requirePlugins(["docs"],p);
          if (value.task_ids?.length) appPolicies.requirePlugins(["tasks"],p);
          if (value.meeting_id) appPolicies.requireMeeting(p);
          if (value.audio_attachment_id) {
            appPolicies.requirePlugins(["im"],p);
            attachmentFeatures.forMessage(roomById(value.room_id),[value.audio_attachment_id]);
          }
        }
        if (
          value.document ||
          value.documents?.length ||
          value.document_manifest?.length ||
          value.document_count > 0
        )
          appPolicies.requirePlugins(["docs"], p);
        if (
          value.task ||
          value.tasks?.length ||
          value.task_manifest?.length ||
          value.task_count > 0
        )
          appPolicies.requirePlugins(["tasks"], p);
        if (
          value.messages?.length ||
          value.message_manifest?.length ||
          value.message_count > 0 ||
          value.last_message
        )
          appPolicies.requirePlugins(["im"], p);
        if (value.runs?.length || value.turn || value.context_summary)
          appPolicies.requirePlugins(
            ["im", "docs", "tasks", "meetings", "calendar"],
            p,
          );
        if (value.meetings?.length || value.meeting)
          appPolicies.requireMeeting(p);
        if (typeof value.room_id === "string") checkRoom(value.room_id);
        for (const key of ["source_room_id", "target_room_id"])
          if (typeof value[key] === "string") checkRoom(value[key]);
        if (Array.isArray(value.room_ids))
          for (const rid of value.room_ids) checkRoom(rid);
        if (
          typeof value.type === "string" &&
          Number.isSafeInteger(value.seq) &&
          (!workforce.visibleEvent(value, p) ||
            !appPolicies.eventAllowed(value, p) ||
            (value.room_id === null &&
              (!Array.isArray(value.audience_ids) ||
                !value.audience_ids.includes(p.id))))
        )
          throw problem(
            403,
            "receipt_scope_revoked",
            "旧事件已不在当前业务授权范围",
          );
        checkId(value.id);
        // User-authored prose/payload is an explicit copy, not a new authority
        // reference. Structured result containers are checked recursively.
        for (const [key, child] of Object.entries(value))
          if (
            ![
              "content",
              "body",
              "payload",
              "instructions",
              "description",
              "details",
              "forwarded_from",
            ].includes(key)
          )
            inspect(child, depth + 1);
      };
      inspect(operation.input);
      for (const key of [
        "request_id",
        "approval_id",
        "meeting_id",
        "event_id",
        "mail_id",
      ])
        checkId(operation.input?.[key]);
      inspect(operation.receipt);
    });
  }
  async function handle(
    method,
    pathname,
    input = {},
    credential = "",
    params = new URLSearchParams(),
    signal,
  ) {
    const signalRoute = pathname.match(
      /^\/api\/im\/meetings\/(meeting-[a-f0-9-]+)\/signals$/,
    );
    if (signalRoute && method === "GET")
      return officeFeatures.poll(signalRoute[1], credential, params, signal);
    if (pathname === "/api/im/events" && method === "GET") {
      const after = integer(params.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
      const wait = integer(params.get("wait"), 0, 0, 25);
      let result = await serial(() => pageEvents(principal(credential), after));
      if (
        !result.events.length &&
        !result.reset_required &&
        wait > 0 &&
        !signal?.aborted
      ) {
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            waiters.delete(done);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, wait * 1000);
          waiters.add(done);
          signal?.addEventListener("abort", done, { once: true });
          // Close the registration race between reading the cursor and waiting.
          if (state.sequence > result.high_watermark) done();
        });
        result = await serial(() => pageEvents(principal(credential), after));
      }
      return result;
    }
    return serial(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw problem(422, "invalid_input", "请求必须是 JSON 对象");
      const publicAccountResult = await accountFeatures.handlePublic(
        method,
        pathname,
        input,
      );
      if (publicAccountResult !== undefined) return publicAccountResult;
      if (pathname.startsWith("/api/im/admin/")) {
        if (!credential || !equal(credential, adminToken))
          throw problem(401, "unauthorized", "此操作需要工作区管理凭据");
        if(pathname==="/api/im/admin/default-colleagues"&&method==="POST"){
          if(Object.keys(input).some(key=>key!=="legacy_activate_agent_id"))throw problem(422,"invalid_default_colleague","默认同事初始化仅接受明确的旧入门身份ID");
          return {default_colleagues:ensureDefaultColleagues(null,input.legacy_activate_agent_id)};
        }
        const enterpriseAdminResult = await enterpriseFeatures.handleAdmin(
          method,
          pathname,
          input,
        );
        if (enterpriseAdminResult !== undefined) return enterpriseAdminResult;
        const adminAccountResult = await accountFeatures.handleAdmin(
          method,
          pathname,
          input,
        );
        if (adminAccountResult !== undefined) {
          for (const wake of waiters) wake();
          return adminAccountResult;
        }
        const adminPluginResult = await pluginFeatures.handleAdmin(
          method,
          pathname,
          input,
        );
        if (adminPluginResult !== undefined) return adminPluginResult;
        if (pathname === "/api/im/admin/workers" && method === "GET") {
          let changed = false;
          const workers = state.principals
            .filter(
              (person) =>
                person.managed && !person.revoked_at && !person.disabled_at,
            )
            .map((person) => {
              const token = managedToken(person.id);
              if (person.token_hash !== hash(token)) {
                person.token_hash = hash(token);
                changed = true;
              }
              return { principal: principalView(person), token,
                runnable_room_count: appPolicies.contextAllowed(person.id) ? state.rooms.filter((room) =>
                  owns(room.members, person.id) && room.members[person.id].mode !== "paused").length : 0 };
            });
          if (changed) persist();
          return { workers };
        }
        if (pathname === "/api/im/admin/principals" && method === "POST") {
          if (!["human", "agent"].includes(input.kind))
            throw problem(422, "invalid_kind", "身份类型必须为 human 或 agent");
          if (state.principals.length >= 1000)
            throw problem(409, "limit_reached", "参与者数量已达本地预览上限");
          const token = crypto.randomBytes(32).toString("base64url");
          const p = {
            id: id("principal"),
            name: requireText(input.name, "name", 100),
            kind: input.kind,
            token_hash: hash(token),
            created_at: stamp(),
          };
          state.principals.push(p);
          enterpriseFeatures.registerPrincipal(p.id);
          persist();
          return { principal: principalView(p), token };
        }
        if (pathname === "/api/im/admin/revoke" && method === "POST") {
          const p = state.principals.find(
            (person) => person.id === input.principal_id && !person.revoked_at,
          );
          if (!p)
            throw problem(422, "invalid_principal", "参与者不存在或已撤销");
          enterpriseFeatures.externalRevoke(p.id);
          revokePrincipal(p, "admin");
          persist();
          return { revoked: true };
        }
        if (pathname === "/api/im/admin/import" && method === "POST") {
          const room = roomById(input.room_id);
          const doc = await workspace.handle(
            "GET",
            docRoute(requireText(input.document_id, "document_id", 100)),
            {},
            "admin",
          );
          if (!room.document_ids.includes(doc.id)) {
            if (room.document_ids.length >= 50)
              throw problem(409, "limit_reached", "每个会话最多 50 篇文档");
            room.document_ids.push(doc.id);
            room.document_versions[doc.id] =
              `${doc.revision}:${doc.content_hash}`;
            event(room, "document.imported", "admin", {
              document_id: doc.id,
              revision: doc.revision,
              content_hash: doc.content_hash,
            });
            persist();
          }
          return { document: doc };
        }
        throw problem(404, "not_found", "管理接口不存在");
      }
      const p = principal(credential);
      appPolicies.requirePlugins(appPolicies.routePlugins(pathname), p);
      if(p.kind==="human" && ((method==="GET" && ["/api/im/contacts","/api/im/agents"].includes(pathname)) || (method==="POST" && pathname==="/api/im/contacts/defaults"))) {
        if(method==="POST" && Object.keys(input).length)throw problem(422,"invalid_default_colleague","默认同事初始化不接受身份或权限覆盖");
        const defaults=ensureDefaultColleagues(p);
        if(method==="POST")return {default_colleagues:defaults};
      }
      if(pathname==="/api/im/contacts/defaults"&&method==="POST")throw problem(422,"human_required","默认同事联系人属于人类账号的入门配置");
      const appPolicyResult = await appPolicies.handle(
        method,
        pathname,
        input,
        p,
        params,
      );
      if (appPolicyResult !== undefined) return appPolicyResult;
      const enterpriseResult = await enterpriseFeatures.handle(
        method,
        pathname,
        input,
        p,
        params,
      );
      if (enterpriseResult !== undefined) return enterpriseResult;
      const pluginResult = await pluginFeatures.handle(
        method,
        pathname,
        input,
        p,
      );
      if (pluginResult !== undefined) return pluginResult;
      const accountResult = await accountFeatures.handle(
        method,
        pathname,
        input,
        p,
        credential,
      );
      if (accountResult !== undefined) {
        if (method !== "GET") for (const wake of waiters) wake();
        return accountResult;
      }
      const workforceResult = await workforce.handle(
        method,
        pathname,
        input,
        p,
        params,
      );
      if (workforceResult !== undefined) return workforceResult;
      const mailResult = await mailbox.handle(
        method,
        pathname,
        input,
        p,
        params,
      );
      if (mailResult !== undefined) return mailResult;
      const settingsResult = await personalSettings.handle(
        method,
        pathname,
        input,
        p,
        params,
      );
      if (settingsResult !== undefined) return settingsResult;
      const minutesResult = await minutesFeatures.handle(method,pathname,input,p,params);
      if (minutesResult !== undefined) return minutesResult;
      const groupsResult = await messageGroups.handle(method,pathname,input,p);
      if (groupsResult !== undefined) return groupsResult;
      const detailsResult = await roomDetails.handle(method,pathname,input,p);
      if (detailsResult !== undefined) return detailsResult;
      const officeResult = await officeFeatures.handle(
        method,
        pathname,
        input,
        p,
        params,
      );
      if (officeResult !== undefined) return officeResult;
      const attachmentResult = await attachmentFeatures.handle(
        method,
        pathname,
        input,
        p,
        params,
      );
      if (attachmentResult !== undefined) return attachmentResult;
      if (pathname === "/api/im/presence" && method === "POST") {
        if (!["online", "busy", "away", "offline"].includes(input.status))
          throw problem(422, "invalid_status", "无效连接状态");
        presence.set(p.id, { status: input.status, at: now() });
        return { presence: presenceView(p.id) };
      }
      if (pathname === "/api/im/me" && method === "GET")
        return { principal: principalView(p), protocol: PROTOCOL };
      if (pathname === "/api/im/contacts" && method === "GET")
        return {
          default_colleagues:p.kind==="human"?defaultColleagueView(p):null,
          contacts: state.principals
            .filter(
              (person) =>
                !person.revoked_at &&
                owns(state.friendships[p.id] || {}, person.id),
            )
            .map((person) => ({
              ...principalView(person),
              relationship: "friend",
              presence: presenceView(person.id),
            })),
        };
      if (pathname === "/api/im/contacts" && method === "POST") {
        const { person, duplicate } = addContact(p, input.principal_id);
        if (!duplicate) persist();
        return {
          contact: {
            ...principalView(person),
            relationship: "friend",
            presence: presenceView(person.id),
          },
          duplicate,
        };
      }
      const contactMatch = pathname.match(
        /^\/api\/im\/contacts\/(principal-[a-f0-9-]+)$/,
      );
      if (contactMatch && method === "DELETE") {
        const removed = owns(state.friendships[p.id] || {}, contactMatch[1]);
        if (removed) {
          delete state.friendships[p.id][contactMatch[1]];
          publishPersonalEvent(
            "contact.removed",
            p.id,
            { principal_id: contactMatch[1] },
            [p.id],
          );
          persist();
        }
        return { removed };
      }
      if (pathname === "/api/im/agent-store" && method === "GET")
        return { agents: copy(AGENT_STORE), reaction_options: REACTIONS, proactivity:copy(PROACTIVITY_CONTRACT) };
      const installMatch = pathname.match(
        /^\/api\/im\/agent-store\/([a-z][a-z0-9-]*)\/install$/,
      );
      if (installMatch && method === "POST") {
        const template = AGENT_STORE.find(
          (item) => item.id === installMatch[1],
        );
        if (!template) throw problem(404, "not_found", "Agent 模板不存在");
        const existing = state.principals.find(
          (person) =>
            person.owner_id === p.id &&
            person.store_template_id === template.id,
        );
        if (existing) {
          if (existing.revoked_at)
            throw problem(
              409,
              "agent_revoked",
              "已安装身份被管理员撤销，请联系管理员",
            );
          return {
            principal: principalView(existing),
            installed: true,
            duplicate: true,
          };
        }
        if (
          state.principals.length >= 1000 ||
          state.principals.filter(
            (person) => person.owner_id === p.id && person.managed,
          ).length >= 12
        )
          throw problem(
            409,
            "limit_reached",
            "专属 Agent 数量已达本地预览上限",
          );
        const agentId = id("principal");
        const person = {
          id: agentId,
          name: template.name,
          kind: "agent",
          created_at: stamp(),
          managed: true,
          owner_id: p.id,
          store_template_id: template.id,
          instructions: template.instructions,
          skills: template.skills,
          ...Object.fromEntries(["category_id", "category_name", "profession", "job_title", "organization_name", "department_name"].filter((key) => template[key] !== undefined).map((key) => [key, template[key]])),
          source_organization_name: template.organization_name,
          source_department_name: template.department_name,
          token_hash: hash(managedToken(agentId)),
        };
        state.principals.push(person);
        enterpriseFeatures.registerPrincipal(person.id, p, "agent_store");
        persist();
        return {
          principal: principalView(person),
          installed: true,
          duplicate: false,
        };
      }
      if (pathname === "/api/im/agents" && method === "GET") {
        const shared = new Set(
          state.rooms
            .filter((room) => owns(room.members, p.id))
            .flatMap((room) => Object.keys(room.members)),
        );
        return {
          default_colleagues:p.kind==="human"?defaultColleagueView(p):null,
          agents: state.principals
            .filter(
              (person) =>
                person.kind === "agent" &&
                !person.revoked_at &&
                person.id !== p.id &&
                (person.owner_id === p.id ||
                  owns(state.friendships[p.id] || {}, person.id) ||
                  shared.has(person.id)),
            )
            .map((person) => ({
              ...principalView(person),
              relationship:
                person.owner_id === p.id
                  ? "installed"
                  : owns(state.friendships[p.id] || {}, person.id)
                    ? "friend"
                    : "room",
              presence: presenceView(person.id),
            })),
        };
      }
      if (pathname === "/api/im/agents" && method === "POST") {
        const person = active(input.principal_id);
        if (person.kind !== "agent" || person.id === p.id)
          throw problem(
            422,
            "invalid_principal",
            "请选择另一位 Agent 作为好友",
          );
        state.friendships[p.id] ||= {};
        if (
          Object.keys(state.friendships[p.id]).length >= 100 &&
          !owns(state.friendships[p.id], person.id)
        )
          throw problem(409, "limit_reached", "Agent 好友已达本地预览上限");
        if (!owns(state.friendships[p.id], person.id)) {
          state.friendships[p.id][person.id] = true;
          persist();
        }
        return { principal: principalView(person), added: true };
      }
      if (pathname === "/api/im/rooms/direct" && method === "POST") {
        const peer = active(input.principal_id);
        if (peer.id === p.id)
          throw problem(422, "invalid_principal", "请选择另一位参与者");
        const pair = [p.id, peer.id].sort().join(":");
        const existing = state.rooms.find(
          (room) => room.kind === "direct" && room.direct_pair === pair,
        );
        if (existing) {
          if (!owns(existing.members, p.id) || !owns(existing.members, peer.id))
            throw problem(409, "direct_inactive", "私聊成员资格已撤销");
          return { room: roomView(existing, p), duplicate: true };
        }
        const room = newRoom(
          p,
          { name: `${p.name} · ${peer.name}`.slice(0, 100) },
          peer,
        );
        persist();
        return { room: roomView(room, p), duplicate: false };
      }
      if (pathname === "/api/im/search" && method === "GET") return searchFeatures(p, params);
      if (pathname === "/api/im/library" && method === "GET") {
        const documents = new Map(),
          tasks = [];
        let truncated = false;
        for (const room of state.rooms.filter((item) =>
          owns(item.members, p.id),
        )) {
          for (const did of appPolicies.allowed("docs", p.id)
            ? room.document_ids
            : []) {
            if (documents.has(did)) {
              documents.get(did).room_ids.push(room.id);
              continue;
            }
            if (documents.size >= 100) {
              truncated = true;
              continue;
            }
            const document = await workspace.handle(
              "GET",
              docRoute(did),
              {},
              p.id,
            );
            documents.set(did, {
              id: document.id,
              title: document.title,
              revision: document.revision,
              content_hash: document.content_hash,
              updated_at: document.updated_at,
              room_ids: [room.id],
            });
          }
          for (const task of appPolicies.allowed("tasks", p.id)
            ? room.tasks
            : []) {
            if (tasks.length >= 500) {
              truncated = true;
              break;
            }
            tasks.push({
              ...task,
              description: task.description.slice(0, 240),
              room_id: room.id,
              room_name: room.name,
            });
          }
        }
        return {
          documents: [...documents.values()],
          tasks,
          truncated,
          rooms: ["docs", "tasks", "attendance", "approvals", "calendar"].some(
            (id) => appPolicies.allowed(id, p.id),
          )
            ? state.rooms
                .filter((room) => owns(room.members, p.id))
                .map((room) => ({
                  id: room.id,
                  name: room.name,
                  members: state.principals
                    .filter(
                      (person) =>
                        owns(room.members, person.id) &&
                        !person.revoked_at &&
                        !person.disabled_at,
                    )
                    .map((person) => ({
                      principal_id: person.id,
                      name: person.name,
                      kind: person.kind,
                    })),
                }))
            : [],
        };
      }
      if (pathname === "/api/im/principals" && method === "GET")
        return {
          principals: state.principals
            .filter((x) => !x.revoked_at)
            .map(principalView),
        };
      if (pathname === "/api/im/rooms" && method === "GET")
        return {
          rooms: state.rooms
            .filter((r) => owns(r.members, p.id))
            .map((room) => roomView(room, p)),
          cursor: state.sequence,
        };
      if (pathname === "/api/im/rooms" && method === "POST") {
        if (input.kind !== undefined && input.kind !== "group")
          throw problem(422, "invalid_kind", "私聊请使用 /rooms/direct");
        const room = newRoom(p, input);
        persist();
        return { room: roomView(room, p) };
      }
      const match = pathname.match(
        /^\/api\/im\/rooms\/(room-[a-f0-9-]+)(?:\/(.*))?$/,
      );
      if (!match) throw problem(404, "not_found", "接口不存在");
      const room = roomById(match[1]),
        route = match[2] || "";
      const m = member(room, p);
      if (!route && method === "GET")
        return {
          room: roomView(room, p),
          members: members(room),
          messages: copy(room.messages.slice(-200)),
          documents: appPolicies.allowed("docs", p.id)
            ? await observeDocuments(room)
            : [],
          tasks: appPolicies.allowed("tasks", p.id) ? copy(room.tasks) : [],
          runs: appPolicies.contextAllowed(p.id)
            ? room.turns.slice(-20).map(turnSummary)
            : [],
          restricted_plugins: ["docs", "tasks", "meetings", "calendar"].filter(
            (id) => !appPolicies.allowed(id, p.id),
          ),
          cursor: state.sequence,
          has_more_messages: room.messages.length > 200,
          pins: copy(
            room.messages.filter(
              (message) => message.pinned && !message.retracted_at,
            ),
          ),
        };
      if (route === "export" && method === "GET")
        return exportRoom(room, await observeDocuments(room));
      if (route === "preferences" && method === "PATCH") {
        for (const field of ["favorite", "pinned", "muted"])
          if (input[field] !== undefined && typeof input[field] !== "boolean")
            throw problem(422, "invalid_input", `${field} 必须为布尔值`);
        const preferences = preferencesFor(room, p.id);
        if (input.read_seq !== undefined)
          preferences.read_seq = Math.max(
            preferences.read_seq,
            Math.min(
              integer(input.read_seq, 0, 0, state.sequence),
              room.messages.at(-1)?.seq || 0,
            ),
          );
        if (input.favorite !== undefined) preferences.favorite = input.favorite;
        if (input.pinned !== undefined) preferences.pinned = input.pinned;
        if (input.muted !== undefined) preferences.muted = input.muted;
        room.preferences ||= {};
        if (
          JSON.stringify(room.preferences[p.id]) !== JSON.stringify(preferences)
        ) {
          room.preferences[p.id] = preferences;
          event(room, "preferences.updated", p.id, {
            target_principal_id: p.id,
          });
          persist();
        }
        return { room: roomView(room, p), preferences: copy(preferences) };
      }
      if (route === "members" && method === "POST") {
        member(room, p, true);
        if (room.kind === "direct")
          throw problem(
            409,
            "direct_membership",
            "私聊保持两位参与者，请创建群聊邀请更多同事",
          );
        const next = active(input.principal_id);
        if (!room.members[next.id]) {
          if (Object.keys(room.members).length >= 100)
            throw problem(409, "limit_reached", "每个会话最多 100 名成员");
          room.members[next.id] = {
            role: "member",
            mode: next.kind === "agent" ? "active" : "mentions",
            cursor: state.sequence,
            joined_at: stamp(),
          };
          room.preferences ||= {};
          room.preferences[next.id] = {
            favorite: false,
            muted: false,
            read_seq: state.sequence,
          };
          room.revision += 1;
          event(room, "member.added", p.id, { principal_id: next.id });
          persist();
        }
        return { member: memberView(room, next.id) };
      }
      if (route.startsWith("members/") && method === "DELETE") {
        member(room, p, true);
        if (room.kind === "direct")
          throw problem(
            409,
            "direct_membership",
            "私聊成员固定；可使用静音管理消息提醒",
          );
        const pid = route.slice(8);
        if (pid === room.created_by)
          throw problem(409, "owner_required", "会话所有者不能移除自己");
        if (owns(room.members, pid)) {
          delete room.members[pid];
          room.revision += 1;
          cancelRunning(room, pid, p.id, "参与者已离开会话，运行已取消");
          event(room, "member.removed", p.id, { principal_id: pid });
          persist();
          officeFeatures.membershipChanged();
        }
        return { removed: true };
      }
      if (route === "participation" && method === "PATCH") {
        if(input.base_revision!==undefined && (!Number.isSafeInteger(input.base_revision) || input.base_revision!==room.revision))throw problem(Number.isSafeInteger(input.base_revision)?409:422,Number.isSafeInteger(input.base_revision)?"conflict":"version_required","会话版本已变化或无效，请读取当前版本后保存参与配置");
        if (input.mode !== undefined && !["active", "mentions", "paused"].includes(input.mode)) throw problem(422, "invalid_mode", "无效参与模式");
        if (input.mode === undefined && input.autonomy === undefined) throw problem(422, "invalid_mode", "需要参与模式或主动配置");
        const targetId = input.principal_id || p.id;
        if (targetId !== p.id) member(room, p, true);
        if (!owns(room.members, targetId)) throw problem(422, "invalid_principal", "参与者不是当前会话成员");
        const targetMember = room.members[targetId];
        let config;
        if (input.autonomy !== undefined) {
          if (!Number.isInteger(input.base_revision)) throw problem(422, "version_required", "主动配置需要房间当前 base_revision");
          if (input.base_revision !== room.revision) throw problem(409, "conflict", "会话版本已变化，请刷新后确认配置");
          if (active(targetId).kind !== "agent") throw problem(422, "agent_required", "主动动作配置属于 Agent 同事");
          config = validateAutonomy(input.autonomy);
        }
        if ((input.mode !== undefined && targetMember.mode !== input.mode) || (config && digest(config) !== digest(autonomy(targetMember.autonomy)))) {
          if (input.mode !== undefined) targetMember.mode = input.mode;
          if (config) targetMember.autonomy = config;
          targetMember.cursor = state.sequence; targetMember.last_review_at = now(); room.revision += 1;
          if (input.mode === "paused" || config) cancelRunning(room, targetId, p.id, "同事参与方式或主动配置已变化，后续动作停止");
          event(room, "participation.updated", p.id, { principal_id: targetId, mode: targetMember.mode, autonomy: autonomy(targetMember.autonomy) }); persist();
        }
        return { member: memberView(room, targetId), room_revision: room.revision };
      }
      if (route === "messages" && method === "GET") {
        const before = integer(
          params.get("before"),
          Number.MAX_SAFE_INTEGER,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        const limit = integer(params.get("limit"), 100, 1, 200);
        const query = params.has("q")
          ? requireText(params.get("q"), "q", 100).trim().toLocaleLowerCase()
          : null;
        const all = room.messages.filter(
          (message) =>
            message.seq < before &&
            (query === null ||
              (!message.retracted_at &&
                message.content.toLocaleLowerCase().includes(query))),
        );
        return {
          messages: copy(all.slice(-limit)),
          has_more: all.length > limit,
        };
      }
      if (route === "messages" && method === "POST") {
        const clientId = requireText(input.client_id, "client_id", 160);
        const attachments = attachmentFeatures.forMessage(
          room,
          input.attachment_ids,
        );
        const payload = {
          content: messageText(input.content, attachments),
          attachment_ids: attachments.map((attachment) => attachment.id),
          mentions: mentionsFor(room, input.mentions),
          reply_to: input.reply_to || null,
        };
        const key = `${p.id}:${clientId}`,
          digest = hash(JSON.stringify(payload));
        if (room.idempotency[key]) {
          if (room.idempotency[key].hash !== digest)
            throw problem(
              409,
              "idempotency_conflict",
              "同一 client_id 不能对应不同消息",
            );
          return {
            message: copy(
              room.messages.find(
                (item) => item.id === room.idempotency[key].message_id,
              ),
            ),
            duplicate: true,
          };
        }
        const message = appendMessage(room, p, payload);
        room.idempotency[key] = { hash: digest, message_id: message.id };
        persist();
        return { message: copy(message), duplicate: false };
      }
      if (route === "pins" && method === "GET")
        return {
          messages: copy(
            room.messages.filter(
              (message) => message.pinned && !message.retracted_at,
            ),
          ),
        };
      const pinMatch = route.match(/^messages\/(msg-[a-f0-9-]+)\/pin$/);
      if (pinMatch && method === "POST") {
        const message = room.messages.find((item) => item.id === pinMatch[1]);
        if (!message) throw problem(404, "not_found", "消息不存在");
        if (message.retracted_at)
          throw problem(409, "message_retracted", "消息已撤回");
        if (typeof input.pinned !== "boolean")
          throw problem(422, "invalid_input", "pinned 必须是布尔值");
        if (
          input.pinned &&
          !message.pinned &&
          room.messages.filter((item) => item.pinned && !item.retracted_at)
            .length >= 50
        )
          throw problem(409, "limit_reached", "每个会话最多置顶 50 条消息");
        if (Boolean(message.pinned) !== input.pinned) {
          message.pinned = input.pinned;
          message.pinned_by = p.id;
          message.pinned_at = stamp();
          event(room, "message.pinned", p.id, {
            message_id: message.id,
            pinned: input.pinned,
          });
          persist();
        }
        return { message: copy(message) };
      }
      const forwardMatch = route.match(/^messages\/(msg-[a-f0-9-]+)\/forward$/);
      if (forwardMatch && method === "POST") {
        const source = room.messages.find(
          (item) => item.id === forwardMatch[1],
        );
        if (!source) throw problem(404, "not_found", "消息不存在");
        const target = roomById(input.target_room_id);
        member(target, p);
        const clientId = requireText(input.client_id, "client_id", 160),
          key = `${p.id}:${clientId}`;
        if (!Number.isInteger(input.base_revision))
          throw problem(
            422,
            "version_required",
            "请提供被转发消息的 base_revision",
          );
        const digest = hash(
          JSON.stringify({
            operation: "forward",
            source_room_id: room.id,
            message_id: source.id,
            base_revision: input.base_revision,
          }),
        );
        if (target.idempotency[key]) {
          if (target.idempotency[key].hash !== digest)
            throw problem(
              409,
              "idempotency_conflict",
              "相同 client_id 对应不同转发",
            );
          return {
            message: copy(
              target.messages.find(
                (message) => message.id === target.idempotency[key].message_id,
              ),
            ),
            duplicate: true,
          };
        }
        if (source.retracted_at)
          throw problem(409, "message_retracted", "消息已撤回");
        if ((source.revision || 1) !== input.base_revision)
          throw problem(409, "conflict", "被转发消息已变化，请刷新后确认");
        const attachment_ids = attachmentFeatures.forward(
          room,
          target,
          p,
          source.attachment_ids || [],
        );
        const message = appendMessage(target, p, {
          content: source.content,
          mentions: [],
          attachment_ids,
          forwarded_from: {
            room_id: room.id,
            message_id: source.id,
            author_id: source.author_id,
            revision: source.revision || 1,
          },
        });
        target.idempotency[key] = { hash: digest, message_id: message.id };
        persist();
        return { message: copy(message), duplicate: false };
      }
      const messageMatch = route.match(/^messages\/(msg-[a-f0-9-]+)$/);
      if (messageMatch && method === "GET") {
        const message = room.messages.find((item) => item.id === messageMatch[1]);
        if (!message) throw problem(404, "not_found", "消息不存在于当前会话");
        const visible = (value) => {
          if (!value) return null;
          const { history, ...current } = copy(value);
          if (current.retracted_at) {
            current.content = "";
            current.attachment_ids = [];
            current.attachments = [];
            current.mentions = [];
            current.reactions = {};
            delete current.forwarded_from;
          }
          return current;
        };
        return {
          message: visible(message),
          reply_parent: visible(room.messages.find((item) => item.id === message.reply_to)),
        };
      }
      if (messageMatch && ["PATCH", "DELETE"].includes(method)) {
        const message = room.messages.find(
          (item) => item.id === messageMatch[1],
        );
        if (!message) throw problem(404, "not_found", "消息不存在");
        if (message.author_id !== p.id)
          throw problem(403, "author_required", "只有消息作者可以编辑或撤回");
        if (!Number.isInteger(input.base_revision))
          throw problem(422, "version_required", "请提供 base_revision");
        if (input.base_revision !== (message.revision || 1))
          throw problem(409, "conflict", "消息版本已变化");
        if (message.retracted_at)
          throw problem(409, "message_retracted", "消息已经撤回");
        const content =
          method === "PATCH"
            ? messageText(input.content, message.attachment_ids || [])
            : "";
        message.history ||= [];
        if (message.history.length >= 100)
          throw problem(409, "limit_reached", "每条消息最多 100 次修订");
        message.history.push({
          revision: message.revision || 1,
          content: message.content,
          at: stamp(),
          operation: method === "DELETE" ? "retract" : "edit",
          actor_id: p.id,
        });
        message.content = content;
        message.revision = (message.revision || 1) + 1;
        message.edited_at = stamp();
        if (method === "DELETE") {
          message.retracted_at = stamp();
          message.pinned = false;
        }
        invalidateMessageRuns(room, message.id, p.id);
        event(
          room,
          method === "DELETE" ? "message.retracted" : "message.updated",
          p.id,
          {
            message: messageContext(message),
            root_id: `edit-${message.id}-r${message.revision}`,
          },
        );
        persist();
        return { message: copy(message) };
      }
      const reactionMatch = route.match(
        /^messages\/(msg-[a-f0-9-]+)\/reactions$/,
      );
      if (reactionMatch && method === "POST") {
        const message = room.messages.find(
          (item) => item.id === reactionMatch[1],
        );
        if (!message) throw problem(404, "not_found", "消息不存在");
        if (message.retracted_at)
          throw problem(409, "message_retracted", "消息已经撤回");
        if (!REACTIONS.includes(input.emoji))
          throw problem(422, "invalid_reaction", "请选择支持的表情反应");
        message.reactions ||= {};
        const reactors = message.reactions[input.emoji] || [];
        message.reactions[input.emoji] = reactors.includes(p.id)
          ? reactors.filter((pid) => pid !== p.id)
          : [...reactors, p.id];
        event(room, "message.reactions", p.id, {
          message_id: message.id,
          reactions: copy(message.reactions),
        });
        persist();
        return { message: copy(message) };
      }
      if (route === "documents" && method === "POST") {
        if (room.document_ids.length >= 50)
          throw problem(409, "limit_reached", "每个会话最多 50 篇文档");
        const document = await workspace.handle(
          "POST",
          docRoute(),
          { title: input.title, content: input.content },
          p.id,
        );
        saveDocuments();
        room.document_ids.push(document.id);
        room.document_versions[document.id] =
          `${document.revision}:${document.content_hash}`;
        event(room, "document.created", p.id, {
          document_id: document.id,
          revision: document.revision,
          content_hash: document.content_hash,
        });
        persist();
        return { document };
      }
      if (route.startsWith("documents/") && ["GET", "PUT"].includes(method)) {
        const did = route.slice(10);
        if (!room.document_ids.includes(did))
          throw problem(403, "document_scope", "文档未共享到当前会话");
        const document = await workspace.handle(
          method,
          docRoute(did),
          {
            title: input.title,
            content: input.content,
            base_revision: input.base_revision,
          },
          p.id,
        );
        if (method === "PUT") {
          saveDocuments();
          room.document_versions[did] =
            `${document.revision}:${document.content_hash}`;
          event(room, "document.updated", p.id, {
            document_id: did,
            revision: document.revision,
            content_hash: document.content_hash,
          });
          persist();
        }
        return { document };
      }
      if (route === "tasks" && method === "POST") {
        const task = reduceTask("create", room, p, input);
        persist(); return { task: copy(task) };
      }
      if (route.startsWith("tasks/") && method === "PATCH") {
        const task = reduceTask("update", room, p, { ...input, task_id: route.slice(6) });
        persist(); return { task: copy(task) };
      }
      if (route === "turns/claim" && method === "POST")
        return claim(room, p, input);
      const planMatch = route.match(/^turns\/(turn-[a-f0-9-]+)\/plan$/);
      if (planMatch && method === "GET") return actionFeatures.read(room, p, planMatch[1]);
      if (planMatch && method === "POST") return actionFeatures.plan(room, p, planMatch[1], input);
      const operationMatch = route.match(/^turns\/(turn-[a-f0-9-]+)\/operations\/(operation-[a-f0-9]+)\/execute$/);
      if (operationMatch && method === "POST") return actionFeatures.execute(room, p, operationMatch[1], operationMatch[2], input);
      const finishMatch = route.match(/^turns\/(turn-[a-f0-9-]+)\/finish$/);
      if (finishMatch && method === "POST")
        return finish(room, p, finishMatch[1], input);
      const turnMatch = route.match(/^turns\/(turn-[a-f0-9-]+)$/);
      if (turnMatch && method === "GET") {
        const turn = room.turns.find((t) => t.id === turnMatch[1]);
        if (!turn) throw problem(404, "not_found", "运行不存在");
        return { turn: turnView(turn) };
      }
      throw problem(404, "not_found", "接口不存在");
    });
  }
  // The developer may identify the old built-in colleague explicitly before
  // accepting requests. Never infer this identity from its display name.
  if(defaultActivateId)ensureDefaultColleagues(null,defaultActivateId);
  return { handle, authorizeStoredOperation, authorizeDocument };
}
module.exports = { createNativeIM, PROTOCOL };
