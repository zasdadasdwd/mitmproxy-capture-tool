"""请求对比只读取有限证据，保留顺序与缺失信息，不把预览相同当完整相同。"""

import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from .parameters import extract_parameters


class RequestComparison:
    """复用参数提取，并补充原始顺序、协议及保存字节前缀的比较。"""

    def __init__(self, store):
        self.store = store

    def raw_body(self, session, message):
        """只散列前 64 KiB；大正文、接收中及磁盘缺失均明确标记。"""
        if not message or not message.get("body_file"):
            return None, None
        filename = message["body_file"]
        if Path(filename).name != filename:
            return None, "正文文件路径无效"
        try:
            path = self.store.root / session / "bodies" / filename
            with path.open("rb") as source:
                prefix = source.read(65537)
            size = path.stat().st_size
        except OSError:
            return None, "已保存的正文文件不可读取"
        value = f"保存字节数={size}; 前缀 SHA256={hashlib.sha256(prefix[:65536]).hexdigest()}"
        return value, "原始正文只比较前 64 KiB，后续字节未比较" if len(
            prefix
        ) > 65536 else None

    def compare(self, session, flow_id, other_session, other_id):
        """返回有界差异与证据限制；兼容原 MCP compare 的字段与响应结构。"""
        left = self.store.get_flow(session, flow_id, preview=True)
        right = self.store.get_flow(other_session, other_id, preview=True)
        extracted = [extract_parameters(item) for item in (left, right)]
        maps = [
            {item["field"]: item["value"] for item in result["fields"]}
            for result in extracted
        ]
        warnings = [warning for result in extracted for warning in result["warnings"]]
        for side, (capture, sid) in enumerate(
            ((left, session), (right, other_session))
        ):
            values = maps[side]
            for key in ("method", "url", "code", "status"):
                if key in capture:
                    values[key] = capture[key]
            for part in ("original_request", "request", "response"):
                message = capture.get(part)
                values[part + ".present"] = message is not None
                if message is None:
                    continue
                values[part + ".http_version"] = message.get("http_version")
                values[part + ".headers_raw"] = json.dumps(
                    message.get("headers", []), ensure_ascii=False
                )
                if part != "response":
                    values[part + ".query_raw"] = urlsplit(
                        message.get("url", capture.get("url", ""))
                    ).query
                values[part + ".body_text"] = message.get("body_text", "")
                raw, warning = self.raw_body(sid, message)
                if raw is not None:
                    values[part + ".body_raw_prefix"] = raw
                if warning:
                    warnings.append(
                        f"{'左侧' if side == 0 else '右侧'} {part}: {warning}"
                    )
                if (
                    message.get("truncated")
                    or message.get("display_truncated")
                    or message.get("decode_error")
                ):
                    warnings.append(
                        f"{'左侧' if side == 0 else '右侧'} {part}: 正文不完整或仅比较预览，不能判断完整正文相同"
                    )
        before, after = maps
        changes = []
        for field in sorted(before.keys() | after.keys()):
            present_before, present_after = field in before, field in after
            if present_before == present_after and before.get(field) == after.get(
                field
            ):
                continue
            values = [before.get(field), after.get(field)]
            changes.append(
                {
                    "field": field,
                    "before": values[0][:512]
                    if isinstance(values[0], str)
                    else values[0],
                    "after": values[1][:512]
                    if isinstance(values[1], str)
                    else values[1],
                    "before_present": present_before,
                    "after_present": present_after,
                    "kind": "modified"
                    if present_before and present_after
                    else "removed"
                    if present_before
                    else "added",
                    "value_limited": any(
                        isinstance(value, str) and len(value) > 512 for value in values
                    ),
                }
            )
        return {
            "comparison_version": 2,
            "left": {
                "session_id": session,
                "flow_id": flow_id,
                "method": left.get("method"),
                "url": left.get("url"),
            },
            "right": {
                "session_id": other_session,
                "flow_id": other_id,
                "method": right.get("method"),
                "url": right.get("url"),
            },
            "changes": changes[:100],
            "total_changes": len(changes),
            "limited": len(changes) > 100,
            "warnings": list(dict.fromkeys(warnings)),
            "body_preview_bytes": 65536,
        }
