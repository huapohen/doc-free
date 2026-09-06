"use strict";

// Native IM is a local, single-writer office protocol. Credentials and leases are
// operational state; the complete work context is inspectable and exportable.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { problem, requireText, fingerprint } = require("./work-protocol");
const PROTOCOL = "active-im/v1";
const AGENT_STORE = Object.freeze([
  {
    id: "product",
    name: "产品同事",
    description: "把讨论整理成产品方案、验收标准与可分配的工作。",
    skills: ["需求分析", "产品方案", "验收标准"],
    instructions:
      "你是一位产品同事。围绕共享的用户问题、目标、约束和资料形成可审阅方案，明确范围、取舍、验收标准和待确认事项。区分事实与假设。没有外部工具，不声称访问了网页、系统或完成了任务。",
  },
  {
    id: "reviewer",
    name: "评审同事",
    description: "基于可见资料检查方案中的遗漏、风险与一致性。",
    skills: ["方案评审", "风险检查", "质量标准"],
    instructions:
      "你是一位评审同事。只依据共享上下文检查方案的逻辑、遗漏、风险和可验证性，逐项说明依据、影响及可执行修改建议。区分阻塞问题与改进建议。没有执行测试或外部检索工具，不虚构验证结果。",
  },
  {
    id: "research",
    name: "研究同事",
    description: "综合团队提供的文档，形成证据清晰的研究备忘录。",
    skills: ["资料综合", "证据整理", "研究备忘录"],
    instructions:
      "你是一位研究同事。综合会话内提供的资料，引用文档标题与版本，标注证据、推论、未知项和下一步研究建议。没有浏览器或外部搜索工具，不能声称完成网络调研或编造来源。",
  },
]);
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
    managed: Boolean(p.managed),
    ...(p.store_template_id
      ? {
          store_template_id: p.store_template_id,
          owner_id: p.owner_id,
          instructions: p.instructions,
          skills: p.skills || [],
        }
      : {}),
  });
  function principal(token) {
    const p = state.principals.find(
      (item) => !item.revoked_at && equal(item.token_hash, hash(token || "")),
    );
    if (!p) throw problem(401, "unauthorized", "请使用独立参与者凭据登录");
    return p;
  }
  function active(pid) {
    const p = state.principals.find(
      (item) => item.id === pid && !item.revoked_at,
    );
    if (!p) throw problem(422, "invalid_principal", "参与者不存在或已撤销");
    return p;
  }
  function roomById(rid) {
    const room = state.rooms.find((r) => r.id === rid);
    if (!room) throw problem(404, "not_found", "会话不存在");
    return room;
  }
  function member(room, p, owner = false) {
    if (p.revoked_at) throw problem(401, "unauthorized", "凭据已撤销");
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
      presence: presenceView(pid),
      ...room.members[pid],
    };
  };
  const members = (room) =>
    Object.keys(room.members).map((pid) => memberView(room, pid));
  const preferencesFor = (room, pid) => ({
    favorite: false,
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
    message_count: room.messages.length,
    last_message: room.messages.at(-1) || null,
    document_count: room.document_ids.length,
    task_count: room.tasks.length,
    kind: room.kind || "group",
    ...(viewer
      ? {
          preferences: preferencesFor(room, viewer.id),
          is_favorite: preferencesFor(room, viewer.id).favorite,
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
    const { lease_hash, finished_lease_hash, finish_hash, ...visible } = turn;
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
    return copy(visible);
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
      value.length > 20 ||
      value.some((pid) => !owns(room.members, pid))
    )
      throw problem(422, "invalid_mentions", "提及对象必须是当前会话成员");
    return [...new Set(value)].sort();
  }
  function appendMessage(room, p, input, cause) {
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
      content: requireText(input.content, "content", 12000),
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
    };
    // Human turns establish a new bounded collaboration root, including replies.
    if (!cause && p.kind === "human") message.root_id = message.id;
    message.root_id ||= message.id;
    if (cause) message.turn_id = cause.turn_id;
    room.messages.push(message);
    event(room, "message.created", p.id, { message });
    return message;
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
      policy: {
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
    const docs = await observeDocuments(room);
    let pending = room.turns.find(
      (t) => t.principal_id === p.id && t.status === "running",
    );
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
        if (cursorChanged) persist();
        return { turn: null };
      }
      pending = {
        id: id("turn"),
        principal_id: p.id,
        root_id:
          trigger.root_id || trigger.message?.root_id || `event-${trigger.seq}`,
        trigger_seq: trigger.seq,
        depth: (trigger.message?.depth || 0) + 1,
        status: "running",
        attempt: 0,
        created_at: stamp(),
        context: { ...boundedContext(room, p, trigger, docs), ...invocation },
      };
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
      JSON.stringify(turn.context.document_manifest) !==
        JSON.stringify(
          docs.map((doc) => ({
            id: doc.id,
            revision: doc.revision,
            content_hash: doc.content_hash,
          })),
        ) ||
      JSON.stringify(turn.context.task_manifest) !==
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
        );
    if (stale) {
      turn.status = "stale";
      turn.finished_at = stamp();
      turn.result = {
        action: "silent",
        rationale: "会话权限、参与状态、文档或任务已变化，本次输出未发布",
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
      `## 当前消息记录\n\n${room.messages.map((m) => `### ${m.at} · ${m.author.name} (${m.author.kind}) · #${m.seq}\n\n${m.retracted_at ? "[消息已撤回]" : m.content}\n\n${fence({ id: m.id, author_id: m.author_id, revision: m.revision || 1, retracted_at: m.retracted_at || null, mentions: m.mentions, reply_to: m.reply_to, root_id: m.root_id, depth: m.depth, reactions: m.reactions || {} })}`).join("\n\n")}\n\n` +
      `## 消息修订审计（包含已撤回历史，当前正文以上方为准）\n\n${room.messages
        .filter((m) => m.history?.length)
        .map((m) => `### ${m.id}\n\n${fence(m.history)}`)
        .join("\n\n")}\n\n` +
      `## 共享文档\n\n${docs.map((d) => `### ${d.title} · r${d.revision}\n\n${d.content}`).join("\n\n")}\n\n` +
      `## 运行与精确上下文\n\n${room.turns.map((t) => `### ${t.id} · ${t.status}\n\n${fence(turnView(t))}`).join("\n\n")}\n`
    );
  }
  function pageEvents(p, after) {
    const allowed = new Set(
      state.rooms.filter((room) => room.members[p.id]).map((room) => room.id),
    );
    const events = state.events
      .filter((e) => e.seq > after && allowed.has(e.room_id))
      .slice(0, 200);
    return {
      events: copy(events),
      cursor: events.length === 200 ? events.at(-1).seq : state.sequence,
      high_watermark: state.sequence,
      reset_required: after > state.sequence,
    };
  }
  async function handle(
    method,
    pathname,
    input = {},
    credential = "",
    params = new URLSearchParams(),
    signal,
  ) {
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
      if (pathname.startsWith("/api/im/admin/")) {
        if (!credential || !equal(credential, adminToken))
          throw problem(401, "unauthorized", "此操作需要工作区管理凭据");
        if (pathname === "/api/im/admin/workers" && method === "GET") {
          let changed = false;
          const workers = state.principals
            .filter((person) => person.managed && !person.revoked_at)
            .map((person) => {
              const token = managedToken(person.id);
              if (person.token_hash !== hash(token)) {
                person.token_hash = hash(token);
                changed = true;
              }
              return { principal: principalView(person), token };
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
          persist();
          return { principal: principalView(p), token };
        }
        if (pathname === "/api/im/admin/revoke" && method === "POST") {
          const p = active(input.principal_id);
          p.revoked_at = stamp();
          for (const room of state.rooms)
            if (room.members[p.id]) {
              delete room.members[p.id];
              room.revision += 1;
              cancelRunning(
                room,
                p.id,
                "admin",
                "参与者凭据已撤销，运行已取消",
              );
              event(room, "member.revoked", "admin", { principal_id: p.id });
            }
          persist();
          for (const wake of waiters) wake();
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
      if (pathname === "/api/im/presence" && method === "POST") {
        if (!["online", "busy", "away", "offline"].includes(input.status))
          throw problem(422, "invalid_status", "无效连接状态");
        presence.set(p.id, { status: input.status, at: now() });
        return { presence: presenceView(p.id) };
      }
      if (pathname === "/api/im/me" && method === "GET")
        return { principal: principalView(p), protocol: PROTOCOL };
      if (pathname === "/api/im/agent-store" && method === "GET")
        return { agents: copy(AGENT_STORE), reaction_options: REACTIONS };
      const installMatch = pathname.match(
        /^\/api\/im\/agent-store\/([a-z]+)\/install$/,
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
          token_hash: hash(managedToken(agentId)),
        };
        state.principals.push(person);
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
      if (pathname === "/api/im/search" && method === "GET") {
        const query = requireText(params.get("q"), "q", 100).trim(),
          needle = query.toLocaleLowerCase();
        const results = [];
        let remainingMessages = 10000,
          remainingTasks = 2000,
          remainingDocuments = 100,
          truncated = false;
        const snippet = (text) => {
          const at = text.toLocaleLowerCase().indexOf(needle);
          return at < 0
            ? null
            : text.slice(Math.max(0, at - 100), at + needle.length + 200);
        };
        const rooms = state.rooms
          .filter((room) => owns(room.members, p.id))
          .sort(
            (a, b) =>
              (b.messages.at(-1)?.seq || 0) - (a.messages.at(-1)?.seq || 0),
          );
        for (const room of rooms) {
          for (const message of [...room.messages].reverse()) {
            if (remainingMessages-- <= 0 || results.length >= 100) {
              truncated = true;
              break;
            }
            const content = message.retracted_at
              ? null
              : snippet(message.content);
            if (content !== null)
              results.push({
                type: "message",
                room_id: room.id,
                id: message.id,
                title: room.name,
                content,
                revision: message.revision || 1,
              });
          }
          for (const task of [...room.tasks].reverse()) {
            if (remainingTasks-- <= 0 || results.length >= 100) {
              truncated = true;
              break;
            }
            const content = snippet(`${task.title}\n${task.description}`);
            if (content !== null)
              results.push({
                type: "task",
                room_id: room.id,
                id: task.id,
                title: task.title,
                content,
                revision: task.revision,
              });
          }
          for (const did of room.document_ids) {
            if (remainingDocuments-- <= 0 || results.length >= 100) {
              truncated = true;
              break;
            }
            const document = await workspace.handle(
              "GET",
              docRoute(did),
              {},
              p.id,
            );
            const content = snippet(`${document.title}\n${document.content}`);
            if (content !== null)
              results.push({
                type: "document",
                room_id: room.id,
                id: document.id,
                title: document.title,
                content,
                revision: document.revision,
              });
          }
          if (results.length >= 100) break;
        }
        return { query, results, truncated };
      }
      if (pathname === "/api/im/library" && method === "GET") {
        const documents = new Map(),
          tasks = [];
        let truncated = false;
        for (const room of state.rooms.filter((item) =>
          owns(item.members, p.id),
        )) {
          for (const did of room.document_ids) {
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
          for (const task of room.tasks) {
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
        return { documents: [...documents.values()], tasks, truncated };
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
          documents: await observeDocuments(room),
          tasks: copy(room.tasks),
          runs: room.turns.slice(-20).map(turnSummary),
          cursor: state.sequence,
          has_more_messages: room.messages.length > 200,
        };
      if (route === "export" && method === "GET")
        return exportRoom(room, await observeDocuments(room));
      if (route === "preferences" && method === "PATCH") {
        for (const field of ["favorite", "muted"])
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
        }
        return { removed: true };
      }
      if (route === "participation" && method === "PATCH") {
        if (!["active", "mentions", "paused"].includes(input.mode))
          throw problem(422, "invalid_mode", "无效参与模式");
        const targetId = input.principal_id || p.id;
        if (targetId !== p.id) member(room, p, true);
        if (!owns(room.members, targetId))
          throw problem(422, "invalid_principal", "参与者不是当前会话成员");
        const targetMember = room.members[targetId];
        if (targetMember.mode !== input.mode) {
          targetMember.mode = input.mode;
          targetMember.cursor = state.sequence;
          room.revision += 1;
          if (input.mode === "paused")
            cancelRunning(room, targetId, p.id, "参与者已暂停，运行已取消");
          event(room, "participation.updated", p.id, {
            principal_id: targetId,
            mode: targetMember.mode,
          });
          persist();
        }
        return { member: memberView(room, targetId) };
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
        const payload = {
          content: requireText(input.content, "content", 12000),
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
      const messageMatch = route.match(/^messages\/(msg-[a-f0-9-]+)$/);
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
            ? requireText(input.content, "content", 12000)
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
        if (method === "DELETE") message.retracted_at = stamp();
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
        if (room.tasks.length >= 500)
          throw problem(409, "limit_reached", "每个会话最多 500 项任务");
        if (input.assignee_id && !owns(room.members, input.assignee_id))
          throw problem(422, "invalid_assignee", "任务负责人必须是会话成员");
        const task = {
          id: id("task"),
          title: requireText(input.title, "title", 200),
          description: String(input.description || "").slice(0, 12000),
          assignee_id: input.assignee_id || null,
          status: "open",
          revision: 1,
          created_by: p.id,
          created_at: stamp(),
          updated_at: stamp(),
        };
        room.tasks.push(task);
        event(room, "task.created", p.id, { task: copy(task) });
        persist();
        return { task: copy(task) };
      }
      if (route.startsWith("tasks/") && method === "PATCH") {
        const task = room.tasks.find((t) => t.id === route.slice(6));
        if (!task) throw problem(404, "not_found", "任务不存在");
        if (!Number.isInteger(input.base_revision))
          throw problem(422, "version_required", "请提供 base_revision");
        if (input.base_revision !== task.revision)
          throw problem(409, "conflict", "任务版本已变化，请刷新后重试");
        if (
          input.status !== undefined &&
          !["open", "doing", "done"].includes(input.status)
        )
          throw problem(422, "invalid_status", "无效任务状态");
        if (input.assignee_id && !owns(room.members, input.assignee_id))
          throw problem(422, "invalid_assignee", "任务负责人必须是会话成员");
        if (input.title !== undefined)
          task.title = requireText(input.title, "title", 200);
        if (input.description !== undefined)
          task.description = String(input.description).slice(0, 12000);
        if (input.status !== undefined) task.status = input.status;
        if (input.assignee_id !== undefined)
          task.assignee_id = input.assignee_id || null;
        task.revision += 1;
        task.updated_at = stamp();
        event(room, "task.updated", p.id, { task: copy(task) });
        persist();
        return { task: copy(task) };
      }
      if (route === "turns/claim" && method === "POST")
        return claim(room, p, input);
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
  return { handle };
}
module.exports = { createNativeIM, PROTOCOL };
