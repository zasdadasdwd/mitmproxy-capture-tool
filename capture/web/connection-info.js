/** 连接摘要只展示观测结果；历史缺失信息显示未知，不从 URL 猜测协议。 */
function renderConnectionInfo(container, flow) {
  container.replaceChildren();
  const summary = document.createElement('p');
  summary.className = 'muted';
  summary.textContent = flow?.source === 'replay'
    ? '重放由 httpx 发起，没有手机／浏览器入站连接。实际协议以重放记录为准，未保留原客户端指纹。'
    : '客户端与上游分别协商，可能使用不同协议。相同连接 ID 可用于关联同一连接上的请求。';
  container.append(summary);
  const rows = [
    ['HTTP 协议', 'http_version'], ['已协商 ALPN', 'alpn'], ['TLS 状态', 'tls_established'], ['TLS 版本', 'tls_version'],
    ['密码套件', 'cipher'], ['SNI', 'sni'], ['连接 ID', 'id'], ['对端地址', 'peer'],
    ['TCP 建连耗时', 'tcp_connect_ms'], ['TLS 握手耗时', 'tls_handshake_ms'], ['连接错误', 'error'],
  ];
  for (const [part, title] of [['client', '客户端 → 代理'], ['upstream', '代理 → 目标服务器']]) {
    const section = document.createElement('section');
    const heading = document.createElement('h3'); heading.textContent = title; section.append(heading);
    const data = flow?.transport?.[part] || {};
    const list = document.createElement('dl');
    for (const [label, key] of rows) {
      const term = document.createElement('dt'); term.textContent = label;
      const value = document.createElement('dd');
      const observed = data[key];
      value.textContent = observed == null || observed === '' ? '未知'
        : key === 'tls_established' ? (observed ? '已建立' : data.tls ? '握手未完成' : '未启用')
        : key.endsWith('_ms') ? `${observed} ms`
        : Array.isArray(observed) ? observed.join(':') : String(observed);
      list.append(term, value);
    }
    section.append(list); container.append(section);
  }
  if (flow?.source === 'replay') {
    const replay = document.createElement('p');
    replay.textContent = `原协议：${flow.replay_transport?.original_http_version || '未知'} · 重放协议：${flow.replay_transport?.actual_http_version || flow.request?.http_version || '未知'}`;
    container.append(replay);
  }
  const raw = document.createElement('details');
  const title = document.createElement('summary'); title.textContent = '其他记录信息';
  const pre = document.createElement('pre');
  const info = Object.fromEntries(Object.entries(flow || {}).filter(([key]) => !['request', 'original_request', 'response'].includes(key)));
  pre.textContent = JSON.stringify(info, null, 2);
  raw.append(title, pre); container.append(raw);
}
