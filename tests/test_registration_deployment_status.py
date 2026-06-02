import routers.auth as auth_module
import core.config as config_module


def registration_payload(username: str, email: str, invite_code: str | None = None) -> dict[str, str]:
    data = {
        "username": username,
        "password": "Password123",
        "email": email,
        "code": "123456",
    }
    if invite_code is not None:
        data["invite_code"] = invite_code
    return data


def test_open_registration_mode_allows_existing_register_flow(api, monkeypatch):
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "open")
    api.add_code("open-mode@example.test")

    response = api.client.post(
        "/api/register",
        data=registration_payload("open_mode_user", "open-mode@example.test"),
    )

    assert response.status_code == 200
    assert response.json()["status"] == "success"


def test_invite_registration_requires_invite_code(api, monkeypatch):
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "invite")
    monkeypatch.setattr(auth_module, "REGISTRATION_INVITE_CODE", "leaf-invite")
    api.add_code("invite-missing@example.test")

    response = api.client.post(
        "/api/register",
        data=registration_payload("invite_missing_user", "invite-missing@example.test"),
    )

    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "error"
    assert "leaf-invite" not in str(body)


def test_invite_registration_rejects_wrong_invite_code(api, monkeypatch):
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "invite")
    monkeypatch.setattr(auth_module, "REGISTRATION_INVITE_CODE", "leaf-invite")
    api.add_code("invite-wrong@example.test")

    response = api.client.post(
        "/api/register",
        data=registration_payload("invite_wrong_user", "invite-wrong@example.test", invite_code="wrong-code"),
    )

    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "error"
    assert "leaf-invite" not in str(body)


def test_invite_registration_accepts_correct_invite_code(api, monkeypatch):
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "invite")
    monkeypatch.setattr(auth_module, "REGISTRATION_INVITE_CODE", "leaf-invite")
    api.add_code("invite-ok@example.test")

    response = api.client.post(
        "/api/register",
        data=registration_payload("invite_ok_user", "invite-ok@example.test", invite_code="leaf-invite"),
    )

    assert response.status_code == 200
    assert response.json()["status"] == "success"


def test_invite_registration_rejects_email_like_username_with_field_detail(api, monkeypatch):
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "invite")
    monkeypatch.setattr(auth_module, "REGISTRATION_INVITE_CODE", "leaf-invite")
    api.add_code("invite-email-username@example.test")

    response = api.client.post(
        "/api/register",
        data=registration_payload("131179835@qq.com", "invite-email-username@example.test", invite_code="leaf-invite"),
    )

    assert response.status_code == 422
    body = response.json()
    assert body["detail"]["field"] == "username"
    assert body["detail"]["code"] == "username_invalid_format"
    assert "leaf-invite" not in str(body)


def test_invite_registration_rejects_invalid_email_format(api, monkeypatch):
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "invite")
    monkeypatch.setattr(auth_module, "REGISTRATION_INVITE_CODE", "leaf-invite")
    api.add_code("not-an-email")

    response = api.client.post(
        "/api/register",
        data=registration_payload("invite_bad_email", "not-an-email", invite_code="leaf-invite"),
    )

    assert response.status_code == 422
    assert "leaf-invite" not in str(response.json())


def test_closed_registration_mode_rejects_new_users(api, monkeypatch):
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "closed")
    api.add_code("closed-mode@example.test")

    response = api.client.post(
        "/api/register",
        data=registration_payload("closed_mode_user", "closed-mode@example.test"),
    )

    assert response.status_code == 200
    assert response.json()["status"] == "error"


def test_login_is_not_affected_by_registration_mode(api, monkeypatch):
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "open")
    token = api.register_and_login("existing_login_user", "existing-login@example.test")
    assert token

    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "closed")
    login_response = api.client.post(
        "/api/login",
        data={"account": "existing-login@example.test", "password": "Password123"},
    )

    assert login_response.status_code == 200
    body = login_response.json()
    assert body["status"] == "success"
    assert body["token"]


def test_deployment_status_returns_public_summary_without_secrets(api, monkeypatch):
    monkeypatch.setattr(auth_module, "DEPLOYMENT_MODE", "public")
    monkeypatch.setattr(auth_module, "ENVIRONMENT", "production")
    monkeypatch.setattr(auth_module, "REGISTRATION_MODE", "invite")
    monkeypatch.setattr(auth_module, "FORCE_HTTPS", True)
    monkeypatch.setattr(auth_module, "COOKIE_SECURE", True)
    monkeypatch.setattr(config_module, "SERVER_UPLOAD_ENABLED", True)
    monkeypatch.setattr(config_module, "DEMO_SERVER_UPLOAD_ENABLED", False)

    response = api.client.get("/api/deployment/status")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "success"
    assert body["deployment_mode"] == "public"
    assert body["environment"] == "production"
    assert body["registration_mode"] == "invite"
    assert body["registration_requires_invite"] is True
    assert body["cookie_secure_required"] is True
    assert body["https_required"] is True
    assert isinstance(body["max_upload_size_mb"], int)
    assert isinstance(body["max_cloud_snapshots_per_user"], int)
    assert body["demo_server_upload_enabled"] is False
    assert body["server_upload_enabled"] is True
    serialized = str(body)
    for forbidden in (
        "SECRET_KEY",
        "REGISTRATION_INVITE_CODE",
        "AI_API_KEY",
        "SENDER_PASSWORD",
        "DATABASE_PATH",
        "UPLOAD_DIR",
        "leaf-invite",
    ):
        assert forbidden not in serialized


def test_deployment_status_reflects_demo_server_upload_enabled_true_in_lan_development(api, monkeypatch):
    monkeypatch.setattr(auth_module, "DEPLOYMENT_MODE", "lan")
    monkeypatch.setattr(auth_module, "ENVIRONMENT", "development")
    monkeypatch.setattr(config_module, "SERVER_UPLOAD_ENABLED", True)
    monkeypatch.setattr(config_module, "DEMO_SERVER_UPLOAD_ENABLED", True)

    response = api.client.get("/api/deployment/status")

    assert response.status_code == 200
    body = response.json()
    assert body["deployment_mode"] == "lan"
    assert body["environment"] == "development"
    assert body["demo_server_upload_enabled"] is True
    assert body["server_upload_enabled"] is True


def test_deployment_status_reflects_demo_server_upload_enabled_false(api, monkeypatch):
    monkeypatch.setattr(auth_module, "DEPLOYMENT_MODE", "lan")
    monkeypatch.setattr(auth_module, "ENVIRONMENT", "development")
    monkeypatch.setattr(config_module, "SERVER_UPLOAD_ENABLED", True)
    monkeypatch.setattr(config_module, "DEMO_SERVER_UPLOAD_ENABLED", False)

    response = api.client.get("/api/deployment/status")

    assert response.status_code == 200
    body = response.json()
    assert body["demo_server_upload_enabled"] is False
    assert body["server_upload_enabled"] is True


def test_deployment_status_reflects_server_upload_enabled_false_independent_of_demo(api, monkeypatch):
    monkeypatch.setattr(auth_module, "DEPLOYMENT_MODE", "lan")
    monkeypatch.setattr(auth_module, "ENVIRONMENT", "development")
    monkeypatch.setattr(config_module, "SERVER_UPLOAD_ENABLED", False)
    monkeypatch.setattr(config_module, "DEMO_SERVER_UPLOAD_ENABLED", True)

    response = api.client.get("/api/deployment/status")

    assert response.status_code == 200
    body = response.json()
    assert body["server_upload_enabled"] is False
    assert body["demo_server_upload_enabled"] is True


def test_deployment_status_boolean_parser_accepts_common_values():
    for value in ("true", "True", "TRUE", "1", "yes", "on"):
        assert config_module.parse_bool(value, False) is True
    for value in ("false", "False", "FALSE", "0", "no", "off"):
        assert config_module.parse_bool(value, True) is False
