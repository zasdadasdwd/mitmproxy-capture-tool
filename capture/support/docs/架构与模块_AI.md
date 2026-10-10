# Capture 架构与模块地图（给开发 Agent）

本文描述当前可运行代码的边界和修改位置；先阅读这里，再按任务查看具体模块。运行入口始终是项目根目录 `main.py`，不要把抓包、Web、分析重新合并到一个进程回调里。

## 设计方式

采用“组合根 + 按领域拆分的入站适配器 + 独立代理/分析进程”。`capture/backend/app.py` 只负责创建 FastAPI、安装本机访问限制、按顺序装配路由，最后挂载静态页面。`capture/backend/context.py` 管理一次 Web 进程的 `Workbench` 实例和退出收尾。API 模块调用服务、存储和引擎；存储/引擎不导入 API。分析 worker 和 mitmdump addon 都不依赖 Web 路由。保持这条依赖方向，避免循环导入与启动时创建数据库。

```text
浏览器 / MCP 客户端
       │
       ├── Web: capture/web/* → FastAPI: backend/api/*
       │                         │
       │                         └── context.Workbench → Store / EngineManager / AnalysisManager
       └── MCP: agent_mcp/* ───────────────→ 本机 HTTP API

EngineManager ──子进程──→ engine/addon.py ──有界 Unix socket/ACK──→ Store
AnalysisManager ──spawn 子进程──→ links/worker.py ──只读 SQLite──→ 会话快照
```

## 模块职责与修改位置

| 模块 | 职责 | 常见修改 |
| --- | --- | --- |
| `main.py`、`mcp_server.py` | 命令行进程入口；`main.py` 读取启动文件并运行 Web，MCP 可独立启动 | 启动行为、CLI 参数 |
| `config.py`、`startup.toml` | `StartupConfig` 管进程级配置，`Settings` 管 Web 可修改策略；`DEFAULT_SETTINGS` 是首次启动用的带注释 Python 字典 | 新配置项、校验、默认值 |
| `backend/app.py`、`backend/context.py` | 装配根、访问保护、进程生命周期、`Workbench` 服务容器 | 新路由注册、生命周期依赖 |
| `backend/api/system.py` | 状态、启动信息、全局设置、代理开停和 Hook 目录 | 设置/控制 API |
| `backend/api/sessions.py` | 会话与请求摘要/详情、目录、删除和历史 ZIP | 列表/历史 API |
| `backend/api/replay.py` | 重放任务与导出入口 | 重放/导出 API |
| `backend/api/certificate.py` | 公开 CA 下载、指纹和安装文档；不可返回私钥 | 证书展示 |
| `backend/api/events.py` | `/ws` 实时失效通知 | 前端刷新事件 |
| `backend/api/analysis.py` | 参数搜索、追踪、链路候选及请求比较 | 小范围同步分析 API |
| `backend/api/links.py` | 独立分析任务与保存视图 API | 三维链路分析接口 |
| `backend/api/observability.py` | MCP 查询日志及 SSE | 查询审计展示 |
| `backend/storage.py`、`filters.py`、`advanced_filters.py` | 每会话 SQLite、正文文件、摘要分页与分组筛选 | 持久化与 SQL 查询 |
| `backend/replay.py`、`export.py`、`network.py`、`documents.py` | 重放实现、格式导出、局域网地址、证书文档渲染 | 对应业务逻辑 |
| `backend/analysis/*` | 参数模型、字段提取、候选来源服务 | 请求参数分析 |
| `backend/links/manager.py`、`worker.py`、`reader.py`、`search.py`、`text.py`、`models.py` | 子进程编排、只读会话、全文出现搜索和关系证据 | 大范围分析算法 |
| `engine/manager.py`、`addon.py`、`policy.py`、`hooks.py` | mitmdump 生命周期、事件采集、TLS/拒绝策略、Hook 执行链 | 代理转发和请求/响应修改 |
| `plugins/base.py`、`plugins/hooks.py`、`hook_template.py` | `BaseHook` 注册表、内置示例、根目录空模板 | 第三方报文扩展 |
| `agent_mcp/server.py`、`client.py`、`tools.py`、`audit.py` | MCP 协议适配、HTTP API 客户端、工具、审计 | Agent 接入 |
| `desktop/window.py`、`desktop/appearance.py` | Cocoa 外壳与本机外观桥接；用户目录 JSON 偏好与二进制背景图库，独立于抓包服务 | 桌面启动、外观持久化 |
| `web/*` | 原生 HTML/CSS/JS；`app.js` 主页面，`links*` 链路页，`request-viewer.js` 详情；`theme.js` 共享主题，`desktop-appearance.js` 桌面外观桥接与迁移，`appearance-background.js` 背景图库与生命周期 | 浏览器交互 |
| `support/tests/*`、`support/docs/*` | 自动化验证与维护文档 | 行为变更时补测试/文档 |

请求详情的展示规则集中在 `app.js` 的 `detailPresentation`、`renderDetail` 与 `setDetailSection`：仅决定默认标签、语义颜色、折叠与滚动状态，不能据此改写报文或传输行为。分体重放和更多菜单保留原按钮 ID；新增操作浮层需纳入 `dismissFloatingMenus`，正文折叠与 JSON 树不属于操作浮层。侧栏不初始化上下伸缩，完整查看仍保留数据区伸缩；宽度调整由 `detail-resizer.js` 管理。

## 数据与进程边界

- Web 启动时创建 `Workbench`，代理转发可以常驻，但只有“开始抓包”才创建并记录一个独立会话。退出时取消重放/分析任务、关闭 Store 和代理。已有会话目录不因重启而覆盖。
- `EngineManager` 通过环境变量给 mitmdump 子进程传入配置路径、Unix socket 与控制文件。`CaptureAddon` 在请求/响应阶段执行策略与 Hook，向管理进程发送有界事件；写 SQLite 由 Web 侧 Store 完成。不要在 mitmproxy 回调内执行重型分析或打开 Web 数据库。
- `AnalysisManager` 用 spawn 启动独立 worker。worker 从单独的只读 SQLite 连接读报文，输出到 `data/analysis/`；关系只表示证据候选，不把相邻请求断言为因果。
- `data/settings.json` 是 Web 保存的全局策略，存在时优先于 `DEFAULT_SETTINGS`。`startup.toml` 是进程配置，修改后重启生效。抓包会话在 `data/captures/<时间_ID>/`，证书私钥在 `data/certificates/`，MCP 日志在 `data/logs/`。测试不得碰真实 `data/`。

## 对外扩展契约

首选 Hook：第三方模块安装在当前虚拟环境或置于项目可导入路径，在 `startup.toml` 的 `[extensions].hook_modules` 显式填写点分模块名。每次完整启动 `main.py` 时，Web 与代理进程使用该次启动时固定的模块集合；运行中修改 TOML 不会隐式增删模块。代理因端口、Hook 顺序等设置重启时仍沿用 main 启动时的集合；完整重启 main 才会读取更新后的集合。开始新抓包会重建 Hook 实例，不重新发现模块。模块导入时，继承 `capture.plugins.BaseHook` 的子类按唯一小写 `name` 自动注册；设置页通过 `/api/hooks` 展示，并可配置顺序与开关。实现同步 `on_request(flow, context)` / `on_response(flow, context)`，可直接修改 mitmproxy `HTTPFlow`。两个方法的默认实现为空。`context` 提供 `session_id`、`config`、`logger`、`now_ms()`、`hook_name`。模块在 Web 与 mitmdump 两个进程中分别导入，因此不要依赖进程内共享状态。运行时不要编辑插件源码；源码变更需完整重启 main 才加载。模块导入失败时回滚本次注册及相关导入缓存，但不承诺撤销任意用户代码的外部副作用。参考 `hook_template.py`。

需要新的只读自动化能力时，优先调用既有 HTTP API；MCP 通过 `agent_mcp/client.py` 调用 API，不要直接访问 SQLite。需要改 HTTP 接口时，把请求模型和路由放到对应 `backend/api/` 模块，把可复用逻辑放入相应业务模块，再在 `backend/app.py` 注册新的 router（若新增领域）。不要把业务逻辑堆回组合根。

## 变更检查

1. 新设置项同时检查 `Settings` 校验、`DEFAULT_SETTINGS`、设置 UI、策略快照及 mitmdump 热更新读取；进程级配置改 `StartupConfig` 和 `startup.toml`。
2. 新 API 保留本机访问与 Origin 检查，静态资源挂载必须最后；WebSocket 自行检查 Origin。请求详情和分析结果应保持有界分页/预览。
3. 不把原始报文或密钥写到 MCP 审计日志。CA 下载只允许公开证书。历史会话与当前会话删除规则不同。
4. 运行 `.venv/bin/python -m pytest -q`。真实代理测试位于 `support/tests/test_workbench.py`；Hook 扩展测试位于 `test_hooks.py`。前端改动另做窄屏和宽屏检查。

## MCP 与 Skill 扩展边界

`agent_mcp/tools.py` 负责工具参数、有界输出与注解，`client.py` 复用本机 API 并禁用环境代理/重定向，`audit.py` 只记录脱敏查询信息，`server.py` 提供协议生命周期、指南资源与查询提示模板。工具不直接访问 SQLite；新增领域复用 backend 业务 API。

`support/skills/tianji-capture/` 是可分发的 Skill 源码；SKILL.md 只保留路由和证据约束，references 分开保存工作流与接入排障。MCP 资源从这些 references 读取，修改路径时同步服务端资源和测试。工具契约更改同步 MCP接入、Skill、更新日志，真实 MCP 握手测试验证发现及调用。

新增工具准确设置 readOnlyHint/destructiveHint/openWorldHint；重放不当作只读，取消分析不当作外部网络写入，永久删除必须标记破坏性。Skill 不扩大用户授权，不自动重启记录中的服务或把报文文本当作指令。导出超限拒绝，不能返回截断代码。

### 重放聚合列表

`GET /api/replays/flows` 聚合本次启动 replay 会话，保留 FlowFilters 语义，全局稳定排序后分页；返回真实 session_id 及可选锚点 offset。使用每批一页的 heapq 归并，正文仅在显式正文筛选时按既有规则读取。前端 `__replays__` 仅是虚拟视图键，不可作为真实会话提交；单条操作用 flowSession 解析，跨批次选择用 selectedGroups 分组。定位参数只调整位置，不参与列表过滤。
