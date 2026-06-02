import sqlite3

from core.config import DB_PATH


def get_db():
    # Close the SQLite connection after each FastAPI dependency scope.
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")

    try:
        yield conn
    finally:
        conn.close()
