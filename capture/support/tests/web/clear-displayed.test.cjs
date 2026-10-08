const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../web/app.js'), 'utf8');
function setup({total=2, filters='sort_by=started&sort_order=desc&scope=url', pages=[], confirmResult=true}={}) {
  const state={session:'s',total};
  const calls=[], confirmations=[];
  let refreshed=0;
  const ctx=vm.createContext({state, URLSearchParams, filterParams:()=>new URLSearchParams(filters), renderSelection(){}, confirm(text){confirmations.push(text);return confirmResult;}, toast(){}, refreshAfterDeletion:async()=>{refreshed++;}, json:async(url, options)=>{calls.push({url,options}); if(!options) return pages.shift(); const body=JSON.parse(options.body);return {deleted:body.ids?.length || total};}});
  vm.runInContext(source.slice(source.indexOf('async function clearDisplayedFlows()'), source.indexOf('$("clearDisplayed").onclick')),ctx);
  return {state,calls,confirmations,run:()=>vm.runInContext('clearDisplayedFlows()',ctx),refreshed:()=>refreshed};
}
test('无请求时清空不触发查询、确认、删除或刷新',async()=>{
  const env=setup({total:0});await env.run();assert.equal(env.calls.length,0);assert.equal(env.confirmations.length,0);assert.equal(env.refreshed(),0);
});
test('无筛选时清空当前批次，范围与排序不算筛选',async()=>{
  const env=setup();await env.run();assert.deepEqual(JSON.parse(env.calls[0].options.body),{all:true});assert.equal(env.refreshed(),1);
});
test('筛选清空包含其他页、保留条件，仅删除具体匹配ID',async()=>{
  const env=setup({total:501,filters:'search=needle&scope=response_body&expression=%7B%7D&host=example.test&path_prefix=%2Fapi',pages:[{total:501,items:Array.from({length:500},(_,i)=>({id:`f${i}`}))},{total:501,items:[{id:'last'}]}]});
  await env.run();assert.equal(env.calls.length,3);assert.match(env.calls[0].url,/scope=response_body/);assert.match(env.calls[0].url,/path_prefix=%2Fapi/);assert.match(env.calls[1].url,/offset=500/);
  const body=JSON.parse(env.calls[2].options.body);assert.equal(body.ids.length,501);assert.equal(body.ids[500],'last');assert.equal(body.all,undefined);assert.match(env.confirmations[0],/包含其他页/);
});
test('取消确认或快照为空时不删除，不触发刷新',async()=>{
  for(const options of [{confirmResult:false},{filters:'host=missing',pages:[{total:0,items:[]}]}]){const env=setup(options);await env.run();assert.equal(env.calls.filter(c=>c.options).length,0);assert.equal(env.refreshed(),0);assert.equal(env.state.clearingDisplayed,false);}
});
test('大于一千条的匹配结果分批删除，超限不开始删除',async()=>{
 const env=setup({total:1001,filters:'host=example.test',pages:[{total:1001,items:Array.from({length:500},(_,i)=>({id:`a${i}`}))},{total:1001,items:Array.from({length:500},(_,i)=>({id:`b${i}`}))},{total:1001,items:[{id:'last'}]}]});await env.run();assert.deepEqual(env.calls.filter(c=>c.options).map(c=>JSON.parse(c.options.body).ids.length),[1000,1]);
 const large=setup({filters:'host=example.test',pages:[{total:50001,items:[]}]});await assert.rejects(large.run(),/50000/);assert.equal(large.calls.filter(c=>c.options).length,0);
});
