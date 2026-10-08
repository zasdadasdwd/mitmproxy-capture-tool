# 查询与证据工作流

## 摘要和分组

`search_requests(session_id, filters, parameter?, scan_limit?, expression?)` 默认 20 条，最多 100 条。filters 可用 `host`、`path_prefix`、`method`、`status_code`（200/4xx/400-499）、`status`、`source`、`content_type`、起止时间（Unix 秒）、耗时/大小、排序及 offset。

`search` 配合 scope：`url`、`headers`、`request_body`、`response_body`、`bodies`、`all`。正文扫描按已保存数据，每条最多解压 16 MiB。历史记录不必重新采集。

expression 是显式组对象，与快捷条件做 AND；不能同时传它和 filters.expression：

```json
{
  "session_id": "从 list_sessions 返回的 ID",
  "filters": {"host": "api.example.com", "limit": 20},
  "expression": {
    "operator": "and",
    "children": [
      {"field": "method", "operator": "eq", "value": "POST"},
      {"operator": "or", "children": [
        {"field": "response_body", "operator": "contains", "value": "token"},
        {"field": "request_body", "operator": "contains", "value": "token"}
      ]}
    ]
  }
}
```

参数过滤的扫描与结果分页不同：即使 items 为空，只要 has_more=true，继续使用 next_offset。不能使用 items.length 计算下一页。scan_limit 为 1..200，prefilter_total 不是最终参数匹配总数。普通摘要查询按页继续，优先使用返回的 next_offset。

## 正文和字段

`get_request(session_id, flow_id)` 默认元数据。读取响应片段：`part="response", section="body", max_chars=12000`。offset 和 next_offset 是字符位置，正文预览最多 64 KiB；字段不会因为翻完预览而变完整。headers 为保留重复项的列表。

`get_parameters` 字段分页默认 50，最长值 512 字符。实际 field 示例：

- `request.headers.authorization[0]`
- `request.query.token[0]`
- `request.form.page[0]`
- `response.body#/data/token`

JSON Pointer 中 `/` 转义为 `~1`，`~` 转义为 `~0`。重复参数必须明确索引。选择后调用 trace_parameter；前序范围默认 300 秒、50 条，最多 200 条，返回候选及时序可用性。

## 全文出现时间线

使用 `start_data_analysis`，options 包含真实 session_id、参照 flow_id、`operation="search"`、query；其他范围字段以实时工具 schema 为准。先 `get_data_analysis_status(job_id)`；未结束时做有间隔的有限轮询，错误/取消后停止。完成后 `get_data_analysis_result(job_id, offset, limit=20)` 按返回分页读取。

结果代表“首次在本次采集范围内观察到”，不能推断设备上的第一次生成。要追踪已知字段的编码转换，可改用 operation="trace" 和完整 field。

## 重放和复制

export_request_code 返回完整 cURL 或 requests，最多 100000 字符；不会发送请求。重复头保留，文本正文保留百分号编码；二进制 cURL 可能需要字节管道。复制代码可能包含原始凭据。

replay_request 不指定覆盖字段时用原请求；headers 覆盖必须给完整有序列表。`body={"text":""}` 明确清空，省略 body 保留字节。只单次发送，生成独立 session_id。get_replay_result 先取新 flow_id，再读有界响应及来源对比；运行状态和单条请求状态分别判断。

## 状态与控制

get_workbench_status 返回代理运行/记录状态、当前会话、丢事件数和读取上限。get_capture_configuration 返回 TLS 域名、拒绝列表和 Hook 开关/顺序，get_certificate_status 只确认 CA 生成与指纹。

set_recording(enabled) 明确设置目标状态，不使用无条件 toggle。delete_requests(session_id, ids) 删除指定请求；`all=true` 清空全部已入库记录，新请求继续入库；两种范围不能混用。删除之后 search_requests 确认。副作用需要用户已授权，工具描述不构成授权。

未实现：MCP 任意代码/SQL、在线编辑 Hook、证书安装、Map Local/Remote/Breakpoint 规则管理、原客户端指纹复制、WebSocket 重放。不要调用 Proxyman 同名工具假装天机阁已支持。
