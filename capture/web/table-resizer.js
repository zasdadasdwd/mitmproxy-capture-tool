// 为页面里的表格列加拖动手柄，内容过宽时由原滚动容器横向查看。
(() => {
  const minimum = 40;
  const maximum = 1200;
  const resizeObservers = new Map();

  function tableKey(table) {
    if (table.closest(".flow-list")) return "requests";
    if (table.closest(".history-main")) return "history";
    const headers = table.closest(".message-header-table");
    if (headers) return `headers.${headers.id || "default"}`;
    return table.id || table.className || "table";
  }

  function makeResizable(table) {
    if (table.dataset.resizable === "true") return;
    const firstRow = table.querySelector("tr");
    if (!firstRow) return;
    const cells = [...firstRow.cells];
    if (cells.length < 2 || table.getBoundingClientRect().width === 0) return;
    table.dataset.resizable = "true";
    table.classList.add("resizable-table");

    const key = `capture.table-columns.${tableKey(table)}`;
    const requestTable = Boolean(table.closest(".flow-list"));
    // 按参考比例分配默认列宽，窄列表保留可读下限，余量优先给地址。
    const defaultRequestWidths = (available) => {
      const ratios = [4, 8, 9, 43, 14, 8, 8, 6];
      const floors = [40, 64, 78, 180, 112, 64, 64, 52];
      const result = ratios.map((ratio, index) => Math.max(floors[index], available * ratio / 100));
      result[3] = Math.max(floors[3], available - (result.reduce((sum, width) => sum + width, 0) - result[3]));
      return result;
    };
    let customWidths = false;
    let widths = cells.map((cell) => Math.max(minimum, Math.round(cell.getBoundingClientRect().width)));
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (Array.isArray(saved) && saved.length === widths.length) {
        customWidths = true;
        widths = saved.map((width) => Math.min(maximum, Math.max(minimum, Number(width) || minimum)));
      }
    } catch {
      // 隐私模式或损坏的旧值只影响记住列宽，不影响拖动。
    }

    if (requestTable && !customWidths && widths.length === 8) {
      widths = defaultRequestWidths(table.parentElement?.getBoundingClientRect?.().width || table.getBoundingClientRect().width);
    }
    // 用独立基准保存列宽比例，避免连续收窄时最小列宽挤掉原比例。
    let preferredWidths = [...widths];
    let group = table.querySelector(":scope > colgroup");
    if (!group) {
      group = document.createElement("colgroup");
      table.insertBefore(group, table.firstChild);
    }
    group.replaceChildren(...cells.map(() => document.createElement("col")));
    const applyWidths = () => {
      [...group.children].forEach((column, index) => {
        column.style.width = `${widths[index]}px`;
      });
      // 列宽与实际边界一致；有空余时允许留白，不让浏览器隐式拉伸各列。
      table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    };
    applyWidths();
    // 请求列表始终随面板恢复宽度，手调列宽保留其比例；其他表格沿用固定列宽。
    if (typeof ResizeObserver !== "undefined" && table.parentElement) {
      const observer = new ResizeObserver(([entry]) => {
        if (!table.isConnected) { observer.disconnect(); return; }
        if ((!requestTable && customWidths) || entry.contentRect.width <= 0) return;
        const total = preferredWidths.reduce((sum, width) => sum + width, 0);
        widths = requestTable && !customWidths && widths.length === 8
          ? defaultRequestWidths(entry.contentRect.width)
          : preferredWidths.map((width) => Math.max(minimum, width * entry.contentRect.width / total));
        applyWidths();
      });
      observer.observe(table.parentElement);
      resizeObservers.set(table, observer);
    }

    cells.forEach((cell, index) => {
      cell.classList.add("resizable-cell");
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "column-resizer";
      handle.setAttribute("aria-label", `拖动调整第 ${index + 1} 列宽度`);
      handle.title = "拖动调整列宽";
      handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        customWidths = true;
        widths[index] = Math.min(
          maximum,
          Math.max(minimum, widths[index] + (event.key === "ArrowRight" ? 16 : -16)),
        );
        preferredWidths = [...widths];
        applyWidths();
        try {
          localStorage.setItem(key, JSON.stringify(widths));
        } catch {
          // 键盘调整仍在当前页面生效。
        }
      });
      handle.addEventListener("pointerdown", (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        customWidths = true;
        const startX = event.clientX;
        const startWidth = widths[index];
        handle.setPointerCapture(event.pointerId);
        function move(pointer) {
          if (pointer.pointerId !== event.pointerId) return;
          widths[index] = Math.min(maximum, Math.max(minimum, startWidth + pointer.clientX - startX));
          applyWidths();
        }
        function finish() {
          preferredWidths = [...widths];
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", finish);
          handle.removeEventListener("pointercancel", finish);
          handle.removeEventListener("lostpointercapture", finish);
          try {
            localStorage.setItem(key, JSON.stringify(widths));
          } catch {
            // 列宽仍保持在本页生效，只是不跨页面保存。
          }
        }
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", finish, { once: true });
        handle.addEventListener("pointercancel", finish, { once: true });
        handle.addEventListener("lostpointercapture", finish, { once: true });
      });
      cell.append(handle);
    });
  }

  function refreshTables() {
    // 详情刷新会替换整个头部表格，主动解除旧表格监听，防止长时间抓包时累积。
    for (const [table, observer] of resizeObservers) {
      if (!table.isConnected) { observer.disconnect(); resizeObservers.delete(table); }
    }
    document.querySelectorAll("table").forEach(makeResizable);
  }

  refreshTables();
  // 批量插入行/JSON 树时每帧只扫描一次，隐藏弹窗打开后再初始化列宽。
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; refreshTables(); });
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["open", "hidden", "class"],
  });
})();
