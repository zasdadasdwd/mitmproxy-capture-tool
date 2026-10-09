// 历史管理与实时抓包分开加载，避免启动时扫描并打开所有旧记录。
const $ = (id) => document.getElementById(id);
let sessions = [],
  deleting = null;
const selected = new Set();
let visibleSessions = [], deletingIds = [], deletingBusy = false;

/** API 错误显示给用户，不把失败当成已经删除。 */
async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = await response.text();
    try {
      message = JSON.parse(message).detail || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}
function notify(message) {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => ($("toast").style.display = "none"), 5000);
}
function action(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      notify(error.message);
    }
  };
}
function bytes(value) {
  if (value < 1024) return value + " B";
  if (value < 1048576) return (value / 1024).toFixed(1) + " KiB";
  return (value / 1048576).toFixed(1) + " MiB";
}

/** 渲染摘要和操作链接；流量字符串只放文本节点。 */
function render() {
  const keyword = $("historySearch").value.trim().toLowerCase();
  const kind = $("historyKind").value;
  const filtered = sessions.filter(
    (item) =>
      item.id.toLowerCase().includes(keyword) && (!kind || item.kind === kind),
  );
  visibleSessions = filtered;
  $("historyRows").replaceChildren();
  $("historyTotal").textContent =
    `${filtered.length} 个会话 · ${bytes(filtered.reduce((sum, item) => sum + item.disk_bytes, 0))}`;
  $("historyEmpty").hidden = !!filtered.length;
  for (const session of filtered) {
    const row = document.createElement("tr");
    const selection = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", `选择会话 ${session.id}`);
    checkbox.checked = selected.has(session.id);
    checkbox.onchange = () => {
      if (checkbox.checked) selected.add(session.id);
      else selected.delete(session.id);
      renderSelection();
    };
    selection.append(checkbox);
    row.append(selection);
    const time = document.createElement("td");
    const title = document.createElement("strong");
    title.textContent =
      session.id.slice(0, 10) +
      " " +
      session.id.slice(11, 19).replaceAll("-", ":");
    const id = document.createElement("small");
    id.textContent = session.id;
    time.append(title, id);
    row.append(time);
    for (const [index, value] of [
      session.kind === "replay" ? "重放" : "抓包",
      session.count,
      {
        stopped: "已结束",
        failed: "失败",
        cancelled: "已取消",
        running: "异常结束",
        interrupted: "异常结束",
      }[session.status] || session.status,
      bytes(session.disk_bytes),
    ].entries()) {
      const cell = document.createElement("td");
      cell.textContent = value;
      cell.dataset.label = ["类型", "记录数", "状态", "磁盘占用"][index];
      row.append(cell);
    }
    const controls = document.createElement("td");
    const open = document.createElement("a");
    open.textContent = "打开会话";
    open.href = "/?session=" + encodeURIComponent(session.id);
    const download = document.createElement("a");
    download.textContent = "下载会话包";
    download.href = `/api/history/${encodeURIComponent(session.id)}/download`;
    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.className = "danger";
    remove.onclick = () => openDeletion([session]);
    controls.className = "history-controls";
    controls.append(open, download, remove);
    row.append(controls);
    $("historyRows").append(row);
  }
  renderSelection();
}
/** 全选只作用于当前可见结果；隐藏选项仍保留并计入清理数量。 */
function renderSelection() {
  const count = visibleSessions.filter(item => selected.has(item.id)).length;
  $("historySelectAll").checked = !!visibleSessions.length && count === visibleSessions.length;
  $("historySelectAll").indeterminate = count > 0 && count < visibleSessions.length;
  $("historySelectAll").disabled = !visibleSessions.length || deletingBusy;
  $("historyClearSelected").disabled = !selected.size || deletingBusy;
  $("historyClearSelected").textContent = selected.size ? `清理选中 (${selected.size})` : "清理选中";
}
/** 单条保留会话 ID 确认；批量展示明确数量、体积并输入确认短语。 */
function openDeletion(items) {
  if (!items.length || deletingBusy) return;
  deletingIds = items.map(item => item.id);
  deleting = items.length === 1 ? items[0].id : `清理 ${items.length} 个会话`;
  $("deleteHistoryDescription").textContent = `将删除 ${items.length} 个会话，共 ${items.reduce((n, item) => n + item.count, 0)} 条记录，占用 ${bytes(items.reduce((n, item) => n + item.disk_bytes, 0))}。会话：${items.map(item => item.id).join("、")}`;
  $("deleteHistoryPrompt").textContent = `输入「${deleting}」确认`;
  $("deleteHistoryId").value = "";
  $("deleteHistoryConfirm").disabled = true;
  $("deleteHistoryDialog").showModal();
  $("deleteHistoryId").focus();
}
async function refresh() {
  sessions = await request("/api/history");
  const ids = new Set(sessions.map(item => item.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  render();
}
$("historySelectAll").onchange = () => {
  for (const item of visibleSessions) {
    if ($("historySelectAll").checked) selected.add(item.id);
    else selected.delete(item.id);
  }
  render();
};
$("historyClearSelected").onclick = () => openDeletion(sessions.filter(item => selected.has(item.id)));
$("historySearch").oninput = render;
$("historyKind").onchange = render;
$("historyRefresh").onclick = action(refresh);
$("deleteHistoryCancel").onclick = () => $("deleteHistoryDialog").close();
$("deleteHistoryId").oninput = () =>
  ($("deleteHistoryConfirm").disabled =
    $("deleteHistoryId").value !== deleting);
$("deleteHistoryForm").onsubmit = action(async (event) => {
  event.preventDefault();
  if (deletingBusy || !deleting || $("deleteHistoryId").value !== deleting) return;
  deletingBusy = true;
  $("deleteHistoryConfirm").disabled = true;
  $("deleteHistoryCancel").disabled = true;
  renderSelection();
  let removed = 0;
  try {
    for (const id of deletingIds) {
      await request(`/api/history/${encodeURIComponent(id)}`, {method: "DELETE"});
      selected.delete(id);
      removed++;
    }
    $("deleteHistoryDialog").close();
    deleting = null;
    deletingIds = [];
    notify(`已清理 ${removed} 个会话`);
  } catch (error) {
    $("deleteHistoryDialog").close();
    deleting = null;
    deletingIds = [];
    notify(`已清理 ${removed} 个会话，其余未完成：${error.message}`);
  } finally {
    deletingBusy = false;
    $("deleteHistoryCancel").disabled = false;
    $("deleteHistoryConfirm").disabled = true;
    await refresh();
  }
});
$("historyTheme").onclick = () =>
  applyTheme(
    document.documentElement.dataset.theme === "dark" ? "light" : "dark",
  );
action(refresh)();
