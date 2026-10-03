"""状态、配置、Hook 目录和代理控制接口。"""

import asyncio

from fastapi import APIRouter, HTTPException, Request

from capture.backend.context import workbench
from capture.backend.network import proxy_addresses
from capture.plugins.base import hook_catalog
from config import ROOT, Settings, save_settings

router = APIRouter()


@router.get("/api/status")
def status(request: Request):
    """返回引擎状态、配置和可取消的重放任务。"""
    state = workbench(request)
    return {
        **state.engine.status(),
        "runtime_id": state.runtime_id,
        "project_root": str(ROOT),
        "network": proxy_addresses(state.settings),
        "settings": state.settings.model_dump(),
        "replay_jobs": list(state.jobs),
    }


@router.get("/api/bootstrap")
def bootstrap(request: Request):
    """供 MCP 查询启动配置和 API 地址。"""
    startup = workbench(request).startup
    return {
        "startup": startup.model_dump(),
        "api_base_url": f"http://{startup.web.host}:{startup.web.port}",
        "mcp_implemented": True,
        "api_version": "0.1",
    }


@router.put("/api/settings")
async def update_settings(settings: Settings, request: Request):
    """校验并发布配置；代理重启失败时恢复旧配置和转发。"""
    state = workbench(request)
    available = set(state.hooks)
    unknown = [
        hook.name for hook in settings.request_hooks if hook.name not in available
    ]
    if unknown:
        raise HTTPException(400, f"未注册的 Hook：{', '.join(unknown)}")
    async with state.config_lock:
        previous = state.settings.model_copy(deep=True)
        if settings.listen_port == state.startup.web.port:
            raise HTTPException(400, "代理端口不能与管理界面端口相同")
        if (
            state.engine.status()["recording"]
            and settings.request_hooks != state.settings.request_hooks
        ):
            raise HTTPException(409, "请停止抓包后修改 Hook 列表或执行顺序")
        restart_proxy = settings.request_hooks != state.settings.request_hooks or (
            settings.listen_host,
            settings.listen_port,
            settings.connection_mode,
            settings.upstream_proxy,
        ) != (
            state.settings.listen_host,
            state.settings.listen_port,
            state.settings.connection_mode,
            state.settings.upstream_proxy,
        )
        if state.engine.status()["recording"] and restart_proxy:
            raise HTTPException(409, "请停止抓包后修改监听地址、端口或外部代理")
        settings.version = previous.version + 1
        if state.engine.status()["recording"]:
            await asyncio.to_thread(
                state.store.record_policy,
                state.engine.session_id,
                settings.model_dump(),
            )
        await asyncio.to_thread(save_settings, settings)
        if restart_proxy or not state.engine.status()["running"]:
            try:
                await state.engine.reconfigure(settings)
            except (RuntimeError, ValueError) as exc:
                failures = []
                try:
                    await asyncio.to_thread(save_settings, previous)
                except OSError as restore_error:
                    failures.append(f"旧配置保存失败：{restore_error}")
                else:
                    try:
                        await state.engine.reconfigure(previous)
                    except (RuntimeError, ValueError) as restore_error:
                        failures.append(f"旧代理恢复失败：{restore_error}")
                state.notify({"type": "status"})
                detail = f"配置更新失败：{exc}"
                if failures:
                    detail += f"；恢复失败：{'；'.join(failures)}"
                else:
                    detail += "；已恢复原配置和代理"
                raise HTTPException(409, detail) from exc
        state.settings = settings
        state.notify({"type": "status"})
        return settings


@router.post("/api/engine/start")
async def start_engine(request: Request):
    """创建本次抓包会话并等待代理就绪，失败时返回具体错误。"""
    state = workbench(request)
    try:
        async with state.config_lock:
            result = await state.engine.start(state.settings)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(409, str(exc)) from exc
    state.notify({"type": "sessions"})
    return result


@router.post("/api/engine/stop")
async def stop_engine(request: Request):
    """停止抓包记录，代理继续转发网络流量。"""
    try:
        state = workbench(request)
        async with state.config_lock:
            return await state.engine.stop()
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/api/hooks")
def hook_files(request: Request):
    """列出通过 BaseHook 注册的类，不扫描或执行任意 Python 文件。"""
    return {"hooks": hook_catalog(workbench(request).hooks)}
