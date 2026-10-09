(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.initAppearanceBackground = api.initAppearanceBackground;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_BYTES = 20 * 1024 * 1024;
  const BUILTIN = { id: "wind-blink", url: "/backgrounds/wind-blink.webp", bytes: 10513478 };
  const MAX_PIXELS = 16 * 1000 * 1000;
  const DB_NAME = "capture-appearance";
  const STORE = "background";
  const META_KEY = "capture.appearance.background";
  const TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

  function u32(view, offset) { return view.getUint32(offset, true); }
  function fourCC(bytes, offset) { return String.fromCharCode(...bytes.subarray(offset, offset + 4)); }
  /** Wraps payload bytes in a padded RIFF chunk. */
  function chunk(type, payload) {
    const size = payload.length, out = new Uint8Array(8 + size + (size & 1));
    out.set(new TextEncoder().encode(type), 0);
    new DataView(out.buffer).setUint32(4, size, true); out.set(payload, 8); return out;
  }
  /** Builds a RIFF/WEBP container from already framed chunks. */
  function riff(chunks) {
    const bodyLength = chunks.reduce((n, c) => n + c.length, 4);
    const out = new Uint8Array(bodyLength + 8); out.set(new TextEncoder().encode("RIFF"));
    new DataView(out.buffer).setUint32(4, bodyLength, true); out.set(new TextEncoder().encode("WEBP"), 8);
    let offset = 12; for (const c of chunks) { out.set(c, offset); offset += c.length; } return out;
  }
  /** Validates WebP chunks and extracts a static image size or animation's first frame. */
  function parseWebP(bytes) {
    if (bytes.length < 12 || fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "WEBP") throw new Error("损坏的 WebP RIFF 文件");
    const declared = u32(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 4) + 8;
    if (declared !== bytes.length) throw new Error("WebP RIFF 长度不匹配");
    const chunks = []; let offset = 12;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error("WebP chunk 头不完整");
      const size = u32(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset + 4);
      const end = offset + 8 + size, padded = end + (size & 1);
      if (end > bytes.length || padded > bytes.length) throw new Error("WebP chunk 长度越界");
      chunks.push({ type: fourCC(bytes, offset), raw: bytes.slice(offset, padded), payload: bytes.slice(offset + 8, end) }); offset = padded;
    }
    const extended = chunks.find(c => c.type === "VP8X");
    const animated = !!(extended && (extended.payload[0] & 2));
    if (!animated) {
      const dimensions = webpDimensions(chunks, extended);
      return { animated: false, bytes, ...dimensions };
    }
    if (!extended || extended.payload.length < 10) throw new Error("动画 WebP 缺少有效 VP8X");
    const frame = chunks.find(c => c.type === "ANMF");
    if (!frame || frame.payload.length < 16) throw new Error("动画 WebP 缺少有效首帧 ANMF");
    const frameWidth = 1 + frame.payload[8] * 65536 + frame.payload[7] * 256 + frame.payload[6];
    const frameHeight = 1 + frame.payload[11] * 65536 + frame.payload[10] * 256 + frame.payload[9];
    if (frameWidth * frameHeight > MAX_PIXELS) throw new Error("动画 WebP 首帧超过 16M 像素限制");
    const sub = frame.payload.subarray(16); let pos = 0, imageChunks = [];
    while (pos < sub.length) {
      if (pos + 8 > sub.length) throw new Error("WebP 首帧子块不完整");
      const n = new DataView(sub.buffer, sub.byteOffset, sub.byteLength).getUint32(pos + 4, true);
      const end = pos + 8 + n, next = end + (n & 1);
      if (next > sub.length) throw new Error("WebP 首帧子块长度越界");
      const type = fourCC(sub, pos);
      if (!["ALPH", "VP8 ", "VP8L"].includes(type)) throw new Error("WebP 首帧包含不支持的子块");
      imageChunks.push(sub.slice(pos, next));
      pos = next;
    }
    const canvas = extended.payload.slice(); canvas[0] &= ~2; // Strip only animation flag; source metadata follows below.
    const canvasWidth = 1 + extended.payload[4] + extended.payload[5] * 256 + extended.payload[6] * 65536;
    const canvasHeight = 1 + extended.payload[7] + extended.payload[8] * 256 + extended.payload[9] * 65536;
    if (canvasWidth * canvasHeight > MAX_PIXELS) throw new Error("动画 WebP 画布超过 16M 像素限制");
    const x = 2 * (frame.payload[0] + frame.payload[1] * 256 + frame.payload[2] * 65536);
    const y = 2 * (frame.payload[3] + frame.payload[4] * 256 + frame.payload[5] * 65536);
    if (x + frameWidth > canvasWidth || y + frameHeight > canvasHeight) throw new Error("WebP 首帧超出画布");
    canvas[4] = frameWidth - 1; canvas[5] = (frameWidth - 1) >>> 8; canvas[6] = (frameWidth - 1) >>> 16;
    canvas[7] = frameHeight - 1; canvas[8] = (frameHeight - 1) >>> 8; canvas[9] = (frameHeight - 1) >>> 16;
    const metadataBefore = chunks.filter(c => c.type === "ICCP").map(c => c.raw);
    const metadataAfter = chunks.filter(c => c.type === "EXIF" || c.type === "XMP ").map(c => c.raw);
    if (!metadataBefore.length) canvas[0] &= ~0x20;
    if (!metadataAfter.some(raw => fourCC(raw, 0) === "EXIF")) canvas[0] &= ~0x08;
    if (!metadataAfter.some(raw => fourCC(raw, 0) === "XMP ")) canvas[0] &= ~0x04;
    const staticChunks = [chunk("VP8X", canvas), ...metadataBefore, ...imageChunks, ...metadataAfter];
    const anim = chunks.find(c => c.type === "ANIM");
    const background = anim?.payload.slice(0, 4) || new Uint8Array([0, 0, 0, 0]); // BGRA
    return { animated: true, bytes: riff(staticChunks), frameWidth, frameHeight,
      canvasWidth, canvasHeight,
      x, y, background, noBlend: !!(frame.payload[15] & 2) };
  }

  /** Reads dimensions from VP8X, lossy VP8, or lossless VP8L image headers. */
  function webpDimensions(chunks, extended) {
    if (extended) {
      if (extended.payload.length < 10) throw new Error("WebP VP8X 头不完整");
      return { width: 1 + extended.payload[4] + extended.payload[5] * 256 + extended.payload[6] * 65536,
        height: 1 + extended.payload[7] + extended.payload[8] * 256 + extended.payload[9] * 65536 };
    }
    const lossless = chunks.find(c => c.type === "VP8L");
    if (lossless) {
      const b = lossless.payload;
      if (b.length < 5 || b[0] !== 0x2f) throw new Error("WebP VP8L 头无效");
      const bits = b[1] + b[2] * 256 + b[3] * 65536 + b[4] * 16777216;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    const lossy = chunks.find(c => c.type === "VP8 ");
    if (lossy) {
      const b = lossy.payload;
      if (b.length < 10 || b[3] !== 0x9d || b[4] !== 0x01 || b[5] !== 0x2a) throw new Error("WebP VP8 帧头无效");
      return { width: (b[6] + b[7] * 256) & 0x3fff, height: (b[8] + b[9] * 256) & 0x3fff };
    }
    throw new Error("WebP 缺少可识别的图像尺寸头");
  }
  /** Returns pixel dimensions without decoding compressed image data. */
  function imageDimensions(bytes, type, parsedWebP = null, parsedGif = null) {
    let dimensions;
    if (type === "png") {
      if (bytes.length < 24) throw new Error("PNG 文件头不完整");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      dimensions = { width: view.getUint32(16), height: view.getUint32(20) };
    } else if (type === "jpeg") dimensions = jpegDimensions(bytes);
    else if (type === "gif") dimensions = { width: parsedGif.width, height: parsedGif.height };
    else if (type === "webp") dimensions = parsedWebP.animated
      ? { width: parsedWebP.canvasWidth, height: parsedWebP.canvasHeight }
      : { width: parsedWebP.width, height: parsedWebP.height };
    else throw new Error("不支持的图片类型");
    if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > MAX_PIXELS) {
      throw new Error("图片超过 16M 像素限制或尺寸无效");
    }
    return dimensions;
  }
  /** Scans JPEG marker segments for a start-of-frame dimensions record. */
  function jpegDimensions(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("JPEG 文件头无效");
    const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    let p = 2;
    while (p < bytes.length) {
      if (bytes[p++] !== 0xff) throw new Error("JPEG marker 无效");
      while (p < bytes.length && bytes[p] === 0xff) p++;
      if (p >= bytes.length) break;
      const marker = bytes[p++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > bytes.length) throw new Error("JPEG segment 长度不完整");
      const length = bytes[p] * 256 + bytes[p + 1];
      if (length < 2 || p + length > bytes.length) throw new Error("JPEG segment 长度越界");
      if (sof.has(marker)) {
        if (length < 7) throw new Error("JPEG SOF 记录不完整");
        return { height: bytes[p + 3] * 256 + bytes[p + 4], width: bytes[p + 5] * 256 + bytes[p + 6] };
      }
      p += length;
    }
    throw new Error("JPEG 缺少 SOF 尺寸记录");
  }
  /** Parses all RIFF chunks and returns immutable first-frame metadata. */
  function parseWebPFrame(bytes) { return parseWebP(bytes); }

  /** Decodes a single WebP frame and composites it over the specified animation background. */
  async function webpFirstFrameCanvas(parsed) {
    const frameBlob = new Blob([parsed.bytes], { type: TYPES.webp });
    const bitmap = await createImageBitmap(frameBlob);
    try {
      const canvas = document.createElement("canvas"); canvas.width = parsed.canvasWidth; canvas.height = parsed.canvasHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建首帧画布");
      context.fillStyle = `rgba(${parsed.background[2]},${parsed.background[1]},${parsed.background[0]},${parsed.background[3] / 255})`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (parsed.noBlend) context.clearRect(parsed.x, parsed.y, parsed.frameWidth, parsed.frameHeight);
      context.globalCompositeOperation = "source-over";
      context.drawImage(bitmap, parsed.x, parsed.y);
      return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("无法生成 WebP 首帧静态图")), "image/png"));
    } finally { bitmap.close(); }
  }

  /** Validates every GIF frame and returns a static file truncated after frame one. */
  function parseGif(bytes) {
    const sig = new TextDecoder().decode(bytes.subarray(0, 6));
    if (sig !== "GIF87a" && sig !== "GIF89a") throw new Error("GIF 签名无效");
    if (bytes.length < 13) throw new Error("GIF 文件头不完整");
    const screenWidth = bytes[6] | bytes[7] << 8, screenHeight = bytes[8] | bytes[9] << 8;
    if (!screenWidth || !screenHeight || screenWidth * screenHeight > MAX_PIXELS) throw new Error("GIF 画布超过 16M 像素限制或尺寸无效");
    let p = 13;
    const packed = bytes[10];
    if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
    if (p > bytes.length) throw new Error("GIF 全局色表越界");
    let frames = 0, firstFrameEnd = -1, ended = false;
    while (p < bytes.length) {
      const start = p, marker = bytes[p++];
      if (marker === 0x3b) { ended = true; break; }
      if (marker === 0x21) {
        if (p >= bytes.length) throw new Error("GIF 扩展块不完整");
        p++; while (true) { if (p >= bytes.length) throw new Error("GIF 子块不完整"); const n = bytes[p++]; if (!n) break; p += n; if (p > bytes.length) throw new Error("GIF 子块越界"); }
      } else if (marker === 0x2c) {
        if (p + 9 > bytes.length) throw new Error("GIF 图像描述符不完整");
        const imagePacked = bytes[p + 8]; p += 9;
        if (imagePacked & 0x80) p += 3 * (1 << ((imagePacked & 7) + 1));
        if (p > bytes.length) throw new Error("GIF 局部色表越界");
        if (p >= bytes.length) throw new Error("GIF 图像数据不完整"); p++;
        while (true) { if (p >= bytes.length) throw new Error("GIF 图像子块不完整"); const n = bytes[p++]; if (!n) break; p += n; if (p > bytes.length) throw new Error("GIF 图像子块越界"); }
        const width = bytes[start + 5] | bytes[start + 6] << 8, height = bytes[start + 7] | bytes[start + 8] << 8;
        const x = bytes[start + 1] | bytes[start + 2] << 8, y = bytes[start + 3] | bytes[start + 4] << 8;
        if (!width || !height || width * height > MAX_PIXELS) throw new Error("GIF 帧超过 16M 像素限制或尺寸无效");
        if (x + width > screenWidth || y + height > screenHeight) throw new Error("GIF 帧超出逻辑画布");
        frames++; if (frames === 1) firstFrameEnd = p;
      } else throw new Error("GIF 数据块类型无效");
    }
    if (!ended) throw new Error("GIF 缺少结束标记");
    if (!frames || firstFrameEnd < 0) throw new Error("GIF 没有图像帧");
    const out = new Uint8Array(firstFrameEnd + 1); out.set(bytes.subarray(0, firstFrameEnd)); out[firstFrameEnd] = 0x3b;
    return { bytes: out, animated: frames > 1, width: screenWidth, height: screenHeight };
  }
  /** Returns the validated first-frame-only GIF bytes. */
  function gifFirstFrame(bytes) { return parseGif(bytes).bytes; }

  /** Identifies the image format from its binary signature. */
  function sniff(bytes) {
    if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)) return "png";
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.subarray(0,6)))) return "gif";
    if (bytes.length >= 12 && fourCC(bytes,0) === "RIFF" && fourCC(bytes,8) === "WEBP") return "webp";
    throw new Error("仅支持有效 PNG、JPEG、WebP 或 GIF 文件");
  }
  /** Opens or creates the local IndexedDB object store. */
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error("浏览器 IndexedDB 不可用"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error || new Error("打开背景存储失败"));
    });
  }
  /** Completes only after the containing IndexedDB transaction commits. */
  async function dbRequest(mode, action, value) {
    const db = await openDb();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode), store = tx.objectStore(STORE), req = action === "put" ? store.put(value, "current") : action === "delete" ? store.delete("current") : store.get("current");
      let result;
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => reject(req.error || new Error("背景存储请求失败"));
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("背景存储事务失败"));
      tx.onerror = () => reject(tx.error || new Error("背景存储事务失败"));
    }); } finally { db.close(); }
  }

  /** Binds optional appearance controls, restores the saved Blob, and manages its object URL lifecycle. */
  function initAppearanceBackground() {
    if (typeof document === "undefined" || !document.body) return;
    if (document.documentElement.dataset.appearanceBackgroundReady) return;
    document.documentElement.dataset.appearanceBackgroundReady = "1";
    const get = id => document.getElementById(id);
    let layer = get("appearanceBackgroundLayer");
    if (!layer) { layer = document.createElement("img"); layer.id = "appearanceBackgroundLayer"; document.body.prepend(layer); }
    Object.assign(layer.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", objectFit: "cover", zIndex: "0", pointerEvents: "none", opacity: "0.3", display: "none" });
    layer.alt = ""; layer.setAttribute("aria-hidden", "true");
    const builtinButton = get("appearanceBackgroundBuiltin");
    const uiOpacity = get("appearanceUiTransparency"), uiPercent = get("appearanceUiTransparencyPercent");
    const fileInput = get("appearanceBackgroundFile"), removeButton = get("appearanceBackgroundRemove"), opacity = get("appearanceBackgroundOpacity"), percent = get("appearanceBackgroundPercent"), animation = get("appearanceBackgroundAnimation"), animationRow = get("appearanceBackgroundAnimationRow"), status = get("appearanceBackgroundStatus");
    const say = message => { if (status) status.textContent = message; };
    let selected = null, liveUrl = null, staticUrl = null, animationFrameUrl = null, generation = 0, shown = false;
    let uiTransparency = 20;
    let alpha = 30, animationSetting = null, animationOn = false, visible = !document.hidden, reduced = false;
    try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* Optional browser preference. */ }
    function prefs() {
      try {
        const value = JSON.parse(localStorage.getItem(META_KEY) || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    }
    const p = prefs(); if (Number.isFinite(p.opacity)) alpha = Math.min(100, Math.max(0, p.opacity));
    if (Number.isFinite(p.uiTransparency)) uiTransparency = Math.min(100, Math.max(0, p.uiTransparency));
    if (uiOpacity) { uiOpacity.value = String(uiTransparency); uiOpacity.disabled = true; }
    if (uiPercent) uiPercent.value = `${uiTransparency}%`;
    document.documentElement.style.setProperty("--ui-panel-alpha", `${100 - uiTransparency}%`);
    if (typeof p.animation === "boolean") animationSetting = p.animation;
    animationOn = animationSetting ?? !reduced;
    if (opacity) opacity.value = String(alpha); if (animation) animation.checked = animationOn;
    if (animationRow) animationRow.hidden = true;
    if (removeButton) removeButton.disabled = true;
    if (opacity) opacity.disabled = true;
    if (animation) animation.disabled = true;
    function savePrefs() { try { const value = { opacity: alpha, uiTransparency }; if (animationSetting !== null) value.animation = animationSetting; localStorage.setItem(META_KEY, JSON.stringify(value)); } catch { say("偏好设置无法保存；当前显示仍有效。"); } }
    /** Detaches the current source and releases the transient animation URL. */
    function stop() {
      layer.removeAttribute("src"); liveUrl = null;
      if (animationFrameUrl) { URL.revokeObjectURL(animationFrameUrl); animationFrameUrl = null; }
    }
    let dbQueue = Promise.resolve();
    /** Serializes writes and ignores operations superseded by a newer user action. */
    function queuedDb(token, mode, action, value) {
      const operation = dbQueue.then(() => token === generation ? dbRequest(mode, action, value) : { stale: true });
      dbQueue = operation.catch(() => {});
      return operation;
    }
    /** Applies opacity and playback preferences to the single background image layer. */
    function refresh() {
      const shouldShow = shown && alpha > 0;
      document.documentElement.dataset.backgroundVisible = String(shouldShow);
      document.documentElement.style.setProperty("--ui-panel-alpha", `${100 - uiTransparency}%`);
      layer.style.opacity = String(alpha / 100); layer.style.display = shouldShow ? "block" : "none";
      let src = null;
      if (shouldShow && visible) {
        if (selected?.animatedBlob && animationOn) {
          if (!animationFrameUrl) animationFrameUrl = URL.createObjectURL(selected.animatedBlob);
          src = animationFrameUrl;
        } else src = staticUrl;
      }
      if (src !== liveUrl) {
        layer.removeAttribute("src");
        if (liveUrl === animationFrameUrl && animationFrameUrl) { URL.revokeObjectURL(animationFrameUrl); animationFrameUrl = null; }
        liveUrl = src;
        if (src) layer.src = src;
      }
    }
    /** Decodes and validates a candidate, persists it atomically, then swaps the visible background. */
    async function useBlob(blob, animatedBlob, token, persist, builtin = null) {
      let candidate = URL.createObjectURL(blob);
      try {
        const dimensions = await new Promise((resolve, reject) => {
          const img = new Image();
          const cleanup = () => { img.onload = null; img.onerror = null; img.removeAttribute("src"); };
          img.onload = () => { const size = { width: img.naturalWidth, height: img.naturalHeight }; cleanup(); resolve(size); };
          img.onerror = () => { cleanup(); reject(new Error("图片无法解码")); };
          img.src = candidate;
        });
        if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > MAX_PIXELS) throw new Error("图片超过 16M 像素限制或尺寸无效");
        if (token !== generation) { URL.revokeObjectURL(candidate); return false; }
        if (persist) {
          const saved = await queuedDb(token, "readwrite", "put", { staticBlob: blob, animatedBlob, builtin });
          if (saved?.stale || token !== generation) { URL.revokeObjectURL(candidate); return false; }
        }
        stop();
        if (staticUrl) URL.revokeObjectURL(staticUrl);
        selected = { staticBlob: blob, animatedBlob, builtin };
        if (builtinButton) builtinButton.setAttribute("aria-pressed", String(builtin === BUILTIN.id)); shown = true; staticUrl = candidate; candidate = null;
        animationOn = animatedBlob ? (animationSetting ?? !reduced) : false;
        if (animationRow) animationRow.hidden = !animatedBlob;
        if (animation) { animation.disabled = !animatedBlob; animation.checked = !!animatedBlob && animationOn; }
        if (removeButton) removeButton.disabled = false;
        if (opacity) opacity.disabled = false;
        if (uiOpacity) uiOpacity.disabled = false;
        refresh(); if (persist) savePrefs(); if (token === generation) say(persist ? "背景已保存并显示。" : "已恢复本地背景。"); return true;
      } catch (error) { if (candidate) URL.revokeObjectURL(candidate); throw error; }
    }
    /** Restores a saved Blob without writing it back to IndexedDB. */
    async function restoreSaved(token) {
      try {
        const saved = await queuedDb(token, "readonly", "get");
        if (saved?.stale || token !== generation) return;
        if (saved instanceof Blob) await useBlob(saved, null, token, false);
        else if (saved?.staticBlob instanceof Blob) await useBlob(saved.staticBlob, saved.animatedBlob instanceof Blob ? saved.animatedBlob : null, token, false, saved.builtin === BUILTIN.id ? BUILTIN.id : null);
      } catch (error) { if (token === generation) say(`本地背景存储不可用：${error.message || error}`); }
    }
    /** Shares validation and first-frame extraction; only the fixed bundled asset is additionally checked against its exact size. */
    async function loadFile(file, token, builtin = null) {
      const limit = builtin === BUILTIN.id ? BUILTIN.bytes : MAX_BYTES;
      if (file.size > limit) throw new Error(builtin ? "内置背景文件大小异常" : "图片不能超过 20 MiB");
      const bytes = new Uint8Array(await file.arrayBuffer()), type = sniff(bytes);
      if (token !== generation) return;
      const parsedGif = type === "gif" ? parseGif(bytes) : null;
      const parsedWebp = type === "webp" ? parseWebPFrame(bytes) : null;
      imageDimensions(bytes, type, parsedWebp, parsedGif);
      let staticBlob = file, animatedBlob = null;
      if (type === "gif") { staticBlob = new Blob([parsedGif.bytes], { type: TYPES.gif }); if (parsedGif.animated) animatedBlob = file; }
      if (type === "webp" && parsedWebp.animated) { staticBlob = await webpFirstFrameCanvas(parsedWebp); animatedBlob = file; }
      if (token !== generation) return;
      await useBlob(staticBlob, animatedBlob, token, true, builtin);
    }
    async function reportFailure(error, token) {
      if (token !== generation) return;
      say(`背景未更改：${error.message || error}`);
      if (!selected) await restoreSaved(token);
    }
    if (fileInput) fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0]; if (!file) return;
      const token = ++generation;
      say("正在读取并验证背景…");
      try { await loadFile(file, token); }
      catch (error) { await reportFailure(error, token); }
      finally { if (token === generation) fileInput.value = ""; }
    });
    // Never request or activate the bundled animation during initialization.
    if (builtinButton) builtinButton.addEventListener("click", async () => {
      if (selected?.builtin === BUILTIN.id) return;
      const token = ++generation;
      builtinButton.disabled = true;
      say("正在加载内置背景…");
      try {
        const response = await fetch(BUILTIN.url);
        if (!response.ok) throw new Error(`内置背景加载失败（${response.status}）`);
        const file = await response.blob();
        if (token !== generation) return;
        if (file.size !== BUILTIN.bytes) throw new Error("内置背景文件不完整");
        await loadFile(file, token, BUILTIN.id);
      } catch (error) { await reportFailure(error, token); }
      finally { builtinButton.disabled = false; }
    });
    if (opacity) opacity.addEventListener("input", () => { alpha = Math.min(100, Math.max(0, Number(opacity.value) || 0)); opacity.value = String(alpha); if (percent) percent.value = `${alpha}%`; refresh(); savePrefs(); });
    if (percent && opacity) percent.value = `${alpha}%`;
    if (uiOpacity) uiOpacity.addEventListener("input", () => {
      uiTransparency = Math.min(100, Math.max(0, Number(uiOpacity.value) || 0));
      uiOpacity.value = String(uiTransparency);
      if (uiPercent) uiPercent.value = `${uiTransparency}%`;
      refresh(); savePrefs();
    });
    refresh();
    if (animation) animation.addEventListener("change", () => { animationSetting = animation.checked; animationOn = animationSetting; savePrefs(); refresh(); });
    if (removeButton) removeButton.addEventListener("click", async () => {
      const token = ++generation; removeButton.disabled = true;
      try {
        const deleted = await queuedDb(token, "readwrite", "delete"); if (deleted?.stale || token !== generation) return;
        stop(); shown = false; selected = null;
        if (builtinButton) builtinButton.setAttribute("aria-pressed", "false"); if (staticUrl) { URL.revokeObjectURL(staticUrl); staticUrl = null; }
        if (removeButton) removeButton.disabled = true; if (opacity) opacity.disabled = true;
        if (uiOpacity) uiOpacity.disabled = true;
        if (animation) { animation.checked = false; animation.disabled = true; }
        if (animationRow) animationRow.hidden = true; refresh(); say("背景已删除。");
      } catch (error) { if (token === generation) { if (removeButton) removeButton.disabled = !shown; say(`删除失败，已保留当前背景：${error.message || error}`); } }
    });
    document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (!visible) stop(); else refresh(); });
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", () => { visible = !document.hidden; refresh(); });
    let media = null; try { media = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { /* Optional browser preference. */ }
    media?.addEventListener?.("change", event => { reduced = event.matches; if (animationSetting === null) { animationOn = !reduced; if (animation) animation.checked = animationOn; } refresh(); });
    restoreSaved(generation);
  }
  return { initAppearanceBackground, parseWebP: parseWebPFrame, gifFirstFrame, parseGif, jpegDimensions, imageDimensions, sniff, MAX_BYTES, MAX_PIXELS };
});
