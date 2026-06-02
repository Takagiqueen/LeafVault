import base64
import binascii
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, StrictInt, StrictStr

from core.dependencies import get_current_user
from core.config import (
    MAX_CLOUD_SNAPSHOT_PAYLOAD_BYTES,
    MAX_CLOUD_SNAPSHOT_PAYLOAD_MB,
    MAX_CLOUD_SNAPSHOTS_PER_USER,
    MAX_SYNC_BATCH_SIZE,
    MAX_SYNC_CHANGE_PAYLOAD_BYTES,
    MAX_SYNC_CHANGE_PAYLOAD_KB,
    MAX_IMAGE_SIZE_BYTES,
    MAX_UPLOAD_SIZE_MB,
    UPLOAD_DIR,
)
from core.validators import ensure_safe_uploaded_image, safe_filename_prefix, validate_upload_image_metadata
from db.database import get_db


router = APIRouter()
MAX_SYNC_CHANGE_BATCH_SIZE = MAX_SYNC_BATCH_SIZE


class SnapshotPayload(BaseModel):
    version: StrictInt
    app: StrictStr
    kdf: StrictStr
    iterations: StrictInt
    salt: StrictStr
    iv: StrictStr
    payload: StrictStr
    created_at: StrictStr
    device_name: Optional[StrictStr] = ""
    snapshot_name: Optional[StrictStr] = None
    snapshot_note: Optional[StrictStr] = None


class EncryptedSyncChangePayload(BaseModel):
    version: StrictInt
    app: StrictStr
    type: StrictStr
    kdf: StrictStr
    iterations: Optional[StrictInt] = None
    salt: Optional[StrictStr] = None
    iv: StrictStr
    payload: StrictStr


class SyncChangeItem(BaseModel):
    change_id: StrictStr
    entity_type: StrictStr
    entity_id: StrictStr
    operation: StrictStr
    encrypted_change: EncryptedSyncChangePayload
    device_id: Optional[StrictStr] = ""
    client_sequence: Optional[StrictInt] = 0
    base_revision: Optional[StrictInt] = 0
    local_revision: Optional[StrictInt] = 0
    created_at: Optional[StrictStr] = ""


class SyncChangeBatchPayload(BaseModel):
    changes: list[SyncChangeItem]


class BackupAssetRestorePayload(BaseModel):
    old_path: StrictStr
    filename: StrictStr
    mime: StrictStr
    size: StrictInt
    sha256: Optional[StrictStr] = ""
    data_base64: StrictStr


def _require_non_empty_string(value: str, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=422, detail=f"Invalid {field_name}")
    return value.strip()


def _utf8_size(value: str) -> int:
    return len(value.encode("utf-8"))


def _enforce_text_size(value: str, *, limit_bytes: int, label: str, message: str) -> None:
    if _utf8_size(value) > limit_bytes:
        raise HTTPException(status_code=413, detail=message)


def _normalize_snapshot_meta(value: Optional[str], field_name: str, max_length: int, default: str = "") -> str:
    text = (value or "").strip()
    if not text:
        text = default
    if len(text) > max_length:
        raise HTTPException(status_code=422, detail=f"{field_name} is too long")
    return text


def _model_to_dict(model: BaseModel) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_none=True)
    return model.dict(exclude_none=True)


@router.post("/api/backup/assets/restore")
def restore_backup_asset(
    asset: BackupAssetRestorePayload,
    current_user: sqlite3.Row = Depends(get_current_user),
):
    """Restore one encrypted-backup image asset into the current user's upload area.

    The client sends image bytes only after decrypting a user-owned backup locally.
    The server still validates extension, MIME, size, and magic bytes before writing.
    """
    try:
        raw = base64.b64decode(asset.data_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="Invalid asset data") from None

    if not raw:
        raise HTTPException(status_code=422, detail="Empty asset")
    if len(raw) > MAX_IMAGE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="图片文件太大，请压缩后再恢复")
    if asset.size and asset.size != len(raw):
        raise HTTPException(status_code=422, detail="Asset size mismatch")

    actual_sha256 = hashlib.sha256(raw).hexdigest()
    declared_sha256 = (asset.sha256 or "").strip().lower()
    if declared_sha256 and declared_sha256 != actual_sha256:
        raise HTTPException(status_code=422, detail="Asset checksum mismatch")

    safe_name = Path(asset.filename or "backup-image.jpg").name
    ext = validate_upload_image_metadata(safe_name, asset.mime)
    safe_ext = ensure_safe_uploaded_image(ext, raw)
    user_prefix = safe_filename_prefix(current_user["user_id"]) or "user"
    # 备份恢复使用内容哈希生成稳定文件名，避免同一张备份图片反复恢复时生成多个不同 URL。
    filename = f"backup_{user_prefix}_{actual_sha256[:20]}{safe_ext}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    output_path = UPLOAD_DIR / filename
    if not output_path.exists():
        output_path.write_bytes(raw)
    return {
        "status": "success",
        "data": {
            "path": f"/uploads/{filename}",
            "size": len(raw),
        },
    }


def _validate_sync_change(change: SyncChangeItem) -> None:
    _require_non_empty_string(change.change_id, "change_id")
    _require_non_empty_string(change.entity_id, "entity_id")
    if change.entity_type not in {"diary", "ledger"}:
        raise HTTPException(status_code=422, detail="Invalid entity_type")
    if change.operation not in {"create", "update", "delete"}:
        raise HTTPException(status_code=422, detail="Invalid operation")

    encrypted = change.encrypted_change
    if encrypted.app != "LeafVault":
        raise HTTPException(status_code=422, detail="Invalid encrypted_change app")
    if encrypted.version not in {1, 2}:
        raise HTTPException(status_code=422, detail="Invalid encrypted_change version")
    if encrypted.type != "incremental_change":
        raise HTTPException(status_code=422, detail="Invalid encrypted_change type")

    if encrypted.version == 1:
        if encrypted.kdf != "PBKDF2":
            raise HTTPException(status_code=422, detail="Invalid encrypted_change kdf")
        if not encrypted.iterations or encrypted.iterations <= 0:
            raise HTTPException(status_code=422, detail="Invalid encrypted_change iterations")
        _require_non_empty_string(encrypted.salt or "", "encrypted_change.salt")
    else:
        # v2 增量同步使用当前本地加密空间的 AES-GCM key；服务端只保存密文信封，不解密。
        if encrypted.kdf != "local-encryption-key-v1":
            raise HTTPException(status_code=422, detail="Invalid encrypted_change kdf")

    _require_non_empty_string(encrypted.iv, "encrypted_change.iv")
    encrypted_payload = _require_non_empty_string(encrypted.payload, "encrypted_change.payload")
    _enforce_text_size(
        encrypted_payload,
        limit_bytes=MAX_SYNC_CHANGE_PAYLOAD_BYTES,
        label="encrypted_change.payload",
        message=f"单条同步变更 payload 不能超过 {MAX_SYNC_CHANGE_PAYLOAD_KB}KB",
    )


@router.post("/api/sync/snapshot")
def upload_sync_snapshot(
    snapshot: SnapshotPayload,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    if snapshot.app != "LeafVault":
        raise HTTPException(status_code=422, detail="Invalid app")
    if snapshot.version != 1:
        raise HTTPException(status_code=422, detail="Invalid version")
    if snapshot.kdf != "PBKDF2":
        raise HTTPException(status_code=422, detail="Invalid kdf")
    if snapshot.iterations <= 0:
        raise HTTPException(status_code=422, detail="Invalid iterations")

    snapshot_payload = _require_non_empty_string(snapshot.payload, "payload")
    _enforce_text_size(
        snapshot_payload,
        limit_bytes=MAX_CLOUD_SNAPSHOT_PAYLOAD_BYTES,
        label="snapshot.payload",
        message=f"云端备份 payload 不能超过 {MAX_CLOUD_SNAPSHOT_PAYLOAD_MB}MB",
    )

    encrypted_snapshot = {
        "version": snapshot.version,
        "app": snapshot.app,
        "kdf": snapshot.kdf,
        "iterations": snapshot.iterations,
        "salt": _require_non_empty_string(snapshot.salt, "salt"),
        "iv": _require_non_empty_string(snapshot.iv, "iv"),
        "payload": snapshot_payload,
        "created_at": _require_non_empty_string(snapshot.created_at, "created_at"),
        "device_name": (snapshot.device_name or "").strip()[:120],
    }
    snapshot_name = _normalize_snapshot_meta(
        snapshot.snapshot_name,
        "snapshot_name",
        60,
        "手动云端备份",
    )
    snapshot_note = _normalize_snapshot_meta(snapshot.snapshot_note, "snapshot_note", 200)

    encrypted_blob = json.dumps(encrypted_snapshot, ensure_ascii=False, separators=(",", ":"))
    uploaded_at = datetime.now(timezone.utc).isoformat()
    cursor = db.cursor()
    cursor.execute("SELECT COUNT(*) AS count FROM sync_snapshots WHERE user_id = ?", (current_user["user_id"],))
    existing_count = cursor.fetchone()["count"] or 0
    if existing_count >= MAX_CLOUD_SNAPSHOTS_PER_USER:
        raise HTTPException(status_code=400, detail="云端备份数量已达上限，请删除旧备份后再上传。")
    cursor.execute(
        """
        INSERT INTO sync_snapshots (
            user_id, encrypted_blob, created_at, uploaded_at, device_name, size_bytes, snapshot_name, snapshot_note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            current_user["user_id"],
            encrypted_blob,
            encrypted_snapshot["created_at"],
            uploaded_at,
            encrypted_snapshot["device_name"],
            len(encrypted_blob.encode("utf-8")),
            snapshot_name,
            snapshot_note,
        ),
    )
    db.commit()

    return {
        "status": "success",
        "message": "云端加密备份已保存",
        "snapshot_id": cursor.lastrowid,
        "uploaded_at": uploaded_at,
    }


@router.get("/api/sync/snapshots")
def list_sync_snapshots(
    limit: int = Query(default=20, ge=1, le=20),
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    cursor = db.cursor()
    cursor.execute(
        """
        SELECT id, snapshot_name, snapshot_note, created_at, uploaded_at, device_name, size_bytes
          FROM sync_snapshots
         WHERE user_id = ?
         ORDER BY uploaded_at DESC, id DESC
         LIMIT ?
        """,
        (current_user["user_id"], limit),
    )
    snapshots = [
        {
            "id": row["id"],
            "snapshot_name": row["snapshot_name"] or "",
            "snapshot_note": row["snapshot_note"] or "",
            "created_at": row["created_at"],
            "uploaded_at": row["uploaded_at"],
            "device_name": row["device_name"] or "",
            "size_bytes": row["size_bytes"] or 0,
        }
        for row in cursor.fetchall()
    ]
    return {
        "status": "success",
        "data": snapshots,
        "count": len(snapshots),
        "max_cloud_snapshots_per_user": MAX_CLOUD_SNAPSHOTS_PER_USER,
        "max_cloud_snapshot_payload_mb": MAX_CLOUD_SNAPSHOT_PAYLOAD_MB,
        "max_upload_size_mb": MAX_UPLOAD_SIZE_MB,
    }


@router.get("/api/sync/snapshots/{snapshot_id}")
def download_sync_snapshot(
    snapshot_id: int,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    cursor = db.cursor()
    cursor.execute(
        """
        SELECT encrypted_blob, snapshot_name, snapshot_note
          FROM sync_snapshots
         WHERE id = ? AND user_id = ?
        """,
        (snapshot_id, current_user["user_id"]),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Snapshot not found")

    try:
        encrypted_backup = json.loads(row["encrypted_blob"])
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Snapshot data is invalid") from None

    encrypted_backup["snapshot_name"] = row["snapshot_name"] or ""
    encrypted_backup["snapshot_note"] = row["snapshot_note"] or ""

    return {"status": "success", "data": encrypted_backup}


@router.delete("/api/sync/snapshots/{snapshot_id}")
def delete_sync_snapshot(
    snapshot_id: int,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    cursor = db.cursor()
    cursor.execute(
        """
        DELETE FROM sync_snapshots
         WHERE id = ? AND user_id = ?
        """,
        (snapshot_id, current_user["user_id"]),
    )
    if cursor.rowcount <= 0:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    db.commit()

    return {"status": "success", "message": "云端备份已删除"}


@router.get("/api/sync/changes")
def list_sync_changes(
    limit: int = Query(default=100, ge=1, le=200),
    since_uploaded_at: Optional[str] = Query(default=None),
    exclude_device_id: Optional[str] = Query(default=None),
    entity_type: Optional[str] = Query(default=None),
    include_own: bool = Query(default=True),
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    if entity_type and entity_type not in {"diary", "ledger"}:
        raise HTTPException(status_code=422, detail="Invalid entity_type")

    clauses = ["user_id = ?"]
    params: list[object] = [current_user["user_id"]]

    if since_uploaded_at:
        clauses.append("uploaded_at > ?")
        params.append(since_uploaded_at)
    if entity_type:
        clauses.append("entity_type = ?")
        params.append(entity_type)
    if exclude_device_id:
        clauses.append("device_id != ?")
        params.append(exclude_device_id)
    elif include_own is False:
        # The server intentionally does not infer a device id from auth state.
        # Clients should send exclude_device_id when they want other-device changes only.
        clauses.append("1 = 1")

    params.append(limit)
    cursor = db.cursor()
    cursor.execute(
        f"""
        SELECT id, change_id, entity_type, entity_id, operation,
               device_id, client_sequence, base_revision, local_revision,
               created_at, uploaded_at
          FROM sync_changes
         WHERE {' AND '.join(clauses)}
         ORDER BY uploaded_at ASC, id ASC
         LIMIT ?
        """,
        params,
    )
    rows = [
        {
            "id": row["id"],
            "change_id": row["change_id"],
            "entity_type": row["entity_type"],
            "entity_id": row["entity_id"],
            "operation": row["operation"],
            "device_id": row["device_id"] or "",
            "client_sequence": row["client_sequence"] or 0,
            "base_revision": row["base_revision"] or 0,
            "local_revision": row["local_revision"] or 0,
            "created_at": row["created_at"] or "",
            "uploaded_at": row["uploaded_at"],
        }
        for row in cursor.fetchall()
    ]
    return {"status": "success", "data": rows, "count": len(rows)}


@router.get("/api/sync/diagnostics/summary")
def get_sync_diagnostics_summary(
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    """Return ciphertext-sync health counts without exposing payloads."""
    cursor = db.cursor()
    cursor.execute(
        "SELECT COUNT(*) AS count, MAX(uploaded_at) AS latest_uploaded_at "
        "FROM sync_changes WHERE user_id = ?",
        (current_user["user_id"],),
    )
    changes = cursor.fetchone()
    cursor.execute(
        "SELECT COUNT(*) AS count, MAX(uploaded_at) AS latest_uploaded_at "
        "FROM sync_snapshots WHERE user_id = ?",
        (current_user["user_id"],),
    )
    snapshots = cursor.fetchone()
    return {
        "status": "success",
        "data": {
            "sync_changes_count": changes["count"] or 0,
            "snapshots_count": snapshots["count"] or 0,
            "latest_change_uploaded_at": changes["latest_uploaded_at"] or "",
            "latest_snapshot_uploaded_at": snapshots["latest_uploaded_at"] or "",
        },
    }


@router.get("/api/sync/changes/{change_id}")
def download_sync_change(
    change_id: str,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    normalized_change_id = _require_non_empty_string(change_id, "change_id")
    cursor = db.cursor()
    cursor.execute(
        """
        SELECT change_id, entity_type, entity_id, operation, encrypted_change,
               device_id, client_sequence, base_revision, local_revision,
               created_at, uploaded_at
          FROM sync_changes
         WHERE change_id = ? AND user_id = ?
        """,
        (normalized_change_id, current_user["user_id"]),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Change not found")

    try:
        encrypted_change = json.loads(row["encrypted_change"])
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Change data is invalid") from None

    return {
        "status": "success",
        "data": {
            "change_id": row["change_id"],
            "entity_type": row["entity_type"],
            "entity_id": row["entity_id"],
            "operation": row["operation"],
            "encrypted_change": encrypted_change,
            "device_id": row["device_id"] or "",
            "client_sequence": row["client_sequence"] or 0,
            "base_revision": row["base_revision"] or 0,
            "local_revision": row["local_revision"] or 0,
            "created_at": row["created_at"] or "",
            "uploaded_at": row["uploaded_at"],
        },
    }


@router.post("/api/sync/changes/batch")
def upload_sync_changes_batch(
    payload: SyncChangeBatchPayload,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    if len(payload.changes) > MAX_SYNC_CHANGE_BATCH_SIZE:
        raise HTTPException(status_code=400, detail=f"单次最多上传 {MAX_SYNC_CHANGE_BATCH_SIZE} 条同步变更")
    if not payload.changes:
        return {
            "status": "success",
            "message": "待同步变更已上传",
            "saved": 0,
            "skipped": 0,
            "failed": 0,
            "saved_change_ids": [],
            "skipped_change_ids": [],
            "errors": [],
        }

    for change in payload.changes:
        _validate_sync_change(change)

    uploaded_at = datetime.now(timezone.utc).isoformat()
    saved_change_ids: list[str] = []
    skipped_change_ids: list[str] = []
    errors: list[dict] = []
    cursor = db.cursor()

    for change in payload.changes:
        encrypted_change = json.dumps(
            _model_to_dict(change.encrypted_change),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        try:
            cursor.execute(
                """
                INSERT INTO sync_changes (
                    user_id, change_id, entity_type, entity_id, operation,
                    encrypted_change, device_id, client_sequence,
                    base_revision, local_revision, created_at, uploaded_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    current_user["user_id"],
                    change.change_id.strip(),
                    change.entity_type,
                    change.entity_id.strip(),
                    change.operation,
                    encrypted_change,
                    (change.device_id or "").strip()[:120],
                    int(change.client_sequence or 0),
                    int(change.base_revision or 0),
                    int(change.local_revision or 0),
                    (change.created_at or "").strip(),
                    uploaded_at,
                ),
            )
            saved_change_ids.append(change.change_id.strip())
        except sqlite3.IntegrityError:
            skipped_change_ids.append(change.change_id.strip())
        except sqlite3.DatabaseError:
            errors.append({"change_id": change.change_id.strip(), "message": "save failed"})

    db.commit()
    return {
        "status": "success",
        "message": "待同步变更已上传",
        "saved": len(saved_change_ids),
        "skipped": len(skipped_change_ids),
        "failed": len(errors),
        "saved_change_ids": saved_change_ids,
        "skipped_change_ids": skipped_change_ids,
        "errors": errors,
        "uploaded_at": uploaded_at,
    }
