"""本机 TLS/ALPN 服务验证 HTTP/2 协商与 HTTP/1 连接池隔离。"""

import asyncio
import copy
import datetime
import ipaddress
import socket
import ssl
import threading
from types import SimpleNamespace

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import StreamEnded

from capture.backend.replay import ReplayOptions, replay_batch
from config import Settings


@pytest.mark.parametrize("server_h2", [True, False])
def test_replay_uses_original_version_and_separate_alpn_pools(
    tmp_path, monkeypatch, server_h2
):
    """同一目标依次重放 HTTP2/HTTP1，实际握手及服务器报文分别匹配。"""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_path, key_path)
    server_context.set_alpn_protocols(["h2", "http/1.1"] if server_h2 else ["http/1.1"])
    client_context = ssl.create_default_context(cafile=str(cert_path))
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: real_client(verify=client_context, **kw)
    )
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(5)
    received, errors, records = [], [], []

    def serve():
        try:
            for _ in range(2):
                channel, _ = listener.accept()
                with server_context.wrap_socket(channel, server_side=True) as tls:
                    tls.settimeout(5)
                    protocol = tls.selected_alpn_protocol()
                    if protocol == "h2":
                        conn = H2Connection(config=H2Configuration(client_side=False))
                        conn.initiate_connection()
                        tls.sendall(conn.data_to_send())
                        done = False
                        while not done:
                            for event in conn.receive_data(tls.recv(65536)):
                                if isinstance(event, StreamEnded):
                                    conn.send_headers(
                                        event.stream_id,
                                        [(":status", "200"), ("content-length", "2")],
                                    )
                                    conn.send_data(
                                        event.stream_id, b"ok", end_stream=True
                                    )
                                    done = True
                            tls.sendall(conn.data_to_send())
                    else:
                        raw = b""
                        while b"\r\n\r\n" not in raw:
                            raw += tls.recv(65536)
                        assert raw.startswith(b"GET /test HTTP/1.1\r\n")
                        tls.sendall(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                        )
                    received.append(protocol)
        except Exception as exc:  # noqa: BLE001 -- 工作线程异常必须传回主测试线程。
            errors.append(exc)
        finally:
            listener.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    requests = [
        (
            str(index),
            {
                "url": f"https://127.0.0.1:{listener.getsockname()[1]}/test",
                "method": "GET",
                "headers": [],
                "body_b64": "",
                "http_version": version,
            },
        )
        for index, version in enumerate(["HTTP/2.0", "HTTP/1.1"])
    ]
    store = SimpleNamespace(
        save_flow=lambda _, flow: records.append(copy.deepcopy(flow)),
        finish=lambda _: None,
    )
    asyncio.run(
        replay_batch(
            store,
            "replay",
            requests,
            Settings().model_dump(),
            lambda _: None,
            ReplayOptions(ids=["0", "1"]),
            True,
        )
    )
    thread.join(timeout=6)
    assert not errors
    assert received == ["h2" if server_h2 else "http/1.1", "http/1.1"]
    completed = [flow for flow in records if flow["status"] == "complete"]
    assert len(completed) == 2
    assert [flow["request"]["http_version"] for flow in completed] == [
        "HTTP/2.0" if server_h2 else "HTTP/1.1",
        "HTTP/1.1",
    ]
    assert completed[0]["replay_transport"]["http_version_changed"] is (not server_h2)
    assert completed[1]["replay_transport"]["http_version_changed"] is False
