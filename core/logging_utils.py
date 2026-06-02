from __future__ import annotations

from collections.abc import Mapping
from typing import Any


SENSITIVE_KEYS = {
    "secret_key",
    "ai_api_key",
    "sender_password",
    "authorization",
    "token",
    "password",
    "backup_password",
    "sync_password",
    "encrypted_blob",
    "encrypted_change",
    "payload",
}


def mask_secret(value: Any) -> str:
    text = "" if value is None else str(value)
    if not text:
        return ""
    if len(text) <= 8:
        return "[REDACTED]"
    return f"{text[:3]}...[REDACTED]...{text[-3:]}"


def safe_log_dict(data: Mapping[str, Any] | None) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in dict(data or {}).items():
        normalized = str(key).lower()
        if any(marker in normalized for marker in SENSITIVE_KEYS):
            safe[key] = "[REDACTED]"
        elif isinstance(value, str) and len(value) > 160:
            safe[key] = f"{value[:40]}...[TRUNCATED]"
        else:
            safe[key] = value
    return safe


def sanitize_error_message(message: Any) -> str:
    text = "" if message is None else str(message)
    for marker in SENSITIVE_KEYS:
        text = text.replace(marker, "[REDACTED_KEY]")
    if len(text) > 300:
        return text[:300] + "...[TRUNCATED]"
    return text
