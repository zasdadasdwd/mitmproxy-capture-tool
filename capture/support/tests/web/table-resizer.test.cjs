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
