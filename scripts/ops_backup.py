"""Create a server-level LeafVault backup package.

The backup intentionally excludes .env, logs, and other sensitive/runtime files.
It uses SQLite's backup API so the database can be copied more safely than a raw
file copy while the app is running.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_NAME = "leafvault.db"
FORBIDDEN_NAME_PARTS = {
    ".env",
    "repomix-output.xml",
    "__pycache__",
    ".pytest_cache",
}
FORBIDDEN_SUFFIXES = {".log", ".pyc", ".pyo"}
DOC_ALLOWLIST = [
    "README.md",
    "VERSION",
    "docs/OPERATIONS.md",
    "docs/RESTORE_GUIDE.md",
    "docs/PUBLIC_DEPLOYMENT.md",
    "docs/DEPLOYMENT_DOCKER.md",
]


@dataclass
class BackupStats:
    archive_path: Path
    database_file: str
    uploads_file_count: int
    uploads_total_bytes: int
    archive_bytes: int


def is_excluded(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    name = path.name.lower()
    if parts & FORBIDDEN_NAME_PARTS:
        return True
    if name.startswith(".env"):
        return True
    return path.suffix.lower() in FORBIDDEN_SUFFIXES


def count_uploads(uploads_dir: Path) -> tuple[int, int]:
    if not uploads_dir.exists():
        return 0, 0
    count = 0
    total = 0
    for item in uploads_dir.rglob("*"):
        if item.is_file() and not is_excluded(item.relative_to(uploads_dir)):
            count += 1
            total += item.stat().st_size
    return count, total


def backup_sqlite_database(source_db: Path, target_db: Path) -> None:
    if not source_db.exists() or source_db.stat().st_size <= 0:
        raise FileNotFoundError(f"SQLite database is missing or empty: {source_db}")
    target_db.parent.mkdir(parents=True, exist_ok=True)
    source_conn = sqlite3.connect(str(source_db))
    target_conn = sqlite3.connect(str(target_db))
    try:
        source_conn.backup(target_conn)
        target_conn.execute("PRAGMA integrity_check")
        target_conn.commit()
    finally:
        target_conn.close()
        source_conn.close()


def build_manifest(database_file: str, uploads_file_count: int, uploads_total_bytes: int) -> dict:
    version_path = ROOT / "VERSION"
    version = version_path.read_text(encoding="utf-8").strip() if version_path.exists() else "unknown"
    return {
        "app": "LeafVault",
        "backup_type": "server-level",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "version": version,
        "database_file": database_file,
        "uploads_file_count": uploads_file_count,
        "uploads_total_bytes": uploads_total_bytes,
        "notes": "This backup does not include .env or secrets.",
    }


def add_uploads_to_zip(zip_file: zipfile.ZipFile, uploads_dir: Path) -> tuple[int, int]:
    zip_file.writestr("uploads/", "")
    if not uploads_dir.exists():
        return 0, 0
    count = 0
    total = 0
    for item in sorted(uploads_dir.rglob("*")):
        if not item.is_file():
            continue
        rel = item.relative_to(uploads_dir)
        if is_excluded(rel):
            continue
        arcname = Path("uploads") / rel
        zip_file.write(item, arcname.as_posix())
        count += 1
        total += item.stat().st_size
    return count, total


def add_docs_to_zip(zip_file: zipfile.ZipFile) -> None:
    for rel_name in DOC_ALLOWLIST:
        path = ROOT / rel_name
        if path.exists() and path.is_file() and not is_excluded(path.relative_to(ROOT)):
            zip_file.write(path, Path("docs_bundle", rel_name).as_posix())


def prune_old_backups(out_dir: Path, name: str, keep: int) -> list[Path]:
    if keep <= 0:
        return []
    archives = sorted(out_dir.glob(f"{name}-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    removed: list[Path] = []
    for archive in archives[keep:]:
        archive.unlink()
        removed.append(archive)
    return removed


def create_backup(
    db_path: Path,
    uploads_dir: Path,
    out_dir: Path,
    *,
    keep: int | None = None,
    name: str = "leafvault-backup",
    include_docs: bool = False,
) -> BackupStats:
    db_path = db_path.resolve()
    uploads_dir = uploads_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    archive_path = out_dir / f"{name}-{timestamp}.zip"
    database_arcname = f"database/{DEFAULT_DB_NAME}"

    with tempfile.TemporaryDirectory(prefix="leafvault-backup-") as tmp:
        tmp_db = Path(tmp) / DEFAULT_DB_NAME
        backup_sqlite_database(db_path, tmp_db)

        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
            zip_file.write(tmp_db, database_arcname)
            uploads_count, uploads_bytes = add_uploads_to_zip(zip_file, uploads_dir)
            manifest = build_manifest(database_arcname, uploads_count, uploads_bytes)
            zip_file.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            if include_docs:
                add_docs_to_zip(zip_file)

    if keep is not None:
        prune_old_backups(out_dir, name, keep)

    return BackupStats(
        archive_path=archive_path,
        database_file=database_arcname,
        uploads_file_count=uploads_count,
        uploads_total_bytes=uploads_bytes,
        archive_bytes=archive_path.stat().st_size,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a LeafVault server-level backup zip.")
    parser.add_argument("--db", required=True, type=Path, help="Path to SQLite database file.")
    parser.add_argument("--uploads", required=True, type=Path, help="Path to uploads directory.")
    parser.add_argument("--out", required=True, type=Path, help="Directory for backup archives.")
    parser.add_argument("--keep", type=int, default=None, help="Keep only the most recent N backup archives.")
    parser.add_argument("--name", default="leafvault-backup", help="Backup archive filename prefix.")
    parser.add_argument("--include-docs", action="store_true", help="Include non-sensitive README/docs summary files.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        stats = create_backup(
            args.db,
            args.uploads,
            args.out,
            keep=args.keep,
            name=args.name,
            include_docs=args.include_docs,
        )
    except Exception as exc:
        print(f"LeafVault backup failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"Backup created: {stats.archive_path}")
    print(f"Archive size: {stats.archive_bytes} bytes")
    print(f"Database backup: {stats.database_file}")
    print(f"Uploads files: {stats.uploads_file_count}")
    print(f"Uploads total bytes: {stats.uploads_total_bytes}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
