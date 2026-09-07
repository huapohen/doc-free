"use strict";

const { problem } = require("./work-protocol");
const STYLES = ["bold", "italic", "underline", "strikethrough"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const boundary = (text, at) => at === 0 || at === text.length ||
  !(text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff &&
    text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff);

// Offsets use UTF-16, shared by JavaScript and Dart. The plain content remains
// authoritative for search, accessibility, tools and clients without styling.
function normalizeRichText(value, content) {
  if (value === undefined || value === null) return undefined;
  const fail = () => { throw problem(422, "invalid_rich_text", "消息格式需要有效的 UTF-16 范围及受支持的文字样式"); };
  if (typeof content !== "string" || !object(value) || value.version !== 1 ||
      Object.keys(value).some(key => !["version", "spans"].includes(key)) ||
      !Array.isArray(value.spans) || value.spans.length > 200) fail();
  const seen = new Set(), spans = [];
  for (const span of value.spans) {
    if (!object(span) || Object.keys(span).some(key => !["start", "end", "styles"].includes(key)) ||
        !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
        span.start < 0 || span.start >= span.end || span.end > content.length ||
        !boundary(content, span.start) || !boundary(content, span.end) ||
        !Array.isArray(span.styles) || span.styles.length < 1 || span.styles.length > 4 ||
        span.styles.some(style => !STYLES.includes(style))) fail();
    const next = {start: span.start, end: span.end, styles: STYLES.filter(style => span.styles.includes(style))};
    const key = JSON.stringify(next);
    if (!seen.has(key)) { seen.add(key); spans.push(next); }
  }
  spans.sort((a,b) => a.start-b.start || a.end-b.end || a.styles.join().localeCompare(b.styles.join()));
  return spans.length ? {version:1, spans} : undefined;
}

const richTextSchema = {
  type: ["object", "null"], additionalProperties: false,
  properties: {version: {const:1}, spans: {type:"array", maxItems:200, items: {
    type:"object", additionalProperties:false,
    properties:{start:{type:"integer",minimum:0},end:{type:"integer",minimum:1},
      styles:{type:"array",minItems:1,maxItems:4,items:{type:"string",enum:STYLES}}},
    required:["start","end","styles"]}}}, required:["version","spans"]
};
module.exports = {normalizeRichText, richTextSchema};
