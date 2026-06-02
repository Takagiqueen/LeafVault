from datetime import datetime, timedelta, timezone

import jwt

from core.config import ALGORITHM, AUTH_COOKIE_NAME, SECRET_KEY


def test_login_response_still_returns_token_and_bearer_works_for_core_apis(api):
    token = api.register_and_login("compat_login", "compat-login@example.test")
    assert token

    diary = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-05-23", "mood_label": "happy", "content": "bearer diary still works"},
    )
    assert diary.status_code == 200
    assert diary.json()["status"] == "success"

    ledger = api.client.post(
        "/api/ledgers/",
        headers=api.auth(token),
        data={"type": "expense", "amount": "9.9", "category": "food", "note": "bearer ledger", "date": "2026-05-23", "uuid": "compat-ledger-1"},
    )
    assert ledger.status_code == 200
    assert ledger.json()["status"] == "success"


def test_username_change_keeps_cookie_identity_based_on_user_id(api):
    token = api.register_and_login("compat_owner", "compat-owner@example.test")
    user_id = api.user_id(token)

    rename = api.client.post(
        "/api/user/username",
        headers=api.auth(token),
        data={"new_username": "compat_owner_new", "current_password": "Password123"},
    )
    assert rename.status_code == 200
    assert rename.json()["status"] == "success"

    cookie_user = api.client.get("/api/user/info").json()["data"]
    assert cookie_user["user_id"] == user_id
    assert cookie_user["username"] == "compat_owner_new"


def test_user_a_cookie_cannot_access_user_b_data(api):
    token_a = api.register_and_login("cookie_scope_a", "cookie-scope-a@example.test")
    api.client.post(
        "/api/diaries/",
        headers=api.auth(token_a),
        data={"date": "2026-05-24", "mood_label": "happy", "content": "alice cookie diary"},
    )
    api.client.cookies.clear()

    token_b = api.register_and_login("cookie_scope_b", "cookie-scope-b@example.test")
    assert api.user_id(token_a) != api.user_id(token_b)

    diaries_for_b_cookie = api.client.get("/api/diaries/list").json()["data"]
    assert diaries_for_b_cookie == []


def test_expired_cookie_token_is_rejected(api):
    token = api.register_and_login("expired_cookie", "expired-cookie@example.test")
    user_id = api.user_id(token)
    expired = jwt.encode(
        {"sub": user_id, "exp": datetime.now(timezone.utc) - timedelta(minutes=1)},
        SECRET_KEY,
        algorithm=ALGORITHM,
    )
    api.client.cookies.clear()
    api.client.cookies.set(AUTH_COOKIE_NAME, expired)
    response = api.client.get("/api/user/info")
    assert response.status_code == 401
