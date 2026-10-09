"""目录分段匹配、外部代理校验与动态地址展示的回归验证。"""

import pytest
from pydantic import ValidationError

from capture.backend import network
from capture.backend.filters import FlowFilters
from capture.backend.storage import Store
from config import Settings


def test_directory_boundaries_and_sources(tmp_path):
    """目录包含子目录和查询参数，但不能误匹配相似名称或 Query 中的斜线。"""
    store = Store(tmp_path / "captures")
    session = store.create_session(Settings().model_dump())
    urls = [
        "http://www.host.com/am1",
        "https://www.host.com/am1/am2?a=1",
        "https://www.host.com/am1/am2?a=2",
        "http://www.host.com/am10",
        "http://www.host.com?next=/am1",
        "http://other.test/am1",
    ]
    for index, url in enumerate(urls):
        store.save_flow(
            session,
            {
                "id": str(index),
                "url": url,
                "host": "other.test" if index == 5 else "www.host.com",
                "status": "complete",
                "source": "replay" if index == 2 else "capture",
            },
        )
    rows = store.list_flows(
        session, filters=FlowFilters(host="www.host.com", path_prefix="/am1")
    )
    assert {row["id"] for row in rows["items"]} == {"0", "1", "2"}
    assert {
        row["id"]
        for row in store.list_flows(
            session,
            filters=FlowFilters(
                host="www.host.com", path_prefix="/am1/am2", source="replay"
            ),
        )["items"]
    } == {"2"}
    assert {
        "host": "www.host.com",
        "path": "/am1/am2",
        "count": 2,
    } in store.directories(session)
    store.close()


@pytest.mark.parametrize(
    "address",
    [
        "socks5://localhost:7890",
        "http://localhost",
        "http://localhost:8080",
        "http://localhost:7890/path",
        "",
    ],
)
def test_invalid_upstream_addresses(address):
    """拒绝不支持的代理协议、缺失端口以及代理指向自身。"""
    with pytest.raises(ValidationError):
        Settings(connection_mode="upstream", upstream_proxy=address)


def test_network_address_tracks_port_and_interface(monkeypatch):
    """动态读取 IP 和端口，区分仅本机与局域网监听，不展示固定旧地址。"""
    monkeypatch.setattr(network, "lan_ip", lambda: "192.168.1.20")
    assert network.proxy_addresses(Settings()) == {
        "lan_ip": "192.168.1.20",
        "lan_address": "192.168.1.20:8080",
        "listen_address": "127.0.0.1:8080",
        "lan_accessible": False,
    }
    assert (
        network.proxy_addresses(Settings(listen_host="0.0.0.0", listen_port=9090))[
            "lan_address"
        ]
        == "192.168.1.20:9090"
    )
    monkeypatch.setattr(network, "lan_ip", lambda: None)
    assert network.proxy_addresses(Settings())["lan_address"] is None


def test_directory_includes_tunnel_and_blocked_hosts(tmp_path):
    """无 HTTP 路径的记录也能按 host 查询，缓存更新和删除保持准确。"""
    store = Store(tmp_path / "captures")
    session = store.create_session(Settings().model_dump())
    store.directories(session)
    for flow in [
        {"id": "tunnel", "host": "tunnel.test", "url": "tunnel.test:443", "method": "CONNECT", "status": "tunnel"},
        {"id": "blocked", "host": "blocked.test", "url": "blocked.test:443", "method": "CONNECT", "status": "blocked"},
        {"id": "http", "host": "blocked.test", "url": "https://blocked.test/api", "status": "blocked"},
    ]:
        store.save_flow(session, flow)
    assert store.directories(session) == [
        {"host": "blocked.test", "path": "/", "count": 1},
        {"host": "blocked.test", "path": "/api", "count": 1},
        {"host": "tunnel.test", "path": "/", "count": 1},
    ]
    assert store.list_flows(session, filters=FlowFilters(host="tunnel.test", path_prefix="/"))["total"] == 1
    store.save_flow(session, {"id": "tunnel", "status": "complete"})
    assert store.directories(session)[-1]["count"] == 1
    store.delete_flows(session, ["tunnel"])
    assert all(item["host"] != "tunnel.test" for item in store.directories(session))
    store.close()


@pytest.mark.parametrize("mode, expected", [
    ("all", {"complete", "blocked", "passthrough", "error", "interrupted"}),
    ("hide_blocked_passthrough", {"complete", "error", "interrupted"}),
    ("hide_blocked", {"complete", "passthrough", "error", "interrupted"}),
    ("hide_passthrough", {"complete", "blocked", "error", "interrupted"}),
    ("errors", {"error"}),
])
def test_record_visibility_before_pagination(tmp_path, mode, expected):
    """表头筛选按记录状态而非 HTTP 码，与其他筛选先组合再分页。"""
    store = Store(tmp_path / "captures")
    session = store.create_session(Settings().model_dump())
    for index, status in enumerate(["complete", "blocked", "passthrough", "error", "interrupted"]):
        store.save_flow(session, {"id": status, "host": "example.test", "url": "https://example.test/api", "status": status, "code": 500 if status == "complete" else 200, "started": index})
    filters = {"record_visibility": mode, "host": "example.test", "sort_by": "started", "sort_order": "asc", "limit": 1}
    first = store.list_flows(session, filters=FlowFilters(**filters))
    assert first["total"] == len(expected)
    actual = {row["id"] for offset in range(len(expected)) for row in store.list_flows(session, filters=FlowFilters(**filters, offset=offset))["items"]}
    assert actual == expected
    assert store.list_flows(session, filters=FlowFilters(**{**filters, "host": "missing.test"}))["total"] == 0
    store.close()
