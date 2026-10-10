const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require("node:path").resolve(__dirname, "../../../web/desktop-appearance.js"), "utf8");

function setup() {
  const listeners = {}, events = [], writes = [];
  const applied = [];
  const window = {addEventListener(name, fn) { listeners[name] = fn; }, applyTheme(theme) { applied.push(theme); }};
  const document = {dispatchEvent(event) { events.push(event); }};
  const ctx = vm.createContext({window, document, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    localStorage: {getItem(key) { return key === "capture.theme" ? "paper" : null; }} });
  vm.runInContext(source, ctx);
  return {window, listeners, events, writes, applied, run(code) { return vm.runInContext(code, ctx); }};
}

test("desktop bootstrap restores settings and gallery, then sends preference patches to native storage", async () => {
  const e = setup(); let savedPatch;
  e.window.pywebview = {api: {
    async get_appearance() { return {settings: {theme: "ocean", opacity: 45}, backgrounds: [{id:"a",name:"Home"}], background: {id:"a",static_b64:"large-payload",static_mime:"image/png"}}; },
    async save_appearance_settings(patch) { savedPatch = patch; return patch; }
  }};
  await e.listeners.pywebviewready();
  assert.equal(e.window.DesktopAppearance.active, true);
  assert.equal(e.events[0].type, "desktop-appearance-ready");
  assert.equal(e.events[0].detail.backgrounds[0].id, "a");
  assert.equal(e.window.DesktopAppearance.snapshot.background, undefined, "the persistent snapshot keeps metadata only");
  e.window.DesktopAppearance.releasePayload(e.events[0].detail);
  assert.equal(e.events[0].detail.background, null, "consumed image bytes are released from the event payload");
  e.window.DesktopAppearance.save({uiTransparency: 70});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(savedPatch.uiTransparency, 70);
  assert.equal(Object.keys(savedPatch).length, 1);
});

test("late desktop restore does not overwrite a theme changed while get_appearance is pending", async () => {
  const e = setup(); let finish;
  let reads=0, saved;
  e.window.pywebview = {api: {get_appearance() { reads++; return new Promise(resolve => { finish = resolve; }); }, save_appearance_settings(patch) { saved=patch; } }};
  const pending = e.listeners.pywebviewready();
  const duplicate = e.window.DesktopAppearance.restoreTheme();
  e.window.DesktopAppearance.save({theme: "dark"});
  finish({settings: {theme: "light"}, backgrounds: []});
  await Promise.all([pending,duplicate]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);
  assert.equal(e.events.length,1, "edited pages still receive the native snapshot for gallery refresh");
  assert.equal(e.applied.length,0);
  assert.equal(saved.theme,"dark");
});

test("uninitialized desktop migrates old local preferences before applying defaults", async () => {
  const e=setup(); let saved;
  e.window.pywebview={api:{async get_appearance(){return {initialized:false,settings:{theme:"light",opacity:30,uiTransparency:20},backgrounds:[]};},async save_appearance_settings(patch){saved=patch;}}};
  await e.listeners.pywebviewready();
  assert.equal(e.applied[0],"paper");
  assert.equal(saved.theme,"paper");
  assert.equal(e.events[0].detail.migrateLegacyBackground,true);
});

test("native background writes and later selection execute in initiation order", async () => {
  const e=setup(), order=[];let finish;
  e.window.pywebview={api:{save_appearance_background(){order.push("store-start");return new Promise(resolve=>{finish=()=>{order.push("store-end");resolve({id:"new"});};});},select_appearance_background(id){order.push(`select:${id}`);return Promise.resolve({id});}}};
  const upload=e.window.DesktopAppearance.storeBackground({name:"new"});
  const choice=e.window.DesktopAppearance.selectBackground("existing");
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,["store-start"]);
  finish();
  await Promise.all([upload,choice]);
  assert.deepEqual(order,["store-start","store-end","select:existing"]);
});

test("failed older preference write cannot retry an obsolete theme over the latest choice", async () => {
  const e=setup(), writes=[];
  e.window.pywebview={api:{async save_appearance_settings(patch){writes.push({...patch});if(writes.length===1)throw new Error("disk unavailable");}}};
  await Promise.all([e.window.DesktopAppearance.save({theme:"ocean"}),e.window.DesktopAppearance.save({theme:"graphite"})]);
  await e.window.DesktopAppearance.save({opacity:40});
  assert.equal(writes[2].theme,"graphite");
  assert.equal(writes[2].opacity,40);
});

test("superseded queued upload does not change the native selected background", async () => {
  const e=setup();let current=true,stored=0;
  e.window.pywebview={api:{async save_appearance_background(){stored++;return {id:"new"};}}};
  const upload=e.window.DesktopAppearance.storeBackground({name:"old"},()=>current);
  current=false;
  assert.equal((await upload).stale,true);
  assert.equal(stored,0);
});
