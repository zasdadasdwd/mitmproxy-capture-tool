"""WebSocket 消息快照：只记录，不修改消息；控制每条和整连接的保存量。"""

import base64


def websocket_event(flow, settings, ended=False):
    """输出增量消息，计数放在可序列化 metadata，避免重复传输整条会话。"""
    state = flow.metadata.setdefault(
        "ws_capture", {"total": 0, "bytes": 0, "queued": 0}
    )
    summary = dict(
        state,
        state=("closed" if flow.websocket.close_code is not None else "interrupted")
        if ended
        else "open",
    )
    message = None
    if not ended and flow.websocket.messages:
        source = flow.websocket.messages[-1]
        state["total"] += 1
        summary["total"] = state["total"]
        if state["queued"] < settings.get("websocket_message_limit", 1000):
            remaining = (
                settings.get("websocket_body_limit", 4 * 1024 * 1024) - state["bytes"]
            )
            size = min(len(source.content), max(0, remaining), 64 * 1024)
            if size or not source.content:
                data = source.content[:size]
                message = {
                    "number": state["total"],
                    "timestamp": source.timestamp,
                    "from_client": source.from_client,
                    "type": "text" if source.is_text else "binary",
                    "size": len(source.content),
                    "body_b64": base64.b64encode(data).decode(),
                    "truncated": size < len(source.content),
                    "dropped": source.dropped,
                    "injected": source.injected,
                }
    if ended:
        summary.update(
            close_code=flow.websocket.close_code,
            close_reason=flow.websocket.close_reason,
        )
    return {
        "type": "websocket",
        "session_id": flow.metadata.get("capture_session"),
        "flow_id": flow.id,
        "summary": summary,
        "message": message,
    }


def accepted_websocket_event(flow, event):
    """只有成功进入采集队列的消息才占保存配额，丢事件可从序号缺口判断。"""
    if event["message"]:
        state = flow.metadata["ws_capture"]
        state["queued"] += 1
        state["bytes"] += len(base64.b64decode(event["message"]["body_b64"]))
