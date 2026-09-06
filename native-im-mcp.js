"use strict";

// The human client and every agent operate the same member API. No administrator
// tools or UI automation are exposed through this gateway.
const s = { type: "string" },
  n = { type: "integer" },
  b = { type: "boolean" };
const strings = { type: "array", items: s };
const definitions = [];
function tool(
  name,
  description,
  method,
  route,
  properties = {},
  required = [],
  query = [],
) {
  const pathKeys = [...route.matchAll(/:([a-z_]+)/g)].map((m) => m[1]);
  definitions.push({
    name,
    description,
    method,
    route,
    query,
    pathKeys,
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(pathKeys.map((k) => [k, s])),
        ...properties,
      },
      required: [...new Set([...pathKeys, ...required])],
      additionalProperties: false,
    },
  });
}
tool(
  "im_identity",
  "Read your authenticated identity. Humans and agents sign in identically.",
  "GET",
  "/me",
);
tool(
  "im_people",
  "List workspace identities available for collaboration.",
  "GET",
  "/principals",
);
tool(
  "im_add_agent",
  "Add an existing agent to your colleague list.",
  "POST",
  "/agents",
  { principal_id: s },
  ["principal_id"],
);
tool(
  "im_library",
  "List shared document and task summaries across your memberships.",
  "GET",
  "/library",
);
tool(
  "im_agents",
  "List your agent friends and installed colleagues.",
  "GET",
  "/agents",
);
tool(
  "im_agent_store",
  "Browse available agent work profiles.",
  "GET",
  "/agent-store",
);
tool(
  "im_install_agent",
  "Acquire an independent colleague from the agent store.",
  "POST",
  "/agent-store/:template_id/install",
);
tool(
  "im_rooms",
  "List your conversations, unread counts and preferences.",
  "GET",
  "/rooms",
);
tool(
  "im_create_room",
  "Create an office group as its owner; either humans or agents can own groups.",
  "POST",
  "/rooms",
  { name: s, description: s },
  ["name"],
);
tool(
  "im_direct",
  "Start or reopen a direct conversation with a person or agent.",
  "POST",
  "/rooms/direct",
  { principal_id: s },
  ["principal_id"],
);
tool(
  "im_read_room",
  "Read the same messages, task board, document context and participants shown in the UI.",
  "GET",
  "/rooms/:room_id",
);
tool(
  "im_invite",
  "Invite a participant to a group you own.",
  "POST",
  "/rooms/:room_id/members",
  { principal_id: s },
  ["principal_id"],
);
tool(
  "im_remove_member",
  "Remove a group member when authorized as its owner.",
  "DELETE",
  "/rooms/:room_id/members/:principal_id",
);
tool(
  "im_participation",
  "Set your participation, or a member's when you own the group.",
  "PATCH",
  "/rooms/:room_id/participation",
  { principal_id: s, mode: { enum: ["active", "mentions", "paused"] } },
  ["mode"],
);
tool(
  "im_preferences",
  "Set your favorite, mute and read position.",
  "PATCH",
  "/rooms/:room_id/preferences",
  { favorite: b, muted: b, read_seq: n },
);
tool(
  "im_send",
  "Proactively send a message and @ humans or agents. Use a stable client_id when retrying. No UI interaction required.",
  "POST",
  "/rooms/:room_id/messages",
  { client_id: s, content: s, mentions: strings, reply_to: s },
  ["client_id", "content"],
);
tool(
  "im_history",
  "Read earlier conversation history.",
  "GET",
  "/rooms/:room_id/messages",
  { before: n, limit: n, q: s },
  [],
  ["before", "limit", "q"],
);
tool(
  "im_edit_message",
  "Edit your own message using its current revision.",
  "PATCH",
  "/rooms/:room_id/messages/:message_id",
  { content: s, base_revision: n },
  ["content", "base_revision"],
);
tool(
  "im_recall_message",
  "Recall your own message. A tombstone and revision audit remain visible.",
  "DELETE",
  "/rooms/:room_id/messages/:message_id",
  { base_revision: n },
  ["base_revision"],
);
tool(
  "im_react",
  "Toggle your reaction to a message.",
  "POST",
  "/rooms/:room_id/messages/:message_id/reactions",
  { emoji: s },
  ["emoji"],
);
tool(
  "im_search",
  "Search messages, shared documents and tasks only inside your current memberships.",
  "GET",
  "/search",
  { q: s },
  ["q"],
  ["q"],
);
tool(
  "im_create_task",
  "Create and assign work to a person or agent.",
  "POST",
  "/rooms/:room_id/tasks",
  { title: s, description: s, assignee_id: s },
  ["title"],
);
tool(
  "im_update_task",
  "Update task status, assignment or content using its current revision.",
  "PATCH",
  "/rooms/:room_id/tasks/:task_id",
  {
    title: s,
    description: s,
    assignee_id: { type: ["string", "null"] },
    status: { enum: ["open", "doing", "done"] },
    base_revision: n,
  },
  ["base_revision"],
);
tool(
  "im_create_document",
  "Create a canonical Doc Free shared document in your room.",
  "POST",
  "/rooms/:room_id/documents",
  { title: s, content: s },
  ["title", "content"],
);
tool(
  "im_read_document",
  "Read a canonical shared document with its revision and content hash.",
  "GET",
  "/rooms/:room_id/documents/:document_id",
);
tool(
  "im_write_document",
  "Write a shared document with optimistic version protection; agent and human use the same operation.",
  "PUT",
  "/rooms/:room_id/documents/:document_id",
  { title: s, content: s, base_revision: n },
  ["base_revision"],
);
tool(
  "im_run_record",
  "Inspect exact model input, visible decision and deliverable for a work turn.",
  "GET",
  "/rooms/:room_id/turns/:turn_id",
);
tool(
  "im_events",
  "Subscribe by durable cursor; replay on reconnect and use wait up to25seconds.",
  "GET",
  "/events",
  { after: n, wait: n },
  [],
  ["after", "wait"],
);
tool(
  "im_export",
  "Export the shared conversation, tasks, documents and work records as Markdown.",
  "GET",
  "/rooms/:room_id/export",
);
tool(
  "im_presence",
  "Publish your current presence as a logged-in participant.",
  "POST",
  "/presence",
  { status: { enum: ["online", "busy", "away", "offline"] } },
  ["status"],
);

const publicTools = definitions.map(
  ({ name, description, inputSchema, method }) => ({
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: method === "GET",
      destructiveHint: method === "DELETE",
      openWorldHint: false,
    },
  }),
);

async function callNativeTool(im, name, args, credential) {
  const definition = definitions.find((t) => t.name === name);
  if (!definition)
    throw Object.assign(new Error("Unknown native IM tool"), {
      status: 404,
      code: "unknown_tool",
    });
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw Object.assign(new Error("Arguments must be an object"), {
      status: 422,
    });
  for (const key of definition.inputSchema.required)
    if (args[key] === undefined)
      throw Object.assign(new Error(`Missing ${key}`), { status: 422 });
  for (const [key, value] of Object.entries(args)) {
    const schema = definition.inputSchema.properties[key];
    if (!schema)
      throw Object.assign(new Error(`Unknown field ${key}`), { status: 422 });
    if (
      (Array.isArray(schema.type) &&
        !(value === null
          ? schema.type.includes("null")
          : schema.type.includes(typeof value))) ||
      (schema.type === "string" && typeof value !== "string") ||
      (schema.type === "integer" && !Number.isSafeInteger(value)) ||
      (schema.type === "boolean" && typeof value !== "boolean") ||
      (schema.type === "array" &&
        (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) ||
      (schema.enum && !schema.enum.includes(value))
    )
      throw Object.assign(new Error(`Invalid ${key}`), { status: 422 });
  }
  let route = definition.route;
  for (const key of definition.pathKeys)
    route = route.replace(`:${key}`, encodeURIComponent(args[key]));
  const query = new URLSearchParams();
  for (const key of definition.query)
    if (args[key] !== undefined) query.set(key, String(args[key]));
  const body = Object.fromEntries(
    Object.entries(args).filter(
      ([key]) =>
        !definition.pathKeys.includes(key) && !definition.query.includes(key),
    ),
  );
  return im.handle(
    definition.method,
    "/api/im" + route,
    body,
    credential,
    query,
  );
}

async function nativeMCP(im, request, credential) {
  await im.handle("GET", "/api/im/me", {}, credential);
  const id = request?.id ?? null;
  if (request?.jsonrpc !== "2.0")
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid JSON-RPC request" },
    };
  if (request.method === "notifications/initialized") return null;
  let result;
  if (request.method === "initialize")
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "active-im-native", version: "0.3.0" },
    };
  else if (request.method === "tools/list") result = { tools: publicTools };
  else if (request.method === "tools/call") {
    try {
      const value = await callNativeTool(
        im,
        request.params?.name,
        request.params?.arguments || {},
        credential,
      );
      result = {
        content: [
          {
            type: "text",
            text: typeof value === "string" ? value : JSON.stringify(value),
          },
        ],
        isError: false,
      };
    } catch (error) {
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: error.status || 500,
              code: error.code || "operation_failed",
            }),
          },
        ],
        isError: true,
      };
    }
  } else
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    };
  return { jsonrpc: "2.0", id, result };
}
module.exports = { nativeMCP, callNativeTool, publicTools };
