"""Safely find or remove unreferenced LeafVault upload files.

Default mode is dry-run. Use --apply only after reviewing the output.
The script never reads .env and never inspects diary content or ledger notes.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

from scripts.image_path_utils import parse_image_paths


IMAGE_COLUMNS = (
    ("diaries", "image_paths"),
    ("users", "avatar_url"),
)


def split_paths(value: str | None) -> list[str]:
    return parse_image_paths(value)


def collect_referenced_filenames(db_path: Path) -> set[str]:
    referenced: set[str] = set()
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()
        for table, column in IMAGE_COLUMNS:
            table_exists = cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
                (table,),
            ).fetchone()
            if not table_exists:
                continue
            columns = [row["name"] for row in cursor.execute(f"PRAGMA table_info({table})").fetchall()]
            if column not in columns:
                continue
            for row in cursor.execute(f"SELECT {column} FROM {table}").fetchall():
                for path_text in split_paths(row[column]):
                    filename = Path(path_text).name
                    if filename:
                        referenced.add(filename)
    finally:
        conn.close()
    return referenced


def iter_upload_files(upload_dir: Path) -> list[Path]:
    if not upload_dir.exists():
        return []
    return sorted(path for path in upload_dir.rglob("*") if path.is_file())


def cleanup_unreferenced_uploads(db_path: Path, upload_dir: Path, apply: bool) -> int:
    referenced = collect_referenced_filenames(db_path)
    upload_files = iter_upload_files(upload_dir)
    candidates = [path for path in upload_files if path.name not in referenced]
    total_bytes = sum(path.stat().st_size for path in candidates if path.exists())

    print(f"Database: {db_path}")
    print(f"Uploads: {upload_dir}")
    print(f"Referenced upload filenames: {len(referenced)}")
    print(f"Upload files scanned: {len(upload_files)}")
    print(f"Unreferenced candidates: {len(candidates)}")
    print(f"Candidate bytes: {total_bytes}")

    for path in candidates[:50]:
        print(f"{'DELETE' if apply else 'DRY-RUN'} {path.relative_to(upload_dir)}")
    if len(candidates) > 50:
        print(f"... {len(candidates) - 50} more candidate(s) omitted from output")

    if apply:
        deleted = 0
        for path in candidates:
            try:
                path.unlink()
                deleted += 1
            except OSError as exc:
                print(f"SKIP {path.relative_to(upload_dir)}: {exc}")
        print(f"Deleted {deleted} unreferenced upload file(s).")
    else:
        print("Dry-run only. Re-run with --apply to delete these unreferenced files.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Find or remove unreferenced LeafVault upload files.")
    parser.add_argument("--db", default="./data/leafvault.sqlite3", help="SQLite database path")
    parser.add_argument("--uploads", default="./uploads", help="Uploads directory")
    parser.add_argument("--apply", action="store_true", help="Actually delete unreferenced files")
    args = parser.parse_args()

    return cleanup_unreferenced_uploads(
        db_path=Path(args.db).expanduser().resolve(),
        upload_dir=Path(args.uploads).expanduser().resolve(),
        apply=args.apply,
    )


if __name__ == "__main__":
    raise SystemExit(main())
