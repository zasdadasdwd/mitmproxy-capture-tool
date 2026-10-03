"""macOS 用户钥匙串证书安装；只处理当前实例的公开 CA。"""

import hashlib
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization


class MacCertificateInstaller:
    """通过系统 security 工具导入 CA，并仅授予当前用户 SSL 信任。"""

    def __init__(self, path: Path):
        self.path = path

    def install(self, expected_sha256: str) -> str:
        """校验页面确认的指纹与 CA 有效期，转换 DER 后请求系统授权。"""
        if sys.platform != "darwin":
            raise ValueError("此功能仅支持运行在 macOS 上的管理服务")
        pem = self.path.read_bytes()
        if b"PRIVATE KEY" in pem:
            raise ValueError("证书文件包含私钥，拒绝导入")
        certificate = x509.load_pem_x509_certificate(pem)
        der = certificate.public_bytes(serialization.Encoding.DER)
        fingerprint = hashlib.sha256(der).hexdigest()
        if fingerprint != expected_sha256:
            raise ValueError("CA 已变化，请重新打开设置，核对指纹后重试")
        if not certificate.extensions.get_extension_for_class(
            x509.BasicConstraints
        ).value.ca:
            raise ValueError("当前文件不是 CA 证书")
        now = datetime.now(timezone.utc)
        if (
            not certificate.not_valid_before_utc
            <= now
            <= certificate.not_valid_after_utc
        ):
            raise ValueError("CA 尚未生效或已经过期")
        # DER 可被 macOS 钥匙串直接识别；临时目录仅当前用户可访问。
        with tempfile.TemporaryDirectory(prefix="capture-ca-") as folder:
            path = Path(folder) / "capture-ca.cer"
            path.write_bytes(der)
            try:
                result = subprocess.run(
                    [
                        "/usr/bin/security",
                        "add-trusted-cert",
                        "-r",
                        "trustRoot",
                        "-p",
                        "ssl",
                        "-k",
                        str(Path.home() / "Library/Keychains/login.keychain-db"),
                        str(path),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=90,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise ValueError("系统授权超时，请检查授权窗口后重试") from exc
        if result.returncode:
            detail = (result.stderr or result.stdout).strip()[-800:]
            raise ValueError(f"安装未完成，可能取消了授权或钥匙串已锁定：{detail}")
        return fingerprint
