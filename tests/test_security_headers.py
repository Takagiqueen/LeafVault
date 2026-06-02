def test_homepage_returns_security_headers(api):
    response = api.client.get("/")
    assert response.status_code == 200
    csp = response.headers.get("Content-Security-Policy") or response.headers.get("Content-Security-Policy-Report-Only")
    assert csp
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert response.headers["X-Frame-Options"] == "DENY" or "frame-ancestors 'none'" in csp
    assert response.headers["Permissions-Policy"]
    assert "unsafe-eval" not in csp
    assert "default-src *" not in csp
    assert "script-src *" not in csp
    assert "script-src 'self' 'unsafe-inline'" in csp
    assert "style-src 'self' 'unsafe-inline'" in csp
    assert "script-src 'self' unsafe-inline" not in csp
    assert "style-src 'self' unsafe-inline" not in csp


def test_health_returns_security_headers(api):
    response = api.client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    csp = response.headers.get("Content-Security-Policy") or response.headers.get("Content-Security-Policy-Report-Only")
    assert csp
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "unsafe-eval" not in csp
    assert "default-src *" not in csp
    assert "script-src *" not in csp
    assert "script-src 'self' 'unsafe-inline'" in csp
    assert "style-src 'self' 'unsafe-inline'" in csp
    assert "script-src 'self' unsafe-inline" not in csp
    assert "style-src 'self' unsafe-inline" not in csp


def test_csp_source_normalization_quotes_keywords():
    from core.security_headers import normalize_csp_sources

    assert normalize_csp_sources(["self", "unsafe-inline", "none", "data:", "https://api.example.test"]) == [
        "'self'",
        "'unsafe-inline'",
        "'none'",
        "data:",
        "https://api.example.test",
    ]


def test_api_errors_do_not_return_tracebacks_or_sensitive_debug_info(api):
    unauth = api.client.get("/api/user/info")
    body = unauth.text
    assert "Traceback" not in body
    assert "DIARY_IMAGE_DEBUG" not in body
    assert "SECRET_KEY" not in body

    token = api.register_and_login("headers_user", "headers-user@example.test")
    invalid = api.client.get("/api/sync/changes?entity_type=profile", headers=api.auth(token))
    assert invalid.status_code == 422
    assert "Traceback" not in invalid.text
    assert "encrypted_change" not in invalid.text
