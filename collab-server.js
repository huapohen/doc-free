const { Server } = require("@hocuspocus/server");
const fs = require("fs");
const path = require("path");
const Y = require("yjs");
const { getSchema } = require("@tiptap/core");
const StarterKit = require("@tiptap/starter-kit").default;
const DiffMatchPatch = require("diff-match-patch");
const {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} = require("@tiptap/y-tiptap");
const port = Number(process.env.COLLAB_PORT || 1234);
const schema = getSchema([StarterKit]);
const diffMatchPatch = new DiffMatchPatch();

function deviceToken() {
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

function markdownDocument(markdown) {
  const content = [];
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const heading = rawLine.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: heading[2] ? [{ type: "text", text: heading[2] }] : undefined,
      });
    } else if (rawLine) {
      content.push({ type: "paragraph", content: [{ type: "text", text: rawLine }] });
    } else {
      content.push({ type: "paragraph" });
    }
  }
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function prosemirrorText(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  const children = (node.content || []).map(prosemirrorText);
  if (node.type === "doc") return children.join("\n");
  if (["paragraph", "heading", "blockquote", "codeBlock", "listItem"].includes(node.type))
    return children.join("");
  return children.join(node.type === "hardBreak" ? "\n" : "");
}

const server = new Server({
  port,
  async onAuthenticate({ token }) {
    if (token !== deviceToken()) throw new Error("Invalid Doc Free token");
  },
  async onRequest({ request, response, instance }) {
    if (!["/internal/replace", "/internal/read", "/internal/rebase"].includes(request.url) || request.method !== "POST") return;
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
      await direct.disconnect({ unloadImmediately: false });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: value }));
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
    await direct.transact((document) => {
      const fragment = document.getXmlFragment("default");
      const title = document.getText("title");
      if (fragment.length) fragment.delete(0, fragment.length);
      prosemirrorJSONToYXmlFragment(schema, markdownDocument(input.content), fragment);
      if (typeof input.title === "string") {
        if (title.length) title.delete(0, title.length);
        title.insert(0, input.title);
      }
    });
    await direct.disconnect({ unloadImmediately: false });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    throw null;
  },
  async onLoadDocument({ documentName, document }) {
    const file = path.join(
      __dirname,
      "yjs-data",
      encodeURIComponent(documentName) + ".bin",
    );
    if (fs.existsSync(file)) Y.applyUpdate(document, fs.readFileSync(file));
    return document;
  },
  async onStoreDocument({ documentName, document }) {
    fs.mkdirSync(path.join(__dirname, "yjs-data"), { recursive: true });
    fs.writeFileSync(
      path.join(
        __dirname,
        "yjs-data",
        encodeURIComponent(documentName) + ".bin",
      ),
      Buffer.from(Y.encodeStateAsUpdate(document)),
    );
  },
});
server.listen();
console.log(`Hocuspocus collaboration server on ws://localhost:${port}`);
