import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, Request, Response

import core.config as app_config
from core.config import (
    AUTH_ALLOW_BEARER_FALLBACK,
    AUTH_COOKIE_NAME,
    AUTH_COOKIE_SESSION_CHECK_ENABLED,
    AUTH_LOCALSTORAGE_DEPRECATION_WARNING,
    AUTH_LOCALSTORAGE_TOKEN_COMPAT,
    AUTH_PREFER_COOKIE,
    AUTH_STORE_TOKEN_IN_LOCALSTORAGE,
    AUTH_TOKEN_TRANSPORT,
    COOKIE_MAX_AGE_SECONDS,
    COOKIE_SAMESITE,
    COOKIE_SECURE,
    DEPLOYMENT_MODE,
    ENVIRONMENT,
    FORCE_HTTPS,
    MAX_CLOUD_SNAPSHOT_PAYLOAD_MB,
    MAX_CLOUD_SNAPSHOTS_PER_USER,
    MAX_SYNC_CHANGE_PAYLOAD_KB,
    MAX_UPLOAD_SIZE_MB,
    REGISTRATION_INVITE_CODE,
    REGISTRATION_MODE,
    CSRF_COOKIE_NAME,
    SENDER_EMAIL,
    SENDER_PASSWORD,
)
from core.rate_limit import limiter
from core.passwords import hash_password, verify_password
from core.tokens import create_access_token, get_optional_token_identity
from core.verification import _hash_code, verify_code
from core.validators import validate_email, validate_password, validate_username
from db.database import get_db
from services.mail_service import send_email_code

router = APIRouter()
LOCAL_DEVELOPMENT_VERIFICATION_CODE = "123456"


def normalize_email(value: str) -> str:
    return (value or "").strip().lower()


def verify_registration_access(invite_code: str | None) -> tuple[bool, str | None]:
    """校验注册资格，不返回真实邀请码，也不记录邀请码内容。"""
    if REGISTRATION_MODE == "open":
        return True, None
    if REGISTRATION_MODE == "closed":
        return False, "当前暂未开放新用户注册"
    submitted = (invite_code or "").strip()
    expected = (REGISTRATION_INVITE_CODE or "").strip()
    if not submitted:
        return False, "当前注册需要邀请码"
    if not expected or not secrets.compare_digest(submitted, expected):
        return False, "邀请码无效"
    return True, None


def should_use_local_development_code() -> bool:
    """仅在本地开发且邮件配置缺失时启用固定验证码，production 永不启用。"""
    return ENVIRONMENT == "development" and (not SENDER_EMAIL or not SENDER_PASSWORD)


def insert_verification_code(
    cursor: sqlite3.Cursor,
    email: str,
    action_type: str,
    code: str,
    expires_at: datetime,
) -> None:
    cursor.execute(
        "INSERT INTO verification_codes (email, action_type, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)",
        (email, action_type, _hash_code(code, action_type), expires_at),
    )


@router.get("/api/deployment/status")
def deployment_status():
    registration_requires_invite = REGISTRATION_MODE == "invite"
    # 部署状态只返回非敏感能力开关：
    # - SERVER_UPLOAD_ENABLED 面向正式账号服务器上传能力；
    # - DEMO_SERVER_UPLOAD_ENABLED 面向游客 Demo 是否允许占用服务器上传空间。
    server_upload_enabled = bool(app_config.SERVER_UPLOAD_ENABLED)
    demo_server_upload_enabled = bool(app_config.DEMO_SERVER_UPLOAD_ENABLED)
    return {
        "status": "success",
        "deployment_mode": DEPLOYMENT_MODE,
        "environment": ENVIRONMENT,
        "registration_mode": REGISTRATION_MODE,
        "registration_requires_invite": registration_requires_invite,
        "cookie_secure_required": ENVIRONMENT == "production" or COOKIE_SECURE,
        "https_required": FORCE_HTTPS or ENVIRONMENT == "production",
        "max_upload_size_mb": MAX_UPLOAD_SIZE_MB,
        "max_cloud_snapshots_per_user": MAX_CLOUD_SNAPSHOTS_PER_USER,
        "max_cloud_snapshot_payload_mb": MAX_CLOUD_SNAPSHOT_PAYLOAD_MB,
        "max_sync_change_payload_kb": MAX_SYNC_CHANGE_PAYLOAD_KB,
        "server_upload_enabled": server_upload_enabled,
        "demo_server_upload_enabled": demo_server_upload_enabled,
    }


@router.post("/api/send_code")
@limiter.limit("5/minute")
def send_code(
    request: Request,
    email: str = Form(...),
    action_type: str = Form(...),
    db: sqlite3.Connection = Depends(get_db),
):
    if action_type not in ("register", "reset"):
        raise HTTPException(status_code=422, detail="非法的操作类型")
    email = normalize_email(email)
    validate_email(email)
    cursor = db.cursor()
    cursor.execute("SELECT id, email FROM users WHERE email = ?", (email,))
    user_exists = cursor.fetchone()
    if action_type == "register" and user_exists and user_exists["email"] != "":
        return {"status": "error", "message": "该邮箱已被注册"}
    if action_type == "reset" and not user_exists:
        return {"status": "error", "message": "该邮箱未注册过账号"}
    cursor.execute(
        "DELETE FROM verification_codes WHERE email = ? AND expires_at < ?",
        (email, datetime.now()),
    )
    # [安全-1] 使用密码学安全随机数生成验证码
    code       = str(secrets.randbelow(900000) + 100000)
    expires_at = datetime.now() + timedelta(minutes=5)
    if should_use_local_development_code():
        code = LOCAL_DEVELOPMENT_VERIFICATION_CODE
        insert_verification_code(cursor, email, action_type, code, expires_at)
        db.commit()
        return {"status": "success", "message": "本地开发模式验证码为 123456"}
    if send_email_code(email, code, action_type):
        insert_verification_code(cursor, email, action_type, code, expires_at)
        db.commit()
        return {"status": "success", "message": "验证码已发送至邮箱，请注意查收"}
    else:
        return {"status": "error", "message": "邮件发送失败，请检查系统邮件配置"}

@router.post("/api/register")
@limiter.limit("5/minute")
def register(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    email: str = Form(...),
    code: str = Form(...),
    invite_code: str = Form(""),
    db: sqlite3.Connection = Depends(get_db),
):
    allowed, message = verify_registration_access(invite_code)
    if not allowed:
        return {"status": "error", "message": message}
    validate_username(username)
    email = normalize_email(email)
    validate_email(email)
    validate_password(password)
    cursor = db.cursor()
    cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
    if cursor.fetchone():
        return {"status": "error", "message": "账号名已被占用"}
    cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
    if cursor.fetchone():
        return {"status": "error", "message": "该邮箱已被注册"}
    if not verify_code(cursor, email, code, "register"):
        db.commit()
        return {"status": "error", "message": "验证码错误或已过期"}
    cursor.execute(
        "INSERT INTO users (user_id, username, email, password_hash) VALUES (?, ?, ?, ?)",
        (str(uuid.uuid4()), username, email, hash_password(password)),
    )
    db.commit()
    return {"status": "success", "message": "注册成功，请登录"}

@router.post("/api/login")
@limiter.limit("10/minute")
def login(
    request: Request,
    response: Response,
    account: str = Form(...),
    password: str = Form(...),
    db: sqlite3.Connection = Depends(get_db),
):
    account = normalize_email(account)
    cursor = db.cursor()
    cursor.execute(
        "SELECT id, user_id, username, password_hash FROM users WHERE email = ?",
        (account,),
    )
    user = cursor.fetchone()
    if not user or not verify_password(password, user["password_hash"]):
        return {"status": "error", "message": "账号或密码错误"}
    token = create_access_token(user["user_id"])
    if AUTH_TOKEN_TRANSPORT in {"cookie", "dual"}:
        response.set_cookie(
            key=AUTH_COOKIE_NAME,
            value=token,
            httponly=True,
            secure=COOKIE_SECURE,
            samesite=COOKIE_SAMESITE,
            max_age=COOKIE_MAX_AGE_SECONDS,
            path="/",
        )
        response.set_cookie(
            key=CSRF_COOKIE_NAME,
            value=secrets.token_urlsafe(32),
            httponly=False,
            secure=COOKIE_SECURE,
            samesite=COOKIE_SAMESITE,
            max_age=COOKIE_MAX_AGE_SECONDS,
            path="/",
        )
    cookie_session = AUTH_TOKEN_TRANSPORT in {"cookie", "dual"}
    return {
        "status": "success",
        "token": token,
        "user_id": user["user_id"],
        "message": "登录成功",
        "cookie_session": cookie_session,
        "prefer_cookie": AUTH_PREFER_COOKIE,
        "localstorage_compat": AUTH_LOCALSTORAGE_TOKEN_COMPAT,
        "localstorage_deprecation_warning": AUTH_LOCALSTORAGE_DEPRECATION_WARNING,
        "store_token_in_localstorage": AUTH_STORE_TOKEN_IN_LOCALSTORAGE,
        "bearer_fallback": AUTH_ALLOW_BEARER_FALLBACK,
    }

@router.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/", samesite=COOKIE_SAMESITE, secure=COOKIE_SECURE)
    response.delete_cookie(key=CSRF_COOKIE_NAME, path="/", samesite=COOKIE_SAMESITE, secure=COOKIE_SECURE)
    return {"status": "success", "message": "已退出登录"}


@router.get("/api/session/status")
def session_status(request: Request, db: sqlite3.Connection = Depends(get_db)):
    base = {
        "status": "success",
        "authenticated": False,
        "cookie_preferred": AUTH_PREFER_COOKIE,
        "localstorage_compat": AUTH_LOCALSTORAGE_TOKEN_COMPAT,
        "localstorage_deprecation_warning": AUTH_LOCALSTORAGE_DEPRECATION_WARNING,
        "store_token_in_localstorage": AUTH_STORE_TOKEN_IN_LOCALSTORAGE,
        "bearer_fallback": AUTH_ALLOW_BEARER_FALLBACK,
    }
    if not AUTH_COOKIE_SESSION_CHECK_ENABLED:
        return base

    user_id, auth_source = get_optional_token_identity(request)
    if not user_id:
        return base
    cursor = db.cursor()
    cursor.execute("SELECT user_id, username FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    if not user:
        return base
    request.state.auth_source = auth_source
    return {
        **base,
        "authenticated": True,
        "auth_source": auth_source,
        "user_id": user["user_id"],
        "username": user["username"],
    }


@router.post("/api/reset_password")
@limiter.limit("5/minute")
def reset_password(
    request: Request,
    email: str = Form(...),
    new_password: str = Form(...),
    code: str = Form(...),
    db: sqlite3.Connection = Depends(get_db),
):
    email = normalize_email(email)
    validate_email(email)
    validate_password(new_password)
    cursor = db.cursor()
    if not verify_code(cursor, email, code, "reset"):
        db.commit()
        return {"status": "error", "message": "验证码错误或已过期"}
    cursor.execute(
        "UPDATE users SET password_hash = ? WHERE email = ?",
        (hash_password(new_password), email),
    )
    db.commit()
    return {"status": "success", "message": "密码重置成功，请使用新密码登录"}
