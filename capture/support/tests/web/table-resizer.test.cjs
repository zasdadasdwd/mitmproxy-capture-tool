const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('保存过列宽的请求列表在详情收起后恢复宽度和原比例', () => {
  let resize;
  const columns = [];
  const group = {children:columns, replaceChildren(...nodes) { columns.splice(0, columns.length, ...nodes); }};
  const cells = [100, 200, 300].map(width => ({
    getBoundingClientRect: () => ({width}), classList: {add() {}}, append() {},
  }));
  const table = {
    dataset: {}, style: {}, isConnected: true, parentElement: {}, classList: {add() {}},
    closest: selector => selector === '.flow-list' ? {} : null,
    querySelector: selector => selector === 'tr' ? {cells} : group,
    getBoundingClientRect: () => ({width:600}),
  };
  const context = vm.createContext({
    localStorage: {getItem: () => '[100,200,300]'},
    document: {querySelectorAll: () => [table], body: {}, createElement: () => ({style: {}, setAttribute() {}, addEventListener() {}})},
    ResizeObserver: class {constructor(callback) { resize = callback; } observe() {} disconnect() {}},
    MutationObserver: class {observe() {}}, requestAnimationFrame() {},
  });
  const source = fs.readFileSync(path.resolve(__dirname, '../../../web/table-resizer.js'), 'utf8');
  vm.runInContext(source, context);
  resize([{contentRect:{width:120}}]);
  resize([{contentRect:{width:900}}]);
  assert.equal(table.style.width, '900px');
  assert.deepEqual(columns.map(column => Number.parseFloat(column.style.width)), [150, 300, 450]);
});

function requestColumns(saved, available) {
  const columns = [];
  const group = {children: columns, replaceChildren(...nodes) { columns.push(...nodes); }};
  const cells = Array.from({length: 8}, () => ({getBoundingClientRect: () => ({width: 100}), classList: {add() {}}, append() {}}));
  const table = {dataset: {}, style: {}, isConnected: true, parentElement: {getBoundingClientRect: () => ({width: available})}, classList: {add() {}}, closest: () => ({}), querySelector: selector => selector === 'tr' ? {cells} : group, getBoundingClientRect: () => ({width: available})};
  const context = vm.createContext({localStorage: {getItem: () => saved}, document: {querySelectorAll: () => [table], body: {}, createElement: () => ({style: {}, setAttribute() {}, addEventListener() {}})}, MutationObserver: class {observe() {}}, requestAnimationFrame() {}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../web/table-resizer.js'), 'utf8'), context);
  return columns.map(column => Number.parseFloat(column.style.width));
}

test('默认八列按参考比例分配，窄窗口保留 CONNECT 与地址可读宽度', () => {
  assert.deepEqual(requestColumns(null, 1000), [40, 80, 90, 430, 140, 80, 80, 60]);
  const narrow = requestColumns(null, 400);
  assert.equal(narrow[2], 78);
  assert.equal(narrow[3], 180);
  assert.ok(narrow.reduce((a, b) => a + b, 0) > 400);
});

test('已有八列宽度不会被新的默认比例覆盖', () => {
  const saved = [48, 70, 90, 350, 120, 75, 80, 60];
  assert.deepEqual(requestColumns(JSON.stringify(saved), 1000), saved);
});
