const test = require('node:test');
const assert = require('node:assert/strict');
const {BackgroundMemoryProtection} = require('../../../web/background-protection.js');
const settings = {enabled:true,interval_seconds:15,consecutive_samples:3,pause_mib:512,hide_mib:768};
function setup() {
  let time=0; const actions=[];
  const guard=new BackgroundMemoryProtection(level=>actions.push(level),()=>time);
  return {guard,actions,tick(mib,pid=123,active=true){time+=15000;guard.sample({pid,mib,settings},active);},gap(){time+=60000;}};
}
test('three high samples pause, then three further high samples hide; no automatic recovery',()=>{
  const g=setup();g.tick(900);g.tick(900);assert.deepEqual(g.actions,[]);g.tick(900);
  assert.deepEqual(g.actions,[1]);g.tick(900);g.tick(900);assert.deepEqual(g.actions,[1]);g.tick(900);
  assert.deepEqual(g.actions,[1,2]);g.tick(10);assert.equal(g.guard.level,2);
  g.guard.reset();assert.equal(g.guard.level,0);g.tick(900);assert.deepEqual(g.actions,[1,2]);
});
test('spikes and values equal to thresholds do not count as sustained excess',()=>{
  const g=setup();for(let i=0;i<20;i++){g.tick(900);g.tick(512);}assert.deepEqual(g.actions,[]);
  g.tick(600);g.tick(600);g.tick(600);for(let i=0;i<20;i++)g.tick(768);assert.deepEqual(g.actions,[1]);
});
test('changed PID, missing sample and long sleep gaps break consecutive counts',()=>{
  const g=setup();g.tick(900);g.tick(900);g.tick(900,124);assert.equal(g.guard.count,1);
  g.guard.sample({unavailable:true});g.tick(900,124);assert.equal(g.guard.count,1);
  g.gap();g.tick(900,124);assert.equal(g.guard.count,1);assert.deepEqual(g.actions,[]);
});
test('inactive background, invalid samples and disabled config cannot trigger protection',()=>{
  const g=setup();for(let i=0;i<10;i++)g.tick(900,123,false);
  for(const value of [{pid:123,mib:Infinity,settings},{pid:0,mib:900,settings},{pid:123,mib:900,settings:{...settings,enabled:false}},{pid:123,mib:900,settings:{...settings,hide_mib:512}}])g.guard.sample(value);
  assert.deepEqual(g.actions,[]);assert.equal(g.guard.count,0);
});
test('all background pages load the guard before appearance initialization',()=>{
  const fs=require('node:fs'),path=require('node:path');
  for(const name of ['index.html','certificate.html','history.html','links.html','mcp-logs.html']) {
    const html=fs.readFileSync(path.resolve(__dirname,'../../../web',name),'utf8');
    assert.ok(html.indexOf('/background-protection.js')>=0,name);
    assert.ok(html.indexOf('/background-protection.js')<html.indexOf('/appearance-background.js'),name);
  }
});
