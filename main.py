"""启动本地管理界面：python main.py。"""

import argparse
import logging
import os
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn

from config import ROOT, load_startup


def open_console(url):
    """尝试打开默认浏览器；没有浏览器或启动失败时给出手动访问地址。"""
    logger = logging.getLogger("uvicorn.error")
    try:
        if webbrowser.open(url, new=2):
            return
    except Exception:  # noqa: BLE001 - 浏览器故障不能中断抓包服务。
        logger.warning("浏览器启动失败，请手动访问抓包控制台：%s", url)
        return
    logger.warning("无法自动打开浏览器，请手动访问抓包控制台：%s", url)


def stop_mcp(process):
    """关闭本次工作台创建的 MCP；重复收尾或已经退出时不再发送信号。"""
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


class ConsoleServer(uvicorn.Server):
    """在服务真正开始监听后打开控制台，浏览器操作不阻塞服务。"""

    def __init__(self, config, open_browser=True, mcp_process=None):
        super().__init__(config)
        self.open_browser = open_browser
        self.mcp_process = mcp_process

    async def startup(self, sockets=None):
        """等待 Uvicorn 启动成功，再在后台打开当前监听端口。"""
        await super().startup(sockets=sockets)
        if self.started and self.open_browser:
            url = f"http://{self.config.host}:{self.config.port}/"
            threading.Thread(
                target=open_console, args=(url,), name="console-browser", daemon=True
            ).start()

    async def shutdown(self, sockets=None):
        """App 退出的 SIGTERM 可能被 Uvicorn 再次发出，先在服务收尾阶段关闭 MCP。"""
        try:
            await super().shutdown(sockets=sockets)
        finally:
            stop_mcp(self.mcp_process)
            self.mcp_process = None


def main():
    """解析启动配置并运行 Web/API；MCP 由独立适配器调用这些 API。"""
    parser = argparse.ArgumentParser(description="Capture 流量工作台")
    parser.add_argument(
        "--config", type=Path, default=ROOT / "startup.toml", help="启动配置 TOML 路径"
    )
    parser.add_argument(
        "--no-browser", action="store_true", help="仅启动服务，不自动打开浏览器"
    )
    args = parser.parse_args()
    path = args.config.resolve()
    if not path.exists():
        parser.error(f"启动配置不存在：{path}")
    os.environ["CAPTURE_STARTUP_FILE"] = str(path)
    startup = load_startup(path)
    mcp_process = None
    if startup.mcp.enabled:
        if startup.mcp.transport == "stdio":
            parser.error(
                "stdio MCP 由 Agent 客户端启动；随工作台启动请使用 streamable-http"
            )
        if startup.mcp.port == startup.web.port:
            parser.error("MCP 与管理界面不能使用相同端口")
        if startup.mcp.entrypoint not in (
            "",
            "agent_mcp.server:main",  # 兼容已有启动配置。
            "capture.agent_mcp.server:main",
        ):
            parser.error("本版本 MCP 入口为 capture.agent_mcp.server:main")
        mcp_process = subprocess.Popen(
            [sys.executable, "-m", "capture.agent_mcp.server", "--config", str(path)],
            cwd=ROOT,
        )
    try:
        # 给 SSE 等长连接留出收尾时间，避免它们让程序退出无限等待。
        server = ConsoleServer(
            uvicorn.Config(
                "capture.backend.app:app",
                host=startup.web.host,
                port=startup.web.port,
                timeout_graceful_shutdown=5,
            ),
            open_browser=startup.web.open_browser and not args.no_browser,
            mcp_process=mcp_process,
        )
        server.run()
    finally:
        stop_mcp(mcp_process)


if __name__ == "__main__":
    main()
