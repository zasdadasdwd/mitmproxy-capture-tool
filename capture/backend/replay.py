"""重放使用 httpx，生成新记录，不覆盖原请求，也不再次执行 hook。"""

import asyncio
import base64
import time
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field

from capture.engine.policy import is_blocked


class RequestEdit(BaseModel):
    """编辑重放的完整请求；正文使用 Base64 避免损坏二进制内容。"""

    url: str
    method: str
    headers: list[tuple[str, str]]
    body_b64: str = ""


class ReplayOptions(BaseModel):
    """校验选中请求、重放次数和间隔，限制一次任务的规模。"""

    ids: list[str] = Field(min_length=1, max_length=100)
    edit: RequestEdit | None = None
    count: int = Field(default=1, ge=1, le=20)
    interval: float = Field(default=0, ge=0, le=60)


def prepare_request(request: dict) -> dict:
    """转换为 httpx 参数，保留重复 Header，重新计算 Host 和 Content-Length。"""
    if request.get("truncated"):
        raise ValueError("请求正文不完整，不能直接重放或导出代码")
    url = httpx.URL(request["url"])
    if url.scheme not in ("http", "https") or not url.host:
        raise ValueError("只支持完整的 HTTP/HTTPS URL")
    body = base64.b64decode(request.get("body_b64", ""), validate=True)
    headers = request.get("headers", [])
    connection_headers = set()
    for name, value in headers:
        if name.lower() == "connection":
            connection_headers.update(item.strip().lower() for item in value.split(","))
    remove = connection_headers | {
        "host",
        "content-length",
        "connection",
        "proxy-connection",
        "proxy-authorization",
        "transfer-encoding",
        "upgrade",
        "keep-alive",
        "te",
        "trailer",
    }
    return {
        "url": str(url),
        "method": request["method"],
        "headers": [(k, v) for k, v in headers if k.lower() not in remove],
        "content": body,
    }


async def replay_batch(
    store,
    session_id,
    requests,
    settings,
    notify,
    options,
    owns_session,
    source_session=None,
):
    """顺序执行可取消的重放任务，保留来源 ID 和新的请求响应记录。"""
    # 第一版批量顺序发送，避免一次选择就突发大量并发请求。
    try:
        async with (
            httpx.AsyncClient(
                timeout=30,
                follow_redirects=False,
                trust_env=False,
                http2=True,  # HTTP/2 请求允许 ALPN 协商及服务器回退。
                proxy=settings.get("upstream_proxy")
                if settings.get("connection_mode") == "upstream"
                else None,
            ) as h2_client,
            httpx.AsyncClient(
                timeout=30,
                follow_redirects=False,
                trust_env=False,
                http2=False,
                proxy=settings.get("upstream_proxy")
                if settings.get("connection_mode") == "upstream"
                else None,
            ) as h1_client,
        ):
            for _ in range(options.count):
                for original_id, request in requests:
                    flow = {
                        "id": uuid4().hex,
                        "original_flow_id": original_id,
                        "original_session_id": source_session,
                        "source": "replay",
                        "started": time.time(),
                        "status": "pending",
                        "host": httpx.URL(request["url"]).host,
                        "url": request["url"],
                        "method": request["method"],
                        "request": dict(request),
                        "policy_version": settings["version"],
                    }
                    await asyncio.to_thread(store.save_flow, session_id, flow)
                    notify({"type": "flows", "session_id": session_id})
                    try:
                        if is_blocked(flow["host"], settings):
                            flow.update(
                                status="blocked", reason="重放目标命中域名拒绝列表"
                            )
                        else:
                            original_version = request.get("http_version")
                            # 两个连接池隔离 ALPN，HTTP/1 请求不会复用已协商的 HTTP/2 连接。
                            enable_h2 = original_version not in ("HTTP/1.0", "HTTP/1.1")
                            client = h2_client if enable_h2 else h1_client
                            prepared = prepare_request(request)
                            outbound = client.build_request(**prepared)
                            # 保存实际发送的头部和协议，避免详情仍显示旧 Host/长度/HTTP2。
                            flow["original_request"] = dict(request)
                            flow["request"] = {
                                **request,
                                "url": str(outbound.url),
                                "headers": list(outbound.headers.multi_items()),
                                "http_version": None,  # 协商成功后填入实际发送版本。
                            }
                            flow["replay_transport"] = {
                                "client": "httpx",
                                "original_http_version": original_version,
                                "http_version_changed": None,
                                "http2_enabled": enable_h2,
                                "tls_fingerprint_preserved": False,
                            }
                            response = await client.send(outbound, stream=True)
                            # HTTP/1.0 响应并不代表发送了 HTTP/1.0 请求；httpx 使用 HTTP/1.1。
                            actual_version = (
                                "HTTP/2.0"
                                if response.http_version in ("HTTP/2", "HTTP/2.0")
                                else "HTTP/1.1"
                            )
                            normalized_original = (
                                "HTTP/2.0"
                                if original_version == "HTTP/2"
                                else original_version
                            )
                            flow["request"]["http_version"] = actual_version
                            flow["replay_transport"].update(
                                actual_http_version=actual_version,
                                http_version_changed=normalized_original
                                != actual_version
                                if original_version
                                else None,
                            )
                            try:
                                body = bytearray()
                                size = 0
                                async for chunk in response.aiter_raw():
                                    size += len(chunk)
                                    remaining = settings["body_limit"] - len(body)
                                    if remaining > 0:
                                        body.extend(chunk[:remaining])
                                flow.update(
                                    status="complete",
                                    code=response.status_code,
                                    size=size,
                                    response={
                                        "headers": list(response.headers.multi_items()),
                                        "body_b64": base64.b64encode(body).decode(),
                                        "body_size": size,
                                        "truncated": size > len(body),
                                        "http_version": response.http_version,
                                    },
                                )
                            finally:
                                await response.aclose()
                    except (httpx.HTTPError, ValueError) as exc:
                        flow.update(status="error", reason=str(exc))
                    flow["duration"] = round((time.time() - flow["started"]) * 1000, 2)
                    await asyncio.to_thread(store.save_flow, session_id, flow)
                    notify({"type": "flows", "session_id": session_id})
                    if options.interval:
                        await asyncio.sleep(options.interval)
    except asyncio.CancelledError:
        if "flow" in locals() and flow["status"] == "pending":
            flow.update(status="interrupted", reason="重放已取消")
            await asyncio.to_thread(store.save_flow, session_id, flow)
        raise
    finally:
        if owns_session:
            await asyncio.to_thread(store.finish, session_id)
        notify({"type": "sessions"})
