"""组合查询回归测试，覆盖统计、分页、Header 搜索和输入校验。"""

import json
import time

import pytest
from pydantic import ValidationError

from capture.backend.filters import FlowFilters
from capture.backend.storage import Store
from config import Settings


def seed_flows(store):
    """创建不同域名、状态、来源与类型的数据，检验条件之间是 AND。"""
    session = store.create_session(Settings().model_dump())
    cases = [
        (
            "a",
            "api.example.com",
            "POST",
            401,
            "complete",
            "capture",
            "application/json",
            150,
            2048,
        ),
        (
            "b",
            "api.example.com",
            "GET",
            200,
            "complete",
            "capture",
            "text/html",
            20,
            400,
        ),
        (
            "c",
            "example.com",
            "POST",
            404,
            "complete",
            "replay",
            "application/json",
            300,
            4096,
        ),
        (
            "d",
            "badexample.com",
            "POST",
            500,
            "error",
            "capture",
            "text/plain",
            500,
            100,
        ),
        (
            "e",
            "cdn.example.com",
            "CONNECT",
            None,
            "passthrough",
            "capture",
            "",
            None,
            0,
        ),
    ]
    for index, (
        flow_id,
        host,
        method,
        code,
        status,
        source,
        mime,
        duration,
        size,
    ) in enumerate(cases):
        store.save_flow(
            session,
            {
                "id": flow_id,
                "host": host,
                "url": f"https://{host}/items",
                "method": method,
                "code": code,
                "status": status,
                "source": source,
                "duration": duration,
                "size": size,
                "started": time.time() + index,
                "request": {"headers": [["X-Token", "Needle"]]},
                "response": {
                    "headers": [["Content-Type", mime], ["X-Trace", "Trace-123"]]
                },
                "reason": "socket timeout" if status == "error" else "",
            },
        )
    return session


def test_combined_filters_and_pagination(tmp_path):
    """精确域名、子域名、类型、耗时和大小共同筛选，统计不受分页影响。"""
    store = Store(tmp_path / "captures")
    session = seed_flows(store)
    result = store.list_flows(
        session,
        filters=FlowFilters(
            host="*.example.com",
            method="post",
            status_code="4xx",
            source="capture",
            content_type="JSON",
            min_duration=100,
            max_duration=200,
            min_size=1024,
        ),
    )
    assert [row["id"] for row in result["items"]] == ["a"]
    result = store.list_flows(
        session, filters=FlowFilters(status_code="400-499", limit=1)
    )
    assert result["total"] == 2
    assert result["items"][0]["id"] == "c"
    result = store.list_flows(
        session, filters=FlowFilters(status_code="400-499", limit=1, offset=1)
    )
    assert result["items"][0]["id"] == "a"
    assert (
        store.list_flows(session, filters=FlowFilters(host="example.com"))["total"] == 1
    )
    assert (
        store.list_flows(session, filters=FlowFilters(status="passthrough"))["items"][
            0
        ]["id"]
        == "e"
    )


def test_keyword_scopes_and_sql_parameters(tmp_path):
    """URL 与 Headers 范围独立，综合范围包括错误，输入不会作为 SQL。"""
    store = Store(tmp_path / "captures")
    session = seed_flows(store)
    assert store.list_flows(session, filters=FlowFilters(search="needle"))["total"] == 0
    assert (
        store.list_flows(
            session, filters=FlowFilters(search="X-Token: NEEDLE", scope="headers")
        )["total"]
        == 5
    )
    assert (
        store.list_flows(
            session,
            filters=FlowFilters(search="TRACE-123", scope="headers", source="replay"),
        )["total"]
        == 1
    )
    assert (
        store.list_flows(session, filters=FlowFilters(search="timeout", scope="all"))[
            "items"
        ][0]["id"]
        == "d"
    )
    assert (
        store.list_flows(
            session, filters=FlowFilters(search="' OR 1=1 --", scope="all")
        )["total"]
        == 0
    )
    assert store.list_flows(session, search="/items")["total"] == 5


def test_nested_and_or_groups_share_count_and_pages(tmp_path):
    """括号分组决定优先级，统计与分页使用同一表达式。"""
    store = Store(tmp_path / "captures")
    session = seed_flows(store)
    expression = {
        "operator": "or",
        "children": [
            {
                "operator": "and",
                "children": [
                    {"field": "host", "operator": "eq", "value": "api.example.com"},
                    {
                        "operator": "or",
                        "children": [
                            {"field": "method", "operator": "eq", "value": "POST"},
                            {"field": "status_code", "operator": "eq", "value": "200"},
                        ],
                    },
                ],
            },
            {
                "operator": "and",
                "children": [
                    {"field": "source", "operator": "eq", "value": "replay"},
                    {
                        "field": "response_header",
                        "operator": "contains",
                        "value": "X-Trace: Trace-123",
                    },
                ],
            },
        ],
    }
    filters = FlowFilters(expression=json.dumps(expression), limit=2)
    first = store.list_flows(session, filters=filters)
    second = store.list_flows(session, filters=filters.model_copy(update={"offset": 2}))
    assert first["total"] == second["total"] == 3
    assert {item["id"] for item in first["items"] + second["items"]} == {"a", "b", "c"}


def test_advanced_filter_validation_and_bound_values(tmp_path):
    """不接受空组、过深嵌套、未知字段或不匹配的操作符。"""
    store = Store(tmp_path / "captures")
    session = seed_flows(store)
    expression = {
        "operator": "and",
        "children": [{"field": "url", "operator": "contains", "value": "' OR 1=1 --"}],
    }
    assert (
        store.list_flows(
            session, filters=FlowFilters(expression=json.dumps(expression))
        )["total"]
        == 0
    )
    invalid = [
        {"operator": "and", "children": []},
        {
            "operator": "or",
            "children": [{"field": "unknown", "operator": "eq", "value": "x"}],
        },
        {
            "operator": "and",
            "children": [{"field": "duration", "operator": "contains", "value": "1"}],
        },
        {
            "operator": "and",
            "children": [{"field": "duration", "operator": "gte", "value": "nan"}],
        },
    ]
    nested = {"field": "url", "operator": "contains", "value": "items"}
    for _ in range(5):
        nested = {"operator": "and", "children": [nested]}
    invalid.append(nested)
    for item in invalid:
        with pytest.raises(ValidationError):
            FlowFilters(expression=json.dumps(item))


@pytest.mark.parametrize(
    "values",
    [
        {"status_code": "wat"},
        {"status_code": "500-400"},
        {"status_code": "4xx-500"},
        {"host": "https://example.com"},
        {"min_duration": 20, "max_duration": 10},
        {"min_size": -1},
    ],
)
def test_invalid_filters(values):
    """无效条件明确报错，避免悄悄返回空列表或扩大匹配范围。"""
    with pytest.raises(ValidationError):
        FlowFilters(**values)


def test_sorting_applies_before_pagination(tmp_path):
    """大小排序应覆盖整个会话；取消排序恢复默认时间顺序。"""
    store = Store(tmp_path)
    session = seed_flows(store)
    try:
        ascending = store.list_flows(
            session, filters=FlowFilters(sort_by="size", sort_order="asc", limit=2)
        )
        assert [row["id"] for row in ascending["items"]] == ["e", "d"]
        descending = store.list_flows(
            session,
            filters=FlowFilters(sort_by="size", sort_order="desc", offset=1, limit=2),
        )
        assert [row["id"] for row in descending["items"]] == ["a", "b"]
        oldest = store.list_flows(
            session, filters=FlowFilters(sort_by="started", sort_order="asc", limit=2)
        )
        assert [row["id"] for row in oldest["items"]] == ["a", "b"]
        default = store.list_flows(
            session, filters=FlowFilters(sort_by="size", sort_order="none", limit=2)
        )
        assert [row["id"] for row in default["items"]] == ["e", "d"]
        with pytest.raises(ValidationError):
            FlowFilters(sort_by="size; DROP TABLE flows")
    finally:
        store.close()
