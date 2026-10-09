# 基于mitmproxy的抓包工具（适用爬虫工程师）

基于 **mitmproxy** 的本地 HTTP/HTTPS 抓包工具，面向爬虫开发、接口调试和逆向分析。集抓包、编辑重放、参数追踪、三维关系图与 MCP 接入于一个 Web 控制台。

> **合法使用声明**：本项目仅用于合法、获得授权的开发调试、接口测试与研究。请遵守适用法律法规及相关服务的使用规则，不得用于未经授权的数据获取、侵犯隐私或其他违法用途。

查看[更新日志](capture/support/docs/更新日志.md)了解最新源码变更。前端样式和交互可刷新加载；后端及 MCP 变更需停止抓包后重启对应服务。

## 项目优势

- **从报文到参数来源**：搜索字段名或值的片段，在请求与响应中查找出现记录，结合时间线和三维关系图检查参数的来源与后续使用。
- **Agent 可以按需分析**：MCP 提供条件查询、分段读取、参数追踪和请求对比，避免一次塞入大量报文；开发者可以实时查看 Agent 的查询日志。提供配套 `tianji-capture` Skill，指导检索、来源证据分析、代码生成和重放验证。
- **抓包与分析隔离**：代理由独立 mitmdump 进程转发，链路分析在独立进程运行；停止记录后仍能正常转发网络请求。
- **扩展方式简单**：继承 `BaseHook` 即可注册处理器，直接修改 mitmproxy `HTTPFlow` 的请求和响应，界面按名称管理启用状态与执行顺序。
- **数据保存在本地**：每次抓包有独立的 SQLite 会话与正文目录，支持历史管理和导出；仓库不包含本机抓包数据、CA 私钥或虚拟环境。
- **部署步骤少**：Python 后端与原生 HTML/CSS/JavaScript 前端，无需 Node 构建；三维图依赖随项目提供，启动后自动打开浏览器。

## 快速开始

需要 **Python 3.12 或更高版本**。当前主要在 macOS 验证，采集通道使用 Unix socket，Windows 尚未适配验证。

```bash
git clone https://github.com/zasdadasdwd/mitmproxy-capture-tool.git
cd mitmproxy-capture-tool
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python main.py
```

启动成功后自动打开控制台。浏览器不可用时仅提示访问地址，服务继续运行。

| 用途 | 默认地址 |
| --- | --- |
| Web 控制台 | `http://127.0.0.1:8765` |
| 客户端 HTTP/HTTPS 代理 | `127.0.0.1:8080` |
| HTTP MCP（需启用） | `http://127.0.0.1:8766/mcp` |

1. 在客户端设置 HTTP/HTTPS 代理。
2. 在控制台点击“开始抓包”，开始保存请求；点击“停止抓包”仅停止记录。
3. 如需 HTTPS 解密，在“设置 → CA 证书管理”下载并安装证书，按 [证书安装说明](capture/support/docs/证书安装.md) 完成信任设置。
4. 将目标域名加入解密列表，或切换为全部解密。默认采用列表解密且列表为空，TLS 流量全部透传。

手机抓包时，在代理设置中将监听地址改为 `0.0.0.0`，客户端填写电脑的局域网 IP 与实际代理端口。顶部会显示当前代理地址。

## 功能一览

| 功能 | 支持内容 |
| --- | --- |
| 抓包策略 | TLS 全部解密、列表解密、全部透传；域名拒绝列表；直连或 HTTP/HTTPS 上游代理 |
| 请求检索 | 域名与 URL 搜索、常用筛选、多条件 AND/OR 嵌套分组、域名与路径目录树 |
| 报文详情 | 原始请求、实际发送请求、响应、重复 Header、完整查看弹窗、JSON 格式化与折叠树、双向 HTTP/ALPN/TLS 连接摘要 |
| 重放 | 单条、编辑重放、批量重放、次数与间隔、取消任务、独立重放记录 |
| 参数分析 | 字段名与值片段搜索、出现时间线、来源候选、跨域关联、三维关系图、实时追踪与保存视图 |
| MCP | 22 个工具：状态诊断、结构化 AND/OR、参数追踪、对比、代码复制、WebSocket 消息读取、重放记录只读检索、记录控制与删除；配套 Skill、指南资源与模板 |
| 数据管理 | 独立 SQLite 会话、历史检索、会话 ZIP 下载；抓包中删除/清空且迟到响应不复活记录 |
| 导出 | cURL、Python/httpx、Python/requests、HAR、CSV、JSON |
| 界面 | 五套完整主题、本地静态／动态背景及可见程度、实时刷新、固定表头、可伸缩侧栏与详情面板、窄窗口适配、WebSocket 消息分页面板及 SSE 事件预览 |

多条件筛选通过子组明确括号优先级，每组选择 AND 或 OR。参数全文搜索由链路分析页面提供，列表快速搜索及多条件筛选也支持请求和响应正文。

参数匹配和时序关系用于提供分析证据，候选来源需要开发者结合业务核实；加密后的参数也可能由客户端本地计算产生。

外观在“设置 → 外观与偏好”调整；背景图片仅保存在当前浏览器本机。详见 [外观设置说明](capture/support/docs/外观设置.md)。

## macOS 窗口启动

浏览器入口仍为 `python main.py`。App 窗口使用同一套源码、配置、抓包数据和 Python 环境，无需打包成独立 Python 应用：

```bash
python -m pip install -r capture/desktop/requirements.txt
python app_main.py
```

窗口使用系统 WebKit，不启动浏览器；设置、重放、分析、证书安装与下载仍使用原来的功能。第三方 Hook 继续在项目环境中开发，并通过 `startup.toml` 注册。自定义启动配置可使用 `app_main.py --config 路径`。

macOS Dock 显示名称为“天机阁”。名称在 Cocoa 初始化前设置，仅修改当前进程的应用信息，不修改系统 Python；已打开的旧窗口需要下次启动 App 才生效。若窗口自建了抓包服务，请先停止记录，再退出窗口。

生成 Finder 双击启动器：

```bash
python capture/support/scripts/build_app_launcher.py
open dist/天机阁.app
```

生成前先激活要使用的 Python 环境；环境可以是任意名称的虚拟环境或 Conda，不要求叫 `.venv`。默认记录运行生成脚本的解释器，也可以显式选择：

```bash
python capture/support/scripts/build_app_launcher.py --python "/路径/自定义环境/bin/python"
```

所选环境需安装 `requirements.txt` 和 `capture/desktop/requirements.txt`。启动器依赖本机项目路径与所选解释器，移动项目或环境后重新生成。启动失败查看 `data/logs/app-launcher.log` 或 `desktop-window.log`。窗口复用同项目已运行的服务时，关闭窗口会保留服务；若服务由窗口创建，退出窗口会保存会话并关闭该服务和代理，请同时关闭客户端手动代理。浏览器入口和窗口入口共享一套服务配置。

## 配置

| 文件 | 作用 | 生效方式 |
| --- | --- | --- |
| [startup.toml](startup.toml) | Web 端口、自动打开浏览器、自动开始记录、MCP 与第三方 Hook 模块 | 完整重启 `main.py` |
| [config.py](config.py) | 配置模型及带注释的 `DEFAULT_SETTINGS` 默认值 | 未生成运行配置时使用默认值 |
| `data/settings.json` | 由设置界面保存的代理、TLS、拒绝列表与 Hook 配置 | 按界面提示应用；部分修改要求先停止抓包 |

已有 `data/settings.json` 时优先使用其中的配置，修改默认字典不会覆盖已保存设置。

关闭启动时自动打开浏览器：

```toml
[web]
host = "127.0.0.1"
port = 8765
open_browser = false
```

指定其他启动配置：

```bash
.venv/bin/python main.py --config /path/to/startup.toml
```

## Hook 扩展

根目录的 [hook_template.py](hook_template.py) 是默认不修改任何报文的模板。填写处理逻辑，完整重启服务，再在“设置 → 扩展”启用 `template`。

```python
from capture.plugins import BaseHook


class ExampleHook(BaseHook):
    """为测试请求和响应添加标记。"""

    name = "example"
    description = "请求与响应标记示例"

    def on_request(self, flow, context):
        """请求发送前修改请求头。"""
        flow.request.headers["X-Debug-Request"] = "1"

    def on_response(self, flow, context):
        """响应返回前修改响应头。"""
        flow.response.headers["X-Debug-Response"] = "1"
```

第三方模块需安装到当前 Python 环境或放在项目目录，并加入启动配置：

```toml
[extensions]
hook_modules = ["my_hooks", "my_package.capture_hooks"]
```

模块导入时自动注册子类。`name` 必须唯一，处理方法为同步方法；`flow` 可修改 URL、查询参数、Header、Cookie、表单和二进制正文。`context` 提供会话、配置与日志等信息。

Hook 模块集合在完整启动时固定；修改模块列表或源码后需完整重启 `main.py`。TLS 透传流量不执行 HTTP Hook。重放通过 httpx 发送，不执行 Hook，也不自动跟随重定向。

## MCP 接入

工作台保持运行，由 Agent 客户端启动 stdio MCP：

```bash
.venv/bin/python mcp_server.py --transport stdio --config startup.toml
```

也可独立启动 Streamable HTTP MCP：

```bash
.venv/bin/python mcp_server.py --transport streamable-http
```

客户端配置、随工作台启动 HTTP MCP 和工具列表见 [MCP 接入说明](capture/support/docs/MCP接入.md)。查询日志可在工作台中打开，实时检查 Agent 查询了哪些请求。

## 项目目录

```text
mitmproxy-capture-tool/
├── app_main.py               # App 窗口启动入口
├── main.py                   # Web 服务启动入口
├── mcp_server.py             # MCP 启动入口
├── config.py                 # 配置模型与默认配置字典
├── startup.toml              # 进程启动配置
├── hook_template.py          # 用户可直接编辑的 Hook 模板
├── requirements.txt          # Python 依赖
├── README.md
├── capture/                  # 应用代码与资源
│   ├── agent_mcp/            # MCP 工具、API 客户端与查询审计
│   ├── backend/              # 后端业务与基础设施
│   │   ├── api/              # 按功能拆分的 HTTP/WebSocket 路由
│   │   ├── analysis/         # 参数提取与请求分析
│   │   ├── links/            # 独立进程链路分析、全文搜索与任务管理
│   │   ├── context.py        # 依赖组合与服务生命周期
│   │   └── storage.py        # SQLite 会话与正文存储
│   ├── desktop/              # 可选 WebKit 窗口，复用项目 Python 环境
│   ├── engine/               # 代理进程、采集、TLS 策略与 Hook 执行
│   ├── plugins/              # BaseHook、自动注册与内置处理器
│   ├── web/                  # Web 页面、交互脚本与样式
│   │   └── vendor/three/     # 本地三维图依赖与许可证
│   └── support/              # 文档、测试与开发辅助内容
│       ├── docs/             # 使用、架构、MCP、证书与性能说明
│       ├── research/         # 研究目录说明；本机案例不上传
│       ├── scripts/          # 性能测量等开发脚本
│       └── tests/            # 自动化测试
├── data/                     # 运行时生成，Git 忽略
└── .venv/                    # 本地安装，Git 忽略
```

## 会话与数据

仓库不需要携带 SQLite 文件。首次运行会创建所需运行目录，创建抓包会话时自动初始化数据库和表结构。

每次开始抓包保存到 `data/captures/<时间_ID>/`，包含 `capture.sqlite` 与 `bodies/`。程序重新启动后主列表从本次启动的数据开始，旧会话保留在历史管理中；重放数据独立管理。

重放合并列表聚合当前工作台启动后产生的全部重放批次，并提供全局排序、分页及来源/重放记录定位；定位只移动到对应结果，不会排除其他重放记录。升级到包含该功能的源码后，先停止抓包，再重启工作台；旧服务进程不会自动加载新接口或 MCP 工具。

`data/` 还保存运行配置、证书、查询日志和分析结果。分享会话推荐使用历史管理中的 ZIP 导出；SQLite 使用 WAL，运行中单独复制主数据库文件可能遗漏数据。CA 目录包含私钥，不能作为公开项目资源上传。

## 性能与当前边界

- 实时事件合并、列表增量刷新、后台标签页暂停刷新；详情预览限制大小，完整报文按需读取。
- SQLite 连接复用与索引、会话摘要缓存、有界事件队列、导出逐条写入临时文件。设计与测量见 [性能优化说明](capture/support/docs/性能优化.md)。
- 当前支持显式 HTTP 代理下的 HTTP/HTTPS，不支持 QUIC/HTTP3 抓包。WebSocket 消息按连接保存并分页查看；SSE 可在详情中预览已保存的完整事件，长流或大响应采用流式转发，正文受保存上限约束，可能不完整。
- 常规正文内存缓存上限默认为 2 MiB；流式正文单独受配置上限约束。截断请求不能重放或导出代码。
- 队列持续超载时可能丢弃事件并显示计数，不保证无限吞吐或零丢失归档。
- 断点编辑、Map Local/Remote、报文导入等功能尚未实现。

## 开发与验证

```bash
.venv/bin/python -m pip install pytest
.venv/bin/python -m pytest -q capture/support/tests
```

也可安装独立的开发依赖集合（pytest 与 ruff）：

```bash
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q capture/support/tests
.venv/bin/ruff check capture
```

| 文档 | 适合谁 |
| --- | --- |
| [使用指南](capture/support/docs/使用指南.md) | 首次使用与日常操作 |
| [架构与模块地图](capture/support/docs/架构与模块_AI.md) | 开发者、第三方扩展与 AI 接手开发 |
| [数据链路说明](capture/support/docs/数据链路.md) | 参数搜索、来源追踪与三维关系分析 |
| [MCP 接入](capture/support/docs/MCP接入.md) | Agent 客户端配置与查询工具使用 |
| [证书安装](capture/support/docs/证书安装.md) | HTTPS 解密与设备证书信任 |
| [优化建议与检查记录](capture/support/docs/优化建议与检查记录.md) | 后续开发与已知改进项 |

## 开发与维护

- [更新日志](capture/support/docs/更新日志.md)
- [开发规范（Agent、UI、功能、代码）](capture/support/docs/开发规范.md)
- [性能测试与资源回收](capture/support/docs/性能优化.md)
- [Agent 约束](capture/AGENTS.md)
- [Proxyman 功能差距与开发顺序](capture/support/docs/Proxyman功能差距与开发顺序.md)

### 天机阁 Agent Skill

配套 [tianji-capture Skill](capture/support/skills/tianji-capture/SKILL.md) 可复制到 Agent 的 skills 目录，用于查接口、追踪 token 首次出现、比较请求、生成 cURL/requests 和验证重放。Skill 与 MCP 接入分别配置，详见 [MCP 接入](capture/support/docs/MCP接入.md)。它只描述当前实现能力，值匹配不被当作客户端生成函数证据。

历史会话管理支持逐项勾选、全选当前搜索/类型筛选结果及批量清理；清理会永久删除选中会话及其请求正文，需要在页面确认。请求目录同时展示透传和被阻止请求的 host，无接口路径时显示域名根节点。

请求目录底部的 host 搜索只过滤左侧域名目录，忽略大小写；清空恢复全部域名，不改变右侧请求列表的筛选条件。

请求列表的“状态”表头支持按记录状态隐藏阻止/透传或仅看错误，与其他筛选共同作用并先过滤后分页。抓包与重放各自记忆选择，“清空所有筛选”恢复全部；错误指记录状态 error，并非 HTTP 错误状态码。
