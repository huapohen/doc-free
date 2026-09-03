import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";

let activeId, editor, provider, ydoc, ytitle;
const mount = document.querySelector("#content");
const titleInput = document.querySelector("#title");
const colors = ["#6d5dfc", "#e05d8b", "#168a72", "#d97818", "#3976d8"];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function markdownToHtml(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) return `<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`;
      return line ? `<p>${escapeHtml(line)}</p>` : "<p></p>";
    })
    .join("");
}

function status(value) {
  dispatchEvent(new CustomEvent("docfree:sync", { detail: value }));
}

function openDocument(selected) {
  if (!selected || selected.id === activeId) return;
  activeId = selected.id;
  editor?.destroy();
  provider?.destroy();
  mount.innerHTML = "";
  ydoc = new Y.Doc();
  ytitle = ydoc.getText("title");
  provider = new HocuspocusProvider({
    url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/collab`,
    name: `doc-${activeId}`,
    token: localStorage.docFreeToken,
    document: ydoc,
  });
  const name = localStorage.docFreeUserName || "访客";
  const color = colors[Math.abs([...name].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % colors.length];
  provider.setAwarenessField("user", { name, color });
  provider.on("status", ({ status: state }) => status(state));
  editor = new Editor({
    element: mount,
    extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: ydoc })],
  });
  provider.on("synced", () => {
    if (editor.isEmpty && selected.content) editor.commands.setContent(markdownToHtml(selected.content));
    if (!ytitle.length && selected.title) ytitle.insert(0, selected.title);
    status("connected");
  });
  ytitle.observe(() => {
    if (titleInput.value !== ytitle.toString()) {
      titleInput.value = ytitle.toString();
      document.querySelector("#topTitle").textContent = ytitle.toString();
      dispatchEvent(new CustomEvent("docfree:title", { detail: ytitle.toString() }));
    }
  });
  editor.on("update", () => {
    mount.dataset.synced = "true";
    mount._tiptapText = editor.getText({ blockSeparator: "\n" });
  });
  window.docFreeEditor = {
    getText: () => editor?.getText({ blockSeparator: "\n" }) || "",
    getTitle: () => ytitle?.toString() || titleInput.value,
    getJSON: () => editor?.getJSON(),
  };
}

titleInput.addEventListener("input", () => {
  if (!ytitle || titleInput.value === ytitle.toString()) return;
  ydoc.transact(() => {
    if (ytitle.length) ytitle.delete(0, ytitle.length);
    ytitle.insert(0, titleInput.value);
  });
  document.querySelector("#topTitle").textContent = titleInput.value;
});

addEventListener("docfree:open", (event) => openDocument(event.detail));
if (window.docFreeCurrent) openDocument(window.docFreeCurrent);
