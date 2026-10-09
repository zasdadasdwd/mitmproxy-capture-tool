import { NetworkGraph } from "./links-graph.js?v=20261002-network-v5";
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function element(tag, text, className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
function notify(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    let message;
    try {
      message = (await response.json()).detail;
    } catch {
      message = `请求失败（${response.status}）`;
    }
    throw new Error(
      typeof message === "string" ? message : JSON.stringify(message),
    );
  }
  return response.json();
}
const action =
  (callback) =>
  (...args) =>
    Promise.resolve(callback(...args)).catch((error) => notify(error.message));

/** 数据链路页面状态：字段发现、独立任务、三维节点图与证据面板。 */
class LinkPage {
  constructor() {
    this.session = "";
    this.flowId = "";
    this.seed = null;
    this.valueRange = null;
    this.requestIds = null;
    this.targetFilters = null;
    this.handoff = null;
    this.field = null;
    this.job = null;
    this.fieldsJob = null;
    this.fieldOffset = 0;
    this.branches = new Map();
    this.jobIds = [];
    this.nodes = [];
    this.edges = [];
    this.annotations = {};
    this.expandedGroups = new Set();
    this.viewId = null;
    this.selected = null;
    this.graph = new NetworkGraph(
      $("graphCanvas"),
      $("graphFallback"),
      (selection) => this.select(selection),
    );
    if (!this.graph.renderer) {
      $("graphMode").value = "2d";
      $("graphMode").querySelector('[value="3d"]').disabled = true;
      $("graphHint").textContent = "WebGL 不可用，已切换为 2D 关系图";
    }
    this.bind();
    this.liveTimer = setInterval(() => {
      if (
        $("liveLinks").checked &&
        !document.hidden &&
        !this.job &&
        this.liveConfig
      )
        this.trace(true).catch((error) => {
          if (!error.message.includes("正在忙")) notify(error.message);
        });
    }, 5000);
  }

  bind() {
    $("includeHistory").onchange = action(() => this.sessions());
    $("linkSession").onchange = action(async () => {
      this.session = $("linkSession").value;
      this.flowId = "";
      this.reset();
      await this.requests();
    });
    $("linkRequest").onchange = action(() =>
      this.chooseRequest($("linkRequest").value),
    );
    $("requestSearchForm").onsubmit = action(async (event) => {
      event.preventDefault();
      await this.requests();
    });
    $("fieldSearchForm").onsubmit = action(async (event) => {
      event.preventDefault();
      this.field = null;
      await this.trace();
    });
    $("fieldSearch").oninput = () => {
      this.field = null;
      this.valueRange = null;
      $("selectedField").textContent = "搜索名称或片段：在所有报文位置查找";
      $("traceLinks").disabled = !$("fieldSearch").value && !this.field;
    };
    $("browseFields").onclick = action(() => this.discover());
    $("revealValues").onchange = action(() => this.discover());
    $("previousFields").onclick = action(() =>
      this.fields(this.fieldOffset - 100),
    );
    $("nextFields").onclick = action(() => this.fields(this.fieldOffset + 100));
    $("previousOccurrences").onclick = () => {
      this.occurrenceOffset = Math.max(0, (this.occurrenceOffset || 0) - 50);
      this.renderOccurrences();
    };
    $("nextOccurrences").onclick = () => {
      this.occurrenceOffset = (this.occurrenceOffset || 0) + 50;
      this.renderOccurrences();
    };
    $("traceLinks").onclick = action(() => this.trace());
    $("cancelLinks").onclick = action(() => this.cancel());
    $("graphMode").onchange = () => this.graph.setMode($("graphMode").value);
    $("resetCamera").onclick = () => this.graph.reset();
    $("closeNodeCard").onclick = () => {
      $("nodeCard").hidden = true;
      this.graph.highlight();
      this.selected = null;
    };
    $("focusNode").onclick = () =>
      this.graph.focus(this.selected?.node?.id || this.selected?.edge?.to);
    $("nodeDetails").onclick = action(() => this.details());
    $("expandNode").onclick = action(() => this.expand());
    $("saveNote").onclick = () => {
      const key = this.selected?.edge?.id || this.selected?.node?.id;
      if (!key) return;
      this.annotations[key] = {
        judgment: $("edgeJudgment").value,
        note: $("edgeNote").value,
      };
      this.draw();
      this.renderEdges();
      notify("判断已记录；保存视图后可长期保留");
    };
    $("saveView").onclick = () => {
      $("saveViewDialog").showModal();
    };
    $("cancelSaveView").onclick = () => $("saveViewDialog").close();
    $("saveViewForm").onsubmit = action(async (event) => {
      event.preventDefault();
      await this.save();
    });
    $("loadView").onclick = action(() => this.load());
    $("exportGraph").onclick = () =>
      this.download(
        new Blob([JSON.stringify(this.exportData(), null, 2)], {
          type: "application/json",
        }),
        "capture-data-links.json",
      );
    $("exportImage").onclick = () => {
      const image = this.graph.image();
      if (!image) return;
      const a = document.createElement("a");
      a.href = image;
      a.download =
        $("graphMode").value === "3d"
          ? "capture-network-3d.png"
          : "capture-links.svg";
      a.click();
    };
    initThemePicker($("linkTheme"));
    $("closeLinkDetail").onclick = () => $("linkDetailDialog").close();
    $("linkDetailPart").onchange = () => this.renderFullDetail();
    window.addEventListener("pagehide", () => {
      clearInterval(this.liveTimer);
      this.graph.close();
    });
  }

  async init() {
    const params = new URLSearchParams(location.search);
    this.session = params.get("session") || "";
    this.flowId = params.get("flow") || "";
    const handoffKey = `capture.analysis.${params.get("handoff")}`;
    const stored = sessionStorage.getItem(handoffKey);
    if (stored) {
      sessionStorage.removeItem(handoffKey);
      const handoff = JSON.parse(stored);
      if (handoff.session === this.session && handoff.id === this.flowId) {
        this.handoff = handoff;
        this.requestIds = handoff.live && handoff.filters ? null : handoff.ids;
        this.targetFilters = handoff.live ? handoff.filters || null : null;
        $("analysisScope").textContent =
          `分析范围：${handoff.label} · 查找更早的来源及后续使用`;
        $("linkWindow").value = 86400;
        $("liveLinks").checked = Boolean(handoff.live);
      }
    }
    if (this.session)
      $("returnWorkbench").href =
        "/?session=" + encodeURIComponent(this.session);
    await this.sessions();
    await this.views();
    if (params.get("view")) {
      $("savedViews").value = params.get("view");
      await this.load();
      return;
    }
    await this.requests();
  }

  async sessions() {
    const sessions = await api(
      "/api/sessions?include_archived=" + $("includeHistory").checked,
    );
    $("linkSession").replaceChildren(
      ...sessions.map(
        (session) => new Option(`${session.id} · ${session.kind}`, session.id),
      ),
    );
    if (
      this.session &&
      !sessions.some((session) => session.id === this.session)
    ) {
      $("linkSession").append(
        new Option(this.session + " · 指定会话", this.session),
      );
    }
    this.session = this.session || sessions[0]?.id || "";
    $("linkSession").value = this.session;
  }

  reset() {
    this.requestIds = null;
    this.targetFilters = null;
    this.valueRange = null;
    this.branches.clear();
    this.nodes = [];
    this.edges = [];
    this.jobIds = [];
    this.expandedGroups.clear();
    this.field = null;
    this.liveConfig = null;
    this.viewId = null;
    this.annotations = {};
    $("nodeCard").hidden = true;
    $("graphEmpty").hidden = false;
    this.graph.setData([], [], { reset: true });
  }

  async requests() {
    if (!this.session) {
      $("linkProgress").textContent = "暂无抓包会话，请先抓包或包含历史会话";
      return;
    }
    const query = new URLSearchParams({
      limit: 100,
      search: $("requestSearch").value,
    });
    const result = await api(
      `/api/sessions/${encodeURIComponent(this.session)}/flows?${query}`,
    );
    $("linkRequest").replaceChildren(
      ...result.items.map(
        (flow) => new Option(`${flow.method} ${flow.url}`, flow.id),
      ),
    );
    if (this.flowId && !result.items.some((flow) => flow.id === this.flowId))
      $("linkRequest").append(
        new Option("指定请求 · " + this.flowId, this.flowId),
      );
    const id = this.flowId || result.items[0]?.id;
    if (id) await this.chooseRequest(id);
  }

  async chooseRequest(id) {
    if (this.job) await this.cancel();
    this.flowId = id;
    this.field = null;
    this.valueRange = null;
    $("linkRequest").value = id;
    this.seed = await api(
      `/api/sessions/${encodeURIComponent(this.session)}/flows/${encodeURIComponent(id)}?preview=true`,
    );
    const sessionInfo = await api(
      `/api/sessions/${encodeURIComponent(this.session)}/info`,
    );
    $("liveLinks").disabled = sessionInfo.status !== "running";
    if ($("liveLinks").disabled) $("liveLinks").checked = false;
    $("liveLinks").title =
      sessionInfo.status === "running"
        ? "每5秒增量复核新增或改变的请求"
        : "历史会话已结束，不进行实时轮询";
    // 详情入口传入的请求可能不在第一页，用真实网址替代内部请求 ID。
    const selectedRequest = $("linkRequest").selectedOptions[0];
    if (selectedRequest)
      selectedRequest.textContent = `${this.seed.method || ""} ${this.seed.url || id}`;
    $("seedUrl").title = this.seed.url || id;
    $("seedUrl").textContent = this.seed.url || id;
    $("traceLinks").disabled = true;
    $("selectedField").textContent =
      "输入参数名或片段，搜索全部匹配报文；也可浏览起点字段。";
    $("linkFields").replaceChildren();
    $("fieldPages").hidden = true;
    this.fieldsJob = null;
    this.liveConfig = null;
    $("traceLinks").disabled = !$("fieldSearch").value;
    $("linkProgress").textContent = "输入参数名或片段，点击搜索关联";
    if (this.handoff?.selection) await this.discover();
    else this.handoff = null;
  }

  /** 轮询只取进度；完成后按页加载有界结果，取消会终止独立子进程。 */
  async task(options) {
    if (this.job) throw new Error("当前页面正在分析，请等待或取消");
    $("cancelLinks").disabled = false;
    $("traceLinks").disabled = true;
    try {
      const started = await api("/api/links/jobs", {
        method: "POST",
        body: JSON.stringify(options),
      });
      this.job = started.id;
      let status = started;
      while (status.status === "running") {
        const progress = status.progress || {};
        $("linkProgress").textContent =
          `独立进程分析中 · ${progress.scanned || 0} / ${progress.total || "…"} · 已匹配 ${progress.matched || 0}`;
        await wait(250);
        status = await api(`/api/links/jobs/${started.id}`);
      }
      if (status.status !== "complete")
        throw new Error(status.error || "分析已取消");
      const result = await api(
        `/api/links/jobs/${started.id}/result?limit=100`,
      );
      if (result.operation !== "fields") {
        for (let offset = 100; offset < result.total; offset += 100) {
          const page = await api(
            `/api/links/jobs/${started.id}/result?offset=${offset}&limit=100`,
          );
          result.nodes.push(...page.nodes);
          result.edges.push(...page.edges);
        }
      }
      $("linkProgress").textContent =
        `完成 · ${Math.round(status.duration_ms || 0)} ms · 分析与抓包进程隔离`;
      return { ...result, job_id: started.id };
    } finally {
      this.job = null;
      $("cancelLinks").disabled = true;
      $("traceLinks").disabled = !this.field && !$("fieldSearch").value;
    }
  }

  async cancel() {
    if (this.job)
      await api(`/api/links/jobs/${this.job}/cancel`, { method: "POST" });
  }
  async discover() {
    if (this.handoff?.selection) {
      $("fieldSearch").value = this.handoff.selection;
      this.field = null;
      this.handoff = null;
      await this.trace();
      return;
    }
    const result = await this.task({
      operation: "fields",
      session_id: this.session,
      flow_id: this.flowId,
      query: "",
      query_scope: $("fieldScope").value,
      reveal: Boolean(this.handoff?.selection) || $("revealValues").checked,
    });

    this.fieldsJob = result.job_id;
    this.fieldOffset = 0;
    this.renderFields(result);
    $("linkWarnings").textContent = result.warnings.join("\n");
  }
  async fields(offset) {
    if (!this.fieldsJob || offset < 0) return;
    const result = await api(
      `/api/links/jobs/${this.fieldsJob}/result?offset=${offset}&limit=100`,
    );
    this.fieldOffset = offset;
    this.renderFields(result);
  }
  renderFields(result) {
    const buttons = result.items.map((item) => {
      const button = element("button", "", "link-field");
      button.type = "button";
      button.append(
        element("strong", item.field),
        element("small", item.value),
      );
      if (item.common)
        button.append(element("small", "短值 / 常见值 · 默认不追踪"));
      button.onclick = () => {
        $("fieldSearch").value = "";
        this.field = item;
        this.valueRange = null;
        $("linkFields")
          .querySelectorAll(".active")
          .forEach((node) => node.classList.remove("active"));
        button.classList.add("active");
        $("selectedField").textContent = `${item.field}\n${item.value}`;
        $("traceLinks").disabled = false;
        this.select({ node: { ...this.seed, source: true }, field: item });
      };
      return button;
    });
    $("linkFields").replaceChildren(...buttons);
    $("fieldCount").textContent =
      `${this.fieldOffset + 1}–${this.fieldOffset + result.items.length} / ${result.total}`;
    $("fieldPages").hidden = result.total === 0;
    $("previousFields").disabled = this.fieldOffset === 0;
    $("nextFields").disabled = !result.has_more;
  }

  options() {
    if ($("linkMode").value === "trace" && !this.field)
      throw new Error("字段转换追踪需要先浏览并选择起点字段");
    let rules = [];
    try {
      rules = JSON.parse($("linkRules").value || "[]");
    } catch {
      throw new Error("转换规则应为合法 JSON 数组");
    }
    return {
      operation: $("linkMode").value,
      query: this.field ? "" : $("fieldSearch").value,
      session_id: this.session,
      flow_id: this.flowId,
      field: this.field?.field || "",
      window_seconds: Number($("linkWindow").value),
      scan_limit: Number($("linkScan").value),
      node_limit: Number($("linkNodes").value),
      host: $("linkHost").value.trim(),
      direction: $("linkDirection").value,
      value_range: this.valueRange,
      request_ids: this.requestIds,
      target_filters: this.targetFilters,
      transforms: $("linkTransforms").checked,
      contains: $("linkContains").checked,
      allow_common: $("linkCommon").checked,
      include_overlap: $("linkOverlap").checked,
      rules,
    };
  }

  async trace(live = false) {
    if (
      !live &&
      !this.field &&
      !$("fieldSearch").value &&
      !this.liveConfig?.query_from
    )
      throw new Error("请输入参数名或片段，或选择起点字段");
    const config = live
      ? this.liveConfig
      : !this.field && !$("fieldSearch").value && this.liveConfig?.query_from
        ? this.liveConfig
        : this.options();
    if (!config) return;
    const key = JSON.stringify(config);
    const previous = this.branches.get(key);
    const result = await this.task({
      ...config,
      ...(previous ? { incremental_from: previous.job_id } : {}),
    });
    const depth =
      previous?.depth ??
      (this.nodes.find((node) => node.id === config.flow_id)?.depth || 0);
    if (!live && config.operation === "search") this.branches.clear();
    this.branches.set(key, { ...result, depth, config });
    this.liveConfig = config;
    if (
      live &&
      result.operation === "trace" &&
      Date.now() > result.scope.end * 1000
    ) {
      $("liveLinks").checked = false;
      notify("当前时间窗已结束，扩大时间窗可继续追踪");
    }
    if (this.branches.size > 20)
      this.branches.delete(this.branches.keys().next().value);
    this.combine({}, !live && config.operation === "search");
    this.scope(result);
    if (config.operation === "search") {
      $("nodeCard").hidden = true;
      this.selected = null;
      this.graph.highlight();
      return;
    }
    this.select({
      node: this.nodes.find((node) => node.id === config.flow_id),
      field: {
        field: result.source.field,
        value: result.source.value,
        fingerprint: result.source.fingerprint,
      },
    });
  }

  combine(saved = {}, reset = false) {
    const nodes = new Map(),
      edges = new Map();
    this.jobIds = [];
    for (const branch of this.branches.values()) {
      this.jobIds.push(branch.job_id);
      for (const node of branch.nodes) {
        const previous = nodes.get(node.id);
        nodes.set(node.id, {
          ...node,
          ...previous,
          depth:
            previous?.depth ??
            (node.id === branch.source.id ? branch.depth : branch.depth + 1),
        });
      }
      for (const edge of branch.edges) edges.set(edge.id, edge);
    }
    this.nodes = [...nodes.values()];
    const ids = new Set(this.nodes.map((node) => node.id));
    this.edges = [...edges.values()].filter(
      (edge) => ids.has(edge.from) && ids.has(edge.to),
    );
    $("graphEmpty").hidden = this.nodes.length > 0;
    $("graphHint").textContent =
      `${this.nodes.length} 个请求节点 · ${this.edges.length} 条完整值关联 · 点击节点查看证据`;
    this.draw(saved, reset);
    this.renderEdges();
    this.occurrenceOffset = 0;
    this.renderOccurrences();
    if (nodes.size > 2001 || edges.size > 40000)
      notify("图形仅展示前 2001 个节点，全部匹配均保留在出现时间线中");
  }

  pathOf(url) {
    try {
      return new URL(url).pathname;
    } catch {
      return url || "/";
    }
  }

  /** 高频接口先折叠为聚合节点，点击后展开成员；原始证据仍保留。 */
  draw(saved = {}, reset = false) {
    const visibleNodes =
      this.nodes.length > 2001
        ? [
            ...this.nodes.filter((node) => node.source),
            ...this.nodes.filter((node) => !node.source).slice(0, 2000),
          ]
        : this.nodes;
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const groups = new Map();
    const sourceIds = new Set(this.edges.map((edge) => edge.from));
    for (const node of visibleNodes) {
      if (sourceIds.has(node.id)) continue;
      const key = node.host + " " + this.pathOf(node.url);
      const members = groups.get(key) || [];
      members.push(node);
      groups.set(key, members);
    }
    const replaced = new Map(),
      display = visibleNodes.filter((node) => {
        const key = node.host + " " + this.pathOf(node.url);
        return (
          sourceIds.has(node.id) ||
          (groups.get(key)?.length || 0) < 12 ||
          this.expandedGroups.has(key)
        );
      });
    for (const [key, members] of groups) {
      if (members.length < 12 || this.expandedGroups.has(key)) continue;
      const id = "group:" + key;
      display.push({
        ...members[0],
        id,
        group: true,
        groupKey: key,
        members: members.map((node) => node.id),
        url: `${key} · ${members.length} 个请求`,
      });
      for (const node of members) replaced.set(node.id, id);
    }
    const edges = new Map();
    for (const edge of this.edges) {
      if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) continue;
      const target = replaced.get(edge.to) || edge.to;
      const key =
        target === edge.to ? edge.id : edge.from + target + edge.source_field;
      edges.set(key, {
        ...edge,
        to: target,
        id: key,
        aggregate: target !== edge.to,
      });
    }
    this.graph.setData(
      display,
      [...edges.values()].map((edge) => ({
        ...edge,
        judgment: this.annotations[edge.id]?.judgment,
      })),
      { saved, reset },
    );
  }

  /** 按请求中的首次出现排序，每个请求仅列一次，各报文位置合并显示。 */
  renderOccurrences() {
    const hits = this.nodes
      .filter((node) => node.occurrences?.length)
      .map((node) => ({
        node,
        at: Math.min(...node.occurrences.map((hit) => hit.at)),
      }))
      .sort((a, b) => a.at - b.at || a.node.id.localeCompare(b.node.id));
    const offset = this.occurrenceOffset || 0;
    $("occurrencePages").hidden = hits.length === 0;
    $("occurrenceCount").textContent =
      `${hits.length ? offset + 1 : 0}–${Math.min(offset + 50, hits.length)} / ${hits.length}`;
    $("previousOccurrences").disabled = offset === 0;
    $("nextOccurrences").disabled = offset + 50 >= hits.length;
    $("linkOccurrences").replaceChildren(
      ...hits.slice(offset, offset + 50).map((hit, index) => {
        const button = element(
          "button",
          `第 ${offset + index + 1} 个出现请求 · ${new Date(hit.at * 1000).toLocaleTimeString()}\n${hit.node.method} ${hit.node.url}\n${hit.node.occurrences.map((location) => `${location.field} · ${location.count} 处`).join("\n")}`,
          "evidence-button",
        );
        button.onclick = () => this.select({ node: hit.node });
        return button;
      }),
    );
  }

  /** 来源线索按完整值和后续使用数排序，点选后可查看原始响应。 */
  renderSources(result) {
    const candidates = result.source_candidates || [];
    $("linkSources").replaceChildren(
      ...candidates.slice(0, 30).map((item) => {
        const label = item.matches_reference_value
          ? "与参考请求完整值一致"
          : item.earlier_than_reference
            ? "更早的响应"
            : item.request_id === result.source.id
              ? "参考请求的响应"
              : "匹配的响应";
        const button = element(
          "button",
          `${label} · ${item.later_requests} 个后续请求完整值一致\n${item.url}\n${item.field}`,
          "evidence-button source-button",
        );
        button.onclick = () => {
          const node = this.nodes.find((node) => node.id === item.request_id);
          if (node) this.select({ node });
        };
        return button;
      }),
    );
    if (!candidates.length)
      $("linkSources").textContent = "当前范围内未捕获可核对的响应来源";
    const shortcut = $("graphSource");
    shortcut.replaceChildren();
    shortcut.hidden = !candidates.length;
    if (candidates.length) {
      const first = candidates[0];
      const name = this.pathOf(first.url);
      shortcut.append(element("strong", "优先查看响应来源"));
      const button = element(
        "button",
        `${name} · ${first.field}\n${first.matches_reference_value ? "完整值与参考请求一致" : "片段匹配"} · 后续 ${first.later_requests} 个请求完整值一致`,
        "source-shortcut",
      );
      button.onclick = () => {
        const node = this.nodes.find((node) => node.id === first.request_id);
        if (node) this.select({ node });
      };
      shortcut.append(button);
    }
  }

  scope(result) {
    const scope = result.scope;
    this.renderSources(result);
    if (result.operation === "search") {
      $("linkScope").textContent =
        `搜索整个指定范围 · 扫描 ${scope.scanned} 条\n匹配 ${scope.matched_requests} 个请求 · ${scope.occurrence_count} 个报文位置\n${result.source.matched ? "起点包含片段" : "起点不含片段，仅作为分析参考点"}\n${scope.text_search_complete ? "已搜索全部保存的正文" : "搜索不完整：查看下方限制或正文缺失提示"}\n${scope.scan_limit_reached ? "扫描达到上限，请缩小筛选范围后继续搜索。" : ""}`;
    } else
      $("linkScope").textContent =
        `扫描 ${scope.scanned} 条 · 本次解析 ${scope.parsed} · 增量复用 ${scope.reused}\n来源候选 ${scope.source_candidates || 0} 条 · 更早使用 ${scope.earlier_uses || 0} 条 · 后续使用 ${scope.later_uses ?? scope.matched_requests} 条\n匹配 ${scope.matched_requests} 条 · 展示 ${scope.displayed_requests} 条\n时间窗 ${scope.window_seconds} 秒 · 正文上限 64 KiB\n${scope.scan_limit_reached ? "扫描达到上限，后续请求尚未全部扫描。" : ""}\n${scope.node_limit_reached ? "部分匹配未展示，可增加展示上限再查询。" : ""}`;
    $("linkWarnings").textContent = result.warnings.join("\n");
    $("linkGroups").replaceChildren(
      ...result.groups.map((group) => {
        const button = element(
          "button",
          `${group.host}${group.path}\n${group.count} 个关联请求`,
          "group-button",
        );
        button.onclick = () => {
          this.expandedGroups.add(group.host + " " + group.path);
          this.draw();
        };
        return button;
      }),
    );
  }
  /** 来源、早期使用和后续使用分开标识，值匹配均保留候选性质。 */
  edgeRole(edge) {
    return edge.role === "source_candidate"
      ? "来源候选"
      : edge.role === "same_value_sequence"
        ? "相同完整值先后出现"
        : edge.role === "earlier_use"
          ? "更早使用"
          : "后续使用";
  }
  renderEdges() {
    $("linkEdges").replaceChildren(
      ...this.edges.slice(0, 100).map((edge) => {
        const label =
          edge.relation === "shared_value"
            ? "完整值再次出现"
            : edge.relation === "exact"
              ? "原值一致"
              : edge.relation === "contains"
                ? "包含匹配"
                : "转换匹配";
        const button = element(
          "button",
          `${this.edgeRole(edge)} · ${edge.partial_selection ? (edge.full_value_match ? "完整参数一致" : "仅片段匹配") : label}\n${edge.source_field} → ${edge.target_field}\n${label} · ${edge.time_delta_ms} ms${this.annotations[edge.id]?.judgment === "excluded" ? " · 已排除" : this.annotations[edge.id]?.judgment === "confirmed" ? " · 人工确认" : ""}`,
          "evidence-button",
        );
        button.onclick = () => this.select({ edge });
        return button;
      }),
    );
  }

  /** 参数和节点共用高亮浮窗，连线证据始终用文本节点渲染。 */
  select(selection) {
    if (!selection.node && !selection.edge) return;
    this.selected = selection;
    const edge = selection.edge;
    const node =
      selection.node || this.nodes.find((node) => node.id === edge.to);
    this.graph.highlight(node?.id, edge?.id, selection.field?.field);
    $("nodeCard").hidden = false;
    $("cardTitle").textContent = edge
      ? "数据传递证据"
      : selection.field
        ? "参数高亮"
        : node?.group
          ? "接口聚合"
          : "请求节点";
    const content = [];
    if (node)
      content.push(element("p", `${node.method || ""} ${node.url || ""}`));
    if (selection.field)
      content.push(
        element("p", `${selection.field.field}\n${selection.field.value}`),
      );
    if (edge)
      content.push(
        element(
          "p",
          `${edge.source_field}\n↓ ${edge.source_transform} / ${edge.target_transform}\n${edge.target_field}`,
        ),
        element(
          "p",
          `${this.edgeRole(edge)}${edge.partial_selection ? (edge.full_value_match ? " · 完整参数一致" : " · 仅片段匹配，完整参数可能不同") : ""}\n${edge.value}\n目标：${edge.target_value}\n时间差：${edge.time_delta_ms} ms\n${edge.available_before_target ? "数据已可用" : "请求早于响应完成，仅为时序疑似"}\n候选关系，尚未证明调用依赖`,
          "muted",
        ),
      );
    if (node?.occurrences)
      content.push(
        element(
          "p",
          node.occurrences
            .map(
              (hit) =>
                `${hit.field} · ${hit.count} 次 · 首处字符 ${hit.offset} · ${new Date(hit.at * 1000).toLocaleTimeString()}`,
            )
            .join("\n"),
        ),
      );
    if (edge?.reference_link)
      content.push(
        element(
          "p",
          "连线表示共享搜索片段，按时间关联到参考请求；不代表已证明参数从该请求生成。",
          "muted",
        ),
      );
    if (node?.group)
      content.push(
        element(
          "p",
          `${node.members.length} 个请求已聚合，点击继续展开查看成员。`,
        ),
      );
    if (!edge && node && !node.group) {
      const related = this.edges
        .filter(
          (item) =>
            (item.from === node.id || item.to === node.id) &&
            (!selection.field ||
              item.source_field === selection.field.field ||
              item.target_field === selection.field.field),
        )
        .slice(0, 3);
      for (const item of related) {
        const button = element(
          "button",
          `${item.source_field} → ${item.target_field}`,
          "evidence-button",
        );
        button.onclick = () => this.select({ edge: item });
        content.push(button);
      }
    }
    $("cardContent").replaceChildren(...content);
    const note = this.annotations[edge?.id || node?.id] || {};
    $("edgeJudgment").value = note.judgment || "candidate";
    $("edgeNote").value = note.note || "";
    $("nodeDetails").disabled = !!node?.group;
    $("expandNode").textContent = node?.group
      ? "展开聚合请求"
      : "选取参数继续展开";
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      $("nodeCard").animate(
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 150 },
      );
  }

  async expand() {
    const node =
      this.selected?.node ||
      this.nodes.find((node) => node.id === this.selected?.edge?.to);
    if (!node) return;
    if (node.group) {
      this.expandedGroups.add(node.groupKey);
      this.draw();
      $("nodeCard").hidden = true;
      return;
    }
    this.flowId = node.id;
    if (
      !$("linkRequest").querySelector(`option[value="${CSS.escape(node.id)}"]`)
    )
      $("linkRequest").append(
        new Option(`${node.method} ${node.url}`, node.id),
      );
    await this.chooseRequest(node.id);
    await this.discover();
  }

  async details() {
    const node =
      this.selected?.node ||
      this.nodes.find((node) => node.id === this.selected?.edge?.to);
    if (!node || node.group) return;
    this.fullFlow = await api(
      `/api/sessions/${encodeURIComponent(this.session)}/flows/${encodeURIComponent(node.id)}?text_only=true`,
    );
    $("linkDetailUrl").textContent = this.fullFlow.url;
    $("linkDetailPart").value = node.occurrences?.some((hit) =>
      hit.field.startsWith("response."),
    )
      ? "response"
      : "request";
    this.renderFullDetail();
    $("linkDetailDialog").showModal();
  }
  renderFullDetail() {
    const message = this.fullFlow?.[$("linkDetailPart").value];
    $("linkDetailHeaders").textContent = (message?.headers || [])
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    $("linkDetailBody").textContent = message?.body_text || "暂无正文";
    if (message?.display_truncated)
      $("linkDetailBody").textContent += "\n[正文展示已达到上限]";
  }
  async views() {
    const views = await api("/api/links/views");
    $("savedViews").replaceChildren(
      new Option("保存的视图…", ""),
      ...views.map((view) => new Option(view.name, view.id)),
    );
    if (this.viewId) $("savedViews").value = this.viewId;
  }
  async save() {
    if (!this.jobIds.length) throw new Error("请先分析再保存视图");
    const payload = {
      name: $("viewName").value,
      job_ids: this.jobIds,
      positions: this.graph.positions,
      annotations: this.annotations,
      hidden_nodes: [],
      camera: this.graph.cameraState(),
    };
    const result = await api(
      "/api/links/views" + (this.viewId ? "/" + this.viewId : ""),
      { method: this.viewId ? "PUT" : "POST", body: JSON.stringify(payload) },
    );
    this.viewId = result.id;
    $("saveViewDialog").close();
    await this.views();
    history.replaceState(null, "", "/links.html?view=" + result.id);
    notify("视图与备注已保存");
  }
  async load() {
    const id = $("savedViews").value;
    if (!id) return;
    const view = await api("/api/links/views/" + id);
    this.reset();
    this.viewId = id;
    this.annotations = view.annotations || {};
    for (const jobId of view.job_ids) {
      let result = await api(`/api/links/jobs/${jobId}/result?limit=100`);
      for (let offset = 100; offset < result.total; offset += 100) {
        const page = await api(
          `/api/links/jobs/${jobId}/result?offset=${offset}&limit=100`,
        );
        result.nodes.push(...page.nodes);
        result.edges.push(...page.edges);
      }
      if (result.operation === "fields") continue;
      this.session = result.session_id;
      this.branches.set(JSON.stringify(result.configuration || { jobId }), {
        ...result,
        depth: 0,
        config: result.configuration,
      });
      this.liveConfig = result.configuration;
      $("linkMode").value = result.operation;
    }
    for (const branch of this.branches.values()) {
      for (const node of branch.nodes) {
        if (view.positions?.[node.id])
          this.expandedGroups.add(node.host + " " + this.pathOf(node.url));
      }
    }
    this.combine(view.positions, true);
    this.graph.restoreCamera(view.camera);
    const last = [...this.branches.values()].at(-1);
    if (last) {
      this.flowId = last.source.id;
      this.seed = last.source;
      this.field =
        last.operation === "search"
          ? null
          : {
              field: last.source.field,
              value: last.source.value,
              fingerprint: last.source.fingerprint,
            };
      $("linkRequest").replaceChildren(
        new Option(`${last.source.method} ${last.source.url}`, last.source.id),
      );
      $("seedUrl").textContent = last.source.url;
      $("selectedField").textContent =
        `${last.source.field}\n${last.source.value}`;
      $("traceLinks").disabled = false;
      this.scope(last);
      const config = last.configuration || {};
      this.valueRange = config.value_range || null;
      this.requestIds = config.request_ids ?? null;
      this.targetFilters = config.target_filters || null;
      for (const [id, key] of [
        ["linkWindow", "window_seconds"],
        ["linkDirection", "direction"],
        ["linkScan", "scan_limit"],
        ["linkNodes", "node_limit"],
        ["linkHost", "host"],
      ])
        if (config[key] !== undefined) $(id).value = config[key];
      for (const [id, key] of [
        ["linkTransforms", "transforms"],
        ["linkContains", "contains"],
        ["linkCommon", "allow_common"],
        ["linkOverlap", "include_overlap"],
      ])
        $(id).checked = !!config[key];
      $("linkRules").value = JSON.stringify(config.rules || []);
      this.select({ node: last.source, field: this.field });
    }
    $("viewName").value = view.name;
    await this.sessions();
    const sessionInfo = await api(
      `/api/sessions/${encodeURIComponent(this.session)}/info`,
    );
    $("liveLinks").disabled = sessionInfo.status !== "running";
    if ($("liveLinks").disabled) $("liveLinks").checked = false;
    $("linkWarnings").textContent = view.missing_requests.length
      ? `原始记录已删除：${view.missing_requests.join(", ")}。图为已保存证据。`
      : "已加载保存证据；重新分析会复核当前数据。";
  }
  exportData() {
    return {
      version: 1,
      session_id: this.session,
      job_ids: this.jobIds,
      nodes: this.nodes,
      edges: this.edges,
      annotations: this.annotations,
      positions: this.graph.positions,
      scopes: [...this.branches.values()].map((branch) => branch.scope),
      warnings: [
        ...new Set(
          [...this.branches.values()].flatMap(
            (branch) => branch.warnings || [],
          ),
        ),
      ],
    };
  }
  download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
const page = new LinkPage();
page.init().catch((error) => notify(error.message));
