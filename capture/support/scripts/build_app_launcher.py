"""生成本机双击启动器；使用指定 Python 环境，不冻结源码或 Hook。"""

import argparse
import os
import plistlib
import shlex
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def main():
    """默认使用当前解释器，也可通过 --python 选择虚拟环境或 Conda。"""
    parser = argparse.ArgumentParser(description="生成天机阁本机 App 启动器")
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Python 解释器路径或命令名，默认使用执行本脚本的解释器",
    )
    args = parser.parse_args()
    selected = os.path.expanduser(args.python)
    found = shutil.which(selected)
    if not found:
        parser.error(f"Python 解释器不存在或不可执行：{args.python}")
    # 保留虚拟环境中的符号链接路径；resolve() 会指向系统 Python，丢失环境。
    interpreter = Path(found).absolute()
    app = ROOT / "dist/天机阁.app"
    contents = app / "Contents"
    executable = contents / "MacOS/tianjige"
    executable.parent.mkdir(parents=True, exist_ok=True)
    resources = contents / "Resources"
    resources.mkdir(exist_ok=True)
    log_path = ROOT / "data/logs/app-launcher.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    executable.write_text(
        "#!/bin/sh\n"
        f"cd {shlex.quote(str(ROOT))} || exit 1\n"
        f"exec {shlex.quote(str(interpreter))} "
        f"{shlex.quote(str(ROOT / 'app_main.py'))} >>{shlex.quote(str(log_path))} 2>&1\n",
    )
    executable.chmod(0o755)
    shutil.copy2(
        ROOT / "capture/desktop/assets/tianjige.icns", resources / "tianjige.icns"
    )
    with (contents / "Info.plist").open("wb") as target:
        plistlib.dump(
            {
                "CFBundleName": "天机阁",
                "CFBundleDisplayName": "天机阁",
                "CFBundleIdentifier": "local.tianjige.source-window",
                "CFBundleExecutable": "tianjige",
                "CFBundlePackageType": "APPL",
                "CFBundleVersion": "1",
                "CFBundleIconFile": "tianjige.icns",
                "NSHighResolutionCapable": True,
            },
            target,
        )
    print(app)
    print(f"Python 环境：{interpreter}")


if __name__ == "__main__":
    main()
