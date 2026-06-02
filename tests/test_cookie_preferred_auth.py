from core.config import AUTH_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME


def encrypted_snapshot(**overrides):
    payload = {
        "version": 1,
        "app": "LeafVault",
        "kdf": "PBKDF2",
        "iterations": 310000,
        "salt": "c2FsdA==",
        "iv": "aXY=",
        "payload": "Y2lwaGVydGV4dA==",
        "created_at": "2026-05-23T12:00:00.000Z",
        "device_name": "cookie-preferred-test",
    }
    payload.update(overrides)
    return payload


def get_set_cookie_headers(response):
    try:
        return response.headers.get_list("set-cookie")
    except AttributeError:
        value = response.headers.get("set-cookie", "")
        return [value] if value else []


def csrf_header(api):
    return {CSRF_HEADER_NAME: api.client.cookies.get(CSRF_COOKIE_NAME)}


def test_cookie_preferred_login_response_and_cookie_only_user_info(api, monkeypatch):
    import routers.auth as auth_router

    monkeypatch.setattr(auth_router, "AUTH_PREFER_COOKIE", True)
    api.add_code("cookie-preferred@example.test")
    api.client.post(
        "/api/register",
        data={"username": "cookie_preferred", "email": "cookie-preferred@example.test", "password": "Password123", "code": "123456"},
    )
    response = api.client.post("/api/login", data={"account": "cookie-preferred@example.test", "password": "Password123"})
    body = response.json()
    assert body["status"] == "success"
    assert body["token"]
    assert body["prefer_cookie"] is True
    assert body["cookie_session"] is True
    assert body["localstorage_compat"] is True

    cookies = get_set_cookie_headers(response)
    assert any(item.startswith(f"{AUTH_COOKIE_NAME}=") and "HttpOnly" in item for item in cookies)
    assert any(item.startswith(f"{CSRF_COOKIE_NAME}=") and "HttpOnly" not in item for item in cookies)

    info = api.client.get("/api/user/info")
    assert info.status_code == 200
    assert info.json()["data"]["username"] == "cookie_preferred"


def test_cookie_preferred_write_requires_csrf_but_bearer_remains_compatible(api, monkeypatch):
    import routers.auth as auth_router

    monkeypatch.setattr(auth_router, "AUTH_PREFER_COOKIE", True)
    token = api.register_and_login("cookie_preferred_write", "cookie-preferred-write@example.test")

    missing = api.client.post(
        "/api/sync/snapshot",
        json=encrypted_snapshot(snapshot_name="missing csrf"),
    )
    assert missing.status_code == 403

    ok_cookie = api.client.post(
        "/api/sync/snapshot",
        headers=csrf_header(api),
        json=encrypted_snapshot(snapshot_name="cookie csrf"),
    )
    assert ok_cookie.status_code == 200
    assert ok_cookie.json()["status"] == "success"

    ok_bearer = api.client.post(
        "/api/sync/snapshot",
        headers=api.auth(token),
        json=encrypted_snapshot(snapshot_name="bearer compat"),
    )
    assert ok_bearer.status_code == 200
    assert ok_bearer.json()["status"] == "success"
