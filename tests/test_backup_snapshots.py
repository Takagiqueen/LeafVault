import json
import base64

import routers.sync as sync_router


def encrypted_snapshot(**overrides):
    payload = {
        "version": 1,
        "app": "LeafVault",
        "kdf": "PBKDF2",
        "iterations": 310000,
        "salt": "c2FsdA==",
        "iv": "aXY=",
        "payload": "Y2lwaGVydGV4dA==",
        "created_at": "2026-05-21T10:00:00.000Z",
        "device_name": "pytest-device",
        "snapshot_name": "manual snapshot",
        "snapshot_note": "safe note",
    }
    payload.update(overrides)
    return payload


def test_snapshot_upload_requires_login_and_accepts_valid_ciphertext(api):
    assert api.client.post("/api/sync/snapshot", json=encrypted_snapshot()).status_code in (401, 403)

    token = api.register_and_login("snap_uploader", "snap-uploader@example.test")
    response = api.client.post("/api/sync/snapshot", headers=api.auth(token), json=encrypted_snapshot())
    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "success"
    assert body["snapshot_id"]
    snapshot_list = api.client.get("/api/sync/snapshots", headers=api.auth(token)).json()
    assert snapshot_list["count"] == 1
    assert snapshot_list["max_cloud_snapshots_per_user"] >= 1


def test_snapshot_list_detail_and_delete_are_user_scoped(api):
    token_a = api.register_and_login("snap_a", "snap-a@example.test")
    token_b = api.register_and_login("snap_b", "snap-b@example.test")

    snapshot_a = api.client.post("/api/sync/snapshot", headers=api.auth(token_a), json=encrypted_snapshot(snapshot_name="A only")).json()
    snapshot_b = api.client.post("/api/sync/snapshot", headers=api.auth(token_b), json=encrypted_snapshot(snapshot_name="B only")).json()

    list_a = api.client.get("/api/sync/snapshots", headers=api.auth(token_a)).json()["data"]
    assert len(list_a) == 1
    assert list_a[0]["snapshot_name"] == "A only"
    assert "encrypted_blob" not in list_a[0]

    assert api.client.get(f"/api/sync/snapshots/{snapshot_b['snapshot_id']}", headers=api.auth(token_a)).status_code == 404
    assert api.client.delete(f"/api/sync/snapshots/{snapshot_b['snapshot_id']}", headers=api.auth(token_a)).status_code == 404

    detail_a = api.client.get(f"/api/sync/snapshots/{snapshot_a['snapshot_id']}", headers=api.auth(token_a)).json()["data"]
    assert detail_a["payload"] == "Y2lwaGVydGV4dA=="
    assert detail_a["snapshot_name"] == "A only"


def test_deleting_snapshot_does_not_delete_diaries_or_ledgers(api):
    token = api.register_and_login("snap_data", "snap-data@example.test")
    api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-05-14", "mood_label": "happy", "content": "keep diary"},
    )
    api.client.post(
        "/api/ledgers/",
        headers=api.auth(token),
        data={"type": "expense", "amount": "8", "category": "meal", "note": "keep ledger", "date": "2026-05-14", "uuid": "keep-ledger"},
    )
    snapshot_id = api.client.post("/api/sync/snapshot", headers=api.auth(token), json=encrypted_snapshot()).json()["snapshot_id"]
    assert api.client.delete(f"/api/sync/snapshots/{snapshot_id}", headers=api.auth(token)).json()["status"] == "success"
    assert len(api.client.get("/api/diaries/list", headers=api.auth(token)).json()["data"]) == 1
    assert len(api.client.get("/api/ledgers/list", headers=api.auth(token)).json()["data"]) == 1


def test_snapshot_metadata_length_limits_and_ciphertext_storage(api):
    token = api.register_and_login("snap_meta", "snap-meta@example.test")
    too_long_name = api.client.post(
        "/api/sync/snapshot",
        headers=api.auth(token),
        json=encrypted_snapshot(snapshot_name="x" * 61),
    )
    assert too_long_name.status_code == 422
    too_long_note = api.client.post(
        "/api/sync/snapshot",
        headers=api.auth(token),
        json=encrypted_snapshot(snapshot_note="y" * 201),
    )
    assert too_long_note.status_code == 422

    api.client.post("/api/sync/snapshot", headers=api.auth(token), json=encrypted_snapshot(payload="bm90LXBsYWludGV4dA=="))
    conn = api.connect()
    blob = conn.execute("SELECT encrypted_blob FROM sync_snapshots").fetchone()["encrypted_blob"]
    conn.close()
    assert "VERY_SECRET_DIARY_TEXT" not in blob
    parsed = json.loads(blob)
    assert parsed["payload"] == "bm90LXBsYWludGV4dA=="


def test_snapshot_upload_rejects_when_user_reaches_limit(api, monkeypatch):
    monkeypatch.setattr(sync_router, "MAX_CLOUD_SNAPSHOTS_PER_USER", 2)
    token = api.register_and_login("snap_limit", "snap-limit@example.test")

    first = api.client.post("/api/sync/snapshot", headers=api.auth(token), json=encrypted_snapshot(created_at="2026-05-21T10:00:00.000Z"))
    second = api.client.post("/api/sync/snapshot", headers=api.auth(token), json=encrypted_snapshot(created_at="2026-05-22T10:00:00.000Z"))
    third = api.client.post("/api/sync/snapshot", headers=api.auth(token), json=encrypted_snapshot(created_at="2026-05-23T10:00:00.000Z"))

    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 400
    body = third.json()
    assert body["detail"] == "云端备份数量已达上限，请删除旧备份后再上传。"
    assert "encrypted_blob" not in str(body)
    assert "Y2lwaGVydGV4dA==" not in str(body)


def test_snapshot_payload_size_limit_does_not_echo_ciphertext(api, monkeypatch):
    monkeypatch.setattr(sync_router, "MAX_CLOUD_SNAPSHOT_PAYLOAD_BYTES", 12)
    monkeypatch.setattr(sync_router, "MAX_CLOUD_SNAPSHOT_PAYLOAD_MB", 1)
    token = api.register_and_login("snap_payload_limit", "snap-payload-limit@example.test")
    oversized_payload = "X" * 64
    response = api.client.post(
        "/api/sync/snapshot",
        headers=api.auth(token),
        json=encrypted_snapshot(payload=oversized_payload),
    )
    assert response.status_code == 413
    body_text = response.text
    assert "payload" in body_text
    assert oversized_payload not in body_text


def test_backup_asset_restore_writes_current_user_upload(api, temp_upload_dir, monkeypatch):
    monkeypatch.setattr(sync_router, "UPLOAD_DIR", temp_upload_dir)
    token = api.register_and_login("asset_restore", "asset-restore@example.test")
    jpeg_bytes = b"\xff\xd8\xff\xe0" + (b"0" * 32)
    response = api.client.post(
        "/api/backup/assets/restore",
        headers=api.auth(token),
        json={
            "old_path": "/uploads/old.jpg",
            "filename": "old.jpg",
            "mime": "image/jpeg",
            "size": len(jpeg_bytes),
            "sha256": "",
            "data_base64": base64.b64encode(jpeg_bytes).decode("ascii"),
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "success"
    assert body["data"]["path"].startswith("/uploads/")
    assert ".." not in body["data"]["path"]
    assert temp_upload_dir.joinpath(body["data"]["path"].split("/")[-1]).exists()
