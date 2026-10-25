/** Incremental GIF/WebP playback: compressed input + one bitmap + one canvas. */
(function (root) {
  "use strict";
  const MAX_BYTES = 20 * 1024 * 1024, MAX_PIXELS = 16_000_000, MAX_FRAMES = 10000;
  const fail = message => { throw new Error(`背景动画：${message}`); };
  const word = (b, p) => b[p] | b[p + 1] << 8;
  const tri = (b, p) => b[p] + b[p + 1] * 256 + b[p + 2] * 65536;
  const text = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));
  function dimensions(w, h) { if (!w || !h || w * h > MAX_PIXELS) fail("尺寸超过限制"); }
  function rect(frame, w, h) { dimensions(frame.w, frame.h); if (frame.x + frame.w > w || frame.y + frame.h > h) fail("帧超出画布"); }
  function riffChunk(type, payload) {
    const result = new Uint8Array(8 + payload.length + (payload.length & 1));
    result.set(new TextEncoder().encode(type)); new DataView(result.buffer).setUint32(4, payload.length, true); result.set(payload, 8); return result;
  }
  function webpIndex(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 12 || text(bytes, 0, 4) !== "RIFF" || text(bytes, 8, 4) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) fail("WebP 容器无效");
    const frames = []; let w = 0, h = 0, background = [0,0,0,0], loops = 0, icc = null, alphaFlag = false;
    for (let p = 12; p < bytes.length;) {
      if (p + 8 > bytes.length) fail("WebP 块不完整");
      const type = text(bytes, p, 4), n = view.getUint32(p + 4, true), q = p + 8, end = q + n;
      if (end + (n & 1) > bytes.length) fail("WebP 块越界");
      if (type === "VP8X") { if (n !== 10 || !(bytes[q] & 2)) fail("不是动画 WebP"); alphaFlag=!!(bytes[q]&16); w = tri(bytes,q+4)+1; h = tri(bytes,q+7)+1; dimensions(w,h); }
      if (type === "ICCP") icc = bytes.subarray(p,end+(n&1));
      if (type === "ANIM") { if (n !== 6) fail("动画参数无效"); background=[bytes[q+2],bytes[q+1],bytes[q],bytes[q+3]]; loops=word(bytes,q+4); }
      if (type === "ANMF") {
        if (!w || n < 24) fail("帧头无效");
        const frame={x:tri(bytes,q)*2,y:tri(bytes,q+3)*2,w:tri(bytes,q+6)+1,h:tri(bytes,q+9)+1,delay:Math.max(10,tri(bytes,q+12)),dispose:bytes[q+15]&1?2:0,noBlend:!!(bytes[q+15]&2),start:q+16,end};
        rect(frame,w,h); let image=false, alpha=false;
        for(let s=frame.start;s<end;) {
          if(s+8>end)fail("帧子块不完整"); const k=text(bytes,s,4), z=view.getUint32(s+4,true), next=s+8+z+(z&1);
          if(next>end || !["ALPH","VP8 ","VP8L"].includes(k))fail("帧子块无效"); image ||= k!=="ALPH"; alpha ||= k==="ALPH"; s=next;
        }
        if(!image)fail("缺少帧图像"); frame.alpha=alpha||alphaFlag; frames.push(frame);
        if(frames.length>MAX_FRAMES)fail("帧数量超过限制");
      }
      p=end+(n&1);
    }
    if(!frames.length)fail("没有可播放帧");
    return {w,h,frames,loops,background,frameBlob(frame) {
      const ext=new Uint8Array(10);ext[0]=(frame.alpha?16:0)|(icc?32:0);
      for(let i=0;i<3;i++){ext[4+i]=((frame.w-1)>>>8*i)&255;ext[7+i]=((frame.h-1)>>>8*i)&255;}
      const parts=[riffChunk("VP8X",ext),...(icc?[icc]:[]),bytes.subarray(frame.start,frame.end)], size=4+parts.reduce((s,p)=>s+p.length,0);
      const header=new Uint8Array(12);header.set(new TextEncoder().encode("RIFF"));new DataView(header.buffer).setUint32(4,size,true);header.set(new TextEncoder().encode("WEBP"),8);
      return new Blob([header,...parts],{type:"image/webp"});
    }};
  }
  function gifIndex(bytes) {
    if(bytes.length<13 || !["GIF87a","GIF89a"].includes(text(bytes,0,6)))fail("GIF 签名无效");
    const w=word(bytes,6),h=word(bytes,8);dimensions(w,h);
    const paletteEnd=13+((bytes[10]&128)?3*(1<<((bytes[10]&7)+1)):0);
    let p=paletteEnd,gce=null,loops=1,ended=false;const frames=[];
    function subBlocks() {
      const blocks=[];while(true){if(p>=bytes.length)fail("GIF 子块缺失");const n=bytes[p++];if(!n)break;if(p+n>bytes.length)fail("GIF 子块越界");blocks.push(bytes.subarray(p,p+n));p+=n;}return blocks;
    }
    if(p>bytes.length)fail("色表越界");
    while(p<bytes.length) {
      const start=p,marker=bytes[p++];
      if(marker===59){ended=true;break;}
      if(marker===33) {
        if(p>=bytes.length)fail("扩展块缺失");const label=bytes[p++],blocks=subBlocks();
        if(label===249){if(blocks.length!==1||blocks[0].length!==4)fail("图形控制块无效");gce=blocks[0];}
        if(label===255 && blocks[0] && ["NETSCAPE2.0","ANIMEXTS1.0"].includes(text(blocks[0],0,11)) && blocks[1]?.[0]===1){loops=word(blocks[1],1);loops=loops?loops+1:0;}
      } else if(marker===44) {
        if(p+9>bytes.length)fail("帧描述缺失");
        const frame={x:word(bytes,p),y:word(bytes,p+2),w:word(bytes,p+4),h:word(bytes,p+6),delay:Math.max(20,gce?word(gce,1)*10:100),dispose:gce?(gce[0]>>>2)&7:0,noBlend:false,start,gce};rect(frame,w,h);
        const packed=bytes[p+8];p+=9;if(packed&128)p+=3*(1<<((packed&7)+1));if(p>=bytes.length)fail("帧色表越界");p++;subBlocks();frame.end=p;
        const bg=bytes[11],bgPos=13+bg*3;frame.background=gce&&(gce[0]&1)&&gce[3]===bg?[0,0,0,0]:paletteEnd>bgPos+2?[bytes[bgPos],bytes[bgPos+1],bytes[bgPos+2],255]:[0,0,0,0];
        frames.push(frame);gce=null;if(frames.length>MAX_FRAMES)fail("帧数量超过限制");
      } else fail("GIF 块类型无效");
    }
    if(!ended||!frames.length)fail("GIF 不完整");
    return {w,h,frames,loops,background:frames[0].background,frameBlob(frame) {
      const header=bytes.slice(0,paletteEnd);header.set(new TextEncoder().encode("GIF89a"));header[6]=frame.w&255;header[7]=frame.w>>>8;header[8]=frame.h&255;header[9]=frame.h>>>8;
      const descriptor=bytes.slice(frame.start,frame.start+10);descriptor.fill(0,1,5);
      const control=new Uint8Array([33,249,4,frame.gce?frame.gce[0]&1:0,0,0,frame.gce?.[3]||0,0]);
      return new Blob([header,control,descriptor,bytes.subarray(frame.start+10,frame.end),new Uint8Array([59])],{type:"image/gif"});
    }};
  }
  function index(bytes) {
    if(bytes.length>MAX_BYTES)fail("文件超过 20 MiB");
    return text(bytes,0,3)==="GIF"?gifIndex(bytes):webpIndex(bytes);
  }
  class BackgroundPlayer {
    constructor(canvas,{onFrame=()=>{},onError=()=>{},decode=blob=>createImageBitmap(blob),clock=()=>performance.now(),schedule=cb=>requestAnimationFrame(cb),cancel=id=>cancelAnimationFrame(id)}={}) {
      Object.assign(this,{canvas,onFrame,onError,decode,clock,schedule,cancel});this.token=0;this.source=null;this.pending=Promise.resolve();this.tickId=null;this.busy=false;this.queued=null;
    }
    /** Cancels scheduled work and releases canvas storage; late bitmaps are closed. */
    stop() {this.token++;this.source=null;this.queued=null;this.animation=null;this.previous=null;this.restore=null;this.ctx=null;if(this.tickId!==null)this.cancel(this.tickId);this.tickId=null;this.canvas.width=0;this.canvas.height=0;this.canvas.style.display="none";}
    /** Coalesces restarts while native decoding finishes; only the latest job is retained. */
    enqueue(job, token) {
      this.queued={job,token};if(this.busy)return;
      const work=this.queued;this.queued=null;this.busy=true;
      this.pending=Promise.resolve().then(work.job).catch(error=>{
        if(work.token===this.token){this.stop();this.onError(error);}
      }).finally(()=>{
        this.busy=false;
        const next=this.queued;if(next)this.enqueue(next.job,next.token);
      });
    }
    play(blob) {
      if(this.source===blob)return;
      this.stop();this.source=blob;const token=this.token;
      // Chain across stop/restart: cancellation cannot abort a native decode in flight.
      this.enqueue(async()=>{
        if(token!==this.token)return;
        const bytes=new Uint8Array(await blob.arrayBuffer());if(token!==this.token)return;
        this.animation=index(bytes);this.canvas.width=this.animation.w;this.canvas.height=this.animation.h;this.ctx=this.canvas.getContext("2d");this.frame=0;this.loops=0;this.deadline=0;
        await this.draw(token);
      },token);
    }
    clear(frame,color) {this.ctx.clearRect(frame.x,frame.y,frame.w,frame.h);if(color[3]){this.ctx.fillStyle=`rgba(${color[0]},${color[1]},${color[2]},${color[3]/255})`;this.ctx.fillRect(frame.x,frame.y,frame.w,frame.h);}}
    async draw(token) {
      if(token!==this.token)return;
      const anim=this.animation,frame=anim.frames[this.frame];let bitmap=null;
      try {
        bitmap=await this.decode(anim.frameBlob(frame));if(token!==this.token)return;
        if(this.frame===0)this.clear({x:0,y:0,w:anim.w,h:anim.h},anim.background);
        else if(this.previous?.dispose===2)this.clear(this.previous,this.previous.background||anim.background);
        else if(this.previous?.dispose===3&&this.restore)this.ctx.putImageData(this.restore,this.previous.x,this.previous.y);
        this.restore=frame.dispose===3?this.ctx.getImageData(frame.x,frame.y,frame.w,frame.h):null;
        if(frame.noBlend)this.ctx.clearRect(frame.x,frame.y,frame.w,frame.h);
        this.ctx.drawImage(bitmap,frame.x,frame.y);this.previous=frame;this.canvas.style.display="block";this.onFrame();
      } finally {bitmap?.close();}
      if(token!==this.token)return;
      this.frame++;if(this.frame===anim.frames.length){this.frame=0;this.loops++;if(anim.loops&&this.loops>=anim.loops)return;}
      const now=this.clock();if(!this.deadline || now-this.deadline>250)this.deadline=now;this.deadline+=frame.delay;
      const tick=()=>{this.tickId=null;if(token!==this.token)return;if(this.clock()<this.deadline){this.tickId=this.schedule(tick);return;}this.enqueue(()=>this.draw(token),token);};
      this.tickId=this.schedule(tick);
    }
  }
  const api={BackgroundPlayer,index,MAX_BYTES,MAX_PIXELS};root.BackgroundAnimation=api;if(typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof globalThis!=="undefined"?globalThis:this);
