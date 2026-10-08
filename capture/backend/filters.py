"""组合筛选模型及 SQL 条件；所有用户输入都通过参数绑定。"""

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from capture.backend.advanced_filters import compile_expression, parse_expression
from capture.engine.policy import normalize_pattern


class FlowFilters(BaseModel):
    """列表和批量选择共用筛选；高级条件树与快捷条件做 AND。"""

    search: str = Field(default="", max_length=500)
    scope: Literal[
        "url", "headers", "request_body", "response_body", "bodies", "all"
    ] = "url"
    host: str = ""
    path_prefix: str = Field(default="", max_length=2000)
    method: str = ""
    status_code: str = ""
    status: Literal[
        "",
        "pending",
        "receiving",
        "complete",
        "blocked",
        "passthrough",
        "error",
        "interrupted",
    ] = ""
    source: Literal["", "capture", "replay"] = ""
    content_type: str = Field(default="", max_length=200)
    min_duration: float | None = Field(default=None, ge=0)
    max_duration: float | None = Field(default=None, ge=0)
    min_size: int | None = Field(default=None, ge=0)
    started_after: float | None = Field(default=None, ge=0)
    started_before: float | None = Field(default=None, ge=0)
    expression: str = Field(default="", max_length=12000)
    # 排序字段采用白名单；与分页共用，避免仅排序当前页。
    sort_by: Literal["started", "size"] = "started"
    sort_order: Literal["none", "asc", "desc"] = "none"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=200, ge=1, le=500)

    def needs_body_search(self):
        """只有显式选择正文范围或正文分组条件时才读取文件。"""
        if self.search and self.scope in {
            "request_body",
            "response_body",
            "bodies",
            "all",
        }:
            return True
        if not self.expression:
            return False

        def visit(node):
            if hasattr(node, "children"):
                return any(visit(child) for child in node.children)
            return node.field in {"request_body", "response_body"}

        return visit(parse_expression(self.expression))

    @field_validator("host")
    @classmethod
    def validate_host(cls, value):
        """域名采用精确或 *. 子域名规则，与连接策略语义一致。"""
        return normalize_pattern(value) if value.strip() else ""

    @field_validator("method")
    @classmethod
    def validate_method(cls, value):
        """允许标准及自定义 HTTP 方法，拒绝无效字符。"""
        value = value.strip().upper()
        if value and not re.fullmatch(r"[A-Z-]{1,30}", value):
            raise ValueError("方法应为 GET、POST 等 HTTP 方法")
        return value

    @field_validator("status_code")
    @classmethod
    def validate_code(cls, value):
        """支持 200、4xx、400-499，校验区间后再交给 SQL。"""
        value = value.strip().lower()
        if not value:
            return value
        if not re.fullmatch(r"[1-5](?:\d{2}|xx)(?:-[1-5]\d{2})?", value) or (
            "xx" in value and "-" in value
        ):
            raise ValueError("状态码使用 200、4xx 或 400-499")
        if "-" in value and int(value[:3]) > int(value[4:]):
            raise ValueError("状态码区间起点不能大于终点")
        return value

    @model_validator(mode="after")
    def validate_duration(self):
        """避免耗时上下限颠倒导致不易察觉的空结果。"""
        if (
            self.min_duration is not None
            and self.max_duration is not None
            and self.min_duration > self.max_duration
        ):
            raise ValueError("最小耗时不能大于最大耗时")
        if self.expression:
            parse_expression(self.expression)
        return self


def build_conditions(filters: FlowFilters) -> tuple[str, list]:
    """生成固定结构的 WHERE 及绑定参数，统计和分页使用同一条件。"""
    conditions, parameters = [], []
    header_search = """EXISTS (
        SELECT 1 FROM json_each(json_extract(flows.detail, '$.request.headers')) h
        WHERE instr(lower(json_extract(h.value, '$[0]') || ': ' || json_extract(h.value, '$[1]')), lower(?)) > 0
        UNION ALL
        SELECT 1 FROM json_each(json_extract(flows.detail, '$.response.headers')) h
        WHERE instr(lower(json_extract(h.value, '$[0]') || ': ' || json_extract(h.value, '$[1]')), lower(?)) > 0
    )"""
    if filters.search:
        keyword_parts = []
        if filters.scope in ("url", "all"):
            keyword_parts.append(
                "(instr(lower(url), lower(?)) > 0 OR instr(lower(host), lower(?)) > 0)"
            )
            parameters.extend([filters.search] * 2)
        if filters.scope in ("headers", "all"):
            keyword_parts.append(header_search)
            parameters.extend([filters.search] * 2)
        for section in ("request", "response"):
            if filters.scope in (f"{section}_body", "bodies", "all"):
                keyword_parts.append(
                    f"body_contains(json_extract(flows.detail, '$.{section}'), ?)"
                )
                parameters.append(filters.search)
        if filters.scope == "all":
            keyword_parts.append(
                "instr(lower(coalesce(json_extract(detail, '$.reason'), '')), lower(?)) > 0"
            )
            parameters.append(filters.search)
        conditions.append("(" + " OR ".join(keyword_parts) + ")")
    if filters.host:
        if filters.host.startswith("*."):
            suffix = filters.host[1:]
            conditions.append("substr(lower(host), -?) = ?")
            parameters.extend([len(suffix), suffix])
        else:
            conditions.append("lower(host) = ?")
            parameters.append(filters.host)
    if filters.path_prefix and filters.path_prefix != "/":
        # 去掉 scheme 和 authority，再以路径分段边界匹配；/am1 不命中 /am10。
        clean_url = (
            "substr(url, 1, min(instr(url || '?', '?'), instr(url || '#', '#')) - 1)"
        )
        rest = f"substr({clean_url}, instr({clean_url}, '://') + 3)"
        path = f"substr({rest}, instr({rest}, '/'))"
        prefix = filters.path_prefix.rstrip("/")
        conditions.append(
            f"instr(url, '://') > 0 AND instr({rest}, '/') > 0 AND substr({path}, 1, ?) = ? AND substr({path}, ?, 1) IN ('', '/', '?', '#')"
        )
        parameters.extend([len(prefix), prefix, len(prefix) + 1])
    for column, value in (
        ("method", filters.method),
        ("status", filters.status),
        ("source", filters.source),
    ):
        if value:
            conditions.append(f"{column} = ?")
            parameters.append(value)
    if filters.status_code:
        value = filters.status_code
        if "xx" in value:
            start, end = int(value[0]) * 100, int(value[0]) * 100 + 99
        elif "-" in value:
            start, end = map(int, value.split("-"))
        else:
            start = end = int(value)
        conditions.append("code BETWEEN ? AND ?")
        parameters.extend([start, end])
    if filters.content_type:
        conditions.append("""EXISTS (
            SELECT 1 FROM json_each(json_extract(detail, '$.response.headers')) h
            WHERE lower(json_extract(h.value, '$[0]')) = 'content-type'
            AND instr(lower(json_extract(h.value, '$[1]')), lower(?)) > 0
        )""")
        parameters.append(filters.content_type)
    for condition, value in (
        ("duration >= ?", filters.min_duration),
        ("duration <= ?", filters.max_duration),
        ("size >= ?", filters.min_size),
        ("started >= ?", filters.started_after),
        ("started <= ?", filters.started_before),
    ):
        if value is not None:
            conditions.append(condition)
            parameters.append(value)
    if filters.expression:
        advanced_sql, advanced_values = compile_expression(
            parse_expression(filters.expression)
        )
        conditions.append(f"({advanced_sql})")
        parameters.extend(advanced_values)
    return ("WHERE " + " AND ".join(conditions) if conditions else ""), parameters
