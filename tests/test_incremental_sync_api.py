import json

import routers.sync as sync_router


def encrypted_change(**overrides):
    payload = {
        "version": 1,
        "app": "LeafVault",
        "type": "incremental_change",
        "kdf": "PBKDF2",
        "iterations": 310000,
        "salt": "c2FsdA==",
        "iv": "aXY=",
        "payload": "Y2lwaGVyLWNoYW5nZQ==",
    }
    payload.update(overrides)
    return payload


def change_item(change_id="change-1", **overrides):
    item = {
        "change_id": change_id,
        "entity_type": "diary",
        "entity_id": "2026-05-21",
        "operation": "update",
        "encrypted_change": encrypted_change(),
        "device_id": "device-a",
        "client_sequence": 1,
        "base_revision": 0,
        "local_revision": 1,
        "created_at": "2026-05-21T10:00:00.000Z",
    }
    item.update(overrides)
    return item


def post_batch(api, token, changes):
    return api.client.post("/api/sync/changes/batch", headers=api.auth(token), json={"changes": changes})


def test_changes_batch_requires_login_and_accepts_valid_encrypted_change(api):
    assert api.client.post("/api/sync/changes/batch", json={"changes": [change_item()]}).status_code in (401, 403)
    token = api.register_and_login("sync_upload", "sync-upload@example.test")
    body = post_batch(api, token, [change_item()]).json()
    assert body["status"] == "success"
    assert body["saved"] == 1
    assert body["saved_change_ids"] == ["change-1"]


def test_change_id_is_idempotent(api):
    token = api.register_and_login("sync_dupe", "sync-dupe@example.test")
    assert post_batch(api, token, [change_item("same-change")]).json()["saved"] == 1
    second = post_batch(api, token, [change_item("same-change")]).json()
    assert second["saved"] == 0
    assert second["skipped"] == 1


def test_user_scope_and_metadata_list_hides_encrypted_change(api):
    token_a = api.register_and_login("sync_a", "sync-a@example.test")
    token_b = api.register_and_login("sync_b", "sync-b@example.test")
    post_batch(api, token_a, [change_item("a-change", device_id="device-a")])
    post_batch(api, token_b, [change_item("b-change", device_id="device-b")])

    list_a = api.client.get("/api/sync/changes", headers=api.auth(token_a)).json()
    assert list_a["count"] == 1
    assert list_a["data"][0]["change_id"] == "a-change"
    assert "encrypted_change" not in list_a["data"][0]

    assert api.client.get("/api/sync/changes/b-change", headers=api.auth(token_a)).status_code == 404
    detail = api.client.get("/api/sync/changes/a-change", headers=api.auth(token_a)).json()["data"]
    assert detail["encrypted_change"]["type"] == "incremental_change"


def test_invalid_change_inputs_are_rejected(api):
    token = api.register_and_login("sync_invalid", "sync-invalid@example.test")
    assert post_batch(api, token, [change_item("bad-type", entity_type="profile")]).status_code == 422
    assert post_batch(api, token, [change_item("bad-op", operation="merge")]).status_code == 422
    too_many = post_batch(api, token, [change_item(f"bulk-{i}") for i in range(101)])
    assert too_many.status_code == 400
    assert "Y2lwaGVyLWNoYW5nZQ==" not in str(too_many.json())


def test_sync_batch_size_limit_uses_configured_cap(api, monkeypatch):
    monkeypatch.setattr(sync_router, "MAX_SYNC_CHANGE_BATCH_SIZE", 2)
    token = api.register_and_login("sync_batch_limit", "sync-batch-limit@example.test")
    response = post_batch(api, token, [change_item(f"small-cap-{i}") for i in range(3)])
    assert response.status_code == 400
    body = response.json()
    assert "单次最多上传 2 条同步变更" in body["detail"]
    assert "encrypted_change" not in str(body)


def test_single_sync_change_payload_size_limit_does_not_echo_ciphertext(api, monkeypatch):
    monkeypatch.setattr(sync_router, "MAX_SYNC_CHANGE_PAYLOAD_BYTES", 12)
    monkeypatch.setattr(sync_router, "MAX_SYNC_CHANGE_PAYLOAD_KB", 1)
    token = api.register_and_login("sync_payload_limit", "sync-payload-limit@example.test")
    oversized_payload = "X" * 64
    response = post_batch(
        api,
        token,
        [change_item("too-large-payload", encrypted_change=encrypted_change(payload=oversized_payload))],
    )
    assert response.status_code == 413
    body_text = response.text
    assert "payload" in body_text
    assert oversized_payload not in body_text


def test_saved_sync_change_is_ciphertext_string_not_plaintext(api):
    token = api.register_and_login("sync_cipher", "sync-cipher@example.test")
    post_batch(api, token, [change_item("cipher-change", encrypted_change=encrypted_change(payload="RU5DUllQVEVE"))])
    conn = api.connect()
    row = conn.execute("SELECT encrypted_change FROM sync_changes WHERE change_id = ?", ("cipher-change",)).fetchone()
    conn.close()
    assert isinstance(row["encrypted_change"], str)
    assert "DIARYPLAINTEXT" not in row["encrypted_change"]
    parsed = json.loads(row["encrypted_change"])
    assert parsed["payload"] == "RU5DUllQVEVE"


def test_exclude_device_id_and_entity_type_filters(api):
    token = api.register_and_login("sync_filter", "sync-filter@example.test")
    post_batch(
        api,
        token,
        [
            change_item("own-diary", device_id="own-device", entity_type="diary"),
            change_item("remote-ledger", device_id="other-device", entity_type="ledger", entity_id="ledger-uuid", operation="create"),
        ],
    )
    filtered = api.client.get("/api/sync/changes?exclude_device_id=own-device", headers=api.auth(token)).json()["data"]
    assert [row["change_id"] for row in filtered] == ["remote-ledger"]
    assert api.client.get("/api/sync/changes?entity_type=profile", headers=api.auth(token)).status_code == 422
