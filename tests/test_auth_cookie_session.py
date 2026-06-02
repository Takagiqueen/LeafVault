from core.config import AUTH_COOKIE_NAME, CSRF_COOKIE_NAME


def cookie_headers(response):
    try:
        return response.headers.get_list("set-cookie")
    except AttributeError:
        value = response.headers.get("set-cookie", "")
        return [value] if value else []


def test_login_sets_http_only_access_cookie_and_readable_csrf_cookie(api):
    api.add_code("cookie-login@example.test")
    api.client.post(
        "/api/register",
        data={"username": "cookie_login", "email": "cookie-login@example.test", "password": "Password123", "code": "123456"},
    )
    response = api.client.post("/api/login", data={"account": "cookie-login@example.test", "password": "Password123"})
    body = response.json()
    assert body["status"] == "success"
    assert body["token"]

    headers = cookie_headers(response)
    access_cookie = next(item for item in headers if item.startswith(f"{AUTH_COOKIE_NAME}="))
    csrf_cookie = next(item for item in headers if item.startswith(f"{CSRF_COOKIE_NAME}="))
    assert "HttpOnly" in access_cookie
    assert "SameSite=lax" in access_cookie
    assert "HttpOnly" not in csrf_cookie
    assert "SameSite=lax" in csrf_cookie


def test_secure_cookie_flag_can_be_enabled_for_production_style_cookie(api, monkeypatch):
    import routers.auth as auth_router

    monkeypatch.setattr(auth_router, "COOKIE_SECURE", True)
    api.add_code("secure-cookie@example.test")
    api.client.post(
        "/api/register",
        data={"username": "secure_cookie", "email": "secure-cookie@example.test", "password": "Password123", "code": "123456"},
    )
    response = api.client.post("/api/login", data={"account": "secure-cookie@example.test", "password": "Password123"})
    access_cookie = next(item for item in cookie_headers(response) if item.startswith(f"{AUTH_COOKIE_NAME}="))
    assert "Secure" in access_cookie


def test_bearer_and_cookie_auth_both_access_protected_route(api):
    token = api.register_and_login("cookie_auth", "cookie-auth@example.test")
    bearer = api.client.get("/api/user/info", headers=api.auth(token))
    assert bearer.status_code == 200
    assert bearer.json()["status"] == "success"

    cookie_only = api.client.get("/api/user/info")
    assert cookie_only.status_code == 200
    assert cookie_only.json()["status"] == "success"

    api.client.cookies.clear()
    no_auth = api.client.get("/api/user/info")
    assert no_auth.status_code in (401, 403)


def test_logout_clears_auth_and_csrf_cookies(api):
    api.register_and_login("logout_cookie", "logout-cookie@example.test")
    response = api.client.post("/api/logout")
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    headers = cookie_headers(response)
    assert any(item.startswith(f"{AUTH_COOKIE_NAME}=") and "Max-Age=0" in item for item in headers)
    assert any(item.startswith(f"{CSRF_COOKIE_NAME}=") and "Max-Age=0" in item for item in headers)
