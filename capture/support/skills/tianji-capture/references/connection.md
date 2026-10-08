# 接入与排障

Skill 提供工作流，不会自动安装或启动 MCP。先确认本机项目目录、可用 Python 环境及实际 startup.toml；虚拟环境名字不要求 `.venv`。

浏览器入口 `python main.py --config /绝对路径/startup.toml`，App 入口 `python app_main.py`，共用后端。启动现有工作台不等于开始记录。不要因 MCP 连接失败就中断正在抓包的服务。

客户端可以配置 stdio 入口：

```json
{
  "mcpServers": {
    "capture": {
      "command": "/你的Python环境/bin/python",
      "args": ["/项目绝对路径/mcp_server.py", "--transport", "stdio", "--config", "/项目绝对路径/startup.toml"]
    }
  }
}
```

如果 startup.toml 的 [mcp] 已启用 streamable-http，MCP 地址由 host/port 决定（默认 `http://127.0.0.1:8766/mcp`）。API 默认 8765，MCP 默认 8766，两者不能混用。不是 Proxyman 的握手文件/token 机制。只配置用户选择的客户端，保留其他 MCP 配置。

接入后实际 MCP initialize → tools/list → get_workbench_status 验证；端口监听只能证明有进程，不保证工具可用。此 Skill 不依赖固定客户端工具前缀。

| 现象 | 处理 |
| --- | --- |
| 工具不可见 | 查入口 Python 和项目路径、依赖及客户端发现状态；重新加载客户端 |
| 工作台无法连接 | 检查 API 地址和 main.py/app_main.py 是否运行；stdio MCP 启动不会自动启动 Web 后端 |
| 连接成功但无会话 | 查记录状态；旧会话使用 include_archived=true，不能因此自动清空或开始抓包 |
| 只有 TLS 隧道 | 查询 tls_mode/tls_domains 和 CA 信息，检查目标客户端是否走代理与信任 CA |
| 特定接口找不到 | 取消不必要的来源/时间/路径过滤；关键词选 response_body/bodies/all；核对是否截断或未缓存 |
| stale ID / 404 | 重查 list_sessions/search_requests，不根据界面行号猜 ID |
| 读取超时 | 缩小域名/时间范围与分页；原调用可能仍在后端计算，别并发重复全量搜索 |
| 重放超时 | 先查独立重放批次和状态，不盲目再次发送 |

HTTP MCP 限于本机，当前不声称具备 Proxyman 的握手认证或全输出自动脱敏。不要暴露到公网或把真实秘密放进 Skill。用户明确要求部署安全时再设计访问控制。

设计参考：[Proxyman MCP](https://docs.proxyman.com/mcp)、[Proxyman Agent Skills](https://github.com/ProxymanApp/proxyman-SKILL.md)。天机阁使用自己实现的工具和工作流，参考不代表兼容其全部操作。
