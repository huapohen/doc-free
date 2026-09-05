import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";

let editor, provider, ydoc, activeId, ytitle, titleListener;
function close() {
  editor?.destroy();
  provider?.destroy();
  ydoc?.destroy();
  document
    .getElementById("document-title")
    .removeEventListener("input", titleListener);
  activeId = null;
}
window.activeWorkspaceEditor = {
  close,
  open({ document: selected, token, name, onChange, onStatus, onPresence }) {
    if (activeId === selected.id) return;
    close();
    activeId = selected.id;
    ydoc = new Y.Doc();
    ytitle = ydoc.getText("title");
    const mount = document.getElementById("editor");
    mount.innerHTML = "";
    provider = new HocuspocusProvider({
      url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/collab`,
      name: `doc-${selected.id}`,
      token,
      document: ydoc,
      onStatus: ({ status }) => onStatus(status),
      onAuthenticationFailed: () => onStatus("unauthorized"),
    });
    provider.setAwarenessField("user", { name, color: "#397754" });
    provider.on("awarenessUpdate", ({ states }) =>
      onPresence(states.map((s) => s.user?.name).filter(Boolean)),
    );
    editor = new Editor({
      element: mount,
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: ydoc }),
      ],
      onUpdate: () => onChange(),
      editorProps: {
        attributes: {
          "aria-label": "协作文档正文",
          role: "textbox",
          "aria-multiline": "true",
        },
      },
    });
    const title = document.getElementById("document-title");
    ytitle.observe(() => {
      title.value = ytitle.toString();
      onChange();
    });
    titleListener = () => {
      ydoc.transact(() => {
        ytitle.delete(0, ytitle.length);
        ytitle.insert(0, title.value);
      });
    };
    title.addEventListener("input", titleListener);
  },
};
dispatchEvent(new Event("workspace-editor-ready"));
