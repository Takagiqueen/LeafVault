import json
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from core.config import ALLOWED_IMAGE_MIME_TYPES, ALLOWED_IMAGE_SUFFIXES, MONTH_RE, logger

EMAIL_RE = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_\-\u4e00-\u9fff]{2,30}$")


def validate_email(email: str):
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="邮箱格式不正确")


def validate_password(password: str):
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="密码长度不能少于 8 位")


def validate_username(username: str):
    if not USERNAME_RE.match(username):
        raise HTTPException(
            status_code=422,
            detail={
                "field": "username",
                "code": "username_invalid_format",
                "message": "用户名格式不正确，不能使用邮箱格式或特殊符号。",
            },
        )


def safe_filename_prefix(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_]", "", value or "")


def is_allowed_image_content(ext: str, data: bytes) -> bool:
    """Lightweight magic-number check for user-uploaded images."""
    if ext in {".jpg", ".jpeg"}:
        return data.startswith(b"\xff\xd8\xff")
    if ext == ".png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == ".gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    if ext == ".webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


def detect_image_suffix(data: bytes) -> str:
    """Return a safe suffix from image magic bytes, independent of client filename."""
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ""


def validate_upload_image_metadata(filename: str, content_type: str | None = None) -> str:
    """Validate user-controlled upload metadata before reading file content."""
    if not filename:
        raise HTTPException(status_code=422, detail="未选择文件")
    path = Path(filename)
    if path.name != filename or ".." in filename or filename.startswith(("/", "\\")):
        raise HTTPException(status_code=422, detail="非法文件名")
    ext = path.suffix.lower()
    if ext not in ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(status_code=422, detail="不支持的图片格式")
    if content_type and content_type.lower() not in ALLOWED_IMAGE_MIME_TYPES:
        raise HTTPException(status_code=422, detail="不支持的图片 MIME 类型")
    return ext


def ensure_safe_uploaded_image(ext: str, data: bytes) -> str:
    """Validate magic bytes and return the trusted suffix for storage."""
    detected_ext = detect_image_suffix(data)
    if detected_ext not in ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(status_code=422, detail="图片内容类型不受支持")
    if ext in ALLOWED_IMAGE_SUFFIXES and is_allowed_image_content(ext, data):
        return ext
    if is_allowed_image_content(detected_ext, data):
        return detected_ext
    raise HTTPException(status_code=422, detail="图片内容与文件格式不匹配")


def validate_month_param(month: Optional[str], param_name: str = "month") -> str:
    """校验 YYYY-MM 格式，避免 LIKE 参数绕过用户隔离边界。"""
    if not month:
        return datetime.now().strftime("%Y-%m")
    if not MONTH_RE.match(month):
        raise HTTPException(status_code=422, detail=f"参数 {param_name} 格式不正确，应为 YYYY-MM")
    return month


def parse_retained_image_paths(paths_str: str) -> list[str]:
    text = str(paths_str or "").strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
    return [part.strip() for part in text.split(",") if part.strip()]


def validate_retained_images(paths_str: str, user_id: str, legacy_display_username: str = "") -> list[str]:
    """校验前端传回的旧图片路径必须属于当前用户。

    新上传图片统一使用不可变 user_id 生成文件名前缀。legacy_display_username
    只用于兼容改名前已经保存的旧图片路径，不参与任何业务数据归属判断。
    """
    valid_owners = {safe_filename_prefix(user_id)}
    if legacy_display_username:
        valid_owners.add(safe_filename_prefix(legacy_display_username))
    valid_owners.discard("")

    result = []
    for p in parse_retained_image_paths(paths_str):
        p = p.strip()
        if not p:
            continue
        path = Path(p)
        ext = path.suffix.lower()
        filename = path.name
        # 兼容两种历史格式：userid_xxx.ext，以及当前上传生成的 timestamp_userid_xxx.ext。
        belongs_to_user = any(
            filename.startswith(f"{owner}_")
            or re.match(rf"^\d{{14}}_{re.escape(owner)}_[A-Za-z0-9]+{re.escape(ext)}$", filename)
            or re.match(rf"^backup_{re.escape(owner)}_[A-Fa-f0-9]{{12,64}}{re.escape(ext)}$", filename)
            for owner in valid_owners
        )
        if (
            (p.startswith("/static/images/") or p.startswith("/uploads/"))
            and "/" not in filename
            and ".." not in p
            and ext in ALLOWED_IMAGE_SUFFIXES
            and belongs_to_user
        ):
            result.append(p)
        else:
            logger.warning("非法 retained_images 路径被过滤: %r (user_id=%s)", p, user_id)
    return result

