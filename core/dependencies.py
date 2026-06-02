import sqlite3

from fastapi import Depends, HTTPException

from core.tokens import verify_token
from db.database import get_db


def get_current_user(
    user_id: str = Depends(verify_token),
    db: sqlite3.Connection = Depends(get_db),
) -> sqlite3.Row:
    # 认证后的身份只认不可变 user_id；username 只作为页面展示昵称。
    cursor = db.cursor()
    cursor.execute(
        "SELECT id, user_id, username, email, avatar_url, password_hash FROM users WHERE user_id = ?",
        (user_id,),
    )
    user = cursor.fetchone()
    if not user:
        raise HTTPException(status_code=401, detail="无效的凭证")
    return user
