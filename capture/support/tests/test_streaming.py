"""流式正文不改转发字节，限额、磁盘错误与停止状态保持可追溯。"""

import asyncio
import gzip

from capture.backend.storage import Store, decode_body
from capture.engine.streaming import StreamWriter
from config import Settings


def test_stream_complete_limit_and_stop(tmp_path):
    async def run():
        (tmp_path / "session" / "bodies").mkdir(parents=True)
        writer = StreamWriter(tmp_path)
        complete = writer.create("session", 100, True)
        limited = writer.create("session", 3, True)
        for body in (complete, limited):
            assert body.feed(b"abcdef") == b"abcdef"
            body.feed(b"")
        await writer.queue.join()
        assert complete.snapshot()["body_state"] == "complete"
        assert complete.path.read_bytes() == b"abcdef"
        assert limited.snapshot()["body_state"] == "truncated"
        assert limited.path.read_bytes() == b"abc"
        active = writer.create("session", 100, True)
        active.feed(b"partial")
        await writer.stop_session("session")
        assert active.snapshot()["body_state"] == "interrupted"
        assert active.feed(b"still forwarded") == b"still forwarded"
        await writer.shutdown()

    asyncio.run(run())


def test_stream_disk_failure_and_queue_limit(tmp_path):
    async def run():
        writer = StreamWriter(tmp_path, buffer_limit=4)
        overflow = writer.create("missing", 100, True)
        assert overflow.feed(b"12345") == b"12345"
        assert overflow.snapshot()["body_state"] == "write_error"
        broken = writer.create("missing", 100, True)
        broken.feed(b"123")
        broken.finish()
        await writer.queue.join()
        assert broken.snapshot()["body_state"] == "write_error"
        disabled = writer.create("missing", 100, False)
        assert disabled.feed(b"x") == b"x"
        assert disabled.snapshot()["body_state"] == "not_cached"
        await writer.shutdown()

    asyncio.run(run())


def test_store_preserves_appending_body_file(tmp_path):
    store = Store(tmp_path)
    session = store.create_session(Settings().model_dump())
    path = tmp_path / session / "bodies" / "stream.bin"
    path.write_bytes(b"first")
    flow = {
        "id": "stream",
        "url": "http://example.test",
        "host": "example.test",
        "method": "GET",
        "started": 1,
        "status": "receiving",
        "response": {
            "body_file": "stream.bin",
            "headers": [],
            "body_state": "receiving",
        },
    }
    store.save_flow(session, flow)
    with path.open("ab") as target:
        target.write(b" second")
    store.save_flow(session, flow)
    assert path.read_bytes() == b"first second"
    assert store.get_flow(session, "stream")["response"]["body_text"] == "first second"


def test_partial_gzip_events():
    data = b"data: first\n\ndata: second\n\n"
    assert decode_body(gzip.compress(data)[:-8], "gzip", 100, partial=True) == data


def test_real_proxy_streams_large_chunked_and_sse(tmp_path, monkeypatch):
    """真实 mitmdump 转发三种正文，停止记录后网络继续工作。"""
    import http.server
    import socket
    import threading
    import time

    import httpx

    from capture.engine import manager

    payload = b"0123456789" * 1000
    events = b"event: update\ndata: first\n\ndata: second\n\n"

    class Origin(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            data = events if self.path == "/sse" else payload
            self.send_response(200)
            if self.path == "/chunked":
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", str(len(data)))
            if self.path == "/sse":
                self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            if self.path == "/chunked":
                for part in (data[:4000], data[4000:]):
                    self.wfile.write(f"{len(part):x}\r\n".encode() + part + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            else:
                self.wfile.write(data)
            self.wfile.flush()

        def log_message(self, *args):
            pass

    origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    settings = Settings(
        listen_host="127.0.0.1",
        listen_port=port,
        connection_mode="direct",
        body_limit=1024,
        hook_enabled=False,
    )
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(settings.model_dump_json())
    monkeypatch.setattr(manager, "DATA", tmp_path)
    monkeypatch.setattr(manager, "CONFIG_PATH", settings_path)
    store = Store(tmp_path / "captures")

    async def run():
        engine = manager.EngineManager(store, lambda event: None)
        try:
            await engine.start(settings)
            session = engine.session_id
            async with httpx.AsyncClient(
                proxy=f"http://127.0.0.1:{port}", timeout=10
            ) as client:
                for route in ("large", "chunked", "sse"):
                    response = await client.get(
                        f"http://127.0.0.1:{origin.server_port}/{route}"
                    )
                    assert response.content == (events if route == "sse" else payload)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    rows = store.list_flows(session)["items"]
                    if len(rows) == 3 and all(
                        store.get_flow(session, row["id"])
                        .get("response", {})
                        .get("body_state")
                        == "complete"
                        for row in rows
                    ):
                        break
                    await asyncio.sleep(0.1)
                assert len(rows) == 3
                for row in rows:
                    body = store.get_flow(session, row["id"])["response"]
                    assert body["body_state"] == "complete"
                    assert body["body_text"].encode() == (
                        events if row["url"].endswith("/sse") else payload
                    )
                await engine.stop()
                assert (
                    await client.get(f"http://127.0.0.1:{origin.server_port}/large")
                ).content == payload
        finally:
            await engine.shutdown()

    try:
        asyncio.run(run())
    finally:
        origin.shutdown()
        origin.server_close()


def test_download_freezes_current_length(tmp_path):
    """SSE 在下载开始后追加，下载内容不能超过声明的长度。"""
    from types import SimpleNamespace

    from capture.backend.api.sessions import download_body

    store = Store(tmp_path)
    session = store.create_session(Settings().model_dump())
    path = tmp_path / session / "bodies" / "live.bin"
    path.write_bytes(b"first")
    store.save_flow(
        session,
        {
            "id": "live",
            "response": {
                "headers": [],
                "body_file": "live.bin",
                "body_state": "receiving",
            },
        },
    )
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(workbench=SimpleNamespace(store=store))
        )
    )
    response = download_body(session, "live", "response", request)
    with path.open("ab") as target:
        target.write(b" later")

    async def read():
        return b"".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(read()) == b"first"
    assert response.headers["content-length"] == "5"
    assert response.headers["x-capture-body-state"] == "receiving"
