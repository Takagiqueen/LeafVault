import sqlite3
import uuid

from core.config import ADMIN_INIT_PASSWORD, DB_PATH, logger
from core.passwords import hash_password


def init_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    cursor = conn.cursor()
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       TEXT    UNIQUE NOT NULL,
            username      TEXT    UNIQUE NOT NULL,
            email         TEXT    DEFAULT '',
            avatar_url    TEXT    DEFAULT '',
            password_hash TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS verification_codes (
            id         INTEGER  PRIMARY KEY AUTOINCREMENT,
            email      TEXT     NOT NULL,
            action_type TEXT     DEFAULT 'register',
            code_hash  TEXT     NOT NULL,
            expires_at DATETIME NOT NULL,
            used       INTEGER  DEFAULT 0,
            attempts   INTEGER  DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS diaries (
            id          INTEGER  PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT     NOT NULL,
            -- Legacy compatibility only. Ownership must always use user_id.
            username    TEXT     DEFAULT '',
            date        TEXT     NOT NULL,
            mood_label  TEXT     NOT NULL,
            content     TEXT     NOT NULL,
            image_paths TEXT,
            is_pinned   INTEGER  DEFAULT 0,
            updated_at  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, date)
        );
        CREATE TABLE IF NOT EXISTS ledgers (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT    NOT NULL,
            -- Legacy compatibility only. Ownership must always use user_id.
            username   TEXT    DEFAULT '',
            type       TEXT    NOT NULL,
            amount     REAL    NOT NULL,
            category   TEXT    NOT NULL,
            note       TEXT,
            uuid       TEXT,
            created_at TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_snapshots (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id        TEXT NOT NULL,
            encrypted_blob TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            uploaded_at    TEXT NOT NULL,
            device_name    TEXT,
            size_bytes     INTEGER,
            snapshot_name  TEXT,
            snapshot_note  TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_changes (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id          TEXT NOT NULL,
            change_id        TEXT NOT NULL,
            entity_type      TEXT NOT NULL,
            entity_id        TEXT NOT NULL,
            operation        TEXT NOT NULL,
            encrypted_change TEXT NOT NULL,
            device_id        TEXT,
            client_sequence  INTEGER,
            base_revision    INTEGER,
            local_revision   INTEGER,
            created_at       TEXT,
            uploaded_at      TEXT NOT NULL,
            UNIQUE(user_id, change_id)
        );
    """)

    # Backward-compatible schema patches only; do not change existing meanings.
    for table, col, col_type in [
        ("users", "user_id", "TEXT"),
        ("users", "email", "TEXT DEFAULT ''"),
        ("users", "avatar_url", "TEXT DEFAULT ''"),
        ("verification_codes", "action_type", "TEXT DEFAULT 'register'"),
        ("verification_codes", "attempts", "INTEGER DEFAULT 0"),
        ("diaries", "user_id", "TEXT"),
        ("diaries", "username", "TEXT DEFAULT ''"),
        ("diaries", "image_paths", "TEXT"),
        ("diaries", "is_pinned", "INTEGER DEFAULT 0"),
        ("diaries", "updated_at", "TEXT"),
        ("ledgers", "user_id", "TEXT"),
        ("ledgers", "username", "TEXT DEFAULT ''"),
        ("ledgers", "category", "TEXT DEFAULT ''"),
        ("ledgers", "note", "TEXT"),
        ("ledgers", "uuid", "TEXT"),
        ("ledgers", "created_at", "TEXT"),
        ("sync_snapshots", "device_name", "TEXT"),
        ("sync_snapshots", "size_bytes", "INTEGER"),
        ("sync_snapshots", "snapshot_name", "TEXT"),
        ("sync_snapshots", "snapshot_note", "TEXT"),
    ]:
        try:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}")
        except sqlite3.OperationalError:
            pass

    # Backfill immutable user_id and migrate old rows that were originally keyed by username.
    # This is a one-time compatibility bridge; new ownership checks must never use username.
    cursor.execute("SELECT id FROM users WHERE user_id IS NULL OR user_id = ''")
    for row in cursor.fetchall():
        cursor.execute("UPDATE users SET user_id = ? WHERE id = ?", (str(uuid.uuid4()), row[0]))

    cursor.execute("SELECT id FROM users WHERE user_id IS NOT NULL AND username = 'admin'")
    if not cursor.fetchone():
        cursor.execute(
            "INSERT INTO users (user_id, username, email, password_hash) VALUES (?, ?, ?, ?)",
            (str(uuid.uuid4()), "admin", "admin@admin.com", hash_password(ADMIN_INIT_PASSWORD)),
        )
        logger.info("Default admin account created; check ADMIN_INIT_PASSWORD.")

    cursor.execute("""
        UPDATE diaries
           SET user_id = (SELECT users.user_id FROM users WHERE users.username = diaries.username)
         WHERE (user_id IS NULL OR user_id = '')
           AND username IS NOT NULL
           AND username != ''
    """)
    cursor.execute("""
        UPDATE ledgers
           SET user_id = (SELECT users.user_id FROM users WHERE users.username = ledgers.username)
         WHERE (user_id IS NULL OR user_id = '')
           AND username IS NOT NULL
           AND username != ''
    """)

    for stmt in [
        "DROP INDEX IF EXISTS idx_diaries_user_date",
        "DROP INDEX IF EXISTS idx_ledgers_uuid",
        "DROP INDEX IF EXISTS idx_ledgers_user_date",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != ''",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_diaries_user_id_date ON diaries(user_id, date) WHERE user_id IS NOT NULL AND user_id != ''",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_user_uuid ON ledgers(user_id, uuid) WHERE uuid IS NOT NULL AND uuid != ''",
        "CREATE INDEX IF NOT EXISTS idx_ledgers_user_id_date ON ledgers(user_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_sync_snapshots_user_uploaded ON sync_snapshots(user_id, uploaded_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_changes_user_change_id ON sync_changes(user_id, change_id)",
        "CREATE INDEX IF NOT EXISTS idx_sync_changes_user_uploaded ON sync_changes(user_id, uploaded_at)",
        "CREATE INDEX IF NOT EXISTS idx_sync_changes_user_entity ON sync_changes(user_id, entity_type, entity_id)",
        "CREATE INDEX IF NOT EXISTS idx_codes_email ON verification_codes(email)",
        "CREATE INDEX IF NOT EXISTS idx_codes_email_action ON verification_codes(email, action_type)",
    ]:
        try:
            cursor.execute(stmt)
        except sqlite3.DatabaseError as e:
            logger.warning(f"Database index initialization skipped: {e}")

    conn.commit()
    conn.close()
