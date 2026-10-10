"""本机桌面外观与背景图库存储，不经过管理服务或第三方网络。"""

import base64
import binascii
import contextlib
import fcntl
import json
import os
import re
import struct
import threading
import uuid
from pathlib import Path

_MAX_ANIMATED = 20 * 1024 * 1024
_MAX_STATIC = 64 * 1024 * 1024
_MAX_PIXELS = 16_000_000
_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_THEMES = {"light", "dark", "ocean", "paper", "graphite"}
_DEFAULTS = {"theme": "light", "opacity": 30, "uiTransparency": 20}
_MIME_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


class DesktopAppearanceAPI:
    """提供给桌面 JS bridge 的外观 API，并以原子文件操作保存本机数据。"""

    def __init__(self, data_dir=None):
        self.data_dir = Path(data_dir or Path.home() / "Library/Application Support/天机阁/appearance")
        self._thread_lock = threading.RLock()

    @property
    def _settings_path(self):
        return self.data_dir / "appearance.json"

    @contextlib.contextmanager
    def _locked(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        with self._thread_lock, (self.data_dir / ".lock").open("a+b") as lockfile:
            fcntl.flock(lockfile.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lockfile.fileno(), fcntl.LOCK_UN)

    def _read(self):
        try:
            raw = json.loads(self._settings_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise TypeError("外观配置格式无效")
            settings = dict(_DEFAULTS)
            settings.update({k: v for k, v in raw.get("settings", {}).items() if k in _DEFAULTS or k == "animation"})
            backgrounds = raw.get("backgrounds", {})
            if not isinstance(backgrounds, dict):
                backgrounds = {}
            selected = raw.get("selected")
            return settings, backgrounds, selected
        except FileNotFoundError:
            return dict(_DEFAULTS), {}, None

    def _write(self, settings, backgrounds, selected):
        payload = {"settings": settings, "backgrounds": backgrounds, "selected": selected}
        temp = self.data_dir / f".appearance-{uuid.uuid4().hex}.tmp"
        try:
            with temp.open("x", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self._settings_path)
        finally:
            temp.unlink(missing_ok=True)

    @staticmethod
    def _decode(encoded, mime, limit):
        if mime not in _MIME_EXT or not isinstance(encoded, str):
            raise ValueError("不支持的图片类型")
        if len(encoded) > ((limit + 2) // 3) * 4:
            raise ValueError("图片大小超出限制")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("图片数据不是有效的 Base64") from exc
        if not data or len(data) > limit:
            raise ValueError("图片大小超出限制")
        detected, width, height, animated = _image_info(data)
        if detected != mime:
            raise ValueError("图片 MIME 与文件签名不匹配")
        if width <= 0 or height <= 0 or width * height > _MAX_PIXELS:
            raise ValueError("图片像素数超出 1600 万限制")
        return data, animated

    @staticmethod
    def _metadata(record):
        return {k: record[k] for k in ("id", "name", "animated", "builtin") if k in record}

    def _payload(self, backgrounds, selected):
        record = backgrounds.get(selected) if selected else None
        if not record:
            return None
        if not _ID_RE.fullmatch(selected):
            raise ValueError("外观配置中的背景 ID 无效")
        folder = self.data_dir / selected
        static_name = record.get("static_file")
        if static_name not in {"static" + suffix for suffix in _MIME_EXT.values()}:
            raise ValueError("外观配置中的静态图片路径无效")
        static = (folder / static_name).read_bytes()
        result = {"id": selected, "name": record["name"], "static_b64": base64.b64encode(static).decode("ascii"), "static_mime": record["static_mime"]}
        if record.get("animated_file"):
            animated_name = record["animated_file"]
            if animated_name not in {"animated" + suffix for suffix in _MIME_EXT.values()}:
                raise ValueError("外观配置中的动画图片路径无效")
            animated = (folder / animated_name).read_bytes()
            result.update(animated_b64=base64.b64encode(animated).decode("ascii"), animated_mime=record["animated_mime"])
        if record.get("builtin"):
            result["builtin"] = record["builtin"]
        return result

    def get_appearance(self, include_background=True):
        """返回偏好、图库目录和当前背景的 Base64 数据。"""
        with self._locked():
            settings, backgrounds, selected = self._read()
            result_settings = dict(settings)
            result_settings["background_id"] = selected
            return {
                "initialized": self._settings_path.exists(),
                "settings": result_settings,
                "backgrounds": [self._metadata(v) for v in backgrounds.values()],
                "background": self._payload(backgrounds, selected) if include_background else None,
            }

    def save_appearance_settings(self, patch):
        """按白名单合并偏好；背景选择必须通过独立图库接口修改。"""
        if not isinstance(patch, dict) or "background_id" in patch:
            raise ValueError("外观设置参数无效")
        allowed = {"theme", "opacity", "uiTransparency", "animation"}
        if set(patch) - allowed:
            raise ValueError("包含不支持的外观设置")
        with self._locked():
            settings, backgrounds, selected = self._read()
            updated = dict(settings)
            for key, value in patch.items():
                if key == "theme":
                    if value not in _THEMES:
                        raise ValueError("主题无效")
                elif key in ("opacity", "uiTransparency"):
                    if type(value) is not int or not 0 <= value <= 100:
                        raise ValueError(f"{key} 必须在 0 到 100 之间")
                elif type(value) is not bool:
                    raise ValueError("animation 必须为布尔值")
                updated[key] = value
            self._write(updated, backgrounds, selected)
            return updated

    def save_appearance_background(self, item):
        """校验并写入一张背景，再原子地将其设为当前背景。"""
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip() or len(item["name"]) > 120:
            raise ValueError("背景名称无效")
        static, _ = self._decode(item.get("static_b64"), item.get("static_mime"), _MAX_STATIC)
        animated = None
        if item.get("animated_b64") is not None:
            animated, _ = self._decode(item["animated_b64"], item.get("animated_mime"), _MAX_ANIMATED)
        builtin = item.get("builtin")
        if builtin is not None and builtin != "wind-blink":
            raise ValueError("内置背景标识无效")
        with self._locked():
            settings, backgrounds, _old_selected = self._read()
            # 内置背景按稳定身份复用，避免每次选择生成重复条目。
            existing = next((k for k, v in backgrounds.items() if builtin and v.get("builtin") == builtin), None)
            if existing:
                self._payload(backgrounds, existing)
                self._write(settings, backgrounds, existing)
                return self._metadata(backgrounds[existing])
            ident = uuid.uuid4().hex
            folder = self.data_dir / ident
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            static_file = "static" + _MIME_EXT[item["static_mime"]]
            animated_file = "animated" + _MIME_EXT[item["animated_mime"]] if animated else None
            try:
                (folder / static_file).write_bytes(static)
                if animated:
                    (folder / animated_file).write_bytes(animated)
                record = {"id": ident, "name": item["name"].strip(), "animated": bool(animated), "static_file": static_file, "static_mime": item["static_mime"]}
                if animated:
                    record.update(animated_file=animated_file, animated_mime=item["animated_mime"])
                if builtin:
                    record["builtin"] = builtin
                backgrounds[ident] = record
                self._write(settings, backgrounds, ident)
            except BaseException:
                if not existing:
                    import shutil
                    shutil.rmtree(folder, ignore_errors=True)
                raise
            return self._metadata(record)

    def select_appearance_background(self, ident):
        """选择图库项目或清除背景，并返回当前项目数据。"""
        if ident is not None and (not isinstance(ident, str) or not _ID_RE.fullmatch(ident)):
            raise ValueError("背景 ID 无效")
        with self._locked():
            settings, backgrounds, _ = self._read()
            if ident is not None and ident not in backgrounds:
                raise ValueError("背景不存在")
            payload = self._payload(backgrounds, ident)
            self._write(settings, backgrounds, ident)
            return payload

    def delete_appearance_background(self, ident):
        """删除指定图库项，并在其当前选中时清除选择。"""
        if not isinstance(ident, str) or not _ID_RE.fullmatch(ident):
            raise ValueError("背景 ID 无效")
        with self._locked():
            settings, backgrounds, selected = self._read()
            if ident not in backgrounds:
                return False
            updated = dict(backgrounds)
            del updated[ident]
            new_selected = None if selected == ident else selected
            self._write(settings, updated, new_selected)
            import shutil
            shutil.rmtree(self.data_dir / ident, ignore_errors=True)
            return True


def _image_info(data):
    """从文件头读取实际格式和画布尺寸，无需解码库。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return "image/png", w, h, b"acTL" in data
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        w, h = struct.unpack("<HH", data[6:10])
        return "image/gif", w, h, data.count(b"\x2c") > 1
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        pos, width, height, animated = 12, 0, 0, False
        while pos + 8 <= len(data):
            kind = data[pos:pos+4]; size = struct.unpack_from("<I", data, pos+4)[0]; body = data[pos+8:pos+8+size]
            if len(body) != size: break
            if kind == b"VP8X" and size >= 10:
                animated = bool(body[0] & 2); width = int.from_bytes(body[4:7], "little") + 1; height = int.from_bytes(body[7:10], "little") + 1
            elif kind == b"VP8 " and size >= 10 and body[3:6] == b"\x9d\x01\x2a":
                width = struct.unpack_from("<H", body, 6)[0] & 0x3fff; height = struct.unpack_from("<H", body, 8)[0] & 0x3fff
            elif kind == b"VP8L" and size >= 5 and body[0] == 0x2f:
                bits = int.from_bytes(body[1:5], "little"); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1
            elif kind == b"ANIM": animated = True
            pos += 8 + size + (size & 1)
        if width and height: return "image/webp", width, height, animated
    if data[:2] == b"\xff\xd8":
        pos = 2
        while pos + 4 <= len(data):
            if data[pos] != 0xff: pos += 1; continue
            marker = data[pos+1]; pos += 2
            if marker in (0xd8, 0xd9) or 0xd0 <= marker <= 0xd7: continue
            if pos + 2 > len(data): break
            length = int.from_bytes(data[pos:pos+2], "big")
            if length < 2 or pos + length > len(data):
                raise ValueError("JPEG 图片数据损坏")
            if marker in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf):
                h, w = struct.unpack_from(">HH", data, pos+3)
                return "image/jpeg", w, h, False
            pos += length
        raise ValueError("JPEG 缺少有效的尺寸标记")
    raise ValueError("图片签名无效或图片数据损坏")
