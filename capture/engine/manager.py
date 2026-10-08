"""独立代理进程的生命周期与本地 Unix socket 通信。"""

import asyncio
import json
import os
import secrets
import signal
import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

from config import CONFIG_PATH, DATA, ROOT


class EngineManager:
    """负责引擎进程、启动确认和采集通道，不直接处理 HTTP 参数。"""

    def __init__(self, store, notify, hook_modules=()):
        """接收存储对象与通知回调，代理可常驻，记录状态由独立控制文件切换。"""
        self.store = store
        self.notify = notify
        self.hook_modules = tuple(hook_modules)
        self.process = None
        self.session_id = None
        self.server = None
        self.ready = asyncio.Event()
        self.policy_version = None
        self.dropped_events = 0
        self.error = ""
        self.lock = asyncio.Lock()
        self.worker = None
        self.connections = set()
        self.clients = set()
        self.log_file = None
        self.socket_folder = None
        self.stopping = False
        self.capture_waiter = None
        self.control_sequence = 0
        self.control_path = None

    def status(self):
        """返回真实进程状态、会话、已确认策略版本及丢弃计数。"""
        return {
            "running": self.process is not None and self.process.returncode is None,
            "recording": self.session_id is not None
            and self.process is not None
            and self.process.returncode is None,
            "session_id": self.session_id,
            "policy_version": self.policy_version,
            "dropped_events": self.dropped_events,
            "error": self.error,
        }

    async def ensure_proxy(self, settings):
        """只启动网络转发，不创建 SQLite 会话；管理服务运行期间代理常驻。"""
        async with self.lock:
            return await self.start_proxy(settings)

    async def start_proxy(self, settings):
        """在持锁情况下创建代理进程与事件通道，不启用记录。"""
        if self.status()["running"]:
            return self.status()
        self.error = ""
        self.ready.clear()
        self.policy_version = None
        self.dropped_events = 0
        self.stopping = False
        self.token = secrets.token_hex(32)
        self.socket_folder = tempfile.TemporaryDirectory(prefix="capture-")
        socket_path = str(Path(self.socket_folder.name) / "events.sock")
        self.server = await asyncio.start_unix_server(
            self.receive, path=socket_path, limit=100 * 1024 * 1024
        )
        self.control_path = Path(self.socket_folder.name) / "recording.json"
        self.control_path.write_text(json.dumps({"session_id": None, "sequence": 0}))
        environment = dict(
            os.environ,
            CAPTURE_SETTINGS=str(CONFIG_PATH),
            CAPTURE_SOCKET=socket_path,
            CAPTURE_TOKEN=self.token,
            CAPTURE_SESSION="",
            CAPTURE_CONTROL=str(self.control_path),
            CAPTURE_PARENT_PID=str(os.getpid()),
            CAPTURE_BODY_ROOT=str(getattr(self.store, "root", DATA / "captures")),
            CAPTURE_HOOK_MODULES=json.dumps(self.hook_modules),
        )
        self.log_file = (Path(self.socket_folder.name) / "engine.log").open("wb")
        command = [
            sys.executable,
            "-c",
            "from mitmproxy.tools.main import mitmdump; mitmdump()",
            "--set",
            "flow_detail=0",
            "-s",
            str(ROOT / "capture/engine/addon.py"),
            "--listen-host",
            settings.listen_host,
            "--listen-port",
            str(settings.listen_port),
            "--set",
            f"confdir={DATA / 'certificates'}",
            "--set",
            "connection_strategy=lazy",
            "--set",
            f"stream_large_bodies={settings.body_limit}",
        ]
        if settings.connection_mode == "upstream":
            upstream = urlsplit(settings.upstream_proxy)
            address = upstream._replace(
                netloc=upstream.netloc.rsplit("@", 1)[-1]
            ).geturl()
            command.extend(["--mode", f"upstream:{address}"])
            if upstream.username is not None:
                auth = (
                    f"{unquote(upstream.username)}:{unquote(upstream.password or '')}"
                )
                command.extend(["--set", f"upstream_auth={auth}"])
        try:
            self.process = await asyncio.create_subprocess_exec(
                *command,
                env=environment,
                cwd=ROOT,
                stdout=self.log_file,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
            self.worker = asyncio.create_task(self.watch_process(self.process))
            await asyncio.wait_for(self.ready.wait(), timeout=20)
            await asyncio.sleep(0.1)
            if not self.status()["running"]:
                raise RuntimeError(self.error or "代理启动失败")
        except Exception as exc:
            await self.stop_process()
            self.error = str(exc) or "代理启动超时"
            raise RuntimeError(self.error) from exc
        return self.status()

    async def receive(self, reader, writer):
        """认证本地引擎，逐条存储事件后回复 ACK，以限制发送积压。"""
        task = asyncio.current_task()
        self.clients.add(task)
        self.connections.add(writer)
        try:
            token = (await asyncio.wait_for(reader.readline(), 5)).decode().strip()
            if not secrets.compare_digest(token, self.token):
                return
            while line := await reader.readline():
                event = json.loads(line)
                dropped = event.get("dropped_events", self.dropped_events)
                if dropped != self.dropped_events:
                    self.dropped_events = dropped
                    self.notify({"type": "status"})
                if event["type"] == "flow":
                    session_id = event.get("session_id")
                    if session_id and session_id == self.session_id:
                        await asyncio.to_thread(
                            self.store.save_flow, session_id, event["flow"]
                        )
                        self.notify(
                            {
                                "type": "flows",
                                "session_id": session_id,
                                "flow_id": event["flow"]["id"],
                            }
                        )
                elif event["type"] == "websocket":
                    session_id = event.get("session_id")
                    if session_id and session_id == self.session_id:
                        await asyncio.to_thread(
                            self.store.save_websocket, session_id, event
                        )
                        self.notify(
                            {
                                "type": "flows",
                                "session_id": session_id,
                                "flow_id": event["flow_id"],
                            }
                        )
                elif event["type"] == "capture":
                    if (
                        event.get("sequence") == self.control_sequence
                        and self.capture_waiter
                        and not self.capture_waiter.done()
                    ):
                        self.capture_waiter.set_result(None)
                elif event["type"] in ("ready", "policy"):
                    self.policy_version = event["version"]
                    if event["type"] == "ready":
                        self.ready.set()
                    self.notify({"type": "status"})
                writer.write(b"ok\n")
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as exc:
            self.error = f"采集数据处理失败：{exc}"
            self.notify({"type": "status"})
        finally:
            writer.close()
            self.connections.discard(writer)
            self.clients.discard(task)

    async def watch_process(self, process):
        """监控非预期退出，将故障同步到界面和会话状态。"""
        code = await process.wait()
        if not self.stopping:
            log = Path(self.socket_folder.name) / "engine.log"
            tail = (
                log.read_text(errors="replace")[-2000:].strip() if log.exists() else ""
            )
            self.error = f"代理进程退出（{code}）" + (f"：{tail}" if tail else "")
            self.ready.set()
            await self.close_transport()
            if self.session_id:
                await asyncio.to_thread(self.store.finish, self.session_id, "failed")
                self.session_id = None
            self.notify({"type": "status"})

    async def close_transport(self):
        """收尾事件连接，关闭日志并移除临时 socket 目录。"""
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        for writer in list(self.connections):
            writer.close()
        if self.clients:
            await asyncio.gather(*list(self.clients), return_exceptions=True)
        if self.log_file:
            self.log_file.close()
            self.log_file = None
        if self.socket_folder:
            self.socket_folder.cleanup()
            self.socket_folder = None

    async def stop_process(self):
        """先尝试 SIGINT 正常退出；超时后终止进程并清理资源。"""
        self.stopping = True
        if self.process and self.process.returncode is None:
            self.process.send_signal(signal.SIGINT)
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.worker:
            await self.worker
            self.worker = None
        await self.close_transport()

    async def set_capture(self, session_id):
        """等待记录切换确认；确认事件排在旧流量之后，停止时先落盘再结束会话。"""
        self.control_sequence += 1
        self.capture_waiter = asyncio.get_running_loop().create_future()
        temporary = self.control_path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"session_id": session_id, "sequence": self.control_sequence})
        )
        temporary.replace(self.control_path)
        try:
            await asyncio.wait_for(self.capture_waiter, 10)
        finally:
            self.capture_waiter = None

    async def start(self, settings):
        """启用记录并创建独立会话，已有代理与客户端连接保持不变。"""
        async with self.lock:
            if self.status()["recording"]:
                raise ValueError("抓包已经开始")
            await self.start_proxy(settings)
            self.session_id = await asyncio.to_thread(
                self.store.create_session, settings.model_dump()
            )
            session_id = self.session_id
            try:
                await self.set_capture(session_id)
            except Exception as exc:
                self.session_id = None
                await asyncio.to_thread(self.store.finish, session_id, "failed")
                self.error = "记录切换失败，请检查代理状态"
                raise RuntimeError(self.error) from exc
            self.notify({"type": "status"})
            return self.status()

    async def stop(self):
        """停止记录并结束当前会话，代理继续转发，未完成请求标记为中断。"""
        async with self.lock:
            if self.session_id:
                session_id = self.session_id
                if self.status()["running"]:
                    try:
                        await self.set_capture(None)
                    except (TimeoutError, OSError) as exc:
                        self.error = "停止记录未收到确认，已关闭写入"
                        raise RuntimeError(self.error) from exc
                    finally:
                        self.session_id = None
                        await asyncio.to_thread(self.store.finish, session_id)
                else:
                    self.session_id = None
                    await asyncio.to_thread(self.store.finish, session_id)
            self.notify({"type": "status"})
            return self.status()

    async def reconfigure(self, settings):
        """未记录时允许调整监听、上游代理或 Hook；重启转发进程应用配置。"""
        async with self.lock:
            if self.status()["recording"]:
                raise ValueError("请先停止抓包")
            await self.stop_process()
            return await self.start_proxy(settings)

    async def shutdown(self):
        """管理服务退出时才终止代理进程，释放监听端口。"""
        async with self.lock:
            session_id = self.session_id
            await self.stop_process()
            self.session_id = None
            if session_id:
                await asyncio.to_thread(self.store.finish, session_id)
