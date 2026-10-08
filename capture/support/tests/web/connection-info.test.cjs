const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function render(flow) {
  const node = () => ({children:[], textContent:'', append(...nodes) {this.children.push(...nodes);}, replaceChildren() {this.children=[];}});
  const context = vm.createContext({document:{createElement:node}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../web/connection-info.js'), 'utf8'), context);
  context.target=node(); context.flow=flow;
  vm.runInContext('renderConnectionInfo(target, flow)', context);
  const texts = n => [n.textContent, ...n.children.flatMap(texts)];
  return texts(context.target);
}
test('旧记录不会因 HTTPS URL 被推断成 HTTP/1.1 或 TLS1.3', () => {
  const texts=render({url:'https://example.test', source:'capture'});
  assert.equal(texts.filter(t=>t==='未知').length, 22);
  assert.ok(!texts.includes('HTTP/1.1'));
  assert.ok(!texts.includes('TLSv1.3'));
});
test('两端不同协议各自显示，重放注明没有原客户端连接', () => {
  const texts=render({source:'capture', transport:{client:{http_version:'HTTP/2.0'}, upstream:{http_version:'HTTP/1.1', tcp_connect_ms:12}}});
  assert.ok(texts.includes('HTTP/2.0'));
  assert.ok(texts.includes('HTTP/1.1'));
  assert.ok(texts.includes('12 ms'));
  assert.match(render({source:'replay', replay_transport:{original_http_version:'HTTP/2.0', actual_http_version:'HTTP/1.1'}}).join('\n'), /没有手机／浏览器入站连接/);
});
