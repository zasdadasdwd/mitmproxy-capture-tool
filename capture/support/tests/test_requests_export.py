"""requests 导出格式与原始请求一致性测试，不向外部服务器发送请求。"""

import base64
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from capture.backend.api.replay import router
from capture.backend.export import requests_lines, write_export


def example_flow(body=b"", headers=None):
    """使用含重复 Query、引号和编码表单的合成请求。"""
    return {
        "request": {
            "method": "POST",
            "url": "https://example.test/api?tag=a&tag=b&signature=x%2By%3D",
            "headers": headers
            if headers is not None
            else [
                ("Content-Type", "application/x-www-form-urlencoded"),
                ("X-Quoted", "it's a test"),
                ("Content-Length", str(len(body))),
            ],
            "body_b64": base64.b64encode(body).decode(),
        }
    }


def load_script(monkeypatch, flows):
    """执行生成脚本的定义，使用假 requests 确认导入不会直接发送请求。"""
    module = ModuleType("requests")
    module.request = Mock(
        return_value=SimpleNamespace(
            url="https://example.test/api", status_code=200, content=b"ok", text="ok"
        )
    )
    monkeypatch.setitem(sys.modules, "requests", module)
    script = "\n".join(requests_lines(iter(flows))) + "\n"
    namespace = {"__name__": "export_under_test"}
    exec(compile(script, "capture.py", "exec"), namespace)  # noqa: S102 - 仅执行合成请求生成的代码。
    module.request.assert_not_called()
    return script, namespace, module


@pytest.mark.parametrize(
    "body",
    [
        b"body=%7B%22transParam%22%3A%22a%2Bb%22%7D",
        '{"name":"中文","id":"123"}'.encode(),
        b"line1\r\nline2\\'\"\x00",
        b"\xff\xfe\x00binary",
        b"",
    ],
)
def test_single_requests_script_preserves_bytes_and_template(monkeypatch, body):
    """正文及 Query 不重新编码，UTF-8 使用字符串 .encode()，二进制用字节字面量。"""
    script, namespace, module = load_script(monkeypatch, [example_flow(body)])
    assert "def build_request_params():" in script
    assert "def send_request(params=None):" in script
    assert '"url": ' in script
    assert '"headers": {\n' in script
    params = namespace["build_request_params"]()
    assert params["data"] == body
    assert params["url"] == example_flow()["request"]["url"]
    assert params["headers"]["X-Quoted"] == "it's a test"
    assert "Content-Length" not in params["headers"]
    assert params["timeout"] == 30
    assert params["allow_redirects"] is False
    if body != b"\xff\xfe\x00binary":
        assert ".encode()" in script
    namespace["send_request"]()
    assert module.request.call_args.kwargs == params


def test_batch_is_sequential_and_params_can_be_edited_independently(monkeypatch):
    """批量沿用 REQUESTS 格式，构建函数复制头部，不改变原始请求模板。"""
    flows = [example_flow(b"first"), example_flow(b"second")]
    script, namespace, module = load_script(monkeypatch, flows)
    assert "REQUESTS = [" in script
    edited = namespace["build_request_params"](0)
    edited["headers"]["X-Quoted"] = "changed"
    assert namespace["REQUESTS"][0]["headers"]["X-Quoted"] == "it's a test"
    namespace["send_all"]()
    assert [call.kwargs["data"] for call in module.request.call_args_list] == [
        b"first",
        b"second",
    ]


@pytest.mark.parametrize(
    "headers",
    [
        [("X-Test", "one"), ("X-Test", "two")],
        [("X-Test", "one"), ("x-test", "two")],
    ],
)
def test_repeated_headers_cannot_be_silently_lost(headers):
    """requests 使用字典，重复字段应明确提示另一种导出格式。"""
    with pytest.raises(ValueError, match="重复请求头"):
        list(requests_lines([example_flow(headers=headers)]))


def test_truncated_or_missing_http_request_is_rejected(tmp_path):
    """不完整正文与 TLS 连接记录不能生成看似完整的可运行请求。"""
    flow = example_flow(b"partial")
    flow["request"]["truncated"] = True
    with pytest.raises(ValueError, match="不完整"):
        list(requests_lines([flow]))
    store = SimpleNamespace(get_flow=lambda *_: {"request": None})
    with pytest.raises(ValueError, match="仅支持 HTTP"):
        write_export(store, "session", ["flow"], "requests", tmp_path / "capture.py")


def test_requests_download_endpoint_and_batch_writer(tmp_path, monkeypatch):
    """API 接受新格式并下载 .py，逐条读取记录且下载后清理临时文件。"""
    flows = {"one": example_flow(b"first"), "two": example_flow(b"second")}
    store = SimpleNamespace(get_flow=Mock(side_effect=lambda _, key: flows[key]))
    target = tmp_path / "capture.py"
    write_export(store, "session", ["one", "two"], "requests", target)
    assert store.get_flow.call_count == 2
    assert target.read_text() == "\n".join(requests_lines(flows.values())) + "\n"
    app = FastAPI()
    app.include_router(router)
    app.state.workbench = SimpleNamespace(store=store)
    with TestClient(app) as client:
        result = client.post(
            "/api/sessions/session/export", json={"ids": ["one"], "format": "requests"}
        )
        assert result.status_code == 200
        assert 'filename="capture.py"' in result.headers["content-disposition"]
        script, _, _ = load_script(monkeypatch, [flows["one"]])
        assert result.text == script
        compile(result.text, "capture.py", "exec")
        flows["one"]["request"]["headers"] = [("X-Test", "one"), ("x-test", "two")]
        result = client.post(
            "/api/sessions/session/export", json={"ids": ["one"], "format": "requests"}
        )
        assert result.status_code == 400
        assert "重复请求头" in result.json()["detail"]
