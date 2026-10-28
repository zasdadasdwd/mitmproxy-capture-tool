"""Web 应用组合根：装配生命周期、HTTP 路由、保护中间件和静态页面。"""

from fastapi import FastAPI, Request
from fastapi.responses import Response

from capture.backend.api import (
    analysis,
    certificate,
    events,
    links,
    observability,
    replay,
    sessions,
    system,
)
from capture.backend.context import lifespan, local_origin
from capture.backend.static import FrontendStaticFiles
from config import ROOT

app = FastAPI(title="Capture Workbench", lifespan=lifespan)


@app.middleware("http")
async def restrict_management(request: Request, call_next):
    """管理页面仅允许本机访问，并阻止跨站浏览器请求。"""
    host = request.headers.get("host", "")
    if host.split(":")[0] not in ("127.0.0.1", "localhost", "testserver"):
        return Response("管理界面仅允许本机访问", status_code=403)
    if not local_origin(request.headers.get("origin"), host):
        return Response("跨站请求被拒绝", status_code=403)
    return await call_next(request)


@app.exception_handler(FileNotFoundError)
async def missing_resource(request: Request, exc: FileNotFoundError):
    """不存在的会话或流量记录统一映射为 HTTP 404。"""
    return Response("记录不存在", status_code=404)


# API 必须先于根目录静态页面挂载。
for module in (
    system,
    sessions,
    replay,
    certificate,
    events,
    analysis,
    links,
    observability,
):
    app.include_router(module.router)

app.mount("/", FrontendStaticFiles(directory=ROOT / "capture/web", html=True), name="web")
