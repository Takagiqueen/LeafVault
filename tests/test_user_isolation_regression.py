def test_user_isolation_for_diaries_ledgers_snapshots_and_sync_changes(api, create_cloud_snapshot, create_sync_change):
    token_a = api.register_and_login("iso_a", "iso-a@example.test")
    token_b = api.register_and_login("iso_b", "iso-b@example.test")

    api.client.post(
        "/api/diaries/",
        headers=api.auth(token_a),
        data={"date": "2026-06-03", "mood_label": "happy", "content": "A private diary"},
    )
    assert api.client.get("/api/diaries/detail?date=2026-06-03", headers=api.auth(token_b)).json()["status"] == "not_found"
    assert api.client.delete("/api/diaries/2026-06-03", headers=api.auth(token_b)).status_code == 200
    assert api.client.get("/api/diaries/detail?date=2026-06-03", headers=api.auth(token_a)).json()["data"]["content"] == "A private diary"

    api.client.post(
        "/api/ledgers/",
        headers=api.auth(token_a),
        data={"type": "expense", "amount": "33.5", "category": "private", "note": "A private ledger", "date": "2026-06-03", "uuid": "iso-ledger-a"},
    )
    ledger_id = api.client.get("/api/ledgers/list", headers=api.auth(token_a)).json()["data"][0]["id"]
    assert api.client.delete(f"/api/ledgers/{ledger_id}", headers=api.auth(token_b)).status_code == 200
    assert len(api.client.get("/api/ledgers/list", headers=api.auth(token_a)).json()["data"]) == 1
    assert api.client.get("/api/ledgers/list", headers=api.auth(token_b)).json()["data"] == []

    snap_a = create_cloud_snapshot(token_a, snapshot_name="iso-a-snapshot").json()["snapshot_id"]
    snap_b = create_cloud_snapshot(token_b, snapshot_name="iso-b-snapshot").json()["snapshot_id"]
    list_b = api.client.get("/api/sync/snapshots", headers=api.auth(token_b)).json()["data"]
    assert [row["snapshot_name"] for row in list_b] == ["iso-b-snapshot"]
    assert api.client.get(f"/api/sync/snapshots/{snap_a}", headers=api.auth(token_b)).status_code == 404
    assert api.client.delete(f"/api/sync/snapshots/{snap_a}", headers=api.auth(token_b)).status_code == 404
    assert api.client.get(f"/api/sync/snapshots/{snap_b}", headers=api.auth(token_b)).status_code == 200

    create_sync_change(token_a, "iso-change-a")
    create_sync_change(token_b, "iso-change-b")
    changes_b = api.client.get("/api/sync/changes", headers=api.auth(token_b)).json()["data"]
    assert [row["change_id"] for row in changes_b] == ["iso-change-b"]
    assert api.client.get("/api/sync/changes/iso-change-a", headers=api.auth(token_b)).status_code == 404

    summary_b = api.client.get("/api/sync/diagnostics/summary", headers=api.auth(token_b)).json()["data"]
    assert summary_b["sync_changes_count"] == 1
    assert summary_b["snapshots_count"] == 1
