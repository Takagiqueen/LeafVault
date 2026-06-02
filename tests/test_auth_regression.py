from core.config import AUTH_COOKIE_NAME, CSRF_COOKIE_NAME


def test_auth_full_session_regression(api):
    api.add_code("auth-regression@example.test")
    register = api.client.post(
        "/api/register",
        data={
            "username": "auth_regression",
            "email": "auth-regression@example.test",
            "password": "Password123",
            "code": "123456",
        },
    )
    assert register.status_code == 200
    assert register.json()["status"] == "success"

    login = api.client.post(
        "/api/login",
        data={"account": "auth-regression@example.test", "password": "Password123"},
    )
    body = login.json()
    assert login.status_code == 200
    for field in ("status", "token", "user_id", "message"):
        assert field in body
    assert body["status"] == "success"
    assert api.client.cookies.get(AUTH_COOKIE_NAME)
    assert api.client.cookies.get(CSRF_COOKIE_NAME)
    assert "httponly" in login.headers.get("set-cookie", "").lower()

    token = body["token"]
    assert api.client.get("/api/session/status").json()["authenticated"] is True
    bearer_info = api.client.get("/api/user/info", headers=api.auth(token))
    assert bearer_info.status_code == 200

    api.client.cookies.clear()
    assert api.client.get("/api/session/status").json()["authenticated"] is False
    assert api.client.get("/api/user/info").status_code in (401, 403)

    cookie_login = api.client.post(
        "/api/login",
        data={"account": "auth-regression@example.test", "password": "Password123"},
    )
    assert cookie_login.status_code == 200
    cookie_info = api.client.get("/api/user/info")
    assert cookie_info.status_code == 200
    status = api.client.get("/api/session/status").json()
    assert status["authenticated"] is True
    assert "token" not in status
    assert "csrf" not in str(status).lower()

    logout = api.client.post("/api/logout")
    assert logout.status_code == 200
    assert "leafvault_access_token" in logout.headers.get("set-cookie", "")


def test_login_failure_does_not_leak_internal_state(api):
    api.register_and_login("auth_fail_owner", "auth-fail-owner@example.test")
    response = api.client.post(
        "/api/login",
        data={"account": "auth-fail-owner@example.test", "password": "wrong-password"},
    )
    body_text = response.text.lower()
    assert response.status_code == 200
    assert response.json()["status"] == "error"
    for forbidden in ("traceback", "secret_key", "password_hash", "leafvault_access_token"):
        assert forbidden not in body_text
