import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Optional, Sequence

from fastapi import HTTPException, UploadFile

from core.config import (
    IMAGES_DIR,
    MAX_DIARY_CONTENT_LEN,
    MAX_DIARY_IMAGES_PER_ENTRY,
    MAX_IMAGE_SIZE_BYTES,
    MAX_UPLOAD_SIZE_MB,
    logger,
)
from core.validators import (
    ensure_safe_uploaded_image,
    safe_filename_prefix,
    validate_retained_images,
    validate_upload_image_metadata,
)

ALLOWED_MOODS = {"开心", "一般", "有点累", "想休息", "不太好"}
MAX_PINNED_DIARIES = 5


def parse_diary_timestamp(value: Optional[str]):
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def validate_diary_date(date: str) -> None:
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="日期格式不正确")


def normalize_mood(mood_label: str) -> str:
    return mood_label if mood_label in ALLOWED_MOODS else "一般"


def validate_diary_content(content: str) -> None:
    if len(content) > MAX_DIARY_CONTENT_LEN:
        raise HTTPException(status_code=422, detail=f"日记内容过长，最大 {MAX_DIARY_CONTENT_LEN} 字")


def parse_image_paths(value: str | None) -> list[str]:
    """Parse current JSON image path arrays and legacy CSV without splitting data URLs."""
    text = str(value or "").strip()
    if not text:
        return []
    if text.lower().startswith("data:image/") and ";base64," in text.lower():
        return [text]
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                parsed_paths: list[str] = []
                for item in parsed:
                    parsed_paths.extend(parse_image_paths(item))
                return merge_image_paths(parsed_paths)
        except json.JSONDecodeError:
            pass
    raw_parts = [path.strip() for path in text.split(",") if path.strip()]
    parts: list[str] = []
    prefixes = {
        "data:image/jpeg;base64",
        "data:image/jpg;base64",
        "data:image/png;base64",
        "data:image/webp;base64",
        "data:image/gif;base64",
    }
    index = 0
    while index < len(raw_parts):
        current = raw_parts[index]
        next_part = raw_parts[index + 1] if index + 1 < len(raw_parts) else ""
        if current.lower() in prefixes and next_part:
            parts.append(f"{current},{next_part}")
            index += 2
        else:
            parts.append(current)
            index += 1
    return merge_image_paths(parts)


def merge_image_paths(*groups: Sequence[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for group in groups:
        for path in group or []:
            if not path or path in seen:
                continue
            seen.add(path)
            merged.append(path)
    return merged


def count_incoming_images(images: Sequence[UploadFile] | None) -> int:
    return sum(1 for image in images or [] if image and image.filename)


def ensure_diary_image_count_limit(paths: Sequence[str], incoming_count: int = 0) -> None:
    total = len([path for path in paths if path]) + max(0, incoming_count)
    if total > MAX_DIARY_IMAGES_PER_ENTRY:
        raise HTTPException(
            status_code=422,
            detail=f"单篇日记最多只能放 {MAX_DIARY_IMAGES_PER_ENTRY} 张图，请先删除一些图片后再上传。",
        )


async def save_uploaded_image_paths(
    images: Sequence[UploadFile] | None,
    user_id: str,
) -> list[str]:
    safe_user = safe_filename_prefix(user_id)
    uploaded_paths: list[str] = []

    if not images:
        return uploaded_paths

    for img in images:
        if not img.filename:
            continue
        ext = validate_upload_image_metadata(img.filename, img.content_type)

        raw = await img.read()
        if len(raw) > MAX_IMAGE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail=f"图片不能超过 {MAX_UPLOAD_SIZE_MB}MB")
        safe_ext = ensure_safe_uploaded_image(ext, raw)

        safe_filename = (
            f"{datetime.now().strftime('%Y%m%d%H%M%S')}"
            f"_{safe_user}_{uuid.uuid4().hex[:8]}{safe_ext}"
        )
        with open(IMAGES_DIR / safe_filename, "wb") as f:
            f.write(raw)
        uploaded_paths.append(f"/uploads/{safe_filename}")

    return uploaded_paths


async def collect_image_paths(
    images: Sequence[UploadFile] | None,
    retained_images: str,
    user_id: str,
    legacy_display_username: str,
) -> list[str]:
    # retained_images 只允许保留当前用户已有图片，避免前端伪造路径引用他人资源。
    retained_paths = validate_retained_images(retained_images, user_id, legacy_display_username)
    uploaded_paths = await save_uploaded_image_paths(images, user_id)
    return merge_image_paths(retained_paths, uploaded_paths)


async def upsert_diary(
    db: sqlite3.Connection,
    *,
    user_id: str,
    date: str,
    mood_label: str,
    content: str,
    retained_images: str,
    removed_images: str,
    images: Sequence[UploadFile] | None,
    legacy_display_username: str,
    updated_at: Optional[str],
) -> dict:
    validate_diary_date(date)
    validate_diary_content(content)
    mood_label = normalize_mood(mood_label)
    retained_paths = validate_retained_images(retained_images, user_id, legacy_display_username)
    removed_paths = validate_retained_images(removed_images, user_id, legacy_display_username)
    # 客户端 updated_at 只用于冲突判断；最终落库时间由服务端生成，避免未来时间锁死后续更新。
    final_updated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    cursor = db.cursor()
    cursor.execute("SELECT updated_at, image_paths FROM diaries WHERE date = ? AND user_id = ?", (date, user_id))
    existing = cursor.fetchone()
    incoming_image_count = count_incoming_images(images)

    if existing:
        db_updated_at = existing["updated_at"]
        client_time = parse_diary_timestamp(updated_at)
        server_time = parse_diary_timestamp(db_updated_at)
        is_stale_update = False
        if updated_at and db_updated_at:
            if client_time and server_time:
                is_stale_update = client_time < server_time
            elif client_time and not server_time:
                is_stale_update = updated_at < db_updated_at
        if is_stale_update:
            return {
                "status": "conflict",
                "message": "发现多端冲突：云端存在更新的版本，为保护数据已拒绝覆盖。",
            }
        existing_paths = parse_image_paths(existing["image_paths"])
        if removed_paths:
            removed_set = set(removed_paths)
            base_paths = [path for path in existing_paths if path not in removed_set]
            retained_for_merge = [path for path in retained_paths if path not in removed_set]
        else:
            # 没有显式 removed_images 时，认为前端可能漏传 retained_images，不能误删数据库旧图。
            base_paths = existing_paths
            retained_for_merge = retained_paths
        existing_and_retained_paths = merge_image_paths(base_paths, retained_for_merge)
        ensure_diary_image_count_limit(existing_and_retained_paths, incoming_image_count)
        uploaded_paths = await save_uploaded_image_paths(images, user_id)
        image_paths = merge_image_paths(existing_and_retained_paths, uploaded_paths)
        image_paths_str = ",".join(image_paths) if image_paths else None
        logger.info(
            "Diary image merge completed: date=%s user_id=%s existing_count=%s retained_count=%s removed_count=%s uploaded_count=%s final_count=%s",
            date,
            user_id,
            len(existing_paths),
            len(retained_paths),
            len(removed_paths),
            len(uploaded_paths),
            len(image_paths),
        )
        cursor.execute(
            "UPDATE diaries SET mood_label=?, content=?, image_paths=?, updated_at=? "
            "WHERE date=? AND user_id=?",
            (mood_label, content, image_paths_str, final_updated_at, date, user_id),
        )
        msg = "时光记录已成功更新！"
    else:
        retained_base_paths = merge_image_paths(retained_paths)
        ensure_diary_image_count_limit(retained_base_paths, incoming_image_count)
        uploaded_paths = await save_uploaded_image_paths(images, user_id)
        image_paths = merge_image_paths(retained_base_paths, uploaded_paths)
        image_paths_str = ",".join(image_paths) if image_paths else None
        cursor.execute(
            "INSERT INTO diaries (user_id, username, date, mood_label, content, image_paths, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            # username 字段仅为旧表兼容保留；业务归属永远使用 user_id。
            (user_id, user_id, date, mood_label, content, image_paths_str, final_updated_at),
        )
        msg = "新时光已存入！"

    db.commit()
    return {
        "status": "success",
        "message": msg,
        "image_paths": image_paths_str or "",
        "date": date,
        "updated_at": final_updated_at,
    }


def get_diary_detail(db: sqlite3.Connection, *, user_id: str, date: str) -> dict:
    validate_diary_date(date)
    cursor = db.cursor()
    cursor.execute("SELECT * FROM diaries WHERE date = ? AND user_id = ?", (date, user_id))
    row = cursor.fetchone()
    if row:
        return {"status": "success", "data": dict(row)}
    return {"status": "not_found"}


def toggle_diary_pin(db: sqlite3.Connection, *, user_id: str, date: str) -> dict:
    validate_diary_date(date)
    cursor = db.cursor()
    cursor.execute("SELECT is_pinned FROM diaries WHERE date = ? AND user_id = ?", (date, user_id))
    row = cursor.fetchone()
    if not row:
        return {"status": "error", "message": "未找到该日记"}

    current_status = row["is_pinned"]
    if current_status == 0:
        cursor.execute("SELECT COUNT(*) FROM diaries WHERE user_id = ? AND is_pinned = 1", (user_id,))
        if cursor.fetchone()[0] >= MAX_PINNED_DIARIES:
            return {"status": "error", "message": f"最多只能置顶 {MAX_PINNED_DIARIES} 篇日记，请先取消一篇置顶"}

    new_status = 1 - current_status
    cursor.execute(
        "UPDATE diaries SET is_pinned = ? WHERE date = ? AND user_id = ?",
        (new_status, date, user_id),
    )
    db.commit()
    return {"status": "success", "message": "操作成功", "is_pinned": new_status}


def list_diaries(
    db: sqlite3.Connection,
    *,
    user_id: str,
    keyword: Optional[str],
    page: int,
    page_size: int,
) -> dict:
    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    offset = (page - 1) * page_size
    cursor = db.cursor()

    if keyword:
        kw = f"%{keyword}%"
        cursor.execute(
            "SELECT * FROM diaries WHERE user_id = ? AND (content LIKE ? OR mood_label LIKE ? OR date LIKE ?) "
            "ORDER BY is_pinned DESC, date DESC LIMIT ? OFFSET ?",
            (user_id, kw, kw, kw, page_size, offset),
        )
    else:
        cursor.execute(
            "SELECT * FROM diaries WHERE user_id = ? ORDER BY is_pinned DESC, date DESC LIMIT ? OFFSET ?",
            (user_id, page_size, offset),
        )
    return {"status": "success", "data": [dict(row) for row in cursor.fetchall()]}


def delete_diary(db: sqlite3.Connection, *, user_id: str, date: str) -> dict:
    validate_diary_date(date)
    cursor = db.cursor()
    cursor.execute("DELETE FROM diaries WHERE date = ? AND user_id = ?", (date, user_id))
    db.commit()
    return {"status": "success", "message": "该日期的记录已删除！"}
