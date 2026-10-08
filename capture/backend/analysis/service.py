"""有界读取会话证据，返回候选关系而不是把时间相邻当作因果。"""

from .comparison import RequestComparison
from .parameters import extract_parameters, select_parameter, value_variants


class AnalysisService:
    """复用 Store 查询请求、追踪参数和比较报文，供 API 与 MCP 共用。"""

    def __init__(self, store):
        self.store = store

    def previous(self, session_id, target, limit=50, window_seconds=300):
        """按开始时间限定前序请求；最多读取 200 条、每条正文预览 64 KiB。"""
        started = target.get("started", 0)
        with self.store.connect(session_id) as db:
            ids = [
                row[0]
                for row in db.execute(
                    "SELECT id FROM flows WHERE started>=? AND started<? AND id!=? ORDER BY started DESC, id LIMIT ?",
                    (started - window_seconds, started, target["id"], limit + 1),
                )
            ]
        return [
            self.store.get_flow(session_id, id, preview=True) for id in ids[:limit]
        ], len(ids) > limit

    def trace(self, session_id, flow_id, field, limit=50, window_seconds=300):
        """搜索参数值的前序出现位置，提供路径、转换和范围限制。"""
        target = self.store.get_flow(session_id, flow_id, preview=True)
        extracted = extract_parameters(target)
        selected = select_parameter(extracted["fields"], field)
        previous, limited = self.previous(session_id, target, limit, window_seconds)
        variants = value_variants(selected["value"])
        matches = []
        warnings = list(extracted["warnings"])
        for source in previous:
            source_fields = extract_parameters(source)
            warnings.extend(source_fields["warnings"])
            for item in source_fields["fields"]:
                common = variants.keys() & value_variants(item["value"]).keys()
                if not common or not selected["value"]:
                    continue
                canonical = (
                    selected["value"] if selected["value"] in common else min(common)
                )
                # 响应只有在完成后才可能被后续请求读取。
                ended = source.get("started", 0) + (source.get("duration") or 0) / 1000
                available = not item["field"].startswith("response.") or (
                    source.get("status") == "complete"
                    and ended <= target.get("started", 0)
                )
                matches.append(
                    {
                        "flow_id": source["id"],
                        "field": item["field"],
                        "relation": "value_match",
                        "source_transform": value_variants(item["value"])[canonical],
                        "target_transform": variants[canonical],
                        "available_before_target": available,
                        "causality": "unconfirmed",
                    }
                )
                if len(matches) >= 100:
                    break
            if len(matches) >= 100:
                break
        if len(selected["value"]) < 4:
            warnings.append("值很短，偶然匹配的可能性较高")
        return {
            "target": {"session_id": session_id, "flow_id": flow_id, **selected},
            "candidates": matches,
            "generation_source": "unknown",
            "scope": {
                "scanned": len(previous),
                "scanned_request_ids": [item["id"] for item in previous],
                "window_seconds": window_seconds,
                "request_limit_reached": limited,
                "match_limit_reached": len(matches) >= 100,
                "body_preview_bytes": 65536,
            },
            "warnings": list(dict.fromkeys(warnings))[:30],
        }

    def chain(self, session_id, flow_id, limit=50, window_seconds=300):
        """明确记录的重放关系与按值匹配的候选关系分开返回。"""
        target = self.store.get_flow(session_id, flow_id, preview=True)
        previous, limited = self.previous(session_id, target, limit, window_seconds)
        target_fields = extract_parameters(
            {"request": target.get("request"), "url": target.get("url")}
        )
        wanted = {}
        for item in target_fields["fields"]:
            # 通用协议字段不能形成有意义的业务链路。
            if ".headers." in item["field"] and not any(
                word in item["field"] for word in ("authorization", "token", "csrf")
            ):
                continue
            if len(item["value"]) >= 4:
                for value in value_variants(item["value"]):
                    wanted.setdefault(value, item["field"])
        edges = []
        for source in previous:
            if source.get("status") != "complete":
                continue
            ended = source.get("started", 0) + (source.get("duration") or 0) / 1000
            if ended > target.get("started", 0):
                continue
            for item in extract_parameters({"response": source.get("response")})[
                "fields"
            ]:
                common = value_variants(item["value"]).keys() & wanted.keys()
                if common:
                    value = min(common)
                    edges.append(
                        {
                            "from": source["id"],
                            "to": flow_id,
                            "relation": "value_match",
                            "source_field": item["field"],
                            "target_field": wanted[value],
                            "causality": "unconfirmed",
                        }
                    )
                if len(edges) >= 100:
                    break
            if len(edges) >= 100:
                break
        explicit = []
        if target.get("original_flow_id"):
            explicit.append(
                {
                    "from": target["original_flow_id"],
                    "from_session": target.get("original_session_id"),
                    "to": flow_id,
                    "relation": "replayed_from",
                    "recorded": True,
                }
            )
        return {
            "target": {
                "session_id": session_id,
                "flow_id": flow_id,
                "url": target.get("url"),
            },
            "recorded_relations": explicit,
            "candidate_relations": edges,
            "executed_hooks": target.get("executed_hooks", []),
            "scope": {
                "scanned": len(previous),
                "scanned_request_ids": [item["id"] for item in previous],
                "request_limit_reached": limited,
                "relation_limit_reached": len(edges) >= 100,
                "body_preview_bytes": 65536,
            },
            "warnings": [
                "值匹配不是调用依赖；未匹配不表示没有依赖，正文仅分析 64 KiB 预览。"
            ],
        }

    def compare(self, session_id, flow_id, other_session_id, other_flow_id):
        """按同一证据模型比较请求，供 HTTP UI 和 MCP 使用。"""
        return RequestComparison(self.store).compare(
            session_id, flow_id, other_session_id, other_flow_id
        )
