from core.config import CSRF_COOKIE_NAME, CSRF_HEADER_NAME


def encrypted_snapshot(**overrides):
    payload = {
        "version": 1,
        "app": "LeafVault",
        "kdf": "PBKDF2",
        "iterations": 310000,
        "salt": "c2FsdA==",
        "iv": "aXY=",
        "payload": "Y2lwaGVydGV4dA==",
        "created_at": "2026-05-23T10:00:00.000Z",
        "device_name": "csrf-test",
    }
    payload.update(overrides)
    return payload


def csrf_header(api):
    return {CSRF_HEADER_NAME: api.client.cookies.get(CSRF_COOKIE_NAME)}


def test_bearer_write_requests_do_not_require_csrf(api):
    token = api.register_and_login("csrf_bearer", "csrf-bearer@example.test")
    response = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-05-23", "mood_label": "happy", "content": "bearer no csrf"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"


def test_cookie_write_requests_require_matching_csrf_header(api):
    api.register_and_login("csrf_cookie", "csrf-cookie@example.test")

    missing = api.client.post(
        "/api/diaries/",
        data={"date": "2026-05-24", "mood_label": "happy", "content": "missing csrf"},
    )
    assert missing.status_code == 403
    assert missing.json()["message"] == "CSRF validation failed"

    wrong = api.client.post(
        "/api/diaries/",
        headers={CSRF_HEADER_NAME: "wrong-token"},
        data={"date": "2026-05-24", "mood_label": "happy", "content": "wrong csrf"},
    )
    assert wrong.status_code == 403

    ok = api.client.post(
        "/api/diaries/",
        headers=csrf_header(api),
        data={"date": "2026-05-24", "mood_label": "happy", "content": "correct csrf"},
    )
    assert ok.status_code == 200
    assert ok.json()["status"] == "success"


def test_cookie_safe_methods_do_not_require_csrf(api):
    api.register_and_login("csrf_get", "csrf-get@example.test")
    assert api.client.get("/api/user/info").status_code == 200
    assert api.client.get("/api/diaries/list").status_code == 200


def test_public_auth_endpoints_are_csrf_exempt(api):
    assert api.client.post("/api/login", data={"account": "missing@example.test", "password": "Password123"}).status_code == 200
    assert api.client.post(
        "/api/register",
        data={"username": "csrf_public", "email": "csrf-public@example.test", "password": "Password123", "code": "bad"},
    ).status_code == 200
    assert api.client.post("/api/send_code", data={"email": "none@example.test", "action_type": "reset"}).status_code == 200
    assert api.client.post(
        "/api/reset_password",
        data={"email": "none@example.test", "new_password": "Password123", "code": "bad"},
    ).status_code == 200


def test_logout_clears_cookies_with_development_compatibility(api):
    api.register_and_login("csrf_logout", "csrf-logout@example.test")
    response = api.client.post("/api/logout")
    assert response.status_code == 200
    assert response.json()["status"] == "success"


def test_cookie_sync_snapshot_requires_csrf_but_bearer_stays_compatible(api):
    token = api.register_and_login("csrf_sync", "csrf-sync@example.test")

    bearer = api.client.post("/api/sync/snapshot", headers=api.auth(token), json=encrypted_snapshot(snapshot_name="bearer"))
    assert bearer.status_code == 200
    assert bearer.json()["status"] == "success"

    missing = api.client.post("/api/sync/snapshot", json=encrypted_snapshot(snapshot_name="missing csrf"))
    assert missing.status_code == 403

    ok = api.client.post(
        "/api/sync/snapshot",
        headers=csrf_header(api),
        json=encrypted_snapshot(snapshot_name="cookie csrf"),
    )
    assert ok.status_code == 200
    assert ok.json()["status"] == "success"
