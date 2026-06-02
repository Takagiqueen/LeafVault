"""Safely migrate legacy /static/images diary paths to /uploads paths.

Default mode is dry-run. Use --apply to modify the database after a backup is
created next to the SQLite file.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.config import DB_PATH, STATIC_DIR, UPLOAD_DIR  # noqa: E402
from scripts.image_path_utils import parse_image_paths, resolve_image_file  # noqa: E402


def migrate_paths(paths: list[str], upload_dir: Path, static_images_dir: Path) -> tuple[list[str], int, int]:
    migrated = 0
    missing = 0
    next_paths: list[str] = []
    for value in paths:
        local_path, uploads_fallback = resolve_image_file(value, upload_dir, static_images_dir)
        if value.startswith("/static/images/") and local_path and uploads_fallback:
            if not local_path.exists() and uploads_fallback.exists():
                next_paths.append(f"/uploads/{uploads_fallback.name}")
                migrated += 1
                continue
            if not local_path.exists() and not uploads_fallback.exists():
                missing += 1
        next_paths.append(value)
    return next_paths, migrated, missing


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate confirmed legacy image paths to /uploads.")
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path")
    parser.add_argument("--uploads", default=str(UPLOAD_DIR), help="Upload directory")
    parser.add_argument("--apply", action="store_true", help="Apply changes. Default is dry-run.")
    args = parser.parse_args()

    db_path = Path(args.db).expanduser()
    upload_dir = Path(args.uploads).expanduser()
    static_images_dir = STATIC_DIR / "images"

    print(f"DB_PATH={db_path}")
    print(f"UPLOAD_DIR={upload_dir}")
    print(f"Mode={'apply' if args.apply else 'dry-run'}")

    if not db_path.exists():
        print("Database file does not exist.")
        return 1

    backup_path = None
    if args.apply:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = db_path.with_name(f"{db_path.name}.bak-{timestamp}")
        shutil.copy2(db_path, backup_path)
        print(f"Database backup created: {backup_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, image_paths FROM diaries WHERE image_paths IS NOT NULL AND image_paths != ''").fetchall()

    changed_rows = migrated_paths = missing_paths = skipped_rows = 0
    for row in rows:
        original_paths = parse_image_paths(row["image_paths"])
        next_paths, row_migrated, row_missing = migrate_paths(original_paths, upload_dir, static_images_dir)
        migrated_paths += row_migrated
        missing_paths += row_missing
        if row_migrated:
            changed_rows += 1
            print(f"diary_id={row['id']} migrate_count={row_migrated}")
            if args.apply:
                conn.execute("UPDATE diaries SET image_paths = ? WHERE id = ?", (",".join(next_paths), row["id"]))
        else:
            skipped_rows += 1

    if args.apply:
        conn.commit()
    conn.close()

    print(
        f"Summary: changed_rows={changed_rows} migrated_paths={migrated_paths} "
        f"skipped_rows={skipped_rows} missing_paths={missing_paths}"
    )
    if not args.apply:
        print("Dry-run only. Re-run with --apply to modify the database after reviewing the output.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
