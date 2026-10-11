"""从子进程日志镜像到启动控制台，不用管道阻塞代理输出。"""

import codecs
import sys
import threading


class ConsoleLogRelay:
    """固定大小读取日志；控制台不可用时停止镜像，原日志写入不受影响。"""

    def __init__(self, path, offset=0):
        self.reader = path.open("rb")
        self.reader.seek(offset)
        self.output = sys.stdout
        self.stopped = threading.Event()
        self.thread = threading.Thread(
            target=self._run, name="capture-console", daemon=True
        )

    def start(self):
        """在子进程启动后开始转发新输出。"""
        self.thread.start()

    def _run(self):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        try:
            while True:
                chunk = self.reader.read(8192)
                if chunk:
                    text = decoder.decode(chunk)
                elif self.stopped.is_set():
                    text = decoder.decode(b"", final=True)
                    if text and self.output is not None:
                        self.output.write(text)
                        self.output.flush()
                    break
                else:
                    self.stopped.wait(0.05)
                    continue
                if text and self.output is not None:
                    self.output.write(text)
                    self.output.flush()
        except (OSError, ValueError, UnicodeError):
            # IDE 控制台关闭或编码失败不能影响代理和日志。
            pass
        finally:
            self.reader.close()

    def close(self):
        """子进程退出后排空尾部；失去响应的控制台不阻塞服务退出。"""
        self.stopped.set()
        if self.thread.ident is not None:
            self.thread.join(timeout=1)
        else:
            self.reader.close()
