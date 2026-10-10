"""macOS 用户钥匙串证书安装；只处理当前实例的公开 CA。"""

import hashlib
import json
import shlex
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization


class MacCertificateInstaller:
    """通过系统 security 工具导入 CA，并授予系统 SSL 信任。"""

    def __init__(self, path: Path):
        self.path = path

    def install(self, expected_sha256: str) -> str:
        """兼容旧接口：校验并安装 CA，返回 DER SHA-256 指纹。"""
        result = self.install_with_feedback(expected_sha256)
        if not result["installed"]:
            raise ValueError(result["message"])
        return result["sha256"]

    def _validated_der(self, expected_sha256: str) -> tuple[bytes, str]:
        """校验当前公开 CA 的指纹、CA 标记和有效期，再返回 DER。"""
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
        now = datetime.now(UTC)
        if (
            not certificate.not_valid_before_utc
            <= now
            <= certificate.not_valid_after_utc
        ):
            raise ValueError("CA 尚未生效或已经过期")
        return der, fingerprint

    def install_with_feedback(self, expected_sha256: str) -> dict:
        """安装后独立检查系统 SSL 信任；必要时打开钥匙串供用户确认。"""
        der, fingerprint = self._validated_der(expected_sha256)
        installed = False
        install_error = ""
        with tempfile.TemporaryDirectory(prefix="capture-ca-") as folder:
            path = Path(folder) / "capture-ca.cer"
            path.write_bytes(der)
            install_command = [
                "/usr/bin/security",
                "add-trusted-cert",
                "-r",
                "trustRoot",
                "-d",
                "-p",
                "ssl",
                "-k",
                "/Library/Keychains/System.keychain",
                str(path),
            ]
            # 管理员凭据由系统授权对话框处理；shlex.quote 防止路径被 shell 解释。
            apple_script = (
                "do shell script "
                f"{json.dumps(shlex.join(install_command), ensure_ascii=True)} "
                "with administrator privileges"
            )
            try:
                result = subprocess.run(
                    ["/usr/bin/osascript", "-e", apple_script],
                    capture_output=True,
                    text=True,
                    timeout=90,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                install_error = "系统授权超时"
            except OSError as exc:
                install_error = f"无法运行系统安装命令：{exc}"
            else:
                installed = result.returncode == 0
                if not installed:
                    detail = (result.stderr or result.stdout).strip()[-800:]
                    install_error = f"安装未完成，可能取消了授权或钥匙串已锁定：{detail}".rstrip()

            # 查询 System.keychain 中证书的 SSL 信任状态，不使用 -r 自信任。
            try:
                verification = subprocess.run(
                    [
                        "/usr/bin/security",
                        "verify-cert",
                        "-c",
                        str(path),
                        "-p",
                        "ssl",
                        "-l",
                        "-L",
                        "-k",
                        "/Library/Keychains/System.keychain",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                if verification.returncode != 0:
                    trusted = False
                else:
                    # A successful system-keychain install plus verification is
                    # required; verify-cert may otherwise use another trust domain.
                    trusted = True if installed else None
            except (OSError, subprocess.TimeoutExpired):
                trusted = None

        keychain_opened = False
        if trusted is not True:
            try:
                opened = subprocess.run(
                    ["/usr/bin/open", "-b", "com.apple.keychainaccess"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                keychain_opened = opened.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                keychain_opened = False

        if trusted is True:
            message = "系统已确认该 CA 具有 SSL 信任"
            if not installed:
                message += "；本次安装命令未成功，但现有信任有效"
        elif trusted is False:
            message = (
                "系统尚未确认该 CA 的 SSL 信任。请在系统钥匙串中按页面指纹核对对应 CA，"
                "双击证书，在“信任”中将 SSL 设为“始终信任”；若证书尚未导入，请先下载公开 CA 并导入"
            )
            if install_error:
                message = f"{install_error}；{message}"
        else:
            message = "无法确认系统钥匙串中的 SSL 信任状态，请检查并确认"
            if install_error:
                message = f"{install_error}；{message}"
        if keychain_opened:
            message += "（已打开钥匙串访问）"
        elif trusted is not True:
            message += "（未能自动打开钥匙串访问）"
        return {
            "sha256": fingerprint,
            "trusted": trusted,
            "installed": installed,
            "keychain_opened": keychain_opened,
            "message": message,
        }
