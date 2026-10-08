"""管理进程异常消失时，代理必须释放监听端口，不修改用户数据。"""

import asyncio
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import time
from unittest.mock import AsyncMock, Mock

import config


def test_parent_watch_exits_when_parent_changes(tmp_path, monkeypatch):
    """PPID 仍是原管理进程时继续等待，变化后只关闭本代理一次。"""
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps(config.Settings().model_dump()))
    monkeypatch.setenv("CAPTURE_SETTINGS", str(settings))
    monkeypatch.setenv("CAPTURE_HOOK_MODULES", "[]")
    monkeypatch.setenv("CAPTURE_PARENT_PID", "12345")
    spec = importlib.util.spec_from_file_location(
        "test_parent_addon", config.ROOT / "capture/engine/addon.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    shutdown = Mock()
    monkeypatch.setattr(module.ctx, "master", Mock(shutdown=shutdown), raising=False)
    sleep = AsyncMock()
    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    monkeypatch.setattr(module.os, "getppid", Mock(side_effect=[12345, 1]))
    asyncio.run(module.CaptureAddon.watch_parent(None))
    shutdown.assert_called_once()
    assert sleep.await_count == 2
    monkeypatch.delenv("CAPTURE_PARENT_PID")
    asyncio.run(module.CaptureAddon.watch_parent(None))
    assert sleep.await_count == 2  # 手动加载 addon 不应触发管理进程监控。


def test_real_proxy_releases_port_after_parent_is_killed(tmp_path):
    """强制结束真实管理子进程，mitmdump 应自行关闭，不残留孤儿监听。"""
    with socket.socket() as socket_probe:
        socket_probe.bind(("127.0.0.1", 0))
        port = socket_probe.getsockname()[1]
    settings = config.Settings(listen_host="127.0.0.1", listen_port=port)
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(settings.model_dump_json())
    script = f"""
import asyncio
from pathlib import Path
from capture.engine import manager
from config import Settings
manager.DATA = Path({str(tmp_path)!r})
manager.CONFIG_PATH = Path({str(settings_file)!r})
async def run():
    engine = manager.EngineManager(None, lambda event: None)
    await engine.ensure_proxy(Settings.model_validate_json(manager.CONFIG_PATH.read_text()))
    print(engine.process.pid, flush=True)
    await asyncio.Event().wait()
asyncio.run(run())
"""
    log = tmp_path / "parent.log"
    engine_pid = None
    with log.open("w+") as output:
        parent = subprocess.Popen(
            [sys.executable, "-c", script],
            cwd=config.ROOT,
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                output.seek(0)
                lines = output.read().splitlines()
                if lines and lines[-1].isdigit():
                    engine_pid = int(lines[-1])
                    break
                assert parent.poll() is None, lines
                time.sleep(0.1)
            assert engine_pid is not None, "测试代理启动超时"
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                pass
            parent.kill()  # 模拟 IDE 强制停止，管理进程无法执行 finally。
            parent.wait(timeout=5)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                with socket.socket() as probe:
                    probe.settimeout(0.2)
                    if probe.connect_ex(("127.0.0.1", port)) != 0:
                        break
                time.sleep(0.1)
            else:
                raise AssertionError("管理进程退出后代理仍占用端口")
        finally:
            if parent.poll() is None:
                parent.terminate()
                parent.wait(timeout=10)
            if engine_pid is not None:
                try:
                    os.kill(engine_pid, signal.SIGINT)
                except ProcessLookupError:
                    pass
