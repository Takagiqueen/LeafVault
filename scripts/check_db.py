import sqlite3
from pathlib import Path

db_path = Path("data/leafvault.sqlite3")

print("DB exists:", db_path.exists())
print("DB path:", db_path.resolve())

if not db_path.exists():
    raise SystemExit("数据库文件不存在")

con = sqlite3.connect(db_path)
cur = con.cursor()

print("\nTables:")
tables = cur.execute(
    "select name from sqlite_master where type = ? order by name",
    ("table",)
).fetchall()
print(tables)

print("\nUsers:")
try:
    users = cur.execute(
        "select email, username, user_id from users"
    ).fetchall()
    print(users)
except Exception as e:
    print("读取 users 表失败:", repr(e))

con.close()
