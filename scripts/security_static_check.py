"""Static security baseline checks for LeafVault.

The script is intentionally local-only: no network, no Docker, no secrets file
reads. Warnings document accepted compatibility debt; errors fail the gate.
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
REGISTERED_CDN_DOMAINS = {"cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"}
LOCALIZED_VENDOR_LIBS = {
    "dompurify": {
        "cdn_markers": ["cdn.jsdelivr.net/npm/dompurify", "unpkg.com/dompurify"],
        "local_file": "static/vendor/dompurify/purify.min.js",
    },
    "marked": {
        "cdn_markers": ["cdn.jsdelivr.net/npm/marked", "unpkg.com/marked"],
        "local_file": "static/vendor/marked/marked.min.js",
    },
    "echarts": {
        "cdn_markers": ["cdn.jsdelivr.net/npm/echarts", "cdnjs.cloudflare.com/ajax/libs/echarts"],
        "local_file": "static/vendor/echarts/echarts.min.js",
    },
    "html2canvas": {
        "cdn_markers": ["cdn.jsdelivr.net/npm/html2canvas", "cdnjs.cloudflare.com/ajax/libs/html2canvas"],
        "local_file": "static/vendor/html2canvas/html2canvas.min.js",
    },
    "xlsx": {
        "cdn_markers": ["cdn.jsdelivr.net/npm/xlsx", "cdnjs.cloudflare.com/ajax/libs/xlsx"],
        "local_file": "static/vendor/xlsx/xlsx.full.min.js",
    },
}
INLINE_HANDLER_NAMES = ["onclick", "onchange", "onsubmit", "oninput", "onkeydown", "onkeyup", "onload"]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def add_if_missing(errors: list[str], source: str, needles: list[str], label: str) -> None:
    for needle in needles:
        if needle not in source:
            errors.append(f"{label} missing `{needle}`")


def count_inline_handlers(html: str) -> Counter[str]:
    counts: Counter[str] = Counter()
    for name in INLINE_HANDLER_NAMES:
        counts[name] = len(re.findall(rf"\s{name}\s*=", html, flags=re.IGNORECASE))
    return counts


def count_inline_scripts(html: str) -> int:
    total = 0
    for match in re.finditer(r"<script\b([^>]*)>", html, flags=re.IGNORECASE):
        attrs = match.group(1)
        if not re.search(r"\bsrc\s*=", attrs, flags=re.IGNORECASE):
            total += 1
    return total


def external_resource_domains(html: str) -> list[str]:
    domains: list[str] = []
    for match in re.finditer(r"""(?:src|href)\s*=\s*["'](https?://[^"']+)["']""", html, flags=re.IGNORECASE):
        host = urlparse(match.group(1)).hostname
        if host:
            domains.append(host.lower())
    return domains


def check_security_headers(errors: list[str], warnings: list[str]) -> None:
    main_py = read("main.py")
    security_headers = read("core/security_headers.py")
    combined = main_py + "\n" + security_headers
    add_if_missing(
        errors,
        combined,
        [
            "X-Content-Type-Options",
            "Referrer-Policy",
            "X-Frame-Options",
            "Content-Security-Policy",
            "Permissions-Policy",
        ],
        "security headers",
    )
    if "frame-ancestors" not in combined:
        errors.append("CSP missing frame-ancestors")
    if re.search(r"default-src\s+\*", combined):
        errors.append("CSP must not allow default-src *")
    if re.search(r"script-src\s+\*", combined):
        errors.append("CSP must not allow script-src *")
    if re.search(r"connect-src\s+\*", combined):
        errors.append("CSP must not allow connect-src *")
    # CSP 归一化工具需要认识 unsafe-eval 这个关键字，才能把错误配置规范化或被
    # 后续检查识别；真正禁止的是把 unsafe-eval 放进实际 CSP 默认值或响应指令里。
    combined_for_unsafe_eval = re.sub(
        r"CSP_KEYWORD_SOURCES\s*=\s*\{.*?\}\s*",
        "",
        combined,
        flags=re.DOTALL,
    )
    if "unsafe-eval" in combined_for_unsafe_eval:
        errors.append("CSP must not allow unsafe-eval")
    if "unsafe-inline" in combined:
        warnings.append("CSP still allows unsafe-inline for current SPA compatibility; document this as a hardening TODO.")


def check_config(errors: list[str], warnings: list[str]) -> None:
    config = read("core/config.py")
    add_if_missing(
        errors,
        config,
        [
            "SECURITY_HEADERS_ENABLED",
            "CSP_MODE",
            "CSP_REPORT_ONLY",
            "CSP_LOCAL_VENDOR_ONLY",
            "CSP_ALLOWED_SCRIPT_SRC",
            "CSP_ALLOWED_STYLE_SRC",
            "ALLOWED_ORIGINS",
            "MAX_UPLOAD_SIZE_MB",
            "ALLOWED_IMAGE_SUFFIXES",
            "ALLOWED_IMAGE_MIME_TYPES",
            "validate_production_config",
            "AUTH_TOKEN_TRANSPORT",
            "AUTH_PREFER_COOKIE",
            "AUTH_LOCALSTORAGE_TOKEN_COMPAT",
            "AUTH_COOKIE_SESSION_CHECK_ENABLED",
            "AUTH_LOCALSTORAGE_DEPRECATION_WARNING",
            "AUTH_STORE_TOKEN_IN_LOCALSTORAGE",
            "AUTH_ALLOW_BEARER_FALLBACK",
            "AUTH_COOKIE_REQUIRED_IN_PRODUCTION",
            "AUTH_COOKIE_NAME",
            "REGISTRATION_MODE",
            "REGISTRATION_INVITE_CODE",
            "DEPLOYMENT_MODE",
            "PUBLIC_BASE_URL",
            "TRUSTED_HOSTS",
            "FORCE_HTTPS",
            "LEAFVAULT_DOMAIN",
            "CSRF_COOKIE_NAME",
            "CSRF_HEADER_NAME",
            "CSRF_PROTECTION_ENABLED",
            "CSRF_ENFORCE_FOR_COOKIE_AUTH",
            "CSRF_EXEMPT_PATHS",
            "CSRF_SAFE_METHODS",
            "CSRF_ALLOW_LOGOUT_WITHOUT_TOKEN",
            "COOKIE_SECURE",
            "COOKIE_SAMESITE",
            "COOKIE_MAX_AGE_SECONDS",
        ],
        "core/config.py",
    )
    if '"*"' in re.sub(r"\s+", "", config) and "ALLOWED_ORIGINS cannot be '*'" not in config:
        errors.append("production ALLOWED_ORIGINS wildcard rejection is missing")
    if "'unsafe-inline'" in config:
        warnings.append("CSP_ALLOWED_* still includes unsafe-inline for current SPA compatibility.")


def check_cookie_session_prep(errors: list[str], warnings: list[str]) -> None:
    tokens = read("core/tokens.py")
    auth = read("routers/auth.py")
    csrf = read("core/csrf.py")
    request_js = read("static/js/api/request.js")
    session_js = read("static/js/modules/session.js")
    add_if_missing(
        errors,
        tokens + "\n" + auth + "\n" + csrf,
        [
            "HTTPBearer(auto_error=False)",
            "request.cookies.get(AUTH_COOKIE_NAME",
            "request.state.auth_source",
            "AUTH_ALLOW_BEARER_FALLBACK",
            "response.set_cookie",
            "httponly=True",
            "CSRF_COOKIE_NAME",
            "@router.post(\"/api/logout\")",
            "@router.get(\"/api/session/status\")",
            "verify_csrf_token",
            "csrf_protection_middleware",
            "secrets.compare_digest",
        ],
        "cookie session preparation",
    )
    session_start = auth.find('def session_status')
    if session_start == -1:
        errors.append("/api/session/status route is missing")
    else:
        session_body = auth[session_start:auth.find('@router.post("/api/reset_password")', session_start)]
        if '"token"' in session_body or '"csrf"' in session_body.lower() or "CSRF_COOKIE_NAME" in session_body:
            errors.append("/api/session/status must not return token or csrf fields")
    deployment_start = auth.find('def deployment_status')
    if deployment_start == -1:
        errors.append("/api/deployment/status route is missing")
    else:
        deployment_body = auth[deployment_start:auth.find('@router.post("/api/send_code")', deployment_start)]
        for forbidden in ("SECRET_KEY", "REGISTRATION_INVITE_CODE", "AI_API_KEY", "SENDER_PASSWORD", "DATABASE_PATH", "UPLOAD_DIR"):
            if forbidden in deployment_body:
                errors.append(f"/api/deployment/status must not return or reference sensitive field {forbidden}")
    if "credentials" not in request_js or "same-origin" not in request_js:
        errors.append("apiFetch must send credentials: 'same-origin' for Cookie session compatibility")
    if "X-CSRF-Token" not in request_js and "getCsrfToken" not in request_js:
        errors.append("apiFetch must attach X-CSRF-Token when a readable CSRF cookie exists")
    if "leafvault_access_token" in session_js or "AUTH_COOKIE_NAME" in session_js:
        errors.append("session.js must not try to read the HttpOnly access token cookie")
    add_if_missing(
        errors,
        session_js,
        ["refreshSessionStatus", "isAuthenticated", "setAuthMode", "getAuthMode"],
        "session.js Cookie preferred helpers",
    )
    add_if_missing(
        errors,
        session_js,
        ["shouldStoreTokenInLocalStorage", "setAuthTokenCompat", "store_token_in_localstorage", "bearer_fallback"],
        "session.js localStorage token downgrade helpers",
    )
    if re.search(r"function\s+setAuthToken\s*\(\s*token\s*\)\s*\{[^}]*localStorage\.setItem", session_js, re.DOTALL):
        errors.append("setAuthToken must not unconditionally persist token to localStorage")
    if "setAuthTokenCompat" in session_js:
        warnings.append("setAuthTokenCompat remains as an explicit migration fallback; keep it out of production default paths.")
    if re.search(r"(localStorage|sessionStorage)\.setItem\([^)]*csrf", session_js + request_js, re.IGNORECASE):
        errors.append("frontend must not persist CSRF tokens to localStorage/sessionStorage")
    if "shouldStoreTokenInLocalStorage" not in session_js:
        errors.append("localStorage token writes must be controlled by shouldStoreTokenInLocalStorage")


def check_upload_security(errors: list[str]) -> None:
    validators = read("core/validators.py")
    diary = read("services/diary_service.py")
    user = read("routers/user.py")
    combined = validators + "\n" + diary + "\n" + user
    add_if_missing(
        errors,
        combined,
        [
            "validate_upload_image_metadata",
            "ensure_safe_uploaded_image",
            "MAX_IMAGE_SIZE_BYTES",
            "content_type",
            "ALLOWED_IMAGE_MIME_TYPES",
            "safe_filename",
            "uuid.uuid4",
        ],
        "upload security",
    )
    config = read("core/config.py")
    if 'ALLOWED_IMAGE_SUFFIXES.discard(".svg")' not in config and "svg" in config:
        errors.append("user upload allow-list must explicitly exclude svg")


def check_frontend_logs(errors: list[str]) -> None:
    terms = ["password", "token", "decryptedPayload", "plainPayload", "encrypted_change"]
    for path in (ROOT / "static/js").rglob("*.js"):
        source = path.read_text(encoding="utf-8")
        for line_no, line in enumerate(source.splitlines(), 1):
            if "console.log" in line and any(term in line for term in terms):
                errors.append(f"{path.relative_to(ROOT)}:{line_no} dangerous console.log")


def check_frontend_csp_surface(errors: list[str], warnings: list[str]) -> None:
    html = read("templates/index.html")
    vendor_dir = ROOT / "static/vendor"
    if not vendor_dir.exists():
        errors.append("static/vendor/ is missing; third-party libraries should be localized where possible")

    inline_counts = count_inline_handlers(html)
    inline_script_blocks = count_inline_scripts(html)
    domains = external_resource_domains(html)
    domain_counts = Counter(domains)
    print(
        "CSP static stats: "
        + ", ".join(f"{name}={inline_counts[name]}" for name in INLINE_HANDLER_NAMES)
        + f", inline_script_blocks={inline_script_blocks}, external_cdn={sum(domain_counts.values())}"
    )

    if sum(inline_counts.values()) > 0:
        warnings.append(f"index.html still contains {sum(inline_counts.values())} inline event handlers.")
    if inline_script_blocks > 0:
        warnings.append(f"index.html still contains {inline_script_blocks} inline script block(s).")

    for domain in domain_counts:
        if domain not in REGISTERED_CDN_DOMAINS:
            errors.append(f"Unregistered external frontend resource domain found in index.html: {domain}")
        else:
            warnings.append(f"Registered CDN still referenced in index.html: {domain}")

    for lib_name, meta in LOCALIZED_VENDOR_LIBS.items():
        local_file = ROOT / meta["local_file"]
        if not local_file.exists():
            errors.append(f"Localized vendor file missing for {lib_name}: {meta['local_file']}")
        for marker in meta["cdn_markers"]:
            if marker in html and local_file.exists():
                errors.append(f"index.html still references CDN for localized library {lib_name}: {marker}")

    if "unsafe-eval" in html:
        errors.append("index.html must not contain unsafe-eval")


def check_service_worker(errors: list[str]) -> None:
    sw = read("static/service-worker.js")
    if "/api/" not in sw:
        errors.append("service-worker.js must explicitly avoid caching /api/")
    if "Authorization" not in sw:
        errors.append("service-worker.js must avoid caching Authorization requests")
    for meta in LOCALIZED_VENDOR_LIBS.values():
        if meta["local_file"].replace("\\", "/").replace("static/", "/static/") not in sw:
            errors.append(f"service-worker.js should cache localized vendor asset {meta['local_file']}")


def check_docker_and_env(errors: list[str]) -> None:
    compose = read("docker-compose.yml")
    env_example = read(".env.example")
    if re.search(r"SECRET_KEY\s*=\s*(?!change-me)", compose):
        errors.append("docker-compose.yml must not hardcode SECRET_KEY")
    if re.search(r"AI_API_KEY\s*=\s*sk-[A-Za-z0-9_-]+", compose):
        errors.append("docker-compose.yml must not hardcode AI_API_KEY")
    if "SECRET_KEY" not in env_example or "change-me" not in env_example or "random" not in env_example.lower():
        errors.append(".env.example must remind users to modify SECRET_KEY with a random value")


def run_checks() -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    for rel in [
        "main.py",
        "core/config.py",
        "core/security_headers.py",
        "core/csrf.py",
        "core/validators.py",
        "core/tokens.py",
        "services/diary_service.py",
        "routers/user.py",
        "routers/auth.py",
        "templates/index.html",
        "static/js/api/request.js",
        "static/js/modules/session.js",
        "static/service-worker.js",
        "docker-compose.yml",
        ".env.example",
    ]:
        if not (ROOT / rel).exists():
            errors.append(f"Missing required file: {rel}")
    if errors:
        return errors, warnings

    check_security_headers(errors, warnings)
    check_config(errors, warnings)
    check_cookie_session_prep(errors, warnings)
    check_upload_security(errors)
    check_frontend_logs(errors)
    check_frontend_csp_surface(errors, warnings)
    check_service_worker(errors)
    check_docker_and_env(errors)
    return errors, warnings


def main() -> int:
    errors, warnings = run_checks()
    for warning in warnings:
        print(f"WARNING: {warning}")
    if errors:
        print("Security static check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("Security static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
