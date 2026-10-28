"""前端源码需重新验证，图片等二进制资源仍保留原静态缓存行为。"""

from pathlib import PurePosixPath

from fastapi.staticfiles import StaticFiles


class FrontendStaticFiles(StaticFiles):
    """保留 ETag/304，只禁止 HTML/CSS/JS 未验证就复用旧响应。"""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if path in {"", ".", "/"} or PurePosixPath(path).suffix.lower() in {
            ".html",
            ".css",
            ".js",
        }:
            response.headers["Cache-Control"] = "no-cache"
        return response
