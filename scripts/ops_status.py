"""Lightweight local operations status check for LeafVault deployments."""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


SENSITIVE_MARKERS = ["SECRET_KEY", "REGISTRATION_INVITE_CODE", "AI_API_KEY", "SENDER_PASSWORD", "token", "csrf"]


@dataclass
class StatusResult:
    errors: list[str]
    warnings: list[str]
    lines: list[str]


def directory_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += item.stat().st_size
    return total


def find_sqlite_database(data_dir: Path) -> Path | None:
    for pattern in ("*.db", "*.sqlite", "*.sqlite3"):
        matches = sorted(data_dir.glob(pattern))
        if matches:
            return matches[0]
    return None


def sqlite_is_openable(db_path: Path) -> bool:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA integrity_check").fetchone()
        return True
    finally:
        conn.close()


def fetch_json(url: str) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            data = response.read(512 * 1024)
        json.loads(data.decode("utf-8"))
        return True, "ok"
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def check_status(
    data_dir: Path,
    uploads_dir: Path,
    backups_dir: Path,
    *,
    url: str | None = None,
    warn_disk_percent: int = 80,
    warn_uploads_mb: int = 10240,
    warn_backups_mb: int = 20480,
) -> StatusResult:
    errors: list[str] = []
    warnings: list[str] = []
    lines: list[str] = []

    for label, path, required in [
        ("data", data_dir, True),
        ("uploads", uploads_dir, True),
        ("backups", backups_dir, False),
    ]:
        if path.exists():
            size = directory_size(path)
            lines.append(f"{label} directory: {path} ({size} bytes)")
        elif required:
            errors.append(f"{label} directory does not exist: {path}")
        else:
            warnings.append(f"{label} directory does not exist yet: {path}")

    if data_dir.exists():
        db_path = find_sqlite_database(data_dir)
        if not db_path:
            errors.append("SQLite database file was not found in data directory")
        else:
            try:
                sqlite_is_openable(db_path)
                lines.append(f"SQLite database: {db_path.name} is openable")
            except Exception as exc:
                errors.append(f"SQLite database is not openable: {type(exc).__name__}")

    uploads_mb = directory_size(uploads_dir) / (1024 * 1024)
    backups_mb = directory_size(backups_dir) / (1024 * 1024)
    if uploads_mb >= warn_uploads_mb:
        warnings.append(f"uploads size is high: {uploads_mb:.1f} MB")
    if backups_mb >= warn_backups_mb:
        warnings.append(f"backups size is high: {backups_mb:.1f} MB")

    try:
        usage = shutil.disk_usage(data_dir if data_dir.exists() else Path.cwd())
        used_percent = int((usage.used / usage.total) * 100) if usage.total else 0
        lines.append(f"Disk used: {used_percent}%")
        if used_percent >= warn_disk_percent:
            warnings.append(f"disk usage is above warning threshold: {used_percent}%")
    except Exception as exc:
        warnings.append(f"could not inspect disk usage: {type(exc).__name__}")

    if url:
        base = url.rstrip("/")
        for endpoint in ("/api/health", "/api/deployment/status"):
            ok, message = fetch_json(base + endpoint)
            if ok:
                lines.append(f"{endpoint}: ok")
            else:
                warnings.append(f"{endpoint}: {message}")

    return StatusResult(errors=errors, warnings=warnings, lines=lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check LeafVault deployment directories and optional public endpoints.")
    parser.add_argument("--data", required=True, type=Path, help="LeafVault data directory.")
    parser.add_argument("--uploads", required=True, type=Path, help="LeafVault uploads directory.")
    parser.add_argument("--backups", required=True, type=Path, help="LeafVault backups directory.")
    parser.add_argument("--url", default=None, help="Optional public base URL. Network is used only when this is provided.")
    parser.add_argument("--warn-disk-percent", type=int, default=80)
    parser.add_argument("--warn-uploads-mb", type=int, default=10240)
    parser.add_argument("--warn-backups-mb", type=int, default=20480)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = check_status(
        args.data,
        args.uploads,
        args.backups,
        url=args.url,
        warn_disk_percent=args.warn_disk_percent,
        warn_uploads_mb=args.warn_uploads_mb,
        warn_backups_mb=args.warn_backups_mb,
    )
    for line in result.lines:
        print(line)
    for warning in result.warnings:
        print(f"WARNING: {warning}")
    if result.errors:
        print("LeafVault ops status failed:")
        for error in result.errors:
            print(f" - {error}")
        return 1
    print("LeafVault ops status check completed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
