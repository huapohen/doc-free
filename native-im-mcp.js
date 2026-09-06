"use strict";

// The human client and every agent operate the same member API. No
// bootstrap credentials or UI automation are exposed through this gateway.
// Enterprise management uses the caller's current enterprise role for both kinds.
const s = { type: "string" },
  n = { type: "integer" },
  b = { type: "boolean" };
const strings = { type: "array", items: s };
const { MOBILE_NAV_IDS } = require("./native-settings");
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
  "List your agent friends, installed colleagues and shared-room peers. The first human read durably initializes the two default colleagues without joining rooms or granting device permissions.",
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
tool("im_configure_autonomy", "Configure an individual Agent colleague's bounded native actions and periodic pending-work review. Yourself or the room owner only; requires current room revision.",
  "PATCH", "/rooms/:room_id/participation", {
    principal_id: s, base_revision: n, mode: { enum: ["active", "mentions", "paused"] },
    autonomy: { type: "object", additionalProperties: false, properties: {
      enabled: b, max_steps: { type: "integer", minimum: 1, maximum: 4 },
      allowed_operations: { type: "array", items: { enum: ["im_create_task", "im_update_task", "im_add_contact", "office_create_event", "office_update_event", "office_respond_event", "im_create_document", "im_update_document"] } },
      review_interval_seconds: { type: "integer", minimum: 60, maximum: 86400 },
    } },
  }, ["base_revision", "autonomy"]);
tool("im_action_plan", "Read the visible frozen native plan and actual server receipts; unresolved canonical document outcomes remain applying, never claimed successful.",
  "GET", "/rooms/:room_id/turns/:turn_id/plan");
tool(
  "im_send",
  "Proactively send a message and @ humans or agents. Use a stable client_id when retrying. No UI interaction required.",
  "POST",
  "/rooms/:room_id/messages",
  { client_id: s, content: s, mentions: strings, reply_to: s, attachment_ids: strings },
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
  "Search visible work with server-side type, room, author and date filters applied before truncation. after is inclusive and before exclusive; both must be timezone-qualified ISO timestamps. Message time is sent_at, document time updated_at, and task/mail/approval/calendar time created_at. Unknown document authors remain null. Directory/store have no author/time and mail has no room scope.",
  "GET",
  "/search",
  { q: s, type: { enum: ["all", "message", "task", "document", "person", "agent", "store", "mail", "approval", "calendar"] }, room_id: s, author_id: s, after: s, before: s },
  ["q"],
  ["q", "type", "room_id", "author_id", "after", "before"],
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

// Meetings, calendar and workbench use exactly the same member authorization.
tool('office_meetings', 'List meetings visible through your room memberships.', 'GET', '/meetings');
tool('office_create_meeting', 'Create or schedule a meeting linked to a shared Doc Free note.', 'POST', '/rooms/:room_id/meetings',
  {title:s, starts_at:s, duration_minutes:n, client_id:s, document_id:s}, ['title','client_id']);
tool('office_read_meeting', 'Read meeting participants and canonical notes revisions.', 'GET', '/meetings/:meeting_id');
tool('office_bind_notes', 'Bind a shared document as meeting notes with revision checking.', 'PATCH', '/meetings/:meeting_id',
  {base_revision:n, document_id:s}, ['base_revision','document_id']);
tool('office_join_meeting', 'Join as your own identity. Does not capture devices; returns ephemeral media session.', 'POST', '/meetings/:meeting_id/join',
  {device_id:s}, ['device_id']);
tool('office_meeting_presence', 'Maintain your own meeting session and declare media state.', 'POST', '/meetings/:meeting_id/heartbeat',
  {session_id:s,audio:b,video:b,sharing:b}, ['session_id']);
tool('office_leave_meeting', 'Leave your current media session.', 'POST', '/meetings/:meeting_id/leave', {session_id:s}, ['session_id']);
tool('office_end_meeting', 'End a meeting when authorized as creator or room owner.', 'POST', '/meetings/:meeting_id/end');
tool('office_signal', 'Send ephemeral SDP or ICE to another current meeting session. Never use this for durable work context.', 'POST', '/meetings/:meeting_id/signals',
  {session_id:s,to:s,kind:{type:'string',enum:['offer','answer','candidate']},payload:{type:'object'}}, ['session_id','to','kind','payload']);
tool('office_receive_signals', 'Read ephemeral signaling for your own media session.', 'GET', '/meetings/:meeting_id/signals',
  {session_id:s,after:n,wait:n}, ['session_id'], ['session_id','after','wait']);
tool('office_calendar', 'List schedules shared with you.', 'GET', '/calendar');
tool('office_create_event', 'Create a shared calendar event for people and agents.', 'POST', '/rooms/:room_id/calendar',
  {title:s,starts_at:s,ends_at:s,description:s,location:s,attendee_ids:strings,client_id:s}, ['title','starts_at','ends_at','client_id']);
tool('office_read_event', 'Read a schedule including participant responses.', 'GET', '/calendar/:event_id');
tool('office_update_event', 'Edit a shared schedule with an expected revision.', 'PATCH', '/calendar/:event_id',
  {base_revision:n,title:s,starts_at:s,ends_at:s,description:s,location:s,attendee_ids:strings}, ['base_revision']);
tool('office_respond_event', 'Accept, decline or tentatively respond as your authenticated identity.', 'POST', '/calendar/:event_id/respond',
  {response:{type:'string',enum:['accepted','declined','tentative']}}, ['response']);
tool('office_workbench', 'Read real application availability and your favorite apps.', 'GET', '/workbench');
tool('office_favorite_apps', 'Choose and order your favorite workbench applications.', 'PATCH', '/workbench', {favorites:strings}, ['favorites']);

tool('im_attachments', 'List file metadata within a room you belong to.', 'GET', '/rooms/:room_id/attachments');
tool('im_attachment', 'Read shared file metadata. Download bytes with the member HTTP API; do not put binary content in model context.', 'GET', '/rooms/:room_id/attachments/:attachment_id');
tool('im_delete_attachment', 'Remove an attachment you uploaded or administer.', 'DELETE', '/rooms/:room_id/attachments/:attachment_id');
tool('im_pin_message', 'Pin or unpin a room message for collaborators.', 'POST', '/rooms/:room_id/messages/:message_id/pin', {pinned:b}, ['pinned']);
tool('im_pins', 'Read pinned messages in a room.', 'GET', '/rooms/:room_id/pins');
tool('im_forward_message', 'Forward a version of a visible message into another room you belong to, preserving its origin.', 'POST', '/rooms/:room_id/messages/:message_id/forward', {target_room_id:s,client_id:s,base_revision:n}, ['target_room_id','client_id','base_revision']);

const object = {type:'object'};
tool('im_contacts','List your own human and agent contacts. The first human read durably initializes the two default colleagues; later reads preserve personal removals.','GET','/contacts');
tool('im_initialize_default_contacts','Idempotently initialize a human account\'s default activate-agent and desktop companion contacts without device permissions, joining rooms or restoring removed contacts.','POST','/contacts/defaults');
tool('im_add_contact','Add a human or agent to your contacts without changing room permissions.','POST','/contacts',{principal_id:s},['principal_id']);
tool('im_remove_contact','Remove a contact from your own list.','DELETE','/contacts/:principal_id');
tool('office_settings','Read your personal office preferences.','GET','/settings');
const minuteFields = { title:s, meeting_id:{type:["string","null"]},audio_attachment_id:{type:["string","null"]},document_id:{type:["string","null"]},task_ids:strings,
  transcript:{type:"array",maxItems:200,items:{type:"object",additionalProperties:false,required:["offset_ms","text"],properties:{id:s,speaker_id:{type:["string","null"]},speaker_label:s,offset_ms:{type:"integer",minimum:0,maximum:86400000},text:{type:"string",maxLength:4000}}}} };
tool('office_minutes','List shared minutes only in your current rooms. Transcript is manual/imported; speech recognition is not configured.','GET','/minutes',{q:s,room_id:s},[],['q','room_id']);
tool('office_create_minute','Create shared room minutes with optional existing audio/meeting and manual transcript; does not transcribe or summarize audio.','POST','/rooms/:room_id/minutes',{client_id:s,...minuteFields},['client_id','title']);
tool('office_read_minute','Read a shared minute and its actual linked document/tasks using current membership and app permissions.','GET','/minutes/:minute_id');
tool('office_update_minute','Revise shared minutes with compare-and-swap. Create documents/tasks through existing member tools, then link their room-scoped IDs here.','PATCH','/minutes/:minute_id',{base_revision:n,...minuteFields},['base_revision']);
tool('office_update_settings','Update your own UI preferences with revision checking. mobile_nav is an ordered list of 1–4 unique feature IDs; the client always appends More. Preferences never grant feature or enterprise permissions.','PATCH','/settings',{base_revision:n,message_alignment:s,send_shortcut:s,text_scale:{type:'number'},show_message_preview:b,
  mobile_nav:{type:'array',minItems:1,maxItems:4,uniqueItems:true,items:{type:'string',enum:MOBILE_NAV_IDS}}},['base_revision']);
tool('office_account','Read your own account metadata. Passwords and bearer credentials are never returned.','GET','/auth/account');
tool('office_sessions','List your own login sessions.','GET','/auth/sessions');
tool('office_revoke_session','Revoke one of your own browser login sessions.','DELETE','/auth/sessions/:session_id');
tool('office_attendance','Read your own daily attendance records.','GET','/attendance',{date:s,timezone:s},[],['date','timezone']);
tool('office_clock','Check in or out as your authenticated identity using server time.','POST','/rooms/:room_id/attendance',{action:{type:'string',enum:['check_in','check_out']},timezone:s,location_note:s,client_id:s},['action','client_id']);
tool('office_attendance_export','Export your own scoped daily attendance as visible Markdown.','GET','/attendance/export',{date:s,timezone:s},[],['date','timezone']);
tool('office_attendance_correction','Request an auditable attendance correction for another member to approve.','POST','/rooms/:room_id/attendance/corrections',{record_id:s,date:s,timezone:s,check_in_at:s,check_out_at:s,reason:s,approver_id:s,client_id:s},['date','reason','approver_id','client_id']);
tool('office_approval_templates','Discover configured approval forms.','GET','/approval-templates');
tool('office_approvals','Read approval requests you are authorized to view.','GET','/approvals',{inbox:s},[],['inbox']);
tool('office_create_approval','Submit an approval to a specific other human or agent reviewer.','POST','/rooms/:room_id/approvals',{template_id:s,title:s,description:s,approver_id:s,payload:object,client_id:s},['template_id','title','approver_id','client_id']);
tool('office_read_approval','Read an authorized request and decision audit.','GET','/approvals/:approval_id');
tool('office_decide_approval','Approve or reject only as the assigned reviewer.','POST','/approvals/:approval_id/decision',{base_revision:n,decision:{type:'string',enum:['approved','rejected']},comment:s,client_id:s},['base_revision','decision','client_id']);
tool('office_cancel_approval','Cancel a request when authorized as requester or room owner.','POST','/approvals/:approval_id/cancel',{base_revision:n,client_id:s},['base_revision','client_id']);
tool('office_export_approval','Export an authorized approval and its audit as Markdown.','GET','/approvals/:approval_id/export');
tool('office_mail_folders','Read your internal workspace mailbox folders and counts.','GET','/mail/folders');
tool('office_mail','List mail in your own mailbox folder.','GET','/mail',{folder:s,q:s},[],['folder','q']);
tool('office_search_mail','Search only your own mail, including drafts.','GET','/mail/search',{q:s},['q'],['q']);
tool('office_read_mail','Read one authorized delivery or your draft; BCC is visible only to sender.','GET','/mail/:mail_id');
tool('office_draft_mail','Create an internal mail draft to people or agents with a stable intent id.','POST','/mail/drafts',{to_ids:strings,cc_ids:strings,bcc_ids:strings,subject:s,body:s,client_id:s},['client_id']);
tool('office_update_mail','Edit your draft, or change read/folder state of your own delivery.','PATCH','/mail/:mail_id',{base_revision:n,to_ids:strings,cc_ids:strings,bcc_ids:strings,subject:s,body:s,folder:s,read:b},['base_revision']);
tool('office_send_mail','Deliver your versioned draft to internal human and agent mailboxes; this never claims external SMTP delivery.','POST','/mail/:mail_id/send',{base_revision:n,client_id:s},['base_revision','client_id']);
tool('office_discard_draft','Move your draft to recoverable trash.','DELETE','/mail/:mail_id',{base_revision:n},['base_revision']);
tool('office_export_mail','Export an authorized mail item as Markdown without exposing other recipients BCC.','GET','/mail/:mail_id/export');
tool('office_plugins','Discover built-in and registered integration plugins.','GET','/plugins');
tool('office_capabilities','Discover native office capabilities and their authorization boundaries.','GET','/capabilities');
tool('office_configure_plugin','Configure a plugin for your own identity. This cannot expand permissions.','PATCH','/plugins/:plugin_id',{base_revision:n,enabled:b,config:object},['base_revision']);

const optionalId = {type: ['string', 'null']};
const enterpriseRole = {type:'string',enum:['owner','admin','member']};
const pageFields = {page:{type:'integer',minimum:1},page_size:{type:'integer',minimum:1,maximum:100}};
tool('enterprise_identity','Read the current enterprise workspace, your role and effective management capabilities. Roles apply equally to people and agents.','GET','/enterprise');
tool('enterprise_overview','Read authorized enterprise counts and your role. Requires current owner or admin membership.','GET','/enterprise/admin/overview');
tool('enterprise_members','Search and page enterprise human and agent identities. Requires owner or admin.','GET','/enterprise/admin/members', {q:s,status:{type:'string',enum:['all','active','disabled','revoked']},role:{type:'string',enum:['all','owner','admin','member']},department_id:s,organization_id:s,...pageFields},[],['q','status','role','department_id','organization_id','page','page_size']);
tool('enterprise_read_member','Read an enterprise member record when authorized as owner or admin.','GET','/enterprise/admin/members/:principal_id');
tool('enterprise_create_member','Create a human or agent workspace member. A personal credential is returned once; never persist it in a document or task. Requires owner or admin.','POST','/enterprise/admin/members',{name:s,kind:{type:'string',enum:['human','agent']},client_id:s,department_id:optionalId,organization_id:optionalId,profession:s,job_title:s},['name','kind','client_id']);
tool('enterprise_update_member','Update a versioned enterprise member. Only the owner assigns elevated roles; disabling invalidates login and stops running agent turns. Last owner is protected.','PATCH','/enterprise/admin/members/:principal_id',{base_revision:n,name:s,role:enterpriseRole,status:{type:'string',enum:['active','disabled']},department_id:optionalId,organization_id:optionalId,profession:s,job_title:s},['base_revision']);
tool('enterprise_revoke_member','Revoke a member identity permanently when authorized by enterprise role. This does not erase historical documents. Last owner is protected.','POST','/enterprise/admin/members/:principal_id/revoke',{base_revision:n},['base_revision']);
tool('enterprise_departments','List enterprise departments and parent relationships. Requires owner or admin.','GET','/enterprise/admin/departments',{q:s},[],['q']);
tool('enterprise_read_department','Read a department and its member count.','GET','/enterprise/admin/departments/:department_id');
tool('enterprise_create_department','Create a department with a stable intent id. Requires owner or admin.','POST','/enterprise/admin/departments',{name:s,parent_id:optionalId,client_id:s},['name','client_id']);
tool('enterprise_update_department','Rename or move a versioned department. Cycles are rejected.','PATCH','/enterprise/admin/departments/:department_id',{base_revision:n,name:s,parent_id:optionalId},['base_revision']);
tool('enterprise_delete_department','Delete a versioned empty department. Departments with members or children cannot be deleted.','DELETE','/enterprise/admin/departments/:department_id',{base_revision:n},['base_revision']);
tool('enterprise_organizations','List company and organization affiliations inside this workspace. Directory membership does not create tenant isolation. Requires owner or admin.','GET','/enterprise/admin/organizations',{q:s},[],['q']);
tool('enterprise_read_organization','Read an organization and its member count.','GET','/enterprise/admin/organizations/:organization_id');
tool('enterprise_create_organization','Create an organization with a stable intent id. Human and agent administrators use the same permission.','POST','/enterprise/admin/organizations',{name:s,description:s,client_id:s},['name','client_id']);
tool('enterprise_update_organization','Update an organization with revision checking.','PATCH','/enterprise/admin/organizations/:organization_id',{base_revision:n,name:s,description:s},['base_revision']);
tool('enterprise_delete_organization','Delete an empty organization at its expected revision. Existing members must be reassigned first.','DELETE','/enterprise/admin/organizations/:organization_id',{base_revision:n},['base_revision']);
tool('enterprise_roles','Discover actual fixed enterprise roles and capabilities.','GET','/enterprise/admin/roles',{q:s},[],['q']);
tool('enterprise_read_role','Read one enterprise role capability definition.','GET','/enterprise/admin/roles/:role_id');
tool('enterprise_audit','Read paged enterprise administration audit entries, including the human or agent actor and time. Requires owner or admin.','GET','/enterprise/admin/audit',{q:s,...pageFields},[],['q','page','page_size']);
tool('enterprise_update_profile','Rename the enterprise workspace with an expected revision. Requires owner.','PATCH','/enterprise/admin/profile',{base_revision:n,name:s},['base_revision','name']);
tool('enterprise_export','Export a human-readable Markdown snapshot of enterprise membership, departments, roles and management audit. No credentials or private mail are included.','GET','/enterprise/admin/export');

tool('enterprise_apps','Read enterprise applications, declared capabilities and effective availability policies. Requires owner or admin.','GET','/enterprise/admin/apps',{q:s},[],['q']);
tool('enterprise_read_app','Read one enterprise application policy and its module dependencies. Requires owner or admin.','GET','/enterprise/admin/apps/:plugin_id');
tool('enterprise_configure_app','Set enforced module availability for people and agents with revision checking. Explicit denies override grants; core settings and enterprise recovery remain available.','PATCH','/enterprise/admin/apps/:plugin_id',{base_revision:n,enabled:b,scope_mode:{type:'string',enum:['all','restricted']},allowed_principal_ids:strings,allowed_department_ids:strings,denied_principal_ids:strings},['base_revision','enabled']);

const publicTools = definitions.map(
  ({ name, description, inputSchema, method }) => ({
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: method === "GET" && !["im_contacts","im_agents"].includes(name),
      destructiveHint: method === "DELETE",
      openWorldHint: false,
    },
  }),
);

function resolveNativeTool(name, args) {
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
    if (!Object.prototype.hasOwnProperty.call(definition.inputSchema.properties,key))
      throw Object.assign(new Error(`Unknown field ${key}`), { status: 422 });
    if (
      (Array.isArray(schema.type) &&
        !(value === null
          ? schema.type.includes("null")
          : schema.type.includes(typeof value))) ||
      (schema.type === "string" && typeof value !== "string") ||
      (schema.type === "integer" && !Number.isSafeInteger(value)) ||
      (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) ||
      (schema.type === "boolean" && typeof value !== "boolean") ||
      (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) ||
      (schema.type === "array" &&
        (!Array.isArray(value) || (schema.items?.type === "string" && value.some((v) => typeof v !== "string")) ||
          (schema.items?.type === "object" && value.some((v) => !v || typeof v !== "object" || Array.isArray(v))))) ||
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
  return { method: definition.method, pathname: "/api/im" + route, input: body, params: query };
}

async function callNativeTool(im, name, args, credential) {
  const resolved = resolveNativeTool(name, args);
  return im.handle(resolved.method, resolved.pathname, resolved.input, credential, resolved.params);
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
      serverInfo: { name: "active-im-native", version: "0.6.0" },
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
              ...(error.code === "app_policy_denied" && typeof error.plugin_id === "string" ? {plugin_id:error.plugin_id} : {}),
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
module.exports = { nativeMCP, callNativeTool, resolveNativeTool, publicTools };
