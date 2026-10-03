"""公开 CA 下载与安装说明；绝不暴露私钥。"""

import asyncio
import hashlib
import ipaddress
import sys

from cryptography import x509
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from capture.backend.certificates import MacCertificateInstaller
from capture.backend.documents import certificate_page
from config import DATA, ROOT

router = APIRouter()
install_lock = asyncio.Lock()


class CertificateInstall(BaseModel):
    """绑定用户看到的证书指纹，防止确认期间证书被替换。"""

    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


@router.post("/api/certificate/macos/install")
async def install_macos_certificate(body: CertificateInstall, request: Request):
    """只接受本机同源操作，在后台线程等待系统钥匙串授权。"""
    try:
        local = request.client and ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        local = False
    if not local or request.headers.get("origin") not in {
        f"http://{request.headers.get('host')}",
        f"https://{request.headers.get('host')}",
    }:
        raise HTTPException(403, "证书安装需要从本机管理页面操作")
    if install_lock.locked():
        raise HTTPException(409, "正在等待系统授权，请勿重复安装")
    try:
        async with install_lock:
            fingerprint = await asyncio.to_thread(
                MacCertificateInstaller(
                    DATA / "certificates/mitmproxy-ca-cert.pem"
                ).install,
                body.sha256,
            )
    except FileNotFoundError as exc:
        raise HTTPException(404, "CA 尚未生成，请先启动代理") from exc
    except (ValueError, OSError, x509.ExtensionNotFound) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "installed": True,
        "sha256": fingerprint,
        "message": "已安装到登录钥匙串，并设为当前用户 SSL 信任",
    }


@router.get("/api/certificate")
def certificate():
    """只提供公开 CA 证书，不暴露包含私钥的 mitmproxy-ca.pem。"""
    path = DATA / "certificates/mitmproxy-ca-cert.pem"
    if not path.exists():
        raise HTTPException(404, "请先启动一次抓包，让引擎生成证书")
    return FileResponse(
        path, filename="capture-ca.pem", media_type="application/x-pem-file"
    )


@router.get("/api/certificate/info")
def certificate_info():
    """返回 CA 的 DER SHA-256 指纹，便于确认安装的是本实例证书。"""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    path = DATA / "certificates/mitmproxy-ca-cert.pem"
    if not path.exists():
        return {"available": False, "macos_install_supported": sys.platform == "darwin"}
    certificate = x509.load_pem_x509_certificate(path.read_bytes())
    fingerprint = hashlib.sha256(
        certificate.public_bytes(serialization.Encoding.DER)
    ).hexdigest()
    return {
        "available": True,
        "sha256": fingerprint,
        "macos_install_supported": sys.platform == "darwin",
    }


@router.get("/docs/certificate")
def certificate_document():
    """渲染安装说明，命令和代码可逐行复制，也可复制整段。"""
    return HTMLResponse(certificate_page())


@router.get("/docs/certificate/source")
def certificate_source():
    """继续提供原始 Markdown，便于分享或离线阅读。"""
    return FileResponse(
        ROOT / "capture/support/docs/证书安装.md",
        filename="证书安装.md",
        media_type="text/markdown; charset=utf-8",
    )
