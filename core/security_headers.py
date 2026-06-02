from __future__ import annotations

from urllib.parse import urlparse

from starlette.responses import Response

from core.config import (
    AI_BASE_URL,
    CSP_ALLOWED_SCRIPT_SRC,
    CSP_ALLOWED_STYLE_SRC,
    CSP_MODE,
    CSP_REPORT_ONLY,
)

CSP_KEYWORD_SOURCES = {
    "self": "'self'",
    "'self'": "'self'",
    "unsafe-inline": "'unsafe-inline'",
    "'unsafe-inline'": "'unsafe-inline'",
    "unsafe-eval": "'unsafe-eval'",
    "'unsafe-eval'": "'unsafe-eval'",
    "none": "'none'",
    "'none'": "'none'",
}


def _origin_from_url(value: str) -> str:
    parsed = urlparse(value)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def normalize_csp_sources(values: list[str]) -> list[str]:
    """归一化 CSP source，避免 unsafe-inline/self 等关键字漏写单引号。

    环境变量里有人会写 unsafe-inline，也有人会写 'unsafe-inline'；这里统一输出
    浏览器能识别的 CSP 关键字，同时保留 data:/blob:/https:// 这类合法 source。
    """
    normalized: list[str] = []
    for raw_value in values:
        for token in str(raw_value or "").split():
            value = token.strip()
            if not value:
                continue
            source = CSP_KEYWORD_SOURCES.get(value.lower(), value)
            if source not in normalized:
                normalized.append(source)
    return normalized


def build_csp() -> str:
    ai_origin = _origin_from_url(AI_BASE_URL)
    connect_sources = normalize_csp_sources(["'self'"])
    if ai_origin:
        connect_sources.append(ai_origin)

    script_sources = normalize_csp_sources(["'self'", *CSP_ALLOWED_SCRIPT_SRC])
    style_sources = normalize_csp_sources(["'self'", *CSP_ALLOWED_STYLE_SRC])

    directives = {
        "default-src": normalize_csp_sources(["'self'"]),
        "base-uri": normalize_csp_sources(["'self'"]),
        "object-src": normalize_csp_sources(["'none'"]),
        "frame-ancestors": normalize_csp_sources(["'none'"]),
        "img-src": normalize_csp_sources(["'self'", "data:", "blob:"]),
        "font-src": normalize_csp_sources(["'self'", "data:"]),
        "connect-src": connect_sources,
        "manifest-src": normalize_csp_sources(["'self'"]),
        "worker-src": normalize_csp_sources(["'self'"]),
        "script-src": script_sources,
        "style-src": style_sources,
    }
    return "; ".join(f"{name} {' '.join(values)}" for name, values in directives.items()) + ";"


def csp_header_name() -> str:
    if CSP_REPORT_ONLY or CSP_MODE == "report-only":
        return "Content-Security-Policy-Report-Only"
    return "Content-Security-Policy"


def apply_security_headers(response: Response) -> Response:
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers[csp_header_name()] = build_csp()
    return response
