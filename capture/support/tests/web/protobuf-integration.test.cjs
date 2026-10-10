const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const wire = require('../../../web/protobuf-viewer.js');
const source = fs.readFileSync(path.resolve(__dirname, '../../../web/request-viewer.js'), 'utf8');
function setup(json) {
  const elements = {viewerRaw:{},viewerNotice:{},viewerCopy:{},viewerMode:{value:'protobuf'},viewerProtoType:{value:''}};
  const context = vm.createContext({Uint8Array,atob,Map,ProtobufViewer:wire, document:{getElementById:id=>elements[id]},readRequests:{json}});
  vm.runInContext(source.slice(0,source.indexOf('const requestViewer =')),context);
  context.viewer={sequence:1,protobufSequence:0,part:'request',session:'synthetic',id:'1',dialog:{open:true},protobufCache:new Map()};
  return {context,elements,viewer:context.viewer,run:message=>{context.message=message;return vm.runInContext('RequestViewer.prototype.renderProtobuf.call(viewer,message)',context);}};
}
test('protobuf reads original bytes, preserves uint64 and caches only current flow',async()=>{
 const message={body_text:'replacement',headers:[],body_state:'complete'};
 let calls=0;
 const fixture={request:{body_b64:Buffer.from([8,255,255,255,255,255,255,255,255,255,1]).toString('base64')}};
 const before=JSON.stringify(fixture);
 const {run,elements}=setup(async(url)=>{calls++;assert.match(url,/text_only=false$/);return fixture;});
 await run(message);assert.match(elements.viewerRaw.textContent,/18446744073709551615/);
 await run(message);assert.equal(calls,1);assert.equal(JSON.stringify(fixture),before);assert.equal(message.body_text,'replacement');
});
test('late byte reads cannot overwrite or cache a closed viewer',async()=>{
 let resolve;const {run,viewer,elements}=setup(()=>new Promise(r=>resolve=r));
 const pending=run({headers:[]});viewer.dialog.open=false;elements.viewerRaw.textContent='new view';
 resolve({request:{body_b64:'CAE='}});await pending;
 assert.equal(elements.viewerRaw.textContent,'new view');assert.equal(viewer.protobufCache.size,0);
});
test('truncated and grpc messages show explicit errors without parsing',async()=>{
 let calls=0;const {run,elements}=setup(async()=>{calls++;return {};});
 await run({truncated:true});assert.match(elements.viewerNotice.textContent,/未完整/);
 await run({headers:[['Content-Type','application/grpc+proto']]});assert.match(elements.viewerNotice.textContent,/gRPC/);
 assert.equal(calls,0);assert.equal(elements.viewerCopy.disabled,true);
});
test('content decoded bytes take priority over compressed raw bytes',async()=>{
 const configured=setup(async()=>({response:{body_b64:'invalid',decoded_b64:'CAE='}}));
 configured.viewer.part='response';await configured.run({headers:[]});
 assert.match(configured.elements.viewerRaw.textContent,/"value": "1"/);
 assert.equal(configured.elements.viewerCopy.disabled,false);
});
