/** 正文保存状态和展示截断分开说明，不能把未缓存说成空正文。 */
function bodyCaptureNotice(message) {
  if (!message) return '';
  const labels = {receiving:'正文仍在接收，已保存内容持续更新。', not_cached:'正文采用流式转发，未缓存原文。', truncated:'正文超过保存上限，只有已保存部分。', write_error:'正文保存失败或队列积压，内容不完整。', interrupted:'记录或网络已中断，正文可能不完整。'};
  return (labels[message.body_state] || '') + (message.capture_error ? ` ${message.capture_error}` : '') + (message.raw_truncated ? ' 原始正文超过接口读取上限，请下载已保存原文。' : '');
}
function isEventStream(message) {
  return (message?.headers || []).some(([key, value]) => key.toLowerCase() === 'content-type' && /text\/event-stream/i.test(value));
}
/** 按 SSE 空行边界解析完整事件；保留多行 data，忽略心跳与尚未收完的尾部。 */
function parseSseEvents(text, limit=500) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  // split 的末尾空字符串不是额外的空行；没有行结束符的尾部也不能分派。
  lines.pop();
  const events = [];
  let data = [], type = 'message', id = '', lastId = '';
  for (const line of lines) {
    if (line === '') {
      if (data.length && events.length < limit) events.push({event:type || 'message', id:id || lastId, data:data.join('\n')});
      data = []; type = 'message'; id = lastId;
      if (events.length >= limit) break;
    } else if (!line.startsWith(':')) {
      const at=line.indexOf(':');
      const key=at<0 ? line : line.slice(0,at);
      let value=at<0 ? '' : line.slice(at+1);
      if (value.startsWith(' ')) value=value.slice(1);
      if (key === 'data') data.push(value);
      else if (key === 'event') type=value;
      else if (key === 'id' && !value.includes('\0')) { id=value; lastId=value; }
    }
  }
  return events;
}
function renderSseEvents(target, text) {
  target.replaceChildren();
  const events = parseSseEvents(text);
  const info=document.createElement('p'); info.className='muted';
  info.textContent=events.length ? `${events.length} 个已接收事件（最多预览前 500 个）` : '等待完整 SSE 事件；心跳及未完成片段不显示。';
  target.append(info);
  events.forEach((event,index) => {
    const section=document.createElement('section');
    const heading=document.createElement('strong'); heading.textContent=`${index+1} · ${event.event}${event.id ? ' · ID '+event.id : ''}`;
    const body=document.createElement('pre'); body.textContent=event.data;
    section.append(heading,body); target.append(section);
  });
}
function setBodyDownload(link, session, flow, part, message) {
  const available = !!message?.body_file && ['request','response','original_request'].includes(part);
  link.hidden = !available;
  if (available) { link.href=`/api/sessions/${encodeURIComponent(session)}/flows/${encodeURIComponent(flow)}/body/${part}`; link.setAttribute('download', `${part}-body.bin`); }
  else link.removeAttribute('href');
}
