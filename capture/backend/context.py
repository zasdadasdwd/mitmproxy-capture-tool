"""进程级依赖容器与生命周期；各 API 路由通过 workbench() 获取实例。"""

import asyncio
import sys
from builtins import BaseExceptionGroup
from contextlib import asynccontextmanager
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import Request

from capture.backend.links.manager import AnalysisManager
from capture.backend.query_logs import QueryLogs
from capture.backend.storage import Store
from capture.engine.manager import EngineManager
from capture.plugins.base import discover_hooks
from config import DATA, load_settings, load_startup, save_settings


class Workbench:
    """管理服务持有配置、存储、引擎和重放任务，生命周期独立于代理。"""

    def __init__(self):
        """加载全局配置，初始化存储，但不自动开启代理。"""
        self.settings = load_settings()
        self.startup = load_startup()
        self.hooks = discover_hooks(self.startup.extensions.hook_modules)
        save_settings(self.settings)
        self.store = Store(DATA / "captures")
        self.runtime_id = uuid4().hex
        self.subscribers = set()
        self.engine = EngineManager(
            self.store,
            self.notify,
            self.startup.extensions.hook_modules,
            console_output=self.startup.logging.console_output,
        )
        self.jobs = {}
        self.config_lock = asyncio.Lock()
        self.query_logs = QueryLogs(DATA / "logs")
        self.analysis = AnalysisManager(DATA / "captures", DATA / "analysis")

    def notify(self, event):
        """向订阅者发送轻量刷新通知，慢客户端队列始终有界。"""
        # 只推送失效通知；重新查询数据库可自然补回断线期间的记录。
        for queue in self.subscribers:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(event)


@asynccontextmanager
async def lifespan(app):
    """启动管理服务，退出时取消重放并收尾代理，避免遗留子进程。"""
    app.state.workbench = Workbench()
    workbench = app.state.workbench
    try:
        try:
            await workbench.engine.ensure_proxy(workbench.settings)
        except RuntimeError:
            # 端口冲突时保留管理页面，让用户可以修改监听配置后重试。
            pass
        if workbench.startup.proxy.autostart:
            await workbench.engine.start(workbench.settings)
        yield
    finally:
        # done_callback 可能在等待期间移除 jobs，先固定任务与会话 ID。
        jobs = list(workbench.jobs.items())
        errors = []
        for _, task in jobs:
            task.cancel()
        if jobs:
            results = await asyncio.gather(
                *(task for _, task in jobs), return_exceptions=True
            )
            errors.extend(
                result
                for result in results
                if isinstance(result, BaseException)
                and not isinstance(result, asyncio.CancelledError)
            )
        for session_id, _ in jobs:
            try:
                await asyncio.to_thread(workbench.store.finish, session_id, "cancelled")
            except Exception as exc:  # noqa: BLE001 - 继续关闭其余资源后统一报告。
                errors.append(exc)
        for close in (
            workbench.analysis.close,
            workbench.engine.shutdown,
        ):
            try:
                await close()
            except Exception as exc:  # noqa: BLE001 - 继续关闭其余资源后统一报告。
                errors.append(exc)
        try:
            await asyncio.to_thread(workbench.store.close)
        except Exception as exc:  # noqa: BLE001 - 继续关闭其余资源后统一报告。
            errors.append(exc)
        if errors:
            original = sys.exception()
            if original is not None:
                errors.insert(0, original)
            raise BaseExceptionGroup("服务收尾失败", errors)


def local_origin(origin, host):
    """要求浏览器调用来自当前管理界面，非浏览器客户端可不带 Origin。"""
    return not origin or urlsplit(origin).netloc == host


def workbench(request: Request):
    """从当前应用生命周期取服务对象，避免导入时创建数据库。"""
    return request.app.state.workbench
