const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../web/app.js'), 'utf8');
const helpers = source.slice(source.indexOf('const REPLAY_VIEW'), source.indexOf('/** 主题按钮'));
test('聚合选择按真实批次分组，单条操作解析真实来源', () => {
  const state = {session: '__replays__', activeId: 'a', selected: new Set(['a', 'b', 'c']), flowSessions: new Map([['a','one'], ['b','two'], ['c','one']])};
  const ctx = vm.createContext({state}); vm.runInContext(helpers, ctx);
  assert.equal(vm.runInContext('flowSession()', ctx), 'one');
  assert.deepEqual(Array.from(vm.runInContext('selectedGroups()', ctx), ([session, ids]) => [session, Array.from(ids)]), [['one',['a','c']],['two',['b']]]);
});
test('进入全部重放时清除视图筛选并保留定位参数', async () => {
  const state = {}, events = [], menu = {open: true}, anchor = {source_session: 'capture', source_id: 'original'};
  const ctx = vm.createContext({state, anchor, $: () => menu, switchSession: id => events.push(id), restoreFilters: value => events.push(value), renderRows(){}, refreshSessions: async () => events.push('sessions'), refreshFlows: async () => events.push('flows')});
  vm.runInContext(helpers, ctx); await vm.runInContext('openReplayList(anchor)', ctx);
  assert.equal(menu.open, false); assert.equal(state.replayAnchor, anchor);
  assert.deepEqual(events, ['__replays__', null, 'sessions', 'flows']);
});
test('定位跨页重放后仍展示全部匹配结果，并自动打开详情', async () => {
  const state = {session:'__replays__', refreshSequence:0, offset:0, rows:[], total:0, selected:new Set(), replayAnchor:{source_id:'original'}, flowSessions:new Map(), rowElements:new Map()};
  let loaded, scrolled = false;
  state.rowElements.set('target', {scrollIntoView(){scrolled = true;}});
  const queries = [];
  const ctx = vm.createContext({state, PAGE_SIZE:200, URLSearchParams, filterParams:()=>new URLSearchParams(), json:async url => {queries.push(url); return queries.length === 1 ? {items:[],total:450,anchor_offset:250,anchor_id:'target',anchor_session_id:'batch'} : {items:[{id:'other',session_id:'second'}, {id:'target',session_id:'batch'}],total:450};}, renderRows(){}, scheduleDirectories(){}, loadDetail:async id => {loaded = id;}});
  vm.runInContext(source.slice(source.indexOf('async function refreshFlows()'), source.indexOf('/** 使用 DOM 文本节点')), ctx);
  await vm.runInContext('refreshFlows()', ctx);
  assert.equal(state.offset,200); assert.equal(state.total,450); assert.equal(state.rows.length,2);
  assert.equal(loaded,'target'); assert.equal(scrolled,true); assert.match(queries[1],/offset=200/);
});
