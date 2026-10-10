const test = require("node:test");
const assert = require("node:assert/strict");
const { parseWebP, gifFirstFrame, parseGif, jpegDimensions, imageDimensions, sniff, MAX_BYTES, MAX_PIXELS, initAppearanceBackground } = require("../../../web/appearance-background.js");

function chunk(type, payload) {
  const head = Buffer.alloc(8); head.write(type, 0); head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, payload.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}
function webp(chunks) {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const head = Buffer.alloc(8); head.write("RIFF"); head.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([head, body]));
}

test("sniff checks file signatures rather than names", () => {
  assert.equal(sniff(new Uint8Array([137,80,78,71,13,10,26,10])), "png");
  assert.throws(() => sniff(new Uint8Array(Buffer.from("image/png"))), /仅支持/);
});

test("animated WebP first frame is repackaged as static RIFF WebP", () => {
  const vp8x = Buffer.alloc(10); vp8x[0] = 2; vp8x.writeUIntLE(4, 4, 3); vp8x.writeUIntLE(4, 7, 3);
  const frame = Buffer.alloc(16); frame[0] = 1; frame[3] = 1; frame.writeUIntLE(1, 6, 3); frame.writeUIntLE(1, 9, 3);
  const nested = chunk("VP8L", Buffer.from([0x2f, 0, 0, 0, 0]));
  const anmf = Buffer.concat([frame, nested]);
  const source = webp([chunk("VP8X", vp8x), chunk("ANIM", Buffer.from([10,20,30,255,0,0])), chunk("ANMF", anmf)]);
  const result = parseWebP(source);
  assert.equal(result.animated, true);
  assert.equal(Buffer.from(result.bytes).toString("ascii", 0, 4), "RIFF");
  assert.equal(Buffer.from(result.bytes).toString("ascii", 8, 12), "WEBP");
  assert.equal(result.bytes[20] & 2, 0);
  assert.equal(result.frameWidth, 2);
  assert.equal(result.frameHeight, 2);
  assert.equal(result.x, 2);
  assert.equal(result.y, 2);
  assert.deepEqual(Array.from(result.background), [10,20,30,255]);
  assert.equal(Buffer.from(result.bytes).includes(Buffer.from("ANMF")), false);
});

test("rejects malformed WebP RIFF sizes and over-limit frames", () => {
  const broken = new Uint8Array(Buffer.from("RIFF\0\0\0\0WEBP"));
  assert.throws(() => parseWebP(broken), /长度不匹配/);
  const vp8x = Buffer.alloc(10); vp8x[0] = 2;
  const frame = Buffer.alloc(16); frame.writeUIntLE(4000, 6, 3); frame.writeUIntLE(4000, 9, 3);
  const tooLarge = webp([chunk("VP8X", vp8x), chunk("ANMF", Buffer.concat([frame, chunk("VP8 ", Buffer.from([1,2]))]))]);
  assert.throws(() => parseWebP(tooLarge), /16M/);
  assert.equal(MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_PIXELS, 16 * 1000 * 1000);
});

test("JPEG SOF and static WebP headers expose dimensions before decoding", () => {
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0x10,0,0x10,0,3,1,0x11,0,2,0x11,0,0xff,0xd9]);
  assert.deepEqual(jpegDimensions(new Uint8Array(jpeg)), { width: 4096, height: 4096 });
  assert.throws(() => imageDimensions(new Uint8Array(jpeg), "jpeg"), /16M/);
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f;
  vp8l.writeUInt32LE((4000 | (4000 << 14)) >>> 0, 1);
  const parsed = parseWebP(webp([chunk("VP8L", vp8l)]));
  assert.deepEqual({ width: parsed.width, height: parsed.height }, { width: 4001, height: 4001 });
  assert.throws(() => imageDimensions(parsed.bytes, "webp", parsed), /16M/);
  const lossy = Buffer.alloc(10); lossy.set([0,0,0,0x9d,0x01,0x2a]); lossy.writeUInt16LE(32, 6); lossy.writeUInt16LE(16, 8);
  const lossyInfo = parseWebP(webp([chunk("VP8 ", lossy)]));
  assert.deepEqual({ width: lossyInfo.width, height: lossyInfo.height }, { width: 32, height: 16 });
  const extended = Buffer.alloc(10); extended.writeUIntLE(127, 4, 3); extended.writeUIntLE(63, 7, 3);
  const extendedInfo = parseWebP(webp([chunk("VP8X", extended), chunk("VP8L", Buffer.from([0x2f,0,0,0,0]))]));
  assert.deepEqual({ width: extendedInfo.width, height: extendedInfo.height }, { width: 128, height: 64 });
});

test("GIF framing retains only the first image and appends trailer", () => {
  const onePixelGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const first = gifFirstFrame(new Uint8Array(onePixelGif));
  assert.equal(Buffer.from(first).toString("ascii", 0, 6), "GIF89a");
  assert.equal(first[first.length - 1], 0x3b);
  assert.deepEqual(Buffer.from(first.subarray(0, first.length - 1)), onePixelGif.subarray(0, onePixelGif.length - 1));
  assert.deepEqual(Buffer.from(first.subarray(13, 19)), onePixelGif.subarray(13, 19), "preserves the global color table");
  const imageStart = onePixelGif.indexOf(0x2c), frame = onePixelGif.subarray(imageStart, onePixelGif.length - 1);
  const animated = Buffer.concat([onePixelGif.subarray(0, onePixelGif.length - 1), frame, Buffer.from([0x3b])]);
  assert.equal(parseGif(new Uint8Array(animated)).animated, true);
  const outsideSecond = Buffer.from(animated); outsideSecond[imageStart + frame.length + 1] = 1;
  assert.throws(() => parseGif(new Uint8Array(outsideSecond)), /超出逻辑画布/);
  assert.throws(() => parseGif(new Uint8Array(Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1,0,1,0,0,0,0,0x3b])]))), /没有图像帧/);
  const outside = Buffer.from(onePixelGif); outside[20] = 1;
  assert.throws(() => parseGif(new Uint8Array(outside)), /超出逻辑画布/);
  assert.equal(sniff(new Uint8Array(onePixelGif)), "gif");
});

test("initialization restores without rewriting IndexedDB, enables controls, then deletes saved background", async () => {
  const previous = { document: globalThis.document, window: globalThis.window, indexedDB: globalThis.indexedDB,
    localStorage: globalThis.localStorage, fetch: globalThis.fetch, Image: globalThis.Image, URL: globalThis.URL };
  const store = { current: { staticBlob: new Blob([new Uint8Array([1])], { type: "image/png" }), animatedBlob: null }, records: new Map() };
  let puts = 0, deletes = 0, ids = 0, fetches = 0, failPut = false, abortPutAfterSuccess = false; const revoked = [], windowListeners = {}, documentListeners = {}, mediaListeners = [], images = [];
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.style = {setProperty(k,v){this[k]=v;}}; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.children = []; this.value = ""; this.disabled = false; this.hidden = false; this.checked = false; }
    setAttribute(k, v) { this.attributes[k] = v; } removeAttribute(k) { delete this.attributes[k]; if (k === "src") delete this.src; }
    addEventListener(k, cb) { (this.listeners[k] ||= []).push(cb); }
    async emit(k, event = {}) { for (const cb of this.listeners[k] || []) await cb(event); }
    prepend(el) { this.children.unshift(el); }
    append(el) { this.children.push(el); }
    replaceChildren() { this.children = []; }
  }
  const els = new Map();
  for (const id of ["appearanceBackgroundGallery", "appearanceBackgroundDelete", "appearanceUiTransparency", "appearanceUiTransparencyPercent", "appearanceBackgroundBuiltin", "appearanceBackgroundFile", "appearanceBackgroundRemove", "appearanceBackgroundOpacity", "appearanceBackgroundPercent", "appearanceBackgroundAnimation", "appearanceBackgroundAnimationRow", "appearanceBackgroundStatus"]) els.set(id, new Element());
  const document = { body: new Element("body"), documentElement: new Element("html"), hidden: false,
    getElementById: id => els.get(id) || null, createElement: tag => new Element(tag), addEventListener(k, cb) { documentListeners[k] = cb; } };
  const media = { matches: false, addEventListener(k, cb) { mediaListeners.push(cb); } };
  const window = { matchMedia: () => media, addEventListener(k, cb) { windowListeners[k] = cb; } };
  class FakeImage {
    constructor() { images.push(this); }
    set src(v) { this._src = v; this.naturalWidth = 1; this.naturalHeight = 1; queueMicrotask(() => this.onload?.()); }
    get src() { return this._src; }
    removeAttribute(k) { if (k === "src") this._src = ""; }
  }
  const URL = { createObjectURL: () => `blob:test-${++ids}`, revokeObjectURL: url => revoked.push(url) };
  const tx = () => ({ objectStore: () => ({
    get: key => req(() => key === "current" ? store.current : store.records.get(key)),
    getAll: () => req(() => [...store.records.values(), ...(store.current ? [store.current] : [])]),
    put: (value, key = "current") => {
      puts++;
      const previousValue = store.current;
      if (!failPut && !abortPutAfterSuccess) { if (key === "current") store.current = value; else store.records.set(key, value); }
      const request = {};
      queueMicrotask(() => {
        if (failPut) { request.error = new Error("quota failure"); request.onerror?.(); queueMicrotask(() => { store.current = previousValue; currentTx.onabort?.(); }); }
        else { request.result = undefined; request.onsuccess?.(); queueMicrotask(() => { if (abortPutAfterSuccess) store.current = previousValue; if (abortPutAfterSuccess) currentTx.onabort?.(); else currentTx.oncomplete?.(); }); }
      });
      return request;
    },
    delete: key => { deletes++; if(key === "current")store.current = undefined;else store.records.delete(key); return req(() => undefined); },
  }), oncomplete: null, onabort: null, onerror: null });
  function req(result) {
    const request = {};
    queueMicrotask(() => { request.result = result(); request.onsuccess?.(); queueMicrotask(() => currentTx.oncomplete?.()); });
    return request;
  }
  let currentTx;
  globalThis.indexedDB = { open: () => {
    const request = {};
    queueMicrotask(() => { request.result = { objectStoreNames: { contains: () => true }, transaction: () => (currentTx = tx()), close() {} }; request.onsuccess?.(); });
    return request;
  } };
  globalThis.document = document; globalThis.window = window; globalThis.Image = FakeImage; globalThis.URL = URL;
  globalThis.fetch = async () => { fetches++; return { ok: false, status: 404 }; };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  try {
    initAppearanceBackground();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(els.get("appearanceUiTransparency").value, "20");
    assert.equal(els.get("appearanceUiTransparency").disabled, false);
    assert.equal(document.documentElement.style["--ui-panel-alpha"], "80%");
    const imageOpacity = document.body.children[0].style.opacity;
    els.get("appearanceUiTransparency").value = "60";
    await els.get("appearanceUiTransparency").emit("input");
    assert.equal(document.documentElement.style["--ui-panel-alpha"], "40%");
    assert.equal(document.body.children[0].style.opacity, imageOpacity, "UI transparency does not affect the image visibility");
    assert.equal(els.get("appearanceUiTransparencyPercent").value, "60%");
    assert.equal(puts, 2, "legacy current background migrates once into an independent gallery item and selection pointer");
    assert.match(store.current.id, /^browser-/);
    assert.equal(store.current.name, "旧背景");
    assert.equal(store.records.get(store.current.id).name, "旧背景", "legacy image is retained as a selectable gallery item");
    assert.equal(els.get("appearanceBackgroundGallery").children.length, 2, "active pointer and gallery record represent one selectable image");
    assert.equal(els.get("appearanceBackgroundRemove").disabled, false);
    assert.equal(els.get("appearanceBackgroundOpacity").disabled, false);
    assert.equal(document.body.children[0].id, "appearanceBackgroundLayer");
    assert.equal(images.at(-1).src, "", "temporary decode image releases its URL");
    assert.equal(images.at(-1).onload, null, "temporary decode image releases its callback");
    const savedBeforeFailure = store.current, shownBeforeFailure = document.body.children[0].src;
    assert.equal(fetches, 0, "bundled background is not loaded or enabled on startup");
    assert.equal(els.get("appearanceBackgroundBuiltin").attributes["aria-pressed"], "false");
    await els.get("appearanceBackgroundBuiltin").emit("click");
    assert.equal(fetches, 1, "bundled asset is only fetched after explicit selection");
    assert.equal(els.get("appearanceBackgroundBuiltin").disabled, false);
    assert.equal(document.body.children[0].src, shownBeforeFailure, "asset loading failure retains the prior background");
    els.get("appearanceBackgroundFile").files = [{ size: MAX_BYTES + 1, arrayBuffer: async () => { throw new Error("must reject before reading"); } }];
    await els.get("appearanceBackgroundFile").emit("change");
    assert.equal(els.get("appearanceBackgroundFile").value, "", "same file can be selected again after rejection");
    assert.equal(store.current, savedBeforeFailure, "rejected replacement leaves the old IndexedDB value intact");
    assert.equal(document.body.children[0].src, shownBeforeFailure, "rejected replacement leaves the old display intact");
    const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    const pngBacking = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    failPut = true;
    els.get("appearanceBackgroundFile").files = [{ size: png.length, arrayBuffer: async () => pngBacking }];
    await els.get("appearanceBackgroundFile").emit("change");
    assert.equal(store.current, savedBeforeFailure, "aborted IndexedDB transaction preserves old data");
    assert.equal(document.body.children[0].src, shownBeforeFailure, "aborted IndexedDB transaction preserves old display");
    abortPutAfterSuccess = true;
    els.get("appearanceBackgroundFile").files = [{ size: png.length, arrayBuffer: async () => pngBacking }];
    await els.get("appearanceBackgroundFile").emit("change");
    assert.equal(store.current, savedBeforeFailure, "transaction abort after request success rolls back data");
    assert.equal(document.body.children[0].src, shownBeforeFailure, "transaction abort after request success preserves display");
    abortPutAfterSuccess = false;
    failPut = false;
    await els.get("appearanceBackgroundRemove").emit("click");
    assert.equal(deletes, 1);
    assert.equal(store.current, undefined);
    assert.equal(els.get("appearanceUiTransparency").disabled, true);
    assert.equal(document.documentElement.dataset.backgroundVisible, "false");
    assert.equal(els.get("appearanceBackgroundRemove").disabled, true);
    assert.match(els.get("appearanceBackgroundStatus").textContent, /已关闭/);

    const still = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    const frameStart = still.indexOf(0x2c), frame = still.subarray(frameStart, still.length - 1);
    const gif = Buffer.concat([still.subarray(0, still.length - 1), frame, Buffer.from([0x3b])]);
    const backing = gif.buffer.slice(gif.byteOffset, gif.byteOffset + gif.byteLength);
    els.get("appearanceBackgroundFile").files = [{ name: "wallpaper.gif", size: gif.length, arrayBuffer: async () => backing }];
    await els.get("appearanceBackgroundFile").emit("change");
    assert.equal(puts, 8, "legacy migration plus two failed writes and one successful upload each write a gallery item and selection record");
    assert.equal(store.current.name, "wallpaper.gif", "browser gallery entries retain the uploaded filename");
    assert.equal(els.get("appearanceBackgroundFile").value, "");
    assert.equal(els.get("appearanceBackgroundRemove").disabled, false);
    assert.equal(els.get("appearanceBackgroundAnimationRow").hidden, false);
    assert.equal(els.get("appearanceBackgroundAnimation").checked, true, "animated media starts unless reduced motion is active");
    const activeUrl = document.body.children[0].src;
    media.matches = true; mediaListeners[0]({ matches: true });
    assert.equal(els.get("appearanceBackgroundAnimation").checked, false);
    media.matches = false; mediaListeners[0]({ matches: false });
    assert.equal(els.get("appearanceBackgroundAnimation").checked, true, "without an explicit choice playback follows system preference");
    media.matches = true; mediaListeners[0]({ matches: true });
    assert.equal(els.get("appearanceBackgroundAnimation").checked, false);
    await els.get("appearanceBackgroundAnimation").emit("change");
    assert.equal(els.get("appearanceBackgroundAnimation").checked, false);
    media.matches = false; mediaListeners[0]({ matches: false });
    assert.equal(els.get("appearanceBackgroundAnimation").checked, false, "explicit pause survives system preference changes");
    els.get("appearanceBackgroundAnimation").checked = true;
    await els.get("appearanceBackgroundAnimation").emit("change");
    assert.notEqual(document.body.children[0].src, activeUrl);
    let animatedUrl = document.body.children[0].src;
    document.hidden = true; documentListeners.visibilitychange();
    assert.equal(document.body.children[0].src, undefined);
    assert.ok(revoked.includes(animatedUrl), "hidden document revokes animation URL");
    document.hidden = false; documentListeners.visibilitychange();
    animatedUrl = document.body.children[0].src;
    els.get("appearanceBackgroundOpacity").value = "0";
    await els.get("appearanceBackgroundOpacity").emit("input");
    assert.equal(document.body.children[0].src, undefined, "zero opacity detaches animation source");
    assert.ok(revoked.includes(animatedUrl), "zero opacity revokes animation URL");
    els.get("appearanceBackgroundOpacity").value = "30";
    await els.get("appearanceBackgroundOpacity").emit("input");
    windowListeners.pagehide();
    assert.equal(document.body.children[0].src, undefined);
    assert.ok(revoked.length > 0);
    windowListeners.pageshow();
    assert.match(document.body.children[0].src, /^blob:test-/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
