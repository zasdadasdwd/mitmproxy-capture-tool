"""WebSocket 重组消息只读采集，保留顺序、二进制及关闭状态。"""

import base64
from types import SimpleNamespace

from mitmproxy.websocket import WebSocketData, WebSocketMessage

from capture.backend.storage import Store
from capture.engine.websocket_capture import accepted_websocket_event, websocket_event
from config import Settings


def flow():
    return SimpleNamespace(
        id="ws", metadata={"capture_session": "session"}, websocket=WebSocketData()
    )


def test_limits_and_failed_enqueue_do_not_modify_forwarded_content():
    source = flow()
    message = WebSocketMessage(2, True, b"abcdef")
    source.websocket.messages.append(message)
    settings = {"websocket_message_limit": 2, "websocket_body_limit": 3}
    event = websocket_event(source, settings)
    assert base64.b64decode(event["message"]["body_b64"]) == b"abc"
    assert event["message"]["truncated"]
    assert source.websocket.messages[-1].content == b"abcdef"
    assert source.metadata["ws_capture"]["queued"] == 0
    accepted_websocket_event(source, event)
    event = websocket_event(source, settings)
    assert event["message"] is None
    assert event["summary"]["total"] == 2
    source.websocket.close_code = 1000
    source.websocket.close_reason = "normal"
    ended = websocket_event(source, settings, ended=True)
    assert ended["summary"]["close_code"] == 1000
    assert ended["summary"]["total"] == 2


def test_store_order_duplicates_delete_and_stopped_state(tmp_path):
    store = Store(tmp_path)
    session = store.create_session(Settings().model_dump())
    store.save_flow(session, {"id": "ws", "request": None, "response": None})
    source = flow()
    for i in range(105):
        source.websocket.messages.append(
            WebSocketMessage(1, i % 2 == 0, str(i).encode())
        )
        event = websocket_event(source, {})
        accepted_websocket_event(source, event)
        store.save_websocket(session, event)
        store.save_websocket(session, event)  # 同一序号不能重复保存。
    first = store.websocket_messages(session, "ws")
    second = store.websocket_messages(session, "ws", 2)
    assert len(first["items"]) == 100
    assert [m["number"] for m in second["items"]] == [101, 102, 103, 104, 105]
    assert first["summary"]["missing"] == 0
    store.finish(session)
    assert store.websocket_messages(session, "ws")["summary"]["state"] == "interrupted"
    store.delete_flows(session, ["ws"])
    store.save_websocket(session, event)
    with store.connect(session) as db:
        assert db.execute("SELECT count(*) FROM websocket_messages").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM flows").fetchone()[0] == 0


def test_real_proxy_bidirectional_websocket(tmp_path, monkeypatch):
    """本机源服务及真实 mitmdump，验证双向文本/二进制及关闭帧。"""
    import asyncio
    import hashlib
    import http.server
    import os
    import socket
    import threading
    import time

    from capture.engine import manager

    class Origin(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            key = self.headers["Sec-WebSocket-Key"]
            accept = base64.b64encode(
                hashlib.sha1(
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                ).digest()
            ).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            for _ in range(3):
                prefix = self.rfile.read(2)
                opcode = prefix[0] & 15
                length = prefix[1] & 127
                mask = self.rfile.read(4)
                data = self.rfile.read(length)
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
                self.wfile.write(bytes([128 | opcode, len(data)]) + data)
                self.wfile.flush()
            self.close_connection = True

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
        hook_enabled=False,
    )
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(settings.model_dump_json())
    monkeypatch.setattr(manager, "DATA", tmp_path)
    monkeypatch.setattr(manager, "CONFIG_PATH", settings_path)
    store = Store(tmp_path / "captures")

    def client():
        with socket.create_connection(("127.0.0.1", port), timeout=8) as connection:
            connection.sendall(
                (
                    f"GET http://127.0.0.1:{origin.server_port}/ws HTTP/1.1\r\nHost: 127.0.0.1:{origin.server_port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                ).encode()
            )
            reader = connection.makefile("rb")
            headers = bytearray()
            while not headers.endswith(b"\r\n\r\n"):
                headers += reader.read(1)
                assert len(headers) < 16384
            assert b"101" in headers.split(b"\r\n")[0]
            for opcode, payload in [(1, b"hello"), (2, b"\x00\xff"), (8, b"\x03\xe8")]:
                mask = os.urandom(4)
                masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                connection.sendall(
                    bytes([128 | opcode, 128 | len(payload)]) + mask + masked
                )
                prefix = reader.read(2)
                assert prefix[0] & 15 == opcode
                assert reader.read(prefix[1] & 127) == payload
            reader.close()

    async def run():
        engine = manager.EngineManager(store, lambda event: None)
        try:
            await engine.start(settings)
            session = engine.session_id
            await asyncio.to_thread(client)
            deadline = time.monotonic() + 8
            result = {}
            while time.monotonic() < deadline:
                rows = store.list_flows(session)["items"]
                if rows:
                    result = store.websocket_messages(session, rows[0]["id"])
                    if (result.get("summary") or {}).get("state") == "closed":
                        break
                await asyncio.sleep(0.1)
            assert result["summary"]["state"] == "closed"
            assert result["summary"]["close_code"] == 1000
            assert result["total"] == 4
            assert [m["from_client"] for m in result["items"]] == [
                True,
                False,
                True,
                False,
            ]
            assert [base64.b64decode(m["body_b64"]) for m in result["items"]] == [
                b"hello",
                b"hello",
                b"\x00\xff",
                b"\x00\xff",
            ]
        finally:
            await engine.shutdown()

    try:
        asyncio.run(run())
    finally:
        origin.shutdown()
        origin.server_close()


def test_message_count_limit_keeps_observed_sequence():
    source = flow()
    for index in range(3):
        source.websocket.messages.append(WebSocketMessage(1, True, b""))
        event = websocket_event(source, {"websocket_message_limit": 2})
        if index < 2:
            assert event["message"]["number"] == index + 1
            accepted_websocket_event(source, event)
        else:
            assert event["message"] is None
            assert event["summary"]["total"] == 3
    assert source.metadata["ws_capture"]["queued"] == 2


def test_http_replay_rejects_websocket_before_creating_job():
    import asyncio
    import importlib

    import pytest
    from fastapi import HTTPException

    from capture.backend.replay import ReplayOptions

    replay_api = importlib.import_module("capture.backend.api.replay")
    store = SimpleNamespace(get_flow=lambda *args: {"websocket": {"state": "closed"}})
    state = SimpleNamespace(jobs={}, store=store)
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(workbench=state))
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(replay_api.replay("session", ReplayOptions(ids=["ws"]), request))
    assert caught.value.status_code == 400
    assert "WebSocket" in caught.value.detail
    assert state.jobs == {}
