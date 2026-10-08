"""浏览器风格 cURL 可复制执行，原始正文和重复请求头不能改变。"""

import base64
import http.server
import os
import subprocess
import threading

from capture.backend.export import curl_code


def test_curl_text_and_binary_round_trip():
    received = []

    class Origin(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            received.append(
                (
                    self.path,
                    self.headers.get_all("X-Repeat"),
                    self.rfile.read(int(self.headers.get("Content-Length", "0"))),
                )
            )
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args):
            pass

    origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    try:
        for body in [b"body=%7B%22id%22%3A1%7D&x='$(false)'\n", b"\x00\xff\x01"]:
            url = f"http://127.0.0.1:{origin.server_port}/api?x=%41&x=B"
            command = curl_code(
                {
                    "request": {
                        "method": "POST",
                        "url": url,
                        "headers": [
                            ["X-Repeat", "a"],
                            ["X-Repeat", "b"],
                            ["Accept-Encoding", "gzip"],
                        ],
                        "body_b64": base64.b64encode(body).decode(),
                    }
                }
            )
            if body.startswith(b"body"):
                assert command.startswith("curl '")
                assert "--data-raw" in command
                assert "python3" not in command
                assert "\\\n  -H " in command
            assert "--compressed" in command
            subprocess.run(
                ["/bin/sh", "-c", command],
                check=True,
                capture_output=True,
                timeout=10,
                env={
                    key: value
                    for key, value in os.environ.items()
                    if "proxy" not in key.lower()
                },
            )
            assert received[-1] == ("/api?x=%41&x=B", ["a", "b"], body)
    finally:
        origin.shutdown()
        origin.server_close()


def test_curl_get_and_head_methods():
    def code(method):
        return curl_code(
            {
                "request": {
                    "method": method,
                    "url": "http://example.test/",
                    "headers": [],
                }
            }
        )

    assert code("GET") == "curl 'http://example.test/'"
    assert "--head" in code("HEAD")
