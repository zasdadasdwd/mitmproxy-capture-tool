const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {BackgroundPlayer,index}=require('../../../web/background-player.js');
const still=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
const gif=Buffer.concat([still.subarray(0,-1),still.subarray(still.indexOf(44),-1),Buffer.from([59])]);
const flush=()=>new Promise(r=>setImmediate(r));
function setup(decode){let now=0,id=0;const queue=new Map(),ops=[];
 const ctx={clearRect(...a){ops.push(['clear',...a]);},fillRect(...a){ops.push(['fill',...a]);},drawImage(){ops.push(['draw']);},getImageData(...a){ops.push(['save',...a]);return {a};},putImageData(...a){ops.push(['restore',...a]);}};
 const canvas={style:{},getContext(){return ctx;}};
 const player=new BackgroundPlayer(canvas,{decode,clock:()=>now,schedule:fn=>{queue.set(++id,fn);return id;},cancel:i=>queue.delete(i)});
 return {player,canvas,ops,queue,next(){now+=200;const callbacks=[...queue.values()];queue.clear();callbacks.forEach(fn=>fn());}};
}
test('indexes GIF frames and makes each decoder input a single-frame file',async()=>{
 const parsed=index(gif);assert.equal(parsed.frames.length,2);assert.equal(parsed.w,1);
 for(const frame of parsed.frames){const data=new Uint8Array(await parsed.frameBlob(frame).arrayBuffer());assert.equal(index(data).frames.length,1);}
 assert.throws(()=>index(gif.subarray(0,-1)),/不完整/);
});
test('indexes all builtin WebP frames without decoding the animation or copying frame payloads',async()=>{
 const bytes=new Uint8Array(fs.readFileSync(require('node:path').resolve(__dirname,'../../../web/backgrounds/wind-blink.webp')));
 const parsed=index(bytes);assert.equal(parsed.frames.length,150);assert.equal(parsed.w,1280);assert.equal(parsed.h,720);
 const blob=parsed.frameBlob(parsed.frames[50]);assert.ok(blob.size<bytes.length/20);
 const data=Buffer.from(await blob.arrayBuffer());assert.equal(data.includes(Buffer.from('ANMF')),false);assert.equal(data.includes(Buffer.from('ANIM')),false);
});
test('stop/restart serializes uncancellable decodes, closes stale bitmaps and prevents late draw',async()=>{
 let resolve,active=0,peak=0,closed=0;
 const {player,canvas,ops}=setup(()=>{active++;peak=Math.max(peak,active);return new Promise(r=>resolve=()=>{active--;r({close(){closed++;}});});});
 const blob=new Blob([gif]);player.play(blob);await flush();assert.equal(active,1);
 player.stop();player.play(new Blob([gif]));await flush();assert.equal(active,1);assert.equal(canvas.width,0);
 resolve();await flush();assert.equal(ops.filter(x=>x[0]==='draw').length,0);assert.equal(closed,1);assert.equal(active,1);
 resolve();await flush();assert.equal(ops.filter(x=>x[0]==='draw').length,1);assert.equal(peak,1);assert.equal(closed,2);
 player.stop();assert.equal(canvas.width,0);assert.equal(player.animation,null);assert.equal(player.source,null);
});
test('one frame at a time closes every bitmap and honors finite animation loops',async()=>{
 let closed=0;const {player,queue,next,canvas}=setup(async()=>({close(){closed++;}}));
 player.play(new Blob([gif]));await flush();assert.equal(closed,1);assert.equal(queue.size,1);
 next();await flush();assert.equal(closed,2);assert.equal(queue.size,0);assert.equal(canvas.width,1);
 player.stop();assert.equal(canvas.width,0);
});
test('GIF disposal restore snapshots one region and is replaced rather than accumulated',async()=>{
 const control=Buffer.from([33,249,4,12,0,0,0,0]);
 const input=Buffer.concat([still.subarray(0,still.indexOf(44)),control,still.subarray(still.indexOf(44),-1),control,still.subarray(still.indexOf(44))]);
 const {player,ops,next}=setup(async()=>({close(){}}));player.play(new Blob([input]));await flush();next();await flush();
 assert.equal(ops.filter(x=>x[0]==='save').length,2);assert.equal(ops.filter(x=>x[0]==='restore').length,1);assert.deepEqual(player.restore,{a:[0,0,1,1]});player.stop();assert.equal(player.restore,null);
});
test('rapid restarts retain only one queued job while native decoding is blocked',async()=>{
 let resolve,decodes=0,closed=0;const {player,ops}=setup(()=>{decodes++;return new Promise(r=>resolve=()=>r({close(){closed++;}}));});
 player.play(new Blob([gif]));await flush();
 for(let i=0;i<1000;i++){player.stop();player.play(new Blob([gif]));}
 assert.equal(decodes,1);assert.ok(player.queued);resolve();await flush();assert.equal(decodes,2);
 assert.equal(ops.filter(x=>x[0]==='draw').length,0);resolve();await flush();assert.equal(closed,2);assert.equal(ops.filter(x=>x[0]==='draw').length,1);player.stop();assert.equal(player.queued,null);
});

test('all background-enabled pages load the incremental player before appearance initialization',()=>{
 const path=require('node:path');
 for(const name of ['index.html','history.html','links.html','mcp-logs.html','certificate.html']){
  const html=fs.readFileSync(path.resolve(__dirname,'../../../web',name),'utf8');
  assert.ok(html.indexOf('/background-player.js')>=0,name);
  assert.ok(html.indexOf('/background-player.js')<html.indexOf('/appearance-background.js'),name);
 }
});
