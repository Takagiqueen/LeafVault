from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from core.config import (
    ACCESS_TOKEN_EXPIRE_DAYS,
    ALGORITHM,
    AUTH_ALLOW_BEARER_FALLBACK,
    AUTH_COOKIE_NAME,
    AUTH_TOKEN_TRANSPORT,
    SECRET_KEY,
)


security = HTTPBearer(auto_error=False)


def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def _decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid credentials")
        return user_id
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Login expired, please sign in again")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid credentials")


def _bearer_auth_allowed() -> bool:
    return AUTH_TOKEN_TRANSPORT in {"bearer", "dual"} or AUTH_ALLOW_BEARER_FALLBACK


def _cookie_auth_allowed() -> bool:
    return AUTH_TOKEN_TRANSPORT in {"cookie", "dual"}


def _token_candidates(bearer_token: str, cookie_token: str) -> list[tuple[str, str]]:
    if AUTH_TOKEN_TRANSPORT == "bearer":
        candidates = [("bearer", bearer_token)]
        if _cookie_auth_allowed():
            candidates.append(("cookie", cookie_token))
    elif AUTH_TOKEN_TRANSPORT == "cookie":
        candidates = [("cookie", cookie_token)]
        if _bearer_auth_allowed():
            candidates.append(("bearer", bearer_token))
    else:
        candidates = [("bearer", bearer_token), ("cookie", cookie_token)]
    return [(source, token) for source, token in candidates if token]


def verify_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Security(security),
) -> str:
    bearer_token = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else ""
    cookie_token = request.cookies.get(AUTH_COOKIE_NAME, "")

    candidates = _token_candidates(bearer_token, cookie_token)
    if not candidates:
        raise HTTPException(status_code=401, detail="Not authenticated")
    last_error: HTTPException | None = None
    for auth_source, token in candidates:
        try:
            user_id = _decode_token(token)
            request.state.auth_source = auth_source
            return user_id
        except HTTPException as exc:
            last_error = exc
            continue
    raise last_error or HTTPException(status_code=401, detail="Invalid credentials")


def get_optional_token_identity(request: Request) -> tuple[str, str]:
    auth_header = request.headers.get("Authorization", "").strip()
    bearer_token = ""
    if auth_header.lower().startswith("bearer "):
        bearer_token = auth_header.split(" ", 1)[1].strip()
    cookie_token = request.cookies.get(AUTH_COOKIE_NAME, "")

    for source, token in _token_candidates(bearer_token, cookie_token):
        try:
            return _decode_token(token), source
        except HTTPException:
            continue
    return "", ""
