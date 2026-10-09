// 原生前端：只保留会话、选择和详情状态；正文不通过 WebSocket 推送。
const $ = (id) => document.getElementById(id);
const state = {
  session: null,
  sessions: [],
  rows: [],
  selected: new Set(),
  detail: null,
  activeId: null,
  tab: "request",
  offset: 0,
  sortBy: "started",
  sortOrder: "none",
  total: 0,
  status: null,
  runtimeId: null,
  archivedSession: new URLSearchParams(location.search).get("session"),
  directory: null,
  directoryOpen: new Set(),
  hookEntries: [],
  hookCatalog: [],
  advancedExpression: null,
  advancedDraft: null,
  advancedPreviewSequence: 0,
  anchor: null,
  refreshTimer: null,
  refreshSequence: 0,
  followReplay: null,
  replayAnchor: null,
  flowSessions: new Map(),
};

/** 聚合列表使用虚拟视图，所有单条操作仍路由到真实批次。 */
const REPLAY_VIEW = "__replays__";
function flowSession(id = state.activeId) {
  return state.session === REPLAY_VIEW ? state.flowSessions.get(id) : state.session;
}
function flowListUrl(session, parameters) {
  return session === REPLAY_VIEW ? `/api/replays/flows?${parameters}`
    : `/api/sessions/${session}/flows?${parameters}`;
}
function selectedGroups(ids = [...state.selected]) {
  const groups = new Map();
  for (const id of ids) {
    const session = flowSession(id);
    if (!session) throw new Error("请求所属批次未知，请刷新后重试");
    if (!groups.has(session)) groups.set(session, []);
    groups.get(session).push(id);
  }
  return groups;
}
async function openReplayList(anchor = null) {
  $("replayMenu").open = false;
  switchSession(REPLAY_VIEW);
  // 点击入口展示全部记录；返回抓包时仍恢复原筛选。
  restoreFilters(null, true);
  state.rows = [];
  state.total = 0;
  renderRows();
  state.replayAnchor = anchor;
  await refreshSessions();
  try { await refreshFlows(); }
  catch (error) {
    if (error.message === "Not Found") throw new Error("重放聚合接口尚未生效，请停止抓包后重启工作台");
    throw error;
  }
}
/** 主题按钮描述当前主题；顶部和设置页共用主题选择，不改抓包/请求状态。 */
initThemePicker($("themeToggle"));
initThemeCards($("themeCards"));
document.addEventListener("appearance-menu-open", () => dismissFloatingMenus());

/** 动画只响应用户操作，并遵循系统的减少动态效果设置。 */
const elementAnimations = new WeakMap();
function animateElement(element, keyframes, duration = 140) {
  elementAnimations.get(element)?.cancel();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches)
    return Promise.resolve();
  const animation = element.animate(keyframes, {
    duration,
    easing: "ease-out",
  });
  elementAnimations.set(element, animation);
  return animation.finished.catch(() => {});
}
async function closeDialog(id) {
  const dialog = $(id);
  if (!dialog.open) return;
  await animateElement(
    dialog,
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(6px)" },
    ],
    130,
  );
  dialog.close();
}
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(dialog.id);
  });

const PAGE_SIZE = 200;
const statusNames = {
  pending: "等待响应",
  receiving: "接收中",
  complete: "完成",
  blocked: "已阻止",
  passthrough: "透传",
  error: "错误",
  interrupted: "已中断",
};

/** 统一调用 API，保留后端给出的具体错误。 */
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const data = JSON.parse(text);
      message =
        typeof data.detail === "string"
          ? data.detail
          : JSON.stringify(data.detail);
    } catch {}
    throw new Error(message);
  }
  return response;
}
async function json(path, options) {
  if (!options || !options.method || options.method.toUpperCase() === "GET")
    return readRequests.json(path, /\/flows\?/.test(path) ? "flow-list" : /\/flows\/[^/?]+\?preview=true$/.test(path) ? "flow-detail" : null);
  return (await api(path, options)).json();
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").style.display = "none"), 5000);
}
function action(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      if (error.name !== "AbortError") toast(error.message);
    }
  };
}
const flowComparison = new FlowComparison($("comparisonDialog"), scope => scope === "viewer"
  ? {session: requestViewer.session, id: requestViewer.id, flow: requestViewer.flow}
  : {session: flowSession(), id: state.activeId, flow: state.detail}, toast);
$("compareSelected").onclick = action(async () => {
  if (!state.session || state.selected.size !== 2) return;
  const [left, right] = [...state.selected];
  $("flowActions").open = false;
  await flowComparison.open({session: flowSession(left), id: left}, {session: flowSession(right), id: right});
});
function size(bytes) {
  return bytes >= 1048576
    ? (bytes / 1048576).toFixed(1) + " MB"
    : bytes >= 1024
      ? (bytes / 1024).toFixed(1) + " KB"
      : bytes + " B";
}

/** 更新引擎状态，同时显示配置是否已被引擎确认。 */
async function refreshStatus() {
  state.status = await json("/api/status");
  if (state.runtimeId !== state.status.runtime_id) {
    const restarted = state.runtimeId !== null;
    if (restarted) state.archivedSession = null;
    state.runtimeId = state.status.runtime_id;
    switchSession(null);
    state.rows = [];
    state.total = 0;
    renderRows();
    if (restarted) scheduleRefresh();
  }
  const {
    running,
    recording,
    settings,
    policy_version,
    dropped_events,
    error,
    replay_jobs,
  } = state.status;
  $("engineStatus").textContent = running
    ? recording
      ? "正在抓包"
      : "代理转发 · 未记录"
    : "代理不可用";
  $("engineStatus").classList.toggle("running", running);
  $("start").disabled = recording;
  $("stop").disabled = !recording;
  const network = state.status.network;
  $("proxyAddress").textContent = network.lan_address || network.listen_address;
  $("proxyAddress").title =
    `监听 ${network.listen_address}；${network.lan_accessible ? "允许局域网连接" : "仅本机可连接"}`;
  $("proxyScope").textContent = network.lan_accessible
    ? "局域网"
    : settings.listen_host === "0.0.0.0"
      ? "未检测到局域网 IP"
      : "仅本机";
  const modes = { all: "全部解密", list: "列表解密", passthrough: "全部透传" };
  $("policySummary").textContent =
    `${settings.connection_mode === "upstream" ? "外部代理" : "直连"} · ${modes[settings.tls_mode]} · 拒绝${settings.blocking_enabled ? "开启" : "关闭"}${settings.hook_enabled ? " · Hook 开启" : ""}`;
  $("policyVersion").textContent =
    error ||
    (running
      ? policy_version === settings.version
        ? `配置 v${settings.version} 已生效`
        : "配置下发中…"
      : `配置 v${settings.version}`);
  if (dropped_events)
    $("policyVersion").textContent += ` · 丢弃 ${dropped_events} 个采集事件`;
  $("jobs").replaceChildren();
  for (const job of replay_jobs) {
    const row = document.createElement("div");
    row.textContent = "重放执行中 · " + job;
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.onclick = action(async () => {
      await json(`/api/replay/${job}/cancel`, { method: "POST" });
      await refreshStatus();
    });
    row.append(cancel);
    $("jobs").append(row);
  }
  renderSelection();
  renderDomainActions();
}

/** 只展示本次服务启动创建的会话，历史数据留在磁盘。 */
async function refreshSessions() {
  state.sessions = await json("/api/sessions");
  if (
    state.archivedSession &&
    !state.sessions.some((item) => item.id === state.archivedSession)
  ) {
    const archived = await json("/api/sessions?include_archived=true");
    const selected = archived.find((item) => item.id === state.archivedSession);
    if (selected) state.sessions.push({ ...selected, archived: true });
  }
  if (
    state.session && state.session !== REPLAY_VIEW &&
    !state.sessions.some((item) => item.id === state.session)
  )
    switchSession(null);
  if (!state.session && state.sessions.length)
    state.session =
      state.archivedSession ||
      state.sessions.find(
        (session) =>
          session.id === state.status?.session_id && session.kind === "capture",
      )?.id ||
      state.sessions.find((session) => session.kind === "capture")?.id ||
      null;
  const replays = state.sessions.filter((session) => session.kind === "replay");
  $("clearReplays").disabled =
    !replays.length ||
    replays.some(
      (session) => session.status === "running" && !session.archived,
    );
  $("replayRecords").replaceChildren();
  $("replayCount").textContent = replays.reduce((count, session) => count + (session.count || 0), 0);
  $("replayCount").hidden = !replays.length;
  $("showReplays").classList.toggle("active", state.session === REPLAY_VIEW);
  $("replayMenu").classList.toggle(
    "active",
    state.session === REPLAY_VIEW || state.sessions.some(
      (session) => session.id === state.session && session.kind === "replay",
    ),
  );
  $("showCapture").classList.toggle(
    "active",
    !$("replayMenu").classList.contains("active"),
  );
  $("showCapture").disabled = false;
  if (!replays.length) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "暂无重放记录。选择请求后，可在“操作”中重放。";
    $("replayRecords").append(hint);
  }
  for (const session of replays) {
    const button = document.createElement("button");
    button.className = "session";
    button.classList.toggle("active", session.id === state.session);
    const title = document.createElement("strong");
    title.textContent =
      session.id.slice(0, 10) +
      " " +
      session.id.slice(11, 19).replaceAll("-", ":");
    const label = document.createElement("small");
    label.textContent = `${session.archived ? "历史 · " : ""}${session.kind === "replay" ? "重放" : "抓包"} · ${session.count} 条 · ${session.status === "running" ? (session.archived ? "异常结束" : "进行中") : session.status === "failed" ? "失败" : session.status === "interrupted" ? "异常结束" : "已结束"}`;
    button.append(title, label);
    button.title = session.id;
    button.onclick = action(async () => {
      $("replayMenu").open = false;
      await openReplayList({anchor_session: session.id});
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "replay-delete";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `删除重放批次 ${session.id}`);
    remove.title = "删除这个重放批次";
    remove.disabled = session.status === "running" && !session.archived;
    remove.onclick = action(() => removeSessions([session.id]));
    const row = document.createElement("div");
    row.className = "replay-record-row";
    row.append(button, remove);
    $("replayRecords").append(row);
  }
}
/** 每个会话保存独立筛选，避免重放批次覆盖来源条件。 */
const sessionFilters = new Map();
function filterSnapshot() {
  return {
    values: Object.fromEntries(["search", "quickSearchScope", "filterKeyword", "searchScope", ...Object.keys(filterFields)].map(id => [id, $(id).value])),
    recordVisibility: $("recordVisibility").value,
    advancedExpression: structuredClone(state.advancedExpression),
    directory: structuredClone(state.directory),
  };
}
function restoreFilters(snapshot, keepRecordVisibility = false) {
  for (const id of ["search", "quickSearchScope", "filterKeyword", "searchScope", ...Object.keys(filterFields)])
    $(id).value = snapshot?.values[id] ?? (id.endsWith("Scope") ? "url" : "");
  if (!keepRecordVisibility) $("recordVisibility").value = snapshot?.recordVisibility ?? "all";
  state.advancedExpression = structuredClone(snapshot?.advancedExpression ?? null);
  state.directory = structuredClone(snapshot?.directory ?? null);
  $("directoryFilter").hidden = !state.directory;
  if (state.directory) $("directoryFilter").textContent = `目录：${state.directory.host}${state.directory.path || ""} · 包含子目录`;
  setQuickFilterDisabled(Boolean(state.advancedExpression));
  syncFilterControls();
}
function switchSession(id) {
  if (state.session) sessionFilters.set(state.session, filterSnapshot());
  clearTimeout($("search").timer);
  state.refreshSequence++;

  state.followReplay = null;
  state.replayAnchor = null;
  state.flowSessions?.clear();
  if (state.sessions?.some(session => session.id === state.session && session.kind === "capture"))
    state.lastCaptureSession = state.session;
  state.session = id;
  state.offset = 0;
  state.selected.clear();
  state.activeId = null;
  state.detail = null;
  state.detailVersion = null;
  state.anchor = null;
  state.directory = null;
  state.directoryOpen.clear();
  state.directorySignature = null;
  clearTimeout(state.directoryTimer);
  // 清除句柄，否则 scheduleDirectories 会误以为旧刷新仍在等待。
  state.directoryTimer = null;
  $("directoryTree").replaceChildren();
  $("directoryFilter").hidden = true;
  restoreFilters(sessionFilters.get(id));
  renderDetail();
  renderSelection();
}

const filterFields = {
  filterHost: "host",
  filterMethod: "method",
  filterCode: "status_code",
  filterStatus: "status",
  filterSource: "source",
  filterType: "content_type",
  filterMinDuration: "min_duration",
  filterMaxDuration: "max_duration",
  filterMinSize: "min_size",
};

/** 目录摘要最多每两秒刷新，查询所有分页中的 URL，不读取正文。 */
function scheduleDirectories() {
  if (!state.session || state.session === REPLAY_VIEW || state.directoryTimer) return;
  state.directoryTimer = setTimeout(
    action(async () => {
      state.directoryTimer = null;
      const session = state.session;
      if (!session || document.hidden) return;
      const records = await json(`/api/sessions/${session}/directories`);
      if (session !== state.session) return;
      const signature = JSON.stringify(records);
      if (signature === state.directorySignature) return;
      renderDirectories(records);
      state.directorySignature = signature;
    }),
    state.directorySignature ? 2000 : 0,
  );
}

/** 域名和路径逐级聚合，目录计数包含其下所有请求，保留展开状态。 */
function renderDirectories(records) {
  const roots = new Map();
  for (const record of records) {
    let root = roots.get(record.host);
    if (!root) {
      root = {
        label: record.host,
        host: record.host,
        path: "/",
        count: 0,
        children: new Map(),
      };
      roots.set(record.host, root);
    }
    root.count += record.count;
    let node = root,
      path = "";
    for (const segment of record.path.slice(1).split("/")) {
      path += "/" + segment;
      if (path === "/") continue;
      if (!node.children.has(path))
        node.children.set(path, {
          label: segment || "/",
          host: record.host,
          path,
          count: 0,
          children: new Map(),
        });
      node = node.children.get(path);
      node.count += record.count;
    }
  }
  const tree = $("directoryTree");
  tree.replaceChildren();
  if (!roots.size) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "暂无请求目录";
    tree.append(hint);
  }
  function appendNode(node, parent) {
    const key = node.host + "\n" + node.path;
    const item = document.createElement("div");
    item.className = "directory-node";
    const row = document.createElement("div");
    row.className = "directory-row";
    const toggle = document.createElement("button");
    toggle.className = "directory-toggle";
    toggle.textContent = node.children.size
      ? state.directoryOpen.has(key)
        ? "▾"
        : "▸"
      : "·";
    toggle.disabled = !node.children.size;
    toggle.setAttribute("aria-label", `展开 ${node.host}${node.path}`);
    toggle.setAttribute("aria-expanded", String(state.directoryOpen.has(key)));
    const choose = document.createElement("button");
    choose.className = "directory-choice";
    choose.classList.toggle(
      "active",
      state.directory?.host === node.host &&
        state.directory?.path === node.path,
    );
    choose.textContent = `${node.label} (${node.count})`;
    choose.title = node.host + node.path;
    choose.onclick = () => {
      state.directory = { host: node.host, path: node.path };
      $("filterHost").value = node.host;
      $("directoryFilter").textContent =
        `目录：${node.host}${node.path} · 包含子目录`;
      $("directoryFilter").hidden = false;
      renderDirectories(records);
      filtersChanged();
    };
    row.append(toggle, choose);
    item.append(row);
    const children = document.createElement("div");
    children.className = "directory-children";
    children.hidden = !state.directoryOpen.has(key);
    toggle.onclick = () => {
      children.hidden = !children.hidden;
      if (children.hidden) state.directoryOpen.delete(key);
      else state.directoryOpen.add(key);
      toggle.textContent = children.hidden ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!children.hidden));
    };
    for (const child of node.children.values()) appendNode(child, children);
    item.append(children);
    parent.append(item);
  }
  for (const root of roots.values()) {
    appendNode(root, tree);
    tree.lastElementChild.dataset.host = root.host;
  }
  filterDirectoryHosts();
}
/** 仅过滤已渲染的 host 根节点，不触发请求查询或改变路径选择。 */
function filterDirectoryHosts() {
  const keyword = $("directoryHostSearch").value.trim().toLowerCase();
  const roots = $("directoryTree").querySelectorAll(":scope > .directory-node");
  let visible = 0;
  for (const root of roots) {
    root.hidden = !root.dataset.host.toLowerCase().includes(keyword);
    if (!root.hidden) visible++;
  }
  let hint = $("directoryHostEmpty");
  if (!hint) {
    hint = document.createElement("p");
    hint.id = "directoryHostEmpty";
    hint.className = "muted";
    hint.textContent = "没有匹配的 host";
    $("directoryTree").append(hint);
  }
  hint.hidden = !roots.length || visible > 0;
}
$("directoryHostSearch").oninput = filterDirectoryHosts;
$("clearDirectory").onclick = () => {
  state.directory = null;
  $("directoryFilter").hidden = true;
  $("filterHost").value = "";
  state.directorySignature = null;
  scheduleDirectories();
  filtersChanged();
};

/** 内外关键词互斥，范围始终随当前关键词提交。 */
function activeKeyword() {
  const inner = $("filterKeyword").value.trim();
  return inner ? { search: inner, scope: $("searchScope").value }
    : { search: $("search").value.trim(), scope: $("quickSearchScope").value };
}
/** 列表与选择筛选结果共用参数，避免显示和批量操作范围不一致。 */
function filterParams() {
  const parameters = new URLSearchParams();
  parameters.set("sort_by", state.sortBy);
  parameters.set("sort_order", state.sortOrder);
  if (state.advancedExpression) {
    parameters.set("expression", JSON.stringify(state.advancedExpression));
  } else {
    const keyword = activeKeyword();
    if (keyword.search) parameters.set("search", keyword.search);
    parameters.set("scope", keyword.scope);
    for (const [id, key] of Object.entries(filterFields)) {
      const value = $(id).value.trim();
      if (value) parameters.set(key, value);
    }
  }
  if ($("recordVisibility").value !== "all") parameters.set("record_visibility", $("recordVisibility").value);
  if (state.directory) {
    parameters.set("host", state.directory.host);
    parameters.set("path_prefix", state.directory.path);
  }
  return parameters;
}

/** 页内实时刷新保留选择；查询序号及参数防止旧查询覆盖新的筛选。 */
async function refreshFlows() {
  const sequence = ++state.refreshSequence;
  if (!state.session) {
    state.rows = [];
    state.total = 0;
    renderRows();
    return;
  }
  const session = state.session;
  const filters = filterParams().toString();
  const parameters = filterParams();
  parameters.set("offset", state.offset);
  parameters.set("limit", PAGE_SIZE);
  const anchor = state.replayAnchor;
  if (session === "__replays__" && anchor)
    for (const [key, value] of Object.entries(anchor)) parameters.set(key, value);
  const result = await json(session === "__replays__"
    ? `/api/replays/flows?${parameters}` : `/api/sessions/${session}/flows?${parameters}`);
  if (
    sequence !== state.refreshSequence ||
    session !== state.session ||
    filters !== filterParams().toString()
  )
    return;
  if (session === "__replays__") {
    const keep = new Set([...state.selected, state.activeId, ...result.items.map(flow => flow.id)]);
    for (const id of state.flowSessions.keys()) if (!keep.has(id)) state.flowSessions.delete(id);
    for (const flow of result.items) state.flowSessions.set(flow.id, flow.session_id);
    if (anchor && state.replayAnchor === anchor) {
      state.replayAnchor = null;
      if (result.anchor_offset != null) {
        state.offset = Math.floor(result.anchor_offset / PAGE_SIZE) * PAGE_SIZE;
        state.activeId = result.anchor_id;
        state.flowSessions.set(result.anchor_id, result.anchor_session_id);
        state.tab = "response";
        state.scrollToReplay = true;
        if (state.offset !== Number(parameters.get("offset"))) {
          await refreshFlows();
          return;
        }
      } else if (anchor.anchor_id || anchor.source_id) toast("未找到对应重放记录，已展示全部重放请求");
    }
  }
  // 删除末页记录后回到有效页；先通过查询序号校验，防止切换会话时跳页。
  if (state.offset > 0 && state.offset >= result.total) {
    state.offset = result.total ? Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE : 0;
    await refreshFlows();
    return;
  }
  const query = `${session}?${parameters}`;
  const changed = state.rowsQuery !== query || state.total !== result.total || JSON.stringify(state.rows) !== JSON.stringify(result.items);
  state.rowsQuery = query;
  state.rows = result.items;
  state.total = result.total;
  // 新批次可能先于第一条记录返回；收到记录后只自动打开一次。
  const following = state.followReplay;
  if (following && (following.session === session || session === "__replays__") && state.rows.some(flow => session !== "__replays__" || flow.session_id === following.session)) {
    state.followReplay = null;
    state.activeId = state.rows.find(flow => session !== "__replays__" || flow.session_id === following.session).id;
    state.tab = "response";
    document
      .querySelectorAll("[data-tab]")
      .forEach((button) =>
        button.classList.toggle("active", button.dataset.tab === state.tab),
      );
    if (following.full)
      await requestViewer.open(session === "__replays__" ? flowSession() : session, state.activeId, "response");
  }
  if (changed) renderRows();
  if (state.scrollToReplay) {
    state.scrollToReplay = false;
    state.rowElements?.get(state.activeId)?.scrollIntoView({block: "center"});
  }
  scheduleDirectories();
  const active = state.rows.find((flow) => flow.id === state.activeId);
  const version = active ? JSON.stringify(active) : null;
  if (state.activeId && version && version !== state.detailVersion)
    await loadDetail(state.activeId);
}

/** 使用 DOM 文本节点渲染流量，抓包内容不会被当成 HTML 执行。 */
/** 列表突出接口路径及 Query；CONNECT 记录没有 HTTP 接口路径。 */
function requestAddress(flow) {
  if (flow.method === "CONNECT") return flow.host || flow.url || "—";
  try {
    const url = new URL(flow.url);
    return url.pathname === "/" && !url.search ? url.host : url.pathname + url.search;
  } catch {
    return flow.url || "—";
  }
}

function renderRows() {
  const previous = state.rowElements || new Map();
  const next = new Map();
  const tbody = $("flows");
  for (let index = 0; index < state.rows.length; index++) {
    const flow = state.rows[index];
    const signature = JSON.stringify(flow);
    const existing = previous.get(flow.id);
    if (existing && existing.dataset.signature === signature) {
      existing.classList.toggle("active", flow.id === state.activeId);
      existing.querySelector("input").checked = state.selected.has(flow.id);
      next.set(flow.id, existing);
      continue;
    }
    const row = document.createElement("tr");
    row.dataset.flowId = flow.id;
    row.dataset.signature = signature;
    row.classList.toggle("active", flow.id === state.activeId);
    const checkCell = document.createElement("td");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = state.selected.has(flow.id);
    check.onclick = (event) => {
      event.stopPropagation();
      selectFlow(
        state.rows.findIndex((item) => item.id === flow.id),
        event.shiftKey,
        check.checked,
      );
    };
    checkCell.append(check);
    row.append(checkCell);
    const statusCell = document.createElement("td");
    statusCell.textContent =
      flow.code || statusNames[flow.status] || flow.status;
    statusCell.className = "status-" + flow.status;
    statusCell.title = statusNames[flow.status];
    row.append(statusCell);
    const method = document.createElement("td");
    method.textContent = flow.method;
    row.append(method);
    const url = document.createElement("td");
    url.className = "url-cell";
    url.title = flow.url;
    const address = document.createElement("div");
    address.className = "request-interface";
    address.textContent = requestAddress(flow);
    url.append(address);
    try {
      const parsed = new URL(flow.url);
      if (flow.method !== "CONNECT" && (parsed.pathname !== "/" || parsed.search)) {
        const host = document.createElement("small");
        host.className = "request-host muted";
        host.textContent = parsed.host;
        url.append(host);
      }
    } catch { /* 无法解析时保留原地址，不猜测接口或域名。 */ }
    row.append(url);
    const timeCell = document.createElement("td");
    const timestamp = flow.started == null ? null : new Date(flow.started * 1000);
    timeCell.textContent = timestamp ? timestamp.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(timestamp.getMilliseconds()).padStart(3, "0") : "—";
    timeCell.title = timestamp ? timestamp.toLocaleString("zh-CN", { hour12: false }) : "未知请求时间";
    row.append(timeCell);
    for (const value of [
      flow.duration == null ? "—" : `${Math.round(flow.duration)} ms`,
      size(flow.size),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const replayCell = document.createElement("td");
    const replayButton = document.createElement("button");
    replayButton.type = "button";
    replayButton.textContent = "↻";
    replayButton.title = "直接重放这条请求";
    replayButton.setAttribute("aria-label", `重放 ${flow.method} ${flow.url}`);
    replayButton.disabled =
      flow.method === "CONNECT" || flow.status === "pending";
    replayButton.onclick = action(async (event) => {
      event.stopPropagation();
      replayButton.disabled = true;
      try {
        await replayOne(flowSession(flow.id), flow.id);
      } finally {
        replayButton.disabled =
          flow.method === "CONNECT" || flow.status === "pending";
      }
    });
    replayCell.append(replayButton);
    row.append(replayCell);
    row.onclick = action(async (event) => {
      // 普通点击同一行收起详情；组合键仍用于多选，不触发收起。
      if (
        state.activeId === flow.id &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        hideRequestDetail();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.shiftKey)
        selectFlow(
          state.rows.findIndex((item) => item.id === flow.id),
          event.shiftKey,
          !state.selected.has(flow.id),
        );
      state.activeId = flow.id;
      state.detail = null;
      state.detailVersion = null;
      renderRows();
      renderDetail();
      await loadDetail(flow.id);
    });
    next.set(flow.id, row);
  }
  // 删除过期行，只插入新增或变化的节点，未变化的行保留焦点和选择。
  for (const [id, row] of previous) if (next.get(id) !== row) row.remove();
  let cursor = tbody.firstElementChild;
  for (const row of next.values()) {
    if (cursor === row) cursor = cursor.nextElementSibling;
    else tbody.insertBefore(row, cursor);
  }
  state.rowElements = next;
  $("empty").style.display = state.rows.length ? "none" : "block";
  const hasFilters =
    activeKeyword().search ||
    Object.keys(filterFields).some((id) => $(id).value.trim());
  $("empty").querySelector("h2").textContent = hasFilters
    ? "没有匹配的记录"
    : "等待第一条请求";
  $("empty").querySelector("p").textContent = hasFilters
    ? "请调整条件，或点击筛选面板中的“重置全部筛选”。"
    : "开始抓包并设置客户端代理。HTTPS 内容需要安装证书并开启目标域名解密。";
  $("total").textContent = `${state.total} 条记录`;
  $("pageInfo").textContent =
    `第 ${Math.floor(state.offset / PAGE_SIZE) + 1} 页 / ${Math.max(1, Math.ceil(state.total / PAGE_SIZE))}`;
  $("previous").disabled = state.offset === 0;
  $("next").disabled = state.offset + PAGE_SIZE >= state.total;
  renderSelection();
}
function selectFlow(index, range, checked) {
  const indices =
    range && state.anchor !== null
      ? [Math.min(index, state.anchor), Math.max(index, state.anchor)]
      : [index, index];
  for (let i = indices[0]; i <= indices[1]; i++)
    checked
      ? state.selected.add(state.rows[i].id)
      : state.selected.delete(state.rows[i].id);
  state.anchor = index;
  renderRows();
}
function renderSelection() {
  const busy =
    state.session === state.status?.session_id ||
    state.status?.replay_jobs?.includes(state.session);
  $("deleteSelected").disabled = !state.selected.size;
  $("deleteSession").textContent = state.session === "__replays__" ? "删除所有重放批次" : "删除当前批次";
  $("clearSession").disabled = !state.session;
  $("clearDisplayed").disabled = !state.session || !state.total || Boolean(state.clearingDisplayed);
  $("deleteSession").disabled = !state.session || busy || (state.session === "__replays__" && state.sessions.some(item => item.kind === "replay" && item.status === "running"));
  $("selectionCount").textContent = `已选择 ${state.selected.size} 条`;
  $("toolbarSelectionCount").hidden = !state.selected.size;
  $("toolbarSelectionCount").textContent = state.selected.size;
  $("actionCount").hidden = !state.selected.size;
  $("actionCount").textContent = state.selected.size;
  $("selectPage").checked =
    state.rows.length > 0 &&
    state.rows.every((flow) => state.selected.has(flow.id));
  $("repeat").disabled = !state.selected.size;
  $("export").disabled = !state.selected.size;
  $("editRepeat").disabled = state.selected.size !== 1;
  $("compareSelected").disabled = state.selected.size !== 2;
}

/** 删除后清理详情与选择，再从服务端重新读取计数和目录。 */
async function refreshAfterDeletion() {
  if ($("requestViewer").open) $("requestViewer").close();
  switchSession(state.session);
  await refreshSessions();
  await refreshFlows();
  await refreshStatus();
}

/** 删除必须确认具体批次；批量清空使用确认前的 ID 快照。 */
async function removeSessions(ids) {
  if (
    !ids.length ||
    !confirm(
      `删除 ${ids.length} 个批次及其全部请求和正文？此操作无法恢复。\n${ids.join("\n")}`,
    )
  )
    return;
  await json("/api/sessions/delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  if (ids.includes(state.archivedSession)) state.archivedSession = null;
  if (ids.includes(state.session)) switchSession(null);
  await refreshAfterDeletion();
  toast("批次已删除");
}
$("deleteSession").onclick = action(() =>
  removeSessions(state.session === REPLAY_VIEW ? state.sessions.filter(item => item.kind === "replay").map(item => item.id) : state.session ? [state.session] : []),
);
$("clearReplays").onclick = action(() =>
  removeSessions(
    state.sessions
      .filter((session) => session.kind === "replay")
      .map((session) => session.id),
  ),
);

async function removeFlows(all) {
  const session = state.session;
  const ids = [...state.selected];
  if (!session || (!all && !ids.length)) return;
  const label = all
    ? session === REPLAY_VIEW ? "所有重放批次的全部请求（包含筛选隐藏的记录）" : "这个批次的全部请求（包含筛选隐藏的记录）"
    : `选中的 ${ids.length} 条请求`;
  if (!confirm(`删除${label}及其正文？此操作无法恢复。`)) return;
  let result = {deleted: 0};
  const groups = session === REPLAY_VIEW
    ? all ? new Map(state.sessions.filter(item => item.kind === "replay").map(item => [item.id, []])) : selectedGroups(ids)
    : new Map([[session, ids]]);
  try {
    for (const [target, targetIds] of groups) {
      const deleted = await json(`/api/sessions/${target}/flows/delete`, {
        method: "POST", body: JSON.stringify(all ? {all: true} : {ids: targetIds}),
      });
      result.deleted += deleted.deleted;
    }
  } catch (error) {
    if (result.deleted) { await refreshAfterDeletion(); throw new Error(`已删除 ${result.deleted} 条，其余未完成：${error.message}`); }
    throw error;
  }
  await refreshAfterDeletion();
  toast(`已删除 ${result.deleted} 条请求`);
}
$("deleteSelected").onclick = action(() => removeFlows(false));
$("clearSession").onclick = action(() => removeFlows(true));

/** 清空当前查询的所有页，保持筛选；空结果不发起删除或刷新。 */
async function clearDisplayedFlows() {
  if (!state.session || !state.total || state.clearingDisplayed) return;
  if (state.session === "__replays__") return clearReplayDisplayed();
  const session = state.session;
  const filters = filterParams().toString();
  const parameters = new URLSearchParams(filters);
  const filtered = [...parameters.keys()].some(key => !["sort_by", "sort_order", "scope"].includes(key));
  state.clearingDisplayed = true;
  renderSelection();
  let deleted = 0;
  try {
    const ids = new Set();
    if (filtered) {
      // 按请求时间正序取快照，避免实时新记录插入列表顶部导致分页移位。
      parameters.set("sort_by", "started");
      parameters.set("sort_order", "asc");
      parameters.set("limit", "500");
      let total = null;
      for (let offset = 0; total === null || offset < total; offset += 500) {
        if (session !== state.session || filters !== filterParams().toString())
          throw new Error("筛选或批次已变化，请重新点击清空");
        parameters.set("offset", offset);
        const page = await json(`/api/sessions/${session}/flows?${parameters}`);
        if (total === null) total = page.total;
        if (total > 50000) throw new Error("一次最多清空 50000 条筛选结果，请缩小筛选范围");
        for (const flow of page.items) ids.add(flow.id);
        if (!page.items.length) break;
      }
      if (!ids.size) return;
    }
    if (session !== state.session || filters !== filterParams().toString())
      throw new Error("筛选或批次已变化，请重新点击清空");
    const label = filtered ? `当前筛选匹配的 ${ids.size} 条请求（包含其他页）` : "当前批次的全部请求";
    if (!confirm(`清空${label}及其正文？此操作无法恢复。筛选条件将保留。`)) return;
    const snapshots = [...ids];
    for (let offset = 0; !filtered || offset < snapshots.length; offset += 1000) {
      const result = await json(`/api/sessions/${session}/flows/delete`, {
        method: "POST",
        body: JSON.stringify(filtered ? { ids: snapshots.slice(offset, offset + 1000) } : { all: true }),
      });
      deleted += result.deleted;
      if (!filtered) break;
    }
    if (state.session === session) await refreshAfterDeletion();
    toast(`已清空 ${deleted} 条请求，筛选条件已保留`);
  } catch (error) {
    if (deleted) {
      if (state.session === session) await refreshAfterDeletion();
      throw new Error(`已清空 ${deleted} 条请求，其余未完成：${error.message}`);
    }
    throw error;
  } finally {
    state.clearingDisplayed = false;
    renderSelection();
  }
}
$("clearDisplayed").onclick = action(clearDisplayedFlows);

/** 聚合清空先固定匹配记录及真实批次，再逐批删除。 */
async function clearReplayDisplayed() {
  state.clearingDisplayed = true;
  renderSelection();
  const filters = filterParams().toString();
  let deleted = 0;
  try {
    const groups = new Map();
    for (let offset = 0; ; offset += 500) {
      if (state.session !== REPLAY_VIEW || filters !== filterParams().toString()) throw new Error("筛选已变化，请重试");
      const params = new URLSearchParams(filters);
      params.set("limit", 500); params.set("offset", offset);
      params.set("sort_by", "started"); params.set("sort_order", "asc");
      const page = await json(flowListUrl(REPLAY_VIEW, params));
      if (page.total > 50000) throw new Error("一次最多清空 50000 条，请缩小范围");
      for (const flow of page.items) {
        if (!groups.has(flow.session_id)) groups.set(flow.session_id, new Set());
        groups.get(flow.session_id).add(flow.id);
      }
      if (offset + 500 >= page.total || !page.items.length) break;
    }
    const count = [...groups.values()].reduce((total, ids) => total + ids.size, 0);
    if (!count || state.session !== REPLAY_VIEW || filters !== filterParams().toString()) return;
    if (!confirm(`清空当前显示条件匹配的 ${count} 条重放请求（包含其他页）及正文？此操作无法恢复。`)) return;
    for (const [session, values] of groups) {
      const ids = [...values];
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const result = await json(`/api/sessions/${session}/flows/delete`, {method: "POST", body: JSON.stringify({ids: ids.slice(offset, offset + 1000)})});
        deleted += result.deleted;
      }
    }
    if (state.session === REPLAY_VIEW) await refreshAfterDeletion();
    toast(`已清空 ${deleted} 条重放请求`);
  } catch (error) {
    if (deleted) { if (state.session === REPLAY_VIEW) await refreshAfterDeletion(); throw new Error(`已删除 ${deleted} 条，其余未完成：${error.message}`); }
    throw error;
  } finally { state.clearingDisplayed = false; renderSelection(); }
}
/** 按需读取详情；快速切换请求时丢弃旧请求的迟到结果。 */
async function loadDetail(id) {
  const view = state.session;
  const session = state.session === "__replays__" ? flowSession(id) : state.session;
  const requestedVersion = JSON.stringify(state.rows.find((flow) => flow.id === id));
  const detail = await json(
    `/api/sessions/${session}/flows/${id}?preview=true`,
  );
  if (view === state.session && id === state.activeId && (view !== "__replays__" || session === flowSession(id))) {
    state.detail = detail;
    state.detailVersion = requestedVersion;
    renderDetail();
    await requestViewer.refresh(session, id);
  }
}
/** 未选中请求时不占用列表空间，仅首次展开播放动画。 */
/** 只解释展示状态，不根据 UI 修改请求数据或重放行为。 */
function detailPresentation(flow) {
  if (!flow) return {method: "—", url: "正在加载请求详情…", label: "读取中", tone: "warning", reason: "", preferConnection: false};
  const special = flow.method === "CONNECT" || flow.status === "blocked" ||
    (["error", "interrupted"].includes(flow.status) && !flow.response);
  const missingResponse = !flow.response && flow.method !== "CONNECT" && flow.status === "complete";
  const tone = ["error", "blocked", "interrupted"].includes(flow.status) ? "danger"
    : flow.status === "complete" && !missingResponse ? "success" : "warning";
  return {
    method: flow.method || "—", url: flow.url || flow.host || "—",
    label: missingResponse ? "未保存响应" : `${flow.code ? flow.code + " · " : ""}${statusNames[flow.status] || flow.status || "状态未知"}`,
    tone, preferConnection: special,
    reason: flow.reason || (flow.status === "blocked" ? "请求已被域名策略阻止。" :
      ["error", "interrupted"].includes(flow.status) ? "请求未完成，可切换连接查看已有信息。" :
      missingResponse ? "此记录没有可查看的响应报文。" : ""),
  };
}
const detailViewStates = new Map();
function rememberDetailView(key, value) {
  detailViewStates.set(key, value);
  if (detailViewStates.size > 120) detailViewStates.delete(detailViewStates.keys().next().value);
}
/** 同一报文保留用户的折叠选择；没有选择时按实际内容自动展开。 */
function setDetailSection(section, key, hasContent) {
  section.dataset.viewKey = key;
  section.open = detailViewStates.has(key) ? detailViewStates.get(key) : Boolean(hasContent);
}
for (const id of ["detailHeadersSection", "detailBodySection"]) {
  const section = $(id);
  section.querySelector("summary").addEventListener("click", event => {
    if (event.target.closest("button, a, select")) return;
    rememberDetailView(section.dataset.viewKey, !section.open);
  });
}
const detailWebSocketViewer = new WebSocketViewer($("detailWebSocket"));
function renderDetail() {
  const panel = $("detailPanel");
  if (!state.activeId) {
    panel.hidden = true;
    $("contentGrid").classList.remove("has-detail");
    return;
  }
  const opening = panel.hidden;
  panel.hidden = false;
  $("contentGrid").classList.add("has-detail");
  if (opening)
    animateElement(panel, [
      { opacity: 0, transform: "translateX(12px)" },
      { opacity: 1, transform: "translateX(0)" },
    ]);
  const flow = state.detail;
  const contentKey = `${state.session}:${state.activeId}:${state.tab}`;
  const previousContentKey = panel.dataset.contentKey;
  if (previousContentKey && previousContentKey !== contentKey)
    rememberDetailView(`scroll:${previousContentKey}`, panel.scrollTop);
  const presentation = detailPresentation(flow);
  const presentationKey = `${state.session}:${state.activeId}`;
  if (flow && state.detailPresentationKey !== presentationKey) {
    state.detailPresentationKey = presentationKey;
    if (presentation.preferConnection) { state.tab = "info"; state.detailAutoTab = true; }
    else if (state.detailAutoTab && state.tab === "info") { state.tab = "request"; state.detailAutoTab = false; }
    $("detailSummary").querySelector(".detail-address").open = false;
  }
  flowComparison.updateMenus();
  document.querySelector('[data-tab="websocket"]').hidden = !flow?.websocket;
  if (state.tab === "websocket" && !flow?.websocket) state.tab = "response";
  document.querySelectorAll("[data-tab]").forEach(button => {
    const active = button.dataset.tab === state.tab;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  $("detailWebSocket").hidden = state.tab !== "websocket";
  renderDomainActions();
  $("detailMethod").textContent = presentation.method;
  $("detailUrl").textContent = presentation.url;
  $("detailUrl").title = presentation.url;
  $("detailFullUrl").textContent = presentation.url;
  $("detailStatus").textContent = presentation.label;
  $("detailStatus").dataset.tone = presentation.tone;
  $("detailSource").textContent = flow ? (flow.source === "replay" ? "重放" : "抓包") : "";
  $("detailReason").textContent = presentation.reason;
  $("detailReason").hidden = !presentation.reason;
  $("detailReason").dataset.tone = presentation.tone;
  const query = parseQueryParameters(flow?.[state.tab]?.url || flow?.url || "");
  const queryOutput = $("detailQueryJson");
  const queryKey = `${state.activeId}:${state.tab}`;
  if (queryOutput.dataset.requestKey !== queryKey) queryOutput.hidden = true;
  queryOutput.dataset.requestKey = queryKey;
  $("detailQueryToggle").hidden = query.count === 0;
  $("detailQueryCopy").hidden = query.count === 0;
  $("detailQueryJson").textContent = query.json;
  if (!query.count) queryOutput.hidden = true;
  $("detailQueryToggle").textContent = queryOutput.hidden ? "查看 Query JSON" : "收起 Query JSON";
  const message = flow?.[state.tab];
  $("detailReplay").disabled =
    !flow?.request || flow.method === "CONNECT" || !!flow.websocket || flow.request.truncated || flow.status === "pending";
  $("detailEditReplay").disabled = $("detailReplay").disabled;
  const replayToggle = $("detailEditReplay").closest("details").querySelector("summary");
  replayToggle.setAttribute("aria-disabled", String($("detailEditReplay").disabled));
  replayToggle.title = $("detailEditReplay").disabled ? "当前报文不支持编辑重放" : "重放选项";
  $("detailConnectionInfo").hidden = state.tab !== "info";
  $("detailBodySection").hidden = ["info", "websocket"].includes(state.tab);
  if (state.tab === "websocket") {
    detailWebSocketViewer.show(flowSession(), flow.id);
  } else if (state.tab === "info") {
    renderConnectionInfo($("detailConnectionInfo"), flow);
    const info = flow
      ? Object.fromEntries(
          Object.entries(flow).filter(
            ([key]) =>
              !["request", "original_request", "response"].includes(key),
          ),
        )
      : {};
    $("detailBodyTitle").textContent = "连接信息";
    $("detailContent").textContent = JSON.stringify(info, null, 2);
  } else {
    const response = state.tab === "response";
    $("detailHeadersTitle").textContent = response ? "响应头" : "请求头";
    $("detailBodyTitle").textContent = response ? "响应体" : "请求体";
    $("detailHeadersCount").textContent = `${message?.headers?.length || 0} 项`;
    renderMessageHeaders($("detailHeaders"), message);
    $("detailCopyHeaders").disabled = !message?.headers?.length;
    $("detailCopyBody").disabled = !message?.body_text;
    setDetailSection($("detailHeadersSection"), `${queryKey}:headers`, message?.headers?.length);
    const hasBody = Boolean(message?.body_text || message?.body_b64 || message?.body_size);
    setDetailSection($("detailBodySection"), `${queryKey}:body`, hasBody);
    $("detailBodyState").textContent = hasBody ? "" : message ? (bodyCaptureNotice(message) || "空正文") : "无报文";
    $("detailBodyState").title = $("detailBodyState").textContent;
    const notice = [bodyCaptureNotice(message)].filter(Boolean);
    if (!message?.body_state && message?.truncated) notice.push("正文被截断或未采集，不能直接重放。");
    if (message?.display_truncated)
      notice.push("正文仅预览前 64 KiB，请点击完整查看。");
    if (message?.decode_error) notice.push("正文解码失败，以下为文本预览。");
    if (!message)
      notice.push(
        flow
          ? flow.status === "pending"
            ? "正在重放，等待响应…"
            : flow.reason || "这条记录没有该报文，TLS 透传无法查看 HTTP 内容。"
          : "正在读取报文…",
      );
    $("detailNotice").textContent = notice.join(" ");
    const decodedBody = decodeRequestBody(message);
    $("detailContent").textContent =
      decodedBody.readable || (message ? "（空正文）" : "暂无正文内容");
    if (decodedBody.changed && !message?.truncated)
      notice.push("请求正文已执行 URL 解码，完整原始内容可在“完整查看”中切换查看。");
    $("detailNotice").textContent = notice.join(" ");
    const sse = state.tab === "response" && isEventStream(message);
    $("detailEvents").hidden = !sse;
    $("detailContent").hidden = sse;
    if (sse) renderSseEvents($("detailEvents"), message?.body_text || "");
    else $("detailEvents").replaceChildren();
    setBodyDownload($("detailDownloadBody"), flowSession(), flow?.id, state.tab, message);
  }
  $("detailMessage").hidden = ["info", "websocket"].includes(state.tab);
  const renderedKey = `${state.session}:${state.activeId}:${state.tab}`;
  panel.dataset.contentKey = renderedKey;
  if (previousContentKey !== renderedKey)
    requestAnimationFrame(() => {
      if (panel.dataset.contentKey === renderedKey)
        panel.scrollTop = detailViewStates.get(`scroll:${renderedKey}`) || 0;
    });
}
/** 清除当前详情，迟到的读取结果会由 loadDetail 的当前请求校验丢弃。 */
function hideRequestDetail() {
  detailWebSocketViewer.reset();
  state.activeId = null;
  state.detail = null;
  state.detailVersion = null;
  renderRows();
  renderDetail();
}
$("closeDetail").onclick = hideRequestDetail;
/** 侧栏复制始终使用保存的原始分区内容，不包含空正文提示。 */
$("detailCopyHeaders").onclick = () =>
  copyMessageText(
    (state.detail?.[state.tab]?.headers || [])
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  );
$("detailCopyBody").onclick = () =>
  copyMessageText(state.detail?.[state.tab]?.body_text || "");
$("detailQueryToggle").onclick = () => {
  const output = $("detailQueryJson");
  output.hidden = !output.hidden;
  $("detailQueryToggle").textContent = output.hidden
    ? "查看 Query JSON"
    : "收起 Query JSON";
};
$("detailQueryCopy").onclick = () =>
  copyMessageText($("detailQueryJson").textContent);

/** 完整报文按需读取，不受侧栏 64 KiB 预览限制。 */
$("openFullRequest").onclick = action(async () => {
  if (!state.activeId) return;
  await requestViewer.open(flowSession(), state.activeId);
});

/** 合并实时事件，不并发刷新；会话计数最多每两秒更新一次。 */
const dirty = { status: false, sessions: false, flows: false };
let refreshing = false,
  lastSessionsRefresh = 0,
  refreshDue = 0;
function scheduleRefresh(event = { type: "connected" }) {
  if (event.type === "flows") {
    if (event.session_id === state.session || (state.session === REPLAY_VIEW && state.sessions.some(item => item.id === event.session_id && item.kind === "replay"))) {
      dirty.flows = true;
      // 落盘完成时字节总数可能不变，仍需更新正文与完整状态。
      if (event.flow_id && event.flow_id === state.activeId) state.detailVersion = null;
    }
    dirty.sessions = true;
  } else if (event.type === "status") dirty.status = true;
  else if (event.type === "sessions") {
    dirty.status = true;
    dirty.sessions = true;
    ((lastSessionsRefresh = 0), (refreshDue = 0));
  } else {
    dirty.status = true;
    dirty.sessions = true;
    dirty.flows = true;
    ((lastSessionsRefresh = 0), (refreshDue = 0));
  }
  queueRefresh();
}
function queueRefresh() {
  if (refreshing || document.hidden) return;
  const delay =
    dirty.status || dirty.flows
      ? 250
      : Math.max(250, 2000 - (Date.now() - lastSessionsRefresh));
  if (state.refreshTimer) {
    if (!(dirty.status || dirty.flows) || refreshDue - Date.now() <= 250)
      return;
    clearTimeout(state.refreshTimer);
  }
  refreshDue = Date.now() + delay;
  state.refreshTimer = setTimeout(
    action(async () => {
      state.refreshTimer = null;
      if (document.hidden) return;
      refreshing = true;
      const updateStatus = dirty.status,
        updateFlows = dirty.flows;
      const updateSessions =
        dirty.sessions && Date.now() - lastSessionsRefresh >= 2000;
      dirty.status = false;
      dirty.flows = false;
      if (updateSessions) {
        dirty.sessions = false;
        lastSessionsRefresh = Date.now();
      }
      try {
        // 不同 API 独立请求，减少顺序等待；正在查看的正文只在它变化时读取。
        await Promise.all([
          updateStatus ? refreshStatus() : null,
          updateSessions ? refreshSessions() : null,
          updateFlows ? refreshFlows() : null,
        ]);
      } finally {
        refreshing = false;
        if (dirty.status || dirty.flows || dirty.sessions) queueRefresh();
      }
    }),
    delay,
  );
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleRefresh();
});
function connectLive() {
  const socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  );
  socket.onopen = () => {
    $("liveStatus").textContent = "● 实时连接";
    $("liveStatus").classList.add("connected");
    scheduleRefresh();
  };
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    scheduleRefresh(data.type === "heartbeat" ? { type: "status" } : data);
  };
  socket.onclose = () => {
    $("liveStatus").textContent = "实时连接断开 · 重连中";
    $("liveStatus").classList.remove("connected");
    setTimeout(connectLive, 2000);
  };
  socket.onerror = () => socket.close();
}

function replayOptions() {
  return {
    ids: [...state.selected],
    count: Number($("repeatCount").value),
    interval: Number($("repeatInterval").value),
  };
}
/** 单条入口固定重放一次，批量入口继续使用次数与间隔设置。 */
async function replayOne(session, id, full = false) {
  return submitReplay({ ids: [id], count: 1, interval: 0 }, session, full);
}
/** 创建独立批次并跟随其响应；过滤条件不应隐藏本次重放结果。 */
async function submitReplay(options, session = state.session, full = false) {
  const result = await json(`/api/sessions/${session}/replay`, {
    method: "POST",
    body: JSON.stringify(options),
  });
  await refreshSessions();
  await openReplayList({anchor_session: result.session_id});
  state.advancedExpression = null;
  setQuickFilterDisabled(false);
  syncFilterControls();
  $("search").value = "";
  for (const id of Object.keys(filterFields)) $(id).value = "";
  state.followReplay = { session: result.session_id, full };
  await refreshSessions();
  await refreshFlows();
  await refreshStatus();
  toast("重放任务已创建");
}

$("start").onclick = action(async () => {
  $("start").disabled = true;
  try {
    const result = await json("/api/engine/start", { method: "POST" });
    switchSession(result.session_id);
    await refreshSessions();
    await refreshFlows();
  } finally {
    await refreshStatus();
  }
});
$("stop").onclick = action(async () => {
  await json("/api/engine/stop", { method: "POST" });
  scheduleRefresh();
});
$("refreshSessions").onclick = action(async () => {
  await refreshSessions();
  await refreshFlows();
});
/** 工具栏分别显示普通筛选与分组筛选的选中状态。 */
function syncFilterControls() {
  const visibility = $("recordVisibility");
  const label = visibility.options[visibility.selectedIndex]?.textContent || "全部";
  $("statusFilterHeading").dataset.active = String(visibility.value !== "all");
  $("statusFilterHeading").title = label;
  visibility.title = label;
  const quickCount = ["filterKeyword", ...Object.keys(filterFields)].filter((id) => $(id).value.trim()).length;
  const advancedCount = state.advancedExpression
    ? countAdvancedConditions(state.advancedExpression) : 0;
  $("toggleFilters").textContent = quickCount ? `筛选 (${quickCount})` : "筛选";
  $("toggleFilters").dataset.active = String(Boolean(quickCount));
  $("clearFilters").hidden = ![...filterParams().keys()].some(key => !["sort_by", "sort_order", "scope"].includes(key));
  $("openAdvancedFilters").textContent = advancedCount
    ? `多条件 (${advancedCount})` : "多条件筛选";
  $("openAdvancedFilters").setAttribute("aria-pressed", String(Boolean(advancedCount)));
}
/** 用户修改条件时清掉旧选择，避免导出或重放已经被筛掉的记录。 */
function filtersChanged() {
  if (
    !state.advancedExpression &&
    state.directory &&
    $("filterHost").value.trim() !== state.directory.host
  ) {
    state.directory = null;
    $("directoryFilter").hidden = true;
    state.directorySignature = null;
    scheduleDirectories();
  }
  state.offset = 0;
  state.refreshSequence++;
  state.selected.clear();
  state.anchor = null;
  state.rows = [];
  state.total = 0;
  state.activeId = null;
  state.detail = null;
  renderRows();
  renderDetail();
  $("total").textContent = "查询中…";
  $("empty").querySelector("h2").textContent = "正在筛选…";
  syncFilterControls();
  clearTimeout($("search").timer);
  $("search").timer = setTimeout(action(refreshFlows), 250);
}
/** 面板条件接管查询时清除外层关键词，避免隐藏的条件叠加。 */
function innerFiltersChanged() {
  $("search").value = "";
  $("quickSearchScope").value = "url";
  filtersChanged();
}
function outerFiltersChanged() {
  $("filterKeyword").value = "";
  filtersChanged();
}
$("search").oninput = outerFiltersChanged;
$("quickSearchScope").onchange = outerFiltersChanged;
$("filterKeyword").oninput = innerFiltersChanged;
$("searchScope").onchange = innerFiltersChanged;
for (const id of Object.keys(filterFields))
  $(id).addEventListener(
    $(id).tagName === "SELECT" ? "change" : "input",
    innerFiltersChanged,
  );
/** 筛选浮层只做位移和透明度动画，不逐帧改变布局高度。 */
function hideFilters() {
  $("filterPanel").hidden = true;
  $("toggleFilters").setAttribute("aria-expanded", "false");
}
$("toggleFilters").onclick = () => {
  const panel = $("filterPanel");
  if (!panel.hidden) return hideFilters();
  $("flowActions").open = false;
  panel.hidden = false;
  $("toggleFilters").setAttribute("aria-expanded", "true");
  animateElement(panel, [
    { transform: "translateY(-4px)", opacity: 0 },
    { transform: "translateY(0)", opacity: 1 },
  ]);
};
$("flowActions").ontoggle = () => {
  if ($("flowActions").open) hideFilters();
};
/** 只收起操作浮层；请求正文和 JSON 树的折叠状态不受影响。 */
function dismissFloatingMenus(target = null) {
  let dismissed = false;
  if (
    !$("filterPanel").hidden &&
    !target?.closest?.("#filterPanel, #toggleFilters, #clearFilters")
  ) {
    hideFilters();
    dismissed = true;
  }
  for (const menu of document.querySelectorAll(
    "#flowActions, #replayMenu, .detail-policy-actions, .detail-export-menu, .detail-replay-menu",
  )) {
    if (menu.open && !menu.contains(target)) {
      menu.open = false;
      dismissed = true;
    }
  }
  return dismissed;
}
// 捕获阶段避免表格拖动等控件阻止冒泡；click 同时覆盖键盘触发。
// 原生 details 的开关同步到触发器，辅助技术与 CSS 箭头共用展开状态。
for (const menu of document.querySelectorAll(".detail-policy-actions")) {
  const trigger = menu.querySelector("summary");
  menu.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(menu.open)));
}
if (typeof FloatingPanels === "undefined") {
for (const type of ["pointerdown", "click"])
  document.addEventListener(type, (event) => dismissFloatingMenus(event.target), true);
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (typeof FloatingPanels !== "undefined" && FloatingPanels.hasOpen()) return;
  const policyTrigger = document.querySelector(".detail-policy-actions[open] > summary");
  if (dismissFloatingMenus()) {
    policyTrigger?.focus?.();
    event.preventDefault();
    event.stopPropagation();
  } else if (!document.querySelector("dialog[open]")) $("closeDetail").click();
}, true);
$("resetFilters").onclick = () => {
  $("recordVisibility").value = "all";
  state.advancedExpression = null;
  setQuickFilterDisabled(false);
  state.directory = null;
  $("directoryFilter").hidden = true;
  state.directorySignature = null;
  scheduleDirectories();
  $("search").value = "";
  $("filterKeyword").value = "";
  $("quickSearchScope").value = "url";
  $("searchScope").value = "url";
  for (const id of Object.keys(filterFields)) $(id).value = "";
  filtersChanged();
};
$("recordVisibility").onchange = filtersChanged;
$("clearFilters").onclick = (event) => {
  event.stopPropagation();
  $("resetFilters").onclick();
  // 清空后按钮隐藏，把焦点交还筛选入口，不切换面板状态。
  $("toggleFilters").focus();
};
$("selectPage").onchange = (event) => {
  for (const flow of state.rows)
    event.target.checked
      ? state.selected.add(flow.id)
      : state.selected.delete(flow.id);
  renderRows();
};
$("clearSelection").onclick = () => {
  state.selected.clear();
  renderRows();
};
$("selectFiltered").onclick = action(async () => {
  const session = state.session;
  if (!session) return;
  const filters = filterParams().toString();
  const ids = [];
  let offset = 0;
  do {
    const parameters = new URLSearchParams(filters);
    parameters.set("offset", offset);
    parameters.set("limit", 500);
    const result = await json(flowListUrl(session, parameters));
    if (result.total > 1000)
      throw new Error("一次最多选择 1000 条，请缩小筛选范围");
    for (const flow of result.items) { ids.push(flow.id); if (session === REPLAY_VIEW) state.flowSessions.set(flow.id, flow.session_id); }
    offset += 500;
    if (offset >= result.total) break;
  } while (true);
  if (session === state.session && filters === filterParams().toString()) {
    state.selected = new Set(ids);
    renderRows();
  }
});
$("previous").onclick = action(async () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  state.anchor = null;
  await refreshFlows();
});
$("next").onclick = action(async () => {
  state.offset += PAGE_SIZE;
  state.anchor = null;
  await refreshFlows();
});
document.querySelectorAll("[data-tab]").forEach(
  (button) =>
    (button.onclick = () => {
      state.tab = button.dataset.tab;
      state.detailAutoTab = false;
      document
        .querySelectorAll("[data-tab]")
        .forEach((b) => {
          const active = b === button;
          b.classList.toggle("active", active);
          b.setAttribute("aria-pressed", String(active));
        });
      renderDetail();
    }),
);
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => closeDialog(button.dataset.close)),
  );
$("repeat").onclick = action(async () => {
  const options = replayOptions(), groups = selectedGroups(options.ids);
  for (const [session, ids] of groups) await submitReplay({...options, ids}, session);
});
$("detailReplay").onclick = action(() =>
  replayOne(flowSession(), state.activeId),
);
$("detailEditReplay").onclick = action(() =>
  editReplay(flowSession(), state.activeId),
);
$("viewerReplay").onclick = action(async () => {
  const session = requestViewer.session, id = requestViewer.id;
  const url = viewerRequestUrl();
  const flow = await json(`/api/sessions/${session}/flows/${id}`);
  if (!flow.request || flow.request.truncated) throw new Error("请求正文不完整，不能重放");
  await submitReplay({ids: [id], count: 1, interval: 0, edit: {
    url, method: flow.request.method, headers: flow.request.headers, body_b64: flow.request.body_b64 || "",
  }}, session, true);
});
$("viewerEditReplay").onclick = action(async () => {
  const session = requestViewer.session,
    id = requestViewer.id;
  const url = viewerRequestUrl();
  $("requestViewer").close();
  await editReplay(session, id, true, url);
});
$("export").onclick = action(async () => {
  const format = $("exportFormat").value;
  for (const [session, ids] of selectedGroups()) {
  const response = await api(`/api/sessions/${session}/export`, {
    method: "POST",
    body: JSON.stringify({ ids, format }),
  });
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = (state.session === REPLAY_VIEW ? `replay-${session}.` : "capture.") + ({ curl: "sh", python: "py", requests: "py" }[format] || format);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
$("showReplays").onclick = action(async () => {
  const id = state.selected.size === 1 ? [...state.selected][0] : state.activeId;
  const session = id ? flowSession(id) : null;
  const replay = state.session === REPLAY_VIEW || state.sessions.some(item => item.id === session && item.kind === "replay");
  await openReplayList(id && session ? replay ? {anchor_session: session, anchor_id: id} : {source_session: session, source_id: id} : null);
});
/** 顶部返回最近的抓包记录，重放记录单独在菜单里切换。 */
$("showCapture").onclick = action(async () => {
  const captures = state.sessions.filter(
    (session) => session.kind === "capture",
  );
  const latest =
    captures.find((session) => session.id === state.lastCaptureSession) ||
    captures.find((session) => session.id === state.status?.session_id) ||
    captures[0];
  $("replayMenu").open = false;
  switchSession(latest?.id || null);
  await refreshSessions();
  await refreshFlows();
});
$("openSettings").onclick = action(async () => {
  await refreshStatus();
  const settings = state.status.settings;
  for (const [id, key] of [
    ["listenHost", "listen_host"],
    ["listenPort", "listen_port"],
    ["tlsMode", "tls_mode"],
    ["connectionMode", "connection_mode"],
    ["upstreamProxy", "upstream_proxy"],
  ])
    $(id).value = settings[key];
  $("bodyCacheLimit").value = (settings.body_limit || 2097152) / 1024;
  const streamSupported = settings.save_streamed_bodies !== undefined;
  $("streamCaptureCompatibility").hidden = streamSupported;
  $("saveStreamBodies").disabled = !streamSupported;
  $("streamBodyLimit").disabled = !streamSupported;
  $("saveStreamBodies").checked = settings.save_streamed_bodies !== false;
  $("streamBodyLimit").value = (settings.stream_body_limit || 67108864) / 1048576;
  $("tlsDomains").value = settings.tls_domains.join("\n");
  $("blockedDomains").value = settings.blocked_domains.join("\n");
  $("blockingEnabled").checked = settings.blocking_enabled;
  $("hookEnabled").checked = settings.hook_enabled;
  state.hookEntries = (
    settings.request_hooks || [
      { name: "request_hook", enabled: true },
    ]
  ).map((hook) => ({ ...hook }));
  renderHookList();
  $("settingsTheme").value = document.documentElement.dataset.theme;
  $("upstreamProxyLabel").hidden = settings.connection_mode !== "upstream";
  $("upstreamProxy").required = settings.connection_mode === "upstream";
  $("settingsDialog").showModal();
  await refreshHookFiles();
  const certificate = await json("/api/certificate/info");
  $("certificateInfo").textContent = certificate.available
    ? "CA SHA-256：" + certificate.sha256
    : "证书尚未生成，请先启动代理。";
  $("macCertificateRow").hidden = !certificate.macos_install_supported;
  $("installMacCertificate").disabled = !certificate.available || macCertificateInstalling;
  $("installMacCertificate").dataset.sha256 = certificate.sha256 || "";
});
$("mobileSettings").onclick = () => $("openSettings").click();

let macCertificateInstalling = false;
/** 安装只在用户点击时发起，等待钥匙串授权期间阻止重复提交。 */
$("installMacCertificate").onclick = action(async () => {
  const button = $("installMacCertificate");
  macCertificateInstalling = true;
  button.disabled = true;
  button.textContent = "等待系统授权…";
  $("macCertificateStatus").textContent = "请查看 macOS 的授权窗口，确认当前 CA 的安装与 SSL 信任。";
  try {
    const result = await json("/api/certificate/macos/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256: button.dataset.sha256 }),
    });
    $("macCertificateStatus").textContent = result.message + "。请重新建立客户端连接。";
  } catch (error) {
    $("macCertificateStatus").textContent = error.message;
    throw error;
  } finally {
    macCertificateInstalling = false;
    button.disabled = false;
    button.textContent = "安装并信任";
  }
});

/** Hook 列表在设置草稿中排序和开关，保存前不会改变代理行为。 */
function renderHookList() {
  const list = $("hookList");
  list.replaceChildren();
  if (!state.hookEntries.length) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "还没有 Hook，请添加已注册的类。";
    list.append(hint);
  }
  state.hookEntries.forEach((hook, index) => {
    const row = document.createElement("div");
    row.className = "hook-row";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "settings-switch";
    toggle.checked = hook.enabled;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", `启用 ${hook.name}`);
    toggle.onchange = () => {
      hook.enabled = toggle.checked;
    };
    const name = document.createElement("span");
    const description = state.hookCatalog?.find((item) => item.name === hook.name)?.description;
    name.textContent = `${index + 1}. ${hook.name}${description ? ` · ${description}` : ""}`;
    name.title = hook.name;
    row.append(toggle, name);
    for (const [label, title, delta] of [
      ["↑", "上移", -1],
      ["↓", "下移", 1],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", `${title} ${hook.name}`);
      button.disabled =
        index + delta < 0 || index + delta >= state.hookEntries.length;
      button.onclick = () => {
        const other = index + delta;
        [state.hookEntries[index], state.hookEntries[other]] = [
          state.hookEntries[other],
          state.hookEntries[index],
        ];
        renderHookList();
      };
      row.append(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", `移除 ${hook.name}`);
    remove.onclick = () => {
      state.hookEntries.splice(index, 1);
      renderHookList();
    };
    row.append(remove);
    list.append(row);
  });
}
async function refreshHookFiles() {
  const result = await json("/api/hooks");
  state.hookCatalog = result.hooks;
  const select = $("newHookName");
  select.replaceChildren(new Option("选择已注册的 Hook", ""));
  for (const hook of result.hooks) {
    const option = document.createElement("option");
    option.value = hook.name;
    option.textContent = hook.description ? `${hook.name} · ${hook.description}` : hook.name;
    select.append(option);
  }
  renderHookList();
}
$("refreshHooks").onclick = action(refreshHookFiles);
$("addHook").onclick = () => {
  const name = $("newHookName").value;
  if (!name) return toast("请选择已注册的 Hook");
  if (state.hookEntries.some((hook) => hook.name === name))
    return toast("该 Hook 已在列表中");
  if (state.hookEntries.length >= 32) return toast("最多添加 32 个 Hook");
  state.hookEntries.push({ name, enabled: true });
  $("newHookName").value = "";
  renderHookList();
};

/** 设置分类只切换面板，保留未保存的输入；遇到校验错误自动定位字段。 */
function showSettingsPanel(name) {
  const buttons = document.querySelectorAll("[data-settings-tab]");
  for (const button of buttons) {
    const selected = button.dataset.settingsTab === name;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected)
      $("settingsPanelTitle").textContent = button.dataset.settingsLabel;
  }
  for (const panel of document.querySelectorAll("[data-settings-panel]"))
    panel.hidden = panel.dataset.settingsPanel !== name;
  $("settingsDialog").querySelector(".settings-content").scrollTop = 0;
}
for (const button of document.querySelectorAll("[data-settings-tab]"))
  button.onclick = () => showSettingsPanel(button.dataset.settingsTab);
$("settingsDialog").querySelector(".settings-nav").onkeydown = (event) => {
  const tabs = [...document.querySelectorAll("[data-settings-tab]")];
  const index = tabs.indexOf(event.target);
  if (index < 0 || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
    return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) %
          tabs.length;
  showSettingsPanel(tabs[next].dataset.settingsTab);
  tabs[next].focus();
};
$("settingsTheme").onchange = () => {
  applyTheme($("settingsTheme").value);
};
$("settingsForm").onsubmit = action(async (event) => {
  event.preventDefault();
  const invalid = $("settingsForm").querySelector(":invalid");
  if (invalid) {
    showSettingsPanel(
      invalid.closest("[data-settings-panel]").dataset.settingsPanel,
    );
    invalid.reportValidity();
    return;
  }
  const settings = {
    ...state.status.settings,
    listen_host: $("listenHost").value,
    connection_mode: $("connectionMode").value,
    upstream_proxy: $("upstreamProxy").value,
    listen_port: Number($("listenPort").value),
    tls_mode: $("tlsMode").value,
    tls_domains: $("tlsDomains").value.split("\n"),
    blocked_domains: $("blockedDomains").value.split("\n"),
    blocking_enabled: $("blockingEnabled").checked,
    hook_enabled: $("hookEnabled").checked,
    request_hooks: state.hookEntries,
    body_limit: Number($("bodyCacheLimit").value) * 1024,
    save_streamed_bodies: $("saveStreamBodies").checked,
    stream_body_limit: Number($("streamBodyLimit").value) * 1048576,
  };
  await json("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  await closeDialog("settingsDialog");
  await refreshStatus();
  toast("配置已保存");
});
$("connectionMode").onchange = () => {
  $("upstreamProxyLabel").hidden = $("connectionMode").value !== "upstream";
  $("upstreamProxy").required = $("connectionMode").value === "upstream";
};
/** 详情按钮跟随当前域名的列表成员状态，外部配置更新后也同步。 */
function renderDomainActions() {
  const host = state.detail?.host?.toLowerCase();
  for (const [id, key, label] of [
    ["addDecrypt", "tls_domains", "解密"],
    ["addBlock", "blocked_domains", "拒绝"],
  ]) {
    const included = state.status?.settings?.[key]?.includes(host);
    $(id).textContent = `${included ? "移出" : "加入"}${label}列表`;
    $(id).disabled = !host;
    $(id).setAttribute("aria-pressed", String(Boolean(included)));
  }
}
/** 只移除当前域名的精确条目，不改动覆盖其他域名的通配规则。 */
async function addDomain(block) {
  if (!state.detail) throw new Error("请先选择一条记录");
  const settings = { ...state.status.settings };
  const key = block ? "blocked_domains" : "tls_domains";
  const host = state.detail.host.toLowerCase();
  const included = settings[key].includes(host);
  settings[key] = included
    ? settings[key].filter((item) => item !== host)
    : [...settings[key], host];
  if (!included) {
    if (block) settings.blocking_enabled = true;
    else settings.tls_mode = "list";
  }
  await json("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  await refreshStatus();
  renderDomainActions();
  toast("域名策略已更新");
}
$("addDecrypt").onclick = action(() => addDomain(false));
$("addBlock").onclick = action(() => addDomain(true));
const replayEditor = new ReplayEditor();
/** 编辑器保存来源会话，防止编辑期间切换列表后重放了错误批次。 */
async function editReplay(session, id, full = false, urlOverride = null) {
  const flow = await json(`/api/sessions/${session}/flows/${id}`);
  const request = flow.request;
  if (!request) throw new Error("连接记录无法编辑重放");
  if (request.truncated) throw new Error("请求正文不完整，不能编辑重放");
  $("editDialog").flow = flow;
  $("editDialog").sourceSession = session;
  $("editDialog").fullReplay = full;
  $("editMethod").value = request.method;
  $("editUrl").value = urlOverride || request.url;
  replayEditor.open(request);
  $("editDialog").showModal();
}
$("editRepeat").onclick = action(() =>
  editReplay(flowSession([...state.selected][0]), [...state.selected][0]),
);
function encodeText(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
$("editForm").onsubmit = action(async (event) => {
  event.preventDefault();
  const options = {
    ...replayOptions(),
    ids: [$("editDialog").flow.id],
    edit: replayEditor.build(),
  };
  await submitReplay(
    options,
    $("editDialog").sourceSession,
    $("editDialog").fullReplay,
  );
  await closeDialog("editDialog");
});
action(async () => {
  // 首次 API 失败也保留实时连接，后端恢复后可自动重新读取。
  connectLive();
  await refreshStatus();
  await refreshSessions();
  await refreshFlows();
})();

/** 记住详情中的文本选区，点击分析按钮时不会因焦点切换丢失。 */
let analysisSelection = null;
document.addEventListener("pointerdown", (event) => {
  if (
    event.target.closest(
      "#detailHeaders, #detailContent, #viewerHeaders, #viewerRaw, #viewerTree",
    )
  ) {
    analysisSelection = null;
    $("detailLinks").textContent = "分析 ✦";
    $("viewerLinks").textContent = "分析 ✦";
  }
});
document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const parent = range.commonAncestorContainer;
  const element =
    parent.nodeType === Node.ELEMENT_NODE ? parent : parent.parentElement;
  const viewer = element?.closest("#viewerHeaders, #viewerRaw, #viewerTree");
  const detail = element?.closest("#detailHeaders, #detailContent");
  if (!viewer && !detail) return;
  const value = selection.toString();
  if (!value.trim()) return;
  analysisSelection = {
    session: viewer ? requestViewer.session : flowSession(),
    id: viewer ? requestViewer.id : state.activeId,
    part: viewer ? requestViewer.part : state.tab,
    value,
    field: element?.closest("tr")?.dataset.analysisHeader
      ? `${viewer ? requestViewer.part : state.tab}.headers.${element.closest("tr").dataset.analysisHeader}`
      : null,
  };
  $(viewer ? "viewerLinks" : "detailLinks").textContent = "分析选中片段 ✦";
});

/** 勾选优先，其次筛选；不加载请求正文，最多固定 2000 条目标请求。 */
async function analysisRequestScope(session) {
  if (state.session === REPLAY_VIEW) {
    const ids = [...state.selected].filter(id => flowSession(id) === session);
    if (ids.length) return {ids, label: `当前批次勾选的 ${ids.length} 条请求`};
    const filters = filterParams();
    if ([...filters.keys()].some(key => !["scope", "sort_by", "sort_order"].includes(key))) {
      const params = new URLSearchParams(filters); params.set("limit", 500);
      const ids = [];
      for (let offset = 0; ; offset += 500) {
        params.set("offset", offset);
        const result = await json(`/api/sessions/${encodeURIComponent(session)}/flows?${params}`);
        if (result.total > 2000) throw new Error("当前批次匹配结果超过 2000 条，请缩小范围");
        ids.push(...result.items.map(item => item.id));
        if (offset + 500 >= result.total) break;
      }
      return {ids, label: `当前批次筛选的 ${ids.length} 条请求`};
    }
    return {ids: null, label: "当前请求所属的重放批次"};
  }
  if (session !== state.session) return { ids: null, label: "整个会话" };
  if (state.selected.size)
    return {
      ids: [...state.selected],
      label: `勾选的 ${state.selected.size} 条请求`,
    };
  const filters = filterParams();
  if (![...filters.keys()].some((key) => key !== "scope"))
    return { ids: null, label: "整个会话" };
  const ids = [];
  for (let offset = 0; ; offset += 500) {
    const query = new URLSearchParams(filters);
    query.set("offset", offset);
    query.set("limit", 500);
    const result = await json(
      `/api/sessions/${encodeURIComponent(session)}/flows?${query}`,
    );
    if (result.total > 2000)
      throw new Error("筛选结果超过 2000 条，请缩小范围后分析");
    ids.push(...result.items.map((item) => item.id));
    if (offset + 500 >= result.total) break;
  }
  return {
    ids,
    filters: Object.fromEntries(filters),
    label: `筛选后的 ${ids.length} 条请求`,
  };
}

/** 从详情启动分析：先确认停止记录，代理转发不中断；敏感选区不放入 URL。 */
async function openDataLinks(session, id, part) {
  if (!session || !id) throw new Error("请先选择请求");
  const selection =
    analysisSelection?.session === session &&
    analysisSelection.id === id &&
    analysisSelection.part === part
      ? analysisSelection.value
      : "";
  if (selection.length > 4096)
    throw new Error("选中内容超过 4096 字符，请选择具体参数或 Cookie 片段");
  let scope = await analysisRequestScope(session);
  const status = await json("/api/status");
  let live = false;
  if (status.recording && status.session_id === session) {
    const dialog = $("analysisModeDialog");
    $("analysisModeScope").textContent = `分析范围：${scope.label}`;
    dialog.returnValue = "cancel";
    const mode = await new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue), {
        once: true,
      });
      dialog.showModal();
    });
    if (mode !== "stop" && mode !== "live") return;
    live = mode === "live";
    if (!live) {
      await json("/api/engine/stop", { method: "POST" });
      await refreshStatus();
      scope = await analysisRequestScope(session);
    }
  }
  const handoff = crypto.randomUUID();
  sessionStorage.setItem(
    `capture.analysis.${handoff}`,
    JSON.stringify({
      session,
      id,
      part,
      selection,
      field: selection ? analysisSelection.field : null,
      live,
      ...scope,
    }),
  );
  location.href = `/links.html?session=${encodeURIComponent(session)}&flow=${encodeURIComponent(id)}&handoff=${handoff}`;
}
$("detailLinks").onclick = action(() =>
  openDataLinks(flowSession(), state.activeId, state.tab),
);
$("viewerLinks").onclick = action(() =>
  openDataLinks(requestViewer.session, requestViewer.id, requestViewer.part),
);

/** 高级筛选只编辑草稿；应用前不改变列表及已有勾选。 */
const advancedFields = [
  ["host", "域名"], ["url", "URL"], ["method", "方法"],
  ["status_code", "状态码"], ["status", "记录状态"], ["source", "来源"],
  ["content_type", "响应类型"], ["request_header", "请求头"],
  ["response_header", "响应头"], ["request_body", "请求正文"],
  ["response_body", "响应正文"], ["reason", "错误信息"],
  ["duration", "耗时 ms"], ["size", "响应大小 B"],
];
const advancedOperators = {
  host: [["eq", "等于"], ["neq", "不等于"], ["contains", "包含"], ["not_contains", "不包含"]],
  url: [["contains", "包含"], ["not_contains", "不包含"]],
  method: [["eq", "等于"], ["neq", "不等于"]],
  status_code: [["eq", "属于"], ["neq", "不属于"]],
  status: [["eq", "等于"], ["neq", "不等于"]],
  source: [["eq", "等于"], ["neq", "不等于"]],
  content_type: [["contains", "包含"], ["not_contains", "不包含"]],
  request_header: [["contains", "包含"], ["not_contains", "不包含"]],
  response_header: [["contains", "包含"], ["not_contains", "不包含"]],
  request_body: [["contains", "包含"], ["not_contains", "不包含"]],
  response_body: [["contains", "包含"], ["not_contains", "不包含"]],
  reason: [["contains", "包含"], ["not_contains", "不包含"]],
  duration: [["gte", "不少于"], ["lte", "不多于"]],
  size: [["gte", "不少于"], ["lte", "不多于"]],
};
const advancedValues = {
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT"],
  status: ["complete", "pending", "receiving", "blocked", "passthrough", "error", "interrupted"],
  source: ["capture", "replay"],
};
function advancedCondition(field = "url", operator = "contains", value = "") {
  return { field, operator, value };
}
function advancedGroup(operator = "and", children = []) {
  return { operator, children };
}
function countAdvancedConditions(node) {
  return node.children
    ? node.children.reduce((count, child) => count + countAdvancedConditions(child), 0)
    : 1;
}
function countAdvancedGroups(node) {
  return node.children ? 1 + node.children.reduce((count, child) => count + countAdvancedGroups(child), 0) : 0;
}
function setQuickFilterDisabled(disabled) {
  for (const id of ["search", "quickSearchScope", "filterKeyword", "searchScope", ...Object.keys(filterFields)])
    $(id).disabled = disabled;
  $("search").placeholder = disabled ? "高级筛选已启用，点击右侧编辑" : "搜索关键词…";
  $("filterHelpText").textContent = disabled
    ? "高级筛选已启用；编辑分组或重置全部筛选后可使用快捷条件。"
    : "条件之间为“同时满足”；关键词忽略大小写；正文按已保存内容搜索，最多解压 16 MiB。";
}
function importQuickFilters() {
  const children = [];
  const { search, scope } = activeKeyword();
  if (search) {
    const fields = scope === "url" ? ["url"] : scope === "headers"
      ? ["request_header", "response_header"]
      : scope === "request_body" ? ["request_body"]
      : scope === "response_body" ? ["response_body"]
      : scope === "bodies" ? ["request_body", "response_body"]
      : ["host", "url", "request_header", "response_header", "request_body", "response_body", "reason"];
    const parts = fields.map((field) => advancedCondition(field, "contains", search));
    children.push(parts.length === 1 ? parts[0] : advancedGroup("or", parts));
  }
  for (const [id, field, operator] of [
    ["filterHost", "host", "eq"], ["filterMethod", "method", "eq"],
    ["filterCode", "status_code", "eq"], ["filterStatus", "status", "eq"],
    ["filterSource", "source", "eq"], ["filterType", "content_type", "contains"],
    ["filterMinDuration", "duration", "gte"], ["filterMaxDuration", "duration", "lte"],
    ["filterMinSize", "size", "gte"],
  ]) {
    const value = $(id).value.trim();
    if (value) children.push(advancedCondition(field, operator, value));
  }
  return advancedGroup("and", children.length ? children : [advancedCondition()]);
}
function advancedSelect(options, selected, onChange, label) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  for (const [value, title] of options) select.add(new Option(title, value));
  select.value = selected;
  select.onchange = () => onChange(select.value);
  return select;
}
function advancedButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.onclick = onClick;
  return button;
}
function renderAdvancedCondition(node, parent, index) {
  const row = document.createElement("div");
  row.className = "advanced-condition";
  row.append(advancedSelect(advancedFields, node.field, (field) => {
    node.field = field;
    node.operator = advancedOperators[field][0][0];
    node.value = "";
    renderAdvancedEditor();
  }, "条件字段"));
  row.append(advancedSelect(advancedOperators[node.field], node.operator, (operator) => {
    node.operator = operator;
    updateAdvancedPreview();
  }, "比较方式"));
  const choices = advancedValues[node.field];
  if (choices) {
    const values = [["", "选择值"], ...choices.map((value) => [value, value])];
    row.append(advancedSelect(values, node.value, (value) => {
      node.value = value;
      updateAdvancedPreview();
    }, "条件值"));
  } else {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "条件值");
    input.placeholder = node.field === "status_code" ? "200 / 4xx / 400-499" : "输入匹配值";
    input.value = node.value;
    input.oninput = () => {
      node.value = input.value;
      updateAdvancedPreview();
    };
    row.append(input);
  }
  row.append(advancedButton("移除", () => {
    parent.children.splice(index, 1);
    renderAdvancedEditor();
  }));
  return row;
}
function renderAdvancedGroup(node, depth = 1, parent = null, index = -1) {
  const group = document.createElement("section");
  group.className = "advanced-group";
  group.dataset.operator = node.operator;
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", `第 ${depth} 层条件组`);
  const heading = document.createElement("div");
  heading.className = "advanced-group-head";
  const title = document.createElement("strong");
  title.textContent = depth === 1 ? "所有条件" : `第 ${depth} 层分组`;
  heading.append(title);
  heading.append(advancedSelect([["and", "全部满足 AND"], ["or", "任一满足 OR"]], node.operator, (operator) => {
    node.operator = operator;
    group.dataset.operator = operator;
    updateAdvancedPreview();
  }, "组内关系"));
  if (parent) heading.append(advancedButton("删除组", () => {
    parent.children.splice(index, 1);
    renderAdvancedEditor();
  }));
  group.append(heading);
  const children = document.createElement("div");
  children.className = "advanced-children";
  node.children.forEach((child, childIndex) => children.append(
    child.children ? renderAdvancedGroup(child, depth + 1, node, childIndex)
      : renderAdvancedCondition(child, node, childIndex),
  ));
  group.append(children);
  const actions = document.createElement("div");
  actions.className = "advanced-group-actions";
  actions.append(advancedButton("+ 条件", () => {
    if (countAdvancedConditions(state.advancedDraft) >= 30) return toast("最多 30 个条件");
    node.children.push(advancedCondition());
    renderAdvancedEditor();
  }));
  if (depth < 4) actions.append(advancedButton("+ 子组", () => {
    if (countAdvancedGroups(state.advancedDraft) >= 15) return toast("最多 15 个分组");
    node.children.push(advancedGroup("and", [advancedCondition()]));
    renderAdvancedEditor();
  }));
  group.append(actions);
  return group;
}
function advancedLogic(node) {
  if (!node.children) {
    const field = advancedFields.find(([value]) => value === node.field)?.[1] || node.field;
    const operator = advancedOperators[node.field].find(([value]) => value === node.operator)?.[1] || node.operator;
    return `${field} ${operator} ${node.value || "未填写"}`;
  }
  return `(${node.children.map(advancedLogic).join(node.operator === "and" ? " 且 " : " 或 ")})`;
}
function advancedDraftValid(node) {
  if (!node.children) return Boolean(node.value.trim());
  return node.children.length > 0 && node.children.every(advancedDraftValid);
}
function updateAdvancedPreview() {
  const draft = state.advancedDraft;
  $("advancedLogic").textContent = draft.children.length ? advancedLogic(draft) : "无高级条件";
  $("applyAdvancedFilters").disabled = draft.children.length > 0 && !advancedDraftValid(draft);
  const sequence = ++state.advancedPreviewSequence;
  clearTimeout(state.advancedPreviewTimer);
  if (!state.session || !advancedDraftValid(draft)) {
    $("advancedMatchCount").textContent = draft.children.length ? "请填写所有条件" : "应用后清除高级筛选";
    return;
  }
  $("advancedMatchCount").textContent = "正在计算匹配数量…";
  state.advancedPreviewTimer = setTimeout(async () => {
    const params = new URLSearchParams({ expression: JSON.stringify(draft), limit: "1" });
    if (state.directory) {
      params.set("host", state.directory.host);
      params.set("path_prefix", state.directory.path);
    }
    try {
      const response = await fetch(flowListUrl(state.session, params));
      const result = await response.json();
      if (sequence !== state.advancedPreviewSequence) return;
      $("advancedMatchCount").textContent = response.ok
        ? `当前会话匹配 ${result.total} 条` : "条件值无效，请检查后再应用";
    } catch {
      if (sequence === state.advancedPreviewSequence)
        $("advancedMatchCount").textContent = "暂时无法计算数量";
    }
  }, 400);
}
function renderAdvancedEditor() {
  $("advancedGroups").replaceChildren(renderAdvancedGroup(state.advancedDraft));
  updateAdvancedPreview();
}
function openAdvancedEditor() {
  hideFilters();
  state.advancedDraft = state.advancedExpression
    ? structuredClone(state.advancedExpression) : importQuickFilters();
  renderAdvancedEditor();
  $("advancedFilterDialog").showModal();
}
$("openAdvancedFilters").onclick = openAdvancedEditor;
$("closeAdvancedFilters").onclick = () => closeDialog("advancedFilterDialog");
$("cancelAdvancedFilters").onclick = () => closeDialog("advancedFilterDialog");
$("clearAdvancedFilters").onclick = () => {
  state.advancedDraft = advancedGroup();
  renderAdvancedEditor();
};
$("applyAdvancedFilters").onclick = action(async () => {
  const draft = state.advancedDraft;
  if (draft.children.length && !advancedDraftValid(draft))
    throw new Error("请填写所有条件");
  if (state.session && draft.children.length) {
    const params = new URLSearchParams({ expression: JSON.stringify(draft), limit: "1" });
    const response = await fetch(flowListUrl(state.session, params));
    if (!response.ok) throw new Error("筛选条件无效，请检查字段和值");
  }
  state.advancedExpression = draft.children.length ? structuredClone(draft) : null;
  $("search").value = "";
  $("filterKeyword").value = "";
  $("quickSearchScope").value = "url";
  $("searchScope").value = "url";
  for (const id of Object.keys(filterFields)) $(id).value = "";
  setQuickFilterDisabled(Boolean(state.advancedExpression));
  await closeDialog("advancedFilterDialog");
  filtersChanged();
});

/** 表头排序在服务端执行，实时刷新和翻页沿用用户选择。 */
for (const [id, field] of [
  ["sortStarted", "started"],
  ["sortSize", "size"],
]) {
  $(id).onclick = action(async () => {
    state.sortOrder = state.sortBy !== field || state.sortOrder === "none" ? "asc" : state.sortOrder === "asc" ? "desc" : "none";
    state.sortBy = field;
    state.offset = 0;
    for (const [button, key, title, cell] of [
      ["sortStarted", "started", "请求时间", "timeSortHeader"],
      ["sortSize", "size", "大小", "sizeSortHeader"],
    ]) {
      const active = state.sortBy === key && state.sortOrder !== "none";
      $(button).textContent = `${title} ${active ? state.sortOrder === "asc" ? "↑" : "↓" : "↕"}`;
      $(button).classList.toggle("active", active);
      $(cell).setAttribute("aria-sort", active ? state.sortOrder === "asc" ? "ascending" : "descending" : "none");
    }
    await refreshFlows();
  });
}

/** 详情代码框只处理当前请求，手动复制且不下载文件。 */
async function exportDetail(session, id, format, urlOverride = null) {
  if (!session || !id) throw new Error("请先选择请求");
  const response = await api(`/api/sessions/${session}/export`, {
    method: "POST", body: JSON.stringify({ids: [id], format, ...(urlOverride ? {request_url: urlOverride} : {})}),
  });
  if (urlOverride && response.headers.get("X-Capture-URL-Override") !== "applied") {
    throw new Error("当前后端尚未支持修改导出 URL，请重启后端后再生成代码");
  }
  $("curlCopyTitle").textContent = format === "curl" ? "cURL 命令" : "Python requests 代码";
  $("curlCopyText").value = (await response.text()).trim();
  $("curlCopyDialog").showModal();
  $("curlCopyText").focus();
  $("curlCopyText").select();
}
for (const prefix of ["detail", "viewer"]) {
  for (const [suffix, format] of [["Curl", "curl"], ["Requests", "requests"]]) {
    $(prefix + "Export" + suffix).onclick = action(async () => {
      const menu = $(prefix + "Export" + suffix).closest("details");
      menu.querySelectorAll("button[id*=\"Export\"]").forEach(button => {
        button.setAttribute("aria-pressed", String(button.id === prefix + "Export" + suffix));
      });
      menu.open = false;
      await exportDetail(prefix === "viewer" ? requestViewer.session : flowSession(),
        prefix === "viewer" ? requestViewer.id : state.activeId, format,
        prefix === "viewer" && viewerRequestUrl() !== requestViewer.flow?.request?.url
          ? viewerRequestUrl() : null);
    });
  }
}

/** 各报文区域独立调节高度，拖动期间不触发文本选择。 */
for (const area of document.querySelectorAll(
  "#viewerHeaders, #viewerBodyArea, #viewerQueryJson"
)) {
  area.classList.add("vertical-area");
  const minimum = 64;
  const handle = document.createElement("div");
  handle.className = "vertical-area-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", "上下拖动调整区域高度");
  handle.title = "上下拖动调整区域高度";
  area.after(handle);
  handle.onpointerdown = event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    const start = event.clientY, height = area.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = move => {
      if (move.pointerId !== event.pointerId) return;
      area.style.height = `${Math.max(minimum, Math.min(1600, height + move.clientY - start))}px`;
      area.style.maxHeight = "none";
    };
    const end = () => {
      handle.onpointermove = null;
      handle.onpointerup = null;
      handle.onpointercancel = null;
      handle.onlostpointercapture = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.onpointerup = end;
    handle.onpointercancel = end;
    handle.onlostpointercapture = end;
  };
}

// 请求代码弹窗只展示内容，复制由用户执行。
$("selectCurlText").onclick = () => { $("curlCopyText").focus(); $("curlCopyText").select(); };
$("closeCurlCopy").onclick = $("doneCurlCopy").onclick = () => $("curlCopyDialog").close();
$("curlCopyDialog").addEventListener("close", () => { $("curlCopyText").value = ""; });

// 正文工具操作不应触发所在 summary 的折叠。
for (const id of ["detailCopyHeaders", "detailCopyBody", "viewerMode", "viewerCopy", "viewerCollapse"]) {
  $(id).addEventListener("click", event => { event.stopPropagation(); if (id.startsWith("detail")) event.preventDefault(); });
}
$("detailEditReplay").closest("details").querySelector("summary").addEventListener("click", event => {
  if ($("detailEditReplay").disabled) event.preventDefault();
});
// 低频操作执行后关闭所属浮层，保留原有业务事件。
for (const id of ["detailLinks", "detailEditReplay", "viewerLinks", "viewerEditReplay", "addDecrypt", "addBlock"])
  $(id).addEventListener("click", () => { const menu = $(id).closest("details"); if (menu) menu.open = false; });

/** 校验详情中的 URL 草稿；仅影响后续操作，不修改已保存抓包。 */
function viewerRequestUrl() {
  const value = $("viewerUrl").value.trim();
  let url;
  try { url = new URL(value); } catch { throw new Error("请输入完整的 HTTP/HTTPS URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支持 HTTP/HTTPS URL");
  return value;
}

// App 通过原生桥接打开外部爬虫工具；浏览器启动保留普通新标签行为。
for (const link of document.querySelectorAll('a[href="https://spidertools.cn/#/"]')) {
  link.addEventListener("click", event => {
    const open = window.pywebview?.api?.open_external_tool;
    if (!open) return;
    event.preventDefault();
    action(async () => {
      if (!await open(link.href)) throw new Error("系统浏览器未能打开，可手动访问 https://spidertools.cn/#/");
    })();
  });
}
