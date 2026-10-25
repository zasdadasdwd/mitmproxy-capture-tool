"""自动保护采样回归：合成内存，不分配大图片或接触用户窗口。"""

import ctypes
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from capture.desktop import background_memory as module
from config import BackgroundProtectionStartup, load_startup


def test_configuration_defaults_and_validation(tmp_path):
    path = tmp_path / "startup.toml"
    path.write_text("[web]\nport=8765\n")
    assert load_startup(path).background_protection.pause_mib == 512
    for values in (
        {"hide_mib": 512},
        {"interval_seconds": 0},
        {"consecutive_samples": 1},
    ):
        with pytest.raises(ValueError):
            BackgroundProtectionStartup(**values)


def test_libproc_uses_phys_footprint_not_resident_size(monkeypatch):
    module._rusage_query.cache_clear()

    def query(pid, version, pointer):
        assert (pid, version) == (123, 2)
        info = ctypes.cast(pointer, ctypes.POINTER(module._RUsageInfoV2)).contents
        info.phys_footprint = 600 * 1024 * 1024
        info.resident_size = 2 * 1024 * 1024
        return 0

    native = Mock(side_effect=query)
    monkeypatch.setattr(
        ctypes, "CDLL", lambda *a, **kw: SimpleNamespace(proc_pid_rusage=native)
    )
    assert module.physical_footprint(123) == 600
    assert ctypes.sizeof(module._RUsageInfoV2) == 160
    module._rusage_query.cache_clear()


def test_only_the_bound_windows_pid_is_sampled(monkeypatch):
    view = Mock()
    view.respondsToSelector_.return_value = True
    view._webProcessIdentifier.return_value = 456
    window = SimpleNamespace(
        uid="owned",
        gui=SimpleNamespace(
            BrowserView=SimpleNamespace(
                instances={"owned": SimpleNamespace(webview=view)}
            )
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "PyObjCTools",
        SimpleNamespace(AppHelper=SimpleNamespace(callAfter=lambda fn: fn())),
    )
    footprint = Mock(return_value=123)
    monkeypatch.setattr(module, "physical_footprint", footprint)
    monitor = module.BackgroundMemoryMonitor(window, BackgroundProtectionStartup())
    assert monitor._sample() == (456, 123)
    footprint.assert_called_once_with(456)
    view.respondsToSelector_.return_value = False
    with pytest.raises(RuntimeError, match="无法识别"):
        monitor._sample()
    footprint.assert_called_once()


def test_failure_is_reported_once_and_interrupts_every_sample():
    outputs = []
    monitor = module.BackgroundMemoryMonitor(
        None,
        BackgroundProtectionStartup(),
        sampler=Mock(side_effect=OSError()),
        dispatch=outputs.append,
    )
    monitor.sample_once()
    monitor.sample_once()
    assert outputs[0]["error"]
    assert "error" not in outputs[1]
    assert all(x["unavailable"] for x in outputs)
    monitor.close()
    monitor.sample_once()
    assert len(outputs) == 2


def test_worker_is_unique_and_close_releases_waiting_thread():
    monitor = module.BackgroundMemoryMonitor(
        None, BackgroundProtectionStartup(), sampler=Mock(), dispatch=Mock()
    )
    monitor.start()
    thread = monitor.thread
    monitor.start()
    assert monitor.thread is thread
    monitor.close()
    assert not thread.is_alive()
    monitor.sampler.assert_not_called()
    monitor.start()
    assert monitor.thread is thread
    disabled = module.BackgroundMemoryMonitor(
        None, BackgroundProtectionStartup(enabled=False)
    )
    disabled.start()
    assert disabled.thread is None


def test_success_uses_config_and_notifies_without_mutating_it():
    config = BackgroundProtectionStartup(pause_mib=256, hide_mib=384)
    outputs = []
    monitor = module.BackgroundMemoryMonitor(
        None, config, sampler=lambda: (321, 400), dispatch=outputs.append
    )
    monitor.sample_once()
    assert outputs == [{"pid": 321, "mib": 400, "settings": config.model_dump()}]
    assert config.pause_mib == 256


def test_blocked_js_keeps_only_one_inflight_and_one_latest_payload(monkeypatch):
    callbacks = []
    view = SimpleNamespace(
        evaluateJavaScript_completionHandler_=lambda script, cb: callbacks.append(
            (script, cb)
        )
    )
    window = SimpleNamespace(
        uid="own",
        gui=SimpleNamespace(
            BrowserView=SimpleNamespace(
                instances={"own": SimpleNamespace(webview=view)}
            )
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "PyObjCTools",
        SimpleNamespace(AppHelper=SimpleNamespace(callAfter=lambda fn: fn())),
    )
    monitor = module.BackgroundMemoryMonitor(window, BackgroundProtectionStartup())
    for i in range(1000):
        monitor._dispatch({"mib": i})
    assert len(callbacks) == 1
    assert monitor.latest_payload == {"mib": 999}
    callbacks[0][1]()
    assert len(callbacks) == 2
    assert '"mib": 999' in callbacks[1][0]
    monitor.close()
    callbacks[1][1]()
    assert len(callbacks) == 2


def test_pending_pid_request_is_reused_instead_of_accumulating_callbacks(monkeypatch):
    schedule = Mock()
    monkeypatch.setitem(
        sys.modules,
        "PyObjCTools",
        SimpleNamespace(AppHelper=SimpleNamespace(callAfter=schedule)),
    )
    monitor = module.BackgroundMemoryMonitor(None, BackgroundProtectionStartup())
    pending = Mock()
    pending.is_set.return_value = False
    pending.wait.return_value = False
    monitor.pid_request = (pending, [])
    for _ in range(2):
        with pytest.raises(RuntimeError, match="无法识别"):
            monitor._sample()
    schedule.assert_not_called()
    assert pending.wait.call_count == 2
