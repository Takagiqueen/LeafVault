# LeafVault v0.1 轻量运维指南

## 推荐目录结构

```text
LeafVault/
  docker-compose.prod.yml
  .env
  data/
  uploads/
  backups/
  deploy/
```

- `data/` 保存 SQLite 数据库。
- `uploads/` 保存头像和日记图片。
- `backups/` 保存服务器级备份包。
- `.env` 需要单独安全保存，不会进入自动备份包。
- `deploy/` 保存 Caddyfile 等部署配置。
- 删除 `data/` 或 `uploads/` 会导致数据丢失。
- Docker volume 不是备份。

## 每周建议

- 运行一次状态检查。
- 生成一次服务器级备份。
- 下载一份备份到本地或其他安全位置。
- 检查 `backups/` 数量和大小。
- 检查 `uploads/` 是否异常增长。
- 查看 `docker compose logs` 是否有明显错误。

## 备份命令

```bash
python scripts/ops_backup.py --db ./data/leafvault.db --uploads ./uploads --out ./backups --keep 7
```

说明：

- 备份包包含 SQLite 数据库副本和 `uploads/`。
- 备份包不包含 `.env`、日志、`repomix-output.xml` 或密钥。
- `--keep 7` 会保留最近 7 个备份包，减少服务器磁盘压力。

## 备份检查命令

```bash
python scripts/ops_backup_check.py --file ./backups/leafvault-backup-xxxx.zip
```

检查内容包括 zip 是否可打开、数据库是否可读、manifest 是否存在，以及备份包是否误包含 `.env`、日志或明显敏感字段。

## 图片垃圾清理

v0.1 不自动删除 `uploads/` 中无法确认引用关系的文件，避免误删仍在使用的图片。日记删除、移除图片、头像更新后，如果担心上传目录长期增长，可以先运行安全 dry-run：

```bash
python scripts/cleanup_unreferenced_uploads.py --db ./data/leafvault.sqlite3 --uploads ./uploads
```

确认候选文件确实不再需要后，再手动启用删除：

```bash
python scripts/cleanup_unreferenced_uploads.py --db ./data/leafvault.sqlite3 --uploads ./uploads --apply
```

该脚本只检查图片路径引用，不读取日记正文、账本备注，也不会读取 `.env`。执行前仍建议先做一次服务器级备份。

## 状态检查命令

```bash
python scripts/ops_status.py --data ./data --uploads ./uploads --backups ./backups --url https://your-domain.com
```

如果不传 `--url`，脚本不会联网，只检查本地目录、SQLite 和磁盘占用。

## 更新部署流程

```bash
python scripts/quality_gate.py
python scripts/ops_backup.py --db ./data/leafvault.db --uploads ./uploads --out ./backups --keep 7
git pull
docker compose -f docker-compose.prod.yml up -d --build
python scripts/ops_status.py --data ./data --uploads ./uploads --backups ./backups --url https://your-domain.com
```

更新前建议先在 LeafVault 内上传一份云端加密备份，再做服务器级备份。

## Docker 日志限制

`docker-compose.prod.yml` 为 `leafvault` 和 `caddy` 配置了：

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

这可以避免 Docker JSON 日志无限增长，但仍建议定期查看服务器磁盘占用。

## 常见问题

### 磁盘快满

- 运行 `ops_status.py` 查看 `uploads/` 和 `backups/` 大小。
- 下载旧备份到本地后，删除服务器上的旧备份。
- 检查是否有异常大的上传图片。

### 图片不显示

- 确认 `uploads/` 已挂载到容器。
- 确认恢复时 `uploads/` 也同步恢复。
- 确认反向代理没有阻断静态图片路径。

### 登录异常

- 确认 `.env` 中 `SECRET_KEY` 与原部署一致。
- 更换 `SECRET_KEY` 后，旧 token 可能失效，用户需要重新登录。
- Cookie 模式生产环境需要 HTTPS。

### CSRF 失败

- 确认通过 HTTPS 访问公网域名。
- 确认浏览器没有拦截 Cookie。
- 退出后重新登录通常可以刷新 CSRF Cookie。

### Caddy 证书失败

- 确认域名 DNS 指向当前服务器。
- 确认 80/443 端口开放。
- 查看 `docker compose -f docker-compose.prod.yml logs caddy`。

### 备份包过大

- 主要原因通常是 `uploads/` 图片增长。
- LeafVault v0.1 已限制图片大小和云端快照数量，但仍建议定期清理旧服务器级备份。

## 便宜服务器建议

- 限制正式用户数量。
- Demo 模式不上传服务器。
- 保持云端快照数量上限。
- 保持图片大小限制。
- 定期下载备份到本地后清理服务器旧备份。
- 不要把 Docker 容器或 VPS 磁盘当成唯一备份。
