"""高级筛选的显式分组语法与安全 SQL 编译。"""

from __future__ import annotations

import math
import re
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from capture.engine.policy import normalize_pattern


class FilterCondition(BaseModel):
    """单个字段比较；字段和操作符都只能从白名单选择。"""

    field: Literal[
        "host",
        "url",
        "method",
        "status_code",
        "status",
        "source",
        "content_type",
        "request_header",
        "response_header",
        "request_body",
        "response_body",
        "reason",
        "duration",
        "size",
    ]
    operator: Literal["eq", "neq", "contains", "not_contains", "gte", "lte"]
    value: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def check_operator(self):
        allowed = {
            "host": {"eq", "neq", "contains", "not_contains"},
            "url": {"contains", "not_contains"},
            "method": {"eq", "neq"},
            "status_code": {"eq", "neq"},
            "status": {"eq", "neq"},
            "source": {"eq", "neq"},
            "content_type": {"contains", "not_contains"},
            "request_header": {"contains", "not_contains"},
            "response_header": {"contains", "not_contains"},
            "request_body": {"contains", "not_contains"},
            "response_body": {"contains", "not_contains"},
            "reason": {"contains", "not_contains"},
            "duration": {"gte", "lte"},
            "size": {"gte", "lte"},
        }
        self.value = self.value.strip()
        if not self.value or self.operator not in allowed[self.field]:
            raise ValueError("字段、比较方式或条件值无效")
        if self.field == "host" and self.operator in {"eq", "neq"}:
            self.value = normalize_pattern(self.value)
        elif self.field == "method":
            self.value = self.value.upper()
            if not re.fullmatch(r"[A-Z-]{1,30}", self.value):
                raise ValueError("HTTP 方法无效")
        elif self.field == "status_code":
            value = self.value.lower()
            if not re.fullmatch(r"[1-5](?:\d{2}|xx)(?:-[1-5]\d{2})?", value) or (
                "xx" in value and "-" in value
            ):
                raise ValueError("状态码使用 200、4xx 或 400-499")
            if "-" in value and int(value[:3]) > int(value[4:]):
                raise ValueError("状态码区间起点不能大于终点")
            self.value = value
        elif self.field == "duration":
            try:
                number = float(self.value)
                if not math.isfinite(number) or number < 0:
                    raise ValueError
            except ValueError as exc:
                raise ValueError("耗时必须是非负数字") from exc
        elif self.field == "size":
            if not self.value.isdecimal():
                raise ValueError("大小必须是非负整数")
        elif self.field == "status" and self.value not in {
            "pending",
            "receiving",
            "complete",
            "blocked",
            "passthrough",
            "error",
            "interrupted",
        }:
            raise ValueError("记录状态无效")
        elif self.field == "source" and self.value not in {"capture", "replay"}:
            raise ValueError("来源无效")
        return self


class FilterGroup(BaseModel):
    """同组子项由同一个 AND/OR 连接；嵌套组明确表示括号。"""

    operator: Literal["and", "or"] = "and"
    children: list[FilterCondition | FilterGroup] = Field(min_length=1)


def parse_expression(source: str) -> FilterGroup:
    """限制层级、组数和条件数，避免过大的递归查询。"""
    group = FilterGroup.model_validate_json(source)
    groups = conditions = 0

    def visit(node, depth):
        nonlocal groups, conditions
        if isinstance(node, FilterCondition):
            conditions += 1
            return
        groups += 1
        if depth > 4:
            raise ValueError("筛选分组最多嵌套 4 层")
        for child in node.children:
            visit(child, depth + 1)

    visit(group, 1)
    if groups > 15 or conditions > 30 or not conditions:
        raise ValueError("筛选最多包含 15 个组和 30 个条件")
    return group


def compile_expression(group: FilterGroup) -> tuple[str, list]:
    """仅拼接静态 SQL 片段，所有条件值都走 SQLite 参数绑定。"""

    def leaf(condition):
        field, op, value = condition.field, condition.operator, condition.value
        negative = op in {"neq", "not_contains"}
        if field in {"request_body", "response_body"}:
            section = "request" if field == "request_body" else "response"
            sql = f"body_contains(json_extract(flows.detail, '$.{section}'), ?)"
            return (f"NOT ({sql})" if negative else sql), [value]
        if field == "status_code":
            if "xx" in value:
                start, end = int(value[0]) * 100, int(value[0]) * 100 + 99
            elif "-" in value:
                start, end = map(int, value.split("-"))
            else:
                start = end = int(value)
            sql = "flows.code BETWEEN ? AND ?"
            return (f"flows.code IS NOT NULL AND NOT ({sql})" if negative else sql), [
                start,
                end,
            ]
        if field in {"duration", "size"}:
            column = f"flows.{field}"
            return f"{column} {'>=' if op == 'gte' else '<='} ?", [
                float(value) if field == "duration" else int(value)
            ]
        if field in {"request_header", "response_header", "content_type"}:
            section = (
                "response"
                if field in {"response_header", "content_type"}
                else "request"
            )
            headers = f"json_each(json_extract(flows.detail, '$.{section}.headers'))"
            if field == "content_type":
                check = "lower(json_extract(h.value, '$[0]')) = 'content-type' AND instr(lower(json_extract(h.value, '$[1]')), lower(?)) > 0"
            else:
                check = "instr(lower(json_extract(h.value, '$[0]') || ': ' || json_extract(h.value, '$[1]')), lower(?)) > 0"
            sql = f"EXISTS (SELECT 1 FROM {headers} h WHERE {check})"
            return (f"NOT ({sql})" if negative else sql), [value]
        if field == "host" and op in {"eq", "neq"} and value.startswith("*."):
            suffix = value[1:]
            sql, parameters = "substr(lower(flows.host), -?) = ?", [len(suffix), suffix]
        elif field in {"host", "method", "status", "source"} and op in {"eq", "neq"}:
            sql, parameters = f"lower(flows.{field}) = lower(?)", [value]
        else:
            column = (
                "coalesce(json_extract(flows.detail, '$.reason'), '')"
                if field == "reason"
                else f"flows.{field}"
            )
            sql, parameters = f"instr(lower({column}), lower(?)) > 0", [value]
        return (f"NOT ({sql})" if negative else sql), parameters

    def compile_node(node):
        if isinstance(node, FilterCondition):
            return leaf(node)
        parts, parameters = [], []
        for child in node.children:
            sql, values = compile_node(child)
            parts.append(f"({sql})")
            parameters.extend(values)
        return f" {node.operator.upper()} ".join(parts), parameters

    return compile_node(group)
