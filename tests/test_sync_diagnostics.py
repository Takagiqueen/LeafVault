from tests.test_backup_snapshots import encrypted_snapshot
from tests.test_incremental_sync_api import change_item, post_batch


FORBIDDEN_FIELDS = {"encrypted_change", "encrypted_blob", "payload"}


def test_sync_diagnostics_summary_requires_login(api):
    assert api.client.get("/api/sync/diagnostics/summary").status_code in (401, 403)


def test_sync_diagnostics_summary_returns_counts_only_for_current_user(api):
    token_a = api.register_and_login("diag_a", "diag-a@example.test")
    token_b = api.register_and_login("diag_b", "diag-b@example.test")
    post_batch(api, token_a, [change_item("diag-a-change")])
    api.client.post("/api/sync/snapshot", headers=api.auth(token_a), json=encrypted_snapshot())
    post_batch(api, token_b, [change_item("diag-b-change")])
    api.client.post("/api/sync/snapshot", headers=api.auth(token_b), json=encrypted_snapshot())

    data_a = api.client.get("/api/sync/diagnostics/summary", headers=api.auth(token_a)).json()["data"]
    assert data_a["sync_changes_count"] == 1
    assert data_a["snapshots_count"] == 1
    assert data_a["latest_change_uploaded_at"]
    assert data_a["latest_snapshot_uploaded_at"]
    assert not FORBIDDEN_FIELDS.intersection(data_a.keys())


def test_sync_diagnostics_summary_does_not_expose_other_users_counts(api):
    token_a = api.register_and_login("diag_empty", "diag-empty@example.test")
    token_b = api.register_and_login("diag_full", "diag-full@example.test")
    post_batch(api, token_b, [change_item("diag-private-change")])
    api.client.post("/api/sync/snapshot", headers=api.auth(token_b), json=encrypted_snapshot())

    data_a = api.client.get("/api/sync/diagnostics/summary", headers=api.auth(token_a)).json()["data"]
    assert data_a["sync_changes_count"] == 0
    assert data_a["snapshots_count"] == 0
