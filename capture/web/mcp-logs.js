// 日志使用 SSE 实时推送；只渲染有界摘要，不读取任何抓包正文。
const $ = (id) => document.getElementById(id);
let stream = null;
let paused = false;
let snapshot = { items: [] };

function textElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

function renderLogs() {
  // 按 call_id 保留展开状态，新增日志不会打断正在阅读的记录。
  const opened = new Set(Array.from($("logRows").querySelectorAll("details[open]"), (node) => node.dataset.id));
  const search = $("logSearch").value.trim().toLowerCase();
  const items = snapshot.items.filter((item) =>
    (!$("logSource").value || item.source === $("logSource").value) &&
    (!$("logStatus").value || item.status === $("logStatus").value) &&
    (!search || JSON.stringify(item).toLowerCase().includes(search)),
  );
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const detail = document.createElement("details");
    detail.className = "query-log";
    detail.dataset.id = item.call_id || item.timestamp;
    detail.open = opened.has(detail.dataset.id);
    const summary = document.createElement("summary");
    const date = new Date(item.timestamp);
    summary.append(
      textElement("span", Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN", { hour12: false }), "muted"),
      textElement("strong", item.tool || "未知工具"),
      textElement("span", item.source === "mcp" ? "MCP" : "分析 API", "muted"),
      textElement("span", item.status === "ok" ? "成功" : "失败", item.status === "error" ? "error" : ""),
      textElement("span", `${item.duration_ms ?? "—"} ms`, "muted"),
    );
    detail.append(summary, textElement("pre", JSON.stringify(item, null, 2)));
    fragment.append(detail);
  }
  $("logRows").replaceChildren(fragment);
  $("logEmpty").hidden = items.length > 0;
  $("logEmpty").textContent = snapshot.items.length ? "没有符合条件的记录。" : "暂无查询日志。Agent 调用 MCP 工具后会自动显示。";
  $("logCount").textContent = `${items.length} / ${snapshot.items.length} 条${snapshot.limited ? " · 仅显示最近记录" : ""}`;
}

function connectLogs() {
  // EventSource 自动重连；隐藏页面时关闭连接，减少闲置开销。
  stream?.close();
  stream = null;
  if (paused || document.hidden) {
    $("logConnection").textContent = "更新已暂停";
    return;
  }
  $("logConnection").textContent = "连接中…";
  stream = new EventSource("/api/mcp/logs/stream");
  stream.onmessage = (event) => {
    try {
      snapshot = JSON.parse(event.data);
      renderLogs();
      $("logConnection").textContent = "● 实时更新中";
    } catch {
      $("logConnection").textContent = "日志格式异常";
    }
  };
  stream.onerror = () => { $("logConnection").textContent = "连接中断，正在重连…"; };
}

for (const id of ["logSearch", "logSource", "logStatus"]) $(id).addEventListener("input", renderLogs);
$("logPause").addEventListener("click", () => {
  paused = !paused;
  $("logPause").textContent = paused ? "继续更新" : "暂停更新";
  connectLogs();
});
initThemePicker($("logTheme"));
document.addEventListener("visibilitychange", connectLogs);
window.addEventListener("pagehide", () => stream?.close());
connectLogs();
