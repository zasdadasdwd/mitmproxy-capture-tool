/** 运行：node --test capture/support/tests/web/request-viewer.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../../web/request-viewer.js'), 'utf8');
const context = vm.createContext({ URL, URLSearchParams, window: { location: { href: 'http://localhost/' } } });
vm.runInContext(source.slice(0, source.indexOf('const requestViewer =')), context);
const body = (text, type = '') => JSON.parse(context.decodeRequestBody({
  body_text: text, headers: [['Content-Type', type]],
}).readable);
const query = (text) => JSON.parse(context.parseQueryParameters(`https://test.invalid/?${text}`).json);

test('JSON 内的 URL 不应变成表单，字符串类型保持不变', () => {
  assert.deepEqual(body('{"url":"https://x/?a=1&b=2","id":"123","flag":"true","none":"null"}'), {
    url: 'https://x/?a=1&b=2', id: '123', flag: 'true', none: 'null',
  });
});
test('嵌套正文保留原生 JSON 类型和原本的百分号字符串', () => {
  const nested = { transParam: JSON.stringify({ id: '123', enabled: true, url: '/a%20b' }) };
  assert.deepEqual(body(`body=${encodeURIComponent(JSON.stringify(nested))}`), {
    body: { transParam: { id: '123', enabled: true, url: '/a%20b' } },
  });
});
test('Query 中等号、签名及普通字符串不解析成表单', () => {
  assert.deepEqual(query('signature=abc%3Dxyz%3D&num=23&flag=true&none=null'), {
    signature: 'abc=xyz=', num: '23', flag: 'true', none: 'null',
  });
});
test('额外 URL 解码层保留第一层已解出的字面加号', () => {
  assert.deepEqual(body('value=%2B%2520'), { value: '+ ' });
  assert.deepEqual(query('value=%2B%2520'), { value: '+ ' });
});
test('重复参数中 JSON 数组仍保持独立值及出现顺序', () => {
  assert.deepEqual(body('item=%5B1%2C2%5D&item=3&item=%5B4%5D'), { item: [[1, 2], '3', [4]] });
  assert.deepEqual(query('item=%5B1%2C2%5D&item=3'), { item: [[1, 2], '3'] });
});
test('只包含 + 的编码表单也可以切换解码视图', () => {
  const result = context.decodeRequestBody({ body_text: 'name=hello+world' });
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.readable), { name: 'hello world' });
});
test('多层编码 JSON 与嵌套 JSON 字符串能够展开', () => {
  const value = { channel: '', id: '123' };
  assert.deepEqual(query(`filter=${encodeURIComponent(encodeURIComponent(JSON.stringify(value)))}`), { filter: value });
  assert.deepEqual(body(encodeURIComponent(JSON.stringify(value))), value);
});
test('非法转义和重复空参数不会丢失', () => {
  assert.deepEqual(query('value=%ZZ&value=&__proto__=safe'), JSON.parse('{"value":["%ZZ",""],"__proto__":"safe"}'));
});
test('JSON 内容类型的无效正文不会被伪装成有效表单 JSON', () => {
  assert.equal(context.decodeRequestBody({ body_text: 'x=1', headers: [['content-type', 'application/json']] }).validJson, false);
});
test('树视图无需提前格式化整个正文', () => {
  const result = context.decodeRequestBody({ body_text: '{"x":1}' });
  assert.equal(typeof Object.getOwnPropertyDescriptor(result, 'readable').get, 'function');
});
test('完整弹窗清理 Query 文本和按钮，失败加载不残留旧数据', () => {
  const elements = Object.fromEntries(['viewerQueryJson', 'viewerQueryToggle', 'viewerQueryCopy'].map((id) => [id, { hidden: false, textContent: 'old-token' }]));
  context.document = { getElementById: (id) => elements[id] };
  context.elements = elements;
  vm.runInContext('RequestViewer.prototype.resetQuery.call({queryExpanded: true, queryJson: "old-token"})', context);
  assert.equal(elements.viewerQueryJson.textContent, '');
  for (const element of Object.values(elements)) assert.equal(element.hidden, true);
});
