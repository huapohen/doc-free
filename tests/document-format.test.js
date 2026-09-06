"use strict";
const {test}=require("node:test");const assert=require("node:assert/strict");
const {markdownDocument,prosemirrorText}=require("../document-format");
const {parseContract,contractDocument}=require("../work-protocol");
test("rich headings, emphasis, lists, safe links, quotes and fenced code remain readable to native agents",()=>{
  const source="# Shared\n\n**Bold** and *italic* and ~~old~~ [link](https://example.com)\n\n- one\n- two\n\n> quotation\n\n```js\nconst a = 1;\n```";
  const parsed=markdownDocument(source);assert.equal(prosemirrorText(parsed),source);
  assert.ok(parsed.content.some(n=>n.type==="bulletList"));
  assert.deepEqual(parsed.content.find(n=>n.type==="paragraph"&&n.content)?.content[0].marks,[{type:"bold"}]);
});
test("legacy line based Y documents keep exactly the same canonical projection",()=>{
  const legacy={type:"doc",content:[{type:"heading",attrs:{level:2},content:[{type:"text",text:"Goal"}]},{type:"paragraph"},{type:"paragraph",content:[{type:"text",text:"Should be fast."}]}]};
  assert.equal(prosemirrorText(legacy),"## Goal\n\nShould be fast.");
});
test("contract code fences survive rich conversion and source HTML/media never become active nodes",()=>{
  const contract={kind:"mission",objective:"visible",source_document_id:"d",status:"active",quiet_seconds:8};
  const content=contractDocument("Work",contract,"## Details\n\nVisible.");
  assert.deepEqual(parseContract({content:prosemirrorText(markdownDocument(content))}),parseContract({content}));
  const parsed=JSON.stringify(markdownDocument('<script>alert(1)</script>\n\n![image](https://example.com/track) [bad](javascript:alert(1))'));
  assert.ok(!parsed.includes('"type":"image"'));assert.ok(!parsed.includes('"type":"link"'));assert.ok(parsed.includes('script'));
});
