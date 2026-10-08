/** WebSocket 重组消息分页查看；异步结果不能覆盖已切换的请求。 */
class WebSocketViewer {
  constructor(target) {
    this.target = target;
    this.key = null;
    this.page = 1;
    this.sequence = 0;
  }
  reset() {
    this.sequence++; this.key = null; this.target.hidden = true; this.target.replaceChildren();
  }
  async show(session, id) {
    const key = session + ':' + id;
    if (key !== this.key) { this.key = key; this.page = 1; this.target.replaceChildren(); }
    this.session = session; this.id = id;
    const sequence = ++this.sequence;
    try {
      const response = await fetch('/api/sessions/' + encodeURIComponent(session) + '/flows/' + encodeURIComponent(id) + '/websocket?page=' + this.page);
      if (!response.ok) throw new Error('无法读取 WebSocket 消息（' + response.status + '）');
      const result = await response.json();
      if (sequence !== this.sequence || this.target.hidden) return;
      if (this.page > 1 && !result.items.length && result.total) {
        this.page = Math.ceil(result.total / 100);
        return this.show(session, id);
      }
      this.render(result);
    } catch (error) {
      if (sequence === this.sequence && !this.target.hidden) this.target.textContent = error.message;
    }
  }
  render(result) {
    this.target.replaceChildren();
    const summary = result.summary;
    const info = document.createElement('p');
    info.className = 'muted';
    if (!summary) { info.textContent = '此记录没有 WebSocket 消息；旧会话无法补回。'; this.target.append(info); return; }
    const states = {open:'连接中', closed:'已关闭', interrupted:'记录或连接已中断'};
    info.textContent = (states[summary.state] || summary.state) + ' · 收到 ' + summary.total + ' 条 · 保存 ' + result.total + ' 条' +
      (summary.missing ? ' · ' + summary.missing + ' 条未保存（上限或采集队列丢弃）' : '') +
      (summary.close_code != null ? ' · 关闭码 ' + summary.close_code : '') +
      (summary.close_reason ? ' · ' + summary.close_reason : '');
    this.target.append(info);
    const toolbar = document.createElement('div'); toolbar.className = 'websocket-pagination';
    const previous = document.createElement('button'); previous.type='button'; previous.textContent='上一页'; previous.disabled=this.page<=1;
    const next = document.createElement('button'); next.type='button'; next.textContent='下一页'; next.disabled=this.page*100>=result.total;
    const label = document.createElement('span'); label.textContent='第 ' + this.page + ' 页';
    previous.onclick = () => { this.page--; this.show(this.session,this.id); };
    next.onclick = () => { this.page++; this.show(this.session,this.id); };
    toolbar.append(previous,label,next); this.target.append(toolbar);
    for (const message of result.items) {
      const section = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = '#' + message.number + ' · ' + (message.from_client ? '客户端 → 服务端' : '服务端 → 客户端') +
        ' · ' + new Date(message.timestamp*1000).toLocaleTimeString() + ' · ' + message.type + ' · ' + message.size + ' B' +
        (message.truncated ? ' · 正文截断' : '') + (message.dropped ? ' · 未转发' : '') + (message.injected ? ' · 注入消息' : '');
      const body = document.createElement('pre');
      let loaded = false;
      const load = () => {
        if (loaded) return;
        loaded = true;
        const bytes = Uint8Array.from(atob(message.body_b64 || ''), c => c.charCodeAt(0));
        body.textContent = message.type === 'text' ? new TextDecoder().decode(bytes) : [...bytes].map(b=>b.toString(16).padStart(2,'0')).join(' ');
      };
      section.ontoggle = () => { if (section.open) load(); };
      const copy = document.createElement('button'); copy.type='button'; copy.textContent=message.type === 'text' ? '复制文本' : '复制十六进制';
      copy.onclick=()=>{ load(); copyMessageText(body.textContent); };
      section.append(heading,copy,body); this.target.append(section);
    }
  }
}
