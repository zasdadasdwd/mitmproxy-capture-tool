"""桌面本机外观存储的边界与图库行为测试。"""

import base64
import struct

import pytest

from capture.desktop.appearance import DesktopAppearanceAPI


def png(width=2, height=3):
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00"


def encoded(data):
    return base64.b64encode(data).decode("ascii")


def item(name="sample"):
    return {"name": name, "static_b64": encoded(png()), "static_mime": "image/png"}


def test_settings_and_background_gallery_are_persistent_and_local(tmp_path):
    api = DesktopAppearanceAPI(tmp_path)
    assert api.get_appearance()["initialized"] is False
    settings = api.save_appearance_settings({"theme": "dark", "opacity": 55, "animation": False})
    assert settings["opacity"] == 55
    first = api.save_appearance_background(item())
    assert first["id"] and first["animated"] is False
    api.save_appearance_background({**item("second"), "static_b64": encoded(png(4, 4))})
    restored = DesktopAppearanceAPI(tmp_path).get_appearance()
    assert restored["initialized"] is True
    assert restored["settings"]["theme"] == "dark"
    assert len(restored["backgrounds"]) == 2
    assert restored["background"]["name"] == "second"
    assert restored["background"]["static_b64"] == encoded(png(4, 4))
    assert not (tmp_path / "appearance.json").read_text().find("static_b64") >= 0


def test_selection_delete_and_builtin_identity(tmp_path):
    api = DesktopAppearanceAPI(tmp_path)
    bg = api.save_appearance_background({**item("wind"), "builtin": "wind-blink"})
    static_path = tmp_path / bg["id"] / "static.png"
    original_bytes = static_path.read_bytes()
    api.save_appearance_background({**item("replacement"), "static_b64": encoded(png(4, 4)), "builtin": "wind-blink"})
    again = api.save_appearance_background({**item("wind"), "builtin": "wind-blink"})
    assert bg["id"] == again["id"]
    assert static_path.read_bytes() == original_bytes
    assert api.select_appearance_background(None) is None
    assert api.select_appearance_background(bg["id"])["builtin"] == "wind-blink"
    assert api.delete_appearance_background(bg["id"])
    assert api.get_appearance()["settings"]["background_id"] is None
    assert not api.delete_appearance_background(bg["id"])


def test_validation_rejects_bad_mime_pixels_and_path_ids(tmp_path):
    api = DesktopAppearanceAPI(tmp_path)
    with pytest.raises(ValueError):
        api.save_appearance_background({**item(), "static_mime": "image/jpeg"})
    with pytest.raises(ValueError):
        api.save_appearance_background({**item(), "static_b64": encoded(png(4001, 4001))})
    with pytest.raises(ValueError):
        api.select_appearance_background("../../outside")
    with pytest.raises(ValueError):
        api.save_appearance_settings({"background_id": "abc"})


def test_failed_candidate_preserves_selected_background(tmp_path):
    api = DesktopAppearanceAPI(tmp_path)
    previous = api.save_appearance_background(item())
    with pytest.raises(ValueError):
        api.save_appearance_background({**item("broken"), "static_b64": encoded(b"no image")})
    assert api.get_appearance()["settings"]["background_id"] == previous["id"]
    assert len(api.get_appearance()["backgrounds"]) == 1


def test_failed_config_commit_cleans_candidate_and_keeps_previous(tmp_path, monkeypatch):
    api = DesktopAppearanceAPI(tmp_path)
    previous = api.save_appearance_background(item())
    before = (tmp_path / "appearance.json").read_bytes()

    def failed_write(*args):
        raise OSError("模拟磁盘写入失败")

    monkeypatch.setattr(api, "_write", failed_write)
    with pytest.raises(OSError, match="模拟磁盘"):
        api.save_appearance_background(item("replacement"))
    assert (tmp_path / "appearance.json").read_bytes() == before
    assert [p.name for p in tmp_path.iterdir() if p.is_dir()] == [previous["id"]]
    assert api.get_appearance(False)["background"] is None
    assert api.get_appearance(False)["settings"]["background_id"] == previous["id"]


def test_selection_reads_files_before_persisting_and_base64_length_is_bounded(tmp_path):
    api = DesktopAppearanceAPI(tmp_path)
    selected = api.save_appearance_background(item("selected"))
    broken = api.save_appearance_background(item("broken"))
    api.select_appearance_background(selected["id"])
    (tmp_path / broken["id"] / "static.png").unlink()
    with pytest.raises(FileNotFoundError):
        api.select_appearance_background(broken["id"])
    assert api._read()[2] == selected["id"]
    with pytest.raises(ValueError, match="大小"):
        DesktopAppearanceAPI._decode("A" * 5, "image/png", 3)


@pytest.mark.parametrize("data", [b"GIFbad\x02\x00\x03\x00", b"\xff\xd8\xff\xe0\x00\x20\x00"])
def test_malformed_gif_and_jpeg_raise_value_error(tmp_path, data):
    api = DesktopAppearanceAPI(tmp_path)
    mime = "image/gif" if data.startswith(b"GIF") else "image/jpeg"
    with pytest.raises(ValueError):
        api.save_appearance_background({"name": "bad", "static_b64": encoded(data), "static_mime": mime})
