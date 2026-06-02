from core.verification import _hash_code
import routers.auth as auth_module


def latest_code_hash(api, email: str, action_type: str):
    conn = api.connect()
    row = conn.execute(
        "SELECT code_hash FROM verification_codes WHERE email = ? AND action_type = ? ORDER BY id DESC LIMIT 1",
        (email, action_type),
    ).fetchone()
    conn.close()
    return row["code_hash"] if row else None


def test_development_empty_email_config_uses_local_register_code(api, monkeypatch):
    monkeypatch.setattr(auth_module, "ENVIRONMENT", "development")
    monkeypatch.setattr(auth_module, "SENDER_EMAIL", "")
    monkeypatch.setattr(auth_module, "SENDER_PASSWORD", "")

    def fail_if_called(*args, **kwargs):
        raise AssertionError("SMTP must not be called in local development code mode")

    monkeypatch.setattr(auth_module, "send_email_code", fail_if_called)

    email = "dev-code@example.test"
    response = api.client.post("/api/send_code", data={"email": email, "action_type": "register"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "success"
    assert body["message"] == "本地开发模式验证码为 123456"
    assert latest_code_hash(api, email, "register") == _hash_code("123456", "register")


def test_development_empty_email_config_allows_reset_with_local_code(api, monkeypatch):
    email = "dev-reset@example.test"
    api.register_and_login("dev_reset_user", email)
    monkeypatch.setattr(auth_module, "ENVIRONMENT", "development")
    monkeypatch.setattr(auth_module, "SENDER_EMAIL", "")
    monkeypatch.setattr(auth_module, "SENDER_PASSWORD", "")
    monkeypatch.setattr(
        auth_module,
        "send_email_code",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("SMTP must not be called")),
    )

    send_response = api.client.post("/api/send_code", data={"email": email, "action_type": "reset"})
    assert send_response.status_code == 200
    assert send_response.json()["message"] == "本地开发模式验证码为 123456"

    reset_response = api.client.post(
        "/api/reset_password",
        data={"email": email, "new_password": "NewPassword123", "code": "123456"},
    )
    assert reset_response.status_code == 200
    assert reset_response.json()["status"] == "success"

    login_response = api.client.post("/api/login", data={"account": email, "password": "NewPassword123"})
    assert login_response.status_code == 200
    assert login_response.json()["status"] == "success"


def test_production_empty_email_config_does_not_use_fixed_code(api, monkeypatch):
    monkeypatch.setattr(auth_module, "ENVIRONMENT", "production")
    monkeypatch.setattr(auth_module, "SENDER_EMAIL", "")
    monkeypatch.setattr(auth_module, "SENDER_PASSWORD", "")
    monkeypatch.setattr(auth_module, "send_email_code", lambda *args, **kwargs: False)

    email = "prod-code@example.test"
    response = api.client.post("/api/send_code", data={"email": email, "action_type": "register"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "error"
    assert "邮件发送失败" in body["message"]
    assert latest_code_hash(api, email, "register") is None
