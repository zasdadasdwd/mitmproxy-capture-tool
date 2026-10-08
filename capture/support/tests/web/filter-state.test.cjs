const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../web/app.js'), 'utf8');
function setup() {
  const elements = Object.fromEntries(['search','quickSearchScope','filterKeyword','searchScope','filterHost','directoryFilter','directoryTree'].map(id=>[id,{value:'',replaceChildren(){}}]));
  const state = {session:'capture',sessions:[{id:'capture',kind:'capture'}], selected:new Set(),directoryOpen:new Set(),refreshSequence:0, advancedExpression:null,directory:null};
  const context=vm.createContext({state,filterFields:{filterHost:'host'},$:id=>elements[id],structuredClone,clearTimeout(){},renderDetail(){},renderSelection(){},setQuickFilterDisabled(){},syncFilterControls(){},URLSearchParams,filtersChanged(){}});
  vm.runInContext(source.slice(source.indexOf('const sessionFilters ='),source.indexOf('const filterFields')),context);
  vm.runInContext(source.slice(source.indexOf('function activeKeyword()'),source.indexOf('/** 页内实时刷新')),context);
  vm.runInContext(source.slice(source.indexOf('function innerFiltersChanged()'),source.indexOf('$("search").oninput')),context);
  return {state,elements,run:code=>vm.runInContext(code,context)};
}
test('抓包→重放→抓包恢复关键词范围、域名和分组条件，状态互不覆盖',()=>{
  const {state,elements,run}=setup();
  elements.search.value='needle';elements.quickSearchScope.value='response_body';elements.filterHost.value='example.test';
  run('switchSession("replay")');assert.equal(elements.search.value,'');
  elements.search.value='replay only';
  run('switchSession("capture")');assert.equal(elements.search.value,'needle');assert.equal(elements.quickSearchScope.value,'response_body');assert.equal(elements.filterHost.value,'example.test');
  state.advancedExpression={operator:'and',children:[{field:'host',value:'example.test'}]};
  run('switchSession("replay")');assert.equal(elements.search.value,'replay only');assert.equal(state.advancedExpression,null);
  run('switchSession("capture")');assert.equal(state.advancedExpression.children[0].value,'example.test');assert.equal(state.lastCaptureSession,'capture');
});
test('内层条件清空外层关键词，查询使用内层范围；外层关键词可切回',()=>{
  const {elements,run}=setup();elements.search.value='outer';elements.quickSearchScope.value='headers';elements.filterKeyword.value='inner';elements.searchScope.value='bodies';
  run('innerFiltersChanged()');assert.equal(elements.search.value,'');assert.equal(elements.quickSearchScope.value,'url');
  assert.equal(run('filterParams().get("search")'),'inner');assert.equal(run('filterParams().get("scope")'),'bodies');
  elements.search.value='new';elements.quickSearchScope.value='response_body';run('outerFiltersChanged()');assert.equal(elements.filterKeyword.value,'');assert.equal(run('filterParams().get("scope")'),'response_body');
});
