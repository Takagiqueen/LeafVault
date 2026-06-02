import sqlite3
import uuid

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile

from core.config import IMAGES_DIR, MAX_IMAGE_SIZE_BYTES, MAX_UPLOAD_SIZE_MB
from core.dependencies import get_current_user
from core.passwords import hash_password, verify_password
from core.rate_limit import limiter
from core.tokens import create_access_token
from core.validators import (
    ensure_safe_uploaded_image,
    safe_filename_prefix,
    validate_password,
    validate_upload_image_metadata,
    validate_username,
)
from db.database import get_db

router = APIRouter()


@router.get("/api/user/info")
@limiter.limit("60/minute")
def get_user_info(
    request: Request,
    current_user: sqlite3.Row = Depends(get_current_user),
):
    return {
        "status": "success",
        "data": {
            "user_id": current_user["user_id"],
            "username": current_user["username"],
            "email": current_user["email"],
            "avatar_url": current_user["avatar_url"],
        },
    }


@router.post("/api/user/avatar")
@limiter.limit("10/minute")
async def upload_avatar(
    request: Request,
    avatar: UploadFile = File(...),
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    ext = validate_upload_image_metadata(avatar.filename or "", avatar.content_type)
    content = await avatar.read()
    if len(content) > MAX_IMAGE_SIZE_BYTES:
        return {"status": "error", "message": f"图片不能超过 {MAX_UPLOAD_SIZE_MB}MB"}
    safe_ext = ensure_safe_uploaded_image(ext, content)
    user_id = current_user["user_id"]
    safe_user = safe_filename_prefix(user_id)
    safe_filename = f"avatar_{safe_user}_{uuid.uuid4().hex[:8]}{safe_ext}"
    with open(IMAGES_DIR / safe_filename, "wb") as f:
        f.write(content)
    avatar_url = f"/uploads/{safe_filename}"
    cursor = db.cursor()
    cursor.execute("UPDATE users SET avatar_url = ? WHERE user_id = ?", (avatar_url, user_id))
    db.commit()
    return {"status": "success", "avatar_url": avatar_url, "message": "头像更新成功"}


@router.post("/api/user/password")
@limiter.limit("10/minute")
def change_password(
    request: Request,
    old_password: str = Form(...),
    new_password: str = Form(...),
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    validate_password(new_password)
    if not current_user or not verify_password(old_password, current_user["password_hash"]):
        return {"status": "error", "message": "原密码错误"}
    cursor = db.cursor()
    cursor.execute(
        "UPDATE users SET password_hash = ? WHERE user_id = ?",
        (hash_password(new_password), current_user["user_id"]),
    )
    db.commit()
    return {"status": "success", "message": "密码修改成功，下次请使用新密码登录"}


@router.post("/api/user/username")
@limiter.limit("10/minute")
def change_username(
    request: Request,
    new_username: str = Form(...),
    current_password: str = Form(...),
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    # username 只作为展示昵称；数据归属由不可变 user_id 决定。
    new_username = new_username.strip()
    validate_username(new_username)
    cursor = db.cursor()

    if not current_user or not verify_password(current_password, current_user["password_hash"]):
        return {"status": "error", "message": "当前密码错误，无法修改用户名"}
    if new_username == current_user["username"]:
        return {"status": "error", "message": "新用户名不能与当前用户名相同"}

    cursor.execute("SELECT id FROM users WHERE username = ?", (new_username,))
    if cursor.fetchone():
        return {"status": "error", "message": "该用户名已被占用"}

    try:
        cursor.execute("BEGIN")
        cursor.execute("UPDATE users SET username = ? WHERE user_id = ?", (new_username, current_user["user_id"]))
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        return {"status": "error", "message": "用户名更新冲突，请换一个名字"}

    return {
        "status": "success",
        "message": "用户名修改成功",
        "username": new_username,
        "token": create_access_token(current_user["user_id"]),
    }
