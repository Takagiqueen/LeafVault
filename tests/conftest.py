import sqlite3
import os
from datetime import datetime, timedelta
from pathlib import Path

import jwt
import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient
from starlette.responses import FileResponse

TEST_ENV_DEFAULTS = {
    "ENVIRONMENT": "testing",
    "SECRET_KEY": "testing-secret-key-for-leafvault-regression",
    "ALLOWED_ORIGINS": "http://localhost:8000,http://127.0.0.1:8000",
    "COOKIE_SECURE": "false",
    "AUTH_COOKIE_ONLY_PREVIEW": "true",
    "AUTH_STORE_TOKEN_IN_LOCALSTORAGE": "false",
    "CSRF_PROTECTION_ENABLED": "true",
    "AI_API_KEY": "",
    "SENDER_EMAIL": "",
    "SENDER_PASSWORD": "",
}

for key, value in TEST_ENV_DEFAULTS.items():
    os.environ.setdefault(key, value)

from core.config import ALGORITHM, CSRF_HEADER_NAME, SECRET_KEY
from core.csrf import csrf_protection_middleware
from core.rate_limit import limiter
from core.security_headers import apply_security_headers
from core.verification import _hash_code
from db.database import get_db
from routers.auth import router as auth_router
from routers.diary import router as diary_router
from routers.ledger import router as ledger_router
from routers.stats import router as stats_router
from routers.sync import router as sync_router
from routers.user import router as user_router
import services.diary_service as diary_service
import routers.user as user_module


def init_test_db(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       TEXT UNIQUE NOT NULL,
            username      TEXT UNIQUE NOT NULL,
            email         TEXT DEFAULT '',
            avatar_url    TEXT DEFAULT '',
            password_hash TEXT NOT NULL
        );
        CREATE TABLE verification_codes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            email       TEXT NOT NULL,
            action_type TEXT DEFAULT 'register',
            code_hash   TEXT NOT NULL,
            expires_at  DATETIME NOT NULL,
            used        INTEGER DEFAULT 0,
            attempts    INTEGER DEFAULT 0
        );
        CREATE TABLE diaries (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT NOT NULL,
            username    TEXT DEFAULT '',
            date        TEXT NOT NULL,
            mood_label  TEXT NOT NULL,
            content     TEXT NOT NULL,
            image_paths TEXT,
            is_pinned   INTEGER DEFAULT 0,
            updated_at  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, date)
        );
        CREATE TABLE ledgers (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT NOT NULL,
            username   TEXT DEFAULT '',
            type       TEXT NOT NULL,
            amount     REAL NOT NULL,
            category   TEXT NOT NULL,
            note       TEXT,
            uuid       TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE sync_snapshots (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id        TEXT NOT NULL,
            encrypted_blob TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            uploaded_at    TEXT NOT NULL,
            device_name    TEXT,
            size_bytes     INTEGER,
            snapshot_name  TEXT,
            snapshot_note  TEXT
        );
        CREATE TABLE sync_changes (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id          TEXT NOT NULL,
            change_id        TEXT NOT NULL,
            entity_type      TEXT NOT NULL,
            entity_id        TEXT NOT NULL,
            operation        TEXT NOT NULL,
            encrypted_change TEXT NOT NULL,
            device_id        TEXT,
            client_sequence  INTEGER,
            base_revision    INTEGER,
            local_revision   INTEGER,
            created_at       TEXT,
            uploaded_at      TEXT NOT NULL,
            UNIQUE(user_id, change_id)
        );
        CREATE UNIQUE INDEX idx_ledgers_user_uuid ON ledgers(user_id, uuid)
            WHERE uuid IS NOT NULL AND uuid != '';
        """
    )
    conn.commit()
    conn.close()


def create_test_app(db_path: Path) -> FastAPI:
    app = FastAPI()
    app.state.limiter = limiter

    @app.middleware("http")
    async def add_security_headers(request, call_next):
        response = await call_next(request)
        return apply_security_headers(response)

    @app.middleware("http")
    async def enforce_cookie_csrf(request, call_next):
        return await csrf_protection_middleware(request, call_next)

    @app.get("/")
    async def root():
        return HTMLResponse("<!doctype html><title>LeafVault</title><main>LeafVault</main>")

    @app.get("/api/health")
    async def health_check():
        return {"status": "ok"}

    app.mount("/uploads", StaticFiles(directory=str(diary_service.IMAGES_DIR)), name="test_uploads")

    @app.get("/static/images/{image_name:path}")
    async def legacy_static_image(image_name: str):
        filename = Path(image_name).name
        if not filename or filename != image_name or ".." in image_name:
            return HTMLResponse("Image not found", status_code=404)
        legacy_path = Path("static/images") / filename
        upload_path = Path(diary_service.IMAGES_DIR) / filename
        if legacy_path.exists() and legacy_path.is_file():
            return FileResponse(legacy_path)
        if upload_path.exists() and upload_path.is_file():
            return FileResponse(upload_path)
        return HTMLResponse("Image not found", status_code=404)

    app.include_router(auth_router)
    app.include_router(user_router)
    app.include_router(diary_router)
    app.include_router(ledger_router)
    app.include_router(stats_router)
    app.include_router(sync_router)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://testserver"],
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type", CSRF_HEADER_NAME],
    )

    def override_get_db():
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
        finally:
            conn.close()

    app.dependency_overrides[get_db] = override_get_db
    return app


class LeafVaultTestAPI:
    def __init__(self, client: TestClient, db_path: Path):
        self.client = client
        self.db_path = db_path

    @staticmethod
    def auth(token: str) -> dict:
        return {"Authorization": f"Bearer {token}"}

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def add_code(self, email: str, code: str = "123456", action_type: str = "register") -> None:
        conn = self.connect()
        conn.execute(
            """
            INSERT INTO verification_codes (email, action_type, code_hash, expires_at, attempts)
            VALUES (?, ?, ?, ?, 0)
            """,
            (
                email.strip().lower(),
                action_type,
                _hash_code(code, action_type),
                datetime.now() + timedelta(minutes=5),
            ),
        )
        conn.commit()
        conn.close()

    def register_and_login(
        self,
        username: str,
        email: str,
        password: str = "Password123",
    ) -> str:
        self.add_code(email)
        register_res = self.client.post(
            "/api/register",
            data={"username": username, "email": email, "password": password, "code": "123456"},
        )
        assert register_res.status_code == 200
        assert register_res.json()["status"] == "success"
        login_res = self.client.post("/api/login", data={"account": email, "password": password})
        assert login_res.status_code == 200
        body = login_res.json()
        assert body["status"] == "success"
        return body["token"]

    def user_id(self, token: str) -> str:
        return self.client.get("/api/user/info", headers=self.auth(token)).json()["data"]["user_id"]

    def token_subject(self, token: str) -> str:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])["sub"]


@pytest.fixture
def temp_db_path(tmp_path, monkeypatch):
    db_path = tmp_path / "leafvault-test.db"
    monkeypatch.setenv("DATABASE_PATH", str(db_path))
    return db_path


@pytest.fixture
def temp_upload_dir(tmp_path, monkeypatch):
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("UPLOAD_DIR", str(upload_dir))
    return upload_dir


@pytest.fixture
def test_app(temp_db_path, temp_upload_dir, monkeypatch):
    limiter._storage.reset()
    monkeypatch.setattr(diary_service, "IMAGES_DIR", temp_upload_dir)
    monkeypatch.setattr(user_module, "IMAGES_DIR", temp_upload_dir)
    init_test_db(temp_db_path)
    return create_test_app(temp_db_path)


@pytest.fixture
def client(test_app):
    with TestClient(test_app) as test_client:
        yield test_client


@pytest.fixture
def api(client, temp_db_path):
    return LeafVaultTestAPI(client, temp_db_path)


@pytest.fixture
def create_test_user(api):
    def _create(username: str, email: str, password: str = "Password123") -> str:
        api.add_code(email)
        response = api.client.post(
            "/api/register",
            data={"username": username, "email": email, "password": password, "code": "123456"},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "success"
        return email

    return _create


@pytest.fixture
def login_user(api):
    def _login(username: str, email: str, password: str = "Password123") -> str:
        return api.register_and_login(username, email, password)

    return _login


@pytest.fixture
def auth_headers(api):
    return api.auth


@pytest.fixture
def cookie_auth_client(api):
    def _cookie_auth(username: str = "cookie_user", email: str = "cookie-user@example.test"):
        api.register_and_login(username, email)
        return api.client

    return _cookie_auth


@pytest.fixture
def csrf_headers(api):
    def _headers() -> dict:
        from core.config import CSRF_COOKIE_NAME, CSRF_HEADER_NAME

        token = api.client.cookies.get(CSRF_COOKIE_NAME)
        return {CSRF_HEADER_NAME: token} if token else {}

    return _headers


@pytest.fixture
def create_diary(api):
    def _create(token: str, date: str = "2026-05-21", content: str = "test diary", **overrides):
        data = {"date": date, "mood_label": overrides.pop("mood_label", "happy"), "content": content}
        data.update(overrides)
        return api.client.post("/api/diaries/", headers=api.auth(token), data=data)

    return _create


@pytest.fixture
def create_ledger(api):
    def _create(token: str, ledger_uuid: str = "ledger-fixture-1", **overrides):
        data = {
            "type": "expense",
            "amount": "12.5",
            "category": "meal",
            "note": "fixture ledger",
            "date": "2026-05-21",
            "uuid": ledger_uuid,
        }
        data.update(overrides)
        return api.client.post("/api/ledgers/", headers=api.auth(token), data=data)

    return _create


@pytest.fixture
def create_cloud_snapshot(api):
    from tests.test_backup_snapshots import encrypted_snapshot

    def _create(token: str, **overrides):
        return api.client.post("/api/sync/snapshot", headers=api.auth(token), json=encrypted_snapshot(**overrides))

    return _create


@pytest.fixture
def create_sync_change(api):
    from tests.test_incremental_sync_api import change_item

    def _create(token: str, change_id: str = "fixture-change", **overrides):
        payload = change_item(change_id, **overrides)
        return api.client.post("/api/sync/changes/batch", headers=api.auth(token), json={"changes": [payload]})

    return _create
