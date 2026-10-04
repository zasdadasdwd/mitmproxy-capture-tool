"""启动入口的浏览器容错与服务就绪时序。"""

import asyncio
from unittest.mock import Mock

import pytest
import uvicorn

import main


@pytest.mark.parametrize("result", [False, RuntimeError("no browser")])
def test_browser_failure_keeps_service_usable(monkeypatch, caplog, result):
    """系统缺少浏览器或浏览器抛异常时仍返回，提示实际访问地址。"""
    browser = (
        Mock(side_effect=result)
        if isinstance(result, Exception)
        else Mock(return_value=result)
    )
    monkeypatch.setattr(main.webbrowser, "open", browser)
    main.open_console("http://localhost:9876/")
    assert "http://localhost:9876/" in caplog.text


@pytest.mark.parametrize(
    "started,enabled", [(True, True), (False, True), (True, False)]
)
def test_browser_only_opens_after_successful_startup(monkeypatch, started, enabled):
    """监听失败或关闭自动打开时不启动浏览器线程。"""
    server = main.ConsoleServer(
        uvicorn.Config("capture.backend.app:app", port=9876), enabled
    )

    async def startup(self, sockets=None):
        self.started = started

    monkeypatch.setattr(uvicorn.Server, "startup", startup)
    thread = Mock()
    monkeypatch.setattr(main.threading, "Thread", thread)
    asyncio.run(server.startup())
    if started and enabled:
        assert thread.call_args.kwargs["args"] == ("http://127.0.0.1:9876/",)
        thread.return_value.start.assert_called_once()
    else:
        thread.assert_not_called()


@pytest.mark.parametrize("no_browser", [False, True])
def test_both_entry_modes_start_mcp_with_same_config(monkeypatch, tmp_path, no_browser):
    """App 使用 --no-browser，其余启动配置和 MCP 生命周期应与浏览器入口一致。"""
    import sys

    config_path = tmp_path / "startup.toml"
    config_path.write_text('[mcp]\nenabled = true\ntransport = "streamable-http"\n')
    argv = ["main.py", "--config", str(config_path)]
    if no_browser:
        argv.append("--no-browser")
    monkeypatch.setattr(sys, "argv", argv)
    monkeypatch.setenv("CAPTURE_STARTUP_FILE", "")
    process = Mock()
    process.poll.return_value = None
    spawn = Mock(return_value=process)
    server = Mock()
    server_class = Mock(return_value=server)
    monkeypatch.setattr(main.subprocess, "Popen", spawn)
    monkeypatch.setattr(main, "ConsoleServer", server_class)
    main.main()
    assert spawn.call_args.args[0] == [
        sys.executable,
        "-m",
        "capture.agent_mcp.server",
        "--config",
        str(config_path),
    ]
    assert server_class.call_args.kwargs["open_browser"] is (not no_browser)
    assert server_class.call_args.kwargs["mcp_process"] is process
    server.run.assert_called_once()
    process.terminate.assert_called_once()
    process.wait.assert_called_once_with(timeout=5)


@pytest.mark.parametrize("failed", [False, True])
def test_server_shutdown_closes_mcp_before_signal_is_reraised(monkeypatch, failed):
    """窗口发送 SIGTERM 时，无论 Web 收尾是否出错，都先关闭自己创建的 MCP。"""
    process = Mock()
    process.poll.return_value = None
    server = main.ConsoleServer(
        uvicorn.Config("capture.backend.app:app"), False, process
    )

    async def shutdown(self, sockets=None):
        if failed:
            raise RuntimeError("Web 收尾失败")

    monkeypatch.setattr(uvicorn.Server, "shutdown", shutdown)
    if failed:
        with pytest.raises(RuntimeError, match="Web 收尾失败"):
            asyncio.run(server.shutdown())
    else:
        asyncio.run(server.shutdown())
    assert server.mcp_process is None
    process.terminate.assert_called_once()
    process.wait.assert_called_once_with(timeout=5)


def test_mcp_shutdown_is_safe_for_already_exited_process():
    """异常退出或第二次关闭不能误发信号。"""
    process = Mock()
    process.poll.return_value = 0
    main.stop_mcp(process)
    main.stop_mcp(None)
    process.terminate.assert_not_called()


def test_mcp_shutdown_kills_unresponsive_child():
    """MCP 未在正常退出期限内关闭时，回收子进程以释放监听端口。"""
    process = Mock()
    process.poll.return_value = None
    process.wait.side_effect = [main.subprocess.TimeoutExpired("mcp", 5), 0]
    main.stop_mcp(process)
    process.kill.assert_called_once()
    assert process.wait.call_count == 2
