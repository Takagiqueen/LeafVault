import sqlite3
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, Form, Request
from pydantic import BaseModel, field_validator

from core.dependencies import get_current_user
from core.rate_limit import limiter
from db.database import get_db
from services.ledger_service import (
    create_ledger as create_ledger_record,
    create_ledgers_batch as create_ledgers_batch_records,
    delete_ledger as delete_ledger_record,
    list_ledgers,
)

router = APIRouter()


@router.post("/api/ledgers/")
@limiter.limit("30/minute")
def create_ledger(
    request: Request,
    type: str = Form(...),
    amount: float = Form(...),
    category: str = Form(...),
    note: str = Form(""),
    date: str = Form(...),
    ledger_uuid: str = Form(None, alias="uuid"),
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    return create_ledger_record(
        db,
        user_id=current_user["user_id"],
        type=type,
        amount=amount,
        category=category,
        note=note,
        date=date,
        ledger_uuid=ledger_uuid,
    )


class LedgerBatchItem(BaseModel):
    type: str
    amount: float
    category: str
    note: str = ""
    date: str
    uuid: Optional[str] = None

    @field_validator("type")
    @classmethod
    def type_must_be_valid(cls, v: str) -> str:
        if v not in ("income", "expense"):
            raise ValueError("非法的记账类型")
        return v

    @field_validator("amount")
    @classmethod
    def amount_must_be_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("金额必须大于 0")
        return round(v, 2)

    @field_validator("date")
    @classmethod
    def date_must_be_valid(cls, v: str) -> str:
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("日期格式不正确，应为 YYYY-MM-DD")
        return v

    @field_validator("category")
    @classmethod
    def category_length(cls, v: str) -> str:
        if len(v) > 50:
            raise ValueError("分类名称过长")
        return v


@router.post("/api/ledgers/batch")
@limiter.limit("30/minute")
def create_ledgers_batch(
    request: Request,
    items: List[LedgerBatchItem],
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    return create_ledgers_batch_records(db, user_id=current_user["user_id"], items=items)


@router.get("/api/ledgers/list")
@limiter.limit("60/minute")
def get_ledgers(
    request: Request,
    page: int = 1,
    page_size: int = 50,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    return list_ledgers(db, user_id=current_user["user_id"], page=page, page_size=page_size)


@router.delete("/api/ledgers/{ledger_id}")
@limiter.limit("30/minute")
def delete_ledger(
    request: Request,
    ledger_id: int,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    return delete_ledger_record(db, user_id=current_user["user_id"], ledger_id=ledger_id)
