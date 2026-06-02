from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from core.config import CSRF_COOKIE_NAME, CSRF_HEADER_NAME
from core.csrf import (
    get_csrf_token_from_cookie,
    get_csrf_token_from_header,
    require_csrf_token,
    verify_csrf_token,
)


def request_with(cookie_value="", header_value=""):
    return SimpleNamespace(
        cookies={CSRF_COOKIE_NAME: cookie_value} if cookie_value else {},
        headers={CSRF_HEADER_NAME: header_value} if header_value else {},
    )


def test_csrf_helpers_read_cookie_and_header_tokens():
    request = request_with("cookie-token", "header-token")
    assert get_csrf_token_from_cookie(request) == "cookie-token"
    assert get_csrf_token_from_header(request) == "header-token"


def test_csrf_verify_requires_matching_tokens():
    assert verify_csrf_token(request_with("same", "same")) is True
    assert verify_csrf_token(request_with("cookie", "header")) is False
    assert verify_csrf_token(request_with("cookie", "")) is False


def test_csrf_require_raises_expected_exception_for_mismatch():
    with pytest.raises(HTTPException) as exc:
        require_csrf_token(request_with("cookie", "header"))
    assert exc.value.status_code == 403


def test_existing_mutating_endpoints_are_not_forced_to_csrf_yet(api):
    token = api.register_and_login("csrf_compat", "csrf-compat@example.test")
    response = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-05-25", "mood_label": "happy", "content": "csrf remains staged"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
