"""全局配置独立于每次抓包会话，文件原子替换供引擎读取。"""

import os
import re
from pathlib import Path, PurePosixPath
from typing import Literal
from urllib.parse import urlsplit

import tomllib
from pydantic import BaseModel, Field, field_validator, model_validator

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CONFIG_PATH = DATA / "settings.json"


class WebStartup(BaseModel):
    """管理服务启动参数，保持本机监听。"""

    host: Literal["127.0.0.1", "localhost"] = "127.0.0.1"
    port: int = Field(default=8765, ge=1024, le=65535)
    # 服务成功监听后打开默认浏览器；无桌面环境可关闭。
    open_browser: bool = True


class ProxyStartup(BaseModel):
    """控制随管理服务自动开始记录；代理转发默认常驻。"""

    autostart: bool = False


class MCPStartup(BaseModel):
    """stdio 由 Agent 启动，HTTP 可随管理服务启动。"""

    enabled: bool = False
    transport: Literal["stdio", "streamable-http"] = "stdio"
    host: Literal["127.0.0.1", "localhost"] = "127.0.0.1"
    port: int = Field(default=8766, ge=1024, le=65535)
    entrypoint: str = ""


class ExtensionsStartup(BaseModel):
    """显式列出第三方 Hook 模块，避免扫描目录和隐式执行代码。"""

    hook_modules: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("hook_modules")
    @classmethod
    def validate_hook_modules(cls, modules):
        """模块名必须可导入且唯一；导入行为发生在应用启动时。"""
        pattern = r"[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*"
        if any(not re.fullmatch(pattern, name) for name in modules):
            raise ValueError("Hook 模块必须使用 Python 点分模块名")
        if len(set(modules)) != len(modules):
            raise ValueError("Hook 模块不能重复")
        return modules


class StartupConfig(BaseModel):
    """区分进程启动配置与界面热更新的抓包策略。"""

    web: WebStartup = Field(default_factory=WebStartup)
    proxy: ProxyStartup = Field(default_factory=ProxyStartup)
    mcp: MCPStartup = Field(default_factory=MCPStartup)
    extensions: ExtensionsStartup = Field(default_factory=ExtensionsStartup)


def load_startup(path: Path | None = None) -> StartupConfig:
    """读取 --config 指定的 TOML；默认配置不存在时使用默认参数。"""
    path = path or Path(os.environ.get("CAPTURE_STARTUP_FILE", ROOT / "startup.toml"))
    if not path.exists():
        if "CAPTURE_STARTUP_FILE" in os.environ:
            raise FileNotFoundError(f"启动配置不存在：{path}")
        return StartupConfig()
    with path.open("rb") as source:
        return StartupConfig.model_validate(tomllib.load(source))


class RequestHook(BaseModel):
    """请求 Hook 的注册名及独立开关，列表顺序就是执行顺序。"""

    name: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    enabled: bool = True

    @model_validator(mode="before")
    @classmethod
    def migrate_file_path(cls, value):
        """兼容旧配置的 plugins/名称.py；运行时只使用注册名。"""
        if isinstance(value, dict) and "path" in value and "name" not in value:
            path = PurePosixPath(str(value["path"]).replace("\\", "/"))
            if (
                path.parts[:1] != ("plugins",)
                or path.suffix != ".py"
                or ".." in path.parts
            ):
                raise ValueError("旧 Hook 路径必须在 plugins 目录")
            return {"name": path.stem, "enabled": value.get("enabled", True)}
        return value


# 首次启动时使用这些值。已有 data/settings.json 时，界面保存的配置优先。
# 修改此字典后，若希望对现有安装生效，请在界面修改对应项，或先备份再移走 settings.json。
DEFAULT_SETTINGS = {
    "listen_host": "127.0.0.1",  # 仅本机；手机抓包改成 0.0.0.0。
    "listen_port": 8080,  # 客户端填写的 HTTP/HTTPS 代理端口。
    "connection_mode": "direct",  # direct 直连，upstream 使用外部代理。
    "upstream_proxy": "",  # 示例：http://127.0.0.1:7890。
    "tls_mode": "list",  # all 全部解密，list 仅列表，passthrough 全部透传。
    "tls_domains": [],  # 需要解密的域名；空列表时默认不解密。
    "blocking_enabled": False,  # 是否启用拒绝域名规则。
    "blocked_domains": [],  # 需要拒绝的域名或通配规则。
    "hook_enabled": False,  # Hook 总开关；具体 Hook 可在界面排序和启用。
    "request_hooks": [{"name": "request_hook", "enabled": True}],
    "websocket_message_limit": 1000,  # 每连接最多保存的重组消息数量。
    "websocket_body_limit": 4
    * 1024
    * 1024,  # 每连接消息正文保存上限，单条最多 64 KiB。
    "body_limit": 2 * 1024 * 1024,  # 常规正文内存缓存上限 2 MiB。
    "save_streamed_bodies": True,  # 大正文及 SSE 异步落盘，不阻塞转发。
    "stream_body_limit": 64 * 1024 * 1024,  # 单个流式正文最多保存 64 MiB。
}


class Settings(BaseModel):
    """校验界面提交的代理、TLS、拒绝与 hook 配置。"""

    listen_host: Literal["127.0.0.1", "0.0.0.0"] = DEFAULT_SETTINGS["listen_host"]
    listen_port: int = Field(default=DEFAULT_SETTINGS["listen_port"], ge=1024, le=65535)
    connection_mode: Literal["direct", "upstream"] = DEFAULT_SETTINGS["connection_mode"]
    upstream_proxy: str = Field(
        default=DEFAULT_SETTINGS["upstream_proxy"], max_length=2000
    )
    tls_mode: Literal["all", "list", "passthrough"] = DEFAULT_SETTINGS["tls_mode"]
    tls_domains: list[str] = Field(
        default_factory=lambda: list(DEFAULT_SETTINGS["tls_domains"])
    )
    blocking_enabled: bool = DEFAULT_SETTINGS["blocking_enabled"]
    blocked_domains: list[str] = Field(
        default_factory=lambda: list(DEFAULT_SETTINGS["blocked_domains"])
    )
    hook_enabled: bool = DEFAULT_SETTINGS["hook_enabled"]
    request_hooks: list[RequestHook] = Field(
        default_factory=lambda: [
            RequestHook.model_validate(item)
            for item in DEFAULT_SETTINGS["request_hooks"]
        ],
        max_length=32,
    )
    body_limit: int = Field(
        default=DEFAULT_SETTINGS["body_limit"], ge=1024, le=16 * 1024 * 1024
    )
    save_streamed_bodies: bool = DEFAULT_SETTINGS["save_streamed_bodies"]
    stream_body_limit: int = Field(
        default=DEFAULT_SETTINGS["stream_body_limit"], ge=1024, le=512 * 1024 * 1024
    )
    websocket_message_limit: int = Field(
        default=DEFAULT_SETTINGS["websocket_message_limit"], ge=1, le=10000
    )
    websocket_body_limit: int = Field(
        default=DEFAULT_SETTINGS["websocket_body_limit"], ge=1024, le=64 * 1024 * 1024
    )
    version: int = 1

    @field_validator("request_hooks")
    @classmethod
    def unique_hooks(cls, hooks):
        """禁止同一文件重复执行，避免误改参数两次。"""
        if len({hook.name for hook in hooks}) != len(hooks):
            raise ValueError("Hook 列表不能包含重复名称")
        return hooks

    @field_validator("upstream_proxy")
    @classmethod
    def validate_upstream(cls, value):
        """支持 HTTP/HTTPS 上游代理及 URL 中的可选认证信息。"""
        value = value.strip()
        if not value:
            return ""
        parsed = urlsplit(value)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or not parsed.port
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or any(char.isspace() for char in value)
        ):
            raise ValueError(
                "外部代理格式：http://host:port 或 https://host:port，可包含用户名和密码"
            )
        return value.rstrip("/")

    @model_validator(mode="after")
    def require_upstream(self):
        """外部代理模式必须有地址；拒绝连接回自身形成代理循环。"""
        if self.connection_mode == "upstream":
            if not self.upstream_proxy:
                raise ValueError("外部代理模式需要填写代理地址")
            parsed = urlsplit(self.upstream_proxy)
            if (
                parsed.hostname in ("127.0.0.1", "localhost", "0.0.0.0", "::1")
                and parsed.port == self.listen_port
            ):
                raise ValueError("外部代理不能指向当前抓包代理端口")
        return self

    @field_validator("tls_domains", "blocked_domains")
    @classmethod
    def validate_domains(cls, domains):
        """去掉空行、重复项，统一域名格式。"""
        from capture.engine.policy import normalize_pattern

        return list(
            dict.fromkeys(normalize_pattern(item) for item in domains if item.strip())
        )


def load_settings() -> Settings:
    """加载全局配置；首次运行采用列表为空、拒绝关闭的默认值。"""
    if CONFIG_PATH.exists():
        return Settings.model_validate_json(CONFIG_PATH.read_text(encoding="utf-8"))
    return Settings.model_validate(DEFAULT_SETTINGS)


def save_settings(settings: Settings) -> None:
    """使用原子替换，避免引擎轮询读到只写了一半的 JSON。"""
    DATA.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_PATH.with_suffix(".tmp")
    temporary.write_text(settings.model_dump_json(indent=2), encoding="utf-8")
    os.replace(temporary, CONFIG_PATH)
