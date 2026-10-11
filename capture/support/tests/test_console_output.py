"""用真实本机子进程验证控制台镜像，不启动代理或访问业务接口。"""

import io
import os
import subprocess
import sys
import time
from pathlib import Path

from capture.console_output import ConsoleLogRelay


def test_partial_utf8_and_unterminated_tail(tmp_path, monkeypatch):
    path = tmp_path / "engine.log"
    path.touch()
    output = io.StringIO()
    monkeypatch.setattr(sys, "stdout", output)
    relay = ConsoleLogRelay(path)
    relay.start()
    with path.open("ab", buffering=0) as writer:
        writer.write("天".encode()[:2])
        time.sleep(0.08)
        writer.write("天".encode()[2:] + b"\xff tail")
    relay.close()
    relay.close()
    assert output.getvalue() == "天� tail"
    assert not relay.thread.is_alive()
    assert relay.reader.closed


def test_failed_console_preserves_log(tmp_path, monkeypatch):
    class BrokenConsole:
        def write(self, text):
            raise BrokenPipeError("closed IDE")

    path = tmp_path / "engine.log"
    path.write_bytes(b"first\n")
    monkeypatch.setattr(sys, "stdout", BrokenConsole())
    relay = ConsoleLogRelay(path)
    relay.start()
    relay.close()
    with path.open("ab") as writer:
        writer.write(b"last\n")
    assert path.read_bytes() == b"first\nlast\n"
    assert relay.reader.closed


def test_desktop_nested_process_reaches_parent_and_both_logs(tmp_path, monkeypatch):
    """模拟 app_main → main → hook 两层日志，普通 print 无 flush 也即时可见。"""
    desktop = tmp_path / "desktop.log"
    desktop.write_bytes(b"previous run\n")
    engine = tmp_path / "engine.log"
    script = tmp_path / "backend.py"
    script.write_text(
        "import subprocess,sys,time\n"
        "from pathlib import Path\n"
        "from capture.console_output import ConsoleLogRelay\n"
        "path=Path(sys.argv[1])\n"
        "with path.open('wb') as log:\n"
        " child=subprocess.Popen([sys.executable,'-c',"
        "\"import sys,time; print('hook 中文'); "
        "print('hook error',file=sys.stderr); time.sleep(1.5)\"],"
        "stdout=log,stderr=subprocess.STDOUT)\n"
        " relay=ConsoleLogRelay(path); relay.start()\n"
        " child.wait(); relay.close()\n"
    )
    output = io.StringIO()
    monkeypatch.setattr(sys, "stdout", output)
    relay = ConsoleLogRelay(desktop, offset=desktop.stat().st_size)
    environment = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[3])
    with desktop.open("ab") as log:
        process = subprocess.Popen(
            [sys.executable, str(script), str(engine)],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=environment,
        )
        relay.start()
        try:
            deadline = time.monotonic() + 1.2
            while "hook error" not in output.getvalue() and time.monotonic() < deadline:
                time.sleep(0.02)
            assert process.poll() is None
            assert output.getvalue() == "hook 中文\nhook error\n"
            assert process.wait(timeout=5) == 0
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            relay.close()
    assert engine.read_text() == output.getvalue()
    assert desktop.read_text() == "previous run\n" + output.getvalue()
    assert not relay.thread.is_alive()
