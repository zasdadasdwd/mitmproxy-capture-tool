"""使用临时数据库测量热路径，绝不写入真实抓包会话。"""

import argparse
import base64
import json
import math
import platform
import sqlite3
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path

from capture.backend.filters import FlowFilters
from capture.backend.storage import Store
from config import Settings


def measure(function, repeats=12):
    """记录中位数与 Python 分配峰值，首次调用也计入样本。"""
    samples = []
    tracemalloc.start()
    for _ in range(repeats):
        started = time.perf_counter()
        function()
        samples.append((time.perf_counter() - started) * 1000)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {
        "median_ms": round(statistics.median(samples), 3),
        "first_ms": round(samples[0], 3),
        "p95_ms": round(sorted(samples)[math.ceil(len(samples) * .95) - 1], 3),
        "peak_kib": round(peak / 1024, 1),
    }


def main():
    """构造 5 万条 URL 和 8 MiB 未压缩响应，覆盖目录及详情预览。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as folder:
        store = Store(Path(folder))
        session = store.create_session(Settings().model_dump())
        with store.connect(session) as db:
            db.executemany(
                "INSERT INTO flows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    (
                        str(i),
                        "example.test",
                        f"https://example.test/catalog/{i % 20}?item={i}",
                        "GET",
                        "complete",
                        200,
                        i,
                        1,
                        0,
                        "capture",
                        "{}",
                    )
                    for i in range(50000)
                ),
            )
        store.save_flow(
            session,
            {
                "id": "large",
                "response": {
                    "headers": [],
                    "body_b64": base64.b64encode(b"a" * (8 * 1024 * 1024)).decode(),
                },
            },
        )
        result = {
            "environment": {"python": platform.python_version(), "sqlite": sqlite3.sqlite_version, "platform": platform.system(), "timing_with_tracemalloc": True},
            "rows": 50000,
            "body_bytes": 8 * 1024 * 1024,
            "directories": measure(lambda: store.directories(session)),
            "preview": measure(lambda: store.get_flow(session, "large", preview=True)),
            "list_first_page": measure(lambda: store.list_flows(session)),
            "list_deep_page": measure(lambda: store.list_flows(session, offset=40000)),
            "list_filtered": measure(lambda: store.list_flows(session, filters=FlowFilters(method="GET", status_code="200"))),
            "list_sorted": measure(lambda: store.list_flows(session, filters=FlowFilters(sort_order="desc"))),
        }
        result["body_replacements"] = measure(lambda: store.save_flow(session, {
            "id": "replace", "request": {"body_b64": "dGVzdA=="},
        }), repeats=100)
        result["cleanup"] = {
            "body_files_after_100_replacements": len(list((store.root / session / "bodies").iterdir())),
            "deleted": store.delete_flows(session, ["replace"]),
            "body_files_after_delete": len(list((store.root / session / "bodies").iterdir())),
        }
        result["full_view"] = {
            "raw_json_bytes": len(
                json.dumps(store.get_flow(session, "large")).encode()
            ),
            "text_json_bytes": len(
                json.dumps(store.get_flow(session, "large", include_raw=False)).encode()
            ),
        }
        store.close()
        result["cleanup"]["connections_after_close"] = len(store.connections)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
