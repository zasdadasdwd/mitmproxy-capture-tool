"""独立的请求重放任务与导出接口。"""

import asyncio
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from capture.backend.context import workbench
from capture.backend.export import write_export
from capture.backend.replay import ReplayOptions, prepare_request, replay_batch

router = APIRouter()


@router.post("/api/sessions/{session_id}/replay")
async def replay(session_id: str, options: ReplayOptions, request: Request):
    """校验选中记录，创建独立重放会话并启动后台任务。"""
    state = workbench(request)
    if len(state.jobs) >= 3:
        raise HTTPException(409, "最多同时运行三个重放任务")
    if options.edit and len(options.ids) != 1:
        raise HTTPException(400, "编辑重放只能选择一个请求")
    requests = []
    try:
        for flow_id in options.ids:
            flow = await asyncio.to_thread(state.store.get_flow, session_id, flow_id)
            if flow.get("websocket"):
                raise ValueError("WebSocket 握手和消息暂不支持 HTTP 重放")
            message = options.edit.model_dump() if options.edit else flow.get("request")
            if options.edit:
                # 编辑的是业务参数，协议仍沿用来源请求，不能因编辑丢失 HTTP/2。
                message["http_version"] = (flow.get("request") or {}).get(
                    "http_version"
                )
            if not message:
                raise ValueError("透传或连接记录无法重放")
            prepare_request(message)
            requests.append((flow_id, message))
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
    # 重放独立会话，停止代理不影响正在执行的重放任务。
    target = await asyncio.to_thread(
        state.store.create_session, state.settings.model_dump(), "replay"
    )
    task = asyncio.create_task(
        replay_batch(
            state.store,
            target,
            requests,
            state.settings.model_dump(),
            state.notify,
            options,
            True,
            session_id,
        )
    )
    state.jobs[target] = task
    task.add_done_callback(lambda done: state.jobs.pop(target, None))
    state.notify({"type": "sessions"})
    return {"session_id": target}


@router.post("/api/replay/{job_id}/cancel")
async def cancel_replay(job_id: str, request: Request):
    """取消指定重放任务，已完成的记录继续保留。"""
    state = workbench(request)
    task = state.jobs.get(job_id)
    if task:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        # 协程首次执行前就取消时，其 finally 不会运行，管理层补齐收尾。
        await asyncio.to_thread(state.store.finish, job_id, "cancelled")
    return {"cancelled": bool(task)}


class ExportOptions(BaseModel):
    """导出必须明确指定记录 ID 和格式，不包含实时新增记录。"""

    ids: list[str] = Field(min_length=1, max_length=1000)
    format: Literal["curl", "python", "requests", "har", "csv", "json"]
    request_url: str | None = Field(default=None, max_length=16000)


@router.post("/api/sessions/{session_id}/export")
def export(session_id: str, options: ExportOptions, request: Request):
    """导出选中流量为 cURL、Python/httpx、Python/requests、HAR、CSV 或 JSON。"""
    if options.request_url is not None:
        if len(options.ids) != 1 or options.format not in ("curl", "requests"):
            raise HTTPException(400, "修改 URL 仅支持单条 cURL 或 requests 代码")
        try:
            prepare_request({"url": options.request_url, "method": "GET"})
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    extension = {"curl": "sh", "python": "py", "requests": "py"}.get(
        options.format, options.format
    )
    with tempfile.NamedTemporaryFile(
        prefix="capture-export-", suffix="." + extension, delete=False
    ) as temporary:
        path = Path(temporary.name)
    try:
        write_export(
            workbench(request).store,
            session_id,
            options.ids,
            options.format,
            path,
            request_url=options.request_url,
        )
    except ValueError as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(400, str(exc)) from exc
    except Exception:
        # 失败时清理半成品，成功下载后由响应后台任务删除文件。
        path.unlink(missing_ok=True)
        raise
    return FileResponse(
        path,
        filename=f"capture.{extension}",
        media_type="application/octet-stream",
        headers={"X-Capture-URL-Override": "applied"}
        if options.request_url is not None
        else None,
        background=BackgroundTask(path.unlink, missing_ok=True),
    )
