"""LeafVault repeatable quality gate for backend and frontend checks."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


CHECKS = [
    (
        "Python compile check",
        [sys.executable, "-m", "compileall", "core", "db", "routers", "services", "main.py"],
    ),
    (
    "Backend pytest",
    [
        sys.executable,
        "-m",
        "pytest",
        "-q",
        "-p",
        "no:cacheprovider",
        "--basetemp=.tmp/pytest-current",
    ],
),
    (
        "Frontend static check",
        [sys.executable, "scripts/frontend_static_check.py"],
    ),
    (
        "Frontend regression check",
        [sys.executable, "scripts/frontend_regression_check.py"],
    ),
    (
        "Mobile UI static check",
        [sys.executable, "scripts/mobile_ui_static_check.py"],
    ),
    (
        "Security static check",
        [sys.executable, "scripts/security_static_check.py"],
    ),
    (
        "PWA static check",
        [sys.executable, "scripts/pwa_static_check.py"],
    ),
    (
        "Demo mode static check",
        [sys.executable, "scripts/demo_mode_static_check.py"],
    ),
    (
        "Docker static check",
        [sys.executable, "scripts/docker_static_check.py"],
    ),
    (
        "Public deployment preflight",
        [sys.executable, "scripts/public_deploy_preflight.py", "--example"],
    ),
    (
        "Ops static check",
        [sys.executable, "scripts/ops_static_check.py"],
    ),
    (
        "Docs static check",
        [sys.executable, "scripts/docs_static_check.py"],
    ),
    (
        "Release static check",
        [sys.executable, "scripts/release_static_check.py"],
    ),
    (
        "JavaScript syntax check",
        [sys.executable, "scripts/js_syntax_check.py"],
    ),
]


def run_check(name: str, command: list[str]) -> tuple[bool, str]:
    print(f"\n=== {name} ===")
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip())
    return result.returncode == 0, " ".join(command)


def main() -> int:
    failures: list[tuple[str, str]] = []
    for name, command in CHECKS:
        ok, rendered_command = run_check(name, command)
        if not ok:
            failures.append((name, rendered_command))

    if failures:
        print("\nQuality gate failed:")
        for name, command in failures:
            print(f" - {name}: {command}")
        print("\nInstall test dependencies with `pip install -r requirements.txt` if pytest is missing.")
        return 1

    print("\nLeafVault quality gate passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
