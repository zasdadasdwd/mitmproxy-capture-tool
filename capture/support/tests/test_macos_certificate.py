"""证书安装行为测试；全部模拟系统写入，不修改开发机钥匙串。"""

import asyncio
import hashlib
import json
import shlex
import subprocess
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi import FastAPI

from capture.backend import certificates
from capture.backend.api import certificate as api


def make_ca(tmp_path, ca=True, expired=False):
    """生成临时公开 CA，覆盖有效性与非 CA 拒绝场景。"""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test capture CA")])
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=2))
        .not_valid_after(now + timedelta(days=-1 if expired else 1))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    path = tmp_path / "ca.pem"
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    fingerprint = hashlib.sha256(
        cert.public_bytes(serialization.Encoding.DER)
    ).hexdigest()
    return path, fingerprint


def test_installs_validated_der_with_user_ssl_trust(tmp_path, monkeypatch):
    path, fingerprint = make_ca(tmp_path)
    monkeypatch.setattr(certificates.sys, "platform", "darwin")
    saved = []

    def run(command, **kwargs):
        if command[0] == "/usr/bin/security":
            assert command[1:] == [
                "verify-cert", "-c", command[3], "-p", "ssl", "-l", "-L",
                "-k", "/Library/Keychains/System.keychain",
            ]
            return SimpleNamespace(returncode=0, stderr="", stdout="")
        assert command[0] == "/usr/bin/osascript"
        script = command[2]
        assert "with administrator privileges" in script
        assert "add-trusted-cert" in script
        assert "/Library/Keychains/System.keychain" in script
        shell_command = script.split('do shell script ', 1)[1].split(' with administrator', 1)[0]
        args = shlex.split(json.loads(shell_command))
        der_path = certificates.Path(args[-1])
        cert = x509.load_der_x509_certificate(der_path.read_bytes())
        assert cert.fingerprint(hashes.SHA256()).hex() == fingerprint
        assert args[:9] == [
            "/usr/bin/security", "add-trusted-cert", "-r", "trustRoot",
            "-d", "-p", "ssl", "-k", "/Library/Keychains/System.keychain",
        ]
        saved.append(der_path)
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr(certificates.subprocess, "run", run)
    assert (
        certificates.MacCertificateInstaller(path).install(fingerprint) == fingerprint
    )
    assert not saved[0].exists()


@pytest.mark.parametrize(
    "case", ["fingerprint", "expired", "not_ca", "private_key", "platform"]
)
def test_invalid_inputs_never_write_keychain(tmp_path, monkeypatch, case):
    path, fingerprint = make_ca(
        tmp_path, ca=case != "not_ca", expired=case == "expired"
    )
    monkeypatch.setattr(
        certificates.sys, "platform", "linux" if case == "platform" else "darwin"
    )
    if case == "fingerprint":
        fingerprint = "0" * 64
    if case == "private_key":
        path.write_bytes(path.read_bytes() + b"PRIVATE KEY")
    run = Mock()
    monkeypatch.setattr(certificates.subprocess, "run", run)
    with pytest.raises(ValueError):
        certificates.MacCertificateInstaller(path).install_with_feedback(fingerprint)
    run.assert_not_called()


@pytest.mark.parametrize("timeout", [False, True])
def test_cancel_and_timeout_are_reported(tmp_path, monkeypatch, timeout):
    path, fingerprint = make_ca(tmp_path)
    monkeypatch.setattr(certificates.sys, "platform", "darwin")
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        if command[0] == "/usr/bin/osascript":
            if timeout:
                raise subprocess.TimeoutExpired("security", 90)
            return SimpleNamespace(returncode=1, stderr="User canceled", stdout="")
        if command[0] == "/usr/bin/security":
            return SimpleNamespace(returncode=1, stderr="not trusted", stdout="")
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    run = Mock(side_effect=run)
    monkeypatch.setattr(certificates.subprocess, "run", run)
    result = certificates.MacCertificateInstaller(path).install_with_feedback(
        fingerprint
    )
    assert result["trusted"] is False
    assert result["installed"] is False
    assert result["keychain_opened"] is True
    assert calls[-1] == ["/usr/bin/open", "-b", "com.apple.keychainaccess"]
    assert ("超时" if timeout else "安装未完成") in result["message"]


def test_successful_install_is_not_reported_trusted_without_verification(
    tmp_path, monkeypatch
):
    path, fingerprint = make_ca(tmp_path)
    monkeypatch.setattr(certificates.sys, "platform", "darwin")

    def run(command, **kwargs):
        if command[0] == "/usr/bin/security":
            raise subprocess.TimeoutExpired(command, 30)
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr(certificates.subprocess, "run", run)
    result = certificates.MacCertificateInstaller(path).install_with_feedback(
        fingerprint
    )
    assert result["installed"] is True
    assert result["trusted"] is None
    assert result["keychain_opened"] is True


def test_legacy_install_still_returns_fingerprint(tmp_path, monkeypatch):
    path, fingerprint = make_ca(tmp_path)
    monkeypatch.setattr(certificates.sys, "platform", "darwin")
    monkeypatch.setattr(
        certificates.subprocess,
        "run",
        Mock(return_value=SimpleNamespace(returncode=0, stderr="", stdout="")),
    )
    assert certificates.MacCertificateInstaller(path).install(fingerprint) == fingerprint


def test_api_rejects_remote_or_missing_origin_and_accepts_local(monkeypatch):
    asyncio.run(check_api_origins(monkeypatch))


async def check_api_origins(monkeypatch):
    app = FastAPI()
    app.include_router(api.router)
    install = Mock(return_value={
        "sha256": "a" * 64, "trusted": None, "installed": False,
        "keychain_opened": True, "message": "待用户确认",
    })
    monkeypatch.setattr(api.MacCertificateInstaller, "install_with_feedback", install)
    for host, origin, status in [
        ("192.168.1.3", "http://localhost", 403),
        ("127.0.0.1", None, 403),
        ("127.0.0.1", "http://evil.example", 403),
        ("127.0.0.1", "http://localhost", 200),
    ]:
        transport = httpx.ASGITransport(app=app, client=(host, 50000))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://localhost"
        ) as client:
            response = await client.post(
                "/api/certificate/macos/install",
                json={"sha256": "a" * 64},
                headers={"Origin": origin} if origin else {},
            )
            assert response.status_code == status
    assert install.call_count == 1
    async with (
        api.install_lock,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 50000)),
            base_url="http://localhost",
        ) as client,
    ):
        response = await client.post(
            "/api/certificate/macos/install",
            json={"sha256": "a" * 64},
            headers={"Origin": "http://localhost"},
        )
        assert response.status_code == 409
    assert install.call_count == 1


def test_permission_denied_opens_keychain_without_claiming_install(tmp_path, monkeypatch):
    path, fingerprint = make_ca(tmp_path)
    monkeypatch.setattr(certificates.sys, "platform", "darwin")
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        if command[0] == "/usr/bin/osascript":
            raise PermissionError("permission denied")
        if command[0] == "/usr/bin/security":
            return SimpleNamespace(returncode=1, stderr="not trusted", stdout="")
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr(certificates.subprocess, "run", run)
    result = certificates.MacCertificateInstaller(path).install_with_feedback(
        fingerprint
    )
    assert result["installed"] is False
    assert result["trusted"] is False
    assert result["keychain_opened"] is True
    assert calls[-1] == ["/usr/bin/open", "-b", "com.apple.keychainaccess"]


def test_failed_system_install_cannot_use_existing_ssl_trust_as_proof(
    tmp_path, monkeypatch
):
    path, fingerprint = make_ca(tmp_path)
    monkeypatch.setattr(certificates.sys, "platform", "darwin")

    def run(command, **kwargs):
        if command[0] == "/usr/bin/osascript":
            return SimpleNamespace(
                returncode=1, stderr="authorization denied", stdout=""
            )
        if command[0] == "/usr/bin/security":
            return SimpleNamespace(returncode=0, stderr="", stdout="")
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr(certificates.subprocess, "run", run)
    result = certificates.MacCertificateInstaller(path).install_with_feedback(
        fingerprint
    )
    assert result["installed"] is False
    assert result["trusted"] is None
    assert result["keychain_opened"] is True
    assert "authorization denied" in result["message"]


def test_keychain_launch_failure_is_reported(tmp_path, monkeypatch):
    path, fingerprint = make_ca(tmp_path)
    monkeypatch.setattr(certificates.sys, "platform", "darwin")
    monkeypatch.setattr(
        certificates.subprocess,
        "run",
        Mock(return_value=SimpleNamespace(returncode=1, stderr="failed", stdout="")),
    )
    result = certificates.MacCertificateInstaller(path).install_with_feedback(
        fingerprint
    )
    assert result["trusted"] is False
    assert result["keychain_opened"] is False
    assert "未能自动打开" in result["message"]
