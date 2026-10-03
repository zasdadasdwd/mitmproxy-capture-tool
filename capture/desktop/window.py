"""源码桌面入口：WebKit 只负责显示，抓包仍由原 Python 环境处理。"""

import argparse
import logging
import subprocess
import sys
import time
from pathlib import Path

import httpx

from config import DATA, ROOT, load_startup


class DesktopBackend:
    """连接同项目的现有服务，或启动服务并在窗口退出时负责收尾。"""

    def __init__(self, config_path):
        self.config_path = Path(config_path).resolve()
        startup = load_startup(self.config_path)
        self.url = f"http://{startup.web.host}:{startup.web.port}"
        self.process = None
        self.log = None
        self.client = httpx.Client(base_url=self.url, trust_env=False, timeout=1)

    def ready(self):
        """确认端口上是本项目，避免连接到其他副本或其他网站。"""
        try:
            response = self.client.get("/api/status")
            if response.status_code != 200:
                return False
            status = response.json()
            if not isinstance(status, dict) or "runtime_id" not in status:
                raise RuntimeError("配置端口已被其他服务占用")
            if status.get("project_root") != str(ROOT):
                raise RuntimeError(
                    "端口上的服务属于其他项目或旧版本，请先关闭或重启该服务"
                )
            return True
        except (httpx.HTTPError, ValueError):
            return False

    def start(self):
        """使用当前解释器启动 main.py，保留 Hook 所需环境且禁止打开浏览器。"""
        if self.ready():
            return
        log_path = DATA / "logs/desktop-window.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log = log_path.open("a", encoding="utf-8")
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "main.py"),
                "--config",
                str(self.config_path),
                "--no-browser",
            ],
            cwd=ROOT,
            stdout=self.log,
            stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                break
            if self.ready():
                return
            time.sleep(0.1)
        raise RuntimeError(f"服务启动失败，请查看日志：{log_path}")

    def close(self):
        """只停止自己创建的服务；复用浏览器服务时不会中断其抓包。"""
        try:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        finally:
            self.client.close()
            if self.log is not None:
                self.log.close()


def set_app_identity():
    """WebKit 初始化后设置 Dock 名称与图标，不改变任何系统代理。"""
    import AppKit
    import Foundation

    Foundation.NSProcessInfo.processInfo().setProcessName_("天机阁")
    icon = AppKit.NSImage.alloc().initWithContentsOfFile_(
        str(ROOT / "capture/web/favicon.png")
    )
    if icon:
        AppKit.NSApplication.sharedApplication().performSelectorOnMainThread_withObject_waitUntilDone_(
            "setApplicationIconImage:", icon, False
        )


def main():
    """在主线程打开完整控制台，所有分析、重放、设置复用原页面。"""
    parser = argparse.ArgumentParser(description="天机阁 · App 窗口启动")
    parser.add_argument("--config", type=Path, default=ROOT / "startup.toml")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("此窗口入口目前仅支持 macOS，请使用 python main.py")
    if not args.config.is_file():
        parser.error(f"启动配置不存在：{args.config}")
    try:
        import webview
    except ImportError:
        parser.error(
            "请先安装窗口依赖：python -m pip install -r capture/desktop/requirements.txt"
        )
    backend = DesktopBackend(args.config)
    try:
        backend.start()
        webview.settings["ALLOW_DOWNLOADS"] = True
        # 新页面链接在 WebKit 内打开，完整查看、说明和分析不调用浏览器。
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False
        window = webview.create_window(
            "天机阁 · 观流溯源，洞悉天机",
            backend.url + "/",
            width=1440,
            height=900,
            min_size=(720, 480),
            text_select=True,
        )
        window.events.loaded += lambda: print("天机阁窗口页面已加载", flush=True)
        webview.start(set_app_identity, gui="cocoa", debug=False)
    except (RuntimeError, OSError) as exc:
        logging.getLogger(__name__).error("窗口启动失败：%s", exc)
        raise SystemExit(1) from exc
    finally:
        backend.close()
