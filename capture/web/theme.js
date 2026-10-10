// 在 CSS 加载前恢复主题；这里只持久化小型外观偏好，不保存图片。
const APPEARANCE_THEMES = [
  {id: "light", name: "白色", description: "冷灰背景 · 白色面板"},
  {id: "dark", name: "黑色", description: "炭灰背景 · 深灰面板"},
  {id: "ocean", name: "深海蓝", description: "深藏蓝 · 蓝灰 · 浅蓝"},
  {id: "paper", name: "暖纸色", description: "米白 · 暖白 · 棕橙"},
  {id: "graphite", name: "石墨紫", description: "深灰紫 · 灰紫 · 淡紫"},
];
function normalizeAppearanceTheme(theme) {
  return APPEARANCE_THEMES.some(item => item.id === theme) ? theme : "light";
}
function applyTheme(theme, persist = true) {
  const value = normalizeAppearanceTheme(theme);
  document.documentElement.dataset.theme = value;
  if (persist) {
    if (window.DesktopAppearance?.active) window.DesktopAppearance.save({theme: value});
    else {
      try { localStorage.setItem("capture.theme", value); }
      catch { /* 存储被禁用时仍允许即时切换。 */ }
      window.DesktopAppearance?.save({theme: value});
    }
  }
  document.dispatchEvent(new CustomEvent("appearance-theme-change", {detail: value}));
}
try { applyTheme(localStorage.getItem("capture.theme") || "light", false); }
catch { applyTheme("light", false); }
window.addEventListener("storage", event => {
  if (event.key === "capture.theme") applyTheme(event.newValue, false);
});
window.addEventListener("pywebviewready", () => {
  window.DesktopAppearance?.restoreTheme?.();
});

/** 各页面共用原生按钮菜单，主题切换不改变页面状态或查询条件。 */
function initThemePicker(button) {
  if (!button || button.dataset.themePicker) return;
  button.dataset.themePicker = "true";
  button.removeAttribute("aria-pressed");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const wrapper = document.createElement("div");
  wrapper.className = "theme-picker";
  button.parentNode.insertBefore(wrapper, button);
  wrapper.append(button);
  const menu = document.createElement("div");
  menu.className = "theme-options";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  wrapper.append(menu);
  const items = APPEARANCE_THEMES.map(theme => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = theme.name;
    item.setAttribute("role", "menuitemradio");
    item.dataset.themeId = theme.id;
    item.onclick = () => { applyTheme(theme.id); close(); button.focus(); };
    menu.append(item);
    return item;
  });
  const close = () => { menu.hidden = true; button.setAttribute("aria-expanded", "false"); };
  const sync = () => {
    const current = normalizeAppearanceTheme(document.documentElement.dataset.theme);
    const name = APPEARANCE_THEMES.find(theme => theme.id === current).name;
    const label = button.querySelector("#themeLabel");
    if (label) label.textContent = name;
    else button.textContent = `◐ ${name} ▾`;
    button.setAttribute("aria-label", `选择主题，当前${name}`);
    items.forEach(item => item.setAttribute("aria-checked", String(item.dataset.themeId === current)));
  };
  button.onclick = () => {
    const opening = menu.hidden;
    document.dispatchEvent(new CustomEvent("appearance-menu-open"));
    menu.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
  };
  button.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (menu.hidden) button.onclick();
    items[0].focus();
  });
  menu.addEventListener("keydown", event => {
    const index = items.indexOf(document.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!delta && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + delta + items.length) % items.length;
    items[next].focus();
  });
  if (typeof FloatingPanels === "undefined") {
  document.addEventListener("pointerdown", event => { if (!wrapper.contains(event.target)) close(); }, true);
  document.addEventListener("click", event => { if (!wrapper.contains(event.target)) close(); }, true);
  document.addEventListener("appearance-menu-open", close);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !menu.hidden) {
      close(); button.focus(); event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  }
  document.addEventListener("appearance-theme-change", sync);
  sync();
}

/** 设置页的五张小卡片只展示配色，与真实主题共用 CSS 变量。 */
function initThemeCards(container) {
  if (!container) return;
  for (const theme of APPEARANCE_THEMES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "theme-card";
    card.dataset.previewTheme = theme.id;
    const preview = document.createElement("span");
    preview.className = "theme-card-sample";
    preview.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) preview.append(document.createElement("i"));
    const name = document.createElement("strong"); name.textContent = theme.name;
    const note = document.createElement("small"); note.textContent = theme.description;
    card.append(preview, name, note);
    card.onclick = () => applyTheme(theme.id);
    container.append(card);
  }
  const sync = () => {
    for (const card of container.children) card.setAttribute("aria-pressed", String(card.dataset.previewTheme === document.documentElement.dataset.theme));
    const select = document.getElementById("settingsTheme");
    if (select) select.value = document.documentElement.dataset.theme;
  };
  document.addEventListener("appearance-theme-change", sync);
  sync();
}
if (typeof module !== "undefined") module.exports = {APPEARANCE_THEMES, normalizeAppearanceTheme};
