"""MCP 通过本机管理 API 访问数据，复用工作台的校验与任务管理。"""

from urllib.parse import quote, urlsplit

import httpx


class WorkbenchClient:
    """持有可复用的异步 HTTP 连接，禁止代理环境变量和跨站重定向。"""

    def __init__(self, base_url, transport=None):
        url = urlsplit(base_url)
        if (
            url.scheme != "http"
            or url.hostname not in ("localhost", "127.0.0.1")
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in ("", "/")
        ):
            raise ValueError("工作台地址必须是本机 http://127.0.0.1:端口")
        self.http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            trust_env=False,
            follow_redirects=False,
            timeout=30,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            transport=transport,
        )

    @staticmethod
    def path(*parts):
        """逐段编码会话与请求 ID，禁止把标识拼接成额外的 API 路径。"""
        for part in parts:
            if not part or part in (".", "..") or "/" in part or "\\" in part:
                raise ValueError("无效的会话或请求标识")
        return "/".join(quote(part, safe="") for part in parts)

    async def request(self, method, path, **kwargs):
        try:
            response = await self.http.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise ValueError(
                "工作台读取超时，请缩小筛选范围；写操作勿盲目重试，先查询状态"
            ) from exc
        except httpx.RequestError as exc:
            raise ValueError(
                "无法连接天机阁工作台，请确认 main.py 或 app_main.py 已启动及 API 地址正确"
            ) from exc
        if response.is_error:
            try:
                message = response.json().get("detail", "API 请求失败")
            except ValueError:
                message = "API 请求失败"
            raise ValueError(f"工作台 API {response.status_code}: {message}")
        return response.json()

    async def code(self, session_id, flow_id, format, max_bytes=400000):
        """流式读取单条导出代码；拒绝过大输出，不截断成无法运行的半段命令。"""
        try:
            async with self.http.stream(
                "POST",
                "/api/sessions/" + self.path(session_id, "export"),
                json={"ids": [flow_id], "format": format},
            ) as response:
                if response.is_error:
                    await response.aread()
                    raise ValueError(
                        f"代码生成失败（{response.status_code}），请确认请求及正文完整"
                    )
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) > max_bytes:
                        raise ValueError(
                            "代码超过 MCP 输出上限，请使用工作台详情复制或文件导出"
                        )
                    content.extend(chunk)
                return content.decode("utf-8")
        except httpx.RequestError as exc:
            raise ValueError(
                "代码读取失败，请确认工作台运行；不会发送目标请求"
            ) from exc

    async def flow(self, session_id, flow_id, preview=True):
        return await self.request(
            "GET",
            "/api/sessions/" + self.path(session_id, "flows", flow_id),
            params={"preview": preview},
        )

    async def close(self):
        await self.http.aclose()
