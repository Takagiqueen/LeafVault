def test_register_login_wrong_password_and_protected_routes(api):
    token = api.register_and_login("auth_alice", "auth-alice@example.test")

    assert api.client.get("/api/user/info", headers=api.auth(token)).json()["status"] == "success"

    wrong = api.client.post("/api/login", data={"account": "auth-alice@example.test", "password": "badpass123"})
    assert wrong.status_code == 200
    assert wrong.json()["status"] == "error"

    api.client.cookies.clear()
    unauth = api.client.get("/api/user/info")
    assert unauth.status_code in (401, 403)


def test_jwt_sub_uses_user_id_and_username_change_keeps_data_owner(api):
    token = api.register_and_login("auth_owner", "auth-owner@example.test")
    user_id = api.user_id(token)
    assert api.token_subject(token) == user_id

    create = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-05-21", "mood_label": "happy", "content": "owned by stable user_id"},
    )
    assert create.json()["status"] == "success"

    rename = api.client.post(
        "/api/user/username",
        headers=api.auth(token),
        data={"new_username": "auth_owner_new", "current_password": "Password123"},
    )
    assert rename.status_code == 200
    assert rename.json()["status"] == "success"
    new_token = rename.json()["token"]
    assert api.token_subject(new_token) == user_id

    diaries = api.client.get("/api/diaries/list", headers=api.auth(new_token)).json()["data"]
    assert len(diaries) == 1
    assert diaries[0]["content"] == "owned by stable user_id"


def test_user_a_cannot_read_user_b_profile_or_business_data(api):
    token_a = api.register_and_login("auth_a", "auth-a@example.test")
    token_b = api.register_and_login("auth_b", "auth-b@example.test")

    api.client.post(
        "/api/diaries/",
        headers=api.auth(token_b),
        data={"date": "2026-05-22", "mood_label": "happy", "content": "bob private diary"},
    )
    api.client.post(
        "/api/ledgers/",
        headers=api.auth(token_b),
        data={"type": "expense", "amount": "42", "category": "private", "note": "bob note", "date": "2026-05-22", "uuid": "bob-ledger-1"},
    )

    profile_a = api.client.get("/api/user/info", headers=api.auth(token_a)).json()["data"]
    profile_b = api.client.get("/api/user/info", headers=api.auth(token_b)).json()["data"]
    assert profile_a["user_id"] != profile_b["user_id"]
    assert profile_a["email"] != profile_b["email"]

    assert api.client.get("/api/diaries/list", headers=api.auth(token_a)).json()["data"] == []
    assert api.client.get("/api/ledgers/list", headers=api.auth(token_a)).json()["data"] == []
