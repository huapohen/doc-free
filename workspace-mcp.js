"use strict";
const text = { type: "string" },
  revision = { type: "integer", minimum: 0 };
const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: { ...properties, actor_id: text },
    required,
  },
});
const workspaceTools = [
  tool(
    "active_doc_workspace",
    "Read the same visible documents, mission contracts, proposals and observations as the workbench.",
  ),
  tool(
    "active_doc_read",
    "Read a live canonical document and its revision before editing.",
    { document_id: text },
    ["document_id"],
  ),
  tool(
    "active_doc_create",
    "Create an ordinary collaboration source document; no external sync.",
    { title: text, content: text },
    ["title", "content"],
  ),
  tool(
    "active_doc_write",
    "Edit a source or mission document using its base_revision. Conflicts preserve the current document.",
    { document_id: text, content: text, title: text, base_revision: revision },
    ["document_id", "content", "base_revision"],
  ),
  tool(
    "active_doc_assign",
    "Create a visible mission document. The active worker automatically observes its source.",
    {
      source_document_id: text,
      objective: text,
      quiet_seconds: { type: "integer", minimum: 2, maximum: 3600 },
    },
    ["source_document_id", "objective"],
  ),
  tool(
    "active_doc_status",
    "Pause, resume or complete a mission by updating its visible contract.",
    {
      document_id: text,
      status: { type: "string", enum: ["active", "paused", "completed"] },
      base_revision: revision,
    },
    ["document_id", "status", "base_revision"],
  ),
  tool(
    "active_doc_review",
    "Explicitly accept or reject a proposed document change. Acceptance checks live source and mission revisions.",
    {
      document_id: text,
      decision: { type: "string", enum: ["accept", "reject"] },
      base_revision: revision,
    },
    ["document_id", "decision", "base_revision"],
  ),
];
async function callWorkspaceTool(workspace, name, args) {
  const actor = String(args.actor_id || "external-agent").slice(0, 100);
  const id = args.document_id;
  if (
    [
      "active_doc_read",
      "active_doc_write",
      "active_doc_status",
      "active_doc_review",
    ].includes(name) &&
    (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
  )
    throw new Error("invalid document_id");
  const route = {
    active_doc_workspace: ["GET", "/api/workspace"],
    active_doc_read: ["GET", `/api/workspace/documents/${id}`],
    active_doc_create: ["POST", "/api/workspace/documents"],
    active_doc_write: ["PUT", `/api/workspace/documents/${id}`],
    active_doc_assign: ["POST", "/api/workspace/missions"],
    active_doc_status: ["PATCH", `/api/workspace/missions/${id}`],
    active_doc_review: ["POST", `/api/workspace/proposals/${id}`],
  }[name];
  if (!route) throw new Error("unknown workspace tool");
  return workspace.handle(...route, args, actor);
}
module.exports = { workspaceTools, callWorkspaceTool };
