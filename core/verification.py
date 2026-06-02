import hmac
from datetime import datetime

from core.config import SECRET_KEY


MAX_CODE_ATTEMPTS = 5


def _hash_code(code: str, action_type: str = "") -> str:
    message = f"{action_type}:{code}".encode()
    return hmac.new(SECRET_KEY.encode(), message, "sha256").hexdigest()


def verify_code(cursor, email: str, code: str, action_type: str) -> bool:
    cursor.execute(
        "SELECT id, code_hash, expires_at, attempts, action_type FROM verification_codes "
        "WHERE email = ? AND action_type = ? AND used = 0 ORDER BY id DESC LIMIT 1",
        (email, action_type),
    )
    record = cursor.fetchone()
    if not record:
        return False

    try:
        exp = datetime.strptime(record["expires_at"], "%Y-%m-%d %H:%M:%S.%f")
    except ValueError:
        exp = datetime.strptime(record["expires_at"], "%Y-%m-%d %H:%M:%S")

    if exp < datetime.now():
        return False
    if int(record["attempts"] or 0) >= MAX_CODE_ATTEMPTS:
        cursor.execute("UPDATE verification_codes SET used = 1 WHERE id = ?", (record["id"],))
        return False

    if not hmac.compare_digest(record["code_hash"], _hash_code(code, action_type)):
        next_attempts = int(record["attempts"] or 0) + 1
        used = 1 if next_attempts >= MAX_CODE_ATTEMPTS else 0
        cursor.execute(
            "UPDATE verification_codes SET attempts = ?, used = ? WHERE id = ?",
            (next_attempts, used, record["id"]),
        )
        return False

    cursor.execute("UPDATE verification_codes SET used = 1 WHERE id = ?", (record["id"],))
    return True
