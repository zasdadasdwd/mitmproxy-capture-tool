"""每次抓包一个 SQLite；正文保存在同目录下，所有写入串行处理。"""

import base64
import json
import shutil
import sqlite3
import threading
import zlib
from collections import Counter, OrderedDict
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4
from zoneinfo import ZoneInfo

import brotli
import zstandard

from capture.backend.filters import FlowFilters, build_conditions


class Store:
    """管理会话目录、SQLite 元数据和正文文件；线程锁保护读写一致性。"""

    def __init__(self, root: Path):
        """创建存储目录；本次启动只登记新会话，不打开或修改历史数据库。"""
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.connections = OrderedDict()
        self.session_cache = {}
        self.directory_cache = {}
        self.current_sessions = set()

    @staticmethod
    def ensure_indexes(db):
        """为常用组合条件和稳定分页建索引，兼容已经保存的旧会话。"""
        db.execute("CREATE INDEX IF NOT EXISTS flows_order ON flows(started DESC, id)")
        db.execute(
            "CREATE INDEX IF NOT EXISTS flows_method_code ON flows(method, code)"
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS flows_status_source ON flows(status, source)"
        )

    def close(self):
        """管理服务退出时关闭有界连接缓存，释放 SQLite 文件句柄。"""
        with self.lock:
            for connection in self.connections.values():
                connection.close()
            self.connections.clear()
            self.session_cache.clear()
            self.directory_cache.clear()

    def create_session(self, settings: dict, kind="capture") -> str:
        """以北京时间和短 ID 创建会话，返回目录名形式的会话 ID。"""
        local = datetime.now(ZoneInfo("Asia/Shanghai"))
        session_id = local.strftime("%Y-%m-%d_%H-%M-%S") + "_" + uuid4().hex[:6]
        folder = self.root / session_id
        folder.mkdir()
        (folder / "bodies").mkdir()
        with self.connect(session_id) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE session (id TEXT PRIMARY KEY, started TEXT, ended TEXT,
                    timezone TEXT, status TEXT, kind TEXT, schema_version INTEGER);
                CREATE TABLE policies (version INTEGER PRIMARY KEY, settings TEXT);
                CREATE TABLE flows (id TEXT PRIMARY KEY, host TEXT, url TEXT, method TEXT,
                    status TEXT, code INTEGER, started REAL, duration REAL, size INTEGER,
                    source TEXT, detail TEXT);
                CREATE INDEX flows_started ON flows(started);
                CREATE INDEX flows_host ON flows(host);
            """)
            db.execute(
                "INSERT INTO session VALUES (?, ?, NULL, ?, 'running', ?, 1)",
                (
                    session_id,
                    datetime.now(timezone.utc).isoformat(),
                    str(local.tzinfo),
                    kind,
                ),
            )
            db.execute(
                "INSERT INTO policies VALUES (?, ?)",
                (settings["version"], json.dumps(settings)),
            )
            self.ensure_indexes(db)
        with self.lock:
            self.current_sessions.add(session_id)
        return session_id

    @contextmanager
    def connect(self, session_id: str):
        """复用最多 8 个连接，持锁使用以保证跨线程安全，退出时提交或回滚。"""
        folder = (self.root / session_id).resolve()
        if not session_id or folder.parent != self.root or not folder.is_dir():
            raise FileNotFoundError(session_id)
        with self.lock:
            connection = self.connections.pop(session_id, None)
            if connection is None:
                connection = sqlite3.connect(
                    folder / "capture.sqlite", timeout=10, check_same_thread=False
                )
            self.connections[session_id] = connection
            while len(self.connections) > 8:
                old_session, old_connection = self.connections.popitem(last=False)
                old_connection.close()
                self.directory_cache.pop(old_session, None)
            with connection:
                yield connection

    def finish(self, session_id: str, status="stopped"):
        """结束会话，将未完成请求标记为中断，并归并 WAL。"""
        with self.lock, self.connect(session_id) as db:
            db.execute(
                "UPDATE session SET status=?, ended=?",
                (status, datetime.now(timezone.utc).isoformat()),
            )
            db.execute(
                "UPDATE flows SET status='interrupted' WHERE status IN ('pending', 'receiving')"
            )
        with self.connect(session_id) as db:
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.session_cache.pop(session_id, None)

    def record_policy(self, session_id: str, settings: dict):
        """保存配置版本快照，便于解释历史连接的策略判断。"""
        with self.lock, self.connect(session_id) as db:
            db.execute(
                "INSERT OR IGNORE INTO policies VALUES (?, ?)",
                (settings["version"], json.dumps(settings)),
            )

    def save_flow(self, session_id: str, flow: dict):
        """合并请求生命周期事件，正文落盘后保存引用，清理被替换的旧正文。"""
        with self.lock:
            # 删除标记跨重启保留，迟到的响应/流式事件不能复活请求。
            with self.connect(session_id) as db:
                deleted = (
                    db.execute(
                        "SELECT 1 FROM sqlite_master WHERE name='deleted_flows'"
                    ).fetchone()
                    and db.execute(
                        "SELECT 1 FROM deleted_flows WHERE id=?", (flow["id"],)
                    ).fetchone()
                )
            if deleted:
                for name in ("original_request", "request", "response"):
                    filename = (flow.get(name) or {}).get("body_file")
                    if filename and Path(filename).name == filename:
                        (self.root / session_id / "bodies" / filename).unlink(
                            missing_ok=True
                        )
                return
            # 只复制被修改的字典，避免大 Base64 正文经历一次 JSON 往返。
            flow = dict(flow)
            for name in ("original_request", "request", "response"):
                message = flow.get(name)
                if message and "body_b64" in message:
                    message = dict(message)
                    flow[name] = message
                    content = base64.b64decode(message.pop("body_b64"))
                    if content:
                        filename = uuid4().hex + ".bin"
                        (self.root / session_id / "bodies" / filename).write_bytes(
                            content
                        )
                        message["body_file"] = filename
                    else:
                        message.pop("body_file", None)
                        message["body_b64"] = ""
                        message["body_text"] = ""
            with self.connect(session_id) as db:
                previous = db.execute(
                    "SELECT detail FROM flows WHERE id=?", (flow["id"],)
                ).fetchone()
                if previous:
                    detail = json.loads(previous[0])
                    old_directory = self.directory_key(
                        detail.get("host", ""), detail.get("url", "")
                    )
                    old_files = [
                        (detail.get(k) or {}).get("body_file")
                        for k in flow
                        if k in ("request", "response", "original_request")
                    ]
                    detail.update(flow)
                else:
                    detail, old_files = flow, []
                    old_directory = None
                db.execute(
                    "INSERT OR REPLACE INTO flows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        detail["id"],
                        detail.get("host", ""),
                        detail.get("url", ""),
                        detail.get("method", ""),
                        detail.get("status", "pending"),
                        detail.get("code"),
                        detail.get("started", 0),
                        detail.get("duration"),
                        detail.get("size", 0),
                        detail.get("source", "capture"),
                        json.dumps(detail),
                    ),
                )
            cached = self.directory_cache.get(session_id)
            new_directory = self.directory_key(
                detail.get("host", ""), detail.get("url", "")
            )
            if cached is not None and old_directory != new_directory:
                if old_directory:
                    cached[old_directory] -= 1
                    if cached[old_directory] <= 0:
                        del cached[old_directory]
                if new_directory:
                    cached[new_directory] += 1
            current_files = {
                (detail.get(part) or {}).get("body_file")
                for part in ("request", "original_request", "response")
            }
            for filename in old_files:
                if filename and filename not in current_files:
                    (self.root / session_id / "bodies" / filename).unlink(
                        missing_ok=True
                    )
            self.session_cache.pop(session_id, None)

    def sessions(self, current_only=False):
        """按启动时间倒序返回摘要，可限定为本次服务启动创建的会话。"""
        result = []
        with self.lock:
            paths = (
                [
                    self.root / session_id / "capture.sqlite"
                    for session_id in self.current_sessions
                ]
                if current_only
                else list(self.root.glob("*/capture.sqlite"))
            )
        for path in sorted(paths, reverse=True):
            with self.lock:
                wal = path.with_name("capture.sqlite-wal")
                stamp = (
                    path.stat().st_mtime_ns,
                    wal.stat().st_mtime_ns if wal.exists() else 0,
                )
                cached = self.session_cache.get(path.parent.name)
                if cached and cached[0] == stamp:
                    result.append(dict(cached[1]))
                    continue
                with self.connect(path.parent.name) as db:
                    db.row_factory = sqlite3.Row
                    session = dict(db.execute("SELECT * FROM session").fetchone())
                    session["count"] = db.execute(
                        "SELECT count(*) FROM flows"
                    ).fetchone()[0]
                    result.append(session)
                    self.session_cache[path.parent.name] = (stamp, dict(session))
        return result

    def list_flows(
        self,
        session_id: str,
        search="",
        offset=0,
        limit=200,
        filters: FlowFilters | None = None,
    ):
        """按组合条件分页查询；保留旧 search 参数供现有调用继续使用。"""
        filters = filters or FlowFilters(search=search, offset=offset, limit=limit)
        with self.query_connection(session_id, filters.needs_body_search()) as db:
            db.row_factory = sqlite3.Row
            where, parameters = build_conditions(filters)
            count = db.execute(
                f"SELECT count(*) FROM flows {where}", parameters
            ).fetchone()[0]
            # 模型限定字段和方向；缺失大小排最后，同值用时间和 ID 稳定分页。
            order = "ASC" if filters.sort_order == "asc" else "DESC"
            column = "size" if filters.sort_by == "size" else "started"
            ordering = (
                "started DESC, id"
                if filters.sort_order == "none"
                else f"{column} IS NULL, {column} {order}, started DESC, id"
            )
            rows = db.execute(
                f"SELECT id, host, url, method, status, code, started, duration, size, source FROM flows {where} ORDER BY {ordering} LIMIT ? OFFSET ?",
                [*parameters, filters.limit, filters.offset],
            ).fetchall()
            return {"items": [dict(row) for row in rows], "total": count}

    @contextmanager
    def query_connection(self, session_id, search_bodies=False):
        """正文查询使用独立只读快照，文件读取和解压不持有采集写入锁。"""
        if not search_bodies:
            with self.connect(session_id) as db:
                yield db
            return
        folder = (self.root / session_id).resolve()
        if not session_id or folder.parent != self.root or not folder.is_dir():
            raise FileNotFoundError(session_id)
        db = sqlite3.connect(
            (folder / "capture.sqlite").as_uri() + "?mode=ro", uri=True
        )
        # 仅缓存本次查询的判断结果，不缓存大正文；计数与分页共用缓存和快照。
        matcher = lru_cache(maxsize=256)(
            lambda message, term: self.body_contains(folder, message, term)
        )
        db.create_function("body_contains", 2, matcher)
        try:
            db.execute("BEGIN")
            yield db
        finally:
            db.close()

    @staticmethod
    def body_contains(folder, source, keyword):
        """搜索解压后的已保存正文；缺失或不完整的未命中正文返回未知，避免误判不包含。"""
        if not source:
            return None
        message = json.loads(source)
        limit = 16 * 1024 * 1024
        incomplete = message.get("truncated", False)
        try:
            if message.get("body_file"):
                body_folder = (folder / "bodies").resolve()
                path = (body_folder / message["body_file"]).resolve()
                if path.parent != body_folder:
                    return None
                with path.open("rb") as stream:
                    content = stream.read(limit + 1)
                encoding = next(
                    (
                        v
                        for k, v in message.get("headers", [])
                        if k.lower() == "content-encoding"
                    ),
                    "identity",
                )
                decoded = decode_body(content, encoding, limit)
                incomplete = incomplete or len(content) > limit or len(decoded) > limit
                text = decoded[:limit].decode("utf-8", errors="replace")
            elif "body_text" in message:
                text = message["body_text"][:limit]
                incomplete = incomplete or len(message["body_text"]) > limit
            elif "body_b64" in message:
                content = base64.b64decode(message["body_b64"], validate=True)
                text = content[:limit].decode("utf-8", errors="replace")
                incomplete = incomplete or len(content) > limit
            else:
                return None
        except (
            ValueError,
            TypeError,
            EOFError,
            OSError,
            zlib.error,
            brotli.error,
            zstandard.ZstdError,
        ):
            return None
        if keyword.lower() in text.lower():
            return True
        return None if incomplete else False

    def get_summary(self, session_id: str, flow_id: str):
        """只读取摘要；CSV 导出无需读取或解压正文文件。"""
        with self.lock, self.connect(session_id) as db:
            db.row_factory = sqlite3.Row
            row = db.execute(
                "SELECT id, method, url, status, code, duration, size, source FROM flows WHERE id=?",
                (flow_id,),
            ).fetchone()
            if not row:
                raise FileNotFoundError(flow_id)
            return dict(row)

    @staticmethod
    def directory_key(host, url):
        """把 URL 归并成域名和路径，不让查询参数生成重复目录。"""
        try:
            parsed = urlsplit(url)
        except ValueError:
            return None
        if parsed.scheme not in ("http", "https"):
            return None
        return host, parsed.path or "/"

    def directories(self, session_id: str):
        """首次查询建立目录计数，后续保存增量更新；缓存随连接淘汰。"""
        with self.lock, self.connect(session_id) as db:
            counts = self.directory_cache.get(session_id)
            if counts is None:
                counts = Counter()
                for host, url, count in db.execute(
                    "SELECT host, url, count(*) FROM flows GROUP BY host, url"
                ):
                    key = self.directory_key(host, url)
                    if key:
                        counts[key] += count
                self.directory_cache[session_id] = counts
            return [
                {"host": host, "path": path, "count": count}
                for (host, path), count in sorted(counts.items())
            ]

    def delete_session(self, session_id: str, allow_current=False):
        """删除已结束的历史会话及正文；本次启动会话禁止在管理页删除。"""
        with self.lock:
            if session_id in self.current_sessions and not allow_current:
                raise ValueError("本次启动的会话不能删除，请结束本次程序后再管理")
            with self.connect(session_id) as db:
                if (
                    session_id in self.current_sessions
                    and db.execute("SELECT status FROM session").fetchone()[0]
                    == "running"
                ):
                    raise ValueError("正在执行的会话不能删除，请先停止")
                folder = self.root / session_id
            self.connections.pop(session_id).close()
            self.session_cache.pop(session_id, None)
            self.directory_cache.pop(session_id, None)
            shutil.rmtree(folder)
            self.current_sessions.discard(session_id)

    def delete_flows(self, session_id: str, ids: list[str] | None = None):
        """删除指定请求或当前已入库记录；迟到事件由持久 ID 标记拦截。"""
        files = set()
        count = 0
        with self.lock:
            with self.connect(session_id) as db:
                where = (
                    ""
                    if ids is None
                    else " WHERE id IN (" + ",".join("?" for _ in ids) + ")"
                )
                db.execute(
                    "CREATE TABLE IF NOT EXISTS deleted_flows (id TEXT PRIMARY KEY)"
                )
                # 新请求继续保存；指定尚未入库的 ID 也阻止排队事件复活。
                if ids is None:
                    db.execute(
                        "INSERT OR IGNORE INTO deleted_flows SELECT id FROM flows"
                    )
                else:
                    db.executemany(
                        "INSERT OR IGNORE INTO deleted_flows VALUES (?)",
                        ((item,) for item in ids),
                    )
                # 逐行读取，清空大批次时不把全部详情同时装入内存。
                for (serialized,) in db.execute(
                    "SELECT detail FROM flows" + where, ids or []
                ):
                    count += 1
                    detail = json.loads(serialized)
                    for name in ("request", "original_request", "response"):
                        filename = (detail.get(name) or {}).get("body_file")
                        if filename and Path(filename).name == filename:
                            files.add(filename)
                if db.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='websocket_messages'"
                ).fetchone():
                    db.execute(
                        "DELETE FROM websocket_messages WHERE flow_id IN (SELECT id FROM flows"
                        + where
                        + ")",
                        ids or [],
                    )
                db.execute("DELETE FROM flows" + where, ids or [])
            self.session_cache.pop(session_id, None)
            self.directory_cache.pop(session_id, None)
        # 文件名由 UUID 生成；提交后清理旧文件不占用采集/列表共用的锁。
        for filename in files:
            (self.root / session_id / "bodies" / filename).unlink(missing_ok=True)
        return count

    def save_websocket(self, session_id, event):
        """消息增量写独立表；HTTP 握手详情只保存摘要，不塞入整条消息列表。"""
        with self.lock, self.connect(session_id) as db:
            row = db.execute(
                "SELECT detail FROM flows WHERE id=?", (event["flow_id"],)
            ).fetchone()
            if not row:
                return  # 已删除的请求不能被长连接消息重新创建。
            db.execute("""CREATE TABLE IF NOT EXISTS websocket_messages (
                flow_id TEXT, number INTEGER, message TEXT,
                PRIMARY KEY(flow_id, number))""")
            message = event.get("message")
            if message:
                db.execute(
                    "INSERT OR IGNORE INTO websocket_messages VALUES (?, ?, ?)",
                    (event["flow_id"], message["number"], json.dumps(message)),
                )
            count = db.execute(
                "SELECT count(*) FROM websocket_messages WHERE flow_id=?",
                (event["flow_id"],),
            ).fetchone()[0]
            detail = json.loads(row[0])
            detail["websocket"] = dict(
                event["summary"],
                saved=count,
                missing=max(0, event["summary"]["total"] - count),
            )
            db.execute(
                "UPDATE flows SET detail=? WHERE id=?",
                (json.dumps(detail), event["flow_id"]),
            )

    def websocket_messages(self, session_id, flow_id, page=1, page_size=100):
        """分页读取消息，关闭或停止状态与正文截断分开呈现。"""
        with self.lock, self.connect(session_id) as db:
            row = db.execute(
                "SELECT detail FROM flows WHERE id=?", (flow_id,)
            ).fetchone()
            if not row:
                raise FileNotFoundError(flow_id)
            summary = json.loads(row[0]).get("websocket")
            if not summary:
                return {"summary": None, "items": [], "total": 0, "page": page}
            summary = dict(summary)
            session_status = db.execute("SELECT status FROM session").fetchone()[0]
            if session_status != "running" and summary["state"] == "open":
                summary["state"] = "interrupted"
            rows = db.execute(
                "SELECT message FROM websocket_messages WHERE flow_id=? ORDER BY number LIMIT ? OFFSET ?",
                (flow_id, page_size, (page - 1) * page_size),
            ).fetchall()
        return {
            "summary": summary,
            "items": [json.loads(r[0]) for r in rows],
            "total": summary["saved"],
            "page": page,
        }

    def get_flow(self, session_id: str, flow_id: str, preview=False, include_raw=True):
        """预览限制 64 KiB；展示可省略 Base64，导出和重放默认保留原始字节。"""
        contents = {}
        with self.lock, self.connect(session_id) as db:
            row = db.execute(
                "SELECT detail, status FROM flows WHERE id=?", (flow_id,)
            ).fetchone()
            if not row:
                raise FileNotFoundError(flow_id)
            detail = json.loads(row[0])
            detail["status"] = row[1]
        for name in ("original_request", "request", "response"):
            message = detail.get(name)
            if message and message.get("body_file"):
                path = self.root / session_id / "bodies" / message["body_file"]
                encoding = next(
                    (
                        value.lower()
                        for key, value in message.get("headers", [])
                        if key.lower() == "content-encoding"
                    ),
                    "identity",
                )
                # 未压缩预览只读上限加一个字节，以保留截断判断。
                with path.open("rb") as stream:
                    read_limit = (
                        64 * 1024
                        if preview and encoding in ("identity", "")
                        else 16 * 1024 * 1024
                    )
                    contents[name] = stream.read(read_limit + 1)
                    if len(contents[name]) > read_limit:
                        message["display_truncated"] = True
                        if include_raw and not preview:
                            message["raw_truncated"] = True
                            message["truncated"] = True
                        contents[name] = contents[name][:read_limit]
        # 解码在锁外进行，查看大响应不会长时间阻塞采集写入。
        limit = 64 * 1024 if preview else 16 * 1024 * 1024
        for name, content in contents.items():
            message = detail[name]
            if not preview and include_raw:
                message["body_b64"] = base64.b64encode(content).decode()
            content_encoding = next(
                (
                    v
                    for k, v in message.get("headers", [])
                    if k.lower() == "content-encoding"
                ),
                "identity",
            )
            try:
                decoded = decode_body(
                    content,
                    content_encoding,
                    limit,
                    partial=bool(message.get("display_truncated"))
                    or (
                        message.get("streaming", False)
                        and message.get("body_state") != "complete"
                    ),
                )
                if len(decoded) > limit:
                    message["display_truncated"] = True
                    decoded = decoded[:limit]
                if not preview and include_raw:
                    message["decoded_b64"] = base64.b64encode(decoded).decode()
                message["body_text"] = decoded.decode("utf-8", errors="replace")
            except (
                ValueError,
                TypeError,
                EOFError,
                OSError,
                zlib.error,
                brotli.error,
                zstandard.ZstdError,
            ):
                message["body_text"] = content[:limit].decode("utf-8", errors="replace")
                message["decode_error"] = True
                message["display_truncated"] = len(content) > limit
        return detail


def decode_body(
    content: bytes, content_encoding: str, limit: int, partial=False
) -> bytes:
    """有界解码常见压缩格式，避免小型压缩正文展开成巨大的展示内容。"""
    import gzip
    import io
    import zlib

    if content_encoding.lower() in ("identity", ""):
        return content[: limit + 1]
    if content_encoding.lower() == "gzip":
        if partial:
            return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(
                content, limit + 1
            )
        with gzip.GzipFile(fileobj=io.BytesIO(content)) as stream:
            return stream.read(limit + 1)
    if content_encoding.lower() == "deflate":
        try:
            return zlib.decompressobj().decompress(content, limit + 1)
        except zlib.error:
            return zlib.decompressobj(-zlib.MAX_WBITS).decompress(content, limit + 1)
    if content_encoding.lower() == "br":
        decoder = brotli.Decompressor()
        return decoder.process(content, output_buffer_limit=limit + 1)[: limit + 1]
    if content_encoding.lower() == "zstd":
        import zstandard

        with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(content)) as stream:
            return stream.read(limit + 1)
    from mitmproxy.net import encoding

    return encoding.decode(content, content_encoding)[: limit + 1]
