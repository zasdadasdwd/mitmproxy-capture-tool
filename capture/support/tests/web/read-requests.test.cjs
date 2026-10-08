const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../../web/read-requests.js'),'utf8');
function setup(fetch) {
  const ctx=vm.createContext({fetch,AbortController,setTimeout,clearTimeout});
  vm.runInContext(source+'\nconst reader = new ReadRequests(10);',ctx);
  return url=>{ctx.url=url;return vm.runInContext('reader.json(url)',ctx);};
}
test('同一只读请求合并，完成后再次读取最新数据',async()=>{
  let count=0, resolve;
  const get=setup(()=>{count++;return new Promise(done=>{resolve=done;});});
  const first=get('/one'),second=get('/one');
  assert.equal(first,second);assert.equal(count,1);
  resolve({ok:true,json:async()=>({value:1})});await first;
  const next=get('/one');assert.equal(count,2);
  resolve({ok:true,json:async()=>({value:2})});assert.equal((await next).value,2);
});
test('正文读取超时释放请求，后续重试成功；不会永久等待',async()=>{
  let calls=0;
  const get=setup(async(url,{signal})=>{
    calls++;
    return {ok:true,json:()=>calls===1?new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))):Promise.resolve({ready:true})};
  });
  await assert.rejects(get('/slow'),/读取超时/);
  assert.equal((await get('/slow')).ready,true);
});

test('切换筛选取消旧读取，取消不会冒充超时或覆盖新结果',async()=>{
  const ctx=vm.createContext({AbortController,setTimeout,clearTimeout,fetch:(url,{signal})=>new Promise((resolve,reject)=>{
    if(url==='/new')resolve({ok:true,json:async()=>({new:true})});
    else signal.addEventListener('abort',()=>reject(new Error('aborted')));
  })});
  vm.runInContext(source+'\nconst reader = new ReadRequests(100);',ctx);
  const old=vm.runInContext('reader.json("/old", "list")',ctx);
  const rejected=assert.rejects(old,error=>error.name==='AbortError');
  assert.equal((await vm.runInContext('reader.json("/new", "list")',ctx)).new,true);
  await rejected;
});
