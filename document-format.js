"use strict";
const { marked } = require("marked");
const plain = (text, marks = []) => text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : [];
function inline(tokens, marks = []) {
  return (tokens || []).flatMap((token) => {
    const mark = { strong: "bold", em: "italic", del: "strike", codespan: "code" }[token.type];
    if (mark) return token.tokens ? inline(token.tokens, [...marks, { type: mark }]) : plain(token.text, [...marks, { type: mark }]);
    if (token.type === "br") return [{ type: "hardBreak" }];
    if (token.type === "link" && /^(https?:\/\/|mailto:)/i.test(token.href))
      return inline(token.tokens, [...marks, { type: "link", attrs: { href: token.href, target: "_blank", rel: "noopener noreferrer" } }]);
    // HTML, unsupported embeds and images stay literal. Opening a document does
    // not execute source HTML or silently fetch remote media.
    if (["html", "image", "link"].includes(token.type)) return plain(token.raw, marks);
    return token.tokens ? inline(token.tokens, marks) : plain(token.text ?? token.raw ?? "", marks);
  });
}
function blocks(tokens) {
  return tokens.flatMap((token) => {
    if (["space", "def"].includes(token.type)) return [];
    if (token.type === "heading") return [{ type: "heading", attrs: { level: token.depth }, content: inline(token.tokens) }];
    if (token.type === "code") return [{ type: "codeBlock", attrs: { language: token.lang || null }, content: plain(token.text) }];
    if (token.type === "hr") return [{ type: "horizontalRule" }];
    if (token.type === "blockquote") return [{ type: "blockquote", content: blocks(token.tokens) }];
    if (token.type === "list") return [{ type: token.ordered ? "orderedList" : "bulletList",
      ...(token.ordered ? { attrs: { start: token.start || 1 } } : {}),
      content: token.items.map((item) => ({ type: "listItem", content: blocks(item.tokens) })) }];
    return [{ type: "paragraph", content: inline(token.tokens || marked.lexer(token.text ?? token.raw ?? "", { gfm: true, breaks: false })[0]?.tokens || [{type:"text",text:token.text ?? token.raw ?? ""}]) }];
  });
}
function markdownDocument(markdown) {
  const content = blocks(marked.lexer(String(markdown || ""), { gfm: true, breaks: false }));
  return { type: "doc", content: content.length ? content.flatMap((block, i) => i ? [{ type: "paragraph" }, block] : [block]) : [{ type: "paragraph" }] };
}
function prosemirrorText(node) {
  if (!node) return "";
  if (node.type === "text") {
    let text = node.text || "";
    for (const mark of node.marks || []) {
      if (mark.type === "bold") text = `**${text}**`;
      if (mark.type === "italic") text = `*${text}*`;
      if (mark.type === "strike") text = `~~${text}~~`;
      if (mark.type === "code") { const fence = "`".repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map(m=>m[0].length+1))); text = `${fence}${text}${fence}`; }
      if (mark.type === "link" && /^(https?:\/\/|mailto:)/i.test(mark.attrs?.href || "")) text = `[${text}](${mark.attrs.href})`;
    }
    return text;
  }
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "horizontalRule") return "---";
  if (node.type === "codeBlock") {
    const content = (node.content || []).map(x=>x.text || "").join("");
    const fence = "`".repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(m=>m[0].length+1)));
    return `${fence}${node.attrs?.language || ""}\n${content}\n${fence}`;
  }
  const children = (node.content || []).map(prosemirrorText);
  if (node.type === "doc") return children.join("\n");
  if (node.type === "heading") return "#".repeat(node.attrs?.level || 1) + " " + children.join("");
  if (node.type === "blockquote") return children.join("\n\n").split("\n").map(line=>"> "+line).join("\n");
  if (["bulletList", "orderedList"].includes(node.type)) return children.map((text,i)=>{
    const prefix = node.type === "orderedList" ? `${(node.attrs?.start || 1)+i}. ` : "- ";
    return prefix+text.split("\n").join("\n"+" ".repeat(prefix.length));
  }).join("\n");
  if (node.type === "listItem") return children.join("\n");
  return children.join("");
}
module.exports = { markdownDocument, prosemirrorText };
