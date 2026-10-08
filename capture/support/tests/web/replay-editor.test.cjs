const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup() {
  const elements = {};
  const node = () => ({value: '', append() {}, replaceChildren() {}, setAttribute() {}});
  const context = vm.createContext({TextEncoder, TextDecoder, Uint8Array, btoa, atob,
    document: {getElementById: id => elements[id] ||= node(), createElement: node}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../web/replay-editor.js'), 'utf8'), context);
  return {fields: vm.runInContext('ReplayFields', context), editor: vm.runInContext('new ReplayEditor()', context), elements};
}
test('Query 保留重复字段、空字段、原始百分号编码；只编码修改行', () => {
  const {fields} = setup();
  const rows = fields.pairs('x=a+b&x=%2f&&flag&zero=');
  assert.equal(fields.encodePairs(rows), 'x=a+b&x=%2f&&flag&zero=');
  rows[1].value = '/two';
  assert.equal(fields.encodePairs(rows), 'x=a+b&x=%2Ftwo&&flag&zero=');
});
test('JSON 顺序调整不损坏重复键、大整数及嵌套正文', () => {
  const {fields} = setup();
  const rows = fields.jsonRows('{"z":9007199254740993123,"a":{"text":"x,y:[]"},"z":1e+9}');
  assert.equal(fields.encodeJson(rows), '{"z":9007199254740993123,"a":{"text":"x,y:[]"},"z":1e+9}');
  rows.reverse();
  assert.equal(fields.encodeJson(rows), '{"z":1e+9,"a":{"text":"x,y:[]"},"z":9007199254740993123}');
  rows[0].value = 'invalid';
  assert.throws(() => fields.encodeJson(rows));
});
test('切换原文、JSON 表格及正文格式，不修改就保留完整原始字节', () => {
  const {editor, elements} = setup();
  const raw = ' \n{ "z" : 1e+9, "a":9007199254740993123 }\n';
  const request = {headers: [['Content-Type', 'application/json']], body_b64: btoa(raw)};
  editor.open(request);
  editor.get('editMethod').value = 'POST'; elements.editUrl.value = 'https://example.test/?q=a+b';
  elements.editViewMode.value = 'table'; editor.switchMode();
  elements.editTablePart.value = 'body'; elements.editTablePart.onchange();
  assert.equal(editor.build().body_b64, request.body_b64);
  elements.editViewMode.value = 'raw'; editor.switchMode();
  elements.editBodyFormat.value = 'text'; elements.editBodyFormat.onchange();
  assert.equal(editor.build().body_b64, request.body_b64);
  elements.editBody.value = '{"updated":true}';
  elements.editBodyFormat.value = 'base64'; elements.editBodyFormat.onchange();
  assert.equal(atob(editor.build().body_b64), '{"updated":true}');
});
test('Query 排序同步回原文URL，跨区切换不会覆盖修改', () => {
  const {editor, elements} = setup();
  editor.open({headers: [], body_b64: ''});
  elements.editUrl.value = 'https://example.test/?x=a+b&x=%2f#part';
  elements.editViewMode.value = 'table'; editor.switchMode();
  elements.editTablePart.value = 'query'; elements.editTablePart.onchange();
  editor.rows.reverse(); editor.dirty = true;
  elements.editTablePart.value = 'headers'; elements.editTablePart.onchange();
  assert.equal(elements.editUrl.value, 'https://example.test/?x=%2f&x=a+b#part');
  assert.equal(elements.editUrl.readOnly, false);
});
test('不支持的正文切换失败后留在原参数区域', () => {
  const {editor, elements} = setup();
  editor.open({headers: [['Content-Encoding', 'gzip']], body_b64: btoa('binary')});
  elements.editViewMode.value = 'table'; editor.switchMode();
  elements.editTablePart.value = 'body'; elements.editTablePart.onchange();
  assert.equal(editor.part, 'headers');
  assert.match(elements.editTableNotice.textContent, /压缩正文/);
});
test('JSON 值无效时阻止切区，并保留尚未提交的修改', () => {
  const {editor, elements} = setup();
  editor.open({headers: [['Content-Type', 'application/json']], body_b64: btoa('{"key":1}')});
  elements.editViewMode.value = 'table'; editor.switchMode();
  elements.editTablePart.value = 'body'; elements.editTablePart.onchange();
  editor.rows[0].value = 'invalid'; editor.dirty = true;
  elements.editTablePart.value = 'headers'; elements.editTablePart.onchange();
  assert.equal(editor.part, 'body');
  assert.equal(editor.rows[0].value, 'invalid');
  assert.equal(editor.dirty, true);
});
