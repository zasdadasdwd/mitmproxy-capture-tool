/** 重放参数编辑：原文为唯一来源，只有用户修改的行才重新编码。 */
class ReplayFields {
  static pairs(raw) {
    if (!raw) return [];
    return raw.split('&').map(segment => {
      const at = segment.indexOf('=');
      const decode = value => decodeURIComponent(value.replace(/\+/g, ' '));
      const key = decode(at < 0 ? segment : segment.slice(0, at));
      const value = decode(at < 0 ? '' : segment.slice(at + 1));
      return {key, value, originalKey: key, originalValue: value, raw: segment};
    });
  }
  static encodePairs(rows) {
    return rows.map(row => row.raw !== undefined && row.key === row.originalKey && row.value === row.originalValue
      ? row.raw : `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`).join('&');
  }
  /** 按顶层边界拆 JSON，保留重复键、数字精度、字段顺序及各行原文。 */
  static jsonRows(raw) {
    JSON.parse(raw);
    const text = raw.trim();
    if (!text.startsWith('{')) throw new Error('JSON 表格目前支持对象；数组及其他正文请使用原文编辑。');
    const inner = text.slice(1, -1);
    if (!inner.trim()) return [];
    let quoted = false, escape = false, depth = 0, start = 0;
    const parts = [];
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (quoted) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    parts.push(inner.slice(start));
    return parts.map(part => {
      const match = part.match(/^\s*("(?:[^"\\]|\\.)*")\s*:/);
      if (!match) throw new Error('JSON 字段无法解析，请使用原文编辑。');
      const key = JSON.parse(match[1]);
      const value = part.slice(match[0].length).trim();
      return {key, value, originalKey: key, originalValue: value, raw: part};
    });
  }
  static encodeJson(rows) {
    return '{' + rows.map(row => {
      JSON.parse(row.value);
      return row.raw !== undefined && row.key === row.originalKey && row.value === row.originalValue
        ? row.raw : `${JSON.stringify(row.key)}:${row.value}`;
    }).join(',') + '}';
  }
}

class ReplayEditor {
  /** 表格和原文切换时同步草稿，不回读原请求覆盖修改。 */
  constructor() {
    this.get = id => document.getElementById(id);
    this.mode = 'raw';
    this.part = 'headers';
    this.get('editViewMode').onchange = () => this.switchMode();
    this.get('editTablePart').onchange = () => {
      const previous = this.part;
      try { this.commit(); }
      catch (error) { this.get('editTablePart').value = previous; this.notice(error.message); return; }
      const rows = this.rows, kind = this.kind;
      try { this.part = this.get('editTablePart').value; this.loadTable(); this.notice(); }
      catch (error) {
        this.part = previous; this.rows = rows; this.kind = kind;
        this.get('editTablePart').value = previous;
        this.render(); this.showMode(); this.notice(error.message);
      }
    };
    this.partButtons = [['editPartHeaders', 'headers'], ['editPartQuery', 'query'], ['editPartBody', 'body']];
    for (const [id, part] of this.partButtons) {
      this.get(id).onclick = () => {
        if (part === this.part) return;
        this.get('editTablePart').value = part;
        this.get('editTablePart').onchange();
        this.showMode();
      };
    }
    this.get('editAddRow').onclick = () => { this.rows.push({key: '', value: this.kind === 'json' ? 'null' : ''}); this.dirty = true; this.render(); };
    this.get('editBodyFormat').onchange = () => {
      try {
        const next = this.get('editBodyFormat').value;
        const raw = this.get('editBody').value;
        this.get('editBody').value = next === 'text' ? this.decode(raw) : this.encode(raw);
        this.bodyFormat = next;
      } catch (error) { this.get('editBodyFormat').value = this.bodyFormat; this.notice(error.message); }
    };
  }
  encode(text) { return btoa(Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join('')); }
  decode(raw) { return new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))); }
  notice(text = '') { this.get('editTableNotice').textContent = text; }
  /** 装载来源快照；每次打开独立草稿，默认原文模式。 */
  open(request) {
    this.original = request;
    this.mode = 'raw'; this.part = 'headers'; this.bodyFormat = 'base64';
    this.get('editHeaders').value = JSON.stringify(request.headers, null, 2);
    this.get('editBody').value = request.body_b64 || '';
    this.get('editBodyFormat').value = 'base64';
    this.get('editViewMode').value = 'raw'; this.get('editTablePart').value = 'headers';
    this.showMode(); this.notice();
  }
  showMode() {
    for (const [id, part] of this.partButtons) {
      this.get(id).className = part === this.part ? 'active' : '';
      this.get(id).setAttribute('aria-pressed', String(part === this.part));
    }
    this.get('editRawFields').hidden = this.mode !== 'raw';
    this.get('editTableFields').hidden = this.mode !== 'table';
    // 表格的 Query 必须提交后才能修改 URL，避免互相覆盖。
    this.get('editUrl').readOnly = this.mode === 'table' && this.part === 'query';
  }
  switchMode() {
    const next = this.get('editViewMode').value;
    try {
      if (this.mode === 'table') this.commit();
      if (next === 'table') this.loadTable();
      this.mode = next; this.showMode(); this.notice();
    } catch (error) { this.get('editViewMode').value = this.mode; this.notice(error.message); }
  }
  /** 从当前草稿解析参数，正文不适合表格时明确拒绝转换。 */
  loadTable() {
    this.dirty = false; this.kind = this.part;
    if (this.part === 'headers') {
      const headers = JSON.parse(this.get('editHeaders').value);
      if (!Array.isArray(headers) || headers.some(row => !Array.isArray(row) || row.length !== 2 || row.some(value => typeof value !== 'string'))) throw new Error('Headers 必须是字符串键值对列表。');
      this.rows = headers.map(([key, value]) => ({key, value}));
    } else if (this.part === 'query') {
      const url = this.get('editUrl').value;
      const hash = url.indexOf('#');
      this.suffix = hash < 0 ? '' : url.slice(hash);
      const address = hash < 0 ? url : url.slice(0, hash);
      const at = address.indexOf('?');
      this.base = at < 0 ? address : address.slice(0, at);
      this.rows = ReplayFields.pairs(at < 0 ? '' : address.slice(at + 1));
    } else {
      const headers = JSON.parse(this.get('editHeaders').value);
      if (headers.some(([key, value]) => key.toLowerCase() === 'content-encoding' && value && value.toLowerCase() !== 'identity')) throw new Error('压缩正文请使用原文 Base64 编辑，以免破坏编码。');
      const text = this.bodyFormat === 'base64' ? this.decode(this.get('editBody').value) : this.get('editBody').value;
      const contentType = headers.find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
      if (text.trim().startsWith('{')) { this.kind = 'json'; this.rows = ReplayFields.jsonRows(text); }
      else if (contentType.includes('application/x-www-form-urlencoded')) { this.kind = 'form'; this.rows = ReplayFields.pairs(text); }
      else throw new Error('此正文不适合键值表格，请使用原文编辑。');
    }
    this.render(); this.showMode();
  }
  /** 把有修改的表格写回草稿，未修改部分沿用原始编码片段。 */
  commit() {
    if (!this.dirty) return; // 未修改时绝不重新序列化。
    if (this.part === 'headers') this.get('editHeaders').value = JSON.stringify(this.rows.map(({key, value}) => [key, value]), null, 2);
    else if (this.part === 'query') {
      const query = ReplayFields.encodePairs(this.rows);
      this.get('editUrl').value = this.base + (query ? '?' + query : '') + this.suffix;
    } else {
      const text = this.kind === 'json' ? ReplayFields.encodeJson(this.rows) : ReplayFields.encodePairs(this.rows);
      this.get('editBody').value = this.bodyFormat === 'base64' ? this.encode(text) : text;
    }
    this.dirty = false;
  }
  render() {
    const body = this.get('editParameterRows'); body.replaceChildren();
    this.rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      for (const property of ['key', 'value']) {
        const td = document.createElement('td');
        const input = document.createElement(property === 'value' ? 'textarea' : 'input');
        input.value = row[property]; input.setAttribute('aria-label', `${index + 1} 行${property === 'key' ? '名称' : '值'}`);
        if (property === 'value') { input.rows = 1; input.wrap = 'off'; }
        input.oninput = () => { row[property] = input.value; this.dirty = true; };
        td.append(input);
        if (property === 'value') {
          td.className = 'replay-value-cell';
          const expand = document.createElement('button');
          expand.type = 'button'; expand.textContent = '⤢'; expand.className = 'replay-expand-value';
          expand.title = '展开长值'; expand.setAttribute('aria-label', `展开第 ${index + 1} 行值`);
          expand.setAttribute('aria-expanded', 'false');
          expand.onclick = () => {
            const opened = input.className !== 'expanded';
            input.className = opened ? 'expanded' : ''; input.wrap = opened ? 'soft' : 'off';
            expand.setAttribute('aria-expanded', String(opened));
            expand.title = opened ? '收起长值' : '展开长值';
          };
          td.append(expand);
        }
        tr.append(td);
      }
      const actions = document.createElement('td');
      for (const [label, delta] of [['↑', -1], ['↓', 1], ['删除', 0]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.disabled = delta !== 0 && (index + delta < 0 || index + delta >= this.rows.length);
        button.onclick = () => {
          if (delta) [this.rows[index], this.rows[index + delta]] = [this.rows[index + delta], this.rows[index]];
          else this.rows.splice(index, 1);
          this.dirty = true; this.render();
        };
        actions.append(button);
      }
      tr.append(actions); body.append(tr);
    });
    this.get('editValueLabel').textContent = this.kind === 'json' ? '值（JSON 原文，可嵌套对象）' : '值';
  }
  /** 校验并构造重放参数，保持原始记录不变。 */
  build() {
    if (this.mode === 'table') this.commit();
    let headers = JSON.parse(this.get('editHeaders').value);
    if (!Array.isArray(headers) || headers.some(row => !Array.isArray(row) || row.length !== 2 || row.some(value => typeof value !== 'string'))) throw new Error('Headers 必须是字符串键值对列表。');
    const body = this.get('editBody').value;
    const bodyB64 = this.bodyFormat === 'text' ? this.encode(body) : body;
    atob(bodyB64); // 提交前校验 Base64。
    // 仅在修改正文文本后移除旧的压缩声明；切换视图不会改变请求。
    if (this.bodyFormat === 'text' && bodyB64 !== (this.original.body_b64 || '')) headers = headers.filter(([key]) => !['content-encoding', 'content-length'].includes(key.toLowerCase()));
    return {url: this.get('editUrl').value, method: this.get('editMethod').value, headers, body_b64: bodyB64};
  }
}
