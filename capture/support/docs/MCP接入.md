# Capture MCP 接入

MCP 已实现，通过本机工作台 API 查询会话、分析链路、追踪参数、比较报文和重放。分析功能在后端统一实现，MCP 不直接打开 SQLite。

## 安装与启动

```bash
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python main.py --config startup.toml
```

新增后端分析接口需要重启工作台才能生效。正在抓包时先停止记录；重启后的抓包是新会话，之前的数据会保留。

### stdio：由 Agent 客户端启动

默认推荐本机 stdio，工作台保持运行。在支持 `mcpServers` 配置的客户端中填写（路径替换成你的实际项目路径）：

```json
{
  "mcpServers": {
    "capture": {
      "command": "/Users/a1234/PycharmProjects/PythonProject/.venv/bin/python",
      "args": [
        "/Users/a1234/PycharmProjects/PythonProject/mcp_server.py",
        "--transport", "stdio",
        "--config", "/Users/a1234/PycharmProjects/PythonProject/startup.toml"
      ]
    }
  }
}
```

`mcp_server.py` 可从任意工作目录启动。stdio 模式不向 stdout 打印日志，stdout 专用于 MCP JSON-RPC。这里的 `[mcp].enabled` 可以保持 false，它只控制是否随工作台启动 HTTP MCP。

### Streamable HTTP：独立启动或随工作台启动

```bash
.venv/bin/python mcp_server.py --transport streamable-http
```

默认 MCP 地址：`http://127.0.0.1:8766/mcp`。需要随工作台启动时，在 `startup.toml` 设置：

```toml
[mcp]
enabled = true
transport = "streamable-http"
host = "127.0.0.1"
port = 8766
entrypoint = "capture.agent_mcp.server:main"
```

浏览器入口 `python main.py` 和 App 入口 `python app_main.py` 共用此配置。App 创建后端时会同时启动 MCP，退出时关闭自己创建的 Web 与 MCP。App 复用已运行的浏览器后端时，服务仍由原后端管理，关闭窗口不会停止它。若修改配置前后端已经启动，需要先重启后端再生效。

stdio 应由 Agent 客户端启动，不能与 Web 服务混用标准输入输出。MCP 与 Web 端口不能相同；HTTP MCP 仅绑定本机。多客户端查询各自传入明确的会话与请求标识，不共享 UI 的当前选择。

命令行还支持 `--api-url http://127.0.0.1:8765` 与 `--log-file /absolute/path/mcp.jsonl`。

## 已实现工具

| 工具 | 用途 |
| --- | --- |
| `list_sessions` | 当前会话摘要；显式 `include_archived=true` 查询历史；默认 20 条分页 |
| `search_requests` | SQL 条件筛选摘要，可附加参数条件，默认 20 条，最多 100 条 |
| `get_request` | 默认只取元数据；指定 part/section 后分段读取头部或正文 |
| `get_parameters` | 返回可定位的参数路径，默认 50 个字段，可分页 |
| `trace_parameter` | 在指定会话前序请求中追踪参数值的候选来源 |
| `get_request_chain` | 返回明确的重放来源与响应值匹配的候选关系 |
| `compare_requests` | 比较两条明确请求，可跨会话；最多 100 个差异 |
| `replay_request` | 一次重放，可覆盖 URL、方法、头部、正文；具有网络副作用 |
| `get_replay_result` | 查看任务状态、响应片段及相对原请求的变化 |

MCP 第一版不提供删除、任意 SQL、任意 Python 执行或自动配置修改工具。已有工作台 REST API 仍可供你另写扩展。

## 条件查询，先摘要后正文

`filters` 支持 AND 组合：`search`、`scope=url|headers|all`、`host`、`path_prefix`、`method`、`status_code`、`status`、`source`、`content_type`、`min_duration`、`max_duration`、`min_size`、`started_after`、`started_before`、`offset`、`limit`。

时间使用 Unix 秒，可包含小数。域名支持精确匹配与 `*.example.com`；路径按目录边界匹配，`/am1` 不会匹配 `/am10`。`scope=all` 搜索 URL、头部和错误信息，不搜索任意正文。

例如调用 `search_requests`：

```json
{
  "session_id": "会话 ID",
  "filters": {
    "host": "api.example.com",
    "path_prefix": "/api/login",
    "method": "POST",
    "status_code": "2xx",
    "limit": 20
  },
  "parameter": {
    "field": "response.body#/code",
    "operator": "equals",
    "value": "0"
  },
  "scan_limit": 100
}
```

参数运算为 `equals`、`contains`、`exists`；JSON 数字和布尔值的比较值使用字符串，如 `"0"`、`"true"`。

普通查询只读取 SQL 摘要。参数查询先由 SQL 缩小范围，再检查最多 200 条正文预览；结果是扫描范围内的命中项，并不表示已经查完全部请求。即使 `items` 为空，只要 `has_more=true` 仍可继续：将 `filters.offset` 更新为 `next_offset`。`prefilter_total` 是 SQL 条件命中总数，不是参数匹配总数。

`incomplete_requests` 表示部分字段无法完整解析。正文最多分析 64 KiB 预览，multipart、二进制正文和客户端运行时调用栈暂不解析。

## 参数路径与来源判断

先调用 `get_parameters` 得到准确字段路径，再调用 `trace_parameter`：

```json
{
  "session_id": "会话 ID",
  "flow_id": "请求 ID",
  "field": "request.headers.authorization[0]",
  "limit": 50,
  "window_seconds": 300
}
```

路径示例：

- `request.query.token[0]`：query 中第一个 token。
- `request.headers.authorization[0]`：大小写归一化后的请求头。
- `response.cookies.sessionid`：Set-Cookie 的 cookie 值。
- `request.form.page[0]`：URL 编码表单。
- `response.body#/data/token`：JSON Pointer；`/` 转义为 `~1`，`~` 为 `~0`。

无重复值时可省略 `[0]`；多个匹配值会要求明确索引。JSON 参数值提取最多 1000 个字段、16 层嵌套；MCP 字段列表分段返回，长值会明确标注截断。

来源追踪支持原值、Bearer 前缀、URL 解码、Base64 解码匹配。返回 `causality=unconfirmed` 和 `generation_source=unknown`，不能据此断言客户端生成函数。响应必须先完成才能供后续请求使用；`available_before_target=false` 的匹配不能作为前序响应来源。短值容易偶然匹配，会有提示。

链路工具第一版聚焦目标请求的前序响应匹配和已记录重放来源，不自动构建整站因果图。`original_request` 与发送请求可比较代理 Hook 前后变化；`executed_hooks` 只说明执行了哪些代理 Hook，不包含客户端函数栈。后续浏览器、Frida 证据可增加独立接入口。

## 重放与结果

调用 `replay_request`：

```json
{
  "session_id": "来源会话 ID",
  "flow_id": "来源请求 ID",
  "url": "https://api.example.com/items?page=2",
  "body": {"text": "{\"page\":2}"}
}
```

仅指定要覆盖的字段，其余从原始请求读取；`body.text` 是 UTF-8 文本，空字符串表示清空正文。不指定 body 时保留原始字节；修改正文会移除 Content-Encoding/Content-Length。`headers` 可传完整键值对列表，保留重复头。

工具会真实访问目标服务器；应在用户授权范围内使用。重放不执行代理 Hook、不自动跟随重定向，仍执行域名拒绝策略。每次生成独立会话，原记录不覆盖，新记录保存 `original_session_id`、`original_flow_id`。

返回 `session_id` 后调用 `get_replay_result` 查看摘要；得到新 `flow_id` 后再次调用结果工具获取响应和对比。等待过程不阻塞 MCP 工具，状态可能为 running/pending/error/complete，批次完成不等于每条请求都成功。

## 开发者日志

默认日志：`data/logs/mcp.jsonl`，北京时间 ISO 时间，每条调用一行 JSON。单文件 5 MiB，保留 3 份轮转备份。

```bash
tail -f data/logs/mcp.jsonl
```

记录内容：调用 ID、工具名、会话/目标请求 ID、查询条件、返回请求 ID、实际扫描请求 ID、关联请求 ID、耗时、成功/错误类型。参数匹配扫描中的请求 ID 会记日志，但内部审计字段不会额外输出给 Agent。

搜索词、参数条件值、编辑 URL、头部和正文只记长度及 SHA-256 摘要，不记录正文、Cookie、token 明文；错误不写可能携带报文的异常文本。域名、目录、字段路径等查询范围保留，供开发者查看。MCP SDK 自身协议诊断写 stderr，不写 stdout。

## 测试

```bash
.venv/bin/python -m pytest -q
```

测试使用临时数据与本机服务，覆盖真实 stdio/Streamable HTTP 协议握手、筛选与分页、参数来源证据、日志脱敏及真实本机重放。不会重放用户现有请求，也不会修改用户抓包会话。

### 工作台实时查询日志

从工作台「设置 → MCP 查询日志 → 打开实时日志」进入，也可直接打开 `http://127.0.0.1:8765/mcp-logs.html`。
页面通过 SSE 自动显示新调用，断线后自动重连；支持筛选、暂停与展开查看条件、请求 ID、耗时和错误类型。显示最近 100 条，读取日志尾部最多 2 MiB，不加载抓包正文。隐藏页面时停止订阅，恢复后补齐最近记录。

默认审计文件为 `data/logs/mcp.jsonl`。若使用 `--log-file` 自定义路径，该文件需由开发者直接查看，工作台仅读取默认目录。普通抓包 API 查询不会自动进入 MCP 日志；另行记录的分析证据复核显示为「分析 API」。

### 独立进程数据链路分析

新增 `start_data_analysis`（options.operation 为 fields/trace）、`get_data_analysis_status`、`get_data_analysis_result`（默认 20 项、最多 100）、`cancel_data_analysis`、`list_data_analysis_views`。先发现字段，再指定完整 field 创建后续追踪任务；不要直接读取整个图。任务会写查询日志，状态与取消不会影响代理。

详见 [数据链路说明](数据链路.md)。
