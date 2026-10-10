const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../../web/app.js'), 'utf8');
function setup(json) {
  const button = {dataset: {sha256: 'a'.repeat(64)}};
  const status = {};
  const messages = [];
  const context = vm.createContext({$: id => id === 'installMacCertificate' ? button : status, action: fn => fn, json, toast: message => messages.push(message)});
  vm.runInContext(source.slice(source.indexOf('let macCertificateInstalling = false;'), source.indexOf('/** Hook 列表在设置草稿')), context);
  return {button, status, messages};
}
test('只有明确验证信任才显示成功，旧服务不能误报', async () => {
  for (const result of [
    {trusted:true, message:'已验证 SSL 信任'},
    {trusted:false, message:'未信任，已打开钥匙串，请手动确认'},
    {trusted:null, message:'验证超时，请检查钥匙串'},
    {installed:true, message:'已安装并信任'},
  ]) {
    const e=setup(async () => result);
    await e.button.onclick();
    assert.equal(e.button.disabled, false);
    assert.equal(e.button.textContent, '安装并信任');
    assert.equal(e.messages.at(-1), e.status.textContent);
    if (result.trusted === true) assert.match(e.status.textContent, /已验证.*重新建立/);
    else assert.doesNotMatch(e.status.textContent, /重新建立客户端连接/);
    if (!('trusted' in result)) assert.match(e.status.textContent, /未提供信任验证/);
  }
});
test('请求失败或超时显示持久反馈并恢复按钮', async () => {
  for (const name of ['Error','TimeoutError']) {
    const e=setup(async()=>{const err=new Error('connection failed');err.name=name;throw err;});
    await e.button.onclick();
    assert.equal(e.button.disabled,false);
    assert.match(e.status.textContent,name==='TimeoutError'?/超时/:/安装未确认成功/);
  }
});
test('等待系统授权期间阻止重复请求', async () => {
  let done, calls=0;
  const e=setup(()=>{calls++;return new Promise(resolve=>{done=resolve;});});
  const pending=e.button.onclick();
  await e.button.onclick();
  assert.equal(calls,1);
  assert.equal(e.button.disabled,true);
  done({trusted:false,message:'未信任'});
  await pending;
  assert.equal(e.button.disabled,false);
});
