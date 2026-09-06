"use strict";
const crypto = require("node:crypto");
const { problem } = require("./work-protocol");
const copy = (v) => JSON.parse(JSON.stringify(v));
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const FOLDERS = [
  ["inbox", "收件箱"], ["sent", "已发送"], ["drafts", "草稿箱"],
  ["archive", "归档"], ["trash", "回收站"],
];

// A real internal workspace mailbox. No message is represented as delivered to
// an external address. SMTP/IMAP requires a separately configured adapter.
function createNativeMail({ state, stamp, persist, active, principalView, publishPersonalEvent = () => {} }) {
  state.mail ||= { messages: [], deliveries: [], create_keys: {}, send_keys: {}, sequence: 0 };
  const box = state.mail;
  if (!Array.isArray(box.messages) || !Array.isArray(box.deliveries) || !box.create_keys || !box.send_keys)
    throw new Error("Mailbox state is corrupt");
  const person = (pid) => {
    try { return principalView(active(pid)); }
    catch (_) { return { id: pid, name: "已停用成员", kind: "unknown" }; }
  };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function text(value, name, max) {
    if (typeof value !== "string" || value.length > max)
      throw problem(422, "invalid_input", `${name} 超出限制`);
    return value;
  }
  function recipients(values) {
    if (!Array.isArray(values) || values.length > 100)
      throw problem(422, "invalid_recipients", "请选择工作空间中的收件人");
    const unique = [...new Set(values)];
    for (const pid of unique) {
      if (typeof pid !== "string") throw problem(422, "invalid_recipients", "无效收件人");
      active(pid);
    }
    return unique;
  }
  function fields(input, current = {}) {
    const to = recipients(input.to_ids ?? current.to_ids ?? []);
    const cc = recipients(input.cc_ids ?? current.cc_ids ?? []).filter((pid) => !to.includes(pid));
    const bcc = recipients(input.bcc_ids ?? current.bcc_ids ?? []).filter((pid) => !to.includes(pid) && !cc.includes(pid));
    if (to.length + cc.length + bcc.length > 100) throw problem(422, "too_many_recipients", "最多 100 位收件人");
    return { to_ids: to, cc_ids: cc, bcc_ids: bcc,
      subject: text(input.subject ?? current.subject ?? "", "主题", 300),
      body: text(input.body ?? current.body ?? "", "正文", 100000) };
  }
  function draft(mid, p) {
    const message = box.messages.find((item) => item.id === mid && item.sender_id === p.id);
    if (!message) throw problem(404, "not_found", "草稿不存在");
    return message;
  }
  function delivery(did, p) {
    const result = box.deliveries.find((item) => item.id === did && item.principal_id === p.id);
    if (!result) throw problem(404, "not_found", "邮件不存在");
    return result;
  }
  function revision(item, input) {
    if (!Number.isSafeInteger(input.base_revision)) throw problem(422, "version_required", "请提供版本");
    if (input.base_revision !== item.revision) throw problem(409, "conflict", "邮件版本已变化，请保留草稿并读取最新版本");
  }
  function view(message, p, item = null, full = false) {
    const sender = message.sender_id === p.id;
    const result = {
      id: item?.id ?? message.id, message_id: message.id, sender_id: message.sender_id,
      sender: person(message.sender_id), to_ids: copy(message.to_ids), cc_ids: copy(message.cc_ids),
      to: message.to_ids.map(person), cc: message.cc_ids.map(person),
      ...(sender ? { bcc_ids: copy(message.bcc_ids), bcc: message.bcc_ids.map(person) } : {}),
      subject: message.subject, preview: message.body.slice(0, 160),
      ...(full ? { body: message.body } : {}),
      status: message.status, folder: item?.folder ?? "drafts", original_folder: item?.original_folder ?? "drafts", read: item?.read ?? true,
      revision: item?.revision ?? message.revision, draft_revision: message.revision,
      created_at: message.created_at, updated_at: item?.updated_at ?? message.updated_at,
      sent_at: message.sent_at ?? null, transport: "workspace_internal",
    };
    return result;
  }
  function list(p, folder, query = "") {
    let values;
    if (folder === "drafts") values = box.messages.filter((m) => m.sender_id === p.id && m.status === "draft").map((m) => view(m, p));
    else values = box.deliveries.filter((d) => d.principal_id === p.id && d.folder === folder)
      .map((d) => view(box.messages.find((m) => m.id === d.message_id), p, d));
    if (query) values = values.filter((m) => {
      const source = box.messages.find((message) => message.id === m.message_id);
      return `${m.subject}\n${source.body}\n${m.sender.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
    });
    return values.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async function handle(method, pathname, input, p, params = new URLSearchParams()) {
    if (!pathname.startsWith("/api/im/mail")) return undefined;
    if (pathname === "/api/im/mail/folders" && method === "GET") return {
      mailbox: { name: "工作空间内部邮箱", principal_id: p.id, transport: "workspace_internal", external_connected: false },
      folders: FOLDERS.map(([id, name]) => { const items = list(p, id); return { id, name, count: items.length, unread: items.filter((item) => !item.read).length }; }), cursor: box.sequence,
    };
    if (pathname === "/api/im/mail" && method === "GET") {
      const folder = params.get("folder") || "inbox";
      if (!FOLDERS.some(([key]) => key === folder)) throw problem(422, "invalid_folder", "无效邮箱目录");
      const query = text(params.get("q") || "", "检索词", 200);
      const items = list(p, folder, query);
      return { items: items.slice(0, 200), total: items.length, cursor: box.sequence, folder };
    }
    if (pathname === "/api/im/mail/search" && method === "GET") {
      const query = text(params.get("q") || "", "检索词", 200);
      const items = FOLDERS.flatMap(([folder]) => list(p, folder, query));
      return { items: items.slice(0, 100), total: items.length };
    }
    if (pathname === "/api/im/mail/drafts" && method === "POST") {
      const content = fields(input), client = text(input.client_id, "client_id", 160);
      if (!client) throw problem(422, "invalid_input", "请提供幂等键");
      const key = `${p.id}:${client}`, digest = hash(content);
      if (own(box.create_keys, key)) {
        const previous = box.create_keys[key];
        if (previous.hash !== digest) throw problem(409, "idempotency_conflict", "同一请求内容不同");
        return { draft: view(draft(previous.id, p), p, null, true), duplicate: true };
      }
      if (box.messages.length >= 10000) throw problem(409, "limit_reached", "本地邮箱容量已达上限");
      const message = { id: id("mail"), sender_id: p.id, ...content, status: "draft", revision: 1, created_at: stamp(), updated_at: stamp() };
      publishPersonalEvent("mail.draft_created", p.id, { message_id: message.id }, [p.id]);
      box.messages.push(message); box.create_keys[key] = { id: message.id, hash: digest }; box.sequence++; persist();
      return { draft: view(message, p, null, true), duplicate: false };
    }
    const route = pathname.match(/^\/api\/im\/mail\/(mail-[a-f0-9-]+|delivery-[a-f0-9-]+)(?:\/(send|export))?$/);
    if (!route) return undefined;
    const key = route[1];
    if (route[2] === "export" && method === "GET") {
      const result = await handle("GET", "/api/im/mail/" + key, {}, p, params);
      const item = result.item;
      return `# ${item.subject || "无主题"}\n\n- 邮箱：工作空间内部邮箱\n- 发件人：${item.sender.name}\n- 收件人：${item.to.map(p=>p.name).join(", ")}\n- 抄送：${item.cc.map(p=>p.name).join(", ")}\n${item.bcc ? "- 密送：" + item.bcc.map(p=>p.name).join(", ") + "\n" : ""}- 时间：${item.sent_at || item.updated_at}\n- 版本：${item.revision}\n\n${item.body}\n`;
    }
    if (key.startsWith("mail-")) {
      const message = draft(key, p);
      if (method === "GET" && !route[2]) return { item: view(message, p, null, true) };
      if (method === "PATCH" && !route[2]) {
        if (message.status !== "draft") throw problem(409, "not_draft", "已发送邮件不可修改");
        revision(message, input); const content = fields(input, message);
        Object.assign(message, content); message.revision++; message.updated_at = stamp(); box.sequence++;
        publishPersonalEvent("mail.draft_updated", p.id, { message_id: message.id }, [p.id]); persist();
        return { draft: view(message, p, null, true) };
      }
      if (method === "POST" && route[2] === "send") {
        const client = text(input.client_id, "client_id", 160), sendKey = `${p.id}:${client}`;
        if (!client) throw problem(422, "invalid_input", "请提供幂等键");
        if (own(box.send_keys, sendKey)) {
          if (box.send_keys[sendKey] !== key) throw problem(409, "idempotency_conflict", "同一请求指向不同草稿");
          const sent = box.deliveries.find((item) => item.message_id === key && item.principal_id === p.id && item.original_folder === "sent");
          return { item: view(message, p, sent, true), duplicate: true, delivered: message.to_ids.length + message.cc_ids.length + message.bcc_ids.length };
        }
        if (message.status !== "draft") throw problem(409, "already_sent", "该草稿已经发送");
        revision(message, input);
        const targets = recipients([...message.to_ids, ...message.cc_ids, ...message.bcc_ids]);
        if (!targets.length || !message.subject.trim()) throw problem(422, "incomplete_mail", "请选择收件人并填写主题");
        if (box.deliveries.length + targets.length + 1 > 50000) throw problem(409, "limit_reached", "本地投递容量已达上限");
        const deliveries = targets.map((pid) => ({ id: id("delivery"), message_id: message.id, principal_id: pid, folder: "inbox", original_folder: "inbox", read: false, revision: 1, updated_at: stamp() }));
        deliveries.push({ id: id("delivery"), message_id: message.id, principal_id: p.id, folder: "sent", original_folder: "sent", read: true, revision: 1, updated_at: stamp() });
        message.status = "sent"; message.sent_at = message.updated_at = stamp(); message.revision++;
        box.deliveries.push(...deliveries); box.send_keys[sendKey] = key; box.sequence++;
        for (const item of deliveries) publishPersonalEvent(item.folder === "sent" ? "mail.sent" : "mail.received", p.id, { message_id: key, delivery_id: item.id }, [item.principal_id]);
        persist();
        return { item: view(message, p, deliveries.at(-1), true), delivered: targets.length, duplicate: false };
      }
      if (method === "DELETE" && !route[2]) {
        if (message.status !== "draft") throw problem(409, "not_draft", "只能移除自己的草稿");
        revision(message, input); message.status = "discarded"; message.revision++; message.updated_at = stamp();
        box.deliveries.push({ id: id("delivery"), message_id: key, principal_id: p.id, folder: "trash", original_folder: "drafts", read: true, revision: 1, updated_at: stamp() });
        box.sequence++; publishPersonalEvent("mail.discarded", p.id, {message_id:key}, [p.id]); persist(); return { discarded: true };
      }
    } else {
      const item = delivery(key, p), message = box.messages.find((m) => m.id === item.message_id);
      if (method === "GET") return { item: view(message, p, item, true) };
      if (method === "PATCH") {
        revision(item, input);
        if (input.folder !== undefined && !["inbox", "sent", "archive", "trash", "drafts"].includes(input.folder)) throw problem(422, "invalid_folder", "无效邮箱目录");
        if (input.read !== undefined && typeof input.read !== "boolean") throw problem(422, "invalid_input", "无效已读状态");
        if (input.folder === "sent" && message.sender_id !== p.id) throw problem(403, "not_sender", "不能把收到的邮件标成自己发送");
        if (input.folder === "drafts") {
          if (message.sender_id !== p.id || message.status !== "discarded" || item.original_folder !== "drafts") throw problem(409, "not_draft", "只有丢弃的草稿可恢复到草稿箱");
          message.status = "draft"; message.revision++; message.updated_at = stamp();
          box.deliveries.splice(box.deliveries.indexOf(item), 1); box.sequence++; publishPersonalEvent("mail.restored", p.id, {message_id:message.id}, [p.id]); persist();
          return { item: view(message, p, null, true) };
        }
        if (input.folder !== undefined) item.folder = input.folder;
        if (input.read !== undefined) item.read = input.read;
        item.revision++; item.updated_at = stamp(); box.sequence++; publishPersonalEvent("mail.updated", p.id, {delivery_id:item.id}, [p.id]); persist();
        return { item: view(message, p, item, true) };
      }
    }
    throw problem(405, "method_not_allowed", "不支持此邮件操作");
  }
  // Shared search applies structured predicates before its content scan and
  // result limits. Keep mailbox visibility and BCC projection in this module.
  function* searchCandidates(p) {
    for (const message of box.messages)
      if (message.sender_id === p.id && message.status === "draft")
        yield view(message, p, null, true);
    for (const item of box.deliveries)
      if (item.principal_id === p.id)
        yield view(box.messages.find((message) => message.id === item.message_id), p, item, true);
  }
  return { handle, searchCandidates };
}
module.exports = { createNativeMail };
