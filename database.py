"""Compatibility entry for the current LeafVault database initializer.

历史上这个文件直接创建旧版表结构。当前项目的唯一数据库初始化入口
是 db.init_db.init_db()，这里保留同名函数，避免误运行旧建表逻辑。
"""

from db.init_db import init_db


if __name__ == "__main__":
    init_db()
