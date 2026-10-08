"""有界异步正文落盘；流式回调只排队，磁盘慢或保存失败不阻塞网络转发。"""

import asyncio
from pathlib import Path
from uuid import uuid4


class StreamBody:
    """保存一个流的原始字节与真实收取数量，超限后继续转发但停止缓存。"""

    def __init__(self, writer, session, limit, enabled):
        self.writer = writer
        self.session = session
        self.limit = limit
        self.enabled = enabled
        self.filename = uuid4().hex + ".bin"
        self.path = writer.root / session / "bodies" / self.filename
        self.received = 0
        self.enqueued = 0
        self.saved = 0
        self.finished = False
        self.closed = False
        self.error = None
        self.write_failed = False
        self.interrupted = False

    def feed(self, chunk):
        """必须原样返回网络字节；缓存上限和写入积压只影响保存。"""
        if not chunk:
            self.finish()
            return chunk
        self.received += len(chunk)
        if not self.closed and self.enabled and not self.error:
            content = chunk[: max(0, self.limit - self.enqueued)]
            if content:
                if self.writer.pending_bytes + len(content) > self.writer.buffer_limit:
                    self.error = "磁盘缓存队列已满，正文保存不完整"
                else:
                    self.writer.pending_bytes += len(content)
                    self.enqueued += len(content)
                    self.writer.queue.put_nowait((self, content))
        return chunk

    def finish(self):
        """结束保存，尾标记排在本流的全部正文之后。"""
        if not self.closed:
            self.closed = True
            self.writer.queue.put_nowait((self, None))

    def snapshot(self):
        """保存状态与空正文区分，未结束的流永远不能视作可完整重放。"""
        state = (
            "not_cached"
            if not self.enabled
            else "interrupted"
            if self.interrupted
            else "write_error"
            if self.error
            else "receiving"
            if not self.finished
            else "truncated"
            if self.saved < self.received
            else "complete"
        )
        result = {
            "body_size": self.received,
            "saved_bytes": self.saved,
            "body_state": state,
            "streaming": True,
            "truncated": state != "complete",
            "capture_error": self.error,
        }
        if self.saved:
            result["body_file"] = self.filename
        else:
            result["body_b64"] = ""
        return result


class StreamWriter:
    """共享一个有界写队列，最多跟踪 128 个并行正文，避免每连接开线程。"""

    def __init__(self, root: Path, buffer_limit=8 * 1024 * 1024):
        self.root = root
        self.buffer_limit = buffer_limit
        self.pending_bytes = 0
        self.queue = asyncio.Queue()
        self.bodies = set()
        self.task = asyncio.create_task(self.run())

    def create(self, session, limit, enabled):
        if len(self.bodies) >= 128:
            return None
        body = StreamBody(self, session, limit, enabled)
        self.bodies.add(body)
        return body

    @staticmethod
    def append(body, content):
        """在工作线程追加原始字节；目录须由 Store 建立，不重建已删除会话。"""
        with body.path.open("ab") as target:
            target.write(content)

    async def run(self):
        """按队列顺序落盘，捕获磁盘错误并继续服务其他流。"""
        while True:
            body, content = await self.queue.get()
            try:
                if content is None:
                    body.finished = True
                    self.bodies.discard(body)
                else:
                    self.pending_bytes -= len(content)
                    if not body.write_failed:
                        try:
                            await asyncio.to_thread(self.append, body, content)
                            body.saved += len(content)
                        except OSError:
                            body.write_failed = True
                            body.error = "正文无法写入磁盘，请检查空间与权限"
            finally:
                self.queue.task_done()

    async def stop_session(self, session=None):
        """停止记录时只结束保存，不能关闭客户端的 SSE 或大文件连接。"""
        for body in list(self.bodies):
            if session is None or body.session == session:
                if not body.closed:
                    body.interrupted = True
                body.finish()
        try:
            await asyncio.wait_for(self.queue.join(), 5)
        except TimeoutError:
            # 只终止缓存；磁盘卡住不能无限拖延停止记录确认。
            for body in list(self.bodies):
                if session is None or body.session == session:
                    body.error = "磁盘写入超时，正文保存不完整"
                    body.write_failed = True

    async def shutdown(self):
        """进程退出前等待有限队列完成，释放写入任务。"""
        await self.stop_session()
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
