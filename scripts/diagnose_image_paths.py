"""Diagnose LeafVault diary image_paths without printing diary content."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.config import DB_PATH, STATIC_DIR, UPLOAD_DIR  # noqa: E402
from scripts.image_path_utils import parse_image_paths, resolve_image_file  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose LeafVault diary image paths.")
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path")
    parser.add_argument("--uploads", default=str(UPLOAD_DIR), help="Upload directory")
    args = parser.parse_args()

    db_path = Path(args.db).expanduser()
    upload_dir = Path(args.uploads).expanduser()
    static_images_dir = STATIC_DIR / "images"

    print(f"DB_PATH={db_path}")
    print(f"UPLOAD_DIR={upload_dir}")
    print(f"STATIC_IMAGES_DIR={static_images_dir}")

    if not db_path.exists():
        print("Database file does not exist.")
        return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, user_id, date, image_paths FROM diaries WHERE image_paths IS NOT NULL AND image_paths != ''").fetchall()
    conn.close()

    total = found = missing = static_to_uploads = 0
    for row in rows:
        for db_image_path in parse_image_paths(row["image_paths"]):
            total += 1
            local_path, uploads_fallback = resolve_image_file(db_image_path, upload_dir, static_images_dir)
            local_exists = bool(local_path and local_path.exists())
            fallback_exists = bool(uploads_fallback and uploads_fallback.exists())
            if local_exists or fallback_exists:
                found += 1
            else:
                missing += 1
            if db_image_path.startswith("/static/images/") and fallback_exists and not local_exists:
                static_to_uploads += 1
            print(
                "date={date} diary_id={diary_id} db_path={db_path} local_path={local_path} "
                "exists={exists} uploads_fallback={fallback} fallback_exists={fallback_exists}".format(
                    date=row["date"],
                    diary_id=row["id"],
                    db_path=db_image_path,
                    local_path=local_path or "",
                    exists=local_exists,
                    fallback=uploads_fallback or "",
                    fallback_exists=fallback_exists,
                )
            )

    print(f"Summary: total={total} found={found} missing={missing} static_to_uploads_candidates={static_to_uploads}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
