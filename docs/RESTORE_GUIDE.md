# LeafVault 恢复指南

本文说明如何从 `scripts/ops_backup.py` 生成的服务器级备份包恢复 LeafVault v0.1 部署。它面向小范围自托管场景，不替代应用内加密备份。

## 恢复前提醒

- 先停止服务，避免恢复过程中数据库继续写入。
- 先备份当前 `data/` 和 `uploads/`，不要覆盖唯一副本。
- 先运行 `ops_backup_check.py` 确认备份包结构可用。
- 不要从不可信来源恢复 `.env`。
- 服务器级备份包默认不包含 `.env`、`SECRET_KEY`、邀请码、API Key 或邮箱密码。

## 恢复步骤示例

```bash
docker compose -f docker-compose.prod.yml down
mkdir -p restore_tmp
python scripts/ops_backup_check.py --file ./backups/leafvault-backup-xxxx.zip
```

然后手动解压备份包：

```text
database/leafvault.db
uploads/
manifest.json
```

将文件恢复到部署目录：

```bash
# 示例命令，请先确认路径无误
cp restore_tmp/database/leafvault.db ./data/leafvault.db
cp -r restore_tmp/uploads/. ./uploads/
docker compose -f docker-compose.prod.yml up -d
```

## 恢复后检查

- 访问 `https://your-domain.com/api/health`。
- 访问 `https://your-domain.com/api/deployment/status`。
- 使用正式账号登录。
- 打开日记和账本，确认基础数据可读。
- 打开带图片的日记，确认 `uploads/` 图片可以显示。
- 打开云端备份列表，确认快照元数据可见。

## 注意事项

- `.env` 不在自动备份包中，需要单独安全保存。
- `SECRET_KEY` 丢失或更换可能导致历史登录 token 失效，用户需要重新登录。
- `uploads/` 缺失会导致头像或日记图片无法显示。
- 应用内加密备份和服务器级备份不是一回事：
  - 应用内加密备份适合用户个人数据迁移和兜底恢复。
  - 服务器级备份适合恢复部署目录中的 SQLite 和上传文件。
- Docker volume 不是备份。删除 `data/` 或 `uploads/` 目录会导致数据丢失。
