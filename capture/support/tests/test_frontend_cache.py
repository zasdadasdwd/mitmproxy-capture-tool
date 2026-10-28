"""持久 WebKit 存储与源码更新兼容；不启动真实代理。"""

import os

from fastapi import FastAPI
from fastapi.testclient import TestClient

from capture.backend.static import FrontendStaticFiles
from capture.desktop.frontend import frontend_revision


def test_revision_is_content_based_and_excludes_backgrounds(tmp_path):
    script = tmp_path / "theme.js"
    script.write_text("old")
    first = frontend_revision(tmp_path)
    timestamp = script.stat().st_mtime_ns
    script.write_text("new")
    os.utime(script, ns=(timestamp, timestamp))
    assert frontend_revision(tmp_path) != first
    second = frontend_revision(tmp_path)
    (tmp_path / "large.gif").write_bytes(b"not read")
    assert frontend_revision(tmp_path) == second
    assert frontend_revision(tmp_path) == second
    (tmp_path / "index.html").write_text("new entry")
    assert frontend_revision(tmp_path) != second


def test_source_assets_revalidate_and_keep_etags_without_disabling_image_cache(
    tmp_path,
):
    for name in ("index.html", "style.css", "theme.js", "sample.png"):
        (tmp_path / name).write_text("version one")
    app = FastAPI()
    app.mount("/", FrontendStaticFiles(directory=tmp_path, html=True))
    with TestClient(app) as client:
        for path in (
            "/",
            "/?ui_revision=123",
            "/index.html",
            "/style.css",
            "/theme.js",
        ):
            response = client.get(path)
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-cache"
            conditional = client.get(
                path, headers={"If-None-Match": response.headers["etag"]}
            )
            assert conditional.status_code == 304
            assert conditional.headers["cache-control"] == "no-cache"
        assert "cache-control" not in client.get("/sample.png").headers
        old = client.get("/")
        (tmp_path / "index.html").write_text("version two with changed content")
        changed = client.get("/", headers={"If-None-Match": old.headers["etag"]})
        assert changed.status_code == 200
        assert changed.text == "version two with changed content"
