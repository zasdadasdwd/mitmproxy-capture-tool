/** 合并相同只读查询，并限制包括正文读取在内的等待时间；写操作不自动取消。 */
class ReadRequests {
  constructor(timeout = 20000) {
    this.timeout = timeout;
    this.pending = new Map();
    this.channels = new Map();
  }

  /** 共用正在读取的结果，不缓存旧数据；失败后允许立即重试。 */
  json(path, channel = null) {
    const previous = this.pending.get(path);
    if (previous && !previous.controller.signal.aborted) return previous.task;
    // 不同筛选/详情取代旧读取，快速切换时不会积累一串无用请求。
    if (channel && this.channels.has(channel)) {
      const old = this.channels.get(channel);
      old.cancelled = true;
      old.controller.abort();
    }
    const controller = new AbortController();
    const record = { controller, cancelled: false, task: null };
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const task = (async () => {
      try {
        const response = await fetch(path, { signal: controller.signal });
        if (!response.ok) {
          const text = await response.text();
          let message = text;
          try {
            const detail = JSON.parse(text).detail;
            message = typeof detail === "string" ? detail : JSON.stringify(detail);
          } catch {}
          throw new Error(message || `读取失败（${response.status}）`);
        }
        return await response.json();
      } catch (error) {
        if (record.cancelled) {
          const cancelled = new Error("已切换查询，取消旧读取");
          cancelled.name = "AbortError";
          throw cancelled;
        }
        if (controller.signal.aborted)
          throw new Error("读取超时，请缩小筛选范围或稍后重试");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    record.task = task;
    this.pending.set(path, record);
    if (channel) this.channels.set(channel, record);
    // 只清理自己的记录，旧读取不能删除快速切回后创建的新请求。
    const cleanup = () => {
      if (this.pending.get(path) === record) this.pending.delete(path);
      if (channel && this.channels.get(channel) === record) this.channels.delete(channel);
    };
    task.then(cleanup, cleanup);
    return task;
  }
}
const readRequests = new ReadRequests();
