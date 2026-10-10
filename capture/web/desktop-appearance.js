/* Desktop-only persistence bridge. Image bytes cross pywebview transiently and never enter localStorage. */
(function (root) {
  "use strict";
  let edited = false, ready = false, snapshot = null, inflight = null, pendingBootstrap = null, nativeChain = Promise.resolve();
  const pending = {}, latest = {};
  function retryLatest(value) { for(const key of Object.keys(value)) pending[key]=latest[key] ?? value[key]; }
  function api() { return root.pywebview?.api || null; }
  function metadata(value) {
    if(!value)return null;
    return {initialized:value.initialized,settings:{...(value.settings || {})},backgrounds:(value.backgrounds || []).map(item=>({id:item.id,name:item.name,animated:!!item.animated,builtin:!!item.builtin}))};
  }
  function report(error) { document.dispatchEvent(new CustomEvent("desktop-appearance-error", {detail: error})); }
  function queueNative(method, args, current) {
    const bridge=api(); if(!bridge?.[method])return Promise.reject(new Error(`桌面外观接口不可用：${method}`));
    const operation=nativeChain.then(()=>current && !current() ? {stale:true} : bridge[method](...args));
    nativeChain=operation.catch(error=>{report(error);});
    return operation;
  }
  function save(patch) {
    Object.assign(latest, patch); Object.assign(pending, patch); edited = true;
    if (!api()?.save_appearance_settings) return Promise.resolve(null);
    const value = {...pending}; Object.keys(pending).forEach(key => delete pending[key]);
    return queueNative("save_appearance_settings", [value]).catch(() => { retryLatest(value); return null; });
  }
  function flushPending() {
    if(!Object.keys(pending).length)return;
    const value={...pending};Object.keys(pending).forEach(key=>delete pending[key]);
    queueNative("save_appearance_settings",[value]).catch(()=>{retryLatest(value);});
  }
  async function bootstrap() {
    const bridge=api(); if(!bridge?.get_appearance)return null;
    if(ready)return snapshot;
    if(inflight)return inflight;
    inflight=(async()=>{
      const value=await bridge.get_appearance(); snapshot=metadata(value); ready=true;
      let detail={...(value || {})};
      if(value?.initialized===false && !(value?.backgrounds || []).length) {
        try {
          const old=JSON.parse(localStorage.getItem("capture.appearance.background") || "{}");
          const theme=localStorage.getItem("capture.theme"), migration={};
          if(["light","dark","ocean","paper","graphite"].includes(theme))migration.theme=theme;
          if(Number.isFinite(old.opacity))migration.opacity=Math.round(Math.max(0,Math.min(100,old.opacity)));
          if(Number.isFinite(old.uiTransparency))migration.uiTransparency=Math.round(Math.max(0,Math.min(100,old.uiTransparency)));
          if(typeof old.animation==="boolean")migration.animation=old.animation;
          if(Object.keys(migration).length) {
            detail.settings={...(value.settings || {}),...migration};
            if(edited) flushPending(); else { await queueNative("save_appearance_settings",[migration]); snapshot.settings=detail.settings; }
          }
          detail.migrateLegacyBackground=true;
        } catch(error) { report(error); }
      }
      if(!edited && detail.settings?.theme && root.applyTheme)root.applyTheme(detail.settings.theme,false);
      if(edited)flushPending();
      pendingBootstrap=detail;
      document.dispatchEvent(new CustomEvent("desktop-appearance-ready",{detail}));
      inflight=null;
      return snapshot;
    })().catch(error=>{ready=false;inflight=null;report(error);throw error;});
    return inflight;
  }
  root.DesktopAppearance={
    get active(){return !!api();},get snapshot(){return snapshot;},get ready(){return ready;},save,
    consumeBootstrapPayload(){const value=pendingBootstrap;pendingBootstrap=null;return value;},
    async refresh(includeBackground=true){const value=await queueNative("get_appearance",[includeBackground]);snapshot=metadata(value);ready=true;return value;},
    releasePayload(value){if(value?.background){value.background.static_b64="";value.background.animated_b64="";value.background=null;}},
    async storeBackground(payload,current){return queueNative("save_appearance_background",[payload],current);},
    async selectBackground(id){return queueNative("select_appearance_background",[id ?? null]);},
    async deleteBackground(id){return queueNative("delete_appearance_background",[id]);},
    restoreTheme:bootstrap
  };
  root.addEventListener?.("pywebviewready",bootstrap);
  if(api())bootstrap();
})(typeof window!=="undefined"?window:globalThis);
