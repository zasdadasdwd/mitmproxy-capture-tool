const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../web/body-events.js'), 'utf8'), ctx);
const parse = text => JSON.parse(vm.runInContext('JSON.stringify(parseSseEvents('+JSON.stringify(text)+'))',ctx));
test('SSE 仅分派空行结束的事件，未完成行不出现',()=>{
  assert.deepEqual(parse('data: x\n'), []);
  assert.deepEqual(parse('data: x'), []);
  assert.deepEqual(parse('data: x\n\n'), [{event:'message',id:'',data:'x'}]);
});
test('SSE 多行、CRLF、心跳和 ID 重置',()=>{
  assert.deepEqual(parse(': heartbeat\r\nid: 7\r\nevent: update\r\ndata: a\r\ndata: b\r\n\r\nid:\r\ndata: c\r\n\r\n'),[
    {event:'update',id:'7',data:'a\nb'}, {event:'message',id:'',data:'c'}
  ]);
});
test('SSE 事件数有界',()=>assert.equal(parse('data: x\n\n'.repeat(600)).length,500));
test('当前请求落盘更新即使大小不变也刷新详情，其他请求不清理详情版本',()=>{
  const app = fs.readFileSync(path.resolve(__dirname, '../../../web/app.js'),'utf8');
  const code = app.slice(app.indexOf('function scheduleRefresh('),app.indexOf('function queueRefresh('));
  const scope = vm.createContext({state:{session:'s',activeId:'a',detailVersion:'old'},dirty:{},queueRefresh(){}});
  vm.runInContext(code, scope);
  scope.event={type:'flows',session_id:'s',flow_id:'b'};
  vm.runInContext('scheduleRefresh(event)', scope);
  assert.equal(scope.state.detailVersion, 'old');
  scope.event.flow_id='a';
  vm.runInContext('scheduleRefresh(event)', scope);
  assert.equal(scope.state.detailVersion, null);
});
