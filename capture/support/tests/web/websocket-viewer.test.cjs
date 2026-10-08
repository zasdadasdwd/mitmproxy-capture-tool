const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup(fetch) {
  const node = () => ({children:[],hidden:false,textContent:'',append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];}});
  const ctx = vm.createContext({document:{createElement:node}, TextDecoder, Uint8Array, atob, fetch, copyMessageText(){}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../web/websocket-viewer.js'),'utf8'),ctx);
  ctx.target=node();
  vm.runInContext('viewer = new WebSocketViewer(target)',ctx);
  return ctx;
}
test('WebSocket 保留方向、截断状态和二进制，展开后才解码',()=>{
  const ctx=setup();
  ctx.result={summary:{state:'closed',total:2,saved:2,close_code:1000},total:2,items:[
    {number:1,timestamp:1,from_client:true,type:'text',size:10,body_b64:Buffer.from('<script>x</script>').toString('base64'),truncated:true},
    {number:2,timestamp:2,from_client:false,type:'binary',size:2,body_b64:'AP8='}
  ]};
  vm.runInContext('viewer.render(result)',ctx);
  const sections=ctx.target.children.slice(2);
  assert.match(sections[0].children[0].textContent,/客户端 → 服务端.*正文截断/);
  assert.equal(sections[0].children[2].textContent,'');
  sections[0].open=true; sections[0].ontoggle();
  assert.equal(sections[0].children[2].textContent,'<script>x</script>');
  sections[1].open=true; sections[1].ontoggle();
  assert.equal(sections[1].children[2].textContent,'00 ff');
});
test('WebSocket 晚到响应不能覆盖切换后的请求',async()=>{
  let release;
  const ctx=setup(url=>url.includes('/old/') ? new Promise(resolve=>{release=resolve;}) : Promise.resolve({ok:true,json:async()=>({summary:null,items:[],total:0})}));
  const old=ctx.viewer.show('s','old');
  await ctx.viewer.show('s','new');
  release({ok:true,json:async()=>({summary:{state:'open',total:1},items:[],total:1})});
  await old;
  assert.equal(ctx.viewer.key,'s:new');
  assert.match(ctx.target.children[0].textContent,/没有 WebSocket/);
  ctx.viewer.reset();
  assert.equal(ctx.target.hidden,true);
  assert.equal(ctx.target.children.length,0);
});
