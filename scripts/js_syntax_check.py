"""Run `node --check` over LeafVault frontend JavaScript modules."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    node = shutil.which("node")
    if not node:
        print("Node.js was not found. Install Node.js or add it to PATH before running JS syntax checks.")
        return 1

    js_files = sorted((ROOT / "static/js").rglob("*.js"))
    service_worker = ROOT / "static/service-worker.js"
    if service_worker.exists():
        js_files.append(service_worker)
    if not js_files:
        print("No JavaScript files found under static/js.")
        return 1

    failed: list[Path] = []
    for path in js_files:
        result = subprocess.run(
            [node, "--check", str(path)],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            failed.append(path)
            print(f"[FAIL] {path.relative_to(ROOT)}")
            if result.stdout.strip():
                print(result.stdout.strip())
            if result.stderr.strip():
                print(result.stderr.strip())

    if failed:
        print(f"JS syntax check failed for {len(failed)} file(s).")
        return 1

    print(f"JS syntax check passed for {len(js_files)} file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
