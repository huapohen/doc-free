import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
const $ = (id) => document.getElementById(id);
let access, editor, provider, ydoc, timer, refreshTimer, stopped = false;
function fail(message) { $("error").textContent = message; $("error").hidden = false; }
async function api(path = "", method = "GET", body) {
  const response = await fetch("/api/office-document" + path, {method,headers:{"content-type":"application/json",...(access ? {authorization:"Bearer "+access} : {})},body:body===undefined?undefined:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) {const error = new Error(result.error?.message || "文档连接失败"); error.status = response.status; throw error;}
  return result;
}
function stop(message) {
  stopped = true; clearInterval(timer);clearTimeout(refreshTimer);provider?.destroy();editor?.setEditable(false);
  $("document-title").disabled = true;$("status").textContent = message;
}
function outline() {
  const entries = [];
  document.querySelectorAll(".tiptap h1,.tiptap h2,.tiptap h3").forEach((heading,i)=>{
    heading.id="heading-"+i;const link=document.createElement("a");link.href="#heading-"+i;link.textContent=heading.textContent;
    link.style.paddingLeft=heading.tagName==="H1"?"0":"12px";entries.push(link);
  });$("outline").replaceChildren(...entries);
  $("characters").textContent=(editor?.getText().length || 0).toLocaleString()+" 字符";
}
async function refresh() {
  if (stopped) return;
  try {
    const {document:d}=await api();
    $("revision").textContent="共同版本 r"+d.revision;
    $("date").textContent="更新于 "+new Date(d.updated_at).toLocaleString("zh-CN");
  } catch(error) {
    if ([401,403].includes(error.status)) {stop("编辑权限已失效");fail(error.message);}
    else $("status").textContent="连接暂不可用，正在重试";
  }
}
async function boot() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("open");
  history.replaceState(null,"",location.pathname);
  if (!ticket) throw new Error("请从人机的文档窗口点击“协作编辑器”打开。这个入口只授权当前文档。");
  const session = await api("/session","POST",{ticket}); access=session.access_token;
  const {document:selected}=await api();
  $("identity").textContent=session.principal.name+(session.principal.kind==="agent"?" · Agent":"");
  $("document-title").value=selected.title;
  ydoc=new Y.Doc();const title=ydoc.getText("title");
  provider = new HocuspocusProvider({url:`${location.protocol==="https:"?"wss":"ws"}://${location.host}/collab`,
    name:`doc-${selected.id}`,token:access,document:ydoc,
    onStatus:({status})=> {if(!stopped) $("status").textContent=({connected:"实时协作已连接",connecting:"正在连接",disconnected:"连接中断，等待重连"})[status] || status;},
    onAuthenticationFailed:()=>{stop("编辑会话已过期");fail("请从人机重新打开文档；原有内容保留在共享文档中。");},
    onSynced:({state:ready})=>{if(ready&&!stopped){editor?.setEditable(true);$("document-title").disabled=false;$("export").disabled=false;$("toolbar").hidden=false;outline();}},
  });
  const user={name:session.principal.name,principal_id:session.principal.id,kind:session.principal.kind,color:session.principal.kind==="agent"?"#7956cf":"#3370ff"};
  editor=new Editor({element:$("editor"),editable:false,extensions:[StarterKit.configure({undoRedo:false}),Collaboration.configure({document:ydoc}),CollaborationCaret.configure({provider,user})],
    editorProps:{attributes:{"aria-label":"协作文档正文",role:"textbox","aria-multiline":"true"}},
    onUpdate:()=>{outline();clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,800);},
  });
  title.observe(()=>{if(document.activeElement!==$("document-title"))$("document-title").value=title.toString();clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,800);});
  $("document-title").addEventListener("input",()=>{ydoc.transact(()=>{title.delete(0,title.length);title.insert(0,$("document-title").value);});});
  provider.on("awarenessUpdate",({states})=>{$("presence").textContent=[...new Set(states.map(s=>s.user?.name).filter(Boolean))].join("、")+" 正在协作";});
  $("toolbar").addEventListener("click",(event)=>{
    const command=event.target.closest("button")?.dataset.command;if(!command || stopped)return;const chain=editor.chain().focus();
    const operations={paragraph:()=>chain.setParagraph(),heading1:()=>chain.toggleHeading({level:1}),heading2:()=>chain.toggleHeading({level:2}),bold:()=>chain.toggleBold(),italic:()=>chain.toggleItalic(),strike:()=>chain.toggleStrike(),bullet:()=>chain.toggleBulletList(),ordered:()=>chain.toggleOrderedList(),quote:()=>chain.toggleBlockquote(),code:()=>chain.toggleCodeBlock(),rule:()=>chain.setHorizontalRule(),undo:()=>chain.undo(),redo:()=>chain.redo()};operations[command]?.().run();
  });
  $("export").addEventListener("click",async()=>{try{const {document:current}=await api();const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([current.content],{type:"text/markdown;charset=utf-8"}));link.download=current.title.replace(/[\\/:*?"<>|]/g,"_")+".md";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}catch(e){fail(e.message);}});
  $("close-session").addEventListener("click",async()=>{await api("/session","DELETE").catch(()=>{});access="";stop("编辑会话已结束");});
  timer=setInterval(refresh,4000);await refresh();
}
boot().catch(error=>{stop("文档未打开");fail(error.message);});
addEventListener("pagehide",()=>{provider?.destroy();editor?.destroy();ydoc?.destroy();clearInterval(timer);});
