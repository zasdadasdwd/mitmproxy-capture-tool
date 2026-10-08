"""关键行为测试：使用本地服务和真实 mitmdump，不访问外网。"""

import asyncio
import base64
import gzip
import importlib.util
import json
import socket
import ssl
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi.testclient import TestClient
from mitmproxy import http
from mitmproxy.test import tflow

import capture.backend.api.certificate as certificate_module
import capture.backend.app as app_module
import capture.backend.context as context_module
import capture.engine.manager as manager_module
import config
from capture.backend.replay import prepare_request
from capture.backend.storage import Store
from capture.engine.policy import matches, normalize_pattern, should_decrypt


def free_port():
    """获取测试专用端口，不占用用户配置的 8080。"""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class EchoHandler(BaseHTTPRequestHandler):
    """回显 URL、正文和重复 Header，验证代理与重放没有丢失数据。"""

    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def respond(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        payload = json.dumps(
            {
                "path": self.path,
                "body": body.decode(),
                "headers": self.headers.get_all("X-Test"),
            }
        ).encode()
        if self.path.startswith("/gzip"):
            payload = gzip.compress(payload)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        if self.path.startswith("/gzip"):
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


@pytest.fixture
def origin(tmp_path):
    """创建本地 HTTP、HTTPS 服务以及测试专用 CA。"""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / "origin.pem", tmp_path / "origin.key"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    plain = ThreadingHTTPServer(("127.0.0.1", 0), EchoHandler)
    secure = ThreadingHTTPServer(("127.0.0.1", 0), EchoHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    secure.socket = context.wrap_socket(secure.socket, server_side=True)
    for server in (plain, secure):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    yield {
        "http": f"http://127.0.0.1:{plain.server_port}",
        "https": f"https://localhost:{secure.server_port}",
        "cert": cert_path,
    }
    for server in (plain, secure):
        server.shutdown()
        server.server_close()


@pytest.fixture
def client(tmp_path, monkeypatch, origin):
    """将数据与证书隔离到临时目录，给引擎显式信任本地测试 CA。"""
    data = tmp_path / "data"
    for module in (config, context_module, certificate_module, manager_module):
        monkeypatch.setattr(module, "DATA", data)
    monkeypatch.setattr(config, "CONFIG_PATH", data / "settings.json")
    monkeypatch.setattr(manager_module, "CONFIG_PATH", data / "settings.json")
    real_spawn = asyncio.create_subprocess_exec

    async def spawn(*command, **kwargs):
        command = (
            *command,
            "--set",
            f"ssl_verify_upstream_trusted_ca={origin['cert']}",
        )
        return await real_spawn(*command, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    config.save_settings(config.Settings(listen_port=free_port()))
    with TestClient(app_module.app) as api:
        settings = api.get("/api/status").json()["settings"]
        settings["listen_port"] = free_port()
        assert api.put("/api/settings", json=settings).status_code == 200
        yield api, data


def wait_for(api, predicate, timeout=8):
    """等待真实引擎事件落盘，超时返回清晰的断言失败。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("等待采集事件超时")


def update_policy(api, **values):
    settings = api.get("/api/status").json()["settings"]
    settings.update(values)
    response = api.put("/api/settings", json=settings)
    assert response.status_code == 200, response.text
    version = response.json()["version"]
    wait_for(api, lambda: api.get("/api/status").json()["policy_version"] == version)


def test_domain_rules():
    """验证通配符边界和域名校验，避免误解密或误拒绝相似域名。"""
    assert matches("API.Example.COM.", ["*.example.com"])
    assert not matches("example.com", ["*.example.com"])
    assert not matches("badexample.com", ["*.example.com"])
    assert normalize_pattern(" EXAMPLE.com ") == "example.com"
    assert normalize_pattern("::1") == "::1"
    with pytest.raises(ValueError):
        normalize_pattern("https://example.com/path")
    assert not should_decrypt("example.com", {"tls_mode": "list", "tls_domains": []})


def test_storage_lifecycle_and_binary(tmp_path):
    """验证会话状态、二进制保存、生命周期合并与目录边界。"""
    store = Store(tmp_path / "captures")
    settings = config.Settings().model_dump()
    session = store.create_session(settings)
    message = {
        "url": "http://example.com/?a=1&a=2",
        "method": "POST",
        "headers": [["X-Test", "1"], ["X-Test", "2"]],
        "body_b64": base64.b64encode(b"\x00\xff").decode(),
        "truncated": False,
    }
    flow = {
        "id": "test",
        "url": message["url"],
        "method": "POST",
        "host": "example.com",
        "request": message,
        "original_request": message,
        "status": "pending",
        "started": time.time(),
    }
    store.save_flow(session, flow)
    store.save_flow(session, {"id": "test", "status": "complete", "code": 200})
    detail = store.get_flow(session, "test")
    assert base64.b64decode(detail["request"]["body_b64"]) == b"\x00\xff"
    assert detail["original_request"]["headers"] == message["headers"]
    assert len(list((store.root / session / "bodies").glob("*.bin"))) == 2
    with pytest.raises(FileNotFoundError):
        store.connect("../escape").__enter__()
    store.finish(session)
    assert store.sessions()[0]["status"] == "stopped"
    incomplete = store.create_session(settings)
    fresh = Store(store.root)
    assert fresh.sessions(current_only=True) == []
    assert (
        next(item for item in store.sessions() if item["id"] == incomplete)["status"]
        == "running"
    )
    new_session = fresh.create_session(settings)
    assert [item["id"] for item in fresh.sessions(current_only=True)] == [new_session]
    assert len(fresh.sessions()) == 3
    fresh.close()
    store.close()


def test_hook_preserves_original_and_blocks_errors(tmp_path, monkeypatch):
    """直接调用真实 addon，验证用户 hook 的修改与错误行为。"""
    settings_path = tmp_path / "settings.json"
    settings = config.Settings(tls_mode="all", hook_enabled=True).model_dump()
    settings_path.write_text(json.dumps(settings))
    monkeypatch.setenv("CAPTURE_SETTINGS", str(settings_path))
    monkeypatch.setenv("CAPTURE_SESSION", "test-session")
    spec = importlib.util.spec_from_file_location(
        "test_capture_addon", config.ROOT / "capture/engine/addon.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    addon = module.CaptureAddon()

    def hook(flow, context):
        assert context.session_id == "test-session"
        flow.request.query["page"] = "2"

    def response_hook(flow, context):
        assert context.hook_name == "request_hook"
        flow.response.content = b"rewritten"

    addon.hooks.instances["request_hook"] = SimpleNamespace(
        on_request=hook, on_response=response_hook
    )
    flow = tflow.tflow()
    flow.request = http.Request.make("GET", "http://example.com/?page=1")
    addon.request(flow)
    detail = json.loads(addon.queue.get_nowait())["flow"]
    assert detail["original_request"]["url"].endswith("page=1")
    assert detail["request"]["url"].endswith("page=2")
    flow.response = http.Response.make(200, b"OK")
    addon.response(flow)
    completed = json.loads(addon.queue.get_nowait())["flow"]
    assert "request" not in completed
    assert base64.b64decode(completed["response"]["body_b64"]) == b"rewritten"

    def broken(flow, context):
        raise RuntimeError("signature failed")

    addon.hooks.instances["request_hook"] = SimpleNamespace(
        on_request=broken, on_response=lambda flow, context: None
    )
    addon.request(flow)
    assert flow.response.status_code == 502
    assert flow.metadata["hook_error"] == "request_hook (request): signature failed"


def test_parallel_capture_does_not_duplicate_or_drop_records(client, origin):
    """真实代理上的并发流量全部落盘，零正文请求不生成空文件。"""
    api, data = client
    started = api.post("/api/engine/start")
    assert started.status_code == 200, started.text
    session = started.json()["session_id"]
    port = api.get("/api/status").json()["settings"]["listen_port"]

    async def send_requests():
        limit = asyncio.Semaphore(4)
        async with httpx.AsyncClient(
            proxy=f"http://127.0.0.1:{port}", trust_env=False
        ) as proxy:

            async def send(index):
                async with limit:
                    response = await proxy.get(origin["http"] + f"/parallel/{index}")
                    assert response.status_code == 200

            await asyncio.gather(*(send(i) for i in range(40)))

    asyncio.run(send_requests())

    def completed_rows():
        result = api.get(f"/api/sessions/{session}/flows").json()
        if result["total"] == 40 and all(
            row["status"] == "complete" for row in result["items"]
        ):
            return result["items"]
        return None

    rows = wait_for(api, completed_rows)
    assert len({row["id"] for row in rows}) == 40
    assert api.get("/api/status").json()["dropped_events"] == 0
    assert len(list((data / "captures" / session / "bodies").iterdir())) == 40
    api.post("/api/engine/stop")


def test_real_http_replay_export_and_websocket(client, origin):
    """真实请求走代理，再验证实时事件、导出和停止后的编辑重放。"""
    api, data = client
    started = api.post("/api/engine/start")
    assert started.status_code == 200, started.text
    session = started.json()["session_id"]
    port = api.get("/api/status").json()["settings"]["listen_port"]
    with api.websocket_connect("/ws") as websocket:
        assert websocket.receive_json()["type"] == "connected"
        with httpx.Client(proxy=f"http://127.0.0.1:{port}", trust_env=False) as proxy:
            response = proxy.post(
                origin["http"] + "/echo?a=1&a=2",
                content=b'{"value":1}',
                headers=[("X-Test", "one"), ("X-Test", "two")],
            )
            assert response.status_code == 200
            assert response.json()["headers"] == ["one", "two"]
        assert websocket.receive_json()["type"] == "flows"
    records = wait_for(
        api,
        lambda: [
            row
            for row in api.get(f"/api/sessions/{session}/flows").json()["items"]
            if row["status"] == "complete"
        ],
    )
    flow_id = records[0]["id"]
    detail = api.get(f"/api/sessions/{session}/flows/{flow_id}").json()
    assert detail["original_request"]["url"].endswith("a=1&a=2")
    for format in ("curl", "python", "har", "csv", "json"):
        result = api.post(
            f"/api/sessions/{session}/export", json={"ids": [flow_id], "format": format}
        )
        assert result.status_code == 200, result.text
        if format == "python":
            compile(result.text, "export.py", "exec")
        if format == "har":
            assert (
                len(result.json()["log"]["entries"][0]["request"]["queryString"]) == 2
            )
    assert api.post("/api/engine/stop").status_code == 200
    assert (data / "captures" / session / "capture.sqlite").exists()
    # 管理服务可以在代理停止后编辑并重放。
    edit = dict(detail["request"], body_b64=base64.b64encode(b'{"value":2}').decode())
    result = api.post(
        f"/api/sessions/{session}/replay", json={"ids": [flow_id], "edit": edit}
    )
    assert result.status_code == 200, result.text
    replay_session = result.json()["session_id"]
    rows = wait_for(
        api,
        lambda: [
            row
            for row in api.get(f"/api/sessions/{replay_session}/flows").json()["items"]
            if row["status"] == "complete"
        ],
    )
    repeated = api.get(f"/api/sessions/{replay_session}/flows/{rows[0]['id']}").json()
    assert repeated["original_flow_id"] == flow_id
    assert json.loads(repeated["response"]["body_text"])["body"] == '{"value":2}'
    assert api.get("/api/status").json()["running"]
    assert not api.get("/api/status").json()["recording"]
    assert api.get("/api/certificate").status_code == 200
    assert "PRIVATE KEY" not in api.get("/api/certificate").text
    assert api.get("/api/certificate/info").json()["available"]
    assert (
        api.post(
            "/api/engine/start", headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    # 取消等待间隔中的批量任务，避免继续发送剩余请求。
    job = api.post(
        f"/api/sessions/{session}/replay",
        json={"ids": [flow_id], "count": 20, "interval": 60},
    ).json()["session_id"]
    assert api.post(f"/api/replay/{job}/cancel").json()["cancelled"]
    assert job not in api.get("/api/status").json()["replay_jobs"]
    assert (
        next(item for item in api.get("/api/sessions").json() if item["id"] == job)[
            "status"
        ]
        == "cancelled"
    )
    # 重放也必须遵守拒绝列表。
    settings = api.get("/api/status").json()["settings"]
    settings.update(blocking_enabled=True, blocked_domains=["127.0.0.1"])
    assert api.put("/api/settings", json=settings).status_code == 200
    blocked_job = api.post(
        f"/api/sessions/{session}/replay", json={"ids": [flow_id]}
    ).json()["session_id"]
    wait_for(
        api,
        lambda: any(
            row["status"] == "blocked"
            for row in api.get(f"/api/sessions/{blocked_job}/flows").json()["items"]
        ),
    )


def test_real_tls_modes_and_blocking(client, origin):
    """验证真实 TLS 证书交换、配置热更新，以及拒绝优先于透传。"""
    api, data = client
    started = api.post("/api/engine/start")
    assert started.status_code == 200, started.text
    session = started.json()["session_id"]
    port = api.get("/api/status").json()["settings"]["listen_port"]
    proxy_url = f"http://127.0.0.1:{port}"
    upstream_context = ssl.create_default_context(cafile=str(origin["cert"]))
    capture_context = ssl.create_default_context(
        cafile=str(data / "certificates/mitmproxy-ca-cert.pem")
    )
    with httpx.Client(
        proxy=proxy_url, verify=upstream_context, trust_env=False
    ) as proxy:
        assert proxy.get(origin["https"] + "/passthrough").status_code == 200
    wait_for(
        api,
        lambda: any(
            row["status"] == "passthrough"
            for row in api.get(f"/api/sessions/{session}/flows").json()["items"]
        ),
    )
    update_policy(api, tls_mode="list", tls_domains=["localhost"])
    with httpx.Client(
        proxy=proxy_url, verify=capture_context, trust_env=False
    ) as proxy:
        assert proxy.get(origin["https"] + "/gzip?a=1").status_code == 200
    rows = wait_for(
        api,
        lambda: [
            row
            for row in api.get(f"/api/sessions/{session}/flows").json()["items"]
            if row["method"] == "GET" and row["status"] == "complete"
        ],
    )
    detail = api.get(f"/api/sessions/{session}/flows/{rows[0]['id']}").json()
    assert detail["tls"] is True
    assert json.loads(detail["response"]["body_text"])["path"] == "/gzip?a=1"
    update_policy(api, tls_mode="all", tls_domains=[])
    with httpx.Client(
        proxy=proxy_url, verify=capture_context, trust_env=False
    ) as proxy:
        assert proxy.get(origin["https"] + "/all").status_code == 200
    update_policy(
        api,
        tls_mode="passthrough",
        blocking_enabled=True,
        blocked_domains=["localhost", "127.0.0.1"],
    )
    with httpx.Client(
        proxy=proxy_url, verify=upstream_context, trust_env=False
    ) as proxy:
        with pytest.raises(httpx.ProxyError):
            proxy.get(origin["https"] + "/blocked")
        assert proxy.get(origin["http"] + "/blocked").status_code == 403
    wait_for(
        api,
        lambda: any(
            row["status"] == "blocked"
            for row in api.get(f"/api/sessions/{session}/flows").json()["items"]
        ),
    )
    assert api.post("/api/engine/stop").status_code == 200


def test_truncated_request_and_hop_headers():
    """不完整请求不能重放，逐跳 Header 不应复用到新连接。"""
    message = {
        "url": "http://example.com",
        "method": "POST",
        "headers": [
            ("Host", "wrong"),
            ("Content-Length", "999"),
            ("Connection", "X-Hop"),
            ("X-Hop", "drop"),
            ("X-Test", "1"),
            ("X-Test", "2"),
        ],
        "body_b64": "eA==",
    }
    prepared = prepare_request(message)
    assert prepared["headers"] == [("X-Test", "1"), ("X-Test", "2")]
    assert prepared["content"] == b"x"
    with pytest.raises(ValueError):
        prepare_request(dict(message, truncated=True))


def test_startup_config_and_bootstrap(client, tmp_path):
    """启动配置与热更新策略分离，MCP 可查询实现状态。"""
    path = tmp_path / "startup.toml"
    path.write_text(
        '[web]\nport = 9000\n[proxy]\nautostart = true\n[mcp]\ntransport = "streamable-http"\nport = 9001\n'
    )
    startup = config.load_startup(path)
    assert startup.web.port == 9000
    assert startup.proxy.autostart is True
    assert startup.mcp.port == 9001
    assert startup.mcp.enabled is False
    api, _ = client
    response = api.get("/api/bootstrap")
    assert response.status_code == 200
    assert response.json()["mcp_implemented"] is True
    assert response.json()["api_base_url"] == "http://127.0.0.1:8765"
    store = api.app.state.workbench.store
    session = store.create_session(config.Settings().model_dump())
    store.save_flow(
        session,
        {
            "id": "filter-test",
            "host": "api.example.com",
            "url": "https://api.example.com/test",
            "method": "POST",
            "status": "complete",
            "code": 403,
            "started": time.time(),
            "response": {"headers": [["Content-Type", "application/json"]]},
        },
    )
    result = api.get(
        f"/api/sessions/{session}/flows",
        params={"method": "post", "status_code": "4xx", "content_type": "json"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["total"] == 1
    assert (
        api.get(
            f"/api/sessions/{session}/flows", params={"status_code": "bad"}
        ).status_code
        == 422
    )


def test_upstream_capture_and_replay(client, origin):
    """目标不可直连时，抓包和重放都应经过配置的真实 HTTP 上游。"""
    api, _ = client
    settings = api.get("/api/status").json()["settings"]
    settings.update(connection_mode="upstream", upstream_proxy=origin["http"])
    assert api.put("/api/settings", json=settings).status_code == 200
    started = api.post("/api/engine/start")
    assert started.status_code == 200, started.text
    session = started.json()["session_id"]
    with httpx.Client(
        proxy=f"http://127.0.0.1:{settings['listen_port']}", trust_env=False
    ) as proxy:
        result = proxy.get("http://unreachable.invalid/am1/am2?a=1")
    assert result.status_code == 200
    assert "unreachable.invalid/am1/am2" in result.json()["path"]
    rows = wait_for(
        api,
        lambda: [
            row
            for row in api.get(f"/api/sessions/{session}/flows").json()["items"]
            if row["status"] == "complete"
        ],
    )
    changed = dict(settings, connection_mode="direct")
    assert api.put("/api/settings", json=changed).status_code == 409
    assert api.post("/api/engine/stop").status_code == 200
    replay = api.post(f"/api/sessions/{session}/replay", json={"ids": [rows[0]["id"]]})
    assert replay.status_code == 200
    replay_id = replay.json()["session_id"]
    replay_rows = wait_for(
        api,
        lambda: [
            row
            for row in api.get(f"/api/sessions/{replay_id}/flows").json()["items"]
            if row["status"] == "complete"
        ],
    )
    assert replay_rows[0]["code"] == 200
    assert api.get(f"/api/sessions/{replay_id}/directories").json() == [
        {"host": "unreachable.invalid", "path": "/am1/am2", "count": 1}
    ]


def test_history_management_and_archive(client):
    """历史仅显式加载，完整下载可还原；删除不能触及本次会话。"""
    import io
    import zipfile

    api, _ = client
    original = api.app.state.workbench.store
    old_id = original.create_session(config.Settings().model_dump())
    original.save_flow(
        old_id, {"id": "old", "status": "complete", "request": {"body_b64": "YWJj"}}
    )
    original.finish(old_id)
    original.close()
    store = Store(original.root)
    api.app.state.workbench.store = store
    api.app.state.workbench.engine.store = store
    assert api.get("/api/sessions").json() == []
    assert api.get("/api/history").json()[0]["id"] == old_id
    package = api.get(f"/api/history/{old_id}/download")
    assert package.status_code == 200
    with zipfile.ZipFile(io.BytesIO(package.content)) as archive:
        assert f"{old_id}/capture.sqlite" in archive.namelist()
        assert any(
            name.endswith(".bin") and archive.read(name) == b"abc"
            for name in archive.namelist()
        )
    current = store.create_session(config.Settings().model_dump())
    assert api.delete(f"/api/history/{current}").status_code == 400
    assert api.get(f"/api/history/{current}/download").status_code == 400
    assert api.delete("/api/history/../escape").status_code in (404, 405)
    assert api.delete(f"/api/history/{old_id}").status_code == 200
    assert not (store.root / old_id).exists()
    assert (store.root / current / "capture.sqlite").exists()


def test_certificate_reading_page_and_hook_discovery(client):
    """说明提供 HTML 与 Markdown；扩展列表只返回已注册的类。"""
    api, _ = client
    page = api.get("/docs/certificate")
    assert page.status_code == 200
    assert "text/html" in page.headers["content-type"]
    assert "/certificate.js" in page.text
    assert '<code class="language-python">' in page.text
    assert "{{content}}" not in page.text
    raw = api.get("/docs/certificate/source")
    assert raw.status_code == 200
    assert raw.text.startswith("# 抓包证书安装")
    assert "attachment" in raw.headers["content-disposition"]
    discovered = {hook["name"] for hook in api.get("/api/hooks").json()["hooks"]}
    assert {"request_hook", "example_query", "template"} <= discovered


def test_forwarding_without_recording_and_new_capture_sessions(client, origin):
    """未抓包与停止后 HTTP/HTTPS 均可转发；再次抓包使用新会话且不混入旧请求。"""
    api, data = client
    state = api.get("/api/status").json()
    assert state["running"] and not state["recording"]
    assert api.get("/api/sessions").json() == []
    process = api.app.state.workbench.engine.process
    update_policy(api, tls_mode="all")
    context = ssl.create_default_context(
        cafile=str(data / "certificates/mitmproxy-ca-cert.pem")
    )
    with httpx.Client(
        proxy=f"http://127.0.0.1:{state['settings']['listen_port']}",
        verify=context,
        trust_env=False,
    ) as proxy:
        assert proxy.get(origin["http"] + "/idle-http").status_code == 200
        assert proxy.get(origin["https"] + "/idle-https").status_code == 200
        assert api.get("/api/sessions").json() == []
        first = api.post("/api/engine/start").json()["session_id"]
        assert proxy.get(origin["http"] + "/record-first").status_code == 200
        wait_for(
            api, lambda: api.get(f"/api/sessions/{first}/flows").json()["total"] == 1
        )
        stopped = api.post("/api/engine/stop")
        assert stopped.status_code == 200, stopped.text
        assert stopped.json()["running"] and not stopped.json()["recording"]
        before = api.get(f"/api/sessions/{first}/flows").json()
        assert before["total"] == 1
        assert proxy.get(origin["http"] + "/after-stop-http").status_code == 200
        assert proxy.get(origin["https"] + "/after-stop-https").status_code == 200
        assert api.get(f"/api/sessions/{first}/flows").json() == before
        second = api.post("/api/engine/start").json()["session_id"]
        assert first != second
        assert proxy.get(origin["http"] + "/record-second").status_code == 200
        rows = wait_for(
            api, lambda: api.get(f"/api/sessions/{second}/flows").json()["items"]
        )
        assert len(rows) == 1 and rows[0]["url"].endswith("/record-second")
        assert api.app.state.workbench.engine.process is process
        api.post("/api/engine/stop")
    assert len(list((data / "captures").iterdir())) == 2


def test_inflight_flow_does_not_cross_recording_sessions(tmp_path, monkeypatch):
    """停止期间开始或跨越两次抓包的请求，不应把响应写入新的会话。"""
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps(config.Settings().model_dump()))
    monkeypatch.setenv("CAPTURE_SETTINGS", str(settings_path))
    monkeypatch.setenv("CAPTURE_SESSION", "")
    spec = importlib.util.spec_from_file_location(
        "test_capture_boundaries", config.ROOT / "capture/engine/addon.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    addon = module.CaptureAddon()
    idle = tflow.tflow(resp=True)
    addon.request(idle)
    assert addon.queue.empty()
    addon.capture_session = "first"
    first = tflow.tflow(resp=True)
    addon.request(first)
    assert json.loads(addon.queue.get_nowait())["session_id"] == "first"
    addon.capture_session = None
    addon.response(first)
    assert addon.queue.empty()
    addon.capture_session = "second"
    addon.response(first)
    addon.response(idle)
    assert addon.queue.empty()
    second = tflow.tflow(resp=True)
    addon.request(second)
    assert json.loads(addon.queue.get_nowait())["session_id"] == "second"


def test_change_proxy_port_while_only_forwarding(client, origin):
    """仅转发时改端口立即切换监听；正在记录时拒绝改端口。"""
    api, _ = client
    settings = api.get("/api/status").json()["settings"]
    old_port = settings["listen_port"]
    settings["listen_port"] = free_port()
    changed = api.put("/api/settings", json=settings)
    assert changed.status_code == 200, changed.text
    state = api.get("/api/status").json()
    assert state["running"] and not state["recording"]
    assert state["network"]["listen_address"].endswith(f":{settings['listen_port']}")
    with httpx.Client(
        proxy=f"http://127.0.0.1:{settings['listen_port']}", trust_env=False
    ) as proxy:
        assert proxy.get(origin["http"] + "/new-port").status_code == 200
    with socket.socket() as channel:
        assert channel.connect_ex(("127.0.0.1", old_port)) != 0
    assert api.get("/api/sessions").json() == []
    assert api.post("/api/engine/start").status_code == 200
    settings["listen_port"] = free_port()
    assert api.put("/api/settings", json=settings).status_code == 409
    api.post("/api/engine/stop")


def test_delete_requests_and_finished_batches(client, origin):
    """删除会清理正文；活动会话允许清空记录，整批删除仍校验活动状态。"""
    api, data = client
    session = api.post("/api/engine/start").json()["session_id"]
    port = api.get("/api/status").json()["settings"]["listen_port"]
    with httpx.Client(proxy=f"http://127.0.0.1:{port}", trust_env=False) as proxy:
        assert proxy.get(origin["http"] + "/delete-check").status_code == 200
    rows = wait_for(
        api,
        lambda: [
            row
            for row in api.get(f"/api/sessions/{session}/flows").json()["items"]
            if row["status"] == "complete"
        ],
    )
    flow_id = rows[0]["id"]
    assert (
        api.post(
            f"/api/sessions/{session}/flows/delete", json={"ids": ["not-yet-saved"]}
        ).status_code
        == 200
    )
    assert api.post("/api/sessions/delete", json={"ids": [session]}).status_code == 409
    api.post("/api/engine/stop")
    replay = api.post(
        f"/api/sessions/{session}/replay",
        json={"ids": [flow_id], "count": 20, "interval": 60},
    ).json()["session_id"]
    assert (
        api.post("/api/sessions/delete", json={"ids": [session, replay]}).status_code
        == 409
    )
    assert (data / "captures" / session).exists()
    assert (
        api.post(f"/api/sessions/{replay}/flows/delete", json={"all": True}).status_code
        == 200
    )
    api.post(f"/api/replay/{replay}/cancel")
    removed = api.post(f"/api/sessions/{session}/flows/delete", json={"ids": [flow_id]})
    assert removed.json()["deleted"] == 1
    assert api.get(f"/api/sessions/{session}/flows").json()["total"] == 0
    assert list((data / "captures" / session / "bodies").iterdir()) == []
    store = api.app.state.workbench.store
    for index in range(2):
        store.save_flow(
            session,
            {
                "id": str(index),
                "status": "complete",
                "request": {
                    "headers": [],
                    "body_b64": base64.b64encode(b"temporary test body").decode(),
                },
            },
        )
    assert api.post(f"/api/sessions/{session}/flows/delete", json={}).status_code == 400
    assert (
        api.post(
            f"/api/sessions/{session}/flows/delete", json={"all": True, "ids": ["0"]}
        ).status_code
        == 400
    )
    assert (
        api.post(f"/api/sessions/{session}/flows/delete", json={"all": True}).json()[
            "deleted"
        ]
        == 2
    )
    assert list((data / "captures" / session / "bodies").iterdir()) == []
    deleted = api.post("/api/sessions/delete", json={"ids": [session, replay]})
    assert deleted.status_code == 200, deleted.text
    assert api.get("/api/sessions").json() == []
    assert (
        not (data / "captures" / session).exists()
        and not (data / "captures" / replay).exists()
    )
    assert api.get("/api/status").json()["running"]


def test_clear_live_capture_keeps_proxy_and_accepts_new_requests(client, origin):
    """清空正在记录的请求不停止代理，后续请求仍进入同一会话。"""
    api, _ = client
    session = api.post("/api/engine/start").json()["session_id"]
    port = api.get("/api/status").json()["settings"]["listen_port"]
    with httpx.Client(proxy=f"http://127.0.0.1:{port}", trust_env=False) as proxy:
        assert proxy.get(origin["http"] + "/before-clear").status_code == 200
        wait_for(api, lambda: api.get(f"/api/sessions/{session}/flows").json()["total"])
        result = api.post(f"/api/sessions/{session}/flows/delete", json={"all": True})
        assert result.status_code == 200, result.text
        assert result.json()["deleted"] >= 1
        assert api.get(f"/api/sessions/{session}/flows").json()["total"] == 0
        assert api.get("/api/status").json()["session_id"] == session
        assert proxy.get(origin["http"] + "/after-clear").status_code == 200
        rows = wait_for(
            api, lambda: api.get(f"/api/sessions/{session}/flows").json()["items"]
        )
        assert all("/before-clear" not in row["url"] for row in rows)
        assert any("/after-clear" in row["url"] for row in rows)
