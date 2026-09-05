"use strict";
const $ = (id) => document.getElementById(id);
const state = {
  token: sessionStorage.activeDocToken || "",
  name: sessionStorage.activeDocName || "",
  docs: [],
  selected: null,
  raw: false,
  refreshing: false,
  sourceId: null,
  signature: "",
};
const labels = {
  pending: "等待审阅",
  accepted: "已接受",
  rejected: "已拒绝",
  conflicted: "正文已变化",
  stay_silent: "保持观察",
  blocked: "需要补充",
  active: "持续关注中",
  paused: "已暂停",
  completed: "已完成",
};
const escape = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const time = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
let toastTimer, changeTimer;
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
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5500);
}
async function api(path = "", method = "GET", input) {
  const res = await fetch("/api/workspace" + path, {
    method,
    headers: {
      Authorization: "Bearer " + state.token,
      "Content-Type": "application/json",
      "X-Actor-Id": encodeURIComponent(state.name),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "连接失败");
  return body;
}
function current() {
  return state.docs.find((d) => d.id === state.selected);
}
function select(id) {
  if (state.selected !== id) {
    state.raw = false;
    state.signature = "";
    window.activeWorkspaceEditor?.close();
  }
  state.selected = id;
  history.replaceState(null, "", "#" + id);
  render();
}
function nav(documents) {
  return documents
    .map(
      (d) =>
        `<button class="doc-nav ${d.id === state.selected ? "active" : ""}" data-select="${escape(d.id)}"><span class="nav-icon">${d.contract ? "◌" : "▤"}</span><span>${escape(d.title)}</span></button>`,
    )
    .join("");
}
function render() {
  const sources = state.docs.filter((d) => !d.contract),
    records = state.docs.filter((d) => d.contract);
  html("document-list", nav(sources));
  html("record-list", nav(records));
  $("doc-count").textContent = sources.length;
  $("record-count").textContent = records.length;
  const d = current();
  if (!d) return;
  const c = d.contract;
  state.sourceId = c?.source_document_id || d.id;
  $("breadcrumb-title").textContent = d.title;
  $("revision").textContent = "r" + d.revision;
  $("document-kind").textContent =
    c?.kind === "mission"
      ? "◌ 任务约定"
      : c?.kind === "proposal"
        ? "✧ 修改提案"
        : c
          ? "◌ 运行记录"
          : "◈ 共同文档";
  $("document-date").textContent = time(d.updated_at);
  $("char-count").textContent = d.content.length.toLocaleString() + " 字符";
  $("document-author").textContent = c?.actor_id || c?.created_by || "共同编辑";
  if (document.activeElement !== $("document-title"))
    $("document-title").value = d.title;
  $("document-title").readOnly = Boolean(c) || state.raw;
  $("editor").hidden = Boolean(c) || state.raw;
  $("record-view").hidden = !c || state.raw;
  $("raw-document").hidden = !state.raw;
  $("save-contract").hidden = !state.raw || c?.kind !== "mission";
  $("show-contract").textContent = state.raw ? "返回文档" : "查看原文";
  $("raw-document").readOnly = c?.kind !== "mission";
  if (!state.raw) $("raw-document").value = d.content;
  if (!c && !state.raw && window.activeWorkspaceEditor) {
    window.activeWorkspaceEditor.open({
      document: d,
      token: state.token,
      name: state.name,
      onChange: () => {
        $("sync-state").textContent = "● 正在同步";
        clearTimeout(changeTimer);
        changeTimer = setTimeout(refresh, 900);
      },
      onStatus: (status) =>
        ($("sync-state").textContent =
          {
            connected: "● 实时协作已连接",
            connecting: "◌ 正在连接",
            disconnected: "◌ 离线，等待重连",
            unauthorized: "访问令牌无效",
          }[status] || status),
      onPresence: (names) =>
        ($("presence").textContent = [...new Set(names)].join(" · ") + " 在线"),
    });
  }
  if (c) {
    window.activeWorkspaceEditor?.close();
    $("presence").textContent = "";
    const signature = d.id + ":" + d.revision;
    if (state.signature !== signature) {
      state.signature = signature;
      if (c.kind === "mission")
        $("record-view").innerHTML =
          `<div class="record-summary"><span class="status-pill">${escape(labels[c.status] || c.status)}</span><h3>协作目标</h3><p>${escape(c.objective)}</p><h3>介入时机</h3><p>正文停止变化 ${escape(c.quiet_seconds)} 秒后，自动检查目标。提案经审阅接受后写入正文。</p><button class="subtle" data-select="${escape(c.source_document_id)}">打开来源文档 ↗</button><p>点击「查看原文」可直接编辑任务约定。</p></div>`;
      else
        $("record-view").innerHTML =
          `<div class="record-summary"><span class="status-pill">${escape(labels[c.status] || c.status)}</span><h3>为什么介入</h3><p>${escape(c.rationale)}</p><h3>原文依据 · r${escape(c.source_revision)}</h3>${(c.evidence_quotes || []).map((q) => `<blockquote class="evidence">${escape(q)}</blockquote>`).join("") || "<p>本次没有引用正文。</p>"}${c.kind === "proposal" ? `<h3>审阅完整修改</h3><div class="diff-grid"><div>修改前<pre>${escape(c.before)}</pre></div><div>建议修改后<pre>${escape(c.replacement)}</pre></div></div>${c.status === "pending" ? `<div class="review-actions"><button class="primary" data-review="accept">接受修改</button><button class="subtle" data-review="reject">拒绝提案</button></div>` : `<p>${escape(labels[c.status])} ${c.resolved_by ? "· " + escape(c.resolved_by) : ""}${c.result_revision ? " · 正文 r" + escape(c.result_revision) : ""}</p>`}` : ""}<p><button class="text-button" data-select="${escape(c.source_document_id)}">↗ 返回来源文档</button></p></div>`;
    }
  }
  const missions = records.filter(
    (x) =>
      x.contract.kind === "mission" &&
      x.contract.source_document_id === state.sourceId,
  );
  html(
    "missions",
    missions
      .map(
        (m) =>
          `<article class="mission-card"><div class="mission-header"><b>◉ ACTIVE AGENT</b><span>${escape(labels[m.contract.status])}</span></div><p>${escape(m.contract.objective)}</p><div class="mission-actions"><button data-select="${escape(m.id)}">查看任务约定 ↗</button><button data-status="${m.contract.status === "active" ? "paused" : "active"}" data-mission="${escape(m.id)}">${m.contract.status === "active" ? "Ⅱ 暂停" : "▷ 继续"}</button></div></article>`,
      )
      .join(""),
  );
  const proposals = records
    .filter(
      (x) =>
        ["proposal", "run"].includes(x.contract.kind) &&
        x.contract.source_document_id === state.sourceId,
    )
    .sort((a, b) => b.updated_at - a.updated_at);
  $("proposal-count").textContent = proposals.length;
  html(
    "proposals",
    proposals.length
      ? proposals
          .map(
            (p) =>
              `<article class="proposal-card ${escape(p.contract.status)}"><span class="tag">${escape(labels[p.contract.status] || p.contract.status)}</span><p>${escape(p.contract.rationale.slice(0, 180))}</p><footer><span>${time(p.updated_at)}</span><button data-select="${escape(p.id)}">查看${p.contract.kind === "proposal" ? "提案" : "依据"} ↗</button></footer></article>`,
          )
          .join("")
      : `<p class="empty">${missions.length ? "Agent 正在关注这份文档。<br>新的提案和判断依据会出现在这里。" : "写下一个目标，<br>让 Agent 加入这份文档的工作。"}</p>`,
  );
  $("assign").hidden = Boolean(c && c.kind !== "mission" && !state.sourceId);
}
async function refresh() {
  if (!state.token || state.refreshing) return;
  state.refreshing = true;
  try {
    const [board, worker] = await Promise.all([api(), api("/worker")]);
    state.docs = board.documents;
    if (!current())
      state.selected =
        state.docs.find((d) => !d.contract)?.id || state.docs[0]?.id;
    const alive = worker && Date.now() - worker.at < 120000;
    $("worker-state").textContent = alive
      ? {
          watching: "持续关注文档变化",
          thinking: "正在阅读与思考",
          retrying: "连接重试中",
        }[worker.status]
      : "等待后台 Worker 启动";
    $("sync-state").textContent = "● 已同步";
    render();
  } catch (e) {
    $("sync-state").textContent = "◌ 连接中断";
    $("worker-state").textContent = "服务连接中断";
  } finally {
    state.refreshing = false;
  }
}
async function connect() {
  await api();
  sessionStorage.activeDocToken = state.token;
  sessionStorage.activeDocName = state.name;
  $("connection").hidden = true;
  $("token").value = "";
  $("workspace").hidden = false;
  $("identity").textContent = state.name.slice(0, 1);
  state.selected = location.hash.slice(1);
  await refresh();
}
$("connect-form").onsubmit = async (e) => {
  e.preventDefault();
  state.name = $("name").value.trim();
  state.token = $("token").value.trim();
  try {
    await connect();
  } catch (error) {
    $("connect-error").textContent = error.message;
  }
};
$("sign-out").onclick = () => {
  sessionStorage.removeItem("activeDocToken");
  location.reload();
};
$("new-document").onclick = async () => {
  try {
    const d = await api("/documents", "POST", {
      title: "未命名文档",
      content: "## 一起开始\n\n在这里写下你的想法。",
    });
    await refresh();
    select(d.id);
  } catch (e) {
    toast(e.message);
  }
};
$("assign").onclick = () => $("mission-dialog").showModal();
$("cancel-mission").onclick = () => $("mission-dialog").close();
$("mission-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/missions", "POST", {
      source_document_id: state.sourceId,
      objective: $("objective").value,
      quiet_seconds: Number($("quiet").value),
    });
    $("mission-dialog").close();
    await refresh();
    toast("目标已写入任务文档，Agent 将持续关注。");
  } catch (error) {
    toast(error.message);
  }
};
$("demo").onclick = async () => {
  $("demo").disabled = true;
  try {
    const d = await api("/documents", "POST", {
      title: "上线计划 · 一次共同推进",
      content:
        "# 文档协作 · 上线计划\n\n## 目标\n让人和 Agent 在同一份在线文档里持续工作。\n\n## 已确定的边界\n本轮只做 Active Agent + Doc Free。所有修改都需要可见依据和人工审阅。\n\n## 验收条件\n系统应该足够快，体验应该不错，Agent 应该比较主动。\n\n## 下一步\n先进行小范围内部验证，再决定是否扩大范围。\n\n## 保留约束\n不接入 IM，不自动发布，不把凭据放进文档。",
    });
    await api("/missions", "POST", {
      source_document_id: d.id,
      objective:
        "只改进「验收条件」一节：把模糊要求改成 3 条可以实际验证的协作验收条件，不编造已经通过的测试，保留其他所有章节。",
      quiet_seconds: 5,
    });
    await refresh();
    select(d.id);
    toast("任务已经开始。继续编辑，或等待 Agent 把提案带回来。");
  } catch (e) {
    toast(e.message);
  } finally {
    $("demo").disabled = false;
  }
};
$("show-contract").onclick = () => {
  state.raw = !state.raw;
  if (state.raw) {
    state.rawBaseRevision = current().revision;
    $("raw-document").value = current().content;
  }
  render();
};
$("save-contract").onclick = async () => {
  const d = current();
  try {
    await api("/documents/" + d.id, "PUT", {
      content: $("raw-document").value,
      base_revision: state.rawBaseRevision,
    });
    state.raw = false;
    await refresh();
    toast("任务约定已更新。");
  } catch (e) {
    toast(e.message + "；你的草稿仍保留在编辑框中。");
  }
};
$("export-document").onclick = () => {
  const d = current();
  const url = URL.createObjectURL(
    new Blob([d.content], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = d.title.replace(/[\\/:*?"<>|]/g, "_") + ".md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.dataset.select) select(button.dataset.select);
  if (button.dataset.status) {
    const d = state.docs.find((d) => d.id === button.dataset.mission);
    try {
      await api("/missions/" + d.id, "PATCH", {
        status: button.dataset.status,
        base_revision: d.revision,
      });
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  }
  if (button.dataset.review) {
    const d = current();
    button.disabled = true;
    try {
      const result = await api("/proposals/" + d.id, "POST", {
        decision: button.dataset.review,
        base_revision: d.revision,
      });
      await refresh();
      toast(
        result.document.contract.status === "conflicted"
          ? "正文或任务已有新变化，请等待新提案；现有正文已保留。"
          : "提案" + labels[result.document.contract.status] + "。",
      );
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }
});
addEventListener("workspace-editor-ready", render);
addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (state.docs.some((d) => d.id === id)) select(id);
});
$("name").value = state.name;
if (state.token)
  connect().catch(() => {
    state.token = "";
    $("connect-error").textContent = "访问已过期，请重新输入令牌。";
  });
setInterval(refresh, 2500);
