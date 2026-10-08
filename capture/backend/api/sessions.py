"""抓包会话、请求列表和历史归档接口。"""

import asyncio
import heapq
import json
import sqlite3
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from capture.backend.context import workbench
from capture.backend.filters import FlowFilters, build_conditions

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


@router.get("/api/replays/flows")
def replay_flows(
    request: Request,
    filters: Annotated[FlowFilters, Depends()],
    anchor_session: str = "",
    anchor_id: str = "",
    source_session: str = "",
    source_id: str = "",
):
    """聚合本次启动产生的重放摘要，并按全局排序分页与定位。"""
    store = workbench(request).store
    replay_sessions = [
        item["id"]
        for item in store.sessions(current_only=True)
        if item["kind"] == "replay"
    ]
    # 每个批次只缓存一页；深页通过逐页拉取而不是为每批加载 offset+limit 行。
    if filters.offset > 100_000:
        raise HTTPException(422, "offset 最大为 100000")
    needed = filters.offset + filters.limit
    page_size = 500
    buffers, positions, totals, page_numbers = {}, {}, {}, {}
    heap = []
    for session_id in replay_sessions:
        page = FlowFilters.model_validate(
            {**filters.model_dump(), "offset": 0, "limit": page_size}
        )
        result = store.list_flows(session_id, filters=page, include_origin=True)
        totals[session_id] = result["total"]
        buffers[session_id] = result["items"]
        positions[session_id] = 0
        page_numbers[session_id] = page_size
        if buffers[session_id]:
            row = dict(buffers[session_id][0], session_id=session_id)
            heapq.heappush(heap, (_aggregate_sort_key(row, filters), session_id, row))
    total = sum(totals.values())
    selected = []
    for index in range(needed):
        if not heap:
            break
        _, session_id, row = heapq.heappop(heap)
        if index >= filters.offset:
            selected.append(row)
        positions[session_id] += 1
        if (
            positions[session_id] >= len(buffers[session_id])
            and page_numbers[session_id] < totals[session_id]
        ):
            start = page_numbers[session_id]
            page = FlowFilters.model_validate(
                {**filters.model_dump(), "offset": start, "limit": page_size}
            )
            next_page = store.list_flows(session_id, filters=page, include_origin=True)
            buffers[session_id] = next_page["items"]
            positions[session_id] = 0
            page_numbers[session_id] += len(buffers[session_id])
        if positions[session_id] < len(buffers[session_id]):
            next_row = dict(
                buffers[session_id][positions[session_id]], session_id=session_id
            )
            heapq.heappush(
                heap, (_aggregate_sort_key(next_row, filters), session_id, next_row)
            )
    items = selected
    anchor = None
    if anchor_session and anchor_id:
        anchor = _locate_replay_row(
            store, replay_sessions, filters, anchor_session, anchor_id
        )
    elif source_session and source_id:
        anchor = _locate_replay_source(
            store, replay_sessions, filters, source_session, source_id
        )
    elif anchor_session and anchor_session in replay_sessions:
        latest_filters = FlowFilters.model_validate(
            {
                **filters.model_dump(),
                "sort_by": "started",
                "sort_order": "none",
                "offset": 0,
                "limit": 1,
            }
        )
        latest = store.list_flows(anchor_session, filters=latest_filters)["items"]
        anchor = dict(latest[0], session_id=anchor_session) if latest else None
    anchor_offset = None
    if anchor:
        # Count matching rows before the anchor in each batch with SQLite; no result set is materialized.
        anchor_offset = _count_before(store, replay_sessions, filters, anchor)
    return {
        "items": items,
        "total": total,
        "anchor_offset": anchor_offset,
        "anchor_id": anchor["id"] if anchor else None,
        "anchor_session_id": anchor["session_id"] if anchor else None,
    }


def _locate_replay_row(store, sessions, filters, session_id, flow_id):
    """按明确的重放会话和请求 ID 查找通过筛选的摘要。"""
    if session_id not in sessions:
        return None
    with store.query_connection(session_id, filters.needs_body_search()) as db:
        db.row_factory = sqlite3.Row
        where, params = build_conditions(filters)
        clause = f"{where} AND id=?" if where else "WHERE id=?"
        row = db.execute(
            f"SELECT id,host,url,method,status,code,started,duration,size,source,json_extract(detail,'$.original_flow_id') AS original_flow_id,json_extract(detail,'$.original_session_id') AS original_session_id FROM flows {clause}",
            [*params, flow_id],
        ).fetchone()
    return dict(row, session_id=session_id) if row else None


def _aggregate_sort_key(row, filters):
    """构造与单批 SQLite 顺序一致的全局归并键。"""
    if filters.sort_order == "none":
        return (
            row.get("started") is None,
            -(row.get("started") or 0),
            row["session_id"],
            row["id"],
        )
    column = "size" if filters.sort_by == "size" else "started"
    value = row.get(column)
    direction = -1 if filters.sort_order == "desc" else 1
    return (
        value is None,
        (value or 0) * direction,
        row.get("started") is None,
        -(row.get("started") or 0),
        row["session_id"],
        row["id"],
    )


def _locate_replay_source(store, sessions, filters, source_session, source_id):
    """定位来源请求对应的最新重放；来源仅用于定位，不参与列表筛选。"""
    matches = []
    for session_id in sessions:
        with store.query_connection(session_id, filters.needs_body_search()) as db:
            db.row_factory = sqlite3.Row
            where, params = build_conditions(filters)
            predicate = "json_extract(detail,'$.original_session_id')=? AND json_extract(detail,'$.original_flow_id')=?"
            clause = f"{where} AND {predicate}" if where else f"WHERE {predicate}"
            row = db.execute(
                f"SELECT id,host,url,method,status,code,started,duration,size,source,json_extract(detail,'$.original_flow_id') AS original_flow_id,json_extract(detail,'$.original_session_id') AS original_session_id FROM flows {clause} ORDER BY started DESC,id LIMIT 1",
                [*params, source_session, source_id],
            ).fetchone()
        if row:
            matches.append(dict(row, session_id=session_id))
    return (
        min(
            matches,
            key=lambda r: (
                r.get("started") is None,
                -(r.get("started") or 0),
                r["session_id"],
                r["id"],
            ),
        )
        if matches
        else None
    )


def _count_before(store, sessions, filters, anchor):
    """用 SQL 计算符合筛选且全局排序在锚点之前的行数。"""
    count = 0
    for session_id in sessions:
        with store.query_connection(session_id, filters.needs_body_search()) as db:
            db.row_factory = sqlite3.Row
            where, params = build_conditions(filters)
            if filters.sort_order == "none":
                before, vals = _started_tie_before(anchor, session_id)
            else:
                col = "size" if filters.sort_by == "size" else "started"
                same_started_before, tie_values = _started_tie_before(
                    anchor, session_id
                )
                if anchor.get(col) is None:
                    before = f"{col} IS NOT NULL OR ({col} IS NULL AND ({same_started_before}))"
                    vals = tie_values
                else:
                    op = "<" if filters.sort_order == "asc" else ">"
                    before = f"{col} IS NOT NULL AND ({col}{op}? OR ({col}=? AND ({same_started_before})))"
                    vals = [anchor.get(col), anchor.get(col), *tie_values]
            clause = f"{where} AND ({before})" if where else f"WHERE ({before})"
            count += db.execute(
                f"SELECT count(*) FROM flows {clause}", [*params, *vals]
            ).fetchone()[0]
    return count


def _started_tie_before(anchor, session_id):
    """生成 started DESC 后以会话 ID、请求 ID 稳定打破并列的比较。"""
    sql = "(started IS NULL)<(? IS NULL) OR ((started IS NULL)=(? IS NULL) AND (started>? OR (started IS ? AND (?<? OR (?=? AND id<?)))))"
    values = [
        anchor.get("started"),
        anchor.get("started"),
        anchor.get("started"),
        anchor.get("started"),
        session_id,
        anchor["session_id"],
        session_id,
        anchor["session_id"],
        anchor["id"],
    ]
    return sql, values


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
