"""抓包会话、请求列表和历史归档接口。"""

import asyncio
import json
import sqlite3
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from capture.backend.context import workbench
from capture.backend.filters import FlowFilters

router = APIRouter()


@router.get("/api/sessions")
def sessions(request: Request, include_archived: bool = False):
    """默认只返回本次启动会话；历史数据保留，需显式查询才读取。"""
    return workbench(request).store.sessions(current_only=not include_archived)


@router.get("/api/sessions/{session_id}/info")
def session_info(session_id: str, request: Request):
    """按 ID 读取单个会话状态，重放轮询无需遍历全部历史目录。"""
    with workbench(request).store.connect(session_id) as db:
        row = db.execute("SELECT id, kind, status FROM session").fetchone()
        return dict(zip(("id", "kind", "status"), row, strict=True))


class DeleteFlowOptions(BaseModel):
    """清空必须显式传 all；删除选中请求时提供具体 ID。"""

    ids: list[str] = Field(default_factory=list, max_length=1000)
    all: bool = False


class DeleteSessionOptions(BaseModel):
    """只删除用户明确选择的批次，不影响确认后才新增的会话。"""

    ids: list[str] = Field(min_length=1, max_length=1000)


def require_session_idle(state, session_id):
    """活动抓包和重放任务必须先停止，避免删除与写入交错。"""
    if session_id == state.engine.session_id or session_id in state.jobs:
        raise HTTPException(409, "请先停止该会话的抓包或重放任务，再清空或删除")
    if session_id in state.store.current_sessions:
        with state.store.connect(session_id) as db:
            if db.execute("SELECT status FROM session").fetchone()[0] == "running":
                raise HTTPException(409, "会话仍在执行，请先停止后再删除")


@router.post("/api/sessions/{session_id}/flows/delete")
async def delete_flows(session_id: str, options: DeleteFlowOptions, request: Request):
    """记录中也允许删除请求；存储层标记 ID，拒绝迟到事件重新入库。"""
    if options.all == bool(options.ids):
        raise HTTPException(400, "请选择删除指定 ID 或明确清空全部")
    state = workbench(request)
    async with state.config_lock:
        count = await asyncio.to_thread(
            state.store.delete_flows, session_id, None if options.all else options.ids
        )
        state.notify({"type": "sessions"})
        state.notify({"type": "flows", "session_id": session_id})
        return {"deleted": count}


@router.post("/api/sessions/delete")
async def delete_sessions(options: DeleteSessionOptions, request: Request):
    """删除明确选择的已结束会话，整批先检查活动状态再执行。"""
    state = workbench(request)
    async with state.config_lock:
        sessions = {
            session["id"]: session
            for session in await asyncio.to_thread(state.store.sessions)
        }
        ids = list(dict.fromkeys(options.ids))
        for session_id in ids:
            require_session_idle(state, session_id)
            if session_id not in sessions:
                raise HTTPException(404, "会话不存在")
            if (
                session_id in state.store.current_sessions
                and sessions[session_id]["status"] == "running"
            ):
                raise HTTPException(409, "正在执行的会话不能删除")
        for session_id in ids:
            await asyncio.to_thread(state.store.delete_session, session_id, True)
        state.notify({"type": "sessions"})
        return {"deleted": ids}


@router.get("/api/history")
def history(request: Request):
    """历史管理页显式加载归档会话，包含正文和数据库的占用空间。"""
    store = workbench(request).store
    records = []
    for session in store.sessions():
        if session["id"] in store.current_sessions:
            continue
        folder = store.root / session["id"]
        records.append(
            {
                **session,
                "disk_bytes": sum(
                    path.stat().st_size for path in folder.rglob("*") if path.is_file()
                ),
            }
        )
    return records


@router.delete("/api/history/{session_id}")
def delete_history(session_id: str, request: Request):
    """删除指定归档会话，界面要求用户确认且不允许删除本次数据。"""
    try:
        workbench(request).store.delete_session(session_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"deleted": session_id}


@router.get("/api/history/{session_id}/download")
def download_history(session_id: str, request: Request):
    """下载 SQLite 一致性快照和正文文件，原始历史数据库不做 checkpoint。"""
    store = workbench(request).store
    if session_id in store.current_sessions:
        raise HTTPException(400, "请在下一次启动后下载归档会话")
    with tempfile.NamedTemporaryFile(
        prefix="capture-archive-", suffix=".zip", delete=False
    ) as temporary:
        path = Path(temporary.name)
    try:
        with tempfile.TemporaryDirectory(prefix="capture-snapshot-") as folder:
            snapshot = Path(folder) / "capture.sqlite"
            with (
                store.connect(session_id) as source,
                closing(sqlite3.connect(snapshot)) as target,
            ):
                source.backup(target)
            root = store.root / session_id
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.write(snapshot, f"{session_id}/capture.sqlite")
                for file in root.rglob("*"):
                    if file.is_file() and file.name not in (
                        "capture.sqlite",
                        "capture.sqlite-wal",
                        "capture.sqlite-shm",
                    ):
                        archive.write(file, f"{session_id}/{file.relative_to(root)}")
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return FileResponse(
        path,
        filename=f"{session_id}.zip",
        background=BackgroundTask(path.unlink, missing_ok=True),
    )


@router.get("/api/sessions/{session_id}/directories")
def directories(session_id: str, request: Request):
    """抓包与重放共用域名路径目录摘要，不读取正文。"""
    return workbench(request).store.directories(session_id)


@router.get("/api/sessions/{session_id}/flows")
def flows(
    session_id: str,
    request: Request,
    filters: Annotated[FlowFilters, Query()],
):
    """组合筛选分页摘要，支持 URL/Header 关键词、域名、方法、状态等。"""
    return workbench(request).store.list_flows(session_id, filters=filters)


@router.get("/api/sessions/{session_id}/flows/{flow_id}")
def flow_detail(
    session_id: str,
    flow_id: str,
    request: Request,
    preview: bool = False,
    text_only: bool = False,
):
    """完整查看使用 text_only 减少重复编码；默认保留原始字节供编辑和重放。"""
    return workbench(request).store.get_flow(
        session_id, flow_id, preview=preview, include_raw=not text_only
    )


@router.get("/api/sessions/{session_id}/flows/{flow_id}/body/{part}")
def download_body(
    session_id: str,
    flow_id: str,
    part: Literal["request", "response", "original_request"],
    request: Request,
):
    """流式下载已保存原始正文，不把大文件装入接口响应内存。"""
    store = workbench(request).store
    with store.lock, store.connect(session_id) as db:
        row = db.execute("SELECT detail FROM flows WHERE id=?", (flow_id,)).fetchone()
        if not row:
            raise HTTPException(404, "请求不存在")
        message = json.loads(row[0]).get(part) or {}
        filename = message.get("body_file")
        if not filename or Path(filename).name != filename:
            raise HTTPException(404, "没有已保存的正文文件")
        path = store.root / session_id / "bodies" / filename
        if not path.is_file():
            raise HTTPException(404, "正文文件不存在")
    # 固定读取当前文件长度，SSE 继续追加时不能超过本次 Content-Length。
    size = path.stat().st_size

    def chunks():
        with path.open("rb") as source:
            remaining = size
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        chunks(),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(size),
            "Content-Disposition": f'attachment; filename="{part}-body.bin"',
            "X-Capture-Body-State": message.get("body_state", "unknown"),
        },
    )


@router.get("/api/sessions/{session_id}/flows/{flow_id}/websocket")
def websocket_messages(
    session_id: str,
    flow_id: str,
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=100),
):
    """WebSocket 重组消息分页，旧 HTTP 记录返回空列表。"""
    return workbench(request).store.websocket_messages(
        session_id, flow_id, page, page_size
    )
