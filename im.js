"use strict";

const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const textContent = (value) =>
  escape(value)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
const labels = {
  human: "人",
  agent: "Agent",
  active: "主动参与",
  mentions: "提及时参与",
  paused: "已暂停",
  open: "待办",
  doing: "进行中",
  replied: "已交付",
  silent: "保持观察",
  pending: "待办",
  todo: "待办",
  in_progress: "进行中",
  done: "已完成",
  completed: "已完成",
  running: "正在推进",
  claimed: "正在推进",
  succeeded: "已交付",
  failed: "需要关注",
  blocked: "需要补充",
  stale: "上下文已更新",
  cancelled: "已取消",
  stay_silent: "保持观察",
  owner: "会话负责人",
  member: "工作成员",
};
const state = {
  token: sessionStorage.getItem("equalRightsToken") || "",
  me: null,
  rooms: [],
  selected: null,
  detail: null,
  hub: "overview",
  cursor: 0,
  connected: false,
  poll: null,
  generation: 0,
  reply: null,
  mentions: [],
  drafts: {},
  unread: {},
  documents: {},
  hasMore: false,
  rendering: false,
  pendingRefresh: false,
  provisioningToken: "",
  document: null,
};
let toastTimer;
let refreshTimer;
const htmlCache = {};

function html(id, value) {
  if (htmlCache[id] !== value) {
    $(id).innerHTML = value;
    htmlCache[id] = value;
  }
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 5000);
}
function formatTime(value, full = false) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString(
    "zh-CN",
    full
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" },
  );
}
function formatDay(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "工作讨论";
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? "今天 · " +
        d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })
    : d.toLocaleDateString("zh-CN", {
        month: "long",
        day: "numeric",
        weekday: "long",
      });
}
function avatar(person, extra = "") {
  const name = person?.name || "成员";
  return `<span class="avatar ${person?.kind === "agent" ? "agent" : ""} ${extra}">${person?.kind === "agent" ? "A·" : escape([...name].slice(0, 1).join(""))}</span>`;
}
function member(id) {
  return state.detail?.members?.find((p) => (p.principal_id || p.id) === id);
}
function memberName(id) {
  return member(id)?.name || (state.me?.id === id ? state.me.name : "工作成员");
}
function messageAuthor(message) {
  return (
    message.author || {
      id: message.author_id,
      name: memberName(message.author_id),
      kind: member(message.author_id)?.kind || "human",
    }
  );
}
function statusChip(status) {
  return `<span class="status-chip ${escape(status)}">${escape(labels[status] || status || "已记录")}</span>`;
}
function storageKey(name) {
  return `equalRights:${state.me?.id || "anonymous"}:${name}`;
}
function readStorage(name, fallback) {
  try {
    return (
      JSON.parse(sessionStorage.getItem(storageKey(name)) || "null") || fallback
    );
  } catch {
    return fallback;
  }
}
function writeStorage(name, value) {
  try {
    sessionStorage.setItem(storageKey(name), JSON.stringify(value));
  } catch {
    /* A full private session must not prevent sending. */
  }
}
function errorText(error) {
  const message = error?.message || "操作未完成，请重试。";
  if (error?.status === 401) return "身份令牌已失效，请重新进入工作空间。";
  if (error?.status === 403)
    return "当前身份没有这项操作权限，或尚未加入此会话。";
  if (error?.status === 409)
    return "内容已被其他成员更新。你的草稿仍在，请读取最新版本后再合并。";
  if (error instanceof TypeError)
    return "暂时无法连接工作空间，内容已保留，请稍后重试。";
  return message;
}

async function api(path = "", method = "GET", data, options = {}) {
  const response = await fetch("/api/im" + path, {
    method,
    headers: {
      Authorization: "Bearer " + (options.token ?? state.token),
      "Content-Type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: options.signal,
  });
  if (options.raw && response.ok) return response.text();
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    const error = new Error(
      body.message ||
        (typeof body.error === "string" ? body.error : body.error?.message) ||
        "操作未完成，请稍后重试。",
    );
    error.status = response.status;
    throw error;
  }
  return body;
}
function roomPath(suffix = "", roomId = state.selected) {
  return "/rooms/" + encodeURIComponent(roomId) + suffix;
}
function setConnection(connected) {
  state.connected = connected;
  $("connection-status").textContent = connected
    ? "消息已同步"
    : "正在重新连接";
  document.body.classList.toggle("offline", !connected);
}
function closePanels() {
  $("sidebar").classList.remove("open");
  $("work-hub").classList.remove("open");
  $("mobile-shade").hidden = true;
}
function openPanel(id) {
  closePanels();
  $(id).classList.add("open");
  $("mobile-shade").hidden = false;
}
function setHub(tab, open = false) {
  state.hub = tab;
  for (const button of document.querySelectorAll("[data-hub]"))
    button.setAttribute("aria-selected", String(button.dataset.hub === tab));
  renderHub();
  if (open && window.innerWidth <= 1020) openPanel("work-hub");
}
function showDialog(id) {
  $(id).showModal();
}
function closeDialog(id) {
  $(id).close();
}

function renderRooms() {
  const query = $("room-search").value.trim().toLowerCase();
  const rooms = state.rooms.filter((r) =>
    `${r.name} ${r.description || ""}`.toLowerCase().includes(query),
  );
  $("room-count").textContent = state.rooms.length;
  html(
    "room-list",
    rooms.length
      ? rooms
          .map(
            (r) =>
              `<button class="room-nav ${r.id === state.selected ? "active" : ""}" data-room="${escape(r.id)}" ${r.id === state.selected ? 'aria-current="page"' : ""}><span class="room-nav-icon">#</span><span class="room-nav-text"><strong>${escape(r.name)}</strong><small>${escape(r.description || "共同讨论 · 共享成果")}</small></span>${state.unread[r.id] ? `<span class="unread-badge" title="本次浏览器会话的未读消息">${Math.min(99, state.unread[r.id])}</span>` : ""}</button>`,
          )
          .join("")
      : `<p class="nav-empty">${query ? "没有找到匹配会话" : "还没有工作会话<br />点击 ＋ 开始共同协作"}</p>`,
  );
}
function renderHeader() {
  const detail = state.detail;
  $("room-empty").hidden = !!detail;
  $("room-tools").hidden = !detail;
  $("message-area").hidden = !detail;
  $("composer").hidden = !detail;
  for (const button of document.querySelectorAll(".room-required"))
    button.disabled = !detail;
  if (!detail) {
    $("room-title").textContent = "工作，从同席开始";
    $("room-description").textContent =
      "建立一个会话，让讨论、文档与行动聚在一起。";
    return;
  }
  $("room-title").textContent = detail.room.name;
  $("room-description").textContent =
    `${detail.members.length} 位成员 · ${detail.room.description || "围绕共同目标，持续推进工作"}`;
  $("document-count").textContent = detail.documents.length;
  $("task-count").textContent = detail.tasks.filter(
    (t) => !["done", "completed"].includes(t.status),
  ).length;
}
function renderMessages(scroll = false) {
  if (!state.detail) return;
  const area = $("message-area");
  const nearBottom =
    area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  const query = $("message-search").value.trim().toLowerCase();
  const messages = state.detail.messages.filter((m) =>
    `${m.content} ${messageAuthor(m).name}`.toLowerCase().includes(query),
  );
  $("search-result").textContent = query
    ? `已加载消息中找到 ${messages.length} 条`
    : "";
  $("load-history").hidden = !state.hasMore;
  let day = "";
  const result = messages
    .map((m) => {
      const author = messageAuthor(m);
      const messageDay = formatDay(m.at || m.created_at);
      const divider =
        messageDay !== day
          ? `<div class="day-divider">${escape(messageDay)}</div>`
          : "";
      day = messageDay;
      const replied = state.detail.messages.find(
        (item) => item.id === m.reply_to,
      );
      return `${divider}<article class="message ${author.kind === "agent" ? "agent-message" : ""}" id="message-${escape(m.id)}">${avatar(author)}<div class="message-body"><div class="message-meta"><strong class="message-name">${escape(author.name)}</strong><span class="kind-tag ${escape(author.kind)}">${author.kind === "agent" ? "AGENT" : "成员"}</span>${author.id === state.me.id ? '<span class="message-time">你</span>' : ""}<time class="message-time" title="${escape(formatTime(m.at || m.created_at, true))}">${escape(formatTime(m.at || m.created_at))}</time></div>${m.reply_to ? `<div class="message-reply"><strong>↳ ${escape(replied ? messageAuthor(replied).name : "回复")}</strong>${escape(replied?.content?.slice(0, 130) || "更早的消息")}</div>` : ""}<div class="message-content">${textContent(m.content)}</div>${m.mentions?.length ? `<div class="message-mentions">${m.mentions.map((id) => `<span class="mention-tag">@${escape(memberName(id))}</span>`).join("")}</div>` : ""}</div><button type="button" class="reply-button" data-reply="${escape(m.id)}" aria-label="回复 ${escape(author.name)} 的消息">↩ 回复</button></article>`;
    })
    .join("");
  html(
    "messages",
    result ||
      `<div class="message-empty"><strong>${query ? "没有匹配的消息" : "从一句话，开始共同推进。"}</strong>${query ? "可加载更早消息继续查找。" : "分享项目背景，添加工作伙伴，或创建第一份共同文档。"}</div>`,
  );
  const running = state.detail.runs.filter((r) =>
    ["running", "claimed"].includes(r.status),
  );
  $("agent-activity").hidden = !running.length;
  $("agent-activity").innerHTML = running.length
    ? `<span></span>${escape(running.map((r) => memberName(r.principal_id)).join("、"))} 正在推进工作 · 依据与成果将记录在工作面板`
    : "";
  if ((scroll || nearBottom) && !query) area.scrollTop = area.scrollHeight;
}
function documentCards(documents) {
  return documents.length
    ? documents
        .map(
          (d) =>
            `<button class="document-card" data-document="${escape(d.id)}"><span class="document-icon">▱</span><span class="document-info"><strong>${escape(d.title)}</strong><small>共同文档 · r${escape(d.revision)}${d.updated_at ? " · " + escape(formatTime(d.updated_at, true)) : ""}</small></span><span>↗</span></button>`,
        )
        .join("")
    : '<p class="hub-note">把背景、方案和工作成果放进共同文档，让每位成员都有完整依据。</p>';
}
function assigneeOptions(current = "") {
  return `<option value="">待分配</option>${(state.detail?.members || []).map((p) => `<option value="${escape(p.principal_id || p.id)}" ${(p.principal_id || p.id) === current ? "selected" : ""}>${escape(p.name)}${p.kind === "agent" ? " · Agent" : ""}</option>`).join("")}`;
}
function taskCards(tasks) {
  return tasks.length
    ? tasks
        .map((t) => {
          const done = ["done", "completed"].includes(t.status);
          return `<div class="task-card ${done ? "completed" : ""}"><div class="task-top"><button class="task-check ${done ? "done" : ""}" data-task-toggle="${escape(t.id)}" aria-label="${done ? "重新打开" : "完成"}任务：${escape(t.title)}">${done ? "✓" : ""}</button><strong class="task-title">${escape(t.title)}</strong></div>${t.description ? `<p class="task-description">${escape(t.description)}</p>` : ""}<div class="task-bottom"><select data-task-assignee="${escape(t.id)}" aria-label="任务负责人">${assigneeOptions(t.assignee_id)}</select><select class="task-status" data-task-status="${escape(t.id)}" aria-label="任务状态">${["open", "doing", "done"].map((s) => `<option value="${s}" ${t.status === s || (s === "open" && t.status === "pending") || (s === "done" && t.status === "completed") ? "selected" : ""}>${labels[s]}</option>`).join("")}</select></div></div>`;
        })
        .join("")
    : '<p class="hub-note">讨论形成行动时，明确负责人和验收条件。人和 Agent 都可以认领与完成任务。</p>';
}
function memberCards(members) {
  const ownMember = member(state.me?.id);
  return members
    .map((p) => {
      const id = p.principal_id || p.id;
      const canSetMode =
        p.kind === "agent" &&
        (id === state.me.id || ownMember?.role === "owner");
      return `<div class="member-row">${avatar(p)}<div class="member-info"><strong>${escape(p.name)}${id === state.me.id ? " <small>你</small>" : ""}</strong><small>${p.kind === "agent" ? "Agent" : "人"} · ${escape(labels[p.role] || "工作成员")}</small></div>${canSetMode ? `<select data-participation="${escape(id)}" aria-label="${escape(p.name)}的参与方式">${["active", "mentions", "paused"].map((mode) => `<option value="${mode}" ${p.mode === mode ? "selected" : ""}>${labels[mode]}</option>`).join("")}</select>` : p.kind === "agent" ? `<span class="member-mode ${escape(p.mode)}">${escape(labels[p.mode] || "提及时参与")}</span>` : ""}</div>`;
    })
    .join("");
}
function artifact(run) {
  return run.result?.artifact || run.artifact;
}
function runCards(runs) {
  return runs.length
    ? [...runs]
        .reverse()
        .map((r) => {
          const output = artifact(r);
          const rationale =
            r.result?.rationale ||
            r.result?.reason ||
            r.reason ||
            r.error ||
            "";
          return `<div class="run-card"><div class="run-card-heading"><strong>◌ ${escape(memberName(r.principal_id))}</strong>${statusChip(r.status)}</div>${rationale ? `<p>${escape(String(rationale).slice(0, 220))}</p>` : ""}${output ? `<div class="artifact-card"><strong>▱ ${escape(output.title || "工作成果")}</strong><p>${escape(output.content?.slice(0, 150) || "")}</p><button data-save-artifact="${escape(r.id)}">＋ 保存为共享文档</button></div>` : ""}<div class="run-card-bottom"><time>${escape(formatTime(r.finished_at || r.completed_at || r.updated_at || r.created_at, true))}</time><button data-run="${escape(r.id)}">查看依据与记录 ↗</button></div></div>`;
        })
        .join("")
    : '<p class="hub-note">Agent 参与工作后，使用的上下文、判断依据和交付结果会出现在这里。</p>';
}
function hubSection(title, count, action, content) {
  return `<section class="hub-section"><div class="section-heading"><h3>${title}${count === undefined ? "" : `<span>${count}</span>`}</h3>${action || ""}</div>${content}</section>`;
}
function renderHub() {
  const d = state.detail;
  if (!d) {
    html(
      "hub-content",
      '<div class="hub-empty">选一个会话，<br />一起把事情向前推进。</div>',
    );
    return;
  }
  const documents = [...d.documents].reverse();
  const tasks = [...d.tasks].sort(
    (a, b) =>
      Number(["done", "completed"].includes(a.status)) -
      Number(["done", "completed"].includes(b.status)),
  );
  const done = tasks.filter((t) =>
    ["done", "completed"].includes(t.status),
  ).length;
  let content = "";
  if (state.hub === "overview") {
    content = `<div class="brief-card"><p class="eyebrow">OUR SHARED INTENTION</p><p>${escape(d.room.description || "在这里，讨论形成共识，文档沉淀依据，任务推动交付。")}</p>${tasks.length ? `<div class="progress-line"><span>行动进度</span><div class="progress-track"><i id="task-progress"></i></div><span>${done} / ${tasks.length}</span></div>` : ""}</div>`;
    content += hubSection(
      "下一步行动",
      tasks.length,
      '<button data-action="new-task">＋ 新建</button>',
      taskCards(tasks.slice(0, 3)),
    );
    content += hubSection(
      "共同文档",
      documents.length,
      '<button data-action="new-document">＋ 新建</button>',
      documentCards(documents.slice(0, 3)),
    );
    content += hubSection(
      "Agent 工作记录",
      d.runs.length,
      "",
      runCards(d.runs.slice(-4)),
    );
  } else if (state.hub === "documents") {
    content = hubSection(
      "共同文档",
      documents.length,
      '<button data-action="new-document">＋ 新建文档</button>',
      documentCards(documents),
    );
    const outputs = d.runs.filter((r) => artifact(r));
    if (outputs.length)
      content += hubSection(
        "待沉淀的工作成果",
        outputs.length,
        "",
        runCards(outputs),
      );
  } else if (state.hub === "tasks") {
    content = hubSection(
      "工作任务",
      tasks.length,
      '<button data-action="new-task">＋ 新建任务</button>',
      taskCards(tasks),
    );
    content += hubSection("协作过程", d.runs.length, "", runCards(d.runs));
  } else {
    content = hubSection(
      "共同参与",
      d.members.length,
      '<button data-action="invite">＋ 添加成员</button>',
      memberCards(d.members),
    );
    content +=
      '<p class="hub-note">主动参与：关注会话的新进展。<br />提及时参与：收到 @ 后推进工作。<br />已暂停：保留身份与历史，暂不自动回应。</p>';
  }
  html("hub-content", content);
  const progress = $("task-progress");
  if (progress)
    progress.style.width =
      Math.round((done / Math.max(1, tasks.length)) * 100) + "%";
}
function render() {
  renderRooms();
  renderHeader();
  renderMessages();
  renderHub();
}
function saveDraft() {
  if (!state.selected) return;
  const prior = state.drafts[state.selected] || {};
  state.drafts[state.selected] = {
    ...prior,
    content: $("message-input").value,
    reply: state.reply,
    mentions: [...state.mentions],
  };
  writeStorage("drafts", state.drafts);
}
function renderComposerContext() {
  $("reply-context").hidden = !state.reply;
  $("reply-context").innerHTML = state.reply
    ? `<span>回复 ${escape(state.reply.author)}：${escape(state.reply.content)}</span><button type="button" id="cancel-reply" class="icon-button" aria-label="取消回复">×</button>`
    : "";
  $("mention-selection").innerHTML = state.mentions
    .map(
      (id) =>
        `<button type="button" data-remove-mention="${escape(id)}">@${escape(memberName(id))} ×</button>`,
    )
    .join("");
}
function restoreDraft() {
  const draft = state.drafts[state.selected] || {};
  $("message-input").value = draft.content || "";
  state.reply = draft.reply || null;
  state.mentions = draft.mentions || [];
  $("send-error").textContent = "";
  renderComposerContext();
  resizeComposer();
}
function resizeComposer() {
  const input = $("message-input");
  input.style.height = "auto";
  input.style.height = Math.min(180, input.scrollHeight) + "px";
}

async function selectRoom(id) {
  if (state.selected === id && state.detail) {
    closePanels();
    return;
  }
  saveDraft();
  state.selected = id;
  state.detail = null;
  $("message-search").value = "";
  state.hasMore = false;
  history.replaceState(null, "", "#" + encodeURIComponent(id));
  renderRooms();
  closePanels();
  try {
    const detail = await api(roomPath("", id));
    if (state.selected !== id) return;
    state.detail = normalizeDetail(detail);
    state.hasMore = detail.has_more_messages ?? detail.messages?.length >= 200;
    state.unread[id] = 0;
    writeStorage("unread", state.unread);
    restoreDraft();
    render();
    renderMessages(true);
  } catch (error) {
    if (state.selected === id) {
      state.selected = null;
      state.detail = null;
      render();
    }
    toast(errorText(error));
  }
}
function normalizeDetail(detail) {
  return {
    ...detail,
    messages: detail.messages || [],
    documents: detail.documents || [],
    members: detail.members || [],
    tasks: detail.tasks || [],
    runs: detail.runs || [],
  };
}
async function refreshRooms() {
  const generation = state.generation;
  const data = await api("/rooms");
  if (generation !== state.generation) return data;
  state.rooms = data.rooms || [];
  renderRooms();
  return data;
}
async function refreshCurrent() {
  if (!state.selected) return;
  if (state.rendering) {
    state.pendingRefresh = true;
    return;
  }
  state.rendering = true;
  const id = state.selected;
  const generation = state.generation;
  try {
    const data = normalizeDetail(await api(roomPath("", id)));
    if (state.selected !== id || generation !== state.generation) return;
    const oldMessages = state.detail?.messages || [];
    const last = data.messages[0]?.seq || 0;
    const older = oldMessages.filter((m) => m.seq < last);
    data.messages = [...older, ...data.messages];
    state.detail = data;
    if (!document.hidden) {
      state.unread[id] = 0;
      writeStorage("unread", state.unread);
    }
    render();
  } finally {
    state.rendering = false;
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      scheduleRefresh();
    }
  }
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshRooms();
      await refreshCurrent();
    } catch (error) {
      if (error.status === 403) {
        state.detail = null;
        state.selected = null;
        render();
        toast("你已不在此会话中。");
      } else setConnection(false);
    }
  }, 120);
}
function delay(ms, signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
async function pollEvents(generation) {
  const controller = new AbortController();
  state.poll = controller;
  let retry = 1000;
  while (
    state.token &&
    generation === state.generation &&
    !controller.signal.aborted
  ) {
    try {
      const data = await api(
        `/events?after=${state.cursor}&wait=20`,
        "GET",
        undefined,
        { signal: controller.signal },
      );
      if (generation !== state.generation) break;
      setConnection(true);
      retry = 1000;
      state.cursor = data.cursor ?? state.cursor;
      if (data.reset_required || data.events?.length) {
        for (const event of data.events || []) {
          if (
            event.type.includes("message") &&
            (event.type.includes("created") || event.type === "message") &&
            event.actor_id !== state.me.id &&
            (event.room_id !== state.selected || document.hidden)
          )
            state.unread[event.room_id] =
              (state.unread[event.room_id] || 0) + 1;
        }
        writeStorage("unread", state.unread);
        scheduleRefresh();
      }
      if (!data.events?.length) await delay(250, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || generation !== state.generation) break;
      setConnection(false);
      if (error.status === 401) {
        signOut();
        $("connect-error").textContent = "身份令牌已失效，请重新进入。";
        break;
      }
      await delay(retry, controller.signal);
      retry = Math.min(retry * 2, 15000);
    }
  }
}
async function connect(token) {
  const data = await api("/me", "GET", undefined, { token });
  state.poll?.abort();
  state.generation += 1;
  state.token = token;
  state.me = data.principal;
  sessionStorage.setItem("equalRightsToken", token);
  state.drafts = readStorage("drafts", {});
  state.unread = readStorage("unread", {});
  $("identity-token").value = "";
  $("self-avatar").textContent =
    state.me.kind === "agent" ? "A·" : [...state.me.name].slice(0, 1).join("");
  $("self-avatar").title = `${state.me.name} · ${labels[state.me.kind]}`;
  $("self-name").textContent = `${state.me.name} · ${labels[state.me.kind]}`;
  const rooms = await refreshRooms();
  state.cursor = rooms.cursor || 0;
  $("connection").hidden = true;
  $("workspace").hidden = false;
  setConnection(true);
  const hashId = decodeURIComponent(location.hash.slice(1));
  const selected =
    state.rooms.find((r) => r.id === hashId)?.id || state.rooms[0]?.id;
  state.selected = null;
  state.detail = null;
  if (selected) await selectRoom(selected);
  else render();
  void pollEvents(state.generation);
}
function signOut() {
  saveDraft();
  state.poll?.abort();
  state.generation += 1;
  state.token = "";
  state.me = null;
  state.detail = null;
  state.selected = null;
  state.rooms = [];
  state.reply = null;
  state.mentions = [];
  sessionStorage.removeItem("equalRightsToken");
  $("workspace").hidden = true;
  $("connection").hidden = false;
  $("identity-token").value = "";
  $("message-input").value = "";
  closePanels();
  for (const dialog of document.querySelectorAll("dialog[open]"))
    dialog.close();
}
async function submitForm(form, errorId, action) {
  const button = form.querySelector('[type="submit"]');
  if (button?.disabled) return;
  if (button) button.disabled = true;
  $(errorId).textContent = "";
  try {
    await action();
  } catch (error) {
    $(errorId).textContent = errorText(error);
  } finally {
    if (button) button.disabled = false;
  }
}

function newRoom() {
  $("room-form").reset();
  $("room-error").textContent = "";
  showDialog("room-dialog");
}
async function inviteMember() {
  if (!state.detail) return;
  $("invite-error").textContent = "";
  try {
    const data = await api("/principals");
    const currentIds = new Set(
      state.detail.members.map((p) => p.principal_id || p.id),
    );
    const available = data.principals.filter((p) => !currentIds.has(p.id));
    $("invite-principal").innerHTML = available.length
      ? available
          .map(
            (p) =>
              `<option value="${escape(p.id)}">${escape(p.name)} · ${p.kind === "agent" ? "Agent" : "人"}</option>`,
          )
          .join("")
      : '<option value="">所有现有成员均已加入此会话</option>';
    $("invite-form").querySelector('[type="submit"]').disabled =
      !available.length;
    showDialog("invite-dialog");
  } catch (error) {
    toast(errorText(error));
  }
}
function newTask() {
  if (!state.detail) return;
  $("task-form").reset();
  $("task-assignee").innerHTML = assigneeOptions();
  $("task-error").textContent = "";
  showDialog("task-dialog");
}
function openDocument(id, initial) {
  if (!state.detail) return;
  const doc = id ? state.detail.documents.find((d) => d.id === id) : initial;
  if (id && !doc) {
    toast("这份文档已不在当前会话中，请刷新后重试。");
    return;
  }
  const drafts = readStorage("documentDrafts", {});
  const key = id || `new:${state.selected}`;
  const draft = !initial ? drafts[key] : null;
  state.document = {
    id,
    roomId: state.selected,
    revision: draft?.revision ?? doc?.revision,
    originalTitle: doc?.title || "",
    originalContent: doc?.content || "",
    key,
  };
  $("document-title").value = draft?.title ?? doc?.title ?? "";
  $("document-content").value = draft?.content ?? doc?.content ?? "";
  $("document-revision").textContent = state.document.revision
    ? `共同版本 r${state.document.revision}${draft ? " · 已恢复草稿" : ""}`
    : "新建共同文档";
  $("document-error").textContent =
    draft && doc?.revision !== draft.revision
      ? "共同文档已有更新。已保留你的草稿，请读取最新版本后合并。"
      : "";
  $("document-reload").hidden = !(draft && doc?.revision !== draft.revision);
  showDialog("document-dialog");
}
function saveDocumentDraft() {
  if (!state.document) return;
  const drafts = readStorage("documentDrafts", {});
  drafts[state.document.key] = {
    title: $("document-title").value,
    content: $("document-content").value,
    revision: state.document.revision,
  };
  writeStorage("documentDrafts", drafts);
}
function clearDocumentDraft() {
  if (!state.document) return;
  const drafts = readStorage("documentDrafts", {});
  delete drafts[state.document.key];
  writeStorage("documentDrafts", drafts);
}
function download(name, content, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, "-");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function patchTask(id, values) {
  const task = state.detail?.tasks.find((t) => t.id === id);
  if (!task) return;
  try {
    await api(roomPath("/tasks/" + encodeURIComponent(id)), "PATCH", {
      ...values,
      base_revision: task.revision,
    });
    await refreshCurrent();
  } catch (error) {
    toast(errorText(error));
    delete htmlCache["hub-content"];
    await refreshCurrent().catch(() => {});
  }
}
function renderRunDetail(run) {
  const context = run.context || {};
  const documents = context.documents || [];
  const messages = context.messages || [];
  const tasks = context.tasks || [];
  const output = artifact(run);
  const model =
    run.model ||
    run.result?.model ||
    context.model ||
    run.context_summary?.model;
  let content = `<h2>${escape(memberName(run.principal_id))} 的工作记录</h2><div class="run-meta">${statusChip(run.status)} · ${escape(formatTime(run.created_at, true))}${model ? `<br />使用模型：${escape(typeof model === "string" ? model : JSON.stringify(model))}` : ""}<br />${escape(run.id)}</div>`;
  if (output)
    content += `<section class="run-section"><h3>交付成果 · ${escape(output.title)}</h3><pre>${escape(output.content)}</pre><button class="primary" data-save-artifact="${escape(run.id)}">保存为共享文档 ↗</button></section>`;
  const rationale =
    run.result?.rationale || run.result?.reason || run.reason || run.error;
  if (rationale)
    content += `<section class="run-section"><h3>判断与说明</h3><pre>${escape(typeof rationale === "string" ? rationale : JSON.stringify(rationale, null, 2))}</pre></section>`;
  if (run.result?.content || run.result?.message)
    content += `<section class="run-section"><h3>返回会话的内容</h3><pre>${escape(run.result.content || run.result.message)}</pre></section>`;
  content += `<section class="run-section"><h3>本次工作的共同上下文</h3><p class="dialog-intro">下面保留本次开始工作时的内容。后续修改会形成新的版本。</p>`;
  if (context.room)
    content += `<div class="evidence-label">会话目标</div><pre>${escape(typeof context.room === "string" ? context.room : context.room.description || context.room.name || JSON.stringify(context.room, null, 2))}</pre>`;
  if (documents.length)
    content += documents
      .map(
        (d) =>
          `<div class="evidence-label"><strong>▱ ${escape(d.title || d.id)}</strong><span>r${escape(d.revision)}</span><code>${escape(d.content_hash || d.hash || "")}</code></div><pre>${escape(d.content ?? JSON.stringify(d, null, 2))}</pre>`,
      )
      .join("");
  if (messages.length)
    content += `<div class="evidence-label">已读取的讨论 · ${messages.length} 条</div><div class="evidence-content">${messages.map((m) => `<div class="run-context-message"><strong>${escape(m.author?.name || memberName(m.author_id))} · ${escape(formatTime(m.at || m.created_at, true))}</strong><p>${escape(m.content)}</p></div>`).join("")}</div>`;
  if (tasks.length)
    content += `<div class="evidence-label">任务上下文 · ${tasks.length} 项</div><pre>${escape(tasks.map((t) => `${t.title}\n${t.description || ""}\n负责人：${memberName(t.assignee_id)} · ${labels[t.status] || t.status}`).join("\n\n"))}</pre>`;
  if (!run.context)
    content += '<p class="hub-note">正在读取本次工作的完整依据…</p>';
  if (
    context.omissions &&
    (context.omissions.messages ||
      context.omissions.tasks ||
      context.omissions.documents?.length)
  )
    content += `<p class="dialog-intro">本次读取了可处理范围内的上下文：未纳入 ${escape(context.omissions.messages || 0)} 条更早讨论、${escape(context.omissions.documents?.length || 0)} 份文档、${escape(context.omissions.tasks || 0)} 项任务。具体范围保留在下方完整记录中。</p>`;
  if (run.context)
    content += `<details class="context-details"><summary>查看完整依据快照</summary><pre>${escape(JSON.stringify(context, null, 2))}</pre></details>`;
  content += "</section>";
  $("run-detail").innerHTML = content;
}
async function openRun(id) {
  const run = state.detail?.runs.find((r) => r.id === id);
  if (!run) return;
  renderRunDetail(run);
  showDialog("run-dialog");
  try {
    const data = await api(roomPath("/turns/" + encodeURIComponent(id)));
    if ($("run-dialog").open) renderRunDetail(data.turn || data.run || run);
  } catch (error) {
    toast(errorText(error));
  }
}
async function saveArtifact(id, button) {
  if (button.disabled) return;
  button.disabled = true;
  const roomId = state.selected;
  try {
    const full = await api(
      roomPath("/turns/" + encodeURIComponent(id), roomId),
    );
    const output = artifact(full.turn || full.run || {});
    if (!output?.content) throw new Error("这次工作记录没有可保存的交付成果。");
    const data = await api(roomPath("/documents", roomId), "POST", {
      title: output.title || "Agent 工作成果",
      content: output.content,
    });
    if (state.selected === roomId) {
      await refreshCurrent();
      if ($("run-dialog").open) closeDialog("run-dialog");
      openDocument(data.document.id);
    }
    toast("工作成果已成为共同文档，所有会话成员都能继续编辑。");
  } catch (error) {
    toast(errorText(error));
  } finally {
    button.disabled = false;
  }
}

$("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitForm(event.currentTarget, "connect-error", () =>
    connect($("identity-token").value.trim()),
  );
});
$("sign-out").addEventListener("click", signOut);
$("self-avatar").addEventListener("click", () => {
  if (state.me)
    toast(
      `${state.me.name} · ${state.me.kind === "agent" ? "Agent 工作成员" : "独立工作身份"}`,
    );
});
$("new-room").addEventListener("click", newRoom);
$("empty-new-room").addEventListener("click", newRoom);
$("room-search").addEventListener("input", renderRooms);
$("message-search").addEventListener("input", () => renderMessages());
$("room-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-room]");
  if (button) void selectRoom(button.dataset.room);
});
$("room-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitForm(event.currentTarget, "room-error", async () => {
    const data = await api("/rooms", "POST", {
      name: $("new-room-name").value.trim(),
      description: $("new-room-description").value.trim(),
    });
    await refreshRooms();
    closeDialog("room-dialog");
    await selectRoom(data.room.id);
    toast("工作会话已创建，添加成员开始共同推进。");
  });
});
$("invite-member").addEventListener("click", () => void inviteMember());
$("invite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitForm(event.currentTarget, "invite-error", async () => {
    await api(roomPath("/members"), "POST", {
      principal_id: $("invite-principal").value,
    });
    await refreshCurrent();
    closeDialog("invite-dialog");
    setHub("members", true);
    toast("成员已加入工作会话。");
  });
});
$("export-room").addEventListener("click", async () => {
  if (!state.detail) return;
  try {
    const name = state.detail.room.name;
    const markdown = await api(roomPath("/export"), "GET", undefined, {
      raw: true,
    });
    download(name + "-工作记录.md", markdown);
    toast("会话与工作记录已导出。");
  } catch (error) {
    toast(errorText(error));
  }
});
$("load-history").addEventListener("click", async () => {
  if (!state.detail?.messages.length) return;
  const roomId = state.selected;
  const button = $("load-history");
  button.disabled = true;
  try {
    const data = await api(
      roomPath(`/messages?before=${state.detail.messages[0].seq}&limit=100`),
    );
    if (roomId !== state.selected) return;
    const area = $("message-area");
    const height = area.scrollHeight;
    const ids = new Set(state.detail.messages.map((m) => m.id));
    state.detail.messages = [
      ...data.messages.filter((m) => !ids.has(m.id)),
      ...state.detail.messages,
    ];
    state.hasMore = !!data.has_more;
    renderMessages();
    area.scrollTop += area.scrollHeight - height;
  } catch (error) {
    toast(errorText(error));
  } finally {
    button.disabled = false;
  }
});
$("messages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reply]");
  if (!button) return;
  const m = state.detail.messages.find(
    (item) => item.id === button.dataset.reply,
  );
  state.reply = {
    id: m.id,
    author: messageAuthor(m).name,
    content: m.content.slice(0, 160),
  };
  renderComposerContext();
  saveDraft();
  $("message-input").focus();
});
$("reply-context").addEventListener("click", (event) => {
  if (!event.target.closest("#cancel-reply")) return;
  state.reply = null;
  saveDraft();
  renderComposerContext();
});
$("mention-button").addEventListener("click", () => {
  $("mention-menu").hidden = !$("mention-menu").hidden;
  $("mention-menu").innerHTML =
    (state.detail?.members || [])
      .filter((p) => (p.principal_id || p.id) !== state.me.id)
      .map(
        (p) =>
          `<button type="button" class="mention-option" data-mention="${escape(p.principal_id || p.id)}">${avatar(p)}${escape(p.name)}<small>${p.kind === "agent" ? "AGENT" : "成员"}</small></button>`,
      )
      .join("") || '<p class="hub-note">先添加一位工作伙伴。</p>';
});
$("mention-menu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-mention]");
  if (!button) return;
  if (!state.mentions.includes(button.dataset.mention))
    state.mentions.push(button.dataset.mention);
  $("mention-menu").hidden = true;
  renderComposerContext();
  saveDraft();
  $("message-input").focus();
});
$("mention-selection").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-mention]");
  if (!button) return;
  state.mentions = state.mentions.filter(
    (id) => id !== button.dataset.removeMention,
  );
  saveDraft();
  renderComposerContext();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#mention-menu, #mention-button"))
    $("mention-menu").hidden = true;
});
$("message-input").addEventListener("input", () => {
  saveDraft();
  resizeComposer();
});
$("message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const content = $("message-input").value.trim();
  if (!content || !state.selected) return;
  const roomId = state.selected;
  const mentions = [...state.mentions];
  const reply = state.reply?.id;
  const draft = state.drafts[roomId] || {};
  const signature = JSON.stringify({ content, mentions, reply });
  const clientId =
    draft.signature === signature && draft.clientId
      ? draft.clientId
      : crypto.randomUUID();
  state.drafts[roomId] = {
    ...draft,
    content: $("message-input").value,
    mentions,
    reply: state.reply,
    signature,
    clientId,
  };
  writeStorage("drafts", state.drafts);
  void submitForm(event.currentTarget, "send-error", async () => {
    const sent = await api(roomPath("/messages", roomId), "POST", {
      client_id: clientId,
      content,
      mentions,
      ...(reply ? { reply_to: reply } : {}),
    });
    const current = state.drafts[roomId];
    if (
      current?.clientId === clientId &&
      JSON.stringify({
        content: current.content.trim(),
        mentions: current.mentions,
        reply: current.reply?.id,
      }) === signature
    ) {
      delete state.drafts[roomId];
      writeStorage("drafts", state.drafts);
      if (
        state.selected === roomId &&
        $("message-input").value.trim() === content
      ) {
        $("message-input").value = "";
        state.reply = null;
        state.mentions = [];
        renderComposerContext();
        resizeComposer();
      }
    }
    if (state.selected === roomId) {
      if (
        sent.message &&
        !state.detail.messages.some((m) => m.id === sent.message.id)
      ) {
        state.detail.messages.push(sent.message);
      }
      await refreshCurrent().catch(() => setConnection(false));
      renderMessages(true);
      $("message-input").focus();
    }
  });
});
$("composer-task").addEventListener("click", newTask);
$("composer-document").addEventListener("click", () => openDocument());
$("task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitForm(event.currentTarget, "task-error", async () => {
    await api(roomPath("/tasks"), "POST", {
      title: $("task-title").value.trim(),
      description: $("task-description").value.trim(),
      assignee_id: $("task-assignee").value || null,
    });
    await refreshCurrent();
    closeDialog("task-dialog");
    setHub("tasks", true);
    toast("下一步已记录，可以开始推进。");
  });
});
$("document-title").addEventListener("input", saveDocumentDraft);
$("document-content").addEventListener("input", saveDocumentDraft);
$("document-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitForm(event.currentTarget, "document-error", async () => {
    const doc = state.document;
    const input = {
      title: $("document-title").value.trim(),
      content: $("document-content").value,
      ...(doc.id ? { base_revision: doc.revision } : {}),
    };
    try {
      const result = await api(
        roomPath(
          "/documents" + (doc.id ? "/" + encodeURIComponent(doc.id) : ""),
          doc.roomId,
        ),
        doc.id ? "PUT" : "POST",
        input,
      );
      clearDocumentDraft();
      state.document = {
        ...doc,
        id: result.document.id,
        revision: result.document.revision,
        key: result.document.id,
        originalTitle: result.document.title,
        originalContent: result.document.content,
      };
      $("document-revision").textContent =
        `共同版本 r${result.document.revision} · 已保存`;
      $("document-reload").hidden = true;
      await refreshCurrent().catch(() => setConnection(false));
      toast("共同文档已保存，人和 Agent 都能读取最新版本。");
    } catch (error) {
      saveDocumentDraft();
      if (error.status === 409) $("document-reload").hidden = false;
      throw error;
    }
  });
});
$("document-reload").addEventListener("click", async () => {
  const doc = state.document;
  if (!doc?.id) return;
  try {
    const data = await api(roomPath("", doc.roomId));
    const latest = data.documents.find((d) => d.id === doc.id);
    if (!latest) throw new Error("文档已不存在。");
    const currentDraft = $("document-content").value;
    const currentTitle = $("document-title").value;
    state.document.revision = latest.revision;
    $("document-content").value =
      `<!-- 你的未合并草稿：请编辑并移除分隔说明后保存 -->\n${currentDraft}\n\n<!-- 共同文档最新版本 r${latest.revision} -->\n${latest.content}`;
    $("document-title").value = currentTitle;
    $("document-revision").textContent = `合并至共同版本 r${latest.revision}`;
    $("document-error").textContent =
      "你的草稿与最新版本已一起保留在编辑器中。请合并内容、移除分隔说明后保存。";
    $("document-reload").hidden = true;
    saveDocumentDraft();
  } catch (error) {
    $("document-error").textContent = errorText(error);
  }
});
$("document-download").addEventListener("click", () =>
  download(
    ($("document-title").value || "共同文档") + ".md",
    $("document-content").value,
  ),
);
$("hub-content").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "new-task") newTask();
  else if (button.dataset.action === "new-document") openDocument();
  else if (button.dataset.action === "invite") void inviteMember();
  else if (button.dataset.document) openDocument(button.dataset.document);
  else if (button.dataset.run) void openRun(button.dataset.run);
  else if (button.dataset.saveArtifact)
    void saveArtifact(button.dataset.saveArtifact, button);
  else if (button.dataset.taskToggle) {
    const task = state.detail.tasks.find(
      (t) => t.id === button.dataset.taskToggle,
    );
    void patchTask(task.id, {
      status: ["done", "completed"].includes(task.status) ? "open" : "done",
    });
  }
});
$("hub-content").addEventListener("change", async (event) => {
  const select = event.target.closest("select");
  if (!select) return;
  if (select.dataset.taskAssignee)
    void patchTask(select.dataset.taskAssignee, {
      assignee_id: select.value || null,
    });
  else if (select.dataset.taskStatus)
    void patchTask(select.dataset.taskStatus, { status: select.value });
  else if (select.dataset.participation) {
    select.disabled = true;
    try {
      await api(roomPath("/participation"), "PATCH", {
        principal_id: select.dataset.participation,
        mode: select.value,
      });
      await refreshCurrent();
      toast("参与方式已更新。");
    } catch (error) {
      toast(errorText(error));
      await refreshCurrent().catch(() => {});
    } finally {
      select.disabled = false;
    }
  }
});
$("run-detail").addEventListener("click", (event) => {
  const button = event.target.closest("[data-save-artifact]");
  if (button) void saveArtifact(button.dataset.saveArtifact, button);
});
for (const button of document.querySelectorAll("[data-hub]"))
  button.addEventListener("click", () => setHub(button.dataset.hub));
for (const id of ["rail-documents", "jump-documents"])
  $(id).addEventListener("click", () => setHub("documents", true));
for (const id of ["rail-tasks", "jump-tasks"])
  $(id).addEventListener("click", () => setHub("tasks", true));
$("open-navigation").addEventListener("click", () => openPanel("sidebar"));
$("close-navigation").addEventListener("click", closePanels);
$("open-hub").addEventListener("click", () => openPanel("work-hub"));
$("close-hub").addEventListener("click", closePanels);
$("mobile-shade").addEventListener("click", closePanels);
for (const button of document.querySelectorAll("[data-close]"))
  button.addEventListener("click", () => closeDialog(button.dataset.close));
$("open-provision").addEventListener("click", () => {
  $("provision-form").reset();
  $("provision-form").hidden = false;
  $("provision-result").hidden = true;
  $("provision-error").textContent = "";
  showDialog("provision-dialog");
});
$("provision-dialog").addEventListener("close", () => {
  state.provisioningToken = "";
  $("provision-token").value = "";
  $("provision-admin").value = "";
});
$("provision-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitForm(event.currentTarget, "provision-error", async () => {
    const token = $("provision-admin").value.trim();
    $("provision-admin").value = "";
    const data = await api(
      "/admin/principals",
      "POST",
      {
        name: $("provision-name").value.trim(),
        kind: $("provision-kind").value,
      },
      { token },
    );
    state.provisioningToken = data.token;
    $("provision-token").value = data.token;
    $("provision-form").hidden = true;
    $("provision-result").hidden = false;
  });
});
$("copy-provision-token").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.provisioningToken);
    toast("个人令牌已复制，请私下保存。");
  } catch {
    $("provision-token").select();
    toast("无法自动复制，请在令牌框中手动复制。");
  }
});
$("use-provision-token").addEventListener("click", async () => {
  const token = state.provisioningToken;
  try {
    await connect(token);
    closeDialog("provision-dialog");
  } catch (error) {
    toast(errorText(error));
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.token) scheduleRefresh();
});
window.addEventListener("online", () => {
  if (state.token) scheduleRefresh();
});
window.addEventListener("hashchange", () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (state.rooms.some((r) => r.id === id)) void selectRoom(id);
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 1020) closePanels();
});
if (state.token)
  void connect(state.token).catch((error) => {
    $("connect-error").textContent = errorText(error);
    $("connection").hidden = false;
    $("workspace").hidden = true;
    if (error.status === 401) {
      sessionStorage.removeItem("equalRightsToken");
      state.token = "";
    }
  });
