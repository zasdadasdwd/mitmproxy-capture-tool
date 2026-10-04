"""MCP 与分析测试：全部使用临时会话、本机接口，不访问外部网站。"""

import asyncio
import base64
import json
import sys
from types import SimpleNamespace

import httpx
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.fastmcp.exceptions import ToolError

import capture.backend.app as app_module
from capture.agent_mcp.audit import AuditLog
from capture.agent_mcp.server import create_server
from capture.backend.analysis.parameters import extract_parameters, select_parameter
from capture.backend.analysis.service import AnalysisService
from capture.backend.storage import Store
from config import ROOT, Settings


@pytest.fixture
def evidence(tmp_path, monkeypatch):
    """构造登录、携带 token 的请求及尚未可用的并行响应。"""
    store = Store(tmp_path / "captures")
    settings = Settings()
    session = store.create_session(settings.model_dump())

    def save(
        id,
        started,
        request_body=None,
        response_body=None,
        headers=None,
        duration=10,
        query="",
    ):
        flow = {
            "id": id,
            "started": started,
            "duration": duration,
            "method": "POST",
            "url": "https://example.test/api" + query,
            "host": "example.test",
            "status": "complete",
            "code": 200,
            "source": "capture",
            "request": {
                "method": "POST",
                "url": "https://example.test/api" + query,
                "headers": headers or [["Content-Type", "application/json"]],
                "body_b64": base64.b64encode(
                    json.dumps(request_body or {}).encode()
                ).decode(),
            },
            "response": {
                "headers": [["Content-Type", "application/json"]],
                "body_b64": base64.b64encode(
                    json.dumps(response_body or {}).encode()
                ).decode(),
            },
        }
        store.save_flow(session, flow)

    save("login", 100, response_body={"data": {"token": "secret-token-123"}})
    save("parallel", 101, response_body={"token": "secret-token-123"}, duration=10000)
    save(
        "business",
        102,
        request_body={"page": 1},
        headers=[
            ["Authorization", "Bearer secret-token-123"],
            ["X-Test", "a"],
            ["X-Test", "b"],
        ],
        query="?page=1&page=2",
    )
    store.finish(session)
    state = SimpleNamespace(
        store=store, settings=settings, jobs={}, notify=lambda event: None
    )
    monkeypatch.setattr(app_module.app.state, "workbench", state, raising=False)
    yield store, session
    store.close()


def test_parameter_paths_and_repeated_values(evidence):
    store, session = evidence
    fields = extract_parameters(store.get_flow(session, "business", preview=True))[
        "fields"
    ]
    assert (
        select_parameter(fields, "headers.authorization")["value"]
        == "Bearer secret-token-123"
    )
    assert select_parameter(fields, "query.page[1]")["value"] == "2"
    assert select_parameter(fields, "request.headers.x-test[1]")["value"] == "b"
    assert select_parameter(fields, "body#/page")["value"] == "1"
    with pytest.raises(ValueError):
        select_parameter(fields, "query.page")


def test_trace_distinguishes_candidate_and_temporal_availability(evidence):
    store, session = evidence
    result = AnalysisService(store).trace(session, "business", "headers.authorization")
    login = next(item for item in result["candidates"] if item["flow_id"] == "login")
    assert login["available_before_target"]
    assert login["target_transform"] == "去除 Bearer 前缀"
    assert login["causality"] == "unconfirmed"
    assert result["generation_source"] == "unknown"
    parallel = next(
        item for item in result["candidates"] if item["flow_id"] == "parallel"
    )
    assert not parallel["available_before_target"]
    chain = AnalysisService(store).chain(session, "business")
    assert any(item["from"] == "login" for item in chain["candidate_relations"])
    assert not any(item["from"] == "parallel" for item in chain["candidate_relations"])
    assert not chain["recorded_relations"]


def test_trace_bounds_and_session_isolation(evidence):
    store, session = evidence
    analysis = AnalysisService(store)
    assert not any(
        item["available_before_target"]
        for item in analysis.trace(
            session, "business", "headers.authorization", window_seconds=1
        )["candidates"]
    )
    result = analysis.trace(session, "business", "headers.authorization", limit=1)
    assert result["scope"]["scanned"] == 1
    assert result["scope"]["request_limit_reached"]
    other = store.create_session(Settings().model_dump())
    with pytest.raises(FileNotFoundError):
        analysis.trace(other, "business", "headers.authorization")


def test_compare_and_recorded_replay_origin(evidence):
    store, session = evidence
    result = AnalysisService(store).compare(session, "login", session, "business")
    assert any(
        item["field"] == "request.headers.authorization[0]"
        for item in result["changes"]
    )
    flow = store.get_flow(session, "business")
    flow.update(
        id="replay-copy",
        started=200,
        source="replay",
        original_flow_id="business",
        original_session_id=session,
    )
    store.save_flow(session, flow)
    result = AnalysisService(store).chain(session, "replay-copy")
    assert result["recorded_relations"][0]["from_session"] == session
    assert result["recorded_relations"][0]["recorded"]


def test_truncated_body_not_used_as_complete_json():
    result = extract_parameters(
        {"request": {"body_text": '{"token":"secret"}', "display_truncated": True}}
    )
    assert result["fields"] == []
    assert result["warnings"]
    result = extract_parameters({"response": {"body_text": '{"a/b":{"~x":null}}'}})
    assert result["fields"][0]["field"] == "response.body#/a~1b/~0x"


def test_analysis_search_is_bounded_and_sql_first(evidence, monkeypatch):
    store, session = evidence
    read_ids = []
    original = store.get_flow

    def counted(*args, **kwargs):
        read_ids.append(args[1])
        return original(*args, **kwargs)

    monkeypatch.setattr(store, "get_flow", counted)

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app_module.app),
            base_url="http://testserver",
        ) as api:
            path = f"/api/analysis/{session}/search"
            result = await api.post(path, json={"filters": {"host": "absent.test"}})
            assert result.status_code == 200
            assert result.json()["items"] == [] and read_ids == []
            result = await api.post(
                path,
                json={
                    "filters": {"limit": 1},
                    "parameter": {
                        "field": "response.body#/data/token",
                        "operator": "exists",
                    },
                    "scan_limit": 1,
                },
            )
            assert result.json()["scanned"] == 1 and result.json()["has_more"]
            offset = result.json()["next_offset"]
            result = await api.post(
                path,
                json={
                    "filters": {"limit": 1, "offset": offset},
                    "parameter": {
                        "field": "response.body#/data/token",
                        "operator": "exists",
                    },
                    "scan_limit": 2,
                },
            )
            assert result.json()["items"][0]["id"] == "login"
            assert not result.json()["has_more"]
            for payload in (
                {"filters": {"limit": 101}},
                {"scan_limit": 201},
                {"filters": {"started_after": 10, "started_before": 1}},
            ):
                assert (await api.post(path, json=payload)).status_code == 422
            result = await api.post(
                path,
                json={"filters": {"started_after": 101.5, "started_before": 102.5}},
            )
            assert [item["id"] for item in result.json()["items"]] == ["business"]
            assert (
                await api.get(
                    f"/api/analysis/{session}/business/trace",
                    params={"field": "missing"},
                )
            ).status_code == 400

    asyncio.run(run())


def structured(result):
    """SDK 返回 text 与 structured 双结果时提取结构化对象。"""
    if isinstance(result, tuple):
        return result[1]
    if isinstance(result, dict):
        return result
    return json.loads(result[0].text)


def test_mcp_tools_and_developer_audit(evidence, tmp_path):
    _, session = evidence
    log_path = tmp_path / "mcp.jsonl"

    async def run():
        server = create_server(
            "http://127.0.0.1:8765",
            log_path=log_path,
            transport=httpx.ASGITransport(app=app_module.app),
        )
        async with server.resources():
            tools = await server.list_tools()
            assert len(tools) == 14
            search = next(item for item in tools if item.name == "search_requests")
            assert search.annotations.readOnlyHint
            replay = next(item for item in tools if item.name == "replay_request")
            assert (
                not replay.annotations.readOnlyHint and replay.annotations.openWorldHint
            )
            result = structured(
                await server.call_tool(
                    "search_requests",
                    {
                        "session_id": session,
                        "filters": {"limit": 1},
                        "parameter": {
                            "field": "request.headers.authorization",
                            "operator": "contains",
                            "value": "secret-token",
                        },
                    },
                )
            )
            assert result["items"][0]["id"] == "business"
            assert "_audit" not in result
            result = structured(
                await server.call_tool(
                    "get_request", {"session_id": session, "flow_id": "business"}
                )
            )
            assert "request" not in result
            result = structured(
                await server.call_tool(
                    "trace_parameter",
                    {
                        "session_id": session,
                        "flow_id": "business",
                        "field": "headers.authorization",
                    },
                )
            )
            assert result["candidates"]
            result = structured(
                await server.call_tool(
                    "get_request",
                    {
                        "session_id": session,
                        "flow_id": "business",
                        "part": "request",
                        "section": "body",
                        "max_chars": 3,
                    },
                )
            )
            assert len(result["body_text"]) == 3 and result["has_more"]
            with pytest.raises(ToolError):
                await server.call_tool(
                    "get_request", {"session_id": session, "flow_id": "not-found"}
                )

    asyncio.run(run())
    text = log_path.read_text()
    assert "secret-token" not in text and "Bearer" not in text
    records = [json.loads(line) for line in text.splitlines()]
    query = records[0]
    assert query["returned_request_ids"] == ["business"]
    assert "business" in query["read_request_ids"]
    assert query["arguments"]["parameter"]["value"]["redacted"]
    assert records[-1]["status"] == "error"
    assert records[2]["related_request_ids"]


def test_audit_error_does_not_leak_sensitive_text(tmp_path):
    audit = AuditLog(tmp_path / "audit.jsonl")

    async def fail(body_text):
        raise ValueError(body_text)

    with pytest.raises(ValueError):
        asyncio.run(audit.wrap(fail)("private-secret"))
    audit.close()
    text = (tmp_path / "audit.jsonl").read_text()
    assert "private-secret" not in text
    assert json.loads(text)["error_type"] == "ValueError"


def test_stdio_protocol_and_error_audit(tmp_path):
    """启动真实子进程并完成 MCP 握手，确保日志不会污染 stdout 协议。"""

    async def run():
        parameters = StdioServerParameters(
            command=sys.executable,
            args=[
                str(ROOT / "mcp_server.py"),
                "--transport",
                "stdio",
                "--api-url",
                "http://127.0.0.1:1",
                "--log-file",
                str(tmp_path / "stdio.jsonl"),
            ],
            cwd=str(tmp_path),
        )
        async with (
            stdio_client(parameters) as (read, write),
            ClientSession(read, write) as session,
        ):
            initialized = await session.initialize()
            assert initialized.serverInfo.name == "天机阁"
            tools = await session.list_tools()
            assert any(tool.name == "trace_parameter" for tool in tools.tools)
            result = await session.call_tool(
                "search_requests", {"session_id": "missing"}
            )
            assert result.isError

    asyncio.run(run())
    record = json.loads((tmp_path / "stdio.jsonl").read_text().splitlines()[0])
    assert record["tool"] == "search_requests" and record["status"] == "error"


def test_mcp_client_rejects_external_hosts_and_path_escape():
    from capture.agent_mcp.client import WorkbenchClient

    for url in (
        "https://example.com",
        "http://127.0.0.1.evil.test",
        "http://user:pass@127.0.0.1",
        "http://127.0.0.1/api",
    ):
        with pytest.raises(ValueError):
            WorkbenchClient(url)
    for value in ("..", "../api", "a/b", "a\\b"):
        with pytest.raises(ValueError):
            WorkbenchClient.path(value)


def test_real_http_mcp_transport(evidence, tmp_path):
    """通过真实 HTTP 协议握手并查询，验证 SDK 路由、结构化结果与日志。"""
    import socket

    import uvicorn
    from mcp.client.streamable_http import streamable_http_client

    _, session_id = evidence

    async def run():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        mcp = create_server(
            "http://127.0.0.1:8765",
            port=port,
            log_path=tmp_path / "http.jsonl",
            transport=httpx.ASGITransport(app=app_module.app),
        )
        http_server = uvicorn.Server(
            uvicorn.Config(
                mcp.streamable_http_app(),
                host="127.0.0.1",
                port=port,
                log_level="warning",
            )
        )
        task = asyncio.create_task(http_server.serve())
        try:
            deadline = asyncio.get_running_loop().time() + 5
            while not http_server.started:
                assert not task.done() and asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.01)

            async with (
                httpx.AsyncClient(trust_env=False) as protocol_http,
                streamable_http_client(
                    f"http://127.0.0.1:{port}/mcp", http_client=protocol_http
                ) as (read, write, _),
                ClientSession(read, write) as session,
            ):
                initialized = await session.initialize()
                assert initialized.serverInfo.name == "天机阁"
                result = await session.call_tool(
                    "search_requests",
                    {
                        "session_id": session_id,
                        "filters": {"limit": 1, "started_after": 101.5},
                    },
                )
                assert not result.isError
                assert result.structuredContent["items"][0]["id"] == "business"
        finally:
            http_server.should_exit = True
            await task

    asyncio.run(run())
    assert json.loads((tmp_path / "http.jsonl").read_text())[
        "returned_request_ids"
    ] == ["business"]


def test_mcp_edit_replay_and_result(evidence, tmp_path):
    """MCP 发出一次真实本机重放，验证来源 ID、正文修改及结果对比。"""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    store, source_session = evidence

    class Echo(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    origin = ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    thread = threading.Thread(target=origin.serve_forever, daemon=True)
    thread.start()

    async def run():
        server = create_server(
            "http://127.0.0.1:8765",
            log_path=tmp_path / "replay.jsonl",
            transport=httpx.ASGITransport(app=app_module.app),
        )
        async with server.resources():
            result = structured(
                await server.call_tool(
                    "replay_request",
                    {
                        "session_id": source_session,
                        "flow_id": "business",
                        "url": f"http://127.0.0.1:{origin.server_port}/echo",
                        "headers": [
                            ["Content-Type", "application/json"],
                            ["Content-Encoding", "gzip"],
                        ],
                        "body": {"text": '{"edited":true}'},
                    },
                )
            )
            replay_session = result["session_id"]
            assert replay_session != source_session
            deadline = asyncio.get_running_loop().time() + 5
            while True:
                result = structured(
                    await server.call_tool(
                        "get_replay_result", {"session_id": replay_session}
                    )
                )
                if result["status"] != "running" and result["items"]:
                    break
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.03)
            flow_id = result["items"][0]["id"]
            result = structured(
                await server.call_tool(
                    "get_replay_result",
                    {"session_id": replay_session, "flow_id": flow_id},
                )
            )
            assert json.loads(result["response"]["body_text"]) == {"edited": True}
            assert result["comparison"]["changes"]
            replayed = store.get_flow(replay_session, flow_id)
            assert replayed["original_session_id"] == source_session
            assert replayed["original_flow_id"] == "business"
            assert not any(
                key.lower() == "content-encoding"
                for key, _ in replayed["request"]["headers"]
            )
            assert store.get_flow(source_session, "business")["request"][
                "url"
            ].startswith("https://example.test")
            await asyncio.gather(*app_module.app.state.workbench.jobs.values())

    try:
        asyncio.run(run())
    finally:
        origin.shutdown()
        origin.server_close()
        thread.join()
