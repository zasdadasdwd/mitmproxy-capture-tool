const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').resolve(__dirname, '../../../web/history.js'),'utf8');
function setup(){
 const els = new Map();
 function el(){return {value:'',checked:false,disabled:false,style:{},dataset:{},children:[],append(...x){this.children.push(...x)},replaceChildren(){this.children=[]},setAttribute(){},showModal(){this.open=true},close(){this.open=false},focus(){}}}
 const items=[{id:'a',kind:'capture',count:2,disk_bytes:20,status:'stopped'},{id:'b',kind:'replay',count:1,disk_bytes:10,status:'stopped'}];
 const calls=[];let fail=null;
 const ctx=vm.createContext({document:{getElementById(id){if(!els.has(id))els.set(id,el());return els.get(id)},createElement:el},fetch:async(path,options)=>{if(options?.method==='DELETE'){calls.push(path);if(path.endsWith(fail))return {ok:false,text:async()=> 'failed'};items.splice(items.findIndex(x=>path.endsWith(x.id)),1)}return {ok:true,json:async()=>items}},setTimeout(){},clearTimeout(){},applyTheme(){}});
 vm.runInContext(source.replace('action(refresh)();',''),ctx);
 return {ctx,els,calls,fail(v){fail=v},run(s){return vm.runInContext(s,ctx)}};
}
test('会话全选只作用于筛选结果，半选及隐藏选择计数保持',async()=>{const e=setup();await e.run('refresh()');e.els.get('historyKind').value='capture';e.run('render()');e.els.get('historySelectAll').checked=true;e.els.get('historySelectAll').onchange();assert.equal(e.run('selected.size'),1);e.els.get('historyKind').value='';e.run('render()');assert.equal(e.els.get('historySelectAll').indeterminate,true);assert.match(e.els.get('historyClearSelected').textContent,/1/)});
test('未确认不删除，批量清理仅提交选中会话并防止重复发送',async()=>{const e=setup();await e.run('refresh()');e.run('selected.add("a");selected.add("b");renderSelection()');e.els.get('historyClearSelected').onclick();await e.els.get('deleteHistoryForm').onsubmit({preventDefault(){}});assert.equal(e.calls.length,0);e.els.get('deleteHistoryId').value='清理 2 个会话';await e.els.get('deleteHistoryForm').onsubmit({preventDefault(){}});assert.deepEqual(e.calls,['/api/history/a','/api/history/b']);assert.equal(e.run('selected.size'),0);assert.equal(e.els.get('historyClearSelected').disabled,true)});
test('部分删除失败时保留未完成选择并明确反馈',async()=>{const e=setup();await e.run('refresh()');e.fail('b');e.run('selected.add("a");selected.add("b")');e.els.get('historyClearSelected').onclick();e.els.get('deleteHistoryId').value='清理 2 个会话';await e.els.get('deleteHistoryForm').onsubmit({preventDefault(){}});assert.equal(e.run('selected.has("b")'),true);assert.equal(e.run('selected.has("a")'),false);assert.match(e.els.get('toast').textContent,/已清理 1 个会话，其余未完成/)});
