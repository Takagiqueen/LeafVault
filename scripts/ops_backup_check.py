"""Validate a LeafVault server-level backup archive."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path


SENSITIVE_MARKERS = [
    "SECRET_KEY",
    "REGISTRATION_INVITE_CODE",
    "AI_API_KEY",
    "SENDER_PASSWORD",
    "token",
    "csrf",
    "password",
    "invite_code",
]


def is_forbidden_archive_name(name: str) -> bool:
    lower = name.lower()
    path = Path(lower)
    return (
        lower == ".env"
        or "/.env" in lower
        or path.name.startswith(".env")
        or lower.endswith(".log")
        or "repomix-output.xml" in lower
        or "__pycache__" in lower
    )


def check_sqlite_file(db_path: Path) -> None:
    if not db_path.exists() or db_path.stat().st_size <= 0:
        raise ValueError("database backup is missing or empty")
    conn = sqlite3.connect(str(db_path))
    try:
        result = conn.execute("PRAGMA integrity_check").fetchone()
        if not result or str(result[0]).lower() != "ok":
            raise ValueError("database integrity_check did not return ok")
    finally:
        conn.close()


def check_backup_archive(archive_path: Path) -> list[str]:
    errors: list[str] = []
    if not archive_path.exists():
        return [f"backup file does not exist: {archive_path}"]
    try:
        with zipfile.ZipFile(archive_path, "r") as zip_file:
            names = zip_file.namelist()
            bad_names = [name for name in names if is_forbidden_archive_name(name)]
            errors.extend(f"backup must not contain {name}" for name in bad_names)

            if "manifest.json" not in names:
                errors.append("manifest.json is missing")
                manifest = {}
            else:
                try:
                    manifest = json.loads(zip_file.read("manifest.json").decode("utf-8"))
                except Exception as exc:
                    errors.append(f"manifest.json is invalid: {exc}")
                    manifest = {}

            manifest_text = json.dumps(manifest, ensure_ascii=False)
            for marker in SENSITIVE_MARKERS:
                if marker.lower() in manifest_text.lower():
                    errors.append(f"manifest.json must not contain sensitive marker `{marker}`")

            db_name = manifest.get("database_file") or "database/leafvault.db"
            if db_name not in names:
                errors.append("database backup file is missing")
            if not any(name == "uploads/" or name.startswith("uploads/") for name in names):
                errors.append("uploads directory entry is missing")

            if db_name in names:
                with tempfile.TemporaryDirectory(prefix="leafvault-backup-check-") as tmp:
                    extracted_db = Path(tmp) / "leafvault.db"
                    extracted_db.write_bytes(zip_file.read(db_name))
                    try:
                        check_sqlite_file(extracted_db)
                    except Exception as exc:
                        errors.append(f"database backup is not usable: {exc}")
    except zipfile.BadZipFile:
        errors.append("backup file is not a valid zip archive")
    return errors


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check a LeafVault server-level backup zip.")
    parser.add_argument("--file", required=True, type=Path, help="Backup zip file to validate.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    errors = check_backup_archive(args.file)
    if errors:
        print("LeafVault backup check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("LeafVault backup check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
