const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../web/app.js'), 'utf8');

test('切换会话取消旧目录刷新后，新会话仍能安排刷新', () => {
  const state = { selected: new Set(), directoryOpen: new Set(), directoryTimer: 42 };
  const elements = { directoryTree: { replaceChildren() {} }, directoryFilter: {}, search: {} };
  let canceled, scheduled = 0;
  const context = vm.createContext({
    state, sessionFilters: new Map(), restoreFilters() {}, $: id => elements[id], clearTimeout: id => { canceled = id; },
    setTimeout: () => { scheduled++; return 43; },
    renderDetail() {}, renderSelection() {}, action: callback => callback,
  });
  const switchSource = source.slice(source.indexOf('function switchSession('), source.indexOf('const filterFields'));
  const scheduleSource = source.slice(source.indexOf('function scheduleDirectories('), source.indexOf('/** 域名和路径'));
  vm.runInContext(switchSource + '\n' + scheduleSource, context);
  vm.runInContext('switchSession("new-session"); scheduleDirectories(); scheduleDirectories();', context);
  assert.equal(canceled, 42);
  assert.equal(scheduled, 1);
  assert.equal(state.directoryTimer, 43);
});
