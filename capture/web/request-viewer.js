/** 用键值表展示 HTTP 头，保持重复头的顺序，所有值以纯文本插入。 */
function renderMessageHeaders(target, message) {
  target.replaceChildren();
  const headers = message?.headers || [];
  if (!headers.length) {
    const empty = document.createElement("p");
    empty.className = "muted message-empty";
    empty.textContent = message ? "没有头部字段" : "暂无头部内容";
    target.append(empty);
    return;
  }
  const table = document.createElement("table");
  const body = document.createElement("tbody");
  const counts = new Map();
  for (const [key, value] of headers) {
    const row = document.createElement("tr");
    const normalized = key.toLowerCase();
    const index = counts.get(normalized) || 0;
    counts.set(normalized, index + 1);
    row.dataset.analysisHeader = `${normalized}[${index}]`;
    const name = document.createElement("th");
    name.scope = "row";
    name.textContent = key;
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(name, cell);
    body.append(row);
  }
  table.append(body);
  target.append(table);
}

/** 解码额外的百分号编码层；加号仅由 URLSearchParams 在第一层处理。 */
function decodeParameterText(text) {
  for (let depth = 0; depth < 3 && /%[\da-f]{2}/i.test(text); depth++) {
    // 一旦已是合法 JSON，就停止 URL 解码，保护内部字符串的字面 %xx。
    try { JSON.parse(text); break; } catch { /* 仍可能是编码后的 JSON。 */ }
    try {
      const next = decodeURIComponent(text);
      if (next === text) break;
      text = next;
    } catch {
      break; // 非法转义保留原文，不丢弃参数。
    }
  }
  return text;
}

/** 展开嵌套的 JSON 对象/数组，保留 token、数字字符串及布尔字符串的类型。 */
function expandParameterJson(value, depth = 0, decodeText = true) {
  if (depth >= 8) return value;
  if (typeof value === "string") {
    const text = decodeParameterText(value);
    let nested = text;
    try {
      // 支持 JSON 再包一层字符串，但不把普通标量字符串转换成其他类型。
      for (let layer = depth; layer < 8 && typeof nested === "string"; layer++)
        nested = JSON.parse(nested);
      if (nested !== null && typeof nested === "object")
        return expandParameterJson(nested, depth + 1, false);
    } catch {
      // 普通字符串不需要 JSON 解析。
    }
    return decodeText ? text : value;
  }
  if (Array.isArray(value))
    return value.map((item) => expandParameterJson(item, depth + 1, false));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, expandParameterJson(item, depth + 1, false)],
    ));
  return value;
}

/** 同名参数按出现次数分组，避免把单个参数的 JSON 数组当作重复参数列表。 */
function collectParameters(params) {
  const groups = new Map();
  let count = 0;
  for (const [key, value] of params) {
    count++;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(expandParameterJson(value));
  }
  return {
    count,
    value: Object.fromEntries([...groups].map(([key, values]) =>
      [key, values.length === 1 ? values[0] : values],
    )),
  };
}

/** 解码正文并识别表单/JSON；有效 JSON 优先，不把 JSON 中的 URL 当表单。 */
function decodeRequestBody(message) {
  const raw = message?.body_text || "";
  const contentType = (message?.headers || []).find(
    ([key]) => key.toLowerCase() === "content-type",
  )?.[1] || "";
  let decoded = raw;
  let parsed = null;
  let validJson = false;
  let form = false;
  try {
    parsed = JSON.parse(raw);
    validJson = true;
  } catch {
    const explicitForm = /application\/x-www-form-urlencoded/i.test(contentType);
    const inferredForm = !/json/i.test(contentType) &&
      /^[^&=\s{}\[\]<>]+=[\s\S]*$/.test(raw);
    if (explicitForm || inferredForm) {
      form = true;
      const params = new URLSearchParams(raw);
      parsed = collectParameters(params).value;
      validJson = true;
      // URLSearchParams 已处理首层 + 和百分号转义，此后不得再次替换 +。
      decoded = raw.replaceAll("+", " ");
      try { decoded = decodeURIComponent(decoded); } catch { /* 保留非法转义。 */ }
    } else {
      decoded = decodeParameterText(raw);
      try {
        parsed = JSON.parse(decoded);
        validJson = true;
      } catch { /* 非 JSON 正文保留解码后的文本。 */ }
    }
  }
  if (validJson && !form) parsed = expandParameterJson(parsed, 0, false);
  return {
    changed: decoded !== raw,
    form,
    parsed,
    validJson,
    // 树和原文模式不提前 stringify 大正文，实际读取文本时才生成。
    get readable() { return validJson ? JSON.stringify(parsed, null, 2) : decoded; },
  };
}

/** Query 参数先按 URL 规则解码，再展开 JSON；重复参数保留独立的值。 */
function parseQueryParameters(url) {
  try {
    const query = new URL(url, window.location.href).searchParams;
    const result = collectParameters(query);
    return { count: result.count, json: JSON.stringify(result.value, null, 2) };
  } catch {
    return { count: 0, json: "{}" };
  }
}

/** 复制当前分区的原始文本；权限不足时保留手动复制提示。 */
async function copyMessageText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    toast("复制失败，请手动选择内容复制");
  }
}

/** 完整请求弹窗：头部独立折叠，正文按需加载，JSON 树延迟生成。 */
class RequestViewer {
  constructor() {
    this.dialog = document.getElementById("requestViewer");
    this.webSocketViewer = new WebSocketViewer(document.getElementById("viewerWebSocket"));
    this.flow = null;
    this.part = "request";
    this.parsed = null;
    this.urlDraft = null;
    this.queryExpanded = false;
    this.queryJson = "{}";
    this.copyContent = "";
    this.sequence = 0;
    this.session = null;
    this.id = null;
    this.dialog.querySelectorAll("[data-viewer-part]").forEach((button) => {
      button.onclick = () => {
        this.part = button.dataset.viewerPart;
        this.render(true);
      };
    });
    document.getElementById("viewerUrl").oninput = event => {
      this.urlDraft = event.target.value;
      const query = parseQueryParameters(this.urlDraft);
      this.queryJson = query.json;
      document.getElementById("viewerQueryJson").textContent = query.json;
      document.getElementById("viewerQueryToggle").hidden = query.count === 0;
      document.getElementById("viewerQueryCopy").hidden = query.count === 0;
      document.getElementById("viewerQueryJson").hidden = query.count === 0 || !this.queryExpanded;
    };
    document.getElementById("viewerMode").onchange = () => this.render();
    document.getElementById("viewerCopy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(
          this.copyContent ?? JSON.stringify(this.parsed, null, 2),
        );
        toast("已复制当前内容");
      } catch {
        toast("复制失败，请手动选择内容复制");
      }
    };
    document.getElementById("viewerCopyHeaders").onclick = () =>
      copyMessageText(
        (this.flow?.[this.part]?.headers || [])
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n"),
      );
    document.getElementById("viewerCopyMessage").onclick = () => {
      const message = this.flow?.[this.part];
      if (!message) return;
      const firstLine =
        this.part === "response"
          ? `${message.http_version || "HTTP"} ${this.flow.code || ""}`
          : `${message.method || this.flow.method || ""} ${message.url || this.flow.url || ""} ${message.http_version || "HTTP"}`;
      copyMessageText(
        `${firstLine}\n${(message.headers || []).map(([key, value]) => `${key}: ${value}`).join("\n")}\n\n${message.body_text || ""}`,
      );
    };
    document.getElementById("viewerQueryToggle").onclick = () => {
      this.queryExpanded = !this.queryExpanded;
      document.getElementById("viewerQueryJson").hidden = !this.queryExpanded;
      document.getElementById("viewerQueryToggle").textContent = this.queryExpanded
        ? "收起 Query JSON"
        : "查看 Query JSON";
    };
    document.getElementById("viewerQueryCopy").onclick = () =>
      copyMessageText(this.queryJson);
    document.getElementById("viewerCollapse").onclick = () => {
      this.dialog
        .querySelectorAll(".json-tree details[open]")
        .forEach((node) => {
          node.open = false;
        });
    };
    this.dialog.addEventListener("close", () => {
      this.sequence++;
      this.webSocketViewer.reset();
      this.flow = null;
      this.urlDraft = null;
      document.getElementById("viewerUrl").value = "";
      document.getElementById("viewerUrl").disabled = true;
      this.parsed = null;
      this.copyContent = "";
      this.resetQuery();
      document.getElementById("viewerRaw").textContent = "";
      document.getElementById("viewerHeaders").replaceChildren();
      document.getElementById("viewerTree").replaceChildren();
    });
  }

  /** 加载或关闭时清理旧请求的 Query，避免失败后仍显示上一次的参数。 */
  resetQuery() {
    this.queryExpanded = false;
    this.queryJson = "{}";
    document.getElementById("viewerQueryJson").textContent = "";
    document.getElementById("viewerQueryJson").hidden = true;
    document.getElementById("viewerQueryToggle").hidden = true;
    document.getElementById("viewerQueryCopy").hidden = true;
  }

  /** 先展示加载状态；关闭弹窗后丢弃迟到响应，避免保留大正文。 */
  async open(session, id, part = "request") {
    const sequence = ++this.sequence;
    this.flow = null;
    this.urlDraft = null;
    this.session = session;
    this.id = id;
    this.part = part;
    this.resetQuery();
    document.getElementById("viewerReplay").disabled = true;
    document.getElementById("viewerEditReplay").disabled = true;
    renderMessageHeaders(document.getElementById("viewerHeaders"), null);
    document.getElementById("viewerHeadersTitle").textContent = "请求头";
    document.getElementById("viewerBodyTitle").textContent = "请求体";
    document.getElementById("viewerHeadersCount").textContent = "";
    document.getElementById("viewerCopyHeaders").disabled = true;
    document.getElementById("viewerCopyMessage").disabled = true;
    document.getElementById("viewerUrl").value = "";
    document.getElementById("viewerUrl").disabled = true;
    document.getElementById("viewerMethod").textContent = "—";
    document.getElementById("viewerRaw").textContent = "";
    document.getElementById("viewerTree").replaceChildren();
    document.getElementById("viewerNotice").textContent = "加载中…";
    document.getElementById("viewerCopy").disabled = true;
    this.webSocketViewer.reset();
    document.getElementById("viewerHttpMessage").hidden = false;
    document.getElementById("viewerMode").value = "raw";
    document.getElementById("viewerRaw").hidden = false;
    document.getElementById("viewerTree").hidden = true;
    document.getElementById("viewerCollapse").hidden = true;
    if (!this.dialog.open) this.dialog.showModal();
    try {
      const flow = await readRequests.json(
        `/api/sessions/${encodeURIComponent(session)}/flows/${encodeURIComponent(id)}?text_only=true`, "full-detail",
      );
      if (sequence !== this.sequence || !this.dialog.open) return;
      this.flow = flow;
      this.render(true);
    } catch (error) {
      if (sequence === this.sequence && this.dialog.open)
        document.getElementById("viewerNotice").textContent = error.message;
    }
  }

  /** 已打开的重放详情收到更新后读取完整正文，不重建弹窗或打断阅读。 */
  async refresh(session, id) {
    if (!this.dialog.open || session !== this.session || id !== this.id) return;
    const sequence = ++this.sequence;
    const flow = await readRequests.json(
      `/api/sessions/${encodeURIComponent(session)}/flows/${encodeURIComponent(id)}?text_only=true`, "full-detail",
    );
    if (sequence !== this.sequence || !this.dialog.open) return;
    const completed =
      this.flow?.status === "pending" && flow.status !== "pending";
    this.flow = flow;
    this.render(completed);
  }

  /** 每次切换报文重新判断 JSON；正文与头部始终以文本插入。 */
  render(resetMode = false) {
    if (!this.flow) return;
    const wsButton = this.dialog.querySelector('[data-viewer-part="websocket"]');
    wsButton.hidden = !this.flow.websocket;
    if (this.part === "websocket" && !this.flow.websocket) this.part = "response";
    const ws = this.part === "websocket";
    document.getElementById("viewerWebSocket").hidden = !ws;
    document.getElementById("viewerHttpMessage").hidden = ws;
    this.dialog.querySelectorAll("[data-viewer-part]").forEach(button => {
      const active = button.dataset.viewerPart === this.part;
      button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
    });
    const message = this.flow[this.part];
    const mode = document.getElementById("viewerMode");
    const raw = document.getElementById("viewerRaw");
    const tree = document.getElementById("viewerTree");
    const sse = this.part === "response" && isEventStream(message);
    const events = document.getElementById("viewerEvents");
    setBodyDownload(document.getElementById("viewerDownloadBody"), this.session, this.id, this.part, message);
    const decodedBody = decodeRequestBody(message);
    const replayable =
      !!this.flow.request &&
      this.flow.method !== "CONNECT" &&
      !this.flow.websocket &&
      !this.flow.request.truncated &&
      this.flow.status !== "pending";
    document.getElementById("viewerReplay").disabled = !replayable;
    document.getElementById("viewerEditReplay").disabled = !replayable;
    const response = this.part === "response";
    document.getElementById("viewerHeadersTitle").textContent = response
      ? "响应头"
      : "请求头";
    document.getElementById("viewerBodyTitle").textContent = response
      ? "响应体"
      : "请求体";
    document.getElementById("viewerHeadersCount").textContent =
      `${message?.headers?.length || 0} 项`;
    document.getElementById("viewerCopyHeaders").disabled = !message;
    document.getElementById("viewerCopyMessage").disabled = ws || !message;
    renderMessageHeaders(document.getElementById("viewerHeaders"), message);
    this.dialog.querySelectorAll("[data-viewer-part]").forEach((button) => {
      const active = button.dataset.viewerPart === this.part;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (this.urlDraft === null) this.urlDraft = this.flow.request?.url || this.flow.url || "";
    document.getElementById("viewerUrl").value = this.urlDraft;
    document.getElementById("viewerUrl").disabled = !this.flow.request;
    document.getElementById("viewerMethod").textContent = this.flow.request?.method || this.flow.method || "—";
    const query = parseQueryParameters(this.urlDraft);
    this.queryJson = query.json;
    document.getElementById("viewerQueryToggle").hidden = query.count === 0;
    document.getElementById("viewerQueryCopy").hidden = query.count === 0;
    document.getElementById("viewerQueryJson").hidden = query.count === 0 || !this.queryExpanded;
    document.getElementById("viewerQueryJson").textContent = this.queryJson;
    document.getElementById("viewerQueryToggle").textContent = this.queryExpanded
      ? "收起 Query JSON"
      : "查看 Query JSON";
    if (ws) {
      this.webSocketViewer.show(this.session, this.id);
      return;
    }
    let validJson = false;
    this.parsed = null;
    if (
      message &&
      !message.truncated &&
      !message.display_truncated &&
      !message.decode_error
    ) {
      this.parsed = decodedBody.parsed;
      validJson = decodedBody.validJson;
    }
    for (const option of mode.options) {
      option.disabled =
        (option.value === "formatted" || option.value === "tree") &&
        !validJson;
      if (option.value === "decoded") option.disabled = !decodedBody.changed;
      if (option.value === "events") option.disabled = !sse;
    }
    if (resetMode)
      mode.value =
        sse ? "events" : validJson && (decodedBody.changed || this.part === "response")
          ? "tree"
          : "raw";
    if (mode.value === "events" && !sse) mode.value = "raw";
    if (!validJson && !["decoded", "events"].includes(mode.value)) mode.value = "raw";
    const notice = [];
    if (!message)
      notice.push(
        this.flow.status === "pending"
          ? "正在重放，等待响应…"
          : this.flow.reason ||
              "这条记录没有该报文，TLS 透传无法查看 HTTP 内容。",
      );
    const captureNotice = bodyCaptureNotice(message);
    if (captureNotice) notice.push(captureNotice);
    if (message?.truncated && !message.body_state)
      notice.push("采集时正文已截断或未采集，以下是已保存内容。");
    if (message?.display_truncated)
      notice.push(
        "解压后的文本超过 16 MiB 展示上限，已保存原始字节可通过下载获取。",
      );
    if (message?.decode_error)
      notice.push("正文解码失败，以下展示原始字节的文本视图。");
    if (decodedBody.changed && !message?.truncated && !message?.display_truncated)
      notice.push("检测到 URL 编码，已解码并尝试解析其中的 JSON；原始正文可切换查看。");
    const jsonHeader = message?.headers?.some(
      ([key, value]) =>
        key.toLowerCase() === "content-type" && /json/i.test(value),
    );
    if (
      jsonHeader &&
      !validJson &&
      !message.truncated &&
      !message.display_truncated
    )
      notice.push("正文不是有效 JSON，无法解析为树。");
    document.getElementById("viewerNotice").textContent = notice.join(" ");
    document.getElementById("viewerCopy").disabled = !message;
    document.getElementById("viewerCollapse").hidden = mode.value !== "tree";
    events.hidden = mode.value !== "events";
    events.replaceChildren();
    raw.hidden = ["tree", "events"].includes(mode.value);
    tree.hidden = mode.value !== "tree";
    tree.replaceChildren();
    if (mode.value === "events") {
      this.copyContent = message?.body_text || "";
      renderSseEvents(events, this.copyContent);
      raw.textContent = "";
    } else if (mode.value === "raw") {
      this.copyContent = message?.body_text || "";
      raw.textContent =
        this.copyContent || (message ? "（空正文）" : "暂无正文内容");
    } else if (mode.value === "decoded") {
      this.copyContent = decodedBody.readable;
      raw.textContent = this.copyContent || "（空正文）";
    } else {
      // 树视图不提前格式化整段正文，复制或切换文本时才生成大字符串。
      this.copyContent =
        mode.value === "formatted"
          ? JSON.stringify(this.parsed, null, 2)
          : null;
      raw.textContent = this.copyContent || "";
      if (mode.value === "tree") {
        const root = this.createNode("$", this.parsed);
        tree.append(root);
        if (root.tagName === "DETAILS") root.open = true;
      }
    }
  }

  /** 大数组每批展示 200 项，展开对象时才生成子树，避免一次创建大量 DOM。 */
  createNode(key, value) {
    const container = value !== null && typeof value === "object";
    const node = document.createElement(container ? "details" : "div");
    node.className = "json-node";
    const line = document.createElement(container ? "summary" : "div");
    const name = document.createElement("span");
    name.className = "json-key";
    name.textContent = `${key}: `;
    line.append(name);
    if (!container) {
      const text = document.createElement("span");
      text.className = `json-value json-${value === null ? "null" : typeof value}`;
      text.textContent = JSON.stringify(value);
      line.append(text);
      node.append(line);
      return node;
    }
    const keys = Object.keys(value);
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = Array.isArray(value)
      ? `Array [${keys.length}]`
      : `Object {${keys.length}}`;
    line.append(label);
    node.append(line);
    let loaded = false;
    node.addEventListener("toggle", () => {
      if (!node.open || loaded) return;
      loaded = true;
      const children = document.createElement("div");
      children.className = "json-children";
      let offset = 0;
      const more = document.createElement("button");
      more.type = "button";
      const appendBatch = () => {
        more.remove();
        const fragment = document.createDocumentFragment();
        const end = Math.min(offset + 200, keys.length);
        for (; offset < end; offset++)
          fragment.append(this.createNode(keys[offset], value[keys[offset]]));
        children.append(fragment);
        if (offset < keys.length) {
          more.textContent = `继续显示（剩余 ${keys.length - offset} 项）`;
          children.append(more);
        }
      };
      more.onclick = appendBatch;
      node.append(children);
      appendBatch();
    });
    return node;
  }
}
const requestViewer = new RequestViewer();
