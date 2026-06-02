import json
import re
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.rate_limit import limiter
from core.validators import safe_filename_prefix
from core.verification import _hash_code, verify_code
from db.database import get_db
from routers.auth import router as auth_router
from routers.diary import router as diary_router
from routers.ledger import router as ledger_router
from routers.stats import router as stats_router
from routers.sync import router as sync_router
import routers.user as user_module
from routers.user import router as user_router
import services.diary_service as diary_service


def create_test_app(db_path: Path) -> FastAPI:
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(auth_router)
    app.include_router(user_router)
    app.include_router(diary_router)
    app.include_router(ledger_router)
    app.include_router(stats_router)
    app.include_router(sync_router)

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
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            email      TEXT NOT NULL,
            action_type TEXT DEFAULT 'register',
            code_hash  TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            used       INTEGER DEFAULT 0,
            attempts   INTEGER DEFAULT 0
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


class MinimalRegressionTest(unittest.TestCase):
    def setUp(self):
        limiter._storage.reset()
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "leafvault-test.db"
        self.image_dir = Path(self.tmp.name) / "uploads"
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self._original_diary_images_dir = diary_service.IMAGES_DIR
        self._original_user_images_dir = user_module.IMAGES_DIR
        diary_service.IMAGES_DIR = self.image_dir
        user_module.IMAGES_DIR = self.image_dir
        init_test_db(self.db_path)
        self.client = TestClient(create_test_app(self.db_path))

    def tearDown(self):
        self.client.close()
        diary_service.IMAGES_DIR = self._original_diary_images_dir
        user_module.IMAGES_DIR = self._original_user_images_dir
        self.tmp.cleanup()

    def add_code(self, email: str, code: str = "123456", action_type: str = "register") -> None:
        email = email.strip().lower()
        conn = sqlite3.connect(str(self.db_path))
        conn.execute(
            "INSERT INTO verification_codes (email, action_type, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)",
            (email, action_type, _hash_code(code, action_type), datetime.now() + timedelta(minutes=5)),
        )
        conn.commit()
        conn.close()

    def register_and_login(self, username: str, email: str) -> str:
        self.add_code(email)
        register_res = self.client.post(
            "/api/register",
            data={"username": username, "email": email, "password": "Password123", "code": "123456"},
        )
        self.assertEqual(register_res.status_code, 200)
        self.assertEqual(register_res.json()["status"], "success")

        login_res = self.client.post("/api/login", data={"account": email, "password": "Password123"})
        self.assertEqual(login_res.status_code, 200)
        body = login_res.json()
        self.assertEqual(body["status"], "success")
        self.assertTrue(body["token"])
        return body["token"]

    @staticmethod
    def auth(token: str) -> dict:
        return {"Authorization": f"Bearer {token}"}

    def test_register_login_refresh_isolation_diary_ledger_stats_and_pwa(self):
        token_a = self.register_and_login("alice_test", "alice@example.test")
        token_b = self.register_and_login("bob_test", "bob@example.test")

        # 刷新保持登录：同一个 token 可以连续获取用户资料。
        self.assertEqual(self.client.get("/api/user/info", headers=self.auth(token_a)).json()["status"], "success")
        self.assertEqual(self.client.get("/api/user/info", headers=self.auth(token_a)).json()["status"], "success")

        diary_a = self.client.post(
            "/api/diaries/",
            headers=self.auth(token_a),
            data={"date": "2026-05-17", "mood_label": "一般", "content": "A 用户日记 #qa"},
        )
        self.assertEqual(diary_a.json()["status"], "success")
        diary_b = self.client.post(
            "/api/diaries/",
            headers=self.auth(token_b),
            data={"date": "2026-05-17", "mood_label": "开心", "content": "B 用户日记"},
        )
        self.assertEqual(diary_b.json()["status"], "success")

        a_list = self.client.get("/api/diaries/list", headers=self.auth(token_a)).json()["data"]
        b_list = self.client.get("/api/diaries/list", headers=self.auth(token_b)).json()["data"]
        self.assertEqual(a_list[0]["content"], "A 用户日记 #qa")
        self.assertEqual(b_list[0]["content"], "B 用户日记")

        ledger_res = self.client.post(
            "/api/ledgers/",
            headers=self.auth(token_a),
            data={"type": "income", "amount": "1000", "category": "工资", "note": "", "date": "2026-05-17", "uuid": "a-income-1"},
        )
        self.assertEqual(ledger_res.json()["status"], "success")
        batch_res = self.client.post(
            "/api/ledgers/batch",
            headers=self.auth(token_a),
            json=[
                {"type": "expense", "amount": 88.8, "category": "餐饮", "note": "午餐", "date": "2026-05-17", "uuid": "a-expense-1"},
                {"type": "expense", "amount": 88.8, "category": "餐饮", "note": "重复", "date": "2026-05-17", "uuid": "a-expense-1"},
            ],
        )
        batch_body = batch_res.json()
        self.assertEqual(batch_body["status"], "success")
        self.assertEqual(batch_body["saved"], 1)
        self.assertEqual(batch_body["skipped"], 1)

        b_ledgers = self.client.get("/api/ledgers/list", headers=self.auth(token_b)).json()["data"]
        self.assertEqual(b_ledgers, [])

        summary = self.client.get("/api/stats/monthly_summary?month=2026-05", headers=self.auth(token_a)).json()
        self.assertEqual(summary["data"]["total_income"], 1000.0)
        self.assertEqual(summary["data"]["total_expense"], 88.8)

        report_v2 = self.client.get("/api/report/v2?period=2026-05", headers=self.auth(token_a)).json()
        self.assertEqual(report_v2["status"], "success")
        self.assertIn("mood_summary", report_v2["data"])
        self.assertIn("finance_summary", report_v2["data"])

        report_v1 = self.client.get("/api/report?period=2026-05", headers=self.auth(token_a))
        self.assertEqual(report_v1.headers.get("deprecation"), "true")
        self.assertIn("/api/report/v2", report_v1.headers.get("link", ""))

        service_worker = Path("static/service-worker.js").read_text(encoding="utf-8")
        self.assertIn("const CACHE_VERSION = 'leafvault-v0.2.40-register-422-errors'", service_worker)
        self.assertIn("const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`", service_worker)
        self.assertIn("/static/js/modules/ui-state.js?v=58-crypto-unlock-ux", service_worker)
        self.assertIn("/static/js/modules/diary.js", service_worker)
        self.assertIn("/static/js/modules/ledger.js?v=70-restore-backup-image-path", service_worker)
        self.assertIn("/static/js/modules/backup.js", service_worker)
        self.assertIn("/static/js/modules/pwa-status.js?v=54-css-shell-refresh", service_worker)
        self.assertIn("/static/js/utils/image.js?v=44-diary-image-upload", service_worker)
        self.assertIn("/static/js/utils/date-picker.js", service_worker)
        self.assertNotIn("cdn.jsdelivr", service_worker)

    def test_sync_snapshot_requires_login_and_stores_ciphertext_for_token_user(self):
        snapshot = {
            "version": 1,
            "app": "LeafVault",
            "kdf": "PBKDF2",
            "iterations": 310000,
            "salt": "c2FsdA==",
            "iv": "aXY=",
            "payload": "Y2lwaGVydGV4dA==",
            "created_at": "2026-05-19T10:00:00.000Z",
            "device_name": "test device",
            "snapshot_name": "期末展示前备份",
            "snapshot_note": "修改首页 UI 前手动保存",
            "user_id": "front-end-must-not-decide-owner",
            "username": "mallory",
        }

        unauth_res = self.client.post("/api/sync/snapshot", json=snapshot)
        self.assertIn(unauth_res.status_code, (401, 403))

        token = self.register_and_login("snapshot_user", "snapshot@example.test")
        upload_res = self.client.post("/api/sync/snapshot", headers=self.auth(token), json=snapshot)
        self.assertEqual(upload_res.status_code, 200)
        upload_body = upload_res.json()
        self.assertEqual(upload_body["status"], "success")
        self.assertEqual(upload_body["message"], "云端加密备份已保存")
        self.assertIsInstance(upload_body["snapshot_id"], int)
        self.assertTrue(upload_body["uploaded_at"])

        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT users.user_id, sync_snapshots.encrypted_blob, sync_snapshots.device_name, "
            "sync_snapshots.size_bytes, sync_snapshots.snapshot_name, sync_snapshots.snapshot_note "
            "FROM sync_snapshots JOIN users ON users.user_id = sync_snapshots.user_id "
            "WHERE users.username = ?",
            ("snapshot_user",),
        ).fetchone()
        conn.close()
        self.assertIsNotNone(row)
        encrypted_blob = json.loads(row["encrypted_blob"])
        self.assertEqual(encrypted_blob["app"], "LeafVault")
        self.assertEqual(encrypted_blob["version"], 1)
        self.assertEqual(encrypted_blob["payload"], snapshot["payload"])
        self.assertEqual(row["device_name"], "test device")
        self.assertEqual(row["snapshot_name"], "期末展示前备份")
        self.assertEqual(row["snapshot_note"], "修改首页 UI 前手动保存")
        self.assertEqual(row["size_bytes"], len(row["encrypted_blob"].encode("utf-8")))
        self.assertNotIn("mallory", row["encrypted_blob"])
        self.assertNotIn("front-end-must-not-decide-owner", row["encrypted_blob"])
        self.assertNotIn("期末展示前备份", row["encrypted_blob"])

        invalid_app = {**snapshot, "app": "OtherApp"}
        invalid_version = {**snapshot, "version": 2}
        long_name = {**snapshot, "snapshot_name": "名" * 61}
        long_note = {**snapshot, "snapshot_note": "备注" * 101}
        self.assertEqual(
            self.client.post("/api/sync/snapshot", headers=self.auth(token), json=invalid_app).status_code,
            422,
        )
        self.assertEqual(
            self.client.post("/api/sync/snapshot", headers=self.auth(token), json=invalid_version).status_code,
            422,
        )
        self.assertEqual(
            self.client.post("/api/sync/snapshot", headers=self.auth(token), json=long_name).status_code,
            422,
        )
        self.assertEqual(
            self.client.post("/api/sync/snapshot", headers=self.auth(token), json=long_note).status_code,
            422,
        )

    def test_sync_snapshot_list_and_download_are_user_scoped(self):
        snapshot_a1 = {
            "version": 1,
            "app": "LeafVault",
            "kdf": "PBKDF2",
            "iterations": 310000,
            "salt": "YS1zYWx0",
            "iv": "YS1pdg==",
            "payload": "YS1jaXBoZXI=",
            "created_at": "2026-05-18T08:00:00.000Z",
            "device_name": "device A",
            "snapshot_name": "A 首次备份",
            "snapshot_note": "只属于 A 的备注",
        }
        snapshot_a2 = {
            **snapshot_a1,
            "payload": "YS0yLWNpcGhlcg==",
            "created_at": "2026-05-19T08:00:00.000Z",
            "snapshot_name": "A 最新备份",
            "snapshot_note": "",
        }
        snapshot_b = {
            **snapshot_a1,
            "payload": "Yi1jaXBoZXI=",
            "device_name": "device B",
            "snapshot_name": "B 私有备份",
            "snapshot_note": "A 不能看到",
        }

        self.assertIn(self.client.get("/api/sync/snapshots").status_code, (401, 403))
        self.assertIn(self.client.get("/api/sync/snapshots/1").status_code, (401, 403))

        token_a = self.register_and_login("cloud_list_a", "cloud-list-a@example.test")
        token_b = self.register_and_login("cloud_list_b", "cloud-list-b@example.test")

        id_a1 = self.client.post("/api/sync/snapshot", headers=self.auth(token_a), json=snapshot_a1).json()["snapshot_id"]
        id_a2 = self.client.post("/api/sync/snapshot", headers=self.auth(token_a), json=snapshot_a2).json()["snapshot_id"]
        id_b = self.client.post("/api/sync/snapshot", headers=self.auth(token_b), json=snapshot_b).json()["snapshot_id"]

        list_a_res = self.client.get("/api/sync/snapshots", headers=self.auth(token_a))
        self.assertEqual(list_a_res.status_code, 200)
        list_a = list_a_res.json()["data"]
        self.assertEqual([item["id"] for item in list_a], [id_a2, id_a1])
        for item in list_a:
            self.assertIn("created_at", item)
            self.assertIn("uploaded_at", item)
            self.assertIn("device_name", item)
            self.assertIn("size_bytes", item)
            self.assertIn("snapshot_name", item)
            self.assertIn("snapshot_note", item)
            self.assertNotIn("encrypted_blob", item)
            self.assertNotIn("payload", item)
        self.assertEqual(list_a[0]["snapshot_name"], "A 最新备份")
        self.assertEqual(list_a[1]["snapshot_name"], "A 首次备份")
        self.assertFalse(any(item["snapshot_name"] == "B 私有备份" for item in list_a))

        list_b = self.client.get("/api/sync/snapshots", headers=self.auth(token_b)).json()["data"]
        self.assertEqual([item["id"] for item in list_b], [id_b])
        self.assertEqual(list_b[0]["snapshot_name"], "B 私有备份")
        self.assertEqual(list_b[0]["snapshot_note"], "A 不能看到")

        download_res = self.client.get(f"/api/sync/snapshots/{id_a2}", headers=self.auth(token_a))
        self.assertEqual(download_res.status_code, 200)
        downloaded = download_res.json()["data"]
        self.assertEqual(downloaded["app"], "LeafVault")
        self.assertEqual(downloaded["version"], 1)
        self.assertEqual(downloaded["kdf"], "PBKDF2")
        self.assertEqual(downloaded["iterations"], 310000)
        self.assertEqual(downloaded["salt"], snapshot_a2["salt"])
        self.assertEqual(downloaded["iv"], snapshot_a2["iv"])
        self.assertEqual(downloaded["payload"], snapshot_a2["payload"])
        self.assertEqual(downloaded["created_at"], snapshot_a2["created_at"])
        self.assertEqual(downloaded["snapshot_name"], "A 最新备份")
        self.assertEqual(downloaded["snapshot_note"], "")
        self.assertNotIn("diaries", downloaded)
        self.assertNotIn("ledgers", downloaded)

        forbidden_download = self.client.get(f"/api/sync/snapshots/{id_b}", headers=self.auth(token_a))
        self.assertEqual(forbidden_download.status_code, 404)

    def test_sync_changes_batch_upload_is_encrypted_idempotent_and_user_scoped(self):
        encrypted_change = {
            "version": 1,
            "app": "LeafVault",
            "type": "incremental_change",
            "kdf": "PBKDF2",
            "iterations": 310000,
            "salt": "Y2hhbmdlLXNhbHQ=",
            "iv": "Y2hhbmdlLWl2",
            "payload": "Y2lwaGVydGV4dC1vbmx5",
        }
        change = {
            "change_id": "change-a-1",
            "entity_type": "diary",
            "entity_id": "2026-05-21",
            "operation": "update",
            "encrypted_change": encrypted_change,
            "device_id": "device-a",
            "client_sequence": 1,
            "base_revision": 0,
            "local_revision": 1,
            "created_at": "2026-05-21T08:00:00.000Z",
            "user_id": "front-end-must-not-decide-owner",
        }

        unauth_res = self.client.post("/api/sync/changes/batch", json={"changes": [change]})
        self.assertIn(unauth_res.status_code, (401, 403))

        token_a = self.register_and_login("sync_change_a", "sync-change-a@example.test")
        token_b = self.register_and_login("sync_change_b", "sync-change-b@example.test")

        upload_res = self.client.post("/api/sync/changes/batch", headers=self.auth(token_a), json={"changes": [change]})
        self.assertEqual(upload_res.status_code, 200)
        upload_body = upload_res.json()
        self.assertEqual(upload_body["status"], "success")
        self.assertEqual(upload_body["message"], "待同步变更已上传")
        self.assertEqual(upload_body["saved"], 1)
        self.assertEqual(upload_body["skipped"], 0)
        self.assertEqual(upload_body["failed"], 0)
        self.assertEqual(upload_body["saved_change_ids"], ["change-a-1"])

        duplicate_res = self.client.post("/api/sync/changes/batch", headers=self.auth(token_a), json={"changes": [change]})
        duplicate_body = duplicate_res.json()
        self.assertEqual(duplicate_res.status_code, 200)
        self.assertEqual(duplicate_body["saved"], 0)
        self.assertEqual(duplicate_body["skipped"], 1)
        self.assertEqual(duplicate_body["skipped_change_ids"], ["change-a-1"])

        change_b = {**change, "change_id": "change-b-1", "entity_id": "ledger-temp-1", "entity_type": "ledger", "operation": "create"}
        self.assertEqual(
            self.client.post("/api/sync/changes/batch", headers=self.auth(token_b), json={"changes": [change_b]}).status_code,
            200,
        )
        change_a2 = {
            **change,
            "change_id": "change-a-2",
            "entity_type": "ledger",
            "entity_id": "ledger-temp-a2",
            "operation": "create",
            "device_id": "device-other",
            "client_sequence": 2,
        }
        self.assertEqual(
            self.client.post("/api/sync/changes/batch", headers=self.auth(token_a), json={"changes": [change_a2]}).status_code,
            200,
        )

        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT users.username, sync_changes.change_id, sync_changes.encrypted_change, sync_changes.entity_type, "
            "sync_changes.entity_id, sync_changes.operation "
            "FROM sync_changes JOIN users ON users.user_id = sync_changes.user_id "
            "ORDER BY sync_changes.id"
        ).fetchall()
        conn.close()
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["username"], "sync_change_a")
        self.assertEqual(rows[0]["change_id"], "change-a-1")
        self.assertEqual(rows[0]["entity_type"], "diary")
        self.assertEqual(rows[0]["entity_id"], "2026-05-21")
        self.assertEqual(rows[0]["operation"], "update")
        stored_change = json.loads(rows[0]["encrypted_change"])
        self.assertEqual(stored_change["type"], "incremental_change")
        self.assertEqual(stored_change["payload"], encrypted_change["payload"])
        self.assertNotIn("front-end-must-not-decide-owner", rows[0]["encrypted_change"])
        self.assertNotIn("diary content", rows[0]["encrypted_change"])
        self.assertEqual(rows[1]["username"], "sync_change_b")
        self.assertEqual(rows[2]["username"], "sync_change_a")

        self.client.cookies.clear()
        self.assertIn(self.client.get("/api/sync/changes").status_code, (401, 403))
        list_a_res = self.client.get("/api/sync/changes", headers=self.auth(token_a))
        self.assertEqual(list_a_res.status_code, 200)
        list_a = list_a_res.json()["data"]
        self.assertEqual([item["change_id"] for item in list_a], ["change-a-1", "change-a-2"])
        for item in list_a:
            self.assertIn("uploaded_at", item)
            self.assertIn("device_id", item)
            self.assertNotIn("encrypted_change", item)
            self.assertNotIn("payload", item)
            self.assertNotIn("content", item)
        list_b = self.client.get("/api/sync/changes", headers=self.auth(token_b)).json()["data"]
        self.assertEqual([item["change_id"] for item in list_b], ["change-b-1"])

        self.assertIn(self.client.get("/api/sync/changes/change-a-1").status_code, (401, 403))
        change_detail_res = self.client.get("/api/sync/changes/change-a-1", headers=self.auth(token_a))
        self.assertEqual(change_detail_res.status_code, 200)
        change_detail = change_detail_res.json()["data"]
        self.assertEqual(change_detail["change_id"], "change-a-1")
        self.assertEqual(change_detail["entity_type"], "diary")
        self.assertEqual(change_detail["operation"], "update")
        self.assertEqual(change_detail["encrypted_change"]["type"], "incremental_change")
        self.assertEqual(change_detail["encrypted_change"]["payload"], encrypted_change["payload"])
        self.assertNotIn("diary content", json.dumps(change_detail, ensure_ascii=False))
        self.assertEqual(self.client.get("/api/sync/changes/change-b-1", headers=self.auth(token_a)).status_code, 404)
        self.assertEqual(self.client.get("/api/sync/changes/missing-change", headers=self.auth(token_a)).status_code, 404)

        excluded = self.client.get(
            "/api/sync/changes?exclude_device_id=device-a",
            headers=self.auth(token_a),
        ).json()["data"]
        self.assertEqual([item["change_id"] for item in excluded], ["change-a-2"])

        ledger_only = self.client.get(
            "/api/sync/changes?entity_type=ledger",
            headers=self.auth(token_a),
        ).json()["data"]
        self.assertEqual([item["change_id"] for item in ledger_only], ["change-a-2"])

        invalid_entity = {**change, "change_id": "bad-entity", "entity_type": "profile"}
        invalid_operation = {**change, "change_id": "bad-op", "operation": "merge"}
        oversized_changes = [{**change, "change_id": f"bulk-{i}"} for i in range(101)]
        self.assertEqual(
            self.client.post("/api/sync/changes/batch", headers=self.auth(token_a), json={"changes": [invalid_entity]}).status_code,
            422,
        )
        self.assertEqual(
            self.client.post("/api/sync/changes/batch", headers=self.auth(token_a), json={"changes": [invalid_operation]}).status_code,
            422,
        )
        self.assertEqual(
            self.client.post("/api/sync/changes/batch", headers=self.auth(token_a), json={"changes": oversized_changes}).status_code,
            400,
        )
        self.assertEqual(
            self.client.get("/api/sync/changes?entity_type=profile", headers=self.auth(token_a)).status_code,
            422,
        )
        self.assertEqual(
            self.client.get("/api/sync/changes?limit=201", headers=self.auth(token_a)).status_code,
            422,
        )

    def test_sync_changes_batch_accepts_v2_local_key_envelope(self):
        token = self.register_and_login("sync_change_v2", "sync-change-v2@example.test")
        encrypted_change_v2 = {
            "version": 2,
            "app": "LeafVault",
            "type": "incremental_change",
            "kdf": "local-encryption-key-v1",
            "iv": "djItaXY=",
            "payload": "djItY2lwaGVydGV4dA==",
        }
        change = {
            "change_id": "change-v2-1",
            "entity_type": "diary",
            "entity_id": "2026-06-01",
            "operation": "create",
            "encrypted_change": encrypted_change_v2,
            "device_id": "device-v2",
            "client_sequence": 1,
            "base_revision": 0,
            "local_revision": 1,
            "created_at": "2026-06-01T08:00:00.000Z",
        }

        upload_res = self.client.post("/api/sync/changes/batch", headers=self.auth(token), json={"changes": [change]})
        self.assertEqual(upload_res.status_code, 200)
        upload_body = upload_res.json()
        self.assertEqual(upload_body["status"], "success")
        self.assertEqual(upload_body["saved_change_ids"], ["change-v2-1"])

        detail_res = self.client.get("/api/sync/changes/change-v2-1", headers=self.auth(token))
        self.assertEqual(detail_res.status_code, 200)
        encrypted_detail = detail_res.json()["data"]["encrypted_change"]
        self.assertEqual(encrypted_detail["version"], 2)
        self.assertEqual(encrypted_detail["kdf"], "local-encryption-key-v1")
        self.assertEqual(encrypted_detail["iv"], encrypted_change_v2["iv"])
        self.assertEqual(encrypted_detail["payload"], encrypted_change_v2["payload"])
        self.assertNotIn("iterations", encrypted_detail)
        self.assertNotIn("salt", encrypted_detail)

    def test_sync_snapshot_delete_is_user_scoped_and_does_not_touch_app_data(self):
        snapshot = {
            "version": 1,
            "app": "LeafVault",
            "kdf": "PBKDF2",
            "iterations": 310000,
            "salt": "ZGVsZXRlLXNhbHQ=",
            "iv": "ZGVsZXRlLWl2",
            "payload": "ZGVsZXRlLWNpcGhlcg==",
            "created_at": "2026-05-19T09:00:00.000Z",
            "device_name": "delete test",
        }

        self.assertIn(self.client.delete("/api/sync/snapshots/1").status_code, (401, 403))

        token_a = self.register_and_login("cloud_delete_a", "cloud-delete-a@example.test")
        token_b = self.register_and_login("cloud_delete_b", "cloud-delete-b@example.test")

        diary_res = self.client.post(
            "/api/diaries/",
            headers=self.auth(token_a),
            data={"date": "2026-05-19", "mood_label": "一般", "content": "delete snapshot keeps diary"},
        )
        self.assertEqual(diary_res.json()["status"], "success")
        ledger_res = self.client.post(
            "/api/ledgers/",
            headers=self.auth(token_a),
            data={"type": "expense", "amount": "12.5", "category": "餐饮", "note": "delete snapshot keeps ledger", "date": "2026-05-19", "uuid": "delete-keeps-ledger"},
        )
        self.assertEqual(ledger_res.json()["status"], "success")

        id_a = self.client.post("/api/sync/snapshot", headers=self.auth(token_a), json=snapshot).json()["snapshot_id"]
        id_b = self.client.post("/api/sync/snapshot", headers=self.auth(token_b), json={**snapshot, "payload": "Yi1kZWxldGU="}).json()["snapshot_id"]

        forbidden_delete = self.client.delete(f"/api/sync/snapshots/{id_b}", headers=self.auth(token_a))
        self.assertEqual(forbidden_delete.status_code, 404)

        delete_res = self.client.delete(f"/api/sync/snapshots/{id_a}", headers=self.auth(token_a))
        self.assertEqual(delete_res.status_code, 200)
        self.assertEqual(delete_res.json(), {"status": "success", "message": "云端备份已删除"})

        list_a = self.client.get("/api/sync/snapshots", headers=self.auth(token_a)).json()["data"]
        self.assertNotIn(id_a, [item["id"] for item in list_a])
        list_b = self.client.get("/api/sync/snapshots", headers=self.auth(token_b)).json()["data"]
        self.assertIn(id_b, [item["id"] for item in list_b])

        diary_detail = self.client.get("/api/diaries/detail?date=2026-05-19", headers=self.auth(token_a)).json()["data"]
        self.assertEqual(diary_detail["content"], "delete snapshot keeps diary")
        ledgers = self.client.get("/api/ledgers/list", headers=self.auth(token_a)).json()["data"]
        self.assertTrue(any(item["note"] == "delete snapshot keeps ledger" for item in ledgers))

    def test_verification_code_attempt_limit_and_email_normalization(self):
        email = "casefold@example.test"
        self.add_code(email, "123456", "register")

        register_res = self.client.post(
            "/api/register",
            data={"username": "casefold_user", "email": f"  {email.upper()}  ", "password": "Password123", "code": "123456"},
        )
        self.assertEqual(register_res.status_code, 200)
        self.assertEqual(register_res.json()["status"], "success")

        limited_email = "limited@example.test"
        self.add_code(limited_email, "123456", "register")
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        for _ in range(5):
            self.assertFalse(verify_code(cursor, limited_email, "000000", "register"))
            conn.commit()
        self.assertFalse(verify_code(cursor, limited_email, "123456", "register"))
        conn.commit()
        row = conn.execute(
            "SELECT attempts, used FROM verification_codes WHERE email = ? AND action_type = ?",
            (limited_email, "register"),
        ).fetchone()
        conn.close()
        self.assertEqual(row["attempts"], 5)
        self.assertEqual(row["used"], 1)

    def test_stale_diary_updated_at_conflict_does_not_overwrite(self):
        token = self.register_and_login("conflict_user", "conflict@example.test")
        create_res = self.client.post(
            "/api/diaries/",
            headers=self.auth(token),
            data={"date": "2026-05-18", "mood_label": "一般", "content": "first version"},
        )
        self.assertEqual(create_res.json()["status"], "success")

        detail = self.client.get(
            "/api/diaries/detail?date=2026-05-18",
            headers=self.auth(token),
        ).json()["data"]
        stale_updated_at = detail["updated_at"]

        conn = sqlite3.connect(str(self.db_path))
        future_updated_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        conn.execute(
            "UPDATE diaries SET content = ?, updated_at = ? WHERE user_id = ? AND date = ?",
            ("server newer version", future_updated_at, detail["user_id"], "2026-05-18"),
        )
        conn.commit()
        conn.close()

        stale_res = self.client.post(
            "/api/diaries/",
            headers=self.auth(token),
            data={
                "date": "2026-05-18",
                "mood_label": "一般",
                "content": "stale client overwrite",
                "updated_at": stale_updated_at,
            },
        )
        self.assertEqual(stale_res.json()["status"], "conflict")

        after = self.client.get(
            "/api/diaries/detail?date=2026-05-18",
            headers=self.auth(token),
        ).json()["data"]
        self.assertEqual(after["content"], "server newer version")
        self.assertEqual(after["updated_at"], future_updated_at)

    def test_diary_image_upload_accepts_compressed_jpeg_with_png_original_name(self):
        token = self.register_and_login("image_user", "image@example.test")
        jpeg_bytes = b"\xff\xd8\xff\xe0" + b"leafvault-test-image"
        res = self.client.post(
            "/api/diaries/",
            headers=self.auth(token),
            data={"date": "2026-05-20", "mood_label": "开心", "content": "image upload regression"},
            files=[("images", ("mobile-screenshot.png", jpeg_bytes, "image/jpeg"))],
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["status"], "success")
        self.assertIn("/uploads/", body["image_paths"])
        self.assertTrue(body["image_paths"].endswith(".jpg"))
        saved_path = Path(diary_service.IMAGES_DIR) / Path(body["image_paths"]).name
        second_jpeg_bytes = b"\xff\xd8\xff\xe0" + b"leafvault-second-image"
        second_saved_path = None
        try:
            self.assertTrue(saved_path.exists())
            self.assertEqual(saved_path.read_bytes(), jpeg_bytes)

            update_res = self.client.post(
                "/api/diaries/",
                headers=self.auth(token),
                data={
                    "date": "2026-05-20",
                    "mood_label": "happy",
                    "content": "image upload regression updated",
                    "retained_images": body["image_paths"],
                    "updated_at": body["updated_at"],
                },
                files=[("images", ("extra.png", second_jpeg_bytes, "image/jpeg"))],
            )
            self.assertEqual(update_res.status_code, 200)
            update_body = update_res.json()
            self.assertEqual(update_body["status"], "success")
            final_paths = [p for p in update_body["image_paths"].split(",") if p]
            self.assertEqual(len(final_paths), 2)
            self.assertEqual(final_paths[0], body["image_paths"])
            second_saved_path = Path(diary_service.IMAGES_DIR) / Path(final_paths[1]).name
            self.assertTrue(second_saved_path.exists())
            self.assertEqual(second_saved_path.read_bytes(), second_jpeg_bytes)

            detail = self.client.get(
                "/api/diaries/detail?date=2026-05-20",
                headers=self.auth(token),
            ).json()["data"]
            self.assertEqual(detail["image_paths"], update_body["image_paths"])
        finally:
            if saved_path.exists():
                saved_path.unlink()
            if second_saved_path and second_saved_path.exists():
                second_saved_path.unlink()

    def test_diary_update_with_new_image_keeps_retained_old_images(self):
        token = self.register_and_login("image_keep_user", "imagekeep@example.test")
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        user_id = conn.execute(
            "SELECT user_id FROM users WHERE username = ?",
            ("image_keep_user",),
        ).fetchone()["user_id"]
        safe_user = safe_filename_prefix(user_id)
        old1 = f"/static/images/{safe_user}_old1.jpg"
        old2 = f"/static/images/{safe_user}_old2.jpg"
        conn.execute(
            "INSERT INTO diaries (user_id, username, date, mood_label, content, image_paths, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                user_id,
                user_id,
                "2026-05-21",
                "一般",
                "old images",
                f"{old1},{old2}",
                "2026-05-21T10:00:00.000Z",
            ),
        )
        conn.commit()
        conn.close()

        new_jpeg = b"\xff\xd8\xff\xe0" + b"leafvault-third-image"
        new_saved_path = None
        try:
            update_res = self.client.post(
                "/api/diaries/",
                headers=self.auth(token),
                data={
                    "date": "2026-05-21",
                    "mood_label": "一般",
                    "content": "append third image",
                    "retained_images": f"{old1},{old2}",
                    "updated_at": "2026-05-21T10:00:00.000Z",
                },
                files=[("images", ("third.png", new_jpeg, "image/jpeg"))],
            )
            self.assertEqual(update_res.status_code, 200)
            body = update_res.json()
            self.assertEqual(body["status"], "success")
            final_paths = [p for p in body["image_paths"].split(",") if p]
            self.assertEqual(len(final_paths), 3)
            self.assertEqual(final_paths[:2], [old1, old2])
            self.assertIn("/uploads/", final_paths[2])
            new_saved_path = Path(diary_service.IMAGES_DIR) / Path(final_paths[2]).name
            self.assertTrue(new_saved_path.exists())
            self.assertEqual(new_saved_path.read_bytes(), new_jpeg)

            detail = self.client.get(
                "/api/diaries/detail?date=2026-05-21",
                headers=self.auth(token),
            ).json()["data"]
            self.assertEqual(detail["image_paths"], body["image_paths"])
            debug_res = self.client.get(
                "/api/diaries/debug_image_paths?date=2026-05-21",
                headers=self.auth(token),
            )
            self.assertEqual(debug_res.status_code, 404)
            self.assertNotIn("content", debug_res.text)

            delete_old_res = self.client.post(
                "/api/diaries/",
                headers=self.auth(token),
                data={
                    "date": "2026-05-21",
                    "mood_label": "一般",
                    "content": "remove old1 explicitly",
                    "retained_images": f"{old2},{final_paths[2]}",
                    "removed_images": old1,
                    "updated_at": body["updated_at"],
                },
            )
            self.assertEqual(delete_old_res.status_code, 200)
            delete_body = delete_old_res.json()
            after_delete_paths = [p for p in delete_body["image_paths"].split(",") if p]
            self.assertNotIn(old1, after_delete_paths)
            self.assertIn(old2, after_delete_paths)
            self.assertIn(final_paths[2], after_delete_paths)
        finally:
            if new_saved_path and new_saved_path.exists():
                new_saved_path.unlink()

    def test_diary_update_missing_retained_images_does_not_drop_existing_images(self):
        token = self.register_and_login("image_miss_user", "imagemiss@example.test")
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        user_id = conn.execute(
            "SELECT user_id FROM users WHERE username = ?",
            ("image_miss_user",),
        ).fetchone()["user_id"]
        safe_user = safe_filename_prefix(user_id)
        old1 = f"/static/images/{safe_user}_old1.jpg"
        old2 = f"/static/images/{safe_user}_old2.jpg"
        conn.execute(
            "INSERT INTO diaries (user_id, username, date, mood_label, content, image_paths, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, user_id, "2026-05-22", "一般", "old images", f"{old1},{old2}", "2026-05-22T08:00:00.000Z"),
        )
        conn.commit()
        conn.close()

        new_jpeg = b"\xff\xd8\xff\xe0" + b"leafvault-new-with-empty-retained"
        new_saved_path = None
        try:
            update_res = self.client.post(
                "/api/diaries/",
                headers=self.auth(token),
                data={
                    "date": "2026-05-22",
                    "mood_label": "一般",
                    "content": "append with empty retained",
                    "retained_images": "",
                    "removed_images": "",
                    "updated_at": "2026-05-22T08:00:00.000Z",
                },
                files=[("images", ("new3.png", new_jpeg, "image/jpeg"))],
            )
            self.assertEqual(update_res.status_code, 200)
            body = update_res.json()
            final_paths = [p for p in body["image_paths"].split(",") if p]
            self.assertEqual(len(final_paths), 3)
            self.assertEqual(final_paths[:2], [old1, old2])
            new_saved_path = Path(diary_service.IMAGES_DIR) / Path(final_paths[2]).name
            self.assertTrue(new_saved_path.exists())

            detail = self.client.get(
                "/api/diaries/detail?date=2026-05-22",
                headers=self.auth(token),
            ).json()["data"]
            self.assertEqual(detail["image_paths"], body["image_paths"])
        finally:
            if new_saved_path and new_saved_path.exists():
                new_saved_path.unlink()

    def test_diary_update_removed_images_explicitly_removes_existing_image(self):
        token = self.register_and_login("image_remove_user", "imageremove@example.test")
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        user_id = conn.execute(
            "SELECT user_id FROM users WHERE username = ?",
            ("image_remove_user",),
        ).fetchone()["user_id"]
        safe_user = safe_filename_prefix(user_id)
        old1 = f"/static/images/{safe_user}_old1.jpg"
        old2 = f"/static/images/{safe_user}_old2.jpg"
        old3 = f"/static/images/{safe_user}_old3.jpg"
        conn.execute(
            "INSERT INTO diaries (user_id, username, date, mood_label, content, image_paths, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, user_id, "2026-05-23", "一般", "old images", f"{old1},{old2},{old3}", "2026-05-23T08:00:00.000Z"),
        )
        conn.commit()
        conn.close()

        update_res = self.client.post(
            "/api/diaries/",
            headers=self.auth(token),
            data={
                "date": "2026-05-23",
                "mood_label": "一般",
                "content": "remove old2 explicitly",
                "retained_images": f"{old1},{old3}",
                "removed_images": old2,
                "updated_at": "2026-05-23T08:00:00.000Z",
            },
        )
        self.assertEqual(update_res.status_code, 200)
        body = update_res.json()
        final_paths = [p for p in body["image_paths"].split(",") if p]
        self.assertEqual(final_paths, [old1, old3])

        detail = self.client.get(
            "/api/diaries/detail?date=2026-05-23",
            headers=self.auth(token),
        ).json()["data"]
        self.assertEqual(detail["image_paths"], body["image_paths"])

    def test_frontend_draft_autosave_uses_submit_mode_dataset(self):
        diary_js = Path("static/js/modules/diary.js").read_text(encoding="utf-8")
        image_js = Path("static/js/utils/image.js").read_text(encoding="utf-8")
        app_startup_js = Path("static/js/modules/app-startup.js").read_text(encoding="utf-8")
        local_db_js = Path("static/js/modules/local-db.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        service_worker = Path("static/service-worker.js").read_text(encoding="utf-8")
        ui_state_js = Path("static/js/modules/ui-state.js").read_text(encoding="utf-8")
        self.assertIn("mainDiarySubmitBtn.dataset.mode", diary_js)
        self.assertIn("saveDiaryDraftImmediately", diary_js)
        self.assertIn("saveDiaryDraftEmergency", diary_js)
        self.assertIn("buildDiaryDraftMetadata", diary_js)
        self.assertIn("function parseDiaryImagePaths", diary_js)
        self.assertIn("function mergeDiaryImagePaths", diary_js)
        self.assertIn("async function getRetainedImagesForSubmit", diary_js)
        self.assertIn("function removeImg", diary_js)
        self.assertIn("const MAX_DIARY_IMAGE_COUNT = 9", diary_js)
        self.assertIn("function setupDiaryImageInputMultiSelect", diary_js)
        self.assertIn("function appendDiaryImageFiles", diary_js)
        self.assertIn("for (let i = 0; i < acceptedFiles.length; i += 1)", diary_js)
        self.assertIn("正在处理 ${i + 1}/${acceptedFiles.length}", diary_js)
        self.assertNotIn("Promise.allSettled(acceptedFiles.map", diary_js)
        self.assertIn("hiddenImageInput.setAttribute('multiple', 'multiple')", diary_js)
        self.assertIn('multiple="multiple"', html)
        self.assertIn('data-diary-image-input="multi"', html)
        self.assertIn("hasRemovedRetainedDiaryImage", diary_js)
        self.assertIn("removedRetainedImages", diary_js)
        self.assertNotIn("[DIARY_IMAGE_DEBUG:FRONT]", diary_js)
        self.assertNotIn("[DIARY_IMAGE_DEBUG:SERVER_RESPONSE]", diary_js)
        self.assertIn("fd.append('retained_images', resolvedRetainedImageText)", diary_js)
        self.assertIn("fd.append('removed_images',  removedImageText)", diary_js)
        self.assertIn("const syncRemovedImages = mergeDiaryImagePaths", diary_js)
        self.assertIn("fd.append('removed_images', syncRemovedImages.join(','))", diary_js)
        self.assertIn("savedImagePaths = json.image_paths || resolvedRetainedImageText", diary_js)
        self.assertIn("beforeunload", diary_js)
        self.assertIn("visibilitychange", diary_js)
        self.assertIn("pagehide", diary_js)
        self.assertIn("compositionend", diary_js)
        self.assertIn("window.getDiaryDraftSnapshot", local_db_js)
        self.assertIn("window.setDiaryDraftEmergency", local_db_js)
        self.assertIn("window.getLatestDiaryDraftDate", local_db_js)
        self.assertIn("rememberLatestDiaryDraft", local_db_js)
        self.assertIn("leafvault_draft_snapshot:", local_db_js)
        self.assertIn("const emergencySnapshot = {", local_db_js)
        self.assertIn("JSON.stringify(emergencySnapshot)", local_db_js)
        self.assertIn("function pickNewerDraft", local_db_js)
        self.assertIn("return pickNewerDraft(emergencyDraft, encryptedDraft)", local_db_js)
        self.assertNotIn("setDiaryDraft(dateValue, snapshot.content, snapshot)", local_db_js)
        self.assertIn("latestDraftDate", app_startup_js)
        self.assertIn("/static/js/modules/app-startup.js?v=55-csp-vendor", html)
        self.assertIn("/static/js/modules/app-startup.js?v=55-csp-vendor", service_worker)
        self.assertIn("checkExistingDiary(dateInput.value || formatDateValue(new Date()))", html)
        self.assertIn("/static/js/modules/local-db.js?v=66-image-src-normalize", html)
        self.assertIn("/static/js/modules/local-db.js?v=66-image-src-normalize", service_worker)
        self.assertIn("/static/js/modules/ui-state.js?v=58-crypto-unlock-ux", html)
        self.assertIn("/static/js/modules/ui-state.js?v=58-crypto-unlock-ux", service_worker)
        self.assertIn("function renderEmptyState", ui_state_js)
        self.assertIn("function renderLoadingState", ui_state_js)
        self.assertIn("function renderErrorState", ui_state_js)
        self.assertIn("function setButtonLoading", ui_state_js)
        self.assertIn("function normalizeUserFacingError", ui_state_js)
        self.assertIn("登录状态校验失败，请刷新页面或重新登录。", ui_state_js)
        self.assertIn("文件太大了，请压缩后再上传。", ui_state_js)
        self.assertIn("/static/js/modules/diary.js?v=71-image-src-normalize", html)
        self.assertIn("/static/js/modules/diary.js?v=71-image-src-normalize", service_worker)
        self.assertIn("/static/js/utils/image.js?v=44-diary-image-upload", html)
        self.assertIn("/static/js/utils/image.js?v=44-diary-image-upload", service_worker)
        self.assertIn("`${baseName}.jpg`", image_js)
        self.assertIn("canvas 压缩输出固定为 JPEG", image_js)
        self.assertIn("getPreviousDiaryDateFromEvent", diary_js)
        self.assertIn("diaryLoadSequence", diary_js)
        self.assertIn("restoreLocalDiaryOrDraft", diary_js)
        self.assertIn("previousValue", Path("static/js/utils/date-picker.js").read_text(encoding="utf-8"))
        self.assertIn("mood_label: metadata.mood_label", local_db_js)
        self.assertIn("server_updated_at: metadata.server_updated_at", local_db_js)
        self.assertNotIn("classList.contains('bg-green-500')", diary_js)
        self.assertIn("currentDiaryServerUpdatedAt = d.updated_at || ''", diary_js)
        self.assertIn("fd.append('updated_at', currentDiaryServerUpdatedAt)", diary_js)
        self.assertIn("if (hasConflict) return", diary_js)
        self.assertNotIn("fd.append('updated_at',      new Date().toISOString())", diary_js)

    def test_home_timeline_keeps_all_pinned_and_limits_recent_days(self):
        diary_js = Path("static/js/modules/diary.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        self.assertIn("const HOME_RECENT_DAYS_LIMIT = 3", diary_js)
        self.assertIn("const DIARY_PIN_LIMIT = 5", diary_js)
        self.assertIn("最多只能置顶 ${DIARY_PIN_LIMIT} 篇日记，请先取消一篇置顶", diary_js)
        self.assertIn("__home_section: 'pinned'", diary_js)
        self.assertIn("__home_section: 'recent'", diary_js)
        self.assertIn("Number(diary.is_pinned || 0) === 1", diary_js)
        self.assertIn("if (recentDates.size >= HOME_RECENT_DAYS_LIMIT) break", diary_js)
        self.assertIn("return [...pinnedItems, ...recentItems]", diary_js)
        self.assertIn("function renderDiaryPinButton", diary_js)
        self.assertIn("data-archive-action=\"toggle-pin\"", diary_js)
        self.assertIn("window.LeafVaultDiaryPin", diary_js)
        self.assertIn(".diary-pin-toggle-btn", html)
        self.assertIn("window.LeafVaultDiaryPin?.syncAfterToggle", html)

    def test_ledger_delete_entry_calls_existing_safe_delete_function(self):
        ledger_js = Path("static/js/modules/ledger.js").read_text(encoding="utf-8")
        diary_js = Path("static/js/modules/diary.js").read_text(encoding="utf-8")
        self.assertIn("window.deleteLedgerSafeImpl", ledger_js)
        self.assertIn('data-ledger-action="delete"', ledger_js)
        self.assertIn("setupLedgerListBindings", ledger_js)
        self.assertIn("deleteLedger(btn.dataset.ledgerId)", ledger_js)
        self.assertIn("window.markLocalDataChanged?.('ledger_saved')", ledger_js)
        self.assertIn("window.markLocalDataChanged?.('ledger_deleted')", ledger_js)
        self.assertIn("window.markLocalDataChanged?.('diary_saved')", diary_js)
        self.assertIn("window.markLocalDataChanged?.('diary_deleted')", diary_js)

    def test_ledger_export_uses_real_xlsx_not_csv(self):
        ledger_js = Path("static/js/modules/ledger.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        self.assertIn("xlsx.full.min.js", html)
        self.assertIn("/static/js/modules/ledger.js?v=70-restore-backup-image-path", html)
        pwa_status_js = Path("static/js/modules/pwa-status.js").read_text(encoding="utf-8")
        self.assertIn("/service-worker.js?v=55-css-shell-refresh", pwa_status_js)
        self.assertIn("scope: '/'", pwa_status_js)
        self.assertNotIn("navigator.serviceWorker.register('/static/service-worker.js", pwa_status_js)
        self.assertIn("XLSX.utils.aoa_to_sheet", ledger_js)
        self.assertIn("XLSX.utils.book_append_sheet", ledger_js)
        self.assertIn("XLSX.writeFile", ledger_js)
        self.assertIn("window.exportLedgerCSV = exportLedgerCSV", ledger_js)
        self.assertIn("leafvault-ledger-${month}.xlsx", ledger_js)
        self.assertIn("leafvault-ledger-${year}.xlsx", ledger_js)
        self.assertIn(".xlsx", ledger_js)
        self.assertIn("apiFetch('/api/ledgers/list')", ledger_js)
        self.assertNotIn("text/csv", ledger_js)
        self.assertNotIn(".csv`", ledger_js)

    def test_ledger_month_filter_and_export_scope_are_static_guarded(self):
        ledger_js = Path("static/js/modules/ledger.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        self.assertIn("let selectedLedgerMonth = normalizeLedgerMonthValue(getLocalLedgerMonthValue())", ledger_js)
        self.assertIn("filterLedgersByMonth(sortedData)", ledger_js)
        self.assertIn("这个月还没有流水，记一笔开始记录吧。", ledger_js)
        self.assertIn("data-ledger-export-scope=\"month\"", html)
        self.assertIn("data-ledger-export-scope=\"year\"", html)
        self.assertIn("filterLedgersByYear(allData, year)", ledger_js)
        self.assertIn("XLSX.writeFile(workbook, filename", ledger_js)

    def test_mobile_chart_and_profile_calendar_use_readable_layouts(self):
        stats_js = Path("static/js/modules/stats.js").read_text(encoding="utf-8")
        profile_js = Path("static/js/modules/profile.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        service_worker = Path("static/service-worker.js").read_text(encoding="utf-8")

        self.assertIn("/static/js/modules/stats.js?v=36-mobile-chart-calendar", html)
        self.assertIn("/static/js/modules/profile.js?v=37-mobile-calendar-layout", html)
        self.assertIn("/static/js/modules/stats.js?v=36-mobile-chart-calendar", service_worker)
        self.assertIn("/static/js/modules/profile.js?v=37-mobile-calendar-layout", service_worker)
        self.assertIn("finance-pie-chart", html)
        self.assertIn("legend: {\n          show: false", stats_js)
        self.assertIn("radius: isMobile ? ['28%', '47%']", stats_js)
        self.assertIn("position: 'outer'", stats_js)
        self.assertIn("const showDirectLabel = percent >= 2", stats_js)
        self.assertIn("return `${name} ${percent.toFixed(1)}%`", stats_js)
        self.assertIn("text: '支出比例'", stats_js)
        self.assertIn("profile-calendar-grid", html)
        self.assertIn("profile-calendar-heading", html)
        self.assertIn("life-calendar-top", profile_js)
        self.assertIn("life-mood-spacer", profile_js)
        self.assertIn("life-calendar-blank", profile_js)
        self.assertIn("life-expense-empty", profile_js)
        self.assertIn('data-calendar-date="${dateKey}" class="life-calendar-card', profile_js)

    def test_profile_settings_page_holds_account_backup_and_cloud_actions(self):
        html = Path("templates/index.html").read_text(encoding="utf-8")
        auth_js = Path("static/js/modules/auth.js").read_text(encoding="utf-8")
        ui_actions_js = Path("static/js/modules/ui-actions.js").read_text(encoding="utf-8")
        service_worker = Path("static/service-worker.js").read_text(encoding="utf-8")

        self.assertIn("/static/js/modules/auth.js?v=72-register-422-errors", html)
        self.assertIn("/static/js/modules/ui-actions.js?v=38-settings-page", html)
        self.assertIn("/static/js/modules/auth.js?v=72-register-422-errors", service_worker)
        self.assertIn("/static/js/modules/ui-actions.js?v=38-settings-page", service_worker)
        self.assertIn('data-profile-action="open-settings"', html)
        self.assertIn('id="view-settings"', html)
        self.assertIn("账号与安全", html)
        self.assertIn("数据与同步管理", html)
        self.assertIn("展开云端备份列表与同步高级工具", html)
        self.assertIn("其他", html)
        self.assertIn('data-profile-action="toggle-reset-password-modal"', html)
        self.assertIn('id="settingsResetForm"', html)
        self.assertIn('data-email-input="settingsResetEmail"', html)
        self.assertIn("toggleSettingsResetModal", auth_js)
        self.assertIn("setupResetForms", auth_js)
        self.assertIn("event.target.id === 'settingsResetForm'", auth_js)
        self.assertIn("openSettingsView", ui_actions_js)
        self.assertIn("closeSettingsView", ui_actions_js)
        self.assertIn("window.fetchCloudBackupSnapshots?.();", ui_actions_js)

        profile_start = html.index('id="view-profile"')
        settings_start = html.index('id="view-settings"')
        profile_html = html[profile_start:settings_start]
        settings_html = html[settings_start:]
        self.assertIn("常用操作", profile_html)
        self.assertIn('data-backup-action="export-encrypted"', profile_html)
        self.assertIn('data-backup-action="upload-encrypted"', profile_html)
        self.assertIn('data-backup-action="export-encrypted"', settings_html)
        self.assertIn('data-backup-action="import-encrypted"', settings_html)
        self.assertIn('data-backup-action="upload-encrypted"', settings_html)
        self.assertIn('id="backupStatusPanel"', settings_html)
        self.assertIn('id="cloudBackupList"', settings_html)
        self.assertIn('data-mobile-section="sync-management"', settings_html)
        self.assertIn("展开云端备份列表与同步高级工具", settings_html)

    def test_local_crypto_unlock_uses_user_bound_ttl_not_operation_counter(self):
        session_js = Path("static/js/modules/session.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        service_worker = Path("static/service-worker.js").read_text(encoding="utf-8")

        crypto_js = Path("static/js/modules/crypto-engine.js").read_text(encoding="utf-8")

        self.assertIn("/static/js/modules/session.js?v=65-device-trusted-unlock", html)
        self.assertIn("/static/js/modules/session.js?v=65-device-trusted-unlock", service_worker)
        self.assertIn("/static/js/modules/crypto-engine.js?v=65-device-trusted-unlock", html)
        self.assertIn("/static/js/modules/crypto-engine.js?v=65-device-trusted-unlock", service_worker)
        self.assertIn("const CRYPTO_UNLOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000", session_js)
        self.assertIn("LeafVault_crypto_unlock_meta_v1", session_js)
        self.assertIn("userId: String(userId)", session_js)
        self.assertIn("unlockedAt: now", session_js)
        self.assertIn("expiresAt: now + CRYPTO_UNLOCK_TTL_MS", session_js)
        self.assertIn("unlockVersion: CRYPTO_UNLOCK_VERSION", session_js)
        self.assertIn("本设备 7 天内无需重复解锁", session_js)
        self.assertIn("密码不会保存到服务器或本地明文存储", session_js)
        self.assertIn("clearCryptoUnlockMeta()", session_js)
        self.assertIn("restoreTrustedUnlock", session_js)
        self.assertIn("TRUSTED_UNLOCK_SEAL_KEY", crypto_js)
        self.assertIn("trustedUntil", session_js)
        self.assertNotIn("crypto-" + "locked-banner", html)
        self.assertNotIn("renderCrypto" + "StatusBanner", session_js)
        self.assertIn("prevUserId && prevUserId !== nextUserId", session_js)
        self.assertNotIn("CRYPTO_UNLOCK" + "_USE_LIMIT", session_js)
        self.assertNotIn("cryptoUnlockUses" + "Remaining", session_js)
        self.assertNotIn("consumeCryptoUnlock" + "Use", session_js)
        self.assertNotIn("连续" + "完成 " + str(5) + " 次", session_js)
        self.assertNotIn("剩余" + "次数", session_js)
        self.assertIsNone(re.search(r"localStorage\.setItem\([^)]*password", session_js, flags=re.IGNORECASE))
        self.assertIsNone(re.search(r"sessionStorage\.setItem\([^)]*password", session_js, flags=re.IGNORECASE))

    def test_backup_build_and_restore_are_server_complete_and_force_restore(self):
        backup_js = Path("static/js/modules/backup.js").read_text(encoding="utf-8")

        self.assertIn("fetchCompleteServerCollection('/api/diaries/list', 100)", backup_js)
        self.assertIn("fetchCompleteServerCollection('/api/ledgers/list', 200)", backup_js)
        self.assertIn("[1, 2].includes(Number(diary?.sync_status || 0))", backup_js)
        self.assertIn("Number(ledger?.sync_status || 0) === 1", backup_js)
        self.assertIn("mergeDiaryBackupRecords(serverDiaries, localPendingDiaries)", backup_js)
        self.assertIn("mergeLedgerBackupRecords(serverLedgers, localPendingLedgers)", backup_js)
        self.assertIn("当前备份来自本机缓存", backup_js)
        self.assertIn("当前备份内容为空，请确认数据是否已加载或本地加密空间是否已解锁", backup_js)
        self.assertIn("mode: 'restore'", backup_js)
        self.assertIn("forceRestore: true", backup_js)
        self.assertIn("markPendingSync: true", backup_js)
        self.assertIn("stripSourceOwnershipFields", backup_js)
        self.assertIn("SOURCE_OWNER_FIELDS", backup_js)
        self.assertIn("sync_status: markPendingSync ? 1", backup_js)
        self.assertIn("is_deleted: 0", backup_js)
        self.assertIn("deleted_at: ''", backup_js)
        self.assertIn("discardPendingLocalChangesForEntity", backup_js)
        self.assertIn("sync_status: 'ignored'", backup_js)
        self.assertIn("恢复备份已取消旧的删除变更", backup_js)
        self.assertIn("window.LeafVaultIncrementalSync.createLocalChange", backup_js)
        self.assertIn("operation: localDiary ? 'update' : 'create'", backup_js)
        self.assertIn("operation: localLedger ? 'update' : 'create'", backup_js)
        self.assertIn("refreshIncrementalSyncStatus", backup_js)
        self.assertIn("checkRemoteChangesQuietly", backup_js)
        self.assertIn("备份中没有可恢复的数据或均被判定无效", backup_js)
        self.assertIn("buildBackupPayload", backup_js)
        self.assertIn("mergeBackupPayloadToLocalDB", backup_js)

    def test_incremental_sync_phase_one_scaffold_is_local_only(self):
        doc = Path("docs/INCREMENTAL_SYNC_DESIGN.md").read_text(encoding="utf-8")
        local_db_js = Path("static/js/modules/local-db.js").read_text(encoding="utf-8")
        incremental_js = Path("static/js/modules/incremental-sync.js").read_text(encoding="utf-8")
        crypto_js = Path("static/js/modules/crypto-engine.js").read_text(encoding="utf-8")
        diary_js = Path("static/js/modules/diary.js").read_text(encoding="utf-8")
        ledger_js = Path("static/js/modules/ledger.js").read_text(encoding="utf-8")
        backup_js = Path("static/js/modules/backup.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        service_worker = Path("static/service-worker.js").read_text(encoding="utf-8")

        self.assertIn("端到端加密增量同步设计", doc)
        self.assertIn("本地优先", doc)
        self.assertIn("云端只保存密文增量", doc)
        self.assertIn("local_changes", doc)
        self.assertIn("sync_changes", doc)
        self.assertIn("### Phase 1：本地变更日志", doc)
        self.assertIn("建立 `local_changes`。", doc)
        self.assertIn("不上传、不下载、不自动合并。", doc)
        self.assertNotIn("Phase 1：本地变更日志骨架，本次完成", doc)

        self.assertIn("const DB_VERSION = 7", local_db_js)
        self.assertIn("createObjectStore('local_changes'", local_db_js)
        self.assertIn("createIndex('sync_status'", local_db_js)
        self.assertIn("createIndex('entity_type'", local_db_js)
        self.assertIn("createIndex('entity_id'", local_db_js)
        self.assertIn("createIndex('created_at'", local_db_js)
        self.assertIn("createIndex('device_id'", local_db_js)
        self.assertIn("createObjectStore('applied_remote_changes'", local_db_js)
        self.assertIn("createIndex('applied_at'", local_db_js)
        self.assertIn("createIndex('local_result'", local_db_js)
        self.assertIn("createObjectStore('sync_conflicts'", local_db_js)
        self.assertIn("createIndex('conflict_status'", local_db_js)
        self.assertIn("createIndex('change_id'", local_db_js)
        self.assertIn("createObjectStore('sync_history'", local_db_js)
        self.assertIn("createIndex('event_type'", local_db_js)
        self.assertIn("createIndex('status'", local_db_js)
        self.assertIn("change_id: data.change_id", crypto_js)
        self.assertIn("entity_type: data.entity_type", crypto_js)
        self.assertIn("entity_id: data.entity_id", crypto_js)
        self.assertIn("device_id: data.device_id", crypto_js)
        self.assertIn("applied_at: data.applied_at", crypto_js)
        self.assertIn("local_result: data.local_result", crypto_js)
        self.assertIn("conflict_id: data.conflict_id", crypto_js)
        self.assertIn("conflict_status: data.conflict_status", crypto_js)
        self.assertIn("resolution_choice: data.resolution_choice", crypto_js)
        self.assertIn("resolved_at: data.resolved_at", crypto_js)
        self.assertIn("resolved_change_id: data.resolved_change_id", crypto_js)
        self.assertIn("history_id: data.history_id", crypto_js)
        self.assertIn("event_type: data.event_type", crypto_js)
        self.assertIn("status: data.status", crypto_js)

        self.assertIn("function getDeviceId", incremental_js)
        self.assertIn("function getNextClientSequence", incremental_js)
        self.assertIn("async function createLocalChange", incremental_js)
        self.assertIn("async function listPendingLocalChanges", incremental_js)
        self.assertIn("async function markLocalChangeSynced", incremental_js)
        self.assertIn("async function markLocalChangeFailed", incremental_js)
        self.assertIn("async function recordSyncHistory", incremental_js)
        self.assertIn("async function listSyncHistory", incremental_js)
        self.assertIn("async function renderSyncHistoryPanel", incremental_js)
        self.assertIn("async function retryFailedLocalChange", incremental_js)
        self.assertIn("async function ignoreFailedLocalChange", incremental_js)
        self.assertIn("async function getSyncDashboardSummary", incremental_js)
        self.assertIn("async function cleanupSyncedLocalChanges", incremental_js)
        self.assertIn("async function cleanupResolvedConflicts", incremental_js)
        self.assertIn("async function buildPlainChangePayload", incremental_js)
        self.assertIn("async function encryptSyncChangePayload", incremental_js)
        self.assertIn("async function startManualSyncWizard", incremental_js)
        self.assertIn("async function runManualSyncFlow", incremental_js)
        self.assertIn("function renderManualSyncResult", incremental_js)
        self.assertIn("async function uploadPendingLocalChangesWithPassword", incremental_js)
        self.assertIn("async function getUnprocessedRemoteChanges", incremental_js)
        self.assertIn("async function recordManualSyncHistory", incremental_js)
        self.assertIn("async function autoCheckRemoteChangesIfNeeded", incremental_js)
        self.assertIn("async function checkRemoteChangesQuietly", incremental_js)
        self.assertIn("function shouldAutoCheckRemoteChanges", incremental_js)
        self.assertIn("function renderSyncAttentionBadge", incremental_js)
        self.assertIn("function dismissSyncAttentionForToday", incremental_js)
        self.assertIn("async function refreshSyncAttentionState", incremental_js)
        self.assertIn("async function runSyncDiagnostics", incremental_js)
        self.assertIn("function buildSyncDiagnosticReport", incremental_js)
        self.assertIn("function renderSyncDiagnosticsPanel", incremental_js)
        self.assertIn("async function exportSyncDiagnosticReport", incremental_js)
        self.assertIn("function getSyncHealthLevel", incremental_js)
        self.assertIn("function selfTestSyncCoreFunctions", incremental_js)
        self.assertIn("async function uploadPendingLocalChanges", incremental_js)
        self.assertIn("async function getPendingChangeCount", incremental_js)
        self.assertIn("async function refreshIncrementalSyncStatus", incremental_js)
        self.assertIn("async function fetchRemoteChangeMetadata", incremental_js)
        self.assertIn("async function getRemoteChangeCount", incremental_js)
        self.assertIn("async function refreshRemoteChangeStatus", incremental_js)
        self.assertIn("function renderRemoteChangeMetadataList", incremental_js)
        self.assertIn("async function fetchRemoteEncryptedChange", incremental_js)
        self.assertIn("async function decryptRemoteChangePayload", incremental_js)
        self.assertIn("async function previewRemoteChange", incremental_js)
        self.assertIn("function renderRemoteChangePreview", incremental_js)
        self.assertIn("function closeRemoteChangePreview", incremental_js)
        self.assertIn("async function getLocalRecordForRemoteChange", incremental_js)
        self.assertIn("async function analyzeRemoteChangeAgainstLocal", incremental_js)
        self.assertIn("function buildMergePlan", incremental_js)
        self.assertIn("function renderMergePlanPreview", incremental_js)
        self.assertIn("function formatMergePlanStatus", incremental_js)
        self.assertIn("async function applyRemoteChange", incremental_js)
        self.assertIn("async function applyMergePlan", incremental_js)
        self.assertIn("async function recordAppliedRemoteChange", incremental_js)
        self.assertIn("async function hasAppliedRemoteChange", incremental_js)
        self.assertIn("async function markRemoteChangeBlocked", incremental_js)
        self.assertIn("async function createConflictCopy", incremental_js)
        self.assertIn("async function saveSyncConflict", incremental_js)
        self.assertIn("async function listSyncConflicts", incremental_js)
        self.assertIn("async function getSyncConflict", incremental_js)
        self.assertIn("async function markSyncConflictIgnored", incremental_js)
        self.assertIn("async function openConflictResolution", incremental_js)
        self.assertIn("async function resolveSyncConflict", incremental_js)
        self.assertIn("async function applyConflictResolution", incremental_js)
        self.assertIn("function renderConflictResolutionPanel", incremental_js)
        self.assertIn("async function markConflictResolved", incremental_js)
        self.assertIn("async function markConflictIgnored", incremental_js)
        self.assertIn("async function refreshSyncConflictStatus", incremental_js)
        self.assertIn("function getLastRemoteChangeCheckAt", incremental_js)
        self.assertIn("function setLastRemoteChangeCheckAt", incremental_js)
        self.assertIn("function buildChangeId", incremental_js)
        self.assertIn("LeafVault_device_id_", incremental_js)
        self.assertIn("LeafVault_client_sequence_", incremental_js)
        self.assertIn("window.LeafVaultIncrementalSync", incremental_js)
        self.assertIn("encrypted_payload: change.encrypted_payload || null", incremental_js)
        self.assertIn("async function encryptSyncChangePayload", incremental_js)
        self.assertIn("CryptoEngine.encryptSyncPayload", incremental_js)
        self.assertIn("async function decryptRemoteChangePayload", incremental_js)
        self.assertIn("CryptoEngine.decryptSyncPayload", incremental_js)
        self.assertIn("encryptSyncPayload", crypto_js)
        self.assertIn("decryptSyncPayload", crypto_js)
        self.assertIn("local-encryption-key-v1", crypto_js)
        self.assertRegex(crypto_js, r"type:\s*['\"]incremental_change['\"]")
        self.assertIn("apiFetch('/api/sync/changes/batch'", incremental_js)
        self.assertIn("apiFetch(`/api/sync/changes?${params.toString()}`)", incremental_js)
        self.assertIn("exclude_device_id", incremental_js)
        self.assertIn("LeafVault_incremental_last_remote_check_at_", incremental_js)
        self.assertIn("LeafVault_incremental_last_auto_check_at_", incremental_js)
        self.assertIn("LeafVault_incremental_auto_check_snoozed_until_", incremental_js)
        self.assertIn("LeafVault_incremental_remote_pending_count_", incremental_js)
        self.assertIn("LeafVault_incremental_attention_dismissed_on_", incremental_js)
        self.assertIn("AUTO_CHECK_INTERVALS", incremental_js)
        self.assertIn("remoteChangeMetadataCache", incremental_js)
        self.assertIn("apiFetch(`/api/sync/changes/${encodeURIComponent(id)}`)", incremental_js)
        self.assertIn('data-incremental-action="preview-remote-change"', incremental_js)
        self.assertIn('data-incremental-action="close-remote-preview"', incremental_js)
        self.assertIn("analyzeRemoteChangeAgainstLocal(decryptedPayload, metadata)", incremental_js)
        self.assertIn("status: 'conflict'", incremental_js)
        self.assertIn("status: 'delete_conflict'", incremental_js)
        self.assertIn("status: 'duplicate'", incremental_js)
        self.assertIn("canApplyMergePlan(mergePlan)", incremental_js)
        self.assertIn('data-incremental-action="apply-remote-change"', incremental_js)
        self.assertIn("应用此变更", incremental_js)
        self.assertIn("不适合直接应用，已阻止覆盖", incremental_js)
        self.assertIn("该远端变更经检查可安全应用", incremental_js)
        self.assertIn("recordAppliedRemoteChange(mergePlan.change_id", incremental_js)
        self.assertIn("applied_remote_changes", incremental_js)
        self.assertIn("sync_conflicts", incremental_js)
        self.assertIn('data-incremental-action="create-conflict-copy"', incremental_js)
        self.assertIn('data-incremental-action="view-sync-conflict"', incremental_js)
        self.assertIn('data-incremental-action="ignore-sync-conflict"', incremental_js)
        self.assertIn('data-incremental-action="resolve-sync-conflict"', incremental_js)
        self.assertIn('data-resolution-choice="keep_local"', incremental_js)
        self.assertIn('data-resolution-choice="use_remote"', incremental_js)
        self.assertIn('data-resolution-choice="manual_merge"', incremental_js)
        self.assertIn("resolution_choice", incremental_js)
        self.assertIn("resolved_change_id", incremental_js)
        self.assertIn("event_type: 'local_change_created'", incremental_js)
        self.assertIn("event_type: 'local_change_uploaded'", incremental_js)
        self.assertIn("event_type: 'local_change_failed'", incremental_js)
        self.assertIn("event_type: 'remote_change_checked'", incremental_js)
        self.assertIn("event_type: 'remote_change_applied'", incremental_js)
        self.assertIn("event_type: 'remote_change_blocked'", incremental_js)
        self.assertIn("event_type: 'conflict_created'", incremental_js)
        self.assertIn("'conflict_resolved'", incremental_js)
        self.assertIn("event_type: updated.conflict_status === 'ignored' ? 'conflict_ignored' : 'conflict_resolved'", incremental_js)
        self.assertIn("event_type: 'cleanup_done'", incremental_js)
        self.assertIn("event_type: 'manual_sync_done'", incremental_js)
        self.assertIn("event_type: 'remote_change_auto_checked'", incremental_js)
        self.assertIn("data-incremental-action=\"start-manual-sync\"", backup_js)
        self.assertIn("syncAttentionBadge", backup_js)
        self.assertIn("syncDiagnosticsResult", backup_js)
        self.assertIn('data-incremental-action="run-sync-diagnostics"', backup_js)
        self.assertIn('data-incremental-action="export-sync-diagnostics"', backup_js)
        self.assertIn("运行同步自检", backup_js)
        self.assertIn("导出诊断报告", backup_js)
        self.assertIn('data-incremental-action="dismiss-sync-attention"', incremental_js)
        self.assertIn("autoCheckRemoteChangesIfNeeded('startup')", incremental_js)
        self.assertIn("autoCheckRemoteChangesIfNeeded('online')", incremental_js)
        self.assertIn("autoCheckRemoteChangesIfNeeded('visibility')", incremental_js)
        self.assertIn("window.addEventListener('online'", incremental_js)
        self.assertIn("document.addEventListener('visibilitychange'", incremental_js)
        self.assertIn("manualSyncWizardPanel", backup_js)
        self.assertIn("开始手动同步", backup_js)
        self.assertIn("冲突不会自动覆盖", backup_js)
        self.assertIn("renderManualSyncResult(result)", incremental_js)
        self.assertIn("getUnprocessedRemoteChanges(remoteChanges)", incremental_js)
        self.assertIn("uploadPendingLocalChangesWithPassword(null", incremental_js)
        self.assertIn("不会自动应用远端变更", incremental_js)
        self.assertIn("不会自动创建冲突副本", incremental_js)
        self.assertIn("预览并应用", incremental_js)
        self.assertIn("查看并创建冲突副本", incremental_js)
        self.assertIn('data-incremental-action="retry-failed-change"', incremental_js)
        self.assertIn('data-incremental-action="ignore-failed-change"', incremental_js)
        self.assertIn("action === 'toggle-sync-history'", incremental_js)
        self.assertIn("action === 'cleanup-synced-local-changes'", incremental_js)
        self.assertIn("action === 'cleanup-resolved-conflicts'", incremental_js)
        self.assertIn("action === 'run-sync-diagnostics'", incremental_js)
        self.assertIn("action === 'export-sync-diagnostics'", incremental_js)
        self.assertIn("createLocalChange({", incremental_js)
        self.assertIn("choice === 'keep_local'", incremental_js)
        self.assertIn("choice === 'use_remote'", incremental_js)
        self.assertIn("choice === 'manual_merge'", incremental_js)
        self.assertIn("conflict_status: resolutionMeta.choice === 'ignore' ? 'ignored' : 'resolved'", incremental_js)
        self.assertIn("解决冲突只会在你确认后修改本地数据", incremental_js)
        self.assertIn("手动合并会生成一个新的本地版本", incremental_js)
        self.assertIn("采用远端删除", incremental_js)
        self.assertIn("创建冲突副本", incremental_js)
        self.assertIn("已创建冲突副本，本地数据未被覆盖", incremental_js)
        self.assertIn("CONFLICT_COPY_STATUSES", incremental_js)
        self.assertIn("const revision = Number(value)", incremental_js)
        self.assertIn("local-encryption-key-v1", incremental_js)
        self.assertIn("function formatSyncError", incremental_js)
        self.assertIn("Array.isArray(detail)", incremental_js)
        self.assertIn("item.loc.join('.')", incremental_js)
        self.assertIn("legacy_password_required", incremental_js)
        self.assertIn("version: 2", crypto_js)
        self.assertIn("当前阶段仅支持解密预览", incremental_js)
        self.assertIn("此内容仅在本设备解密显示", incremental_js)
        self.assertIn("当前离线，联网后再预览云端变更", incremental_js)
        self.assertNotIn("请输入本次同步加密密码", incremental_js)
        self.assertNotIn("请输入同步加密密码以预览", incremental_js)
        self.assertNotIn("请输入同步加密密码以应用", incremental_js)
        self.assertNotIn("请输入同步加密密码以创建冲突副本", incremental_js)
        self.assertNotIn("请输入同步加密密码以重试", incremental_js)
        self.assertIn("当前离线，联网后再上传待同步变更", incremental_js)
        self.assertIn("当前离线，联网后再检查云端变更", incremental_js)
        self.assertNotIn("plain_preview", incremental_js)
        self.assertNotIn("fetch(", incremental_js)
        self.assertNotIn("console.log", incremental_js)
        self.assertNotIn("local" + "Storage.setItem('" + "password", incremental_js)
        self.assertNotIn("session" + "Storage.setItem('" + "password", incremental_js)
        self.assertNotIn("window.LocalStorage.set('manual", incremental_js)
        self.assertNotIn("sessionStorage.setItem", incremental_js)
        self.assertNotIn("sync_history', plainPayload", incremental_js)
        self.assertNotIn("sync_history', decryptedPayload", incremental_js)
        self.assertNotIn("sync_history', encrypted_change", incremental_js)
        self.assertNotIn("强制覆盖所有冲突", incremental_js)
        self.assertNotIn("批量解决", incremental_js)
        preview_body = incremental_js[incremental_js.index("async function previewRemoteChange"):incremental_js.index("async function fetchRemoteChangeMetadata")]
        apply_body = incremental_js[incremental_js.index("async function applyRemoteChange"):incremental_js.index("async function fetchRemoteChangeMetadata")]
        wizard_body = incremental_js[incremental_js.index("async function runManualSyncFlow"):incremental_js.index("async function startManualSyncWizard")]
        start_wizard_body = incremental_js[incremental_js.index("async function startManualSyncWizard"):incremental_js.index("async function refreshIncrementalSyncStatus")]
        quiet_body = incremental_js[incremental_js.index("async function checkRemoteChangesQuietly"):incremental_js.index("function shouldAutoCheckRemoteChanges")]
        diagnostics_body = incremental_js[incremental_js.index("async function runSyncDiagnostics"):incremental_js.index("function getSyncHealthLevel")]
        report_body = incremental_js[incremental_js.index("function buildSyncDiagnosticReport"):incremental_js.index("function renderSyncDiagnosticsPanel")]
        self.assertNotIn("markLocalChangeSynced", preview_body)
        self.assertNotIn("markLocalChangeFailed", preview_body)
        self.assertNotIn("markLocalChangeSynced", apply_body)
        self.assertNotIn("markLocalChangeFailed", apply_body)
        self.assertIn("if (!navigator.onLine)", start_wizard_body)
        self.assertIn("return await runManualSyncFlow()", start_wizard_body)
        self.assertIn("decryptRemoteChangePayload(remoteDetail.encrypted_change)", wizard_body)
        self.assertIn("legacy_password_required", wizard_body)
        self.assertNotIn("applyMergePlan(", wizard_body)
        self.assertNotIn("createConflictCopy(", wizard_body)
        self.assertIn("fetchRemoteChangeMetadata({ exclude_device_id: currentDeviceId, limit: 100 })", quiet_body)
        self.assertNotIn("fetchRemoteEncryptedChange", quiet_body)
        self.assertNotIn("decryptRemoteChangePayload", quiet_body)
        self.assertNotIn("applyMergePlan", quiet_body)
        self.assertNotIn("createConflictCopy", quiet_body)
        self.assertNotIn("window.LocalStorage.set('diaries'", quiet_body)
        self.assertNotIn("window.LocalStorage.set('ledgers'", quiet_body)
        self.assertNotIn("fetchRemoteEncryptedChange", diagnostics_body)
        self.assertNotIn("decryptRemoteChangePayload", diagnostics_body)
        self.assertNotIn("window.LocalStorage.set('diaries'", diagnostics_body)
        self.assertNotIn("window.LocalStorage.set('ledgers'", diagnostics_body)
        self.assertNotIn("window.LocalStorage.delete('local_changes'", diagnostics_body)
        self.assertNotIn("window.LocalStorage.delete('sync_conflicts'", diagnostics_body)
        self.assertIn("fetchRemoteChangeMetadata({ exclude_device_id: getDeviceId(), limit: 100 })", incremental_js)
        self.assertIn("window.apiFetch('/api/sync/snapshots')", incremental_js)
        self.assertIn("if (!window.confirm('诊断报告不包含日记正文、账本备注、密码或密钥", incremental_js)
        for forbidden in ["content:", "note:", "encrypted_change", "encrypted_blob", "payload", "decryptedPayload", "token", "password", "key"]:
            self.assertNotIn(forbidden, report_body)
        self.assertIn("diagnosticResult.local_changes?.failed", incremental_js)
        self.assertIn("diagnosticResult.sync_conflicts?.open", incremental_js)
        self.assertIn("diagnosticResult.ledgers?.duplicate_uuid", incremental_js)

        self.assertIn("/static/js/modules/incremental-sync.js?v=71-sync-v2-local-key", html)
        self.assertIn("/static/js/modules/incremental-sync.js?v=71-sync-v2-local-key", service_worker)
        self.assertIn("LeafVaultIncrementalSync?.createLocalChange", diary_js)
        self.assertIn("operation: diaryOperation", diary_js)
        self.assertIn("operation: 'delete'", diary_js)
        self.assertIn("LeafVaultIncrementalSync?.createLocalChange", ledger_js)
        self.assertIn("operation: 'create'", ledger_js)
        self.assertIn("previousLedger?.uuid || ledgerId", ledger_js)
        self.assertIn("pendingLocalChangeCount", backup_js)
        self.assertIn("uploadPendingChangesBtn", backup_js)
        self.assertIn("upload-incremental-changes", backup_js)
        self.assertIn("check-remote-changes", backup_js)
        self.assertIn("remoteChangeMetadataList", backup_js)
        self.assertIn("remoteChangePreviewPanel", backup_js)
        self.assertIn("syncConflictCount", backup_js)
        self.assertIn("syncConflictList", backup_js)
        self.assertIn("syncConflictDetailPanel", backup_js)
        self.assertIn("failedLocalChangesPanel", backup_js)
        self.assertIn("failedLocalChangeList", backup_js)
        self.assertIn("syncHistoryList", backup_js)
        self.assertIn("syncHistoryAllList", backup_js)
        self.assertIn("cleanup-synced-local-changes", backup_js)
        self.assertIn("cleanup-resolved-conflicts", backup_js)
        self.assertIn("云端新变更", backup_js)
        self.assertIn("本地待上传", backup_js)

    def test_backup_export_is_client_side_encrypted_only(self):
        backup_js = Path("static/js/modules/backup.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        pwa_status_js = Path("static/js/modules/pwa-status.js").read_text(encoding="utf-8")
        service_worker = Path("static/service-worker.js").read_text(encoding="utf-8")
        self.assertIn("async function exportEncryptedBackup()", backup_js)
        self.assertIn("async function importEncryptedBackup(file, password)", backup_js)
        self.assertIn("async function uploadEncryptedBackupSnapshot()", backup_js)
        self.assertIn("async function fetchCloudBackupSnapshots()", backup_js)
        self.assertIn("async function downloadCloudBackupSnapshot(snapshotId)", backup_js)
        self.assertIn("async function restoreCloudBackupSnapshot(snapshotId)", backup_js)
        self.assertIn("async function deleteCloudBackupSnapshot(snapshotId)", backup_js)
        self.assertIn("ensureOnlineForCloudBackup", backup_js)
        self.assertIn("async function buildBackupPayload(", backup_js)
        self.assertIn("buildBackupPayload({ forCloud: false })", backup_js)
        self.assertIn("buildBackupPayload({ forCloud: true })", backup_js)
        self.assertIn("async function encryptBackupPayload(backupPayload, password)", backup_js)
        self.assertIn("function parseEncryptedBackupJson(raw)", backup_js)
        self.assertIn("async function decryptBackupPayload(encryptedBackup, password)", backup_js)
        self.assertIn("async function mergeBackupPayloadToLocalDB(backupPayload, options = {})", backup_js)
        self.assertIn("window.exportEncryptedBackup = exportEncryptedBackup", backup_js)
        self.assertIn("window.importEncryptedBackup = importEncryptedBackup", backup_js)
        self.assertIn("window.uploadEncryptedBackupSnapshot = uploadEncryptedBackupSnapshot", backup_js)
        self.assertIn("window.fetchCloudBackupSnapshots = fetchCloudBackupSnapshots", backup_js)
        self.assertIn("window.downloadCloudBackupSnapshot = downloadCloudBackupSnapshot", backup_js)
        self.assertIn("window.restoreCloudBackupSnapshot = restoreCloudBackupSnapshot", backup_js)
        self.assertIn("window.deleteCloudBackupSnapshot = deleteCloudBackupSnapshot", backup_js)
        self.assertIn("window.markLocalDataChanged = markLocalDataChanged", backup_js)
        self.assertIn("window.markCloudBackupUploaded = markCloudBackupUploaded", backup_js)
        self.assertIn("window.updateBackupStatusPanel = updateBackupStatusPanel", backup_js)
        self.assertIn("window.shouldShowBackupReminder = shouldShowBackupReminder", backup_js)
        self.assertIn("window.LocalStorage.getAll('diaries')", backup_js)
        self.assertIn("window.LocalStorage.getAll('ledgers')", backup_js)
        self.assertIn("window.LocalStorage.set('diaries'", backup_js)
        self.assertIn("window.LocalStorage.set('ledgers'", backup_js)
        self.assertIn("apiFetch('/api/sync/snapshot'", backup_js)
        self.assertIn("apiFetch('/api/sync/snapshots')", backup_js)
        self.assertIn("apiFetch(`/api/sync/snapshots/${encodeURIComponent(id)}`)", backup_js)
        self.assertIn("云端加密备份上传成功", backup_js)
        self.assertIn("云端加密备份已下载", backup_js)
        self.assertIn("leafvault-cloud-backup-${datePart}.lvbackup", backup_js)
        self.assertIn("恢复云端备份会把该备份中的日记和账本合并到本地数据中，不会清空现有数据。是否继续？", backup_js)
        self.assertIn("备份密码错误或备份已损坏", backup_js)
        self.assertIn("云端备份恢复完成：已恢复", backup_js)
        self.assertIn("无权访问该备份或登录已失效", backup_js)
        self.assertIn('data-backup-action="restore-cloud"', backup_js)
        self.assertIn('data-backup-action="delete-cloud"', backup_js)
        self.assertIn("删除后该云端加密备份将无法恢复，但不会影响你本地的日记和账本。是否继续？", backup_js)
        self.assertIn("method: 'DELETE'", backup_js)
        self.assertIn("云端备份已删除", backup_js)
        self.assertIn("PBKDF2", backup_js)
        self.assertIn("AES-GCM", backup_js)
        self.assertIn("310000", backup_js)
        self.assertIn(".lvbackup", backup_js)
        self.assertIn("备份密码错误或文件已损坏", backup_js)
        self.assertIn("备份文件格式不正确", backup_js)
        self.assertIn("备份导入完成：已恢复", backup_js)
        self.assertIn("backupActionsBound", backup_js)
        self.assertNotIn("console.log", backup_js)
        self.assertIn("function shouldShowBackupReminder", backup_js)
        self.assertIn("function snoozeBackupReminder", backup_js)
        self.assertIn("function dismissBackupReminderForWeek", backup_js)
        self.assertIn("function clearBackupReminderState", backup_js)
        self.assertIn("function updateBackupStatusPanel", backup_js)
        self.assertIn("LeafVault_backup_reminder_last_shown_at", backup_js)
        self.assertIn("LeafVault_backup_reminder_snoozed_until", backup_js)
        self.assertIn("还没有云端加密备份，建议找个时间上传一份。", backup_js)
        self.assertIn("本地数据已有新变化，建议空闲时上传一份新的云端加密备份。", backup_js)
        self.assertIn('data-backup-action="reminder-upload"', backup_js)
        self.assertIn('data-backup-action="reminder-snooze"', backup_js)
        self.assertIn('data-backup-action="reminder-week"', backup_js)
        self.assertIn("requestCloudSnapshotMetadata", backup_js)
        self.assertIn("snapshot_name", backup_js)
        self.assertIn("snapshot_note", backup_js)
        self.assertIn("备份名称不能超过 60 字", backup_js)
        self.assertIn("备份备注不能超过 200 字", backup_js)
        self.assertIn("cloud-backup-note", backup_js)
        self.assertIn("leafvault-${safeName}-${datePart}.lvbackup", backup_js)
        self.assertIn("sanitizeFilenamePart", backup_js)
        self.assertNotIn("Notification", backup_js)
        self.assertNotIn("sessionStorage.setItem", backup_js)
        self.assertNotIn("fetch(", backup_js)
        self.assertIn('/static/js/modules/pwa-status.js?v=54-css-shell-refresh', html)
        self.assertIn('/static/js/modules/backup.js?v=71-image-src-normalize', html)
        self.assertIn('/static/js/modules/backup.js?v=71-image-src-normalize', service_worker)
        self.assertIn('/static/js/modules/incremental-sync.js?v=71-sync-v2-local-key', html)
        self.assertIn('/static/js/modules/incremental-sync.js?v=71-sync-v2-local-key', service_worker)
        self.assertIn('/static/js/modules/pwa-status.js?v=54-css-shell-refresh', service_worker)
        self.assertIn('/static/js/utils/image.js?v=44-diary-image-upload', html)
        self.assertIn('data-backup-action="export-encrypted"', html)
        self.assertIn('data-backup-action="import-encrypted"', html)
        self.assertIn('data-backup-action="upload-encrypted"', html)
        self.assertIn('data-backup-action="refresh-cloud"', html)
        self.assertIn('id="cloudBackupList"', html)
        self.assertIn('id="backupStatusPanel"', html)
        self.assertIn("backup-reminder", html)
        self.assertIn('id="pwaStatusBanner"', html)
        self.assertIn("registerPWAUpdateHandler", pwa_status_js)
        self.assertIn("SKIP_WAITING", pwa_status_js)
        self.assertIn("controllerchange", pwa_status_js)
        self.assertIn("LeafVault 有新版本可用", pwa_status_js)
        self.assertIn("当前处于离线状态，本地日记和账本仍可使用，云端备份暂不可用。", pwa_status_js)
        self.assertIn("当前离线，联网后再使用此功能。", pwa_status_js)
        self.assertIn("ensureOnlineForCloudFeature", pwa_status_js)
        self.assertIn("暂无云端备份", html)
        settings_start = html.index('id="view-settings"')
        upload_btn = html.index('data-backup-action="upload-encrypted"', settings_start)
        status_panel = html.index('id="backupStatusPanel"', settings_start)
        cloud_list = html.index('id="cloudBackupList"', settings_start)
        self.assertGreater(status_panel, upload_btn)
        self.assertGreater(cloud_list, upload_btn)
        self.assertIn("window.fetchCloudBackupSnapshots?.();", html)

    def test_pwa_service_worker_update_and_cache_policy_is_safe(self):
        service_worker = Path("static/service-worker.js").read_text(encoding="utf-8")
        html = Path("templates/index.html").read_text(encoding="utf-8")
        pwa_status_js = Path("static/js/modules/pwa-status.js").read_text(encoding="utf-8")

        self.assertIn("const CACHE_VERSION = 'leafvault-v0.2.40-register-422-errors'", service_worker)
        self.assertIn("const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`", service_worker)
        self.assertIn("APP_SHELL_ASSETS", service_worker)
        self.assertIn("request.headers.has('Authorization')", service_worker)
        self.assertIn("url.pathname.startsWith('/api/')", service_worker)
        self.assertIn("url.pathname === '/profile' || url.pathname.startsWith('/profile/')", service_worker)
        self.assertIn("url.pathname.startsWith('/static/images/')", service_worker)
        self.assertIn("url.pathname.startsWith('/uploads/')", service_worker)
        self.assertIn("request.mode === 'navigate'", service_worker)
        self.assertIn("isCodeAsset(url)", service_worker)
        self.assertIn("function cacheResponse(cacheKey, response)", service_worker)
        self.assertIn("const responseForCache = response.clone()", service_worker)
        self.assertIn("HTML App Shell", service_worker)
        self.assertNotIn("event.waitUntil(cacheResponse('/', networkResponse))", service_worker)
        self.assertNotIn("return response.clone()", service_worker)
        self.assertIn("caches.keys().then(keys => Promise.all", service_worker)
        self.assertIn("event.data?.type === 'SKIP_WAITING'", service_worker)
        self.assertNotIn("self.skipWaiting();\n});\n\nself.addEventListener('activate'", service_worker)
        self.assertNotIn("payload", service_worker)
        self.assertNotIn("Authorization') return false", service_worker)

        self.assertNotIn("serviceWorker.register('/static/service-worker.js", html)
        self.assertIn("Service Worker 注册与更新提示由 /static/js/modules/pwa-status.js 统一处理", html)
        self.assertIn("navigator.serviceWorker.register('/service-worker.js?v=55-css-shell-refresh'", pwa_status_js)
        self.assertIn("scope: '/'", pwa_status_js)
        self.assertNotIn("navigator.serviceWorker.register('/static/service-worker.js", pwa_status_js)
        self.assertIn("pendingWorker.postMessage({ type: 'SKIP_WAITING' })", pwa_status_js)
        self.assertIn("window.location.reload()", pwa_status_js)
        self.assertIn("window.addEventListener('offline'", pwa_status_js)
        self.assertIn("window.addEventListener('online'", pwa_status_js)


if __name__ == "__main__":
    unittest.main()
