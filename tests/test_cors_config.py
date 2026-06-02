import pytest

from core.config import parse_allowed_origins, validate_production_config


def test_allowed_origins_parse_comma_separated_values():
    origins = parse_allowed_origins("https://leaf.example.com, http://localhost:8000", "production")
    assert origins == ["https://leaf.example.com", "http://localhost:8000"]


def test_development_allowed_origins_default_localhost():
    origins = parse_allowed_origins(None, "development")
    assert "http://localhost:8000" in origins
    assert "http://127.0.0.1:8000" in origins


def test_production_rejects_wildcard_allowed_origins():
    with pytest.raises(RuntimeError):
        validate_production_config(
            environment="production",
            secret_key="x" * 48,
            allowed_origins=["*"],
            database_path_value="/app/data/leafvault.sqlite3",
            upload_dir_value="/app/uploads",
            csp_mode="strict",
        )
