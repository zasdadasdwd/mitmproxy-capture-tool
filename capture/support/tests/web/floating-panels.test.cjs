const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fitFloatingPanel} = require('../../../web/floating-panels.js');

function controllerHarness({filter = false} = {}) {
  const listeners = new Map();
  const frames = new Map();
  let nextFrame = 1;
  const doc = {
    readyState: 'complete',
    activeElement: null,
    body: {contains: () => true},
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    querySelectorAll() { return [panel]; },
    getElementById() { return trigger; },
  };
  function element(tagName) {
    return {
      tagName,
      attributes: {},
      style: {setProperty() {}, removeProperty() {}},
      dataset: {},
      classList: {add() {}, contains() { return false; }},
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name] ?? null; },
      getClientRects() { return this.hidden ? [] : [{}]; },
      getBoundingClientRect() { return {left: 100, right: 140, top: 100, bottom: 130}; },
      contains(target) { return target === this || (this.children || []).includes(target); },
      focus() { doc.activeElement = this; this.focused = true; },
      querySelector() { return trigger; },
      querySelectorAll() { return this.children || []; },
      matches() { return false; },
      scrollHeight: 100,
      hidden: false,
    };
  }
  const owner = element('DETAILS');
  owner.open = false;
  const trigger = element('SUMMARY');
  owner.querySelector = () => trigger;
  const panel = element('DIV');
  panel.id = filter ? 'filterPanel' : 'menuPanel';
  panel.hidden = filter;
  panel.closest = () => panel.id === 'filterPanel' ? null : owner;
  panel.classList.contains = name => name === 'detail-policy-options';
  panel.parentElement = {querySelector: () => trigger};
  owner.contains = target => target === owner || target === trigger || target === panel || (panel.children || []).includes(target);
  panel.contains = target => target === panel || (panel.children || []).includes(target);

  class MutationObserverMock {
    observe() {}
  }
  const window = {
    document: doc,
    innerWidth: 1000,
    innerHeight: 800,
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    addEventListener() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../../../web/floating-panels.js'), 'utf8');
  vm.runInNewContext(source, {
    window,
    document: doc,
    MutationObserver: MutationObserverMock,
    module: undefined,
  });
  function dispatch(type, event) {
    for (const callback of listeners.get(type) || []) callback(event);
  }
  return {window, doc, owner, panel, trigger, listeners, dispatch};
}

function keyEvent(key, target) {
  return {
    key,
    target,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
}

function assertInside(result, viewport) {
  assert.ok(result.left >= viewport.left + 8);
  assert.ok(result.top >= viewport.top + 8);
  assert.ok(result.left + result.width <= viewport.left + viewport.width - 8);
  assert.ok(result.top + result.maxHeight <= viewport.top + viewport.height - 8);
}

test('正常锚点在下方展开并保留首选尺寸', () => {
  const viewport = {left: 0, top: 0, width: 1000, height: 800};
  const result = fitFloatingPanel(
    {left: 100, right: 140, top: 100, bottom: 130},
    {width: 200, height: 180},
    viewport,
  );

  assert.deepEqual(result, {
    left: 100,
    top: 136,
    width: 200,
    maxHeight: 180,
    placement: 'below',
  });
  assertInside(result, viewport);
});

test('右边缘锚点将浮层向左夹紧到视口内', () => {
  const viewport = {left: 0, top: 0, width: 1000, height: 800};
  const result = fitFloatingPanel(
    {left: 940, right: 980, top: 100, bottom: 130},
    {width: 240, height: 160},
    viewport,
  );

  assert.equal(result.left, 752);
  assert.equal(result.placement, 'below');
  assertInside(result, viewport);
});

test('下方空间不足时翻转到上方', () => {
  const viewport = {left: 0, top: 0, width: 800, height: 800};
  const result = fitFloatingPanel(
    {left: 300, right: 340, top: 740, bottom: 770},
    {width: 200, height: 180},
    viewport,
  );

  assert.equal(result.placement, 'above');
  assert.equal(result.top, 554);
  assert.equal(result.maxHeight, 180);
  assertInside(result, viewport);
});

test('超大菜单保留下方展开方向并限制最大高度', () => {
  const viewport = {left: 0, top: 0, width: 800, height: 800};
  const result = fitFloatingPanel(
    {left: 200, right: 240, top: 300, bottom: 320},
    {width: 300, height: 1200},
    viewport,
  );

  assert.equal(result.placement, 'below');
  assert.equal(result.top, 326);
  assert.equal(result.maxHeight, 466);
  assertInside(result, viewport);
});

test('小窗口限制宽高且所有边界仍在视口内', () => {
  const viewport = {left: 0, top: 0, width: 300, height: 180};
  const result = fitFloatingPanel(
    {left: 100, right: 130, top: 80, bottom: 90},
    {width: 500, height: 500},
    viewport,
  );

  assert.equal(result.width, 284);
  assert.equal(result.maxHeight, 76);
  assert.equal(result.placement, 'below');
  assertInside(result, viewport);
});

test('viewport 有偏移时定位使用视口的绝对边界', () => {
  const viewport = {left: 50, top: 100, width: 400, height: 300};
  const result = fitFloatingPanel(
    {left: 100, right: 140, top: 130, bottom: 150},
    {width: 160, height: 100},
    viewport,
  );

  assert.equal(result.left, 100);
  assert.equal(result.top, 156);
  assert.equal(result.placement, 'below');
  assertInside(result, viewport);
});

test('极端锚点和尺寸组合仍不越过任一视口边缘', () => {
  const cases = [
    {
      viewport: {left: 40, top: 70, width: 240, height: 160},
      anchor: {left: 500, right: 540, top: 210, bottom: 230},
      size: {width: 900, height: 900},
    },
    {
      viewport: {left: 0, top: 0, width: 120, height: 100},
      anchor: {left: -40, right: -10, top: -30, bottom: -20},
      size: {width: 400, height: 400},
    },
  ];

  for (const {viewport, anchor, size} of cases) {
    assertInside(fitFloatingPanel(anchor, size, viewport), viewport);
  }
});

test('RAF 执行前也能识别已打开菜单，Escape 关闭并返回触发器焦点', () => {
  const h = controllerHarness();
  h.owner.open = true;

  assert.equal(h.window?.FloatingPanels?.hasOpen?.(), true);
  const event = keyEvent('Escape', h.trigger);
  h.dispatch('keydown', event);

  assert.equal(h.owner.open, false);
  assert.equal(h.trigger.focused, true);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('方向键、Home 和 End 在可见启用的菜单项间移动焦点', () => {
  const h = controllerHarness();
  const makeItem = ({disabled = false, hidden = false} = {}) => {
    const item = {
      tagName: 'BUTTON', disabled, hidden, focused: false,
      attributes: {},
      getAttribute(name) { return this.attributes[name] ?? null; },
      getClientRects: () => hidden ? [] : [{}],
      focus() { h.doc.activeElement = this; this.focused = true; },
    };
    return item;
  };
  const first = makeItem();
  const disabled = makeItem({disabled: true});
  const second = makeItem();
  const hidden = makeItem({hidden: true});
  const last = makeItem();
  h.panel.children = [first, disabled, second, hidden, last];
  h.owner.open = true;
  h.dispatch('toggle', {});
  h.doc.activeElement = first;

  for (const [key, current, expected] of [
    ['ArrowDown', first, second],
    ['ArrowUp', second, first],
    ['End', first, last],
    ['Home', last, first],
  ]) {
    h.doc.activeElement = current;
    const event = keyEvent(key, current);
    h.dispatch('keydown', event);
    assert.equal(h.doc.activeElement, expected, `${key} should focus the expected item`);
    assert.equal(event.prevented, true, `${key} should be handled by the menu`);
  }
});

test('筛选输入框中的方向键保留给输入控件', () => {
  const h = controllerHarness({filter: true});
  const input = {tagName: 'INPUT', value: 'abc'};
  h.panel.id = 'filterPanel';
  h.panel.children = [input];
  h.owner.open = false;
  h.panel.hidden = false;
  assert.equal(h.window.FloatingPanels.hasOpen(), true);

  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    const event = keyEvent(key, input);
    h.dispatch('keydown', event);
    assert.equal(event.prevented, false, `${key} should remain available to the input`);
  }
});
