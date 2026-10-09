const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').resolve(__dirname,'../../../web/app.js'),'utf8');
function setup(hosts){const roots=hosts.map(host=>({dataset:{host},hidden:false}));const els={directoryHostSearch:{value:''},directoryTree:{querySelectorAll:()=>roots,append(h){els[h.id]=h}}};const ctx=vm.createContext({$:id=>els[id],document:{createElement:()=>({})}});vm.runInContext(source.slice(source.indexOf('function filterDirectoryHosts()'),source.indexOf('$("directoryHostSearch").oninput')),ctx);return{roots,els,run(){vm.runInContext('filterDirectoryHosts()',ctx)}}}
test('host 过滤忽略大小写与空白，清空恢复全部域名',()=>{const e=setup(['api.example.test','other.test']);e.els.directoryHostSearch.value='  EXAMPLE  ';e.run();assert.deepEqual(e.roots.map(x=>x.hidden),[false,true]);assert.equal(e.els.directoryHostEmpty.hidden,true);e.els.directoryHostSearch.value='';e.run();assert.deepEqual(e.roots.map(x=>x.hidden),[false,false])});
test('无匹配显示提示，空目录不重复显示提示，刷新域名仍适用关键词',()=>{const e=setup(['tunnel.test']);e.els.directoryHostSearch.value='blocked';e.run();assert.equal(e.els.directoryHostEmpty.hidden,false);e.roots.push({dataset:{host:'blocked.test'}});e.run();assert.equal(e.roots[1].hidden,false);assert.equal(e.els.directoryHostEmpty.hidden,true);e.roots.length=0;e.run();assert.equal(e.els.directoryHostEmpty.hidden,true)});
