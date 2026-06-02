def test_session_status_unauthenticated_does_not_401_or_leak_tokens(api):
    response = api.client.get("/api/session/status")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "success"
    assert body["authenticated"] is False
    assert "cookie_preferred" in body
    assert "localstorage_compat" in body
    assert "token" not in body
    assert "csrf" not in str(body).lower()


def test_session_status_with_bearer_and_cookie_sources(api):
    token = api.register_and_login("session_status", "session-status@example.test")

    bearer = api.client.get("/api/session/status", headers=api.auth(token)).json()
    assert bearer["authenticated"] is True
    assert bearer["auth_source"] == "bearer"
    assert bearer["user_id"] == api.user_id(token)
    assert bearer["username"] == "session_status"
    assert "token" not in bearer

    cookie = api.client.get("/api/session/status").json()
    assert cookie["authenticated"] is True
    assert cookie["auth_source"] == "cookie"
    assert cookie["user_id"] == api.user_id(token)


def test_session_status_is_user_scoped(api):
    token_a = api.register_and_login("session_a", "session-a@example.test")
    user_a = api.user_id(token_a)
    api.client.cookies.clear()
    token_b = api.register_and_login("session_b", "session-b@example.test")
    user_b = api.user_id(token_b)

    status_b = api.client.get("/api/session/status").json()
    assert status_b["authenticated"] is True
    assert status_b["user_id"] == user_b
    assert status_b["user_id"] != user_a
    assert status_b["username"] == "session_b"
