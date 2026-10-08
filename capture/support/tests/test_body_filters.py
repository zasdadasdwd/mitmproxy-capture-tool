"""正文筛选验证：压缩响应、分组、旧会话与不阻塞采集写入。"""

import base64
import gzip
import json
import threading

import pytest

from capture.backend import storage
from capture.backend.filters import FlowFilters
from capture.backend.storage import Store
from config import Settings


def seed(store):
    session = store.create_session(Settings().model_dump())
    for index, (flow_id, body, encoding) in enumerate(
        [
            (
                "gzip",
                gzip.compress(b"x" * 70000 + b' {"token":"ResponseSecret"}'),
                "gzip",
            ),
            ("plain", b'{"message":"ordinary"}', "identity"),
            ("partial", b"saved fragment", "identity"),
            ("empty", b"", "identity"),
            ("pending", None, "identity"),
        ]
    ):
        response = (
            None
            if body is None
            else {
                "headers": [["Content-Encoding", encoding]],
                "body_b64": base64.b64encode(body).decode(),
                "truncated": flow_id == "partial",
            }
        )
        store.save_flow(
            session,
            {
                "id": flow_id,
                "url": "https://example.test/" + flow_id,
                "host": "example.test",
                "method": "POST",
                "started": index,
                "status": "complete" if response is not None else "pending",
                "request": {
                    "body_b64": base64.b64encode(b"RequestSecret").decode(),
                    "headers": [],
                },
                "response": response,
            },
        )
    return session


def condition(field, operator="contains", value="ResponseSecret"):
    return {"field": field, "operator": operator, "value": value}


def ids(result):
    return [row["id"] for row in result["items"]]


@pytest.mark.parametrize(
    "scope,term,expected",
    [
        ("response_body", "responsesecret", ["gzip"]),
        (
            "request_body",
            "requestsecret",
            ["pending", "empty", "partial", "plain", "gzip"],
        ),
        ("bodies", "ResponseSecret", ["gzip"]),
        ("all", "ResponseSecret", ["gzip"]),
        ("url", "ResponseSecret", []),
    ],
)
def test_body_scopes_and_historical_sessions(tmp_path, scope, term, expected):
    store = Store(tmp_path)
    session = seed(store)
    store.close()
    reopened = Store(tmp_path)
    try:
        result = reopened.list_flows(
            session, filters=FlowFilters(scope=scope, search=term)
        )
        assert ids(result) == expected
        assert result["total"] == len(expected)
        assert all(
            "request" not in row and "response" not in row for row in result["items"]
        )
    finally:
        reopened.close()


def test_advanced_body_groups_and_unknown_negative_values(tmp_path):
    store = Store(tmp_path)
    session = seed(store)
    try:
        expression = {
            "operator": "and",
            "children": [
                condition("request_body", value="RequestSecret"),
                {
                    "operator": "or",
                    "children": [
                        condition("response_body"),
                        condition("url", value="plain"),
                    ],
                },
            ],
        }
        filters = FlowFilters(expression=json.dumps(expression), limit=1)
        first = store.list_flows(session, filters=filters)
        assert first["total"] == 2 and ids(first) == ["plain"]
        assert ids(
            store.list_flows(session, filters=filters.model_copy(update={"offset": 1}))
        ) == ["gzip"]
        negative = {
            "operator": "and",
            "children": [condition("response_body", "not_contains")],
        }
        assert ids(
            store.list_flows(
                session, filters=FlowFilters(expression=json.dumps(negative))
            )
        ) == ["empty", "plain"]
    finally:
        store.close()


def test_body_decode_never_holds_capture_lock(tmp_path, monkeypatch):
    store = Store(tmp_path)
    session = seed(store)
    decode = storage.decode_body
    checked = []

    def unlocked_decode(*args):
        def acquire():
            acquired = store.lock.acquire(timeout=0.3)
            checked.append(acquired)
            if acquired:
                store.lock.release()

        thread = threading.Thread(target=acquire)
        thread.start()
        thread.join(timeout=1)
        assert checked[-1], "正文解压占用了采集锁"
        return decode(*args)

    monkeypatch.setattr(storage, "decode_body", unlocked_decode)
    try:
        assert (
            store.list_flows(
                session,
                filters=FlowFilters(scope="response_body", search="ResponseSecret"),
            )["total"]
            == 1
        )
        assert checked
    finally:
        store.close()


def test_normal_filters_do_not_read_bodies(tmp_path, monkeypatch):
    store = Store(tmp_path)
    session = seed(store)

    def forbidden(*args):
        raise AssertionError("URL 查询不应该读取正文")

    monkeypatch.setattr(Store, "body_contains", forbidden)
    try:
        assert ids(store.list_flows(session, filters=FlowFilters(search="gzip"))) == [
            "gzip"
        ]
    finally:
        store.close()


def test_body_file_cannot_escape_session_folder(tmp_path):
    secret = tmp_path / "outside.txt"
    secret.write_text("secret")
    result = Store.body_contains(
        tmp_path, json.dumps({"body_file": "../outside.txt"}), "secret"
    )
    assert result is None


def test_ui_and_mcp_query_endpoints_support_response_body(tmp_path):
    """列表 GET 与 MCP 查询使用的 POST 都接受响应正文范围，只返回摘要。"""
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from capture.backend.api import analysis, sessions

    store = Store(tmp_path)
    session = seed(store)
    app = FastAPI()
    app.include_router(analysis.router)
    app.include_router(sessions.router)
    app.state.workbench = SimpleNamespace(store=store)
    try:
        with TestClient(app) as client:
            result = client.get(
                f"/api/sessions/{session}/flows",
                params={"scope": "response_body", "search": "responsesecret"},
            )
            assert result.status_code == 200
            assert ids(result.json()) == ["gzip"]
            result = client.post(
                f"/api/analysis/{session}/search",
                json={
                    "filters": {"scope": "response_body", "search": "responsesecret"}
                },
            )
            assert result.status_code == 200
            assert ids(result.json()) == ["gzip"]
            assert result.json()["has_more"] is False
    finally:
        store.close()
