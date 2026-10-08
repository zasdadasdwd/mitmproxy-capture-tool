"""只读连接快照；不改变代理协商、连接复用或业务报文。"""


def connection_snapshot(connection, http_version=None):
    """记录已观测连接信息；ALPN offers 不是协商结果，缺失值保持未知。"""
    accepted = (
        connection.alpn.decode("ascii", errors="replace") if connection.alpn else None
    )
    tcp_done = getattr(connection, "timestamp_tcp_setup", None)
    started = connection.timestamp_start
    tls_done = connection.timestamp_tls_setup
    return {
        "id": connection.id,
        "http_version": http_version
        or {"h2": "HTTP/2.0", "http/1.1": "HTTP/1.1"}.get(accepted),
        "alpn": accepted,
        "alpn_offers": [
            item.decode("ascii", errors="replace") for item in connection.alpn_offers
        ],
        "tls": connection.tls,
        "tls_established": connection.tls_established,
        "tls_version": connection.tls_version,
        "cipher": connection.cipher,
        "sni": connection.sni,
        "peer": connection.peername,
        "started": started,
        "tcp_connect_ms": round((tcp_done - started) * 1000, 2)
        if tcp_done is not None and started is not None and tcp_done >= started
        else None,
        "tls_handshake_ms": round((tls_done - tcp_done) * 1000, 2)
        if tls_done is not None and tcp_done is not None and tls_done >= tcp_done
        else None,
        "error": connection.error,
    }
