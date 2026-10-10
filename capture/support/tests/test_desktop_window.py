"""窗口入口生命周期测试：复用服务与自建服务拥有不同退出责任。"""

import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from capture.desktop.window import DesktopBackend
from config import ROOT


@pytest.mark.parametrize("localized", [None, {"CFBundleName": "Python"}])
def test_app_identity_updates_bundle_before_cocoa(monkeypatch, localized):
    """Dock 名称来自主 bundle；本地化名称存在时也要一致。"""
    from capture.desktop.window import prepare_app_identity

    info = {"CFBundleName": "Python"}
    bundle = Mock()
    bundle.infoDictionary.return_value = info
    bundle.localizedInfoDictionary.return_value = localized
    process = Mock()
    monkeypatch.setitem(sys.modules, "Foundation", SimpleNamespace(
        NSBundle=SimpleNamespace(mainBundle=lambda: bundle),
        NSProcessInfo=SimpleNamespace(processInfo=lambda: process),
    ))
    prepare_app_identity()
    assert info["CFBundleName"] == info["CFBundleDisplayName"] == "天机阁"
    if localized is not None:
        assert localized["CFBundleName"] == localized["CFBundleDisplayName"] == "天机阁"
    process.setProcessName_.assert_called_once_with("天机阁")


def backend_with_status(status):
    backend = DesktopBackend(ROOT / "startup.toml")
    backend.client.close()
    backend.client = Mock()
    backend.client.get.return_value = Mock(
        status_code=200, json=Mock(return_value=status)
    )
    return backend


def test_existing_service_is_not_stopped(monkeypatch):
    backend = backend_with_status({"runtime_id": "test", "project_root": str(ROOT)})
    spawn = Mock()
    monkeypatch.setattr("capture.desktop.window.subprocess.Popen", spawn)
    backend.start()
    backend.close()
    spawn.assert_not_called()
    backend.client.close.assert_called_once()


def test_other_project_is_not_reused():
    backend = backend_with_status(
        {"runtime_id": "test", "project_root": "/other/project"}
    )
    with pytest.raises(RuntimeError, match="其他项目"):
        backend.start()
    backend.close()


def test_owned_service_receives_graceful_shutdown():
    backend = backend_with_status({})
    backend.process = Mock()
    backend.process.poll.return_value = None
    backend.close()
    backend.process.terminate.assert_called_once()
    backend.process.wait.assert_called_once_with(timeout=20)
    backend.process.kill.assert_not_called()


def test_new_service_uses_current_interpreter_without_browser(monkeypatch):
    """窗口新建服务必须使用当前环境，避免 Hook 依赖在独立打包环境中丢失。"""
    import sys

    backend = backend_with_status({})
    monkeypatch.setattr(backend, "ready", Mock(side_effect=[False, True]))
    process = Mock()
    process.poll.return_value = None
    spawn = Mock(return_value=process)
    monkeypatch.setattr("capture.desktop.window.subprocess.Popen", spawn)
    backend.start()
    command = spawn.call_args.args[0]
    assert command == [
        sys.executable,
        str(ROOT / "main.py"),
        "--config",
        str(ROOT / "startup.toml"),
        "--no-browser",
    ]
    assert spawn.call_args.kwargs["cwd"] == ROOT
    backend.close()


def test_external_tool_uses_browser_without_navigating_app(monkeypatch):
    from capture.desktop.window import DesktopLinks

    browser = Mock(return_value=True)
    monkeypatch.setattr("capture.desktop.window.webbrowser.open", browser)
    assert DesktopLinks().open_external_tool("https://spidertools.cn/#/") is True
    browser.assert_called_once_with("https://spidertools.cn/#/", new=2)
    with pytest.raises(ValueError):
        DesktopLinks().open_external_tool("https://spidertools.cn.evil.test/")
    assert browser.call_count == 1


def test_desktop_restart_preserves_website_storage(monkeypatch):
    """实际窗口入口必须关闭清空网站数据的隐私模式，且保留服务退出责任。"""
    from capture.desktop import window as module

    backend = Mock(url="http://127.0.0.1:8765")
    shell = Mock()
    from unittest.mock import MagicMock
    shell.events.loaded = MagicMock()
    webview = SimpleNamespace(settings={}, create_window=Mock(return_value=shell), start=Mock())
    monkeypatch.setattr(sys, "argv", ["app_main.py"])
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(module, "prepare_app_identity", Mock())
    monkeypatch.setattr(module, "DesktopBackend", Mock(return_value=backend))
    monkeypatch.setitem(sys.modules, "webview", webview)
    module.main()
    assert webview.start.call_args.kwargs["private_mode"] is False
    backend.start.assert_called_once()
    backend.close.assert_called_once()
