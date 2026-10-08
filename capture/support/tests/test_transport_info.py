"""验证连接信息忠实记录握手结果，而不是配置或 offered 协议。"""

import importlib.util
import json

from mitmproxy import http
from mitmproxy.test import tflow

from capture.engine.transport import connection_snapshot
from config import ROOT, Settings


def test_offered_protocol_does_not_become_negotiated_protocol():
    """握手尚未完成时即使提供 h2，也不能记录已经协商 HTTP/2。"""
    server = tflow.tserver_conn()
    server.alpn = None
    server.alpn_offers = [b"h2", b"http/1.1"]
    server.tls = True
    server.timestamp_tls_setup = None
    detail = connection_snapshot(server)
    assert detail["alpn"] is None
    assert detail["http_version"] is None
    assert detail["alpn_offers"] == ["h2", "http/1.1"]
    assert detail["tls_established"] is False
    assert detail["tls_handshake_ms"] is None


def test_negotiated_protocol_and_connection_timings():
    """保留稳定连接标识及已测得的上游 TCP/TLS 时长。"""
    server = tflow.tserver_conn()
    server.alpn = b"h2"
    server.timestamp_start = 10.0
    server.timestamp_tcp_setup = 10.125
    server.timestamp_tls_setup = 10.375
    detail = connection_snapshot(server)
    assert detail["http_version"] == "HTTP/2.0"
    assert detail["id"] == server.id
    assert detail["tcp_connect_ms"] == 125
    assert detail["tls_handshake_ms"] == 250
    server.timestamp_tcp_setup = 9
    assert connection_snapshot(server)["tcp_connect_ms"] is None


def test_addon_updates_both_connections_without_changing_request(tmp_path, monkeypatch):
    """真实 addon 的响应阶段补齐上游握手；客户端协议不被 Hook 后版本替代。"""
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps(Settings().model_dump()))
    monkeypatch.setenv("CAPTURE_SETTINGS", str(settings))
    monkeypatch.setenv("CAPTURE_SESSION", "test-session")
    monkeypatch.setenv("CAPTURE_HOOK_MODULES", "[]")
    spec = importlib.util.spec_from_file_location(
        "transport_capture_addon", ROOT / "capture/engine/addon.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    addon = module.CaptureAddon()
    flow = tflow.tflow()
    flow.request = http.Request.make("GET", "https://example.test/api")
    flow.request.http_version = "HTTP/2.0"
    flow.client_conn.alpn = b"h2"
    flow.server_conn.alpn = None
    addon.requestheaders(flow)
    addon.request(flow)
    pending = json.loads(addon.queue.get_nowait())["flow"]
    assert pending["transport"]["upstream"]["http_version"] is None
    flow.server_conn.alpn = b"http/1.1"
    flow.request.http_version = "HTTP/1.1"
    flow.response = http.Response.make(200, b"ok")
    addon.response(flow)
    completed = json.loads(addon.queue.get_nowait())["flow"]
    assert completed["transport"]["client"]["http_version"] == "HTTP/2.0"
    assert completed["transport"]["upstream"]["http_version"] == "HTTP/1.1"
    assert flow.request.http_version == "HTTP/1.1"
    assert (
        completed["transport"]["upstream"]["id"]
        == pending["transport"]["upstream"]["id"]
    )
