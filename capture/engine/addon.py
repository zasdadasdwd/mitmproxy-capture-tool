"""mitmdump 入口：策略在引擎执行，数据库与界面不在转发钩子里运行。"""

import asyncio
import base64
import json
import logging
import os
import socket
import sys
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mitmproxy import ctx, http, tls

from capture.engine.hooks import HookRunner
from capture.engine.policy import is_blocked, should_decrypt
from capture.engine.streaming import StreamWriter
from capture.engine.transport import connection_snapshot
from capture.engine.websocket_capture import accepted_websocket_event, websocket_event
from capture.plugins.base import discover_hooks
from config import DATA, load_startup

logger = logging.getLogger("capture.addon")


def snapshot(message, limit: int) -> dict:
    """保存原始正文和重复 Header；超出限制时明确标记，禁止不完整重放。"""
    raw = message.raw_content
    body = raw or b""
    return {
        "headers": list(message.headers.items(multi=True)),
        "body_b64": base64.b64encode(body[:limit]).decode(),
        "body_size": len(body),
        "truncated": len(body) > limit or raw is None,
        "body_state": "not_cached"
        if raw is None
        else "truncated"
        if len(body) > limit
        else "complete",
        "http_version": message.http_version,
    }


class CaptureAddon:
    """在 mitmproxy 事件中执行策略和 hook，将采集事件放入有界队列。"""

    def __init__(self):
        """加载配置，通信密钥与会话由管理进程通过环境变量传入。"""
        self.settings_path = Path(os.environ["CAPTURE_SETTINGS"])
        self.settings = json.loads(self.settings_path.read_text())
        modules = os.environ.get("CAPTURE_HOOK_MODULES")
        if modules is None:
            modules = load_startup().extensions.hook_modules
        else:
            modules = json.loads(modules)
        self.hook_snapshot = discover_hooks(modules)
        self.queue = asyncio.Queue(maxsize=1024)
        self.queued_bytes = 0
        self.last_drop_log = 0
        self.dropped = 0
        self.tasks = []
        self.hooks = HookRunner(self.hook_snapshot)
        self.capture_session = os.environ.get("CAPTURE_SESSION") or None
        self.control_sequence = 0
        self.stream_writer = None
        self.stream_flows = {}
        self.stream_bodies = {}

    def running(self):
        """引擎就绪后启动发送与配置轮询，并通知管理进程。"""
        self.stream_writer = StreamWriter(
            Path(os.environ.get("CAPTURE_BODY_ROOT", DATA / "captures"))
        )
        self.tasks = [
            asyncio.create_task(self.send_events()),
            asyncio.create_task(self.watch_settings()),
            asyncio.create_task(self.watch_capture()),
            asyncio.create_task(self.watch_parent()),
            asyncio.create_task(self.watch_streams()),
        ]
        self.emit({"type": "ready", "version": self.settings["version"]})

    async def watch_parent(self):
        """管理进程被强制结束时主动退出，避免独立进程组继续占用代理端口。"""
        parent = os.environ.get("CAPTURE_PARENT_PID")
        if not parent:
            return  # 保持手动加载 addon 时的原有行为。
        parent_pid = int(parent)
        while True:
            await asyncio.sleep(1)
            if os.getppid() != parent_pid:
                logger.warning("管理进程已退出，关闭残留代理并释放监听端口")
                ctx.master.shutdown()
                return

    def emit(self, event):
        """只序列化一次；数量及字节双重限制兼顾突发小事件与正文内存。"""
        payload = (json.dumps(event, ensure_ascii=True) + "\n").encode()
        byte_limit = max(16 * 1024 * 1024, self.settings["body_limit"] * 4)
        if self.queue.full() or self.queued_bytes + len(payload) > byte_limit:
            self.dropped += 1
            if time.monotonic() - self.last_drop_log > 1:
                logger.error("采集缓冲已满，丢弃事件，累计 %s", self.dropped)
                self.last_drop_log = time.monotonic()
            return False
        self.queue.put_nowait(payload)
        self.queued_bytes += len(payload)
        return True

    async def send_events(self):
        """通过 Unix socket 发送 JSON 事件，等存储 ACK 后发送下一条。"""
        writer = None
        try:
            reader, writer = await asyncio.open_unix_connection(
                os.environ["CAPTURE_SOCKET"]
            )
            writer.write((os.environ["CAPTURE_TOKEN"] + "\n").encode())
            await writer.drain()
            reported_drops = 0
            while True:
                payload = await self.queue.get()
                self.queued_bytes -= len(payload)
                if self.dropped != reported_drops:
                    writer.write(
                        (
                            json.dumps(
                                {"type": "health", "dropped_events": self.dropped}
                            )
                            + "\n"
                        ).encode()
                    )
                    await writer.drain()
                    if not await reader.readline():
                        raise ConnectionError("管理服务连接已关闭")
                    reported_drops = self.dropped
                writer.write(payload)
                await writer.drain()
                if not await reader.readline():
                    raise ConnectionError("管理服务连接已关闭")
                self.queue.task_done()
        except Exception:
            logger.exception("采集通信中断，请停止并重新开始抓包")
        finally:
            if writer:
                writer.close()

    async def watch_settings(self):
        """每半秒检查策略版本，成功加载后通知界面已生效。"""
        while True:
            await asyncio.sleep(0.5)
            try:
                settings = json.loads(self.settings_path.read_text())
                if settings["version"] != self.settings["version"]:
                    ctx.options.update(stream_large_bodies=str(settings["body_limit"]))
                    self.settings = settings
                    self.emit({"type": "policy", "version": settings["version"]})
            except Exception:
                logger.exception("无法更新配置，继续使用上一个版本")

    async def watch_capture(self):
        """独立切换记录，确认事件与流量共用有序队列，保持代理连接不断开。"""
        path = os.environ.get("CAPTURE_CONTROL")
        if not path:
            return
        while True:
            await asyncio.sleep(0.1)
            try:
                control = json.loads(Path(path).read_text())
                if control["sequence"] == self.control_sequence:
                    continue
                if self.stream_writer and self.capture_session:
                    await self.stream_writer.stop_session(self.capture_session)
                    self.update_streams()
                self.control_sequence = control["sequence"]
                self.capture_session = control["session_id"]
                if self.capture_session:
                    self.hooks = HookRunner(self.hook_snapshot)  # 新抓包重建实例。
                payload = (
                    json.dumps({"type": "capture", "sequence": self.control_sequence})
                    + "\n"
                ).encode()
                await self.queue.put(payload)  # 控制确认不能因流量队列超载被丢弃。
                self.queued_bytes += len(payload)
            except (OSError, ValueError, KeyError):
                logger.exception("无法切换记录状态")

    async def done(self):
        """事件循环停止后，用短时同步连接尽量写完队列里的剩余事件。"""
        if self.stream_writer:
            await self.stream_writer.shutdown()
            self.update_streams()
        if self.queue.empty():
            return
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
                deadline = time.monotonic() + 3
                channel.settimeout(3)
                channel.connect(os.environ["CAPTURE_SOCKET"])
                channel.sendall((os.environ["CAPTURE_TOKEN"] + "\n").encode())
                with channel.makefile("rb") as reader:
                    while not self.queue.empty() and time.monotonic() < deadline:
                        payload = self.queue.get_nowait()
                        self.queued_bytes -= len(payload)
                        channel.settimeout(max(0.1, deadline - time.monotonic()))
                        channel.sendall(payload)
                        if not reader.readline():
                            break
        except (OSError, ValueError):
            # done 时日志系统已关闭，不能再依赖 logging。
            pass

    def connection_record(self, connection_id, host, status, reason=""):
        """透传、拒绝和 TLS 错误没有普通 HTTPFlow，单独记录连接摘要。"""
        if not self.capture_session:
            return
        self.emit(
            {
                "type": "flow",
                "session_id": self.capture_session,
                "flow": {
                    "id": "conn-" + connection_id,
                    "host": host,
                    "url": host,
                    "method": "CONNECT",
                    "status": status,
                    "reason": reason,
                    "started": time.time(),
                    "policy_version": self.settings["version"],
                },
            }
        )

    def http_connect(self, flow: http.HTTPFlow):
        """显式代理 CONNECT 阶段拒绝目标，避免先与目标建立连接。"""
        host = flow.request.host
        if is_blocked(host, self.settings):
            flow.response = http.Response.make(403, b"Domain blocked by capture policy")
            self.connection_record(
                flow.client_conn.id, host, "blocked", "命中域名拒绝列表"
            )

    def tls_clienthello(self, data: tls.ClientHelloData):
        """握手前按 SNI 或 CONNECT 地址决定拒绝、解密或加密透传。"""
        target = data.context.server.address
        host = data.client_hello.sni or (target[0] if target else "")
        if is_blocked(host, self.settings):
            data.context.client.error = "Domain blocked by capture policy"
            self.connection_record(
                data.context.client.id, host, "blocked", "命中域名拒绝列表"
            )
        elif not should_decrypt(host, self.settings):
            data.ignore_connection = True
            self.connection_record(
                data.context.client.id, host, "passthrough", "TLS 加密透传"
            )

    def tls_failed_client(self, data):
        """记录客户端 TLS 错误，常见原因是尚未信任本工具的 CA。"""
        host = data.conn.sni or "未知域名"
        self.connection_record(
            data.conn.id, host, "error", str(data.conn.error or "客户端 TLS 握手失败")
        )

    def tls_failed_server(self, data):
        """记录上游 TLS 验证或握手失败，供界面诊断。"""
        host = data.conn.sni or (
            data.conn.address[0] if data.conn.address else "未知域名"
        )
        self.connection_record(
            data.context.client.id,
            host,
            "error",
            str(data.conn.error or "上游 TLS 握手失败"),
        )

    def requestheaders(self, flow):
        """HTTP 头到达时尽早拒绝，避免等待完整上传正文。"""
        flow.metadata["capture_session"] = self.capture_session
        flow.metadata.setdefault("client_http_version", flow.request.http_version)
        length = flow.request.headers.get("content-length", "")
        if (
            flow.request.stream
            or "chunked" in flow.request.headers.get("transfer-encoding", "").lower()
            or (length.isdigit() and int(length) > self.settings["body_limit"])
        ):
            flow.request.stream = flow.request.stream or True
            self.attach_stream(flow, "request")
        if is_blocked(flow.request.host, self.settings):
            flow.metadata["blocked"] = True
            flow.response = http.Response.make(403, b"Domain blocked by capture policy")

    def request(self, flow: http.HTTPFlow):
        """保存原始快照，调用用户 hook，再采集实际待发送的请求。"""
        limit = self.settings["body_limit"]
        flow.metadata.setdefault("capture_session", self.capture_session)
        original = None
        if (
            flow.metadata["capture_session"]
            and flow.metadata["capture_session"] == self.capture_session
        ):
            original = snapshot(flow.request, limit)
            original.update(url=flow.request.url, method=flow.request.method)
        flow.metadata["policy_version"] = self.settings["version"]
        if flow.metadata.get("blocked") or is_blocked(flow.request.host, self.settings):
            flow.metadata["blocked"] = True
            flow.response = http.Response.make(403, b"Domain blocked by capture policy")
        elif self.settings["hook_enabled"]:
            try:
                allowed = self.hooks.run_request(
                    self.settings.get(
                        "request_hooks",
                        [{"name": "request_hook", "enabled": True}],
                    ),
                    flow,
                    self.hook_context(),
                    lambda: is_blocked(flow.request.host, self.settings),
                )
                if not allowed:
                    flow.metadata["blocked"] = True
                    flow.response = http.Response.make(
                        403, b"Hook target domain blocked"
                    )
            except Exception as exc:
                flow.metadata["hook_error"] = str(exc)
                flow.response = http.Response.make(
                    502, b"Request hook failed; request was not sent"
                )
                logger.exception("请求 hook 执行失败")
        self.publish(flow, "pending", original)

    def hook_context(self):
        """为两个 Hook 阶段提供相同的会话信息与时间工具。"""
        return SimpleNamespace(
            session_id=self.capture_session,
            config=dict(self.settings),
            logger=logging.getLogger("request_hook"),
            now_ms=lambda: int(time.time() * 1000),
        )

    def attach_stream(self, flow, part):
        """把流式原始字节交给共享队列，不修改网络内容及传输节奏。"""
        message = getattr(flow, part)
        if not self.stream_writer or not flow.metadata.get("capture_session"):
            return
        body = self.stream_writer.create(
            flow.metadata["capture_session"],
            self.settings.get("stream_body_limit", 64 * 1024 * 1024),
            self.settings.get("save_streamed_bodies", True),
        )
        if body is None:
            flow.metadata["stream_capture_error"] = "并行流式正文过多，未缓存该正文"
            return
        self.stream_bodies[(flow.id, part)] = body
        self.stream_flows[flow.id] = flow
        previous = message.stream if callable(message.stream) else None

        def stream(chunk):
            # 先观察收到的字节，不包办用户自定义流变换。
            body.feed(chunk)
            return previous(chunk) if previous else chunk

        message.stream = stream

    async def watch_streams(self):
        """每秒补充保存状态及 SSE 预览通知，不逐个网络分片写数据库。"""
        while True:
            await asyncio.sleep(1)
            self.update_streams()

    def update_streams(self):
        """只推送有变化的流；会话切换后释放引用，避免长连接累积。"""
        for flow_id, flow in list(self.stream_flows.items()):
            bodies = [
                self.stream_bodies.get((flow.id, part))
                for part in ("request", "response")
            ]
            bodies = [body for body in bodies if body]
            signature = tuple(
                (body.received, body.saved, body.finished, body.error)
                for body in bodies
            )
            if flow.metadata.get("stream_signature") != signature:
                flow.metadata["stream_signature"] = signature
                self.publish(flow, flow.metadata.get("capture_status", "receiving"))
            if (
                all(body.finished for body in bodies)
                and flow.metadata.get("capture_status")
                in ("complete", "error", "blocked")
            ) or flow.metadata.get("capture_session") != self.capture_session:
                self.stream_flows.pop(flow_id, None)
                for part in ("request", "response"):
                    self.stream_bodies.pop((flow_id, part), None)

    def responseheaders(self, flow):
        """大响应和 SSE 保持流式转发，由异步队列保存有限原始字节。"""
        length = flow.response.headers.get("content-length", "")
        content_type = flow.response.headers.get("content-type", "")
        if (
            flow.response.stream
            or (length.isdigit() and int(length) > self.settings["body_limit"])
            or "text/event-stream" in content_type.lower()
            or (
                not length
                and flow.request.method != "HEAD"
                and flow.response.status_code not in (204, 304)
                and flow.response.status_code >= 200
            )
        ):
            flow.response.stream = flow.response.stream or True
            self.attach_stream(flow, "response")
        self.publish(flow, "receiving", include_body=False)

    def response(self, flow):
        """响应完成后补全状态码、正文、大小和耗时。"""
        if (
            self.settings["hook_enabled"]
            and not flow.metadata.get("blocked")
            and not flow.metadata.get("hook_error")
        ):
            try:
                self.hooks.run_response(
                    self.settings.get(
                        "request_hooks", [{"name": "request_hook", "enabled": True}]
                    ),
                    flow,
                    self.hook_context(),
                )
            except Exception as exc:
                flow.metadata["hook_error"] = str(exc)
                flow.response = http.Response.make(502, b"Response hook failed")
                logger.exception("响应 hook 执行失败")
        status = (
            "blocked"
            if flow.metadata.get("blocked")
            else "error"
            if flow.metadata.get("hook_error")
            else "complete"
        )
        for part in ("request", "response"):
            body = self.stream_bodies.get((flow.id, part))
            if body:
                body.finish()
        self.publish(flow, status)

    def error(self, flow):
        """网络错误进入同一流量记录，避免请求一直显示等待响应。"""
        for part in ("request", "response"):
            body = self.stream_bodies.get((flow.id, part))
            if body:
                body.interrupted = True
                body.error = body.error or "网络中断，正文可能不完整"
                body.finish()
        self.publish(flow, "error")

    def websocket_start(self, flow):
        """握手结束后标识消息查看入口，不修改 WebSocket 转发。"""
        self.publish(flow, "complete")
        self.record_websocket(flow, initial=True)

    def websocket_message(self, flow):
        """仅发送当前重组消息的有限快照，不反复发送历史正文。"""
        self.record_websocket(flow)

    def websocket_end(self, flow):
        """保留关闭码与原因；未收到关闭帧的结束仍由引擎信息标识。"""
        self.record_websocket(flow, ended=True)

    def record_websocket(self, flow, ended=False, initial=False):
        """只采集当前记录会话，连接已有但未记录的历史不能补回。"""
        if (
            flow.metadata.get("capture_session") != self.capture_session
            or not self.capture_session
        ):
            return
        event = websocket_event(flow, self.settings, ended=ended or initial)
        if initial:
            event["summary"]["state"] = "open"
        if self.emit(event):
            accepted_websocket_event(flow, event)

    def publish(self, flow, status, original=None, include_body=True):
        """将 HTTPFlow 转为可存储事件，响应头阶段只推送摘要。"""
        flow.metadata["capture_status"] = status
        session_id = flow.metadata.get("capture_session")
        if not session_id or session_id != self.capture_session:
            return
        request = flow.request
        detail = {
            "id": flow.id,
            "host": request.host,
            "url": request.url,
            "method": request.method,
            "started": request.timestamp_start,
            "status": status,
            "policy_version": flow.metadata.get(
                "policy_version", self.settings["version"]
            ),
            "reason": flow.metadata.get("hook_error")
            or (str(flow.error) if flow.error else ""),
            "tls": request.scheme == "https",
            "source": "capture",
            "transport": {
                "client": connection_snapshot(
                    flow.client_conn,
                    flow.metadata.get("client_http_version", request.http_version),
                ),
                "upstream": connection_snapshot(flow.server_conn),
            },
            "executed_hooks": list(flow.metadata.get("executed_hooks", [])),
        }
        if original is not None:
            detail["original_request"] = original
        includes_request = include_body and (
            not flow.metadata.get("request_saved")
            or self.stream_bodies.get((flow.id, "request"))
        )
        if includes_request:
            detail["request"] = snapshot(request, self.settings["body_limit"])
            if body := self.stream_bodies.get((flow.id, "request")):
                detail["request"].pop("body_b64", None)
                detail["request"].update(body.snapshot())
            detail["request"].update(url=request.url, method=request.method)
        if flow.response:
            detail["code"] = flow.response.status_code
            if include_body or self.stream_bodies.get((flow.id, "response")):
                detail["response"] = snapshot(
                    flow.response, self.settings["body_limit"]
                )
                if body := self.stream_bodies.get((flow.id, "response")):
                    detail["response"].pop("body_b64", None)
                    detail["response"].update(body.snapshot())
                detail["size"] = detail["response"]["body_size"]
            if flow.response.timestamp_end:
                detail["duration"] = round(
                    (flow.response.timestamp_end - request.timestamp_start) * 1000, 2
                )
        if (
            self.emit({"type": "flow", "session_id": session_id, "flow": detail})
            and includes_request
        ):
            # 队列超载时保留重试机会，后续响应事件仍可补齐请求。
            flow.metadata["request_saved"] = True


addons = [CaptureAddon()]
