const http = require("http"),
  net = require("net"),
  fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const { Pool } = require("pg");
const { WebSocketServer, WebSocket } = require("ws");
const { createWorkspace } = require("./workspace");
const { createNativeIM } = require("./native-im");
const { nativeMCP, callNativeTool, publicTools } = require("./native-im-mcp");
const { createNativeA2A } = require("./native-a2a");
const { problem } = require("./work-protocol");
const { workspaceTools, callWorkspaceTool } = require("./workspace-mcp");
const ROOT = __dirname,
  DATA = path.resolve(process.env.DOC_FREE_DATA || path.join(ROOT, "data.json")),
  AUTH = path.join(ROOT, "auth.json"),
  INTEGRATION_AUTH = path.join(ROOT, "integration-auth.json"),
  AFFINE_WORKSPACE_ID =
    process.env.AFFINE_WORKSPACE_ID || "779fabb1-3e57-4164-af4c-1ed50153e16a",
  PORT = Number(process.env.PORT || 3210);
const COLLAB_URL = process.env.COLLAB_URL || "http://127.0.0.1:1234";
const documentLocks = new Map();
async function withDocumentLock(id, operation) {
  const previous = documentLocks.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  documentLocks.set(id, next);
  try { return await next; }
  finally { if (documentLocks.get(id) === next) documentLocks.delete(id); }
}
let token = process.env.DOC_FREE_TOKEN;
function readEnvFile(file) {
  const values = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
  return values;
}
const productEnv = {};
try {
  for (const line of fs
    .readFileSync(path.join(ROOT, ".env.affine-docmost"), "utf8")
    .split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) productEnv[line.slice(0, at)] = line.slice(at + 1);
  }
} catch {}
const agentEnv = {
  ...readEnvFile(path.join(ROOT, ".env.agent")),
  ...process.env,
};
const AGENT_API_KEY =
    agentEnv.DEEPSEEK_API_KEY || agentEnv.OPENAI_API_KEY || "",
  AGENT_BASE_URL = (
    agentEnv.DEEPSEEK_BASE_URL ||
    agentEnv.OPENAI_BASE_URL ||
    "https://api.deepseek.com"
  ).replace(/\/$/, ""),
  AGENT_MODEL = agentEnv.DEEPSEEK_MODEL || "deepseek-chat";
const affineDb = new Pool({
  host: "127.0.0.1",
  port: 54331,
  user: "affine",
  password: productEnv.AFFINE_DB_PASSWORD,
  database: "affine",
  connectionTimeoutMillis: 1500,
});
const docmostDb = new Pool({
  host: "127.0.0.1",
  port: 54332,
  user: "docmost",
  password: productEnv.DOCMOST_DB_PASSWORD,
  database: "docmost",
  connectionTimeoutMillis: 1500,
});
function docmostCookie() {
  try {
    const line = fs
      .readFileSync(path.join(ROOT, "docmost.cookies"), "utf8")
      .split("\n")
      .find((x) => x.includes("\tauthToken\t"));
    const fields = line?.split("\t") || [];
    return fields.length >= 7 ? `authToken=${fields[6]}` : "";
  } catch {
    return "";
  }
}
async function docmostApi(endpoint, payload) {
  const response = await fetch(`http://localhost:3020/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: docmostCookie() },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || result.success === false)
    throw new Error(result.message || `Docmost API ${response.status}`);
  return result.data ?? result;
}
function affineMcpToken() {
  try {
    const auth = JSON.parse(fs.readFileSync(INTEGRATION_AUTH, "utf8"));
    return auth.token || auth.data?.createMcpCredential?.token || "";
  } catch {
    return "";
  }
}
async function affineMcp(toolName, args = {}) {
  const affineToken = affineMcpToken();
  if (!affineToken) throw new Error("AFFiNE MCP credential is not configured");
  const response = await fetch(
    `http://localhost:3010/api/workspaces/${AFFINE_WORKSPACE_ID}/mcp`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${affineToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    },
  );
  const result = await response.json();
  if (!response.ok || result.error)
    throw new Error(
      result.error?.message || `AFFiNE MCP request failed (${response.status})`,
    );
  if (result.result?.isError) {
    const message = result.result.content?.map((x) => x.text).join("\n");
    throw new Error(message || "AFFiNE MCP tool failed");
  }
  const content = result.result?.content;
  if (Array.isArray(content) && content.length === 1 && content[0].type === "text") {
    try {
      return JSON.parse(content[0].text);
    } catch {
      return content[0].text;
    }
  }
  return result.result;
}
function parseAgentJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}
async function planDocumentUpdate(instruction, current) {
  if (!AGENT_API_KEY)
    throw new Error("文档 Agent 模型凭据尚未配置");
  const response = await fetch(`${AGENT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AGENT_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      temperature: 0.45,
      max_tokens: 5000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是 Doc Free 的文档执行 Agent。根据用户指令编辑当前文档，并只返回 JSON 对象：" +
            '{"title":"最终标题","content":"最终完整 Markdown 正文","operations":[{"type":"replace_block或insert_after_block","block_id":"已有块ID","content":"新块内容"}],"targets":["affine","docmost"],"reply":"给用户的简短说明"}。' +
            "content 必须是编辑后的完整正文，不是建议或差异。局部修改时优先提供 operations；只能使用 currentDocument.blocks 中真实存在的 block_id，不能编造。整篇重写时 operations 可为空。默认 targets 同时包含 affine 和 docmost；只有用户明确说仅本地、仅某个平台或不要同步时才改变。不要把标题 H1 重复放进正文。",
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction,
            currentDocument: {
              title: current.title,
              content: String(current.content || "").slice(0, 40000),
              blocks: documentBlocks(current).map((block) => ({
                id: block.id,
                index: block.index,
                content: block.content.slice(0, 4000),
              })),
            },
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message || `模型请求失败 (${response.status})`);
  const plan = parseAgentJson(result.choices?.[0]?.message?.content);
  if (!plan || typeof plan.content !== "string")
    throw new Error("模型没有返回完整文档内容");
  plan.title = String(plan.title || current.title || "未命名文档").trim();
  plan.targets = Array.isArray(plan.targets)
    ? plan.targets.filter((x) => x === "affine" || x === "docmost")
    : ["affine", "docmost"];
  plan.operations = Array.isArray(plan.operations)
    ? plan.operations.filter((operation) =>
        ["replace_block", "insert_after_block"].includes(operation?.type) &&
        typeof operation.block_id === "string" && typeof operation.content === "string",
      )
    : [];
  return plan;
}
function applyBlockOperations(document, operations) {
  let blocks = documentBlocks(document);
  for (const operation of operations) {
    const index = blocks.findIndex((block) => block.id === operation.block_id);
    if (index < 0) throw new Error(`Agent 返回了失效块 ID：${operation.block_id}`);
    if (operation.type === "replace_block") blocks[index] = { ...blocks[index], content: operation.content };
    else blocks.splice(index + 1, 0, { id: newBlockId(), content: operation.content });
  }
  return { content: blocks.map((block) => block.content).join("\n\n"), blockIds: blocks.map((block) => block.id) };
}
async function firstDocmostSpaceId() {
  const { rows } = await docmostDb.query(
    "select id from spaces order by created_at limit 1",
  );
  if (!rows[0]?.id) throw new Error("Docmost space not found");
  return rows[0].id;
}
async function syncAgentDocument(document, targets) {
  document.integrations ||= {};
  const actions = [];
  for (const target of targets) {
    try {
      if (target === "affine") {
        let docId = document.integrations.affine;
        if (docId) {
          await affineMcp("update_document", {
            docId,
            content: document.content,
          });
          await affineMcp("update_document_meta", {
            docId,
            title: document.title,
          });
          actions.push({ target, operation: "updated", id: docId, ok: true });
        } else {
          const created = await affineMcp("create_document", {
            title: document.title,
            content: document.content,
          });
          docId = created?.docId;
          if (!docId) throw new Error("AFFiNE 未返回文档 ID");
          document.integrations.affine = docId;
          actions.push({ target, operation: "created", id: docId, ok: true });
        }
      } else if (target === "docmost") {
        let pageId = document.integrations.docmost;
        if (pageId) {
          await docmostApi("pages/update", {
            pageId,
            title: document.title,
            content: document.content,
            format: "markdown",
            operation: "replace",
          });
          actions.push({ target, operation: "updated", id: pageId, ok: true });
        } else {
          const created = await docmostApi("pages/create", {
            spaceId: await firstDocmostSpaceId(),
            title: document.title,
            content: document.content,
            format: "markdown",
          });
          pageId = created?.id;
          if (!pageId) throw new Error("Docmost 未返回文档 ID");
          document.integrations.docmost = pageId;
          actions.push({ target, operation: "created", id: pageId, ok: true });
        }
      }
    } catch (error) {
      actions.push({ target, ok: false, error: error.message });
    }
  }
  return actions;
}
async function runDocumentAgent(input) {
  const document = doc(input.document_id);
  if (!document) throw new Error("当前文档不存在");
  const instruction = String(input.instruction || "").trim();
  if (!instruction) throw new Error("请输入文档指令");
  const currentDraft = {
    ...document,
    title:
      typeof input.current_title === "string"
        ? input.current_title
        : document.title,
    content:
      typeof input.current_content === "string"
        ? input.current_content
        : document.content,
  };
  const plan = await planDocumentUpdate(instruction, currentDraft);
  let blockPlan = plan.operations.length
    ? applyBlockOperations(currentDraft, plan.operations)
    : { content: plan.content, blockIds: null };
  let plannedContent = blockPlan.content;
  let merge = await rebaseCollabDocument(document.id, currentDraft.content, plannedContent, plan.title);
  let rebased = merge.content !== plan.content;
  if (!merge.applied) {
    const latest = await readCollabDocument(document.id);
    const retry = await planDocumentUpdate(
      `${instruction}\n\n注意：其他协作者刚刚修改了正文。请在下面最新版本上完成同一任务，不要撤销他人的修改。`,
      { ...currentDraft, content: latest },
    );
    plan.title = retry.title;
    plan.targets = retry.targets;
    plan.reply = retry.reply;
    plan.operations = retry.operations;
    blockPlan = retry.operations.length
      ? applyBlockOperations({ ...currentDraft, content: latest }, retry.operations)
      : { content: retry.content, blockIds: null };
    plannedContent = blockPlan.content;
    merge = await rebaseCollabDocument(document.id, latest, plannedContent, retry.title);
    if (!merge.applied) throw new Error("同一区块发生并发冲突，请重试这条指令");
    rebased = true;
  }
  document.history ||= [];
  document.history.unshift({
    title: currentDraft.title,
    content: currentDraft.content,
    at: document.updatedAt,
    source: "agent",
  });
  document.title = plan.title;
  document.content = merge.content;
  if (blockPlan.blockIds && merge.content === plannedContent) document.blockIds = blockPlan.blockIds;
  else documentBlocks(document);
  document.updatedAt = Date.now();
  document.revision = Number(document.revision || 0) + 1;
  const committedRevision = document.revision;
  let actions = await syncAgentDocument(document, plan.targets);
  if (document.revision !== committedRevision)
    actions = await syncAgentDocument(document, plan.targets);
  recordAudit(document, { actor_id: input.actor_id || "doc_free", requester_id: input.requester_id || null, operation: plan.operations.length ? "agent_block_update" : "agent_update" });
  log(
    "Agent 更新文档",
    `${document.title} · ${actions.map((x) => `${x.target}:${x.ok ? x.operation : "failed"}`).join(" · ")}`,
  );
  save();
  broadcastGroup({ type: "document", document });
  return {
    reply: plan.reply || "文档已按你的要求更新。",
    document,
    actions,
    model: AGENT_MODEL,
    rebased,
    operations: plan.operations,
  };
}
async function rebaseCollabDocument(documentId, base, content, title) {
  const response = await fetch(`${COLLAB_URL}/internal/rebase`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ document_id: documentId, base, content, title }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`协作正文合并失败 (${response.status})`);
  return response.json();
}
async function readCollabDocument(documentId) {
  return (await readCollabSnapshot(documentId)).content || "";
}
async function readCollabSnapshot(documentId) {
  const response = await fetch(`${COLLAB_URL}/internal/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ document_id: documentId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`协作正文读取失败 (${response.status})`);
  return response.json();
}
async function syncCollabDocument(document, expected, meta = {}) {
  const response = await fetch(`${COLLAB_URL}/internal/${expected === undefined ? "replace" : "compare-replace"}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ document_id: document.id, title: document.title, content: document.content,
      expected_content: expected, expected_title: meta.expected_title, operation_id: meta.operation_id,
      expected_state_hash: meta.expected_state_hash,
      result_revision: document.revision }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw problem(response.status === 409 ? 409 : 503,
    response.status === 409 ? "conflict" : "collaboration_unavailable", `协作正文同步失败 (${response.status})`);
  document.crdt_state_hash = (await response.json()).state_hash;
}
async function readCanonicalDocument(id) {
  const document = doc(id);
  if (!document) return null;
  const readRevision = document.revision;
  const live = await readCollabSnapshot(id);
  if (document.revision !== readRevision) return readCanonicalDocument(id);
  if (!live.initialized) {
    await syncCollabDocument(document);
    return document;
  }
  document.applied_operations = live.operations || {};
  if (document.content !== live.content || document.title !== live.title ||
      (document.crdt_state_hash && document.crdt_state_hash !== live.state_hash)) {
    document.content = live.content;
    document.title = live.title;
    document.updatedAt = Date.now();
    document.revision = Number(document.revision || 0) + 1;
    documentBlocks(document);
    recordAudit(document, { actor_id: "collaborator", operation: "crdt_observed" });
    document.crdt_state_hash = live.state_hash;
    save();
  }
  document.crdt_state_hash = live.state_hash;
  return document;
}
function newBlockId() {
  return `block-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
function documentBlocks(document) {
  const parts = String(document.content || "").split(/\n{2,}/);
  document.blockIds ||= [];
  while (document.blockIds.length < parts.length) document.blockIds.push(newBlockId());
  document.blockIds = document.blockIds.slice(0, parts.length);
  return parts.map((content, index) => ({ id: document.blockIds[index], index, content }));
}
function blockDocument(document, blockIdValue) {
  return documentBlocks(document).find((block) => block.id === blockIdValue);
}
function recordAudit(document, meta = {}) {
  db.audit ||= [];
  db.audit.unshift({ id: uid(), document_id: document.id, actor_id: meta.actor_id || "system", requester_id: meta.requester_id || null, revision: Number(document.revision || 0), operation: meta.operation || "update", at: Date.now() });
  db.audit = db.audit.slice(0, 1000);
  db.documentEvents ||= [];
  db.eventSequence = Number(db.eventSequence || 0) + 1;
  db.documentEvents.push({ seq: db.eventSequence, document_id: document.id,
    revision: Number(document.revision || 0), actor_id: meta.actor_id || "system",
    operation: meta.operation || "update", at: Date.now() });
}
async function createLocalDocument(input = {}, meta = {}) {
  const document = { id: input.id || uid(), title: input.title || "未命名文档", icon: "◈", content: input.content || "", updatedAt: Date.now(), revision: 1, history: [] };
  documentBlocks(document);
  await syncCollabDocument(document);
  db.docs.unshift(document);
  recordAudit(document, { ...meta, operation: "create" });
  log("创建文档", document.title);
  broadcastGroup({ type: "docs_changed", document });
  return document;
}
async function persistDocumentChange(document, content, meta = {}) {
  if (meta.base_version !== undefined && Number(meta.base_version) !== Number(document.revision || 0))
    throw problem(409, "conflict", `版本冲突：期望 ${meta.base_version}，当前 ${document.revision || 0}`);
  const previous = { ...document };
  const next = { ...document, title: typeof meta.title === "string" ? meta.title : document.title,
    content, updatedAt: Date.now(), revision: Number(document.revision || 0) + 1,
    history: [{ title: document.title, content: document.content, at: document.updatedAt,
      source: meta.actor_id || "mcp" }, ...(document.history || [])].slice(0, 100) };
  if (Array.isArray(meta.block_ids)) next.blockIds = meta.block_ids;
  else documentBlocks(next);
  // Compare inside the CRDT transaction; nothing changes locally on failure.
  await syncCollabDocument(next, previous.content, { ...meta, expected_title: previous.title,
    expected_state_hash: previous.crdt_state_hash });
  Object.assign(document, next);
  save();
  broadcastGroup({ type: "document", document });
  recordAudit(document, { ...meta, actor_id: meta.actor_id || "mcp" });
  save();
  return document;
}
if (!token) {
  try {
    token = JSON.parse(fs.readFileSync(AUTH, "utf8")).token;
  } catch {}
  if (!token) {
    token = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(AUTH, JSON.stringify({ token }, null, 2));
  }
}
let db;
try {
  db = JSON.parse(fs.readFileSync(DATA, "utf8"));
} catch {
  db = {
    docs: [
      {
        id: "welcome",
        title: "欢迎来到 Doc Free",
        icon: "✦",
        content:
          "# 你的本地 Agent-native 文档\n\n这是一个属于你的、无需反复登录的工作空间。\n\n## 快速开始\n- 在左侧创建文档\n- 使用右侧 Agent 对文档进行块级修改\n- 通过 MCP 让 Codex、Claude 或自定义 Agent 读写文档\n\n> 数据保存在本机 `data.json`，随时可导出。",
        updatedAt: Date.now(),
        history: [],
      },
    ],
    activity: [],
  };
  save();
}
db.chat ||= [];
db.audit ||= [];
db.idempotency ||= {};
for (const document of db.docs) documentBlocks(document);
save();
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA + ".tmp", JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(DATA + ".tmp", DATA);
}
function json(res, x, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(x));
}
function body(req, limit = 2_000_000) {
  return new Promise((ok, fail) => {
    let size = 0, stopped = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (stopped) return;
      size += chunk.length;
      if (size > limit) {
        stopped = true; chunks.length = 0;
        return fail(problem(413, "too_large", "请求过大"));
      }
      chunks.push(chunk);
    });
    req.on("error", fail);
    req.on("aborted", () => fail(problem(400, "aborted", "请求已中断")));
    req.on("end", () => {
      if (stopped) return;
      try { ok(size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (_) { fail(problem(400, "invalid_json", "JSON 格式不正确")); }
    });
  });
}
function auth(req) {
  let h = req.headers.authorization || "";
  return h === "Bearer " + token || req.headers["x-doc-free-token"] === token;
}
function doc(id) {
  return db.docs.find((d) => d.id === id);
}
function uid() {
  return crypto.randomUUID().slice(0, 8);
}
function log(action, detail) {
  db.activity.unshift({ id: uid(), action, detail, at: Date.now() });
  db.activity = db.activity.slice(0, 30);
  save();
}
const tools = [
  {
    name: "list_document_apps",
    description: "列出 Doc Free 集成的文档应用及访问入口",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_documents",
    description: "列出工作空间内的文档",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_document",
    description: "读取文档标题与完整 Markdown 内容",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "create_document",
    description: "创建一个 Markdown 文档",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, content: { type: "string" },
        actor_id: { type: "string" }, requester_id: { type: "string" }, idempotency_key: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "replace_document",
    description: "替换文档内容并保留历史版本",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        content: { type: "string" },
        actor_id: { type: "string" }, requester_id: { type: "string" },
        base_version: { type: "integer" }, idempotency_key: { type: "string" },
      },
      required: ["document_id", "content"],
    },
  },
  {
    name: "append_to_document",
    description: "向文档末尾追加内容",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        content: { type: "string" },
        actor_id: { type: "string" }, requester_id: { type: "string" },
        base_version: { type: "integer" }, idempotency_key: { type: "string" },
      },
      required: ["document_id", "content"],
    },
  },
  {
    name: "list_blocks",
    description: "列出本地文档的稳定块 ID、顺序与内容摘要，供 Agent 精确定位",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "read_block",
    description: "读取本地文档中的一个块",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" }, block_id: { type: "string" } },
      required: ["document_id", "block_id"],
    },
  },
  {
    name: "replace_block",
    description: "只替换本地文档中的一个块，并同步 CRDT、AFFiNE、Docmost",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        block_id: { type: "string" },
        content: { type: "string" },
        actor_id: { type: "string" },
        requester_id: { type: "string" },
        base_version: { type: "integer" }, idempotency_key: { type: "string" },
      },
      required: ["document_id", "block_id", "content"],
    },
  },
  {
    name: "insert_after_block",
    description: "在指定块后插入一个新块，并同步 CRDT、AFFiNE、Docmost",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        block_id: { type: "string" },
        content: { type: "string" },
        actor_id: { type: "string" },
        requester_id: { type: "string" },
        base_version: { type: "integer" }, idempotency_key: { type: "string" },
      },
      required: ["document_id", "block_id", "content"],
    },
  },
  {
    name: "search_documents",
    description: "跨 Doc Free、AFFiNE、Docmost 搜索文档标题和正文",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "list_all_documents",
    description: "列出 Doc Free、AFFiNE、Docmost 的全部服务器端文档",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_external_document",
    description: "读取 affine: 或 docmost: 前缀的外部文档",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "create_docmost_document",
    description: "通过 Docmost 正式页面 API 创建 Markdown 文档",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        space_id: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_docmost_document",
    description: "通过 Docmost 正式页面 API 替换、追加或前置 Markdown 内容",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        operation: { type: "string", enum: ["replace", "append", "prepend"] },
      },
      required: ["document_id"],
    },
  },
  {
    name: "create_affine_document",
    description: "通过 AFFiNE 官方 MCP/CRDT 写入机制创建 Markdown 文档",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "update_affine_document",
    description: "通过 AFFiNE 官方结构化差异算法更新正文，保留历史并支持实时协作",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        content: { type: "string" },
      },
      required: ["document_id", "content"],
    },
  },
  {
    name: "rename_affine_document",
    description: "通过 AFFiNE 官方 MCP 更新文档标题",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        title: { type: "string" },
      },
      required: ["document_id", "title"],
    },
  },
  {
    name: "read_affine_document",
    description: "通过 AFFiNE 官方 MCP 读取完整文档",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "search_affine_documents",
    description: "通过 AFFiNE 官方 MCP 搜索持久化工作区文档",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        document_ids: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
];
async function externalDocuments() {
  const result = [];
  try {
    const { rows } = await affineDb.query(
      "select page_id,title,summary,workspace_id from workspace_pages where blocked=false order by title nulls last",
    );
    result.push(
      ...rows.map((r) => ({
        id: `affine:${r.workspace_id}:${r.page_id}`,
        source: "affine",
        title: r.title || "Untitled",
        content: r.summary || "",
      })),
    );
  } catch {}
  try {
    const { rows } = await docmostDb.query(
      "select id,slug_id,title,text_content,updated_at from pages where deleted_at is null order by updated_at desc",
    );
    result.push(
      ...rows.map((r) => ({
        id: `docmost:${r.id}`,
        source: "docmost",
        slug_id: r.slug_id,
        title: r.title || "Untitled",
        content: r.text_content || "",
        updatedAt: r.updated_at,
      })),
    );
  } catch {}
  return result;
}
async function mcp(req, res) {
  if (!auth(req)) return json(res, { error: "Unauthorized" }, 401);
  let b = await body(req),
    id = b.id || uid();
  if (b.method === "initialize")
    return json(res, {
      jsonrpc: "2.0",
      id: b.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "doc-free", version: "0.2.0" },
        capabilities: { tools: {} },
      },
    });
  if (b.method === "tools/list")
    return json(res, { jsonrpc: "2.0", id: b.id, result: { tools: [...tools, ...workspaceTools] } });
  if (b.method !== "tools/call")
    return json(res, { jsonrpc: "2.0", id: b.id, result: {} });
  let n = b.params?.name,
    a = b.params?.arguments || {},
    out;
  if (typeof n === "string" && n.startsWith("active_doc_")) {
    try {
      out = await callWorkspaceTool(workspace, n, a);
      return json(res, { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify(out) }], isError: false } });
    } catch (error) {
      return json(res, { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify({ error: error.message, code: error.code || "invalid_request" }) }], isError: true } });
    }
  }
  const idempotencyKey = String(a.idempotency_key || "").slice(0, 200);
  if (idempotencyKey && db.idempotency[idempotencyKey] !== undefined) {
    out = db.idempotency[idempotencyKey];
    return json(res, { jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
  }
  if (n === "list_document_apps")
    out = [
      {
        id: "doc-free",
        name: "Doc Free",
        local_url: "http://localhost:3210",
      },
      {
        id: "affine",
        name: "AFFiNE",
        local_url: "http://localhost:3010",
        public_url: "https://newly-reunion-highland-literacy.trycloudflare.com",
      },
      {
        id: "docmost",
        name: "Docmost",
        local_url: "http://localhost:3020",
        public_url: "https://sword-nitrogen-cement-fastest.trycloudflare.com",
      },
    ];
  else if (n === "list_all_documents") {
    const local = db.docs.map((d) => ({
      id: `docfree:${d.id}`,
      source: "docfree",
      title: d.title,
      content: d.content,
      updatedAt: d.updatedAt,
    }));
    out = local.concat(await externalDocuments());
  } else if (n === "read_external_document") {
    if (a.document_id.startsWith("docmost:")) {
      out = await docmostApi("pages/info", {
        pageId: a.document_id.slice("docmost:".length),
        format: "markdown",
      });
    } else
      out = (await externalDocuments()).find((d) => d.id === a.document_id) || {
        error: "not found",
      };
  } else if (n === "create_docmost_document") {
    let spaceId = a.space_id;
    if (!spaceId) {
      const { rows } = await docmostDb.query(
        "select id from spaces order by created_at limit 1",
      );
      spaceId = rows[0]?.id;
    }
    if (!spaceId) throw new Error("Docmost space not found");
    const created = await docmostApi("pages/create", {
      spaceId,
      title: a.title,
      content: a.content || "",
      format: "markdown",
    });
    out = {
      id: `docmost:${created.id}`,
      title: created.title,
      slugId: created.slugId,
    };
  } else if (n === "update_docmost_document") {
    const pageId = a.document_id.replace(/^docmost:/, "");
    const payload = { pageId };
    if (a.title !== undefined) payload.title = a.title;
    if (a.content !== undefined) {
      payload.content = a.content;
      payload.format = "markdown";
      payload.operation = a.operation || "replace";
    }
    const updated = await docmostApi("pages/update", payload);
    out = {
      id: `docmost:${updated.id}`,
      title: updated.title,
      updatedAt: updated.updatedAt,
    };
  } else if (n === "create_affine_document") {
    out = await affineMcp("create_document", {
      title: a.title,
      content: a.content,
    });
  } else if (n === "update_affine_document") {
    out = await affineMcp("update_document", {
      docId: a.document_id.replace(/^affine(?::[^:]+)?:/, ""),
      content: a.content,
    });
  } else if (n === "rename_affine_document") {
    out = await affineMcp("update_document_meta", {
      docId: a.document_id.replace(/^affine(?::[^:]+)?:/, ""),
      title: a.title,
    });
  } else if (n === "read_affine_document") {
    out = await affineMcp("read_document", {
      docId: a.document_id.replace(/^affine(?::[^:]+)?:/, ""),
    });
  } else if (n === "search_affine_documents") {
    const args = { query: a.query };
    if (a.document_ids)
      args.doc_ids = a.document_ids.map((id) =>
        id.replace(/^affine(?::[^:]+)?:/, ""),
      );
    if (a.limit) args.limit = a.limit;
    out = await affineMcp("doc_search", args);
  } else if (n === "list_documents")
    out = db.docs.map((d) => ({
      id: d.id,
      title: d.title,
      updatedAt: d.updatedAt,
      revision: Number(d.revision || 0),
    }));
  else if (n === "read_document") {
    let d = doc(a.document_id);
    out = d
      ? { id: d.id, title: d.title, content: d.content, updatedAt: d.updatedAt, revision: Number(d.revision || 0) }
      : { error: "not found" };
  } else if (n === "create_document") {
    out = await createLocalDocument(a, { actor_id: a.actor_id || "mcp", requester_id: a.requester_id || null });
  } else if (n === "list_blocks") {
    const d = doc(a.document_id);
    out = d ? documentBlocks(d) : { error: "not found" };
  } else if (n === "read_block") {
    const d = doc(a.document_id);
    const block = d && blockDocument(d, a.block_id);
    out = block || { error: "block not found" };
  } else if (n === "replace_block" || n === "insert_after_block") {
    const d = doc(a.document_id);
    const block = d && blockDocument(d, a.block_id);
    if (!d) out = { error: "not found" };
    else if (!block) out = { error: "block not found", blocks: documentBlocks(d) };
    else {
      const blocks = documentBlocks(d);
      const next = n === "replace_block"
        ? blocks.map((item) => item.id === block.id ? { ...item, content: String(a.content || "") } : item)
        : blocks.flatMap((item) => item.id === block.id ? [item, { id: newBlockId(), content: String(a.content || "") }] : [item]);
      await persistDocumentChange(d, next.map((item) => item.content).join("\n\n"), { ...a, block_ids: next.map((item) => item.id) });
      const actions = await syncAgentDocument(d, ["affine", "docmost"]);
      log(n === "replace_block" ? "替换文档块" : "插入文档块", `${d.title} · ${a.actor_id || "mcp"}`);
      out = { ok: true, document_id: d.id, blocks: documentBlocks(d), actions, updatedAt: d.updatedAt };
    }
  } else if (n === "replace_document" || n === "append_to_document") {
    let d = doc(a.document_id);
    if (!d) out = { error: "not found" };
    else {
      const nextContent =
        n === "append_to_document" ? d.content + "\n\n" + a.content : a.content;
      await persistDocumentChange(d, nextContent, a);
      log(n === "append_to_document" ? "追加内容" : "更新文档", d.title);
      out = { ok: true, document_id: d.id, updatedAt: d.updatedAt };
    }
  } else if (n === "search_documents") {
    let q = (a.query || "").toLowerCase();
    const local = db.docs.map((d) => ({
      id: `docfree:${d.id}`,
      source: "docfree",
      title: d.title,
      content: d.content,
    }));
    out = local
      .concat(await externalDocuments())
      .filter((d) => (d.title + " " + d.content).toLowerCase().includes(q))
      .map((d) => ({
        id: d.id,
        source: d.source,
        title: d.title,
        snippet: d.content.slice(0, 180),
      }));
  } else out = { error: "unknown tool" };
  if (idempotencyKey) {
    db.idempotency[idempotencyKey] = out;
    const keys = Object.keys(db.idempotency);
    for (const key of keys.slice(0, Math.max(0, keys.length - 500))) delete db.idempotency[key];
    save();
  }
  return json(res, {
    jsonrpc: "2.0",
    id: b.id,
    result: { content: [{ type: "text", text: JSON.stringify(out) }] },
  });
}
function page() {
  return Buffer.from(
    fs
      .readFileSync(path.join(ROOT, "index.html"), "utf8")
      .replace(
        "</body>",
        '<script type="module" src="/assets/tiptap-editor.js"></script></body>',
      ),
  );
}
db.workspace ||= {};
const workspace = createWorkspace({ documents: () => db.docs, read: readCanonicalDocument,
  create: createLocalDocument, write: persistDocumentChange, lock: withDocumentLock,
  events: () => db.documentEvents || [], save, state: db.workspace });
const nativeIMPath = path.resolve(process.env.DOC_FREE_IM_DATA || path.join(path.dirname(DATA), "native-im.json"));
const nativeIM = createNativeIM({ file: nativeIMPath, adminToken: token, workspace, saveDocuments: save });
const nativeA2A = createNativeA2A({ file: path.join(path.dirname(nativeIMPath), "native-a2a.json"),
  im: nativeIM, invokeTool: callNativeTool, publicTools });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/.well-known/agent-card.json" && req.method === "GET") {
      return json(res, nativeA2A.agentCard(process.env.DOC_FREE_PUBLIC_URL || `http://localhost:${PORT}`));
    }
    if (url.pathname === "/office") {
      res.writeHead(302, { location: "/office/" }); return res.end();
    }
    if (url.pathname.startsWith("/office/")) {
      const buildRoot = path.resolve(process.env.DOC_FREE_OFFICE_BUILD || path.join(ROOT, "../active-agent/apps/office/build/web"));
      const relative = decodeURIComponent(url.pathname.slice("/office/".length)) || "index.html";
      const target = path.resolve(buildRoot, relative);
      if (!target.startsWith(buildRoot + path.sep)) return json(res, { error: "not found" }, 404);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(res, { error: "Office client asset unavailable" }, 404);
      const types = { ".html":"text/html", ".js":"text/javascript", ".json":"application/json", ".wasm":"application/wasm",
        ".css":"text/css", ".png":"image/png", ".ico":"image/x-icon", ".svg":"image/svg+xml", ".ttf":"font/ttf", ".woff2":"font/woff2" };
      res.writeHead(200, { "content-type":(types[path.extname(target)]||"application/octet-stream"), "cache-control":"no-cache", "x-content-type-options":"nosniff" });
      return fs.createReadStream(target).pipe(res);
    }
    if (url.pathname === "/im" || url.pathname.startsWith("/im/")) {
      const asset = { "/im": ["im.html", "text/html"], "/im/app.js": ["im.js", "text/javascript"],
        "/im/style.css": ["im.css", "text/css"] }[url.pathname];
      if (!asset) return json(res, { error: "not found" }, 404);
      res.writeHead(200, { "content-type": asset[1] + "; charset=utf-8", "cache-control": "no-cache",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
      return res.end(fs.readFileSync(path.join(ROOT, asset[0])));
    }
    // Independent principal credentials never authenticate the legacy admin APIs.
    if (url.pathname === "/api/im" || url.pathname.startsWith("/api/im/")) {
      const credential = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || "";
      const uploading = req.method === "POST" && /^\/api\/im\/rooms\/room-[a-f0-9-]+\/attachments$/.test(url.pathname);
      if (uploading) await nativeIM.handle("GET", "/api/im/me", {}, credential);
      const input = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ? await body(req, uploading ? 18 * 1024 * 1024 : 2_000_000) : {};
      if (url.pathname === "/api/im/a2a" && req.method === "POST") {
        res.setHeader("cache-control", "no-store");
        return json(res, await nativeA2A.handle(input, credential));
      }
      if (url.pathname === "/api/im/mcp" && req.method === "POST") {
        const result = await nativeMCP(nativeIM, input, credential);
        res.setHeader("cache-control", "no-store");
        if (result === null) { res.writeHead(204); return res.end(); }
        return json(res, result);
      }
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const result = await nativeIM.handle(req.method, url.pathname, input, credential, url.searchParams, controller.signal);
      if (res.destroyed) return;
      if (result?._native_binary) {
        const binary = result._native_binary;
        res.writeHead(200, {
          "content-type": binary.mime_type || "application/octet-stream",
          "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(binary.filename).replace(/'/g, "%27"),
          "content-length": binary.content.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
        });
        return res.end(binary.content);
      }
      if (typeof result === "string") {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
        return res.end(result);
      }
      res.setHeader("cache-control", "no-store");
      return json(res, result);
    }
    if (url.pathname === "/workbench" || url.pathname.startsWith("/workbench/")) {
      const assets = { "/workbench": ["workbench.html", "text/html"],
        "/workbench/app.js": ["workbench.js", "text/javascript"],
        "/workbench/style.css": ["workbench.css", "text/css"] };
      const asset = assets[url.pathname];
      if (!asset) return json(res, { error: "not found" }, 404);
      res.writeHead(200, { "content-type": asset[1] + "; charset=utf-8", "cache-control": "no-cache" });
      return res.end(fs.readFileSync(path.join(ROOT, asset[0])));
    }
    if (url.pathname.startsWith("/api/workspace")) {
      if (!auth(req)) return json(res, { error: "Unauthorized" }, 401);
      if (url.pathname === "/api/workspace/events" && req.method === "GET") {
        const after = Number(url.searchParams.get("after") || 0);
        if (!Number.isSafeInteger(after) || after < 0) throw problem(422, "invalid_cursor", "无效事件游标");
        const batch = (db.documentEvents || []).filter((e) => e.seq > after).slice(0, 200);
        return json(res, { events: batch, cursor: batch.at(-1)?.seq ?? after,
          high_watermark: db.eventSequence || 0, reset_required: after > (db.eventSequence || 0) });
      }
      if (url.pathname === "/api/workspace/worker") {
        if (req.method === "POST") {
          const input = await body(req);
          db.workspace.worker = { at: Date.now(), status: ["watching", "thinking", "retrying"].includes(input.status) ? input.status : "watching",
            model: String(input.model || "rules").slice(0, 100), mission_id: String(input.mission_id || "").slice(0, 100) };
        }
        return json(res, db.workspace.worker || null);
      }
      const input = ["POST", "PUT", "PATCH"].includes(req.method) ? await body(req) : {};
      let actor;
      try { actor = decodeURIComponent(String(req.headers["x-actor-id"] || "human")).slice(0, 100); }
      catch { throw problem(422, "invalid_actor", "无效的 actor 编码"); }
      return json(res, await workspace.handle(req.method, url.pathname, input, actor));
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers":
          "authorization,content-type,x-doc-free-token",
      });
      return res.end();
    }
    if (req.url === "/mcp" && req.method === "POST")
      return await mcp(req, res);
    if (req.url === "/api/bootstrap" && auth(req))
      return json(res, { docs: db.docs, activity: db.activity });
    if (req.url === "/api/agent" && req.method === "POST") {
      if (!auth(req)) return json(res, { error: "Unauthorized" }, 401);
      return json(res, await runDocumentAgent(await body(req)));
    }
    if (req.url.startsWith("/api/docs/") && auth(req)) {
      let id = req.url.split("/")[3],
        d = doc(id);
      if (req.method === "GET") return json(res, d || {}, d ? 200 : 404);
      if (req.method === "PUT") {
        let b = await body(req);
        if (!d) return json(res, { error: "not found" }, 404);
        await persistDocumentChange(d, b.content ?? d.content, { title: b.title ?? d.title, actor_id: b.actor_id || "web" });
        log("编辑文档", d.title);
        return json(res, d);
      }
      if (req.method === "DELETE") {
        db.docs = db.docs.filter((x) => x.id !== id);
        log("删除文档", id);
        save();
        broadcastGroup({ type: "docs_changed" });
        return json(res, { ok: true });
      }
    }
    if (req.url === "/api/docs" && req.method === "POST" && auth(req)) {
      const b = await body(req);
      return json(res, await createLocalDocument(b, { actor_id: b.actor_id || "web", requester_id: b.requester_id || null }));
    }
    if (req.url.startsWith("/api/search") && auth(req)) {
      let q = new URL(req.url, "http://x").searchParams.get("q") || "";
      return json(
        res,
        db.docs.filter((d) =>
          (d.title + " " + d.content).toLowerCase().includes(q.toLowerCase()),
        ),
      );
    }
    if (req.url === "/health") return json(res, { ok: true });
    if (["/assets/tiptap-editor.js", "/assets/workbench-editor.js"].includes(req.url)) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
      });
      return res.end(
        fs.readFileSync(path.join(ROOT, "public", path.basename(req.url))),
      );
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page());
  } catch (e) {
    json(res, { error: e.message, code: e.code || "internal_error", ...(e.code === "app_policy_denied" && typeof e.plugin_id === "string" ? {plugin_id:e.plugin_id} : {}) }, e.status || 500);
  }
});
const groupServer = new WebSocketServer({ noServer: true });
const groupClients = new Set();
const palette = ["#6d5dfc", "#e05d8b", "#168a72", "#d97818", "#3976d8", "#8c52a8"];

function sendGroup(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function broadcastGroup(payload) {
  for (const socket of groupClients) sendGroup(socket, payload);
}
function onlineUsers() {
  return [...groupClients]
    .filter((socket) => socket.identity)
    .map((socket) => socket.identity);
}
function broadcastPresence() {
  broadcastGroup({ type: "presence", users: onlineUsers() });
}
function appendChat(message) {
  db.chat.push(message);
  db.chat = db.chat.slice(-300);
  save();
  broadcastGroup({ type: "chat", message });
}
groupServer.on("connection", (socket) => {
  const authTimer = setTimeout(() => socket.close(4401, "Authentication required"), 5000);
  socket.on("message", async (raw) => {
    let input;
    try {
      input = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!socket.identity) {
      if (input.type !== "auth" || input.token !== token) return socket.close(4403, "Invalid token");
      clearTimeout(authTimer);
      const name = String(input.name || "访客").trim().slice(0, 24) || "访客";
      socket.identity = {
        id: crypto.randomUUID().slice(0, 8),
        name,
        color: palette[groupClients.size % palette.length],
        documentId: String(input.documentId || ""),
      };
      groupClients.add(socket);
      sendGroup(socket, { type: "ready", self: socket.identity, messages: db.chat.slice(-100) });
      broadcastPresence();
      return;
    }
    if (input.type === "focus") {
      socket.identity.documentId = String(input.documentId || "");
      broadcastPresence();
      return;
    }
    if (input.type !== "chat") return;
    const text = String(input.text || "").trim().slice(0, 5000);
    const documentId = String(input.documentId || socket.identity.documentId || "");
    if (!text || !doc(documentId)) return;
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      author: socket.identity.name,
      color: socket.identity.color,
      text,
      documentId,
      at: Date.now(),
    };
    appendChat(userMessage);
    if (!/@doc_free\b/i.test(text)) return;
    const jobId = crypto.randomUUID();
    broadcastGroup({ type: "agent_status", documentId, jobId, running: true, author: socket.identity.name });
    void (async () => {
      try {
        const result = await runDocumentAgent({
          document_id: documentId,
          instruction: text.replace(/@doc_free\b/gi, "").trim(),
          current_title: typeof input.currentTitle === "string" ? input.currentTitle : undefined,
          current_content: typeof input.currentContent === "string" ? input.currentContent : undefined,
        });
        appendChat({
          id: crypto.randomUUID(), role: "agent", author: "doc_free", text: result.reply,
          documentId, actions: result.actions, at: Date.now(),
        });
      } catch (error) {
        appendChat({
          id: crypto.randomUUID(), role: "agent", author: "doc_free",
          text: `执行失败：${error.message}`, documentId, error: true, at: Date.now(),
        });
      } finally {
        broadcastGroup({ type: "agent_status", documentId, jobId, running: false });
      }
    })();
  });
  socket.on("close", () => {
    clearTimeout(authTimer);
    groupClients.delete(socket);
    broadcastPresence();
  });
});
server.on("upgrade", (req, clientSocket, head) => {
  if (req.url.startsWith("/group")) {
    return groupServer.handleUpgrade(req, clientSocket, head, (socket) =>
      groupServer.emit("connection", socket, req),
    );
  }
  if (!req.url.startsWith("/collab")) return clientSocket.destroy();
  const collabAddress = new URL(COLLAB_URL);
  const upstream = net.connect(Number(collabAddress.port || 80), collabAddress.hostname, () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n");
    upstream.write(
      `${req.method} /${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`,
    );
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream).pipe(clientSocket);
  });
  upstream.on("error", () => clientSocket.destroy());
});
server.listen(PORT, process.env.HOST || "127.0.0.1", () =>
  console.log(
    `Doc Free running on http://localhost:${PORT}\nMCP endpoint: http://localhost:${PORT}/mcp\nWorkspace authentication configured`,
  ),
);
