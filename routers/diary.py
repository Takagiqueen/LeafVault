import sqlite3
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile

from core.config import ENVIRONMENT
from core.dependencies import get_current_user
from core.rate_limit import limiter
from db.database import get_db
from services.diary_service import (
    delete_diary as delete_diary_record,
    get_diary_detail as get_diary_detail_record,
    list_diaries,
    toggle_diary_pin,
    upsert_diary,
    validate_diary_date,
)

router = APIRouter()


@router.post("/api/diaries/")
@limiter.limit("30/minute")
async def create_diary(
    request: Request,
    date: str = Form(...),
    mood_label: str = Form("一般"),
    content: str = Form(...),
    retained_images: str = Form(""),
    removed_images: str = Form(""),
    updated_at: str = Form(None),
    images: List[UploadFile] = File(None),
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    user_id = current_user["user_id"]
    return await upsert_diary(
        db,
        user_id=user_id,
        date=date,
        mood_label=mood_label,
        content=content,
        retained_images=retained_images,
        removed_images=removed_images,
        images=images,
        legacy_display_username=current_user["username"],
        updated_at=updated_at,
    )


@router.get("/api/diaries/detail")
@limiter.limit("60/minute")
def get_diary_detail(
    request: Request,
    date: str,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    return get_diary_detail_record(db, user_id=current_user["user_id"], date=date)


@router.get("/api/diaries/debug_image_paths")
@limiter.limit("60/minute")
def debug_diary_image_paths(
    request: Request,
    date: str,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    """开发期临时调试接口：只返回当前用户该日期的图片引用，不暴露日记正文。"""
    if ENVIRONMENT != "development":
        raise HTTPException(status_code=404, detail="Not found")
    validate_diary_date(date)
    cursor = db.cursor()
    cursor.execute(
        "SELECT image_paths, updated_at FROM diaries WHERE date = ? AND user_id = ?",
        (date, current_user["user_id"]),
    )
    row = cursor.fetchone()
    return {
        "status": "success",
        "date": date,
        "image_paths": row["image_paths"] if row else "",
        "updated_at": row["updated_at"] if row else "",
    }


@router.post("/api/diaries/toggle_pin")
@limiter.limit("30/minute")
def toggle_pin(
    request: Request,
    date: str = Form(...),
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    return toggle_diary_pin(db, user_id=current_user["user_id"], date=date)


@router.get("/api/diaries/list")
@limiter.limit("60/minute")
def get_diaries(
    request: Request,
    keyword: Optional[str] = None,
    page: int = 1,
    page_size: int = 30,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    return list_diaries(
        db,
        user_id=current_user["user_id"],
        keyword=keyword,
        page=page,
        page_size=page_size,
    )


@router.delete("/api/diaries/{date}")
@limiter.limit("30/minute")
def delete_diary(
    request: Request,
    date: str,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    return delete_diary_record(db, user_id=current_user["user_id"], date=date)
