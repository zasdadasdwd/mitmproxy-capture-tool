"""Independent macOS/Cocoa background memory probe; no capture/proxy API is used."""

import argparse
import json
import re
import subprocess
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import webview

from capture.desktop.window import bind_background_visibility

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--mode", choices=("old", "new"), default="new")
parser.add_argument("--seconds", type=int, default=120)
parser.add_argument(
    "--output", type=Path, default=Path("/tmp/tianji-background-memory.json")
)
args = parser.parse_args()
if not 5 <= args.seconds <= 3600:
    parser.error("--seconds must be between 5 and 3600")
root = Path(__file__).resolve().parents[2] / "web"
mode = args.mode
observed = []
failures = []
old = (
    subprocess.check_output(
        ["git", "show", "1dda75f:capture/web/appearance-background.js"],
        text=True,
        cwd=root.parent.parent,
    )
    if mode == "old"
    else None
)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kw):
        super().__init__(*args, directory=str(root), **kw)

    def log_message(self, *args):
        pass

    def do_GET(self):
        if urlsplit(self.path).path == "/":
            html = """<!doctype html><html><head><meta charset="utf-8"><script>window.qaErrors=[];addEventListener('error',e=>qaErrors.push(e.message));addEventListener('unhandledrejection',e=>qaErrors.push(String(e.reason)));</script></head><body>
   <button id="appearanceBackgroundBuiltin">启用</button><button id="appearanceBackgroundRemove">关闭</button>
   <select id="appearanceBackgroundGallery"></select><button id="appearanceBackgroundDelete">删除</button>
   <input id="appearanceBackgroundFile" type="file"><input id="appearanceBackgroundOpacity" type="range"><output id="appearanceBackgroundPercent"></output>
   <div id="appearanceBackgroundAnimationRow"><input id="appearanceBackgroundAnimation" type="checkbox"></div><p id="appearanceBackgroundStatus"></p>
   <script src="/background-player.js"></script><script src="/appearance-background.js"></script><script>initAppearanceBackground();</script></body></html>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode())
            return
        if old is not None and urlsplit(self.path).path == "/appearance-background.js":
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.end_headers()
            self.wfile.write(old.encode())
            return
        super().do_GET()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
original_pids = {
    int(l.split()[0])
    for l in subprocess.check_output(["ps", "-axo", "pid,comm"], text=True).splitlines()
    if "WebContent" in l
}
w = webview.create_window(
    "天机阁独立动画内存测试",
    f"http://127.0.0.1:{server.server_port}/",
    width=1280,
    height=800,
)


def memory():
    lines = subprocess.check_output(
        ["ps", "-axo", "pid,ppid,comm"], text=True
    ).splitlines()
    out = []
    for l in lines:
        parts = l.split(None, 2)
        if (
            len(parts) == 3
            and parts[0].isdigit()
            and int(parts[0]) not in original_pids
            and "WebContent" in parts[2]
        ):
            data = subprocess.check_output(["vmmap", "-summary", parts[0]], text=True)
            matched = re.search(r"Physical footprint:\s+([\d.]+)([MGK])", data)
            if matched:
                out.append(
                    {
                        "pid": int(parts[0]),
                        "MiB": float(matched[1])
                        * {"G": 1024, "M": 1, "K": 1 / 1024}[matched[2]],
                    }
                )
    return out


def check():
    try:
        time.sleep(0.6)
        w.show()
        import AppKit

        AppKit.NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        time.sleep(0.5)
        observed.append({"stage": "baseline", "memory": memory()})
        w.evaluate_js("document.getElementById('appearanceBackgroundBuiltin').click()")
        for _ in range(100):
            if (
                w.evaluate_js(
                    "document.getElementById('appearanceBackgroundBuiltin').getAttribute('aria-pressed')"
                )
                == "true"
            ):
                break
            time.sleep(0.1)
        assert (
            w.evaluate_js(
                "document.getElementById('appearanceBackgroundBuiltin').getAttribute('aria-pressed')"
            )
            == "true"
        ), w.evaluate_js(
            "({status:document.getElementById('appearanceBackgroundStatus').textContent,errors:qaErrors})"
        )
        w.evaluate_js(
            "let a=document.getElementById('appearanceBackgroundAnimation');a.checked=true;a.dispatchEvent(new Event('change'))"
        )
        w.evaluate_js(
            "window.frameTimes=[];window.previousTime=performance.now();function measure(t){frameTimes.push(t-previousTime);previousTime=t;requestAnimationFrame(measure)};requestAnimationFrame(measure)"
        )
        for i in range(args.seconds // 5):
            time.sleep(5)
            point = {
                "stage": f"play-{(i + 1) * 5}s",
                "memory": memory(),
                "state": w.evaluate_js(
                    "({errors:qaErrors,canvas:document.getElementById('appearanceAnimationCanvas')?.width,playing:document.getElementById('appearanceBackgroundAnimation').checked,hidden:document.hidden,src:!!document.getElementById('appearanceBackgroundLayer')?.getAttribute('src'),status:document.getElementById('appearanceBackgroundStatus').textContent})"
                ),
            }
            assert (
                not point["state"]["errors"]
                and not point["state"]["hidden"]
                and point["state"]["playing"]
            ), point
            if mode == "new":
                assert point["state"]["canvas"] == 1280, point
            observed.append(point)
            print(json.dumps(point), flush=True)
        if mode == "new":
            w.minimize()
            time.sleep(1)
            native_minimized = bool(w.native.isMiniaturized())
            if not native_minimized:
                # Headless/accessory sessions can refuse Dock minimization.
                # Still test the production event bridge without claiming OS coverage.
                w.events.minimized.set()
            for _ in range(50):
                if (
                    w.evaluate_js(
                        "document.getElementById('appearanceAnimationCanvas').width"
                    )
                    == 0
                ):
                    break
                time.sleep(0.1)
            assert (
                w.evaluate_js(
                    "document.getElementById('appearanceAnimationCanvas').width"
                )
                == 0
            ), w.evaluate_js(
                "({visible:window.__tianjiDesktopVisible,hidden:document.hidden,errors:qaErrors})"
            )
            assert w.evaluate_js("window.__tianjiDesktopVisible") is False
            if native_minimized:
                w.restore()
            else:
                w.events.restored.set()
            time.sleep(1)
            assert (
                w.evaluate_js(
                    "document.getElementById('appearanceAnimationCanvas').width"
                )
                == 1280
            )
            assert w.evaluate_js("window.__tianjiDesktopVisible") is True
            observed.append(
                {
                    "stage": "minimize-restore-bridge",
                    "native_minimized": native_minimized,
                    "released": True,
                    "resumed": True,
                }
            )
        result = w.evaluate_js(
            "(()=>{const a=frameTimes.slice(10).sort((a,b)=>a-b);return {samples:a.length,p95:a[Math.floor(a.length*.95)],max:a.at(-1),over50:a.filter(x=>x>50).length,errors:qaErrors};})()"
        )
        assert not result["errors"], result
        observed.append({"frames": result})
        for i in range(12):
            w.evaluate_js(
                "let a=document.getElementById('appearanceBackgroundAnimation');a.checked=false;a.dispatchEvent(new Event('change'))"
            )
            time.sleep(0.1)
            if mode == "new":
                assert (
                    w.evaluate_js(
                        "document.getElementById('appearanceAnimationCanvas').width"
                    )
                    == 0
                )
            w.evaluate_js(
                "let a=document.getElementById('appearanceBackgroundAnimation');a.checked=true;a.dispatchEvent(new Event('change'))"
            )
            time.sleep(0.1)
        observed.append({"stage": "after-12-restarts", "memory": memory()})
        if mode == "new":
            # Two 1px frames with different palette indices, no external artwork.
            header = b"GIF89a" + bytes.fromhex("01000100800000ff000000ff00")
            loop = b"\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00"
            frame = bytes.fromhex("21f90400050000002c0000000001000100000202")
            gif = (
                header
                + loop
                + frame
                + bytes.fromhex("440100")
                + frame
                + bytes.fromhex("4c01003b")
            )
            w.evaluate_js(
                f"let data=new Uint8Array({list(gif)});let transfer=new DataTransfer();"
                "transfer.items.add(new File([data],'synthetic.gif',{type:'image/gif'}));"
                "let input=document.getElementById('appearanceBackgroundFile');"
                "input.files=transfer.files;input.dispatchEvent(new Event('change'))"
            )
            for _ in range(100):
                if (
                    w.evaluate_js(
                        "document.getElementById('appearanceAnimationCanvas').width"
                    )
                    == 1
                ):
                    break
                time.sleep(0.05)
            colors = set()
            for _ in range(16):
                colors.add(
                    str(
                        w.evaluate_js(
                            "Array.from(document.getElementById('appearanceAnimationCanvas').getContext('2d').getImageData(0,0,1,1).data)"
                        )
                    )
                )
                time.sleep(0.035)
            assert len(colors) == 2, colors
            observed.append({"stage": "synthetic-gif-pixels", "colors": sorted(colors)})
        w.evaluate_js("document.getElementById('appearanceBackgroundRemove').click()")
        time.sleep(2)
        observed.append(
            {"stage": "closed", "memory": memory(), "errors": w.evaluate_js("qaErrors")}
        )
        print("MEMORY_QA_PASS", mode, json.dumps(observed), flush=True)
    except Exception as e:  # noqa: BLE001 - GUI test harness must report and fail on any error.
        import traceback

        traceback.print_exc()
        failures.append(repr(e))
        print("QA_FAILURE", mode, repr(e), flush=True)
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(observed, indent=2))
        w.destroy()


if mode == "new":
    bind_background_visibility(w)

w.events.loaded += lambda: threading.Thread(target=check, daemon=True).start()
with tempfile.TemporaryDirectory(prefix="tianji-animation-benchmark-") as storage:
    webview.start(gui="cocoa", private_mode=True, storage_path=storage)
server.shutdown()

if failures:
    raise SystemExit(1)
