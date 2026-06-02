"""Static checks for LeafVault lightweight operations assets."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

REQUIRED_FILES = [
    "scripts/ops_backup.py",
    "scripts/ops_backup_check.py",
    "scripts/cleanup_unreferenced_uploads.py",
    "scripts/ops_status.py",
    "docs/OPERATIONS.md",
    "docs/RESTORE_GUIDE.md",
    "docker-compose.prod.yml",
    "docker-compose.local.yml",
]

FORBIDDEN_DOC_PHRASES = ["绝对安全", "军事级加密", "永不丢失"]
FORBIDDEN_SECRET_PATTERNS = [
    r"SECRET_KEY\s*=\s*(?!change-me|your-|<|示例)",
    r"REGISTRATION_INVITE_CODE\s*=\s*(?!change-me|your-|<|示例)",
    r"sk-[A-Za-z0-9_-]{12,}",
]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def service_block(compose: str, service: str) -> str:
    pattern = rf"(?ms)^  {re.escape(service)}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)"
    match = re.search(pattern, compose)
    return match.group(1) if match else ""


def check_compose() -> list[str]:
    errors: list[str] = []
    compose = read("docker-compose.prod.yml")
    for service in ("leafvault", "caddy"):
        block = service_block(compose, service)
        if not block:
            errors.append(f"docker-compose.prod.yml missing `{service}` service")
            continue
        for needle in ['logging:', 'driver: "json-file"', 'max-size: "10m"', 'max-file: "3"']:
            if needle not in block:
                errors.append(f"docker-compose.prod.yml `{service}` missing logging setting `{needle}`")
    leafvault_block = service_block(compose, "leafvault")
    if "8000:8000" in leafvault_block:
        errors.append("leafvault service must not publish 8000:8000; use 8001:8000 only for local Docker testing")
    if "ports:" in leafvault_block or "8001:8000" in leafvault_block:
        errors.append("docker-compose.prod.yml leafvault must not publish host ports; use docker-compose.local.yml for local Docker testing")
    if "--reload" in compose:
        errors.append("docker-compose.prod.yml must not use --reload")
    local_compose = read("docker-compose.local.yml")
    local_leafvault = service_block(local_compose, "leafvault")
    if "ports:" not in local_leafvault or "8001:8000" not in local_leafvault:
        errors.append("docker-compose.local.yml must publish 8001:8000 for local Docker testing")
    if "--reload" in local_compose:
        errors.append("docker-compose.local.yml must not use --reload")
    return errors


def check_backup_script() -> list[str]:
    errors: list[str] = []
    source = read("scripts/ops_backup.py")
    required = ["sqlite3", "backup(", "manifest.json", ".env", "repomix-output.xml", ".log"]
    for needle in required:
        if needle not in source:
            errors.append(f"ops_backup.py missing `{needle}`")
    forbidden_read_env = ["dotenv", "os.getenv(\"SECRET_KEY", "os.environ.get(\"SECRET_KEY"]
    for needle in forbidden_read_env:
        if needle in source:
            errors.append(f"ops_backup.py should not read secrets by default: `{needle}`")
    return errors


def check_cleanup_script() -> list[str]:
    errors: list[str] = []
    source = read("scripts/cleanup_unreferenced_uploads.py")
    for needle in ("--apply", "Dry-run", "diaries", "avatar_url"):
        if needle not in source:
            errors.append(f"cleanup_unreferenced_uploads.py missing `{needle}`")
    if "dotenv" in source or "os.getenv" in source or "os.environ" in source:
        errors.append("cleanup_unreferenced_uploads.py should not read environment secrets")
    return errors


def check_docs() -> list[str]:
    errors: list[str] = []
    for rel in ("docs/OPERATIONS.md", "docs/RESTORE_GUIDE.md"):
        source = read(rel)
        for phrase in FORBIDDEN_DOC_PHRASES:
            if phrase in source:
                errors.append(f"{rel} contains exaggerated claim `{phrase}`")
        for pattern in FORBIDDEN_SECRET_PATTERNS:
            if re.search(pattern, source):
                errors.append(f"{rel} appears to contain a real secret-like value")
    return errors


def run_checks() -> list[str]:
    errors: list[str] = []
    for rel in REQUIRED_FILES:
        if not (ROOT / rel).exists():
            errors.append(f"Missing required file: {rel}")
    if errors:
        return errors
    errors.extend(check_compose())
    errors.extend(check_backup_script())
    errors.extend(check_cleanup_script())
    errors.extend(check_docs())
    return errors


def main() -> int:
    errors = run_checks()
    if errors:
        print("LeafVault ops static check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("LeafVault ops static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
