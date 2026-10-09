/** Shared viewport fitting for floating menus; request data and actions stay with their owners. */
(function (root) {
  "use strict";
  /** Pure geometry: flip toward available space and clamp dimensions inside the viewport. */
  function fitFloatingPanel(anchor, size, viewport) {
    const edge = 8, gap = 6;
    const width = Math.max(1, Math.min(size.width, viewport.width - edge * 2));
    const left = Math.max(viewport.left + edge, Math.min(anchor.left, viewport.left + viewport.width - edge - width));
    const floor = viewport.top + viewport.height - edge;
    const ceiling = viewport.top + edge;
    const below = Math.max(0, floor - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - gap - ceiling);
    const up = below < size.height && above > below;
    const maxHeight = Math.max(1, Math.min(size.height, up ? above : below, viewport.height - edge * 2));
    const top = Math.max(ceiling, Math.min(up ? anchor.top - gap - maxHeight : anchor.bottom + gap, floor - maxHeight));
    return {left, top, width, maxHeight, placement: up ? "above" : "below"};
  }
  if (typeof module !== "undefined") module.exports = {fitFloatingPanel};
  if (!root.document) return;
  const entries = [], active = new Set();
  let frame = 0;
  const viewport = () => {
    const v = root.visualViewport;
    return {left: v?.offsetLeft || 0, top: v?.offsetTop || 0, width: v?.width || root.innerWidth, height: v?.height || root.innerHeight};
  };
  /** Read owner state synchronously: input may arrive before the positioning frame. */
  function openEntries() {
    return entries.filter(entry => (entry.owner.tagName === "DETAILS" ? entry.owner.open : !entry.panel.hidden) && entry.trigger.getClientRects().length);
  }
  function close(entry, focus = false) {
    if (entry.owner.tagName === "DETAILS") entry.owner.open = false;
    else entry.panel.hidden = true;
    entry.trigger.setAttribute("aria-expanded", "false");
    if (typeof entry.panel.hidePopover === "function" && entry.panel.matches(":popover-open")) entry.panel.hidePopover();
    active.delete(entry);
    if (focus) entry.trigger.focus();
  }
  function place(entry) {
    const {panel, trigger} = entry;
    const v = viewport();
    // The top layer preserves DOM ancestry while escaping scroll containers and stacking contexts.
    if (typeof panel.showPopover === "function" && !panel.matches(":popover-open")) panel.showPopover();
    panel.style.removeProperty("--floating-height");
    panel.style.setProperty("--floating-width", Math.min(entry.preferredWidth, v.width - 16) + "px");
    const anchor = trigger.getBoundingClientRect();
    const size = {width: entry.preferredWidth, height: panel.scrollHeight + 2};
    const position = fitFloatingPanel(anchor, size, v);
    panel.style.setProperty("--floating-width", position.width + "px");
    panel.style.setProperty("--floating-height", position.maxHeight + "px");
    panel.style.setProperty("--floating-left", position.left + "px");
    panel.style.setProperty("--floating-top", position.top + "px");
    // Older WebKit fallback: correct fixed positioning relative to a containing ancestor.
    if (typeof panel.showPopover !== "function") {
      const measured = panel.getBoundingClientRect();
      panel.style.setProperty("--floating-left", (position.left + position.left - measured.left) + "px");
      panel.style.setProperty("--floating-top", (position.top + position.top - measured.top) + "px");
    }
    panel.dataset.placement = position.placement;
  }
  function sync() {
    frame = 0;
    for (const entry of entries) {
      const open = entry.owner.tagName === "DETAILS" ? entry.owner.open : !entry.panel.hidden;
      if (!open || !entry.trigger.getClientRects().length) {
        if (active.has(entry)) close(entry);
        continue;
      }
      if (!active.has(entry)) {
        for (const other of [...active]) close(other);
        active.add(entry);
      }
      entry.trigger.setAttribute("aria-expanded", "true");
      place(entry);
    }
  }
  function schedule() {
    if (!frame) frame = root.requestAnimationFrame(sync);
  }
  function initialize() {
    const selector = ".theme-options, #filterPanel, .flow-actions-panel, .replay-menu-panel, .detail-policy-options, .detail-export-options";
    for (const panel of root.document.querySelectorAll(selector)) {
      const owner = panel.closest("details") || panel;
      const trigger = owner.tagName === "DETAILS" ? owner.querySelector("summary") : panel.id === "filterPanel" ? root.document.getElementById("toggleFilters") : panel.parentElement.querySelector("button");
      if (!trigger) continue;
      const preferredWidth = panel.id === "filterPanel" ? 650 : panel.classList.contains("replay-menu-panel") || panel.classList.contains("flow-actions-panel") ? 340 : panel.classList.contains("detail-policy-options") ? 280 : panel.classList.contains("theme-options") ? 160 : 200;
      entries.push({owner, trigger, panel, preferredWidth});
      if (panel.id !== "filterPanel") trigger.setAttribute("aria-haspopup", "menu");
      if (panel.classList.contains("detail-policy-options") || panel.classList.contains("detail-export-options")) {
        panel.setAttribute("role", "menu");
        for (const item of panel.querySelectorAll("button")) item.setAttribute("role", "menuitem");
      }
      panel.classList.add("floating-panel");
      if (typeof panel.showPopover === "function") panel.setAttribute("popover", "manual");
    }
    new MutationObserver(records => {
      if (records.some(record => entries.some(e => e.owner === record.target || e.panel === record.target || record.target.contains(e.trigger)))) schedule();
    }).observe(root.document.body, {subtree: true, attributes: true, attributeFilter: ["open", "hidden"]});
    root.document.addEventListener("toggle", schedule, true);
    root.document.addEventListener("close", schedule, true);
    for (const type of ["pointerdown", "click"]) root.document.addEventListener(type, event => {
      for (const entry of openEntries()) {
        const inGroup = entry.panel.id === "filterPanel" && entry.trigger.parentElement.contains(event.target);
        if (!entry.owner.contains(event.target) && !entry.trigger.contains(event.target) && !inGroup) close(entry);
      }
    }, true);
    root.document.addEventListener("keydown", event => {
      const opened = openEntries();
      if (!opened.length) return;
      if (event.key === "Escape") {
        for (const entry of opened) close(entry, true);
        event.preventDefault(); event.stopImmediatePropagation();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const entry = opened.find(e => e.owner.contains(event.target) || e.trigger.contains(event.target));
      // Filter inputs retain native caret/number/select behavior; theme has its own navigator.
      if (!entry || entry.panel.id === "filterPanel" || entry.panel.classList.contains("theme-options")) return;
      const items = [...entry.panel.querySelectorAll("button, a[href], [role='menuitem']")].filter(item => !item.disabled && item.getAttribute("aria-disabled") !== "true" && item.getClientRects().length);
      if (!items.length) return;
      const index = items.indexOf(root.document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
      items[next].focus();
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    root.addEventListener("resize", schedule);
    root.document.addEventListener("scroll", event => {
      if (active.size && ![...active].some(entry => entry.panel.contains(event.target))) schedule();
    }, true);
    root.visualViewport?.addEventListener("resize", schedule);
    root.visualViewport?.addEventListener("scroll", schedule);
    sync();
  }
  root.FloatingPanels = {fitFloatingPanel, schedule, hasOpen: () => openEntries().length > 0};
  if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", initialize, {once: true});
  else initialize();
})(typeof window === "undefined" ? {} : window);
