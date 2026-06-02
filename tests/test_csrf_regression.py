from core.config import CSRF_COOKIE_NAME, CSRF_HEADER_NAME


def _csrf_header(api):
    return {CSRF_HEADER_NAME: api.client.cookies.get(CSRF_COOKIE_NAME)}


def test_csrf_cookie_write_matrix_and_error_shape(api):
    token = api.register_and_login("csrf_matrix", "csrf-matrix@example.test")

    bearer = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-01", "mood_label": "happy", "content": "bearer csrf compat"},
    )
    assert bearer.status_code == 200
    assert bearer.json()["status"] == "success"

    missing = api.client.post(
        "/api/diaries/",
        data={"date": "2026-06-02", "mood_label": "happy", "content": "missing csrf"},
    )
    assert missing.status_code == 403
    assert missing.headers.get("content-type", "").startswith("application/json")
    assert missing.json()["message"] == "CSRF validation failed"
    leaked = missing.text.lower()
    for forbidden in ("traceback", "leafvault_access_token", "leafvault_csrf_token", "password"):
        assert forbidden not in leaked

    wrong = api.client.post(
        "/api/diaries/",
        headers={CSRF_HEADER_NAME: "wrong"},
        data={"date": "2026-06-02", "mood_label": "happy", "content": "wrong csrf"},
    )
    assert wrong.status_code == 403

    ok = api.client.post(
        "/api/diaries/",
        headers=_csrf_header(api),
        data={"date": "2026-06-02", "mood_label": "happy", "content": "correct csrf"},
    )
    assert ok.status_code == 200
    assert ok.json()["status"] == "success"


def test_csrf_safe_and_public_routes_stay_compatible(api):
    api.register_and_login("csrf_public_reg", "csrf-public-reg@example.test")
    assert api.client.get("/api/user/info").status_code == 200
    assert api.client.get("/api/diaries/list").status_code == 200

    api.client.cookies.clear()
    assert api.client.post("/api/login", data={"account": "missing@example.test", "password": "Password123"}).status_code == 200
    assert api.client.post(
        "/api/register",
        data={"username": "csrf_open_register", "email": "csrf-open-register@example.test", "password": "Password123", "code": "bad"},
    ).status_code == 200
    assert api.client.post("/api/send_code", data={"email": "csrf-open@example.test", "action_type": "reset"}).status_code == 200
    assert api.client.post(
        "/api/reset_password",
        data={"email": "csrf-open@example.test", "new_password": "Password123", "code": "bad"},
    ).status_code == 200
