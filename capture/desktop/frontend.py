"""源码界面的内容版本，用于绕过桌面 WebKit 旧首页缓存。"""

import hashlib
from pathlib import Path

from config import ROOT


def frontend_revision(directory: Path = ROOT / "capture/web") -> str:
    """只散列前端源码，保留浏览器存储，不读取用户数据或大背景图片。"""
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".html", ".css", ".js"}:
            continue
        digest.update(path.relative_to(directory).as_posix().encode())
        digest.update(b"\0")
        with path.open("rb") as stream:
            while chunk := stream.read(64 * 1024):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()[:16]
