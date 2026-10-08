const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function setup(fetch, menus=[], getContext=()=>null) {
  const node=()=>({children:[],textContent:'',dataset:{},classList:{toggle(){}},append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];this.textContent='';},setAttribute(){}});
  const nodes={};const dialog=node();dialog.open=false;
  dialog.querySelector=selector=>nodes[selector] ||= node();
  dialog.addEventListener=(name,callback)=>{dialog[name]=callback;};
  dialog.showModal=()=>{dialog.open=true;};
  dialog.close=()=>{dialog.open=false;dialog.closeEvent?.();};
  const ctx=vm.createContext({document:{createElement:node,querySelectorAll:()=>menus},fetch,URLSearchParams,notify(){}});
  ctx.dialog=dialog; ctx.getContext=getContext;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../web/request-comparison.js'),'utf8'),ctx);
  vm.runInContext('view = new FlowComparison(dialog, getContext, notify)',ctx);
  return {ctx,nodes};
}
const result={comparison_version:2,left:{url:'http://example.test/a'},right:{url:'http://example.test/b'},warnings:[],total_changes:1,changes:[{field:'request.headers.x[0]',kind:'removed',before:'<script>unsafe</script>',after:null,before_present:true,after_present:false}]};
test('对比值用纯文本，区分字段删除与 null',async()=>{
  const {ctx,nodes}=setup(async()=>({ok:true,json:async()=>result}));
  await ctx.view.open({session:'s',id:'a'},{session:'s',id:'b'});
  const table=nodes['[data-compare-results]'].children[0];
  const row=table.children[1].children[0];
  assert.equal(row.children[1].children[0].textContent,'<script>unsafe</script>');
  assert.equal(row.children[2].children[0].textContent,'（不存在）');
  assert.match(row.children[0].textContent,/删除/);
  assert.equal(vm.runInContext('comparisonGroup("request.query.x[0]")',ctx),'query');
  assert.equal(vm.runInContext('comparisonGroup("response.body#/x")',ctx),'responseBody');
});
test('晚到的比较结果不会覆盖新的一对请求',async()=>{
  let release;
  const {ctx,nodes}=setup(url=>url.includes('/old/') ? new Promise(resolve=>release=resolve) : Promise.resolve({ok:true,json:async()=>result}));
  const old=ctx.view.open({session:'s',id:'old'},{session:'s',id:'b'});
  await ctx.view.open({session:'s',id:'new'},{session:'s',id:'b'});
  release({ok:true,json:async()=>({...result,left:{url:'stale'}})});
  await old;
  assert.ok(!nodes['[data-compare-labels]'].textContent.includes('stale'));
  assert.equal(ctx.view.pair[0].id,'new');
});
test('相同请求不能对比；旧后端明确提示不支持新增检查',async()=>{
  const {ctx,nodes}=setup(async()=>({ok:true,json:async()=>({...result,comparison_version:undefined})}));
  await ctx.view.open({session:'s',id:'a'},{session:'s',id:'a'});
  assert.equal(ctx.dialog.open,false);
  await ctx.view.open({session:'s',id:'a'},{session:'s',id:'b'});
  assert.match(nodes['[data-compare-status]'].textContent,/旧对比接口/);
});
test('工作台真实 HTML 包含初始化对比所需控件，避免启动时空节点异常',()=>{
  const html=fs.readFileSync(path.resolve(__dirname,'../../../web/index.html'),'utf8');
  const ids=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],{}]));
  const app=fs.readFileSync(path.resolve(__dirname,'../../../web/app.js'),'utf8');
  const bindings=app.slice(app.indexOf('const flowComparison ='),app.indexOf('function size(bytes)'));
  const ctx=vm.createContext({
    $:id=>ids.get(id) || null,
    FlowComparison:class {constructor(dialog){assert.ok(dialog);}},
    action:fn=>fn, toast(){}, requestViewer:{}, state:{selected:new Set()}
  });
  assert.doesNotThrow(()=>vm.runInContext(bindings,ctx));
  assert.equal(typeof ids.get('compareSelected').onclick,'function');
});

test('基准选中状态包含会话 ID，同名请求可跨会话对比',()=>{
  const buttons=Object.fromEntries(['baseline','compare','source'].map(action=>[action,{dataset:{compareAction:action},setAttribute(key,value){this[key]=value;}}]));
  const menu={dataset:{compareMenu:'detail'},querySelectorAll:()=>Object.values(buttons),querySelector:selector=>buttons[selector.match(/="([^"]+)"/)[1]]};
  let current={session:'first',id:'same-id',flow:{url:'http://example.test/a'}};
  const {ctx}=setup(null,[menu],()=>current);
  buttons.baseline.onclick();
  assert.equal(buttons.baseline['aria-pressed'],'true');
  assert.equal(buttons.compare.disabled,true);
  current={session:'second',id:'same-id',flow:{url:'http://example.test/b'}};
  ctx.view.updateMenus();
  assert.equal(buttons.baseline['aria-pressed'],'false');
  assert.equal(buttons.compare.disabled,false);
  assert.equal(ctx.view.baseline.session,'first');
});
