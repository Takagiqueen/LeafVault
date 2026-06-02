import logging
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_csv(value: str | None, default: list[str] | None = None) -> list[str]:
    if value is None or value.strip() == "":
        return list(default or [])
    return [item.strip() for item in value.split(",") if item.strip()]


def parse_allowed_origins(value: str | None, environment: str) -> list[str]:
    defaults = ["http://localhost:8000", "http://127.0.0.1:8000"] if environment != "production" else []
    return parse_csv(value, defaults)


def parse_trusted_hosts(value: str | None, environment: str) -> list[str]:
    defaults = ["localhost", "127.0.0.1", "testserver"] if environment != "production" else []
    return parse_csv(value, defaults)


def parse_registration_mode(value: str | None, environment: str) -> str:
    mode = (value or ("invite" if environment == "production" else "open")).strip().lower()
    if mode not in {"open", "invite", "closed"}:
        raise RuntimeError("REGISTRATION_MODE must be one of: open, invite, closed.")
    return mode


def validate_production_config(
    *,
    environment: str,
    secret_key: str | None,
    allowed_origins: list[str],
    trusted_hosts: list[str] | None = None,
    database_path_value: str | None,
    upload_dir_value: str | None,
    csp_mode: str | None,
    public_base_url: str | None = None,
    cookie_secure: bool = False,
) -> None:
    if environment != "production":
        return
    if not secret_key:
        raise RuntimeError("SECRET_KEY must be set in production.")
    weak_values = {"change-me", "change-me-use-a-long-random-string", "secret", "test-secret"}
    if secret_key.strip().lower() in weak_values or len(secret_key) < 32:
        raise RuntimeError("SECRET_KEY is too weak for production; use a long random string.")
    if "*" in allowed_origins:
        raise RuntimeError("ALLOWED_ORIGINS cannot be '*' in production.")
    if not public_base_url or not public_base_url.startswith("https://"):
        raise RuntimeError("PUBLIC_BASE_URL must start with https:// in production.")
    parsed_public_url = urlparse(public_base_url)
    if not parsed_public_url.netloc:
        raise RuntimeError("PUBLIC_BASE_URL must include a public host in production.")
    effective_trusted_hosts = trusted_hosts or []
    if not effective_trusted_hosts or "*" in effective_trusted_hosts:
        raise RuntimeError("TRUSTED_HOSTS cannot be empty or '*' in production.")
    if not cookie_secure:
        raise RuntimeError("COOKIE_SECURE must be true in production.")
    if not csp_mode:
        raise RuntimeError("CSP_MODE must be set in production.")
    if not database_path_value:
        raise RuntimeError("DATABASE_PATH must be set in production.")
    if not upload_dir_value:
        raise RuntimeError("UPLOAD_DIR must be set in production.")


logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("LeafVault")

load_dotenv()

SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.qq.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", 465))
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "")
SENDER_PASSWORD = os.getenv("SENDER_PASSWORD", "")

BASE_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
ENVIRONMENT = os.getenv("ENVIRONMENT", "development").strip().lower()
DEPLOYMENT_MODE = os.getenv("DEPLOYMENT_MODE", "local").strip().lower()
if DEPLOYMENT_MODE not in {"local", "lan", "public"}:
    raise RuntimeError("DEPLOYMENT_MODE must be one of: local, lan, public.")
LEAFVAULT_DOMAIN = os.getenv("LEAFVAULT_DOMAIN", "").strip()
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip()
FORCE_HTTPS = parse_bool(os.getenv("FORCE_HTTPS"), ENVIRONMENT == "production")
REGISTRATION_MODE = parse_registration_mode(os.getenv("REGISTRATION_MODE"), ENVIRONMENT)
REGISTRATION_INVITE_CODE = os.getenv("REGISTRATION_INVITE_CODE", "")
DATABASE_PATH_VALUE = os.getenv("DATABASE_PATH")
UPLOAD_DIR_VALUE = os.getenv("UPLOAD_DIR")
DB_PATH = Path(DATABASE_PATH_VALUE or str(BASE_DIR / "data.db")).expanduser()
UPLOAD_DIR = Path(UPLOAD_DIR_VALUE or str(BASE_DIR / "uploads")).expanduser()
IMAGES_DIR = UPLOAD_DIR
SECURITY_HEADERS_ENABLED = parse_bool(os.getenv("SECURITY_HEADERS_ENABLED"), True)
CSP_MODE = os.getenv("CSP_MODE") or ("strict" if ENVIRONMENT == "production" else "dev")
if CSP_MODE not in {"dev", "strict", "report-only"}:
    raise RuntimeError("CSP_MODE must be one of: dev, strict, report-only.")
CSP_REPORT_ONLY = parse_bool(os.getenv("CSP_REPORT_ONLY"), False)
CSP_LOCAL_VENDOR_ONLY = parse_bool(os.getenv("CSP_LOCAL_VENDOR_ONLY"), ENVIRONMENT == "production")
CSP_ALLOWED_SCRIPT_SRC = parse_csv(
    os.getenv("CSP_ALLOWED_SCRIPT_SRC"),
    ["'unsafe-inline'"] if CSP_LOCAL_VENDOR_ONLY else ["'unsafe-inline'", "cdn.jsdelivr.net"],
)
CSP_ALLOWED_STYLE_SRC = parse_csv(
    os.getenv("CSP_ALLOWED_STYLE_SRC"),
    ["'unsafe-inline'"],
)
ALLOWED_ORIGINS = parse_allowed_origins(os.getenv("ALLOWED_ORIGINS"), ENVIRONMENT)
TRUSTED_HOSTS = parse_trusted_hosts(os.getenv("TRUSTED_HOSTS"), ENVIRONMENT)
AUTH_TOKEN_TRANSPORT = os.getenv(
    "AUTH_TOKEN_TRANSPORT",
    "dual" if ENVIRONMENT != "production" else "dual",
).strip().lower()
if AUTH_TOKEN_TRANSPORT not in {"bearer", "cookie", "dual"}:
    raise RuntimeError("AUTH_TOKEN_TRANSPORT must be one of: bearer, cookie, dual.")
AUTH_PREFER_COOKIE = parse_bool(os.getenv("AUTH_PREFER_COOKIE"), ENVIRONMENT == "production")
AUTH_LOCALSTORAGE_TOKEN_COMPAT = parse_bool(os.getenv("AUTH_LOCALSTORAGE_TOKEN_COMPAT"), True)
AUTH_COOKIE_SESSION_CHECK_ENABLED = parse_bool(os.getenv("AUTH_COOKIE_SESSION_CHECK_ENABLED"), True)
AUTH_LOCALSTORAGE_DEPRECATION_WARNING = parse_bool(
    os.getenv("AUTH_LOCALSTORAGE_DEPRECATION_WARNING"),
    ENVIRONMENT != "production",
)
AUTH_STORE_TOKEN_IN_LOCALSTORAGE = parse_bool(
    os.getenv("AUTH_STORE_TOKEN_IN_LOCALSTORAGE"),
    ENVIRONMENT != "production",
)
AUTH_ALLOW_BEARER_FALLBACK = parse_bool(os.getenv("AUTH_ALLOW_BEARER_FALLBACK"), True)
AUTH_COOKIE_REQUIRED_IN_PRODUCTION = parse_bool(os.getenv("AUTH_COOKIE_REQUIRED_IN_PRODUCTION"), False)
AUTH_COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "leafvault_access_token")
CSRF_COOKIE_NAME = os.getenv("CSRF_COOKIE_NAME", "leafvault_csrf_token")
CSRF_HEADER_NAME = os.getenv("CSRF_HEADER_NAME", "X-CSRF-Token")
CSRF_PROTECTION_ENABLED = parse_bool(os.getenv("CSRF_PROTECTION_ENABLED"), True)
CSRF_ENFORCE_FOR_COOKIE_AUTH = parse_bool(os.getenv("CSRF_ENFORCE_FOR_COOKIE_AUTH"), True)
CSRF_EXEMPT_PATHS = parse_csv(
    os.getenv("CSRF_EXEMPT_PATHS"),
    [
        "/api/login",
        "/api/register",
        "/api/send_code",
        "/api/reset_password",
        "/api/health",
        "/",
        "/static",
        "/favicon.ico",
        "/manifest.json",
    ],
)
CSRF_SAFE_METHODS = {method.upper() for method in parse_csv(os.getenv("CSRF_SAFE_METHODS"), ["GET", "HEAD", "OPTIONS"])}
CSRF_ALLOW_LOGOUT_WITHOUT_TOKEN = parse_bool(os.getenv("CSRF_ALLOW_LOGOUT_WITHOUT_TOKEN"), ENVIRONMENT != "production")
COOKIE_SECURE = parse_bool(os.getenv("COOKIE_SECURE"), ENVIRONMENT == "production")
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax").strip().lower()
if COOKIE_SAMESITE not in {"strict", "lax", "none"}:
    raise RuntimeError("COOKIE_SAMESITE must be one of: strict, lax, none.")
if COOKIE_SAMESITE == "none" and not COOKIE_SECURE:
    raise RuntimeError("COOKIE_SAMESITE=none requires COOKIE_SECURE=true.")

SECRET_KEY = os.getenv("SECRET_KEY")
validate_production_config(
    environment=ENVIRONMENT,
    secret_key=SECRET_KEY,
    allowed_origins=ALLOWED_ORIGINS,
    trusted_hosts=TRUSTED_HOSTS,
    database_path_value=DATABASE_PATH_VALUE,
    upload_dir_value=UPLOAD_DIR_VALUE,
    csp_mode=CSP_MODE,
    public_base_url=PUBLIC_BASE_URL,
    cookie_secure=COOKIE_SECURE,
)
if not SECRET_KEY:
    logger.warning("SECRET_KEY 未配置，正在使用临时随机密钥；服务重启后所有登录态都会失效。")
    SECRET_KEY = secrets.token_hex(32)

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = int(os.getenv("ACCESS_TOKEN_EXPIRE_DAYS", 30))
COOKIE_MAX_AGE_SECONDS = int(os.getenv("COOKIE_MAX_AGE_SECONDS", ACCESS_TOKEN_EXPIRE_DAYS * 24 * 60 * 60))
ALLOWED_IMAGE_SUFFIXES = {
    f".{ext.lower().lstrip('.')}"
    for ext in parse_csv(os.getenv("ALLOWED_IMAGE_EXTENSIONS"), ["jpg", "jpeg", "png", "webp", "gif"])
}
ALLOWED_IMAGE_SUFFIXES.discard(".svg")
ALLOWED_IMAGE_MIME_TYPES = set(
    parse_csv(os.getenv("ALLOWED_IMAGE_MIME_TYPES"), ["image/jpeg", "image/png", "image/webp", "image/gif"])
)
ALLOWED_IMAGE_MIME_TYPES.discard("image/svg+xml")
MAX_UPLOAD_SIZE_MB = int(os.getenv("MAX_UPLOAD_SIZE_MB", 10))
MAX_IMAGE_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024
MAX_DIARY_IMAGES_PER_ENTRY = int(os.getenv("MAX_DIARY_IMAGES_PER_ENTRY", 9))
MAX_CLOUD_SNAPSHOTS_PER_USER = int(os.getenv("MAX_CLOUD_SNAPSHOTS_PER_USER", 5))
MAX_SYNC_BATCH_SIZE = int(os.getenv("MAX_SYNC_BATCH_SIZE", 100))
MAX_CLOUD_SNAPSHOT_PAYLOAD_MB = int(os.getenv("MAX_CLOUD_SNAPSHOT_PAYLOAD_MB", 100))
MAX_CLOUD_SNAPSHOT_PAYLOAD_BYTES = MAX_CLOUD_SNAPSHOT_PAYLOAD_MB * 1024 * 1024
MAX_SYNC_CHANGE_PAYLOAD_KB = int(os.getenv("MAX_SYNC_CHANGE_PAYLOAD_KB", 512))
MAX_SYNC_CHANGE_PAYLOAD_BYTES = MAX_SYNC_CHANGE_PAYLOAD_KB * 1024
DEMO_SERVER_UPLOAD_ENABLED = parse_bool(os.getenv("DEMO_SERVER_UPLOAD_ENABLED"), False)
# SERVER_UPLOAD_ENABLED 控制正式账号是否允许使用服务器上传能力。
# 兼容旧环境：如果未显式配置 SERVER_UPLOAD_ENABLED，则沿用旧的 DEMO_SERVER_UPLOAD_ENABLED 值。
SERVER_UPLOAD_ENABLED = parse_bool(os.getenv("SERVER_UPLOAD_ENABLED"), DEMO_SERVER_UPLOAD_ENABLED)
MAX_DIARY_CONTENT_LEN = 10_000
ADMIN_INIT_PASSWORD = os.getenv("ADMIN_INIT_PASSWORD", secrets.token_urlsafe(16))
AI_API_KEY = os.getenv("AI_API_KEY", "")
AI_BASE_URL = os.getenv("AI_BASE_URL", "https://api.deepseek.com")
VALID_MODELS = {
    # 极速模式：便宜、快，适合普通日记润色
    "chat": "deepseek-v4-flash",

    # 深度模式：调用 Pro，适合更细腻、更高质量的文案优化
    "reason": "deepseek-v4-pro",
}
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
PERIOD_RE = re.compile(r"^\d{4}-\d{2}$")

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
