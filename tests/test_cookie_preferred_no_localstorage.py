from core.config import AUTH_COOKIE_NAME, CSRF_COOKIE_NAME


def _register_user(api, username: str, email: str) -> None:
    api.add_code(email)
    response = api.client.post(
        "/api/register",
        data={"username": username, "email": email, "password": "Password123", "code": "123456"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"


def test_login_reports_no_localstorage_token_policy_when_disabled(api, monkeypatch):
    import routers.auth as auth_router

    monkeypatch.setattr(auth_router, "AUTH_PREFER_COOKIE", True)
    monkeypatch.setattr(auth_router, "AUTH_STORE_TOKEN_IN_LOCALSTORAGE", False)
    monkeypatch.setattr(auth_router, "AUTH_ALLOW_BEARER_FALLBACK", True)
    _register_user(api, "no_ls_token", "no-localstorage-token@example.test")

    response = api.client.post(
        "/api/login",
        data={"account": "no-localstorage-token@example.test", "password": "Password123"},
    )
    body = response.json()

    assert body["status"] == "success"
    assert body["token"]
    assert body["prefer_cookie"] is True
    assert body["cookie_session"] is True
    assert body["store_token_in_localstorage"] is False
    assert body["bearer_fallback"] is True
    assert api.client.cookies.get(AUTH_COOKIE_NAME)
    assert api.client.cookies.get(CSRF_COOKIE_NAME)


def test_login_reports_localstorage_token_policy_when_enabled(api, monkeypatch):
    import routers.auth as auth_router

    monkeypatch.setattr(auth_router, "AUTH_STORE_TOKEN_IN_LOCALSTORAGE", True)
    _register_user(api, "yes_ls_token", "yes-localstorage-token@example.test")

    response = api.client.post(
        "/api/login",
        data={"account": "yes-localstorage-token@example.test", "password": "Password123"},
    )
    body = response.json()

    assert body["status"] == "success"
    assert body["store_token_in_localstorage"] is True


def test_session_status_reports_storage_policy_without_token_or_csrf(api, monkeypatch):
    import routers.auth as auth_router

    monkeypatch.setattr(auth_router, "AUTH_STORE_TOKEN_IN_LOCALSTORAGE", False)
    monkeypatch.setattr(auth_router, "AUTH_ALLOW_BEARER_FALLBACK", True)
    token = api.register_and_login("session_policy", "session-policy@example.test")

    status = api.client.get("/api/session/status").json()
    assert status["authenticated"] is True
    assert status["auth_source"] == "cookie"
    assert status["store_token_in_localstorage"] is False
    assert status["bearer_fallback"] is True
    assert "token" not in status
    assert "csrf" not in str(status).lower()

    bearer_status = api.client.get("/api/session/status", headers=api.auth(token)).json()
    assert bearer_status["authenticated"] is True
    assert bearer_status["auth_source"] == "bearer"


def test_cookie_session_and_bearer_fallback_still_access_user_info(api, monkeypatch):
    import routers.auth as auth_router

    monkeypatch.setattr(auth_router, "AUTH_STORE_TOKEN_IN_LOCALSTORAGE", False)
    token = api.register_and_login("cookie_no_ls", "cookie-no-ls@example.test")

    cookie_info = api.client.get("/api/user/info")
    assert cookie_info.status_code == 200
    assert cookie_info.json()["data"]["username"] == "cookie_no_ls"

    api.client.cookies.clear()
    bearer_info = api.client.get("/api/user/info", headers=api.auth(token))
    assert bearer_info.status_code == 200
    assert bearer_info.json()["data"]["username"] == "cookie_no_ls"
