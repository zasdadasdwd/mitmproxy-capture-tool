"""桌面背景保护采样：只读取当前窗口的 WebKit 内容进程，不扫描其他应用。"""

import ctypes
import json
import logging
import threading
from functools import lru_cache


class _RUsageInfoV2(ctypes.Structure):
    """Darwin sys/resource.h 的公开 RUSAGE_INFO_V2 布局。"""

    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64)
        for name in (
            "user_time",
            "system_time",
            "pkg_idle_wkups",
            "interrupt_wkups",
            "pageins",
            "wired_size",
            "resident_size",
            "phys_footprint",
            "proc_start_abstime",
            "proc_exit_abstime",
            "child_user_time",
            "child_system_time",
            "child_pkg_idle_wkups",
            "child_interrupt_wkups",
            "child_pageins",
            "child_elapsed_abstime",
            "diskio_bytesread",
            "diskio_byteswritten",
        )
    ]


@lru_cache(maxsize=1)
def _rusage_query():
    """复用一个 libproc 查询函数，避免定时采样重复 dlopen。"""
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    query = library.proc_pid_rusage
    query.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    query.restype = ctypes.c_int
    return query


def physical_footprint(pid):
    """从 libproc 读取物理 footprint；失败不使用 RSS 或其他进程代替。"""
    info = _RUsageInfoV2()
    if pid <= 0 or _rusage_query()(pid, 2, ctypes.byref(info)) != 0:
        raise OSError("无法读取当前 WebKit 进程的物理内存")
    return info.phys_footprint / (1024 * 1024)


class BackgroundMemoryMonitor:
    """单个后台线程按启动配置采样，关闭窗口后停止；不修改用户外观文件。"""

    def __init__(self, window, settings, sampler=None, dispatch=None):
        self.window = window
        self.settings = settings
        self.stop_event = threading.Event()
        self.thread = None
        self.lock = threading.Lock()
        self.warned = False
        self.pid_request = None
        self.delivery_pending = False
        self.latest_payload = None
        self.sampler = sampler or self._sample
        self.dispatch = dispatch or self._dispatch

    def _browser(self):
        browser = self.window.gui.BrowserView.instances.get(self.window.uid)
        if browser is None or browser.webview is None:
            raise RuntimeError("当前窗口的 WebKit 尚未就绪")
        return browser.webview

    def _sample(self):
        from PyObjCTools import AppHelper

        with self.lock:
            pending = self.pid_request and not self.pid_request[0].is_set()
            if not pending:
                self.pid_request = (threading.Event(), [])
            done, result = self.pid_request

        def identify():
            try:
                if self.stop_event.is_set():
                    return
                view = self._browser()
                # WebKit 没有稳定的公开内容 PID API，运行时检查兼容性，失败明确告知。
                if not view.respondsToSelector_("_webProcessIdentifier"):
                    raise RuntimeError("此 WebKit 不支持当前窗口的进程识别接口")
                pid = int(view._webProcessIdentifier())
                if pid <= 0:
                    raise RuntimeError("当前窗口的 WebKit 内容进程尚未就绪")
                result.append(pid)
            except Exception:  # noqa: BLE001 - Cocoa bridge availability differs by runtime.
                result.append(None)
            finally:
                done.set()

        if not pending:
            AppHelper.callAfter(identify)
        if not done.wait(2) or not result or result[0] is None:
            raise RuntimeError("无法识别当前窗口的 WebKit 内容进程，内存保护暂不可用")
        pid = result[0]
        return pid, physical_footprint(pid)

    def _dispatch(self, payload):
        """最多一条 JS 通知在途，卡住时只保留最新样本，不累积任务队列。"""
        from PyObjCTools import AppHelper

        with self.lock:
            self.latest_payload = payload
            if self.delivery_pending or self.stop_event.is_set():
                return
            self.delivery_pending = True

        def completed(_result=None, _error=None):
            with self.lock:
                self.delivery_pending = False
                latest = self.latest_payload
                self.latest_payload = None
            if latest is not None and not self.stop_event.is_set():
                self._dispatch(latest)

        def send():
            with self.lock:
                value = self.latest_payload
                self.latest_payload = None
            if self.stop_event.is_set():
                completed()
                return
            script = (
                f"window.__tianjiBackgroundMemorySample={json.dumps(value)};"
                "window.dispatchEvent(new CustomEvent('tianji-background-memory',"
                "{detail:window.__tianjiBackgroundMemorySample}));"
            )
            try:
                self._browser().evaluateJavaScript_completionHandler_(script, completed)
            except Exception:  # noqa: BLE001 - closed/reloading WebKit must not stop the app.
                logging.getLogger(__name__).debug("背景保护通知暂无法投递")
                completed()

        AppHelper.callAfter(send)

    def sample_once(self):
        """一次失败也发送空样本以中断连续计数，仅首次失败提示。"""
        if self.stop_event.is_set():
            return
        try:
            pid, mib = self.sampler()
            payload = {"pid": pid, "mib": mib, "settings": self.settings.model_dump()}
        except (OSError, RuntimeError, AttributeError):
            if self.stop_event.is_set():
                return
            payload = {"unavailable": True}
            if not self.warned:
                self.warned = True
                payload["error"] = "无法读取当前 WebKit 内存，背景自动保护暂不可用"
                logging.getLogger(__name__).warning(payload["error"])
        if not self.stop_event.is_set():
            self.dispatch(payload)

    def start(self):
        """页面加载后启动一次；刷新页面不叠加线程。"""
        with self.lock:
            if not self.settings.enabled or self.stop_event.is_set() or self.thread:
                return
            self.thread = threading.Thread(
                target=self._run, name="background-memory", daemon=True
            )
            self.thread.start()

    def _run(self):
        while not self.stop_event.wait(self.settings.interval_seconds):
            self.sample_once()

    def close(self):
        """退出时取消下一次采样，不阻塞 Cocoa 线程等待 JS。"""
        self.stop_event.set()
        self.latest_payload = None
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=0.1)
