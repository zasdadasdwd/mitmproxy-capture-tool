"""真实本机服务验证重放记录和实际发送的报文一致。"""

import asyncio
import base64
import copy
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

from capture.backend.replay import ReplayOptions, replay_batch
from config import Settings


def test_replay_records_actual_headers_and_protocol():
    """重放重算 Host 和长度，重复头保留；原 HTTP/2 快照不能冒充当前协议。"""
    received = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.update(
                version=self.request_version,
                host=self.headers["Host"],
                length=self.headers["Content-Length"],
                repeated=self.headers.get_all("X-Test"),
            )
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    records = []
    store = SimpleNamespace(
        save_flow=lambda _, flow: records.append(copy.deepcopy(flow)),
        finish=lambda _: None,
    )
    request = {
        "url": f"http://127.0.0.1:{server.server_port}/test",
        "method": "POST",
        "http_version": "HTTP/2.0",
        "headers": [
            ("Host", "old.example"),
            ("Content-Length", "999"),
            ("X-Test", "one"),
            ("X-Test", "two"),
        ],
        "body_b64": base64.b64encode(b"payload").decode(),
    }
    try:
        asyncio.run(
            replay_batch(
                store,
                "replay",
                [("original", request)],
                Settings().model_dump(),
                lambda _: None,
                ReplayOptions(ids=["original"]),
                True,
            )
        )
        result = records[-1]
        assert result["status"] == "complete"
        assert received["version"] == result["request"]["http_version"] == "HTTP/1.1"
        headers = dict(result["request"]["headers"])
        assert headers["host"] == received["host"] == f"127.0.0.1:{server.server_port}"
        assert headers["content-length"] == received["length"] == "7"
        assert received["repeated"] == ["one", "two"]
        assert result["original_request"] == request
        assert result["replay_transport"]["http_version_changed"] is True
        assert result["replay_transport"]["tls_fingerprint_preserved"] is False
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
