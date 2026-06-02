# LeafVault 公网部署指南

本文用于指导 LeafVault v0.1 在个人 VPS 上进行公网自托管部署


## 1. 适用范围

适用：

- 个人 VPS / 云服务器自托管。
- Docker Compose 启动 `leafvault` 与 `caddy`。
- Caddy 负责公网 80/443 与 HTTPS。
- FastAPI 容器只在 Docker 网络内暴露 `8000`。
- SQLite 数据库存放在 `./data`。
- 用户上传图片存放在 `./uploads`。
- `.env.production` 保存 Docker / 服务器部署配置，不进入 Git，不进入镜像。


## 2. 部署前准备

部署前至少准备：

- 一台 Linux VPS。
- 一个已经解析到服务器公网 IP 的域名。
- 服务器开放 `80` 和 `443` 端口。
- 服务器已安装 Docker 和 Docker Compose。
- 项目代码已同步到服务器。
- 真实 `.env.production` 已准备完成。
- 已经在本地或服务器运行过质量门禁。

建议目录：

```text
LeafVault/
  docker-compose.prod.yml
  .env.production
  data/
  uploads/
  backups/
  deploy/
```

目录含义：

| 路径 | 作用 | 是否需要备份 |
| --- | --- | --- |
| `.env.production` | 生产环境变量、密钥、邮箱授权码、AI Key | 是，单独安全保存 |
| `data/` | SQLite 数据库 | 是 |
| `uploads/` | 头像、日记图片等用户上传文件 | 是 |
| `backups/` | 服务器级备份包 | 建议下载到本地或其他位置 |
| `deploy/` | Caddyfile 等部署配置 | 建议备份 |

注意：Docker volume 不是备份。删除 `data/` 或 `uploads/` 会导致业务数据或图片丢失。

## 3. 生产环境变量

生产环境建议使用项目根目录下的 `.env.production`，不要提交到 Git。本地开发才使用 `.env`。

最小生产配置示例：

```env
ENVIRONMENT=production
DEPLOYMENT_MODE=public
PUBLIC_BASE_URL=https://your-domain.com
LEAFVAULT_DOMAIN=your-domain.com

TRUSTED_HOSTS=your-domain.com,www.your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
FORCE_HTTPS=true

DATABASE_PATH=/app/data/leafvault.db
UPLOAD_DIR=/app/uploads

SECRET_KEY=请替换为足够长的随机字符串
COOKIE_SECURE=true
AUTH_PREFER_COOKIE=true
AUTH_STORE_TOKEN_IN_LOCALSTORAGE=false
AUTH_ALLOW_BEARER_FALLBACK=true

REGISTRATION_MODE=invite
REGISTRATION_INVITE_CODE=请替换为真实邀请码

SENDER_EMAIL=你的发信邮箱
SENDER_PASSWORD=你的SMTP授权码
SMTP_SERVER=smtp.qq.com
SMTP_PORT=465

AI_API_KEY=你的DeepSeek API Key
AI_BASE_URL=https://api.deepseek.com

MAX_UPLOAD_SIZE_MB=10
MAX_DIARY_IMAGES_PER_ENTRY=9
MAX_CLOUD_SNAPSHOTS_PER_USER=5
MAX_CLOUD_SNAPSHOT_PAYLOAD_MB=100
MAX_SYNC_BATCH_SIZE=100
MAX_SYNC_CHANGE_PAYLOAD_KB=512
SERVER_UPLOAD_ENABLED=true
DEMO_SERVER_UPLOAD_ENABLED=false
```

生产硬性要求：

- `PUBLIC_BASE_URL` 必须是 `https://`。
- `TRUSTED_HOSTS` 不能是 `*`。
- `ALLOWED_ORIGINS` 不能是 `*`。
- `COOKIE_SECURE=true`。
- `SECRET_KEY` 不能使用默认值，也不能过短。
- `DATABASE_PATH` 与 `UPLOAD_DIR` 必须明确配置。
- 公开部署时不建议 `REGISTRATION_MODE=open`。
- `.env.production`、邀请码、SMTP 授权码、AI Key 不得提交到 Git。

## 4. Docker Compose 结构

本机 Docker 测试约定：`leafvault` 容器内部仍监听 `8000`，通过 `docker-compose.local.yml` 把宿主机映射到 `8001`，浏览器请访问 `http://127.0.0.1:8001`。这样可以避免和日常本地 `uvicorn :8000` 冲突。正式公网部署不要叠加 `docker-compose.local.yml`，公网访问应走 Caddy 的 `80/443` 和 HTTPS 域名，不要发布 `8000:8000` 或 `8001:8000`。

`docker-compose.prod.yml` 建议保持以下边界：

- `leafvault` 只使用 `expose: 8000`，不直接映射公网端口。
- `caddy` 暴露 `80:80` 和 `443:443`。
- `leafvault` 挂载：
  - `./data:/app/data`
  - `./uploads:/app/uploads`
- `caddy` 使用 `deploy/Caddyfile.prod.example` 或正式 `deploy/Caddyfile`。
- `leafvault` 和 `caddy` 开启 Docker JSON 日志滚动，避免日志占满磁盘。

Caddy 示例：

```caddy
{$LEAFVAULT_DOMAIN} {
    reverse_proxy leafvault:8000
}
```

如果你使用 `www` 子域名，可以额外增加：

```caddy
www.{$LEAFVAULT_DOMAIN} {
    redir https://{$LEAFVAULT_DOMAIN}{uri} permanent
}
```

实际使用时请确认你的 Caddyfile 写法和 `LEAFVAULT_DOMAIN` 变量匹配。

## 5. 部署前预检

本地或服务器运行：

```powershell
python scripts/quality_gate.py
```

检查示例部署文件：

```powershell
python scripts/public_deploy_preflight.py --example
```

预检通过后再执行生产启动。

## 6. 首次生产启动流程

进入项目目录：

```bash
cd LeafVault
```

创建持久化目录：

```bash
mkdir -p data uploads backups deploy
```

确认 `.env.production` 已存在：

```bash
ls -la .env.production
```

启动生产容器：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

本地 Docker 测试使用：

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml up -d --build
```

浏览器访问：

```text
http://127.0.0.1:8001
```

查看容器状态：

```bash
docker compose -f docker-compose.prod.yml ps
```

查看后端日志：

```bash
docker compose -f docker-compose.prod.yml logs -f leafvault
```

查看 Caddy 日志：

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
```

## 7. 部署后健康检查

浏览器访问：

```text
https://your-domain.com/api/health
```

期望返回：

```json
{"status":"ok"}
```

继续访问：

```text
https://your-domain.com/api/deployment/status
```

应确认返回中包含以下非敏感字段：

- `deployment_mode`
- `environment`
- `registration_mode`
- `registration_requires_invite`
- `cookie_secure_required`
- `https_required`
- `max_upload_size_mb`
- `max_cloud_snapshots_per_user`
- `demo_server_upload_enabled`
- `server_upload_enabled`

该接口不应返回：

- `SECRET_KEY`
- 邀请码
- AI Key
- 邮箱授权码
- SMTP 密码
- 数据库绝对路径
- 上传目录绝对路径
- token / CSRF / 密文 payload 全文

## 8. 公网功能验收

建议按顺序验证：

1. 打开首页。
2. 进入 Demo 模式。
3. Demo 新建一篇日记。
4. Demo 添加一笔账本。
5. Demo 云端备份、同步、AI 功能被温和拦截。
6. 使用邀请码注册正式账号。
7. 正式账号登录成功。
8. 刷新页面后 Cookie session 仍有效。
9. 正式账号写日记、上传图片、编辑、删除正常。
10. 添加账本后月度统计、生活日历正常更新。
11. 本地加密导出 `.lvbackup` 成功。
12. 云端密文备份上传、列表、下载、删除成功。
13. 手动同步向导可以打开，冲突不会自动覆盖本地数据。
14. AI 润色可用；未配置 AI Key 时能给出温和提示。
15. PWA 可添加到桌面。
16. 退出登录后无法访问受保护数据。

## 9. 资源保护基线

v0.1 默认不是无限存储服务。便宜 VPS 应控制资源增长：

- 限制单张图片大小：`MAX_UPLOAD_SIZE_MB`。
- 限制单篇日记图片数量：`MAX_DIARY_IMAGES_PER_ENTRY`。
- 限制每个用户云端密文快照数量：`MAX_CLOUD_SNAPSHOTS_PER_USER`。
- 限制单个快照 payload 大小：`MAX_CLOUD_SNAPSHOT_PAYLOAD_MB`。
- 限制单次同步变更数量：`MAX_SYNC_BATCH_SIZE`。
- 限制单条同步密文大小：`MAX_SYNC_CHANGE_PAYLOAD_KB`。
- 正式账号服务器上传能力由 `SERVER_UPLOAD_ENABLED` 控制。
- Demo 模式默认不占用服务器上传空间：`DEMO_SERVER_UPLOAD_ENABLED=false`。

达到快照上限时，应用应拒绝新上传，并提示用户先删除旧备份。不要自动删除用户有效备份。

## 10. 认证与 Cookie 边界

v0.1 生产推荐：

```env
AUTH_PREFER_COOKIE=true
AUTH_STORE_TOKEN_IN_LOCALSTORAGE=false
AUTH_ALLOW_BEARER_FALLBACK=true
COOKIE_SECURE=true
```

说明：

- Cookie 优先是当前生产推荐路径。
- `AUTH_ALLOW_BEARER_FALLBACK=true` 是迁移兼容，方便旧 PWA 缓存、本地调试和异常兜底。
- 后续更安全目标是 Cookie-only，并逐步设置 `AUTH_ALLOW_BEARER_FALLBACK=false`。
- Cookie 模式写请求必须带 CSRF header。

## 11. 邮箱与 AI 配置

### 邮箱验证码

生产环境不会启用固定验证码。公网部署时必须满足其中一种：

- 配置真实 SMTP：`SENDER_EMAIL`、`SENDER_PASSWORD`、`SMTP_SERVER`、`SMTP_PORT`。
- 或将注册模式设置为 `invite` / `closed`，避免开放注册流程不可用。

`SENDER_PASSWORD` 应使用邮箱 SMTP 授权码，不要使用邮箱登录密码。

### AI 润色

DeepSeek 配置建议：

```env
AI_API_KEY=你的DeepSeek API Key
AI_BASE_URL=https://api.deepseek.com
```

模型名应由后端 `VALID_MODELS` 管理，例如：

```python
VALID_MODELS = {
    "chat": "deepseek-v4-flash",
    "reason": "deepseek-v4-pro",
}
```

不要把 AI Key 写进 README、截图、部署文档示例或 Git 提交记录。

## 12. 备份与恢复

生产部署后建议定期执行：

```bash
python scripts/ops_status.py --data ./data --uploads ./uploads --backups ./backups --url https://your-domain.com
python scripts/ops_backup.py --db ./data/leafvault.db --uploads ./uploads --out ./backups --keep 7
```

检查备份包：

```bash
python scripts/ops_backup_check.py --file ./backups/leafvault-backup-xxxx.zip
```

备份策略：

- 服务器级备份包含 SQLite 与 `uploads/`。
- `.env.production` 不应自动打进备份包，需要单独安全保存。
- 备份包建议下载到本地或其他安全位置。
- 恢复前先停止容器，并备份当前 `data/`、`uploads/`。

## 13. 更新部署流程

每次更新建议流程：

```bash
python scripts/quality_gate.py
python scripts/ops_backup.py --db ./data/leafvault.db --uploads ./uploads --out ./backups --keep 7
git pull
docker compose -f docker-compose.prod.yml up -d --build
python scripts/ops_status.py --data ./data --uploads ./uploads --backups ./backups --url https://your-domain.com
```

更新后至少手动验证：

- 首页可打开。
- 登录状态正常。
- 日记与图片正常。
- 账本与统计正常。
- 本地加密导出正常。
- 云端备份列表正常。
- `/api/health` 正常。

## 14. 常见问题排查

### 域名打不开

检查：

- DNS 是否指向当前服务器 IP。
- 服务器安全组是否开放 80/443。
- Caddy 是否启动成功。
- `LEAFVAULT_DOMAIN` 是否和实际访问域名一致。

### HTTPS 证书失败

检查：

```bash
docker compose -f docker-compose.prod.yml logs caddy
```

常见原因：

- DNS 未生效。
- 80 端口被占用或未开放。
- 域名没有正确指向服务器。

### 后端 502

检查：

```bash
docker compose -f docker-compose.prod.yml logs leafvault
```

常见原因：

- `.env.production` 缺少必需配置。
- `data/` 或 `uploads/` 不可写。
- 生产预检未通过。
- 数据库路径配置错误。

### 登录或 CSRF 异常

检查：

- 是否通过 HTTPS 访问。
- `COOKIE_SECURE=true`。
- `PUBLIC_BASE_URL` 与实际域名一致。
- `ALLOWED_ORIGINS` 包含当前域名。
- 浏览器是否禁用了 Cookie。
- 退出后重新登录是否恢复。

### 图片不显示

检查：

- `uploads/` 是否挂载到容器。
- 恢复时是否同步恢复了 `uploads/`。
- 反向代理是否阻断静态文件路径。
- 图片路径是否仍是安全相对路径。

