"""导出函数不依赖 Web 框架。"""

import base64
import csv
import io
import json
import shlex
from datetime import datetime, timezone
from itertools import chain
from urllib.parse import parse_qsl, urlsplit

from capture.backend.replay import prepare_request


def curl_code(flow):
    """浏览器风格多行 cURL；文本正文原样引用，二进制才使用字节管道。"""
    request = prepare_request(flow["request"])

    def quoted(value):
        # 始终单引号，保留正文的空格、换行、百分号和 shell 元字符。
        return "'" + value.replace("'", "'\"'\"'") + "'"

    lines = ["curl " + quoted(request["url"])]
    method = request["method"].upper()
    if method == "HEAD":
        lines.append("  --head")
    elif method != "GET" or request["content"]:
        lines.append("  -X " + shlex.quote(method))
    for name, value in request["headers"]:
        lines.append("  -H " + quoted(f"{name}: {value}"))
    binary = False
    if request["content"]:
        try:
            text = request["content"].decode("utf-8")
            binary = any(ord(char) < 32 and char not in "\r\n\t" for char in text)
        except UnicodeDecodeError:
            binary = True
        lines.append("  --data-binary @-" if binary else "  --data-raw " + quoted(text))
    if any(name.lower() == "accept-encoding" for name, _ in request["headers"]):
        lines.append("  --compressed")
    command = (" " + chr(92) + "\n").join(lines)
    if binary:
        encoded = base64.b64encode(request["content"]).decode()
        command = (
            f"printf %s {shlex.quote(encoded)} | python3 -c 'import sys,base64; sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))' | "
            + command
        )
    return command


def python_code(flows):
    """生成可直接运行的 httpx 脚本，保留重复 Header 和正文原始字节。"""
    return "\n".join(python_lines(flows)) + "\n"


def python_lines(flows):
    """逐行生成脚本，批量导出时不累积所有请求正文。"""
    yield from [
        "import base64",
        "import httpx",
        "",
        "# headers 使用键值对列表，保留重复字段。",
        "with httpx.Client(follow_redirects=False, trust_env=False) as client:",
    ]
    for flow in flows:
        request = prepare_request(flow["request"])
        encoded = base64.b64encode(request["content"]).decode()
        yield from [
            f"    response = client.request({request['method']!r}, {request['url']!r},",
            f"        headers={request['headers']!r}, content=base64.b64decode({encoded!r}))",
            "    print(response.status_code, response.text)",
        ]


def requests_params_lines(flow, indent):
    """按 web_js 的参数字典格式生成请求；正文保留原始字节而非重新序列化。"""
    request = prepare_request(flow["request"])
    headers = {}
    duplicate = len({name.lower() for name, _ in request["headers"]}) != len(
        request["headers"]
    )
    for name, value in request["headers"]:
        headers[name] = value
    try:
        body = repr(request["content"].decode("utf-8")) + ".encode()"
    except UnicodeDecodeError:
        body = repr(request["content"])
    yield f'{indent}"method": {request["method"]!r},'
    url = urlsplit(request["url"])
    yield f'{indent}"url": {url._replace(query="", fragment="").geturl()!r},'
    query = parse_qsl(url.query, keep_blank_values=True)
    # 列表保留重复 Query；无重复时用字典便于编辑。
    params = query if len({key for key, _ in query}) != len(query) else dict(query)
    yield f'{indent}"params": {params!r},'
    yield f'{indent}"raw_query": {url.query!r},  # params 未改动时保留原始编码。'

    if duplicate:
        yield f'{indent}"headers": {request["headers"]!r},  # 重复头保留为列表。'
    else:
        yield f'{indent}"headers": {{'
        for name, value in headers.items():
            yield f"{indent}    {name!r}: {value!r},"
        yield f"{indent}}},"
    yield f'{indent}"data": {body},'
    yield f'{indent}"proxies": None,  # 需要代理时填写 http/https 代理地址。'
    yield f'{indent}"verify": True,'
    yield f'{indent}"timeout": 30,'
    yield f'{indent}"allow_redirects": False,'


def requests_lines(flows):
    """生成 requests 脚本；单条使用参数构建函数，批量使用 REQUESTS 列表顺序发送。"""
    records = iter(flows)
    first = next(records, None)
    second = next(records, None)
    if first is None:
        raise ValueError("请选择至少一条 HTTP 请求")
    yield from [
        "# 安装依赖：python -m pip install requests",
        "# URL 和正文保持采集内容；正文修改后 Content-Length 会自动计算。",
        "import requests",
        "from urllib.parse import parse_qsl",
        "",
        "",
    ]
    if second is None:
        yield from [
            "def build_request_params():",
            '    """返回可直接编辑的请求参数。"""',
            "    params = {",
        ]
        yield from requests_params_lines(first, "        ")
        yield from ["    }", "    return params"]
    else:
        yield "REQUESTS = ["
        for flow in chain((first, second), records):
            yield "    {"
            yield from requests_params_lines(flow, "        ")
            yield "    },"
        yield from [
            "]",
            "",
            "",
            "def build_request_params(index=0):",
            '    """复制指定请求参数，方便单独编辑和发送。"""',
            "    params = dict(REQUESTS[index])",
            '    params["headers"] = params["headers"].copy()',
            '    params["params"] = params["params"].copy()',
            "    return params",
        ]
    yield from [
        "",
        "",
        "def send_request(params=None):",
        '    """发送请求并返回完整响应。"""',
        "    if params is None:",
        "        params = build_request_params()",
        "    params = dict(params)",
        "    raw_query = params.pop('raw_query', '')",
        "    query = params.get('params', {})",
        "    pairs = list(query.items()) if isinstance(query, dict) else list(query)",
        "    if pairs == parse_qsl(raw_query, keep_blank_values=True):",
        "        params['url'] += ('?' + raw_query) if raw_query else ''",
        "        params.pop('params', None)",
        "    headers = params.pop('headers')",
        "    if isinstance(headers, dict):",
        "        response = requests.request(headers=headers, **params)",
        "    else:",
        "        from urllib3 import HTTPHeaderDict",
        "        # requests 的普通字典会合并重复头；在准备后用 urllib3 容器发送。",
        "        with requests.Session() as session:",
        "            options = {key: params.pop(key) for key in ('proxies', 'verify', 'timeout', 'allow_redirects')}",
        "            prepared = session.prepare_request(requests.Request(**params))",
        "            repeated = HTTPHeaderDict()",
        "            for key, value in headers:",
        "                repeated.add(key, value)",
        "            for key, value in prepared.headers.items():",
        "                if key not in repeated:",
        "                    repeated.add(key, value)",
        "            prepared.headers = repeated",
        "            response = session.send(prepared, **options)",
        "    print(f'Response Url: {response.url}')",
        "    print(f'Response Status Code: {response.status_code}')",
        "    print(f'Response Content Length: {len(response.content)}')",
        "    print(f'Response Body: {response.text[:100]}')",
        "    return response",
    ]
    if second is not None:
        yield from [
            "",
            "",
            "def send_all():",
            '    """按导出顺序发送全部请求，不产生并发突发流量。"""',
            "    for index in range(len(REQUESTS)):",
            "        send_request(build_request_params(index))",
        ]
    yield from [
        "",
        "",
        "if __name__ == '__main__':",
        "    send_request()" if second is None else "    send_all()",
    ]


def csv_export(flows):
    """导出流量摘要，避免抓包内容被电子表格识别为公式。"""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        ["method", "url", "status", "code", "duration_ms", "bytes", "source"]
    )
    for flow in flows:
        writer.writerow(csv_values(flow))
    return "\ufeff" + output.getvalue()


def csv_values(flow):
    """按固定字段顺序生成摘要，并转义电子表格公式前缀。"""
    values = [
        flow.get(key, "")
        for key in ("method", "url", "status", "code", "duration", "size", "source")
    ]
    return [
        "'" + value
        if isinstance(value, str) and value.startswith(("=", "+", "-", "@"))
        else value
        for value in values
    ]


def har_export(flows):
    """导出 HAR 1.2；附加采集状态和正文完整性标记。"""
    entries = [har_entry(flow) for flow in flows]
    return json.dumps(
        {
            "log": {
                "version": "1.2",
                "creator": {"name": "Capture Workbench", "version": "0.1"},
                "entries": entries,
            }
        },
        ensure_ascii=False,
        indent=2,
    )


def har_entry(flow):
    """转换单条 HAR 记录，供批量导出逐条写入。"""
    request = flow["request"]
    response = flow.get("response", {})
    headers = lambda message: [
        {"name": k, "value": v} for k, v in message.get("headers", [])
    ]
    content_type = lambda message: next(
        (v for k, v in message.get("headers", []) if k.lower() == "content-type"),
        "application/octet-stream",
    )
    duration = flow.get("duration") or 0
    return {
        "startedDateTime": datetime.fromtimestamp(
            flow["started"], timezone.utc
        ).isoformat(),
        "time": duration,
        "request": {
            "method": request["method"],
            "url": request["url"],
            "httpVersion": request.get("http_version", "HTTP/1.1"),
            "headers": headers(request),
            "cookies": [],
            "queryString": [
                {"name": k, "value": v}
                for k, v in parse_qsl(
                    urlsplit(request["url"]).query, keep_blank_values=True
                )
            ],
            "headersSize": -1,
            "bodySize": request.get("body_size", 0),
            "postData": {
                "mimeType": content_type(request),
                "text": request.get("body_text", ""),
            },
        },
        "response": {
            "status": flow.get("code") or 0,
            "statusText": "",
            "httpVersion": response.get("http_version", "HTTP/1.1"),
            "headers": headers(response),
            "cookies": [],
            "redirectURL": "",
            "headersSize": -1,
            "bodySize": response.get("body_size", 0),
            "content": {
                "size": response.get("body_size", 0),
                "mimeType": content_type(response),
                "text": response.get("decoded_b64", response.get("body_b64", "")),
                "encoding": "base64",
            },
        },
        "cache": {},
        "timings": {"send": 0, "wait": duration, "receive": 0},
        "_capture": {
            "status": flow["status"],
            "reason": flow.get("reason", ""),
            "requestTruncated": request.get("truncated", False),
            "responseTruncated": response.get("truncated", False),
        },
    }


def write_export(store, session_id, ids, format, path, request_url=None):
    """逐条读取并写入导出文件，内存占用不随选中记录数累积。"""

    def records():
        for flow_id in ids:
            flow = (
                store.get_summary(session_id, flow_id)
                if format == "csv"
                else store.get_flow(session_id, flow_id)
            )
            if format in ("curl", "python", "requests", "har") and not flow.get(
                "request"
            ):
                raise ValueError(
                    "此格式仅支持 HTTP 请求，请取消选择连接记录；连接记录可导出 JSON 或 CSV"
                )
            if request_url is not None:
                if not flow.get("request"):
                    raise ValueError("连接记录无法修改请求 URL")
                flow = {**flow, "request": {**flow["request"], "url": request_url}}
            yield flow

    with path.open("w", encoding="utf-8", newline="") as output:
        if format == "python":
            for line in python_lines(records()):
                output.write(line + "\n")
        elif format == "requests":
            for line in requests_lines(records()):
                output.write(line + "\n")
        elif format == "curl":
            for flow in records():
                output.write(curl_code(flow) + "\n\n")
        elif format == "csv":
            output.write("\ufeff")
            writer = csv.writer(output)
            writer.writerow(
                ["method", "url", "status", "code", "duration_ms", "bytes", "source"]
            )
            for flow in records():
                writer.writerow(csv_values(flow))
        else:
            if format == "har":
                output.write(
                    '{"log":{"version":"1.2","creator":{"name":"Capture Workbench","version":"0.1"},"entries":'
                )
            output.write("[")
            for index, flow in enumerate(records()):
                if index:
                    output.write(",")
                json.dump(
                    har_entry(flow) if format == "har" else flow,
                    output,
                    ensure_ascii=False,
                )
            output.write("]}}" if format == "har" else "]")
