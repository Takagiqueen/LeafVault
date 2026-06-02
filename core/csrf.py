import secrets

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from core.config import (
    AUTH_COOKIE_NAME,
    CSRF_ALLOW_LOGOUT_WITHOUT_TOKEN,
    CSRF_COOKIE_NAME,
    CSRF_ENFORCE_FOR_COOKIE_AUTH,
    CSRF_EXEMPT_PATHS,
    CSRF_HEADER_NAME,
    CSRF_PROTECTION_ENABLED,
    CSRF_SAFE_METHODS,
)


def get_csrf_token_from_cookie(request: Request) -> str:
    return request.cookies.get(CSRF_COOKIE_NAME, "")


def get_csrf_token_from_header(request: Request) -> str:
    return request.headers.get(CSRF_HEADER_NAME, "")


def has_bearer_authorization(request: Request) -> bool:
    return request.headers.get("Authorization", "").strip().lower().startswith("bearer ")


def is_csrf_exempt_path(path: str) -> bool:
    for exempt in CSRF_EXEMPT_PATHS:
        if not exempt:
            continue
        if exempt == "/":
            if path == "/":
                return True
        elif path == exempt or path.startswith(f"{exempt}/"):
            return True
    return False


def verify_csrf_token(request: Request) -> bool:
    cookie_token = get_csrf_token_from_cookie(request)
    header_token = get_csrf_token_from_header(request)
    return bool(cookie_token and header_token and secrets.compare_digest(cookie_token, header_token))


def require_csrf_token(request: Request) -> None:
    if not verify_csrf_token(request):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")


def should_validate_csrf(request: Request) -> bool:
    if not CSRF_PROTECTION_ENABLED or not CSRF_ENFORCE_FOR_COOKIE_AUTH:
        return False
    if request.method.upper() in CSRF_SAFE_METHODS:
        return False
    path = request.url.path
    if path == "/api/logout" and CSRF_ALLOW_LOGOUT_WITHOUT_TOKEN:
        return False
    if is_csrf_exempt_path(path):
        return False
    if has_bearer_authorization(request):
        return False
    if not request.cookies.get(AUTH_COOKIE_NAME):
        return False
    return True


async def csrf_protection_middleware(request: Request, call_next):
    if should_validate_csrf(request) and not verify_csrf_token(request):
        return JSONResponse(
            status_code=403,
            content={"status": "error", "message": "CSRF validation failed"},
        )
    return await call_next(request)
