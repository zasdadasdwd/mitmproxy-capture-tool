"""请求对比保留原始顺序、缺失和预览边界；不修改原始证据。"""

import base64

from capture.backend.analysis.service import AnalysisService
from capture.backend.storage import Store
from config import Settings


def seed(store, session, fid, query="", headers=None, body=b"", response=None):
    store.save_flow(
        session,
        {
            "id": fid,
            "method": "POST",
            "url": "http://example.test/api" + query,
            "request": {
                "url": "http://example.test/api" + query,
                "headers": headers or [],
                "http_version": "HTTP/2.0",
                "body_b64": base64.b64encode(body).decode(),
            },
            "response": response,
        },
    )


def test_duplicate_headers_query_order_and_raw_encoding(tmp_path):
    store = Store(tmp_path)
    sid = store.create_session(Settings().model_dump())
    seed(store, sid, "a", "?x=%41&x=B&empty=", [("X-Repeat", "a"), ("X-Repeat", "b")])
    seed(store, sid, "b", "?empty=&x=A&x=B", [("X-Repeat", "b"), ("X-Repeat", "a")])
    result = AnalysisService(store).compare(sid, "a", sid, "b")
    fields = {item["field"] for item in result["changes"]}
    assert "request.headers.x-repeat[0]" in fields
    assert "request.query_raw" in fields
    assert "request.headers_raw" in fields
    assert "request.query.x[0]" not in fields
    assert store.get_flow(sid, "a")["request"]["headers"][0] == ["X-Repeat", "a"]


def test_missing_response_and_cross_session_json_large_integer(tmp_path):
    store = Store(tmp_path)
    a = store.create_session(Settings().model_dump())
    b = store.create_session(Settings().model_dump())
    seed(store, a, "a", body=b'{"id":9007199254740993,"gone":null}')
    seed(
        store,
        b,
        "b",
        body=b'{"id":9007199254740994}',
        response={"headers": [], "body_b64": ""},
    )
    result = AnalysisService(store).compare(a, "a", b, "b")
    changes = {item["field"]: item for item in result["changes"]}
    assert changes["request.body#/id"]["before"] == "9007199254740993"
    assert changes["request.body#/id"]["after"] == "9007199254740994"
    assert changes["request.body#/gone"]["before"] == "null"
    assert changes["request.body#/gone"]["after_present"] is False
    assert changes["response.present"]["before"] is False
    assert result["comparison_version"] == 2


def test_large_body_equal_prefix_cannot_claim_complete_equality(tmp_path):
    store = Store(tmp_path)
    sid = store.create_session(Settings().model_dump())
    seed(store, sid, "a", body=b"x" * 70000 + b"a")
    seed(store, sid, "b", body=b"x" * 70000 + b"b")
    result = AnalysisService(store).compare(sid, "a", sid, "b")
    assert result["total_changes"] == 0
    assert any("后续字节未比较" in warning for warning in result["warnings"])
    assert any("不能判断完整正文相同" in warning for warning in result["warnings"])


def test_binary_body_raw_prefix_and_result_limit(tmp_path):
    store = Store(tmp_path)
    sid = store.create_session(Settings().model_dump())
    seed(store, sid, "a", headers=[(f"x-{i}", "a") for i in range(130)], body=b"\xff")
    seed(store, sid, "b", headers=[(f"x-{i}", "b") for i in range(130)], body=b"\xfe")
    result = AnalysisService(store).compare(sid, "a", sid, "b")
    assert result["limited"]
    assert len(result["changes"]) == 100
    assert result["total_changes"] > 130
    # 二进制解码后均是替换字符，但原始字节摘要应有差异。
    assert any(item["field"] == "request.body_raw_prefix" for item in result["changes"])
