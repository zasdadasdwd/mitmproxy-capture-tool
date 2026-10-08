const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../web/app.js'), 'utf8');

test('删除末页后回到最后有效页，不残留空白列表', async () => {
  const state = {session:'session', refreshSequence:0, offset:400, rows:[], total:401};
  const queries = [];
  const context = vm.createContext({
    state, PAGE_SIZE:200, filterParams: () => new URLSearchParams(),
    json: async url => {queries.push(url); return {total:201, items:[{id:'remaining'}]};},
    renderRows() {}, scheduleDirectories() {},
  });
  const start = source.indexOf('async function refreshFlows()');
  const end = source.indexOf('/** 使用 DOM 文本节点', start);
  vm.runInContext(source.slice(start, end), context);
  await vm.runInContext('refreshFlows()', context);
  assert.equal(state.offset, 200);
  assert.equal(state.rows[0].id, 'remaining');
  assert.equal(queries.length, 2);
  assert.match(queries[1], /offset=200/);
});

test('旧后端未确认 URL 修改时，不展示错误目标的代码', async () => {
  let displayed = false;
  const context = vm.createContext({
    api: async () => ({headers:{get:() => null}, text:async () => 'old target'}),
    $: () => {displayed = true; return {};},
  });
  const start = source.indexOf('async function exportDetail(');
  const end = source.indexOf('\nfor (const prefix', start);
  vm.runInContext(source.slice(start, end), context);
  await assert.rejects(vm.runInContext('exportDetail("session", "flow", "curl", "https://new.example/")', context), /重启后端/);
  assert.equal(displayed, false);
});

test('根路径和 CONNECT 显示 host，接口路径与 Query 保留',()=>{
  const ctx=vm.createContext({URL});
  const start=source.indexOf('function requestAddress(flow)');
  const end=source.indexOf('function renderRows()',start);
  vm.runInContext(source.slice(start,end),ctx);
  const address=flow=>{ctx.flow=flow;return vm.runInContext('requestAddress(flow)',ctx);};
  assert.equal(address({url:'https://example.test/',method:'HEAD'}),'example.test');
  assert.equal(address({url:'https://example.test:8443/api?q=1',method:'GET'}),'/api?q=1');
  assert.equal(address({url:'example.test:443',host:'example.test',method:'CONNECT'}),'example.test');
});

test('实时列表未变化时不重建表格，切换查询仍渲染空结果',async()=>{
  const state={session:'s',refreshSequence:0,offset:0,rows:[],total:0};
  let renders=0;
  const ctx=vm.createContext({state,PAGE_SIZE:200,URLSearchParams,filterParams:()=>new URLSearchParams(),json:async()=>({items:[],total:0}),renderRows(){renders++;},scheduleDirectories(){}});
  vm.runInContext(source.slice(source.indexOf('async function refreshFlows()'),source.indexOf('/** 使用 DOM 文本节点')),ctx);
  await vm.runInContext('refreshFlows()',ctx);assert.equal(renders,1);
  await vm.runInContext('refreshFlows()',ctx);assert.equal(renders,1);
  state.session='new';await vm.runInContext('refreshFlows()',ctx);assert.equal(renders,2);
});

test('抓包期间可删除选中和清空，整批删除仍需停止',()=>{
  const elements=Object.fromEntries(['deleteSelected','clearSession','deleteSession','selectionCount','toolbarSelectionCount','actionCount','selectPage','repeat','export','editRepeat','compareSelected'].map(id=>[id,{}]));
  const state={session:'live',status:{session_id:'live'},selected:new Set(['one']),rows:[]};
  const ctx=vm.createContext({state,$:id=>elements[id]});
  vm.runInContext(source.slice(source.indexOf('function renderSelection()'),source.indexOf('/** 删除后清理详情')),ctx);
  vm.runInContext('renderSelection()',ctx);
  assert.equal(elements.deleteSelected.disabled,false);assert.equal(elements.clearSession.disabled,false);assert.equal(elements.deleteSession.disabled,true);
});

test('详情加载期间摘要已更新，不把旧详情标成新版本',async()=>{
  let resolve;
  const state={session:'s',activeId:'one',rows:[{id:'one',status:'pending'}]};
  const ctx=vm.createContext({state,json:()=>new Promise(done=>{resolve=done;}),renderDetail(){},requestViewer:{refresh:async()=>{}}});
  vm.runInContext(source.slice(source.indexOf('async function loadDetail(id)'),source.indexOf('/** 未选中请求时不占用')),ctx);
  const task=vm.runInContext('loadDetail("one")',ctx);
  state.rows=[{id:'one',status:'complete'}];resolve({status:'pending'});await task;
  assert.equal(JSON.parse(state.detailVersion).status,'pending');
});
