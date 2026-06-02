import sqlite3
from datetime import datetime
from typing import Optional, Sequence

from fastapi import HTTPException

from core.config import logger


def validate_ledger_values(type: str, amount: float, category: str, date: str) -> float:
    if type not in ("income", "expense"):
        raise HTTPException(status_code=422, detail="非法的记账类型")
    if amount <= 0:
        raise HTTPException(status_code=422, detail="金额必须大于 0")
    if len(category) > 50:
        raise HTTPException(status_code=422, detail="分类名称过长")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="日期格式不正确")
    return round(amount, 2)


def ledger_exists(db: sqlite3.Connection, *, user_id: str, ledger_uuid: Optional[str]) -> bool:
    if not ledger_uuid:
        return False
    cursor = db.cursor()
    cursor.execute("SELECT id FROM ledgers WHERE uuid = ? AND user_id = ?", (ledger_uuid, user_id))
    return cursor.fetchone() is not None


def insert_ledger(
    db: sqlite3.Connection,
    *,
    user_id: str,
    type: str,
    amount: float,
    category: str,
    note: str,
    date: str,
    ledger_uuid: Optional[str],
) -> None:
    normalized_amount = validate_ledger_values(type, amount, category, date)
    cursor = db.cursor()
    cursor.execute(
        "INSERT INTO ledgers (user_id, username, type, amount, category, note, created_at, uuid) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        # username 字段仅为旧表兼容保留；业务归属永远使用 user_id。
        (user_id, user_id, type, normalized_amount, category, note, date, ledger_uuid),
    )


def create_ledger(
    db: sqlite3.Connection,
    *,
    user_id: str,
    type: str,
    amount: float,
    category: str,
    note: str,
    date: str,
    ledger_uuid: Optional[str],
) -> dict:
    validate_ledger_values(type, amount, category, date)
    if ledger_exists(db, user_id=user_id, ledger_uuid=ledger_uuid):
        return {"status": "success", "message": "数据已存在，触发幂等保护"}
    insert_ledger(
        db,
        user_id=user_id,
        type=type,
        amount=amount,
        category=category,
        note=note,
        date=date,
        ledger_uuid=ledger_uuid,
    )
    db.commit()
    return {"status": "success", "message": "一笔新流水已入库！"}


def create_ledgers_batch(db: sqlite3.Connection, *, user_id: str, items: Sequence[object]) -> dict:
    if not items:
        return {
            "status": "success",
            "message": "空批次，无需处理",
            "saved": 0,
            "skipped": 0,
            "errors": [],
            "saved_uuids": [],
            "skipped_uuids": [],
        }
    if len(items) > 200:
        raise HTTPException(status_code=422, detail="单次批量提交不得超过 200 条")

    saved = 0
    skipped = 0
    errors = []
    saved_uuids = []
    skipped_uuids = []

    for index, item in enumerate(items):
        try:
            ledger_uuid = getattr(item, "uuid", None)
            if ledger_exists(db, user_id=user_id, ledger_uuid=ledger_uuid):
                skipped += 1
                skipped_uuids.append(ledger_uuid)
                continue

            insert_ledger(
                db,
                user_id=user_id,
                type=item.type,
                amount=item.amount,
                category=item.category,
                note=item.note,
                date=item.date,
                ledger_uuid=ledger_uuid,
            )
            saved += 1
            if ledger_uuid:
                saved_uuids.append(ledger_uuid)
        except Exception as exc:
            errors.append({"index": index, "uuid": getattr(item, "uuid", None), "error": str(exc)})
            logger.warning("批量账本第 %s 条写入失败: %s", index, exc)

    db.commit()
    logger.info("批量账本同步：user_id=%s，成功=%s，跳过=%s，失败=%s", user_id, saved, skipped, len(errors))
    return {
        "status": "partial_success" if errors else "success",
        "message": f"批量同步完成：{saved} 条入库，{skipped} 条已存在跳过",
        "saved": saved,
        "skipped": skipped,
        "errors": errors,
        "saved_uuids": saved_uuids,
        "skipped_uuids": skipped_uuids,
    }


def list_ledgers(db: sqlite3.Connection, *, user_id: str, page: int, page_size: int) -> dict:
    page = max(1, page)
    page_size = min(max(1, page_size), 200)
    offset = (page - 1) * page_size
    cursor = db.cursor()
    cursor.execute(
        "SELECT * FROM ledgers WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        (user_id, page_size, offset),
    )
    return {"status": "success", "data": [dict(row) for row in cursor.fetchall()]}


def delete_ledger(db: sqlite3.Connection, *, user_id: str, ledger_id: int) -> dict:
    cursor = db.cursor()
    cursor.execute("DELETE FROM ledgers WHERE id = ? AND user_id = ?", (ledger_id, user_id))
    db.commit()
    return {"status": "success", "message": "流水已安全删除！"}
