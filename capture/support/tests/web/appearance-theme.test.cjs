const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').resolve(__dirname, '../../../web/theme.js'), 'utf8');

function setup(saved = 'light', denied = false) {
  const events = new Map(), windowEvents = new Map(), writes = [];
  function element() {
    return {dataset: {}, children: [], attributes: {}, hidden: false,
      append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } },
      insertBefore(n) { n.parentNode = this; this.children.unshift(n); },
      setAttribute(k,v) {this.attributes[k]=v;}, removeAttribute(k) {delete this.attributes[k];},
      addEventListener(k,f) {this[k]=f;}, contains(n) {return n===this || this.children.some(x=>x.contains(n));},
      querySelector() {return null;}, focus() {document.activeElement=this;}};
  }
  const document = {documentElement:{dataset:{}}, createElement:element, getElementById(){return null;},
    addEventListener(k,f){if(!events.has(k))events.set(k,[]);events.get(k).push(f);},
    dispatchEvent(e){for(const f of events.get(e.type)||[])f(e);}};
  const ctx=vm.createContext({document,window:{addEventListener(k,f){windowEvents.set(k,f);}},
    localStorage:{getItem(){if(denied)throw Error('denied');return saved;},setItem(k,v){if(denied)throw Error('denied');writes.push([k,v]);}},
    CustomEvent: class {constructor(type,options={}) {this.type=type;this.detail=options.detail;}}});
  vm.runInContext(source,ctx);
  return {document,writes,windowEvents,element,run(s){return vm.runInContext(s,ctx);}};
}
test('五套主题恢复、即时切换、未知值回退和跨页同步不重复保存',()=>{
  for (const id of ['light','dark','ocean','paper','graphite']) {
    const e=setup(id);assert.equal(e.document.documentElement.dataset.theme,id);assert.equal(e.writes.length,0);
    e.run('applyTheme("paper")');assert.deepEqual(e.writes,[['capture.theme','paper']]);
    e.windowEvents.get('storage')({key:'capture.theme',newValue:'ocean'});
    assert.equal(e.document.documentElement.dataset.theme,'ocean');assert.equal(e.writes.length,1);
    e.run('applyTheme("invalid")');assert.equal(e.document.documentElement.dataset.theme,'light');
  }
  assert.equal(setup('unknown').document.documentElement.dataset.theme,'light');
});
test('本地存储不可用仍允许切换主题',()=>{
  const e=setup('dark',true);assert.equal(e.document.documentElement.dataset.theme,'light');
  assert.doesNotThrow(()=>e.run('applyTheme("graphite")'));assert.equal(e.document.documentElement.dataset.theme,'graphite');
});
test('主题菜单互斥、独立选中、Escape关闭并保留焦点，重复初始化不创建重复菜单',()=>{
  const e=setup();const p=e.element(),b=e.element(),b2=e.element();p.append(b,b2);
  e.document.getElementById=()=>null;
  // Bind handles through the VM without inspecting application business state.
  e.document.buttons=[b,b2];e.run('initThemePicker(document.buttons[0]);initThemePicker(document.buttons[1]);initThemePicker(document.buttons[0]);');
  const wrapper=b.parentNode,menu=wrapper.children[1];assert.equal(wrapper.children.length,2);
  b.onclick();assert.equal(menu.hidden,false);
  b.keydown({key:'ArrowDown',preventDefault(){}});assert.equal(menu.hidden,false);assert.equal(e.document.activeElement,menu.children[0]);
  b2.onclick();assert.equal(menu.hidden,true);
  b.onclick();menu.children[2].onclick();assert.equal(e.document.documentElement.dataset.theme,'ocean');assert.equal(menu.hidden,true);
  assert.equal(menu.children[2].attributes['aria-checked'],'true');
  b.onclick();let stopped=false;e.document.dispatchEvent({type:'keydown',key:'Escape',preventDefault(){},stopImmediatePropagation(){stopped=true;}});
  assert.equal(menu.hidden,true);assert.equal(stopped,true);assert.equal(e.document.activeElement,b);
});
