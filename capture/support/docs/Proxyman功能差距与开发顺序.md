# 天机阁与 Proxyman 功能差距

检查日期：2026-10-08。依据当前项目代码和 Proxyman 官方文档；“引擎支持”不代表工作台已有对应的存储、操作和预览界面。

## 本轮已完成

- 域名策略使用浮层，展开不挤压请求详情；编辑重放支持 Headers、Query、表单及 JSON 对象表格，保留原文模式。
- 参数支持重复名称、上下排序、添加与删除；未修改的 Query 编码、正文字节保持原样，JSON 大整数和重复键不会因表格解析丢失。
- 重放按来源版本选择 HTTP/2 协商或 HTTP/1.1，独立连接池避免 HTTP/1 请求复用 HTTP/2 连接。协商后保存实际版本，服务器不支持 HTTP/2 时记录回退。HTTP/1.0 目前使用 HTTP/1.1；未知版本允许 HTTP/2 协商。HTTP/3、h2c 不在此次重放支持范围内。
- 以上不保证原客户端 TLS 或 HTTP/2 指纹，不保证 Host、Content-Length、连接专用头及网络帧逐字节一致。编辑参数及调整顺序可能要求重新计算签名。

## 已有的主要能力

当前具备 HTTPS 域名解密策略与拒绝策略、CA 管理、直连及上游代理、会话持久化及管理、请求目录、全文和分组条件查询、请求/响应 JSON 预览、请求重放及编辑、cURL/requests 复制、HAR 等导出、可继承注册的 Python Hook、MCP 查询日志，以及参数出现时间线和数据链路分析。App 与浏览器共用后端。

## 建议开发顺序

| 优先级 | 功能 | 当前差距 | 建议范围 |
| --- | --- | --- | --- |
| P1 | 双向协议及连接信息 | 已补两端 ALPN/TLS/连接 ID 与可测 TCP/TLS 时长；完整 DNS/连接事件日志及连接复用统计尚缺 | 当前快照已实现；后续独立记录 DNS 与连接事件，缺失信息保持未知 |
| P1 | 大正文 / SSE | 已支持有界异步磁盘保存、大正文原文下载及 SSE 事件预览 | 默认每正文 64 MiB，超限/中断/失败明确标记；逐帧 WebSocket 另行开发 |
| P1 | WebSocket | 已支持双向重组消息增量存储、详情分页与文本/二进制预览 | 默认 1000 条/4 MiB，每条 64 KiB；尚不支持控制帧查看、发送与重放 |
| P1 | 请求对比 | 已接入双请求、跨会话基准、重放来源及分区差异窗口 | 支持重复字段、原始顺序、协议与字节前缀差异；正文预览不代表完整一致 |
| P2 | 交互断点 | Hook 能自动改请求/响应，但没有暂停、人工编辑、继续与终止的界面 | 请求/响应阶段规则、超时自动放行、显式继续，不阻塞其他连接 |
| P2 | Map Local / Map Remote | 可通过 Hook 编程实现，没有独立可视化规则 | 路径/域名匹配、响应文件替换及目标重定向，规则优先级与命中日志 |
| P2 | Multipart 预览与编辑 | 普通表单/JSON 可解析，multipart 缺少按 part 展示 | 先只读展示字段、文件名、大小、Content-Type；编辑时保留未改部分原文和 boundary |
| P2 | HAR 导入及请求构造 | 已有 HAR 导出，没有等价的通用 HAR 导入和空白新建请求界面 | 导入为独立会话，明确丢失的字段；复用重放编辑器构造新请求 |
| P2 | 自定义列及标注 | 现有固定列与筛选，缺少 Header/Query/JSON 路径列及请求颜色/备注 | 保存列配置、备注与颜色，按会话隔离 |
| P3 | Protobuf / gRPC | 正文以原始/文本/JSON 为主，缺少 schema 解码和 trailer 展示 | 先保存 trailers，展示 grpc-status；支持描述文件后再做 Protobuf 解码 |
| P3 | JSONPath / jq | JSON 树和搜索已有，但没有表达式查询视图 | JSONPath 优先，限制计算量；jq 不必引入外部进程作为默认依赖 |
| P3 | 多视图和模拟网络 | 缺少独立标签视图、双栏比较、带宽/延迟模拟 | 先请求对比，再多视图；网络模拟需独立规则和停用保护 |

不建议立即追求：原生网络扩展、团队云共享、完整原客户端指纹复刻。它们会明显增加平台依赖和维护成本，应先完善爬虫工程师日常用到的观察与编辑能力。

## HTTP/2 结论

Proxyman 官方文档同样区分客户端和上游两条连接：启用 HTTP/2 允许协商与 HTTP/1.1 回退，不保证所有请求使用 HTTP/2，也不意味着保留客户端指纹。工作台应显示实测协议，不能只显示配置值。

## 官方参考

- [HTTP/2](https://docs.proxyman.com/basic-features/http2)：两端协议、ALPN 与回退。
- [Connection Log](https://docs.proxyman.com/basic-features/connection-log)：DNS、连接、TLS 与协议事件。
- [Breakpoint](https://docs.proxyman.com/advanced-features/breakpoint)：请求和响应的交互暂停与编辑。
- [WebSocket](https://docs.proxyman.com/advanced-features/websocket)：消息方向、内容和二进制预览。
- [Import / Export](https://docs.proxyman.com/basic-features/import-export)：日志与 HAR 等格式交换。
- [官方功能索引](https://docs.proxyman.com/llms.txt)：其他能力的逐项入口。

本表只做差距记录，不表示已授权一次性实现全部功能。

## 按使用场景核对

状态：**已实现**表示当前项目有直接入口；**部分实现**表示有代码能力但覆盖不完整；**未接入**表示依赖引擎有基础，工作台没有完整采集/展示；**未实现**表示需开发新的工作台能力。

| 场景 | 当前状态 | 代码依据 / 实际限制 | 补齐后的验收标准 |
| --- | --- | --- | --- |
| HTTP/HTTPS 抓包及 TLS 域名控制 | 已实现 | `engine/addon.py`、`engine/policy.py`；解密/透传/拒绝分开 | 已有能力保留；策略变更真实生效 |
| HTTP/2 抓包及重放 | 部分实现 | mitmproxy 采集支持，`backend/replay.py` 本轮补按版本协商；双向协议摘要本轮已补；详细连接事件日志仍缺 | 用实测 ALPN 分别显示客户端和上游协议，不能把 offered 当 accepted |
| 原文/表格编辑重放 | 部分实现 | `web/replay-editor.js`；JSON 对象和表单，暂不编辑 multipart/JSON 数组表格 | 不改数据时字节一致，重复字段/排序可回读，签名风险有明确提示 |
| 请求参数对比 | 已接入 UI | `backend/analysis/service.py::compare` 与 MCP；UI 支持选中两条、基准及来源对比 | 对比 Headers、Query、Body 和响应，能区分新增/删除/修改 |
| UI 实时刷新 | 已实现 | `backend/api/events.py` 仅发送失效通知 | 不推送全部正文；批量更新保持列表可交互 |
| 抓取 WebSocket 消息 | 已接入重组消息 | 双向文本/二进制、顺序、时间、长度、截断和关闭信息可查看 | 不宣称原始分片/控制帧或 WebSocket 重放 |
| SSE 事件查看 | 已实现有界预览 | 响应与完整详情显示前 500 个完整事件，原文可切换及下载 | 后续可增加尾部追踪与事件筛选 |
| 交互断点 | 未实现 | 当前 Hook 是程序处理，不是人工暂停窗 | 可继续、取消/终止、超时处理；单请求暂停不阻塞其他流量 |
| Map Local / Remote 菜单规则 | 未实现 | BaseHook 可自行编写，不代表已有规则编辑器 | 规则顺序与命中日志清晰；明确 Host/URL 改写行为 |
| HAR 导出 | 已实现 | `backend/export.py` | 导出字段与实际保存内容一致，截断状态明确 |
| HAR / 第三方日志导入 | 未实现 | `backend/api/sessions.py` 有会话 ZIP 下载，无通用导入路由 | 恶意文件/路径校验，导入独立会话；缺失字段显示未知 |
| 请求新建 / 导入 cURL | 未实现 | 编辑器依赖来源 flow，cURL 目前用于复制/导出 | 空白构造新请求与 cURL 解析；不能执行导入的 shell 命令 |
| 请求颜色 / 备注 | 未实现 | 链路图的开发者备注不等于列表请求标注 | 请求级标注可保存、搜索、随导出带出 |
| Multipart / Protobuf / MessagePack | 未接入 | 现有预览以文本和 JSON 为主 | 保留原始字节；未知 schema 不虚构字段名称 |
| gRPC trailers | 未接入 | 当前 HTTP 快照未存 trailers | 显示 grpc-status/grpc-message，HTTP 200 不误判 RPC 成功 |
| 内容筛选 | 部分实现 | `advanced_filters.py` 已支持 AND/OR 和正文；暂不支持 regex/JSONPath | 表达式限量、执行超时；不要直接执行用户 Python/JS |
| 双栏/独立请求标签 | 未实现 | 当前一份列表筛选状态、一个详情与完整弹窗 | 视图之间筛选/选择隔离，不能修改全局会话查询 |
| 自定义列 | 未实现 | 列宽/排序已有；字段类型固定 | 支持 Header/Query/JSON 路径，长值不撑破列表 |
| 客户端证书 mTLS / 自定义 CA | 部分实现 | 自有 CA 安装及信任已有；无用户自定义服务器/客户端证书管理 | 证书路径、权限、匹配域名、失败原因明确，私钥不上报 |
| 进程级抓包及绕过系统代理的流量 | 未实现 | HTTP 显式代理与系统代理不是网络扩展 | 作为独立平台项目评估，不能宣称自动抓全部 Mac 程序 |

## 当前建议先后次序

1. 完成当前编辑器和 HTTP/2 的兼容回归，优先修实际使用问题。
2. 双向连接信息：减少“浏览器用了 HTTP/2 但上游不是”的判断错误。
3. 大正文/SSE 的存储与缺失提示，补齐“收到却看不到完整内容”的观察能力。
4. WebSocket 消息采集；随后补请求差异 UI。
5. 交互断点和映射规则，再做二进制解析、导入和高级预览。

以上为建议顺序，下一轮只实施用户明确选择的范围；现阶段没有顺带加入以上缺失功能。

补充参考：[Map Local](https://docs.proxyman.com/advanced-features/map-local)、[Map Remote](https://docs.proxyman.com/advanced-features/map-remote)、[Multipart 预览](https://docs.proxyman.com/basic-features/multipart-form-data-previewer)。

## 差距修复记录

2026-10-08：第一项双向连接摘要已完成源码与单元测试，显示客户端及上游的真实协商信息，不改变转发策略；没有增加新的顶栏按钮。旧会话不补造连接数据，后台未重启前不会生成新快照。完整 DNS 事件、连接重用统计和详细连接日志继续保留为未完成项。
