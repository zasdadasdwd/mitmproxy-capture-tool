const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../web/app.js'), 'utf8');
function setup() {
  const panel = {hidden: false};
  const trigger = {setAttribute(name, value) {this[name] = value;}};
  let detailClosed = 0;
  const menus = Array.from({length: 5}, () => ({open: true, contains(target) {return target?.menu === this;}}));
  const listeners = {};
  const document = {
    querySelectorAll() {return menus;},
    querySelector() {return {open: true};},
    addEventListener(type, callback, capture) {listeners[type] = {callback, capture};},
  };
  const context = vm.createContext({document, $: id => ({filterPanel: panel, toggleFilters: trigger, closeDetail: {click() {detailClosed++;}}})[id]});
  vm.runInContext(source.slice(source.indexOf('function hideFilters()'), source.indexOf('$("toggleFilters").onclick')), context);
  vm.runInContext(source.slice(source.indexOf('function dismissFloatingMenus('), source.indexOf('$("resetFilters").onclick')), context);
  return {panel, trigger, menus, listeners, run: code => vm.runInContext(code, context), closed: () => detailClosed};
}
test('点击浮层外部收起全部操作菜单，不修改内容折叠', () => {
  const {panel, menus, listeners} = setup();
  const content = {open: true, closest() {return null;}};
  listeners.pointerdown.callback({target: content});
  assert.equal(panel.hidden, true);
  assert.ok(menus.every(menu => !menu.open));
  assert.equal(content.open, true);
  assert.equal(listeners.pointerdown.capture, true);
});
test('菜单内部操作保留当前菜单，关闭其他浮层；键盘 click 同样生效', () => {
  const {panel, menus, listeners} = setup();
  listeners.click.callback({target: {menu: menus[2], closest() {return null;}}});
  assert.equal(panel.hidden, true);
  assert.equal(menus[2].open, true);
  assert.ok(menus.filter((_, i) => i !== 2).every(menu => !menu.open));
  assert.equal(listeners.click.capture, true);
});
test('筛选内部输入或触发按钮不会关闭筛选', () => {
  const {panel, menus, listeners} = setup();
  listeners.pointerdown.callback({target: {closest() {return panel;}}});
  assert.equal(panel.hidden, false);
  assert.ok(menus.every(menu => !menu.open));
});
test('Escape 优先关闭菜单，不关闭完整详情弹窗', () => {
  const {panel, menus, listeners, closed} = setup();
  let prevented = false;
  listeners.keydown.callback({key: 'Escape', preventDefault() {prevented = true;}, stopPropagation() {}});
  assert.equal(prevented, true);
  assert.equal(panel.hidden, true);
  assert.ok(menus.every(menu => !menu.open));
  assert.equal(closed(), 0);
});
