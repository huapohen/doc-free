const { Server, OutgoingMessage } = require("@hocuspocus/server");
const fs = require("fs");
const path = require("path");
const Y = require("yjs");
const { getSchema } = require("@tiptap/core");
const StarterKit = require("@tiptap/starter-kit").default;
const DiffMatchPatch = require("diff-match-patch");
const { commitDocumentOperation, stateHash } = require("./collab-operations");
const { durableWrite } = require("./durable-write");
const {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} = require("@tiptap/y-tiptap");
const port = Number(process.env.COLLAB_PORT || 1234);
const dataDir = process.env.DOC_FREE_CRDT_DIR || path.join(__dirname, "yjs-data");
const schema = getSchema([StarterKit]);
const diffMatchPatch = new DiffMatchPatch();
const { parseContract } = require("./work-protocol");

function deviceToken() {
  if (process.env.DOC_FREE_TOKEN) return process.env.DOC_FREE_TOKEN;
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "auth.json"), "utf8"),
  ).token;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let value = "";
    request.on("data", (chunk) => (value += chunk));
    request.on("end", () => {
      try {
        resolve(value ? JSON.parse(value) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

const { markdownDocument, prosemirrorText } = require("./document-format");

function createCollabServer({ authorizeEditor } = {}) {
let persistenceFailure;
const check = (context, documentName) => context?.editor_access ? authorizeEditor(context.editor_access, documentName) : null;
const server = new Server({
  port,
  address: process.env.COLLAB_HOST || "127.0.0.1",
  async onAuthenticate({ token, documentName }) {
    if (token === deviceToken()) return { legacy_workspace: true };
    if (!authorizeEditor) throw new Error("Invalid Doc Free token");
    authorizeEditor(token, documentName);
    return { editor_access: token };
  },
  async beforeHandleMessage({ context, documentName, update }) {
    check(context, documentName);
    if (context?.editor_access && update.length > 2_000_000) throw new Error("Editor update exceeds limit");
  },
  async beforeSync({ context, documentName, document, type, payload }) {
    if (!context?.editor_access) return;
    check(context, documentName);
    if (type === 0) return;
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
      const receipts = JSON.stringify(candidate.getMap("active-agent-operations").toJSON());
      Y.applyUpdate(candidate, payload);
      if (candidate.store.pendingStructs || candidate.store.pendingDs ||
          [...candidate.share.keys()].some((key) => !["default", "title", "active-agent-operations"].includes(key)) ||
          JSON.stringify(candidate.getMap("active-agent-operations").toJSON()) !== receipts)
        throw new Error("Editor cannot modify protected operation receipts");
      const content = prosemirrorText(yXmlFragmentToProsemirrorJSON(candidate.getXmlFragment("default")));
      const title = candidate.getText("title").toString();
      if (content.length > 200000 || title.length > 200 || parseContract({ content }) ||
          parseContract({ content: prosemirrorText(yXmlFragmentToProsemirrorJSON(document.getXmlFragment("default"))) }))
        throw new Error("Editor cannot modify protected contracts or exceed document limits");
    } finally { candidate.destroy(); }
    check(context, documentName);
  },
  async beforeHandleAwareness({ context, documentName, states }) {
    const current = check(context, documentName);
    if (current) for (const value of states.values()) if (value) value.user = {
      name: current.principal.name, principal_id: current.principal.id,
      kind: current.principal.kind, color: current.principal.kind === "agent" ? "#7956cf" : "#3370ff" };
  },
  async onRequest({ request, response, instance }) {
    if (!["/internal/replace", "/internal/read", "/internal/rebase", "/internal/compare-replace", "/internal/create-once"].includes(request.url) || request.method !== "POST") return;
    if (request.headers.authorization !== `Bearer ${deviceToken()}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      throw null;
    }
    const input = await readBody(request);
    const direct = await instance.openDirectConnection(`doc-${input.document_id}`, {
      source: "doc-free-agent",
    });
    if (request.url === "/internal/read") {
      const value = prosemirrorText(
        yXmlFragmentToProsemirrorJSON(direct.document.getXmlFragment("default")),
      );
      const result = { content: value, title: direct.document.getText("title").toString(),
        initialized: direct.document.getXmlFragment("default").length > 0,
        state_hash: stateHash(direct.document),
        operations: direct.document.getMap("active-agent-operations").toJSON() };
      await direct.disconnect({ unloadImmediately: false });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      throw null;
    }
    if (["/internal/compare-replace", "/internal/create-once", "/internal/replace"].includes(request.url)) {
      let result, status = 200;
      try {
        await direct.transact((document) => {
          result = commitDocumentOperation({ document, input, mode: request.url.slice("/internal/".length),
            read: (d) => ({ content: prosemirrorText(yXmlFragmentToProsemirrorJSON(d.getXmlFragment("default"))),
              title: d.getText("title").toString(), initialized: d.getXmlFragment("default").length > 0 }),
            replace: (d, content, nextTitle) => {
              const fragment = d.getXmlFragment("default"), title = d.getText("title");
              if (fragment.length) fragment.delete(0, fragment.length);
              prosemirrorJSONToYXmlFragment(schema, markdownDocument(content), fragment);
              if (title.length) title.delete(0, title.length);
              title.insert(0, nextTitle);
            }, persist: (candidate) => persistYdoc(`doc-${input.document_id}`, candidate) });
        });
        result.state_hash = stateHash(direct.document);
      } catch (error) {
        status = error.status || 503;
        result = { ok: false, code: error.code || "collaboration_unavailable" };
      } finally { await direct.disconnect({ unloadImmediately: false }); }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      throw null;
    }
    if (request.url === "/internal/rebase") {
      let mergedContent = "";
      let applied = [];
      await direct.transact((document) => {
        const fragment = document.getXmlFragment("default");
        const title = document.getText("title");
        const liveContent = prosemirrorText(yXmlFragmentToProsemirrorJSON(fragment)) || String(input.base || "");
        const patches = diffMatchPatch.patch_make(String(input.base || ""), String(input.content || ""));
        [mergedContent, applied] = diffMatchPatch.patch_apply(patches, liveContent);
        if (!applied.every(Boolean)) return;
        if (fragment.length) fragment.delete(0, fragment.length);
        prosemirrorJSONToYXmlFragment(schema, markdownDocument(mergedContent), fragment);
        if (typeof input.title === "string") {
          if (title.length) title.delete(0, title.length);
          title.insert(0, input.title);
        }
      });
      await direct.disconnect({ unloadImmediately: false });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: mergedContent, applied: applied.every(Boolean) }));
      throw null;
    }

  },
  async onLoadDocument({ documentName, document }) {
    const file = path.join(
      dataDir,
      encodeURIComponent(documentName) + ".bin",
    );
    if (fs.existsSync(file)) Y.applyUpdate(document, fs.readFileSync(file));
    // Yjs emits afterTransaction before its update/broadcast event. Persist
    // client edits here as well: seeing a peer's accepted change must not rely
    // on the default debounced onStore timer surviving a process crash.
    document.on("afterTransaction", (transaction) => {
      if (transaction.changed.size) persistYdoc(documentName, document);
    });
    // Wrap before Connection's constructor sends initial awareness. Every later
    // outbound packet checks the same in-process IM authority without a cache.
    const add = document.addConnection.bind(document);
    document.addConnection = (connection) => {
      check(connection.context, documentName);
      const send = connection.send.bind(connection);
      let denied = false;
      connection.send = (message) => {
        if (denied) return;
        try {
          if (persistenceFailure) throw persistenceFailure;
          check(connection.context, documentName);
        } catch {
          denied = true;
          const reason = persistenceFailure ? "collaboration_unavailable" : "document_access_revoked";
          // close() emits awareness and recursively calls send(). Suppress
          // both, and deliver only the explicit close control frame below.
          connection.close({ code: 4403, reason });
          const close = new OutgoingMessage(connection.messageAddress);
          close.writeCloseMessage(reason);
          send(close.toUint8Array());
          return;
        }
        send(message);
      };
      return add(connection);
    };
    return document;
  },
  async onStoreDocument({ documentName, document }) {
    persistYdoc(documentName, document);
  },
});
function persistYdoc(documentName, document) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, encodeURIComponent(documentName) + ".bin");
  if (persistenceFailure) throw persistenceFailure;
  try { durableWrite(file, Buffer.from(Y.encodeStateAsUpdate(document))); }
  catch (error) {
    // After an ambiguous rename/fsync failure, never let delayed onStore write
    // an older in-memory projection over the candidate receipt. Restart reloads
    // whichever whole durable version actually reached disk.
    persistenceFailure = error;
    setImmediate(() => process.exit(1));
    throw error;
  }
}

return server;
}
if (require.main === module) {
  const server = createCollabServer();
  server.listen();
  console.log(`Hocuspocus collaboration server on ws://localhost:${port}`);
}
module.exports = { createCollabServer };
