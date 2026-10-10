const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../web/app.js'), 'utf8');
function setup() {
  const sections = Object.fromEntries(['detailHeadersSection','detailBodySection'].map(id=>[id,{dataset:{},open:false,querySelector(){return {addEventListener(type, fn){sections[id].click=fn;}};}}]));
  const ctx=vm.createContext({statusNames:{complete:'完成',blocked:'已阻止',error:'错误',passthrough:'透传',pending:'等待响应'},$:id=>sections[id]});
  vm.runInContext(source.slice(source.indexOf('function detailPresentation('),source.indexOf('const detailWebSocketViewer')),ctx);
  return {sections,run:code=>vm.runInContext(code,ctx),present:flow=>{ctx.flow=flow;return vm.runInContext('detailPresentation(flow)',ctx);}};
}
test('普通请求保留报文展示，真实状态决定颜色，不把缺失响应当成功',()=>{
 const {present}=setup();const good=present({method:'GET',status:'complete',code:200,response:{}});assert.equal(good.tone,'success');assert.equal(good.preferConnection,false);
 const missing=present({method:'GET',status:'complete'});assert.equal(missing.tone,'warning');assert.equal(missing.label,'未保存响应');assert.match(missing.reason,/没有/);
});
test('CONNECT、阻止和无响应错误优先连接，保留具体原因',()=>{
 const {present}=setup();for(const flow of [{method:'CONNECT',status:'passthrough'},{method:'POST',status:'blocked',reason:'命中策略'},{method:'POST',status:'error',reason:'连接中断'}]){const result=present(flow);assert.equal(result.preferConnection,true);if(flow.reason)assert.equal(result.reason,flow.reason);}
 assert.equal(present({method:'GET',status:'error',response:{}}).preferConnection,false);
 assert.equal(present({method:'GET',status:'pending'}).preferConnection,false);
});
test('空头部或正文默认折叠，内容到达后自动展开',()=>{
 const {sections,run}=setup();run('setDetailSection($("detailHeadersSection"), "flow:headers", false)');assert.equal(sections.detailHeadersSection.open,false);
 run('setDetailSection($("detailHeadersSection"), "flow:headers", true)');assert.equal(sections.detailHeadersSection.open,true);
});
test('用户折叠选择跨刷新保留，复制工具不会改变折叠状态',()=>{
 const {sections,run}=setup();const section=sections.detailBodySection;
 run('setDetailSection($("detailBodySection"), "flow:body", true)');section.click({target:{closest(){return null;}}});run('setDetailSection($("detailBodySection"), "flow:body", true)');assert.equal(section.open,false);
 section.click({target:{closest(){return {};}}});run('setDetailSection($("detailBodySection"), "flow:body", true)');assert.equal(section.open,false);
 run('setDetailSection($("detailBodySection"), "other:body", true)');assert.equal(section.open,true);
});
test('详情状态缓存有界，标签滚动位置与折叠状态独立',()=>{
 const {run}=setup();run('rememberDetailView("scroll:flow:request", 150)');assert.equal(run('detailViewStates.get("scroll:flow:request")'),150);
 run('for(let i=0;i<200;i++)rememberDetailView("key"+i,true)');assert.equal(run('detailViewStates.size'),120);
});
test('复制头部保留重复项和顺序；复制正文使用原文，不取展示格式',()=>{
 const copied=[];const elements={detailCopyHeaders:{},detailCopyBody:{}};
 const ctx=vm.createContext({state:{tab:'original_request',detail:{original_request:{headers:[['X-Repeat','first'],['X-Repeat','second']],body_text:'body=%7B%22id%22%3A1%7D'}}},$:id=>elements[id],copyMessageText:text=>copied.push(text)});
 vm.runInContext(source.slice(source.indexOf('$("detailCopyHeaders").onclick'),source.indexOf('$("detailProtobuf").onclick')),ctx);
 elements.detailCopyHeaders.onclick();elements.detailCopyBody.onclick();
 assert.deepEqual(copied,['X-Repeat: first\nX-Repeat: second','body=%7B%22id%22%3A1%7D']);
});
test('分体按钮保留原禁用规则，CONNECT 即使带元数据也不能重放',()=>{
 const start=source.indexOf('  $("detailReplay").disabled =');
 const end=source.indexOf('  const replayToggle =',start);
 for(const [flow,disabled] of [[{method:'POST',status:'complete',request:{}},false],[{method:'CONNECT',status:'passthrough',request:{}},true],[{method:'POST',status:'pending',request:{}},true],[{method:'POST',request:{truncated:true}},true],[{method:'GET',request:{},websocket:true},true],[null,true]]){
  const elements={detailReplay:{},detailEditReplay:{}};
  const ctx=vm.createContext({flow,$:id=>elements[id]});vm.runInContext(source.slice(start,end),ctx);
  assert.equal(elements.detailReplay.disabled,disabled);assert.equal(elements.detailEditReplay.disabled,disabled);
 }
});
