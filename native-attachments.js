"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {forwardingBlocked}=require("./native-message-personal");
const { problem, requireText } = require("./work-protocol");
const MAX_BYTES = 12 * 1024 * 1024;
const copy = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function createAttachments({
  state,
  directory,
  stamp,
  persist,
  roomById,
  member,
  event,
  invalidateMessageRuns,
}) {
  state.attachments ||= [];
  state.attachment_keys ||= {};
  if (!Array.isArray(state.attachments) || !state.attachment_keys)
    throw new Error("Native attachment metadata is corrupt");
  function get(id) {
    const attachment = state.attachments.find((item) => item.id === id);
    if (!attachment) throw problem(404, "not_found", "附件不存在");
    return attachment;
  }
  function view(attachment) {
    return {
      ...copy(attachment),
      download_path: `/api/im/rooms/${attachment.room_id}/attachments/${attachment.id}/content`,
    };
  }
  function accessible(room, attachment) {
    if (attachment.room_id !== room.id)
      throw problem(403, "attachment_scope", "附件不属于当前会话");
    if (attachment.status !== "active")
      throw problem(410, "attachment_deleted", "附件已删除");
    if (
      attachment.message_ids.length &&
      !room.messages.some(
        (message) =>
          attachment.message_ids.includes(message.id) && !message.retracted_at,
      )
    )
      throw problem(410, "attachment_recalled", "附件所关联的消息均已撤回");
  }
  function forMessage(room, ids = [], {allowProtected=false,maxItems=8}={}) {
    if (
      !Array.isArray(ids) ||
      ids.length > maxItems ||
      ids.some((id) => typeof id !== "string")
    )
      throw problem(
        422,
        "invalid_attachments",
        "每条消息最多附加 8 个当前会话文件",
      );
    return [...new Set(ids)].map((id) => {
      const attachment = get(id);
      accessible(room, attachment);
      if(!allowProtected&&room.messages.some(message=>attachment.message_ids.includes(message.id)&&forwardingBlocked(state,room,message)))throw problem(403,"forwarding_disabled","禁止通过重用附件绕过消息转发保护");
      return view(attachment);
    });
  }
  function link(message) {
    for (const id of message.attachment_ids || []) {
      const attachment = get(id);
      if (!attachment.message_ids.includes(message.id))
        attachment.message_ids.push(message.id);
    }
  }
  function contextMetadata(message) {
    return (message.attachment_ids || []).map((id) => {
      const attachment = get(id);
      let availability = attachment.status;
      try {
        accessible(roomById(attachment.room_id), attachment);
      } catch (error) {
        availability = error.code;
      }
      return {
        id,
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        size: attachment.size,
        sha256: attachment.sha256,
        availability,
      };
    });
  }
  function quota(room, additions) {
    if (
      state.attachments.length + additions.length > 5000 ||
      state.attachments.filter((item) => item.room_id === room.id).length +
        additions.length >
        200
    )
      throw problem(409, "attachment_quota", "附件数量达到本地上限");
    const roomBytes = state.attachments
      .filter((item) => item.room_id === room.id)
      .reduce((sum, item) => sum + item.size, 0);
    if (
      roomBytes + additions.reduce((sum, item) => sum + item.size, 0) >
      200 * 1024 * 1024
    )
      throw problem(409, "attachment_quota", "会话附件超过 200 MiB 配额");
    const files = new Map(
      [...state.attachments, ...additions].map((item) => [
        item.sha256,
        item.size,
      ]),
    );
    if (
      [...files.values()].reduce((sum, size) => sum + size, 0) >
      1024 * 1024 * 1024
    )
      throw problem(409, "attachment_quota", "实例附件超过 1 GiB 配额");
  }
  function storeBlob(bytes, sha256) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        throw new Error("Invalid blob directory");
      const target = path.join(directory, sha256);
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size !== bytes.length ||
          hash(fs.readFileSync(target)) !== sha256
        )
          throw new Error("Corrupt blob");
        return;
      }
      const temp = path.join(directory, `${sha256}.${crypto.randomUUID()}.tmp`);
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, target);
    } catch {
      throw problem(
        503,
        "attachment_storage",
        "附件存储不可用，请检查磁盘和权限",
      );
    }
  }
  function normalizedMime(declared, bytes) {
    const allowed = {
      "image/png": () =>
        bytes.length >= 24 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.subarray(12, 16).toString() === "IHDR",
      "image/jpeg": () =>
        bytes.length >= 4 &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255 &&
        bytes.at(-2) === 255 &&
        bytes.at(-1) === 217,
      "image/gif": () =>
        bytes.length >= 13 &&
        ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()),
      "image/webp": () =>
        bytes.length >= 16 &&
        bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WEBP",
    };
    if (!Object.prototype.hasOwnProperty.call(allowed, declared))
      return "application/octet-stream";
    if (!allowed[declared]())
      throw problem(422, "mime_mismatch", "图片类型与文件特征不匹配");
    return declared;
  }
  function forward(sourceRoom, targetRoom, p, ids) {
    const originals = forMessage(sourceRoom, ids);
    quota(targetRoom, originals);
    return originals.map((original) => {
      const attachment = {
        id: `attachment-${crypto.randomUUID()}`,
        room_id: targetRoom.id,
        filename: original.filename,
        mime_type: original.mime_type,
        size: original.size,
        sha256: original.sha256,
        created_by: p.id,
        created_at: stamp(),
        status: "active",
        message_ids: [],
        forwarded_from: original.id,
      };
      state.attachments.push(attachment);
      return attachment.id;
    });
  }
  function prepareForwardBatch(sourceRoom, targets, p, ids) {
    const originals=forMessage(sourceRoom,ids,{maxItems:400});
    if(state.attachments.length+originals.length*targets.length>5000)
      throw problem(409,"attachment_quota","批次附件数量超过实例上限");
    for(const target of targets)quota(target,originals);
    // Construct all metadata only after every room quota/source check passes.
    // No blob is copied: target records reference already validated shared data.
    const plan=targets.map(target=>({room_id:target.id,attachments:originals.map(original=>({original_id:original.id,attachment:{
      id:`attachment-${crypto.randomUUID()}`,room_id:target.id,filename:original.filename,mime_type:original.mime_type,
      size:original.size,sha256:original.sha256,created_by:p.id,created_at:stamp(),status:"active",message_ids:[],forwarded_from:original.id,
    }}))}));
    return {plan,commit(){for(const target of plan)for(const item of target.attachments)state.attachments.push(item.attachment);}};
  }
  async function handle(method, pathname, input, p, params) {
    const match = pathname.match(
      /^\/api\/im\/rooms\/(room-[a-f0-9-]+)\/attachments(?:\/(attachment-[a-f0-9-]+)(?:\/(content))?)?$/,
    );
    if (!match) return undefined;
    if (params.has("token") || params.has("access_token"))
      throw problem(
        422,
        "header_auth_required",
        "附件凭据只能通过 Authorization 请求头传递",
      );
    const room = roomById(match[1]);
    member(room, p);
    if (!match[2] && method === "GET")
      return {
        attachments: state.attachments
          .filter((attachment) => {
            if (attachment.room_id !== room.id) return false;
            try {
              accessible(room, attachment);
              return true;
            } catch {
              return false;
            }
          })
          .map(view),
      };
    if (!match[2] && method === "POST") {
      const clientId = requireText(input.client_id, "client_id", 160),
        filename = requireText(input.filename, "filename", 200);
      if (/[\x00-\x1f\x7f/\\]/.test(filename) || [".", ".."].includes(filename))
        throw problem(422, "invalid_filename", "文件名不能包含路径或控制字符");
      const declared = requireText(
        input.mime_type || "application/octet-stream",
        "mime_type",
        100,
      ).toLowerCase();
      const encoded = input.data_base64;
      if (
        typeof encoded !== "string" ||
        encoded.length === 0 ||
        encoded.length > Math.ceil(MAX_BYTES / 3) * 4
      )
        throw problem(413, "too_large", "附件必须为 1 字节到 12 MiB");
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        throw problem(422, "invalid_base64", "请使用规范 base64 编码");
      const bytes = Buffer.from(encoded, "base64");
      if (
        bytes.length === 0 ||
        bytes.length > MAX_BYTES ||
        bytes.toString("base64") !== encoded
      )
        throw problem(422, "invalid_base64", "无效 base64 附件");
      const sha256 = hash(bytes),
        mime_type = normalizedMime(declared, bytes),
        digest = hash(
          JSON.stringify({ filename, declared, sha256, size: bytes.length }),
        );
      const key = `${room.id}:${p.id}:${clientId}`,
        previous = state.attachment_keys[key];
      if (previous) {
        if (previous.hash !== digest)
          throw problem(
            409,
            "idempotency_conflict",
            "相同 client_id 对应不同附件",
          );
        return { attachment: view(get(previous.id)), duplicate: true };
      }
      const attachment = {
        id: `attachment-${crypto.randomUUID()}`,
        room_id: room.id,
        filename,
        mime_type,
        size: bytes.length,
        sha256,
        created_by: p.id,
        created_at: stamp(),
        status: "active",
        message_ids: [],
      };
      quota(room, [attachment]);
      storeBlob(bytes, sha256);
      state.attachments.push(attachment);
      state.attachment_keys[key] = { id: attachment.id, hash: digest };
      event(room, "attachment.created", p.id, { attachment_id: attachment.id });
      persist();
      return { attachment: view(attachment), duplicate: false };
    }
    if (match[2]) {
      const attachment = get(match[2]);
      if (attachment.room_id !== room.id)
        throw problem(403, "attachment_scope", "附件不属于当前会话");
      if (!match[3] && method === "GET")
        return { attachment: view(attachment) };
      if (!match[3] && method === "DELETE") {
        if (
          attachment.created_by !== p.id &&
          room.members[p.id].role !== "owner"
        )
          throw problem(
            403,
            "creator_required",
            "只有上传者或会话所有者可以删除附件",
          );
        if (attachment.status !== "deleted") {
          attachment.status = "deleted";
          attachment.deleted_at = stamp();
          attachment.deleted_by = p.id;
          for (const messageId of attachment.message_ids)
            invalidateMessageRuns(room, messageId, p.id);
          event(room, "attachment.deleted", p.id, {
            attachment_id: attachment.id,
          });
          persist();
        }
        return { attachment: view(attachment) };
      }
      if (match[3] === "content" && method === "GET") {
        accessible(room, attachment);
        let bytes;
        try {
          if (!/^[a-f0-9]{64}$/.test(attachment.sha256))
            throw new Error("Invalid blob hash");
          const directoryStat = fs.lstatSync(directory);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new Error("Invalid blob directory");
          const location = path.join(directory, attachment.sha256),
            stat = fs.lstatSync(location);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size !== attachment.size ||
            stat.size > MAX_BYTES
          )
            throw new Error("Invalid blob");
          bytes = fs.readFileSync(location);
          if (hash(bytes) !== attachment.sha256)
            throw new Error("Hash mismatch");
        } catch {
          throw problem(503, "attachment_storage", "附件文件缺失或校验失败");
        }
        return {
          _native_binary: {
            content: bytes,
            mime_type: attachment.mime_type,
            filename: attachment.filename,
            size: attachment.size,
            sha256: attachment.sha256,
          },
        };
      }
    }
    throw problem(404, "not_found", "附件接口不存在");
  }
  return {
    handle,
    forMessage,
    link,
    forward,
    prepareForwardBatch,
    contextMetadata,
    roomRecords: (rid) =>
      state.attachments.filter((item) => item.room_id === rid).map(view),
  };
}
module.exports = { createAttachments, MAX_BYTES };
