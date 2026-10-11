"""引擎启动失败与取消时释放临时资源，不启动真实代理。"""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from capture.engine import manager as manager_module
from capture.engine.manager import EngineManager, _read_log_tail


class FakeServer:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass


def settings():
    return SimpleNamespace(
        listen_host="127.0.0.1",
        listen_port=8080,
        body_limit=1024,
        connection_mode="direct",
        upstream_proxy="",
    )


def track_temporary_directories(monkeypatch):
    paths = []
    original = manager_module.tempfile.TemporaryDirectory

    def create(*args, **kwargs):
        folder = original(*args, **kwargs)
        paths.append(Path(folder.name))
        return folder

    monkeypatch.setattr(manager_module.tempfile, "TemporaryDirectory", create)
    return paths


def test_unix_server_failure_cleans_temporary_folder(monkeypatch):
    paths = track_temporary_directories(monkeypatch)
    manager = EngineManager(None, lambda event: None)

    async def fail_server(*args, **kwargs):
        raise OSError("socket unavailable")

    monkeypatch.setattr(asyncio, "start_unix_server", fail_server)

    with pytest.raises(RuntimeError, match="socket unavailable"):
        asyncio.run(manager.start_proxy(settings()))

    assert len(paths) == 1
    assert not paths[0].exists()
    assert manager.socket_folder is None
    assert manager.server is None


def test_control_file_failure_closes_server_and_temporary_folder(monkeypatch):
    paths = track_temporary_directories(monkeypatch)
    server = FakeServer()
    manager = EngineManager(None, lambda event: None)

    async def start_server(*args, **kwargs):
        return server

    monkeypatch.setattr(asyncio, "start_unix_server", start_server)
    original_write_text = Path.write_text

    def fail_control_file(path, *args, **kwargs):
        if path.name == "recording.json":
            raise OSError("control file unavailable")
        return original_write_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", fail_control_file)

    with pytest.raises(RuntimeError, match="control file unavailable"):
        asyncio.run(manager.start_proxy(settings()))

    assert server.closed
    assert not paths[0].exists()
    assert manager.socket_folder is None
    assert manager.server is None


def test_cancelled_start_cleans_resources_and_reraises(monkeypatch):
    paths = track_temporary_directories(monkeypatch)
    server = FakeServer()
    manager = EngineManager(None, lambda event: None)
    reached_spawn = asyncio.Event()

    async def start_server(*args, **kwargs):
        return server

    async def wait_before_spawn(*args, **kwargs):
        reached_spawn.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(asyncio, "start_unix_server", start_server)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", wait_before_spawn)

    async def run():
        task = asyncio.create_task(manager.start_proxy(settings()))
        await reached_spawn.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())

    assert server.closed
    assert not paths[0].exists()
    assert manager.socket_folder is None
    assert manager.server is None
    assert manager.log_file is None


def test_large_engine_log_reads_only_bounded_tail(tmp_path, monkeypatch):
    log = tmp_path / "engine.log"
    log.write_bytes(b"x" * (8 * 1024 * 1024) + b"final diagnostic")
    read_sizes = []
    original_open = Path.open

    class TrackingReader:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            self.stream.__enter__()
            return self

        def __exit__(self, *args):
            return self.stream.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def read(self, size=-1):
            read_sizes.append(size)
            return self.stream.read(size)

    def tracking_open(path, *args, **kwargs):
        stream = original_open(path, *args, **kwargs)
        if path == log:
            return TrackingReader(stream)
        return stream

    monkeypatch.setattr(Path, "open", tracking_open)

    tail = _read_log_tail(log)

    assert read_sizes == [2000]
    assert len(tail.encode()) <= 2000
    assert tail.endswith("final diagnostic")


@pytest.mark.parametrize("enabled", [True, False])
def test_console_switch_controls_relay_not_log(monkeypatch, enabled):
    from unittest.mock import Mock

    manager = EngineManager(None, lambda event: None, console_output=enabled)
    relay = Mock()
    monkeypatch.setattr(manager_module, "ConsoleLogRelay", relay)
    server = FakeServer()
    spawn_options = {}

    async def run():
        exited = asyncio.Event()

        async def start_server(*args, **kwargs):
            return server

        class Process:
            returncode = None

            async def wait(self):
                await exited.wait()
                return 0

            def send_signal(self, signal):
                self.returncode = 0
                exited.set()

        async def spawn(*args, **kwargs):
            spawn_options.update(kwargs)
            manager.ready.set()
            return Process()

        monkeypatch.setattr(asyncio, "start_unix_server", start_server)
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        await manager.start_proxy(settings())
        assert spawn_options["stdout"] is manager.log_file
        assert spawn_options["env"]["PYTHONUNBUFFERED"] == "1"
        if enabled:
            relay.return_value.start.assert_called_once()
        else:
            relay.assert_not_called()
        await manager.stop_process()
        assert manager.console_relay is None
        assert manager.log_file is None

    asyncio.run(run())
