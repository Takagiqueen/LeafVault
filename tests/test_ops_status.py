import sqlite3
import urllib.request
from pathlib import Path

from scripts.ops_status import check_status


def create_status_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE status_check (id INTEGER PRIMARY KEY)")
    conn.commit()
    conn.close()


def test_ops_status_checks_local_directories_without_network(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    uploads_dir = tmp_path / "uploads"
    backups_dir = tmp_path / "backups"
    data_dir.mkdir()
    uploads_dir.mkdir()
    backups_dir.mkdir()
    create_status_db(data_dir / "leafvault.db")
    (uploads_dir / "image.jpg").write_bytes(b"image")

    def fail_if_called(*args, **kwargs):
        raise AssertionError("network should not be used when --url is omitted")

    monkeypatch.setattr(urllib.request, "urlopen", fail_if_called)

    result = check_status(data_dir, uploads_dir, backups_dir)

    assert result.errors == []
    assert any("SQLite database" in line for line in result.lines)
    rendered = "\n".join(result.lines + result.warnings + result.errors)
    assert "SECRET_KEY" not in rendered
    assert "token" not in rendered.lower()


def test_ops_status_reports_missing_required_directories(tmp_path):
    result = check_status(tmp_path / "missing-data", tmp_path / "missing-uploads", tmp_path / "missing-backups")

    assert any("data directory does not exist" in error for error in result.errors)
    assert any("uploads directory does not exist" in error for error in result.errors)
    assert any("backups directory does not exist yet" in warning for warning in result.warnings)
