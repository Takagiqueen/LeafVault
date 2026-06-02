import json
import os
import sqlite3
import zipfile
from pathlib import Path

from scripts.ops_backup import create_backup
from scripts.ops_backup_check import check_backup_archive


def create_sample_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)")
    conn.execute("INSERT INTO sample (value) VALUES (?)", ("hello",))
    conn.commit()
    conn.close()


def test_ops_backup_creates_safe_archive(tmp_path):
    db_path = tmp_path / "data" / "leafvault.db"
    db_path.parent.mkdir()
    create_sample_db(db_path)

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "image.jpg").write_bytes(b"fake-image")
    (uploads_dir / ".env").write_text("SECRET_KEY=real-secret", encoding="utf-8")
    (uploads_dir / "server.log").write_text("token=secret", encoding="utf-8")
    (uploads_dir / "repomix-output.xml").write_text("<secret/>", encoding="utf-8")

    out_dir = tmp_path / "backups"
    stats = create_backup(db_path, uploads_dir, out_dir, keep=3)

    assert stats.archive_path.exists()
    assert stats.uploads_file_count == 1
    assert check_backup_archive(stats.archive_path) == []

    with zipfile.ZipFile(stats.archive_path, "r") as archive:
        names = set(archive.namelist())
        assert "manifest.json" in names
        assert "database/leafvault.db" in names
        assert "uploads/image.jpg" in names
        assert "uploads/.env" not in names
        assert "uploads/server.log" not in names
        assert "uploads/repomix-output.xml" not in names

        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        manifest_text = json.dumps(manifest)
        assert manifest["app"] == "LeafVault"
        assert manifest["database_file"] == "database/leafvault.db"
        assert "SECRET_KEY" not in manifest_text
        assert "token" not in manifest_text.lower()


def test_ops_backup_keep_prunes_old_archives(tmp_path):
    db_path = tmp_path / "leafvault.db"
    create_sample_db(db_path)
    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    out_dir = tmp_path / "backups"
    out_dir.mkdir()

    old_archives = []
    for index in range(3):
        old = out_dir / f"leafvault-backup-20000101-00000{index}.zip"
        old.write_bytes(b"old")
        os.utime(old, (1000 + index, 1000 + index))
        old_archives.append(old)

    create_backup(db_path, uploads_dir, out_dir, keep=2)

    remaining = sorted(out_dir.glob("leafvault-backup-*.zip"))
    assert len(remaining) == 2
    assert old_archives[0] not in remaining
