# LeafVault Docker 自托管部署指南

## 适用场景

本指南适用于：

- 本地 Docker 测试
- 个人 VPS 自托管
- 局域网部署
- 小规模个人使用

本指南不包含：

- Kubernetes
- 高并发集群
- 企业级多副本部署
- 自动 HTTPS 证书管理

## 前置要求

- Docker
- Docker Compose
- Git
- 可选：域名
- 可选：Nginx / Caddy 反向代理

本地 Docker 测试可以直接使用 HTTP；公网生产必须使用 HTTPS 反向代理。当前推荐使用 Caddy 负责公网 80/443 和自动 HTTPS，LeafVault 容器不要直接暴露公网端口。

## 快速启动步骤

```bash
git clone <your-repo-url>
cd LeafVault
cp .env.production.example .env.production
# 编辑 .env.production，至少修改 SECRET_KEY、域名、TRUSTED_HOSTS、ALLOWED_ORIGINS
docker compose -f docker-compose.prod.yml up -d --build
```

访问：

```text
https://your-domain.com
```

本地 Docker 测试可以叠加 `docker-compose.local.yml`：

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml up -d --build
```

然后访问：

```text
http://127.0.0.1:8001
```

健康检查：

```text
http://127.0.0.1:8001/api/health
```

## .env.production 配置说明

本地开发通常使用 `.env`；Docker / 服务器部署使用 `.env.production`。真实 `.env` 和 `.env.production` 都不得提交到 Git。

`SECRET_KEY`：
JWT 签名密钥。生产环境必须改成强随机字符串，不能继续使用示例值。可以用下面命令生成：

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

`ACCESS_TOKEN_EXPIRE_DAYS`：
登录 token 有效期，单位是天。自托管建议按自己的安全偏好设置，例如 `7`。

`DATABASE_PATH`：
SQLite 数据库路径。Docker Compose 默认使用 `/app/data/leafvault.sqlite3`，对应宿主机的 `./data` 目录。

`UPLOAD_DIR`：
用户上传文件目录。Docker Compose 默认使用 `/app/uploads`，对应宿主机的 `./uploads` 目录。

`ENVIRONMENT`：
运行环境。生产部署建议设置为 `production`。此模式下 `SECRET_KEY` 必须存在且足够长。

`LOG_LEVEL`：
日志级别，常用值为 `INFO`、`WARNING`、`ERROR`。

`ALLOWED_ORIGINS`：
允许的前端来源。本地 Docker 测试可以使用 `http://127.0.0.1:8001,http://localhost:8001`。如果使用 HTTPS 反向代理，请改成自己的域名来源。

`AI_API_KEY`：
AI 润色服务密钥。为空时 AI 润色功能不可用是正常的，不影响日记、账本、备份和同步。

`AI_BASE_URL`：
AI 服务地址。示例中使用 `https://api.deepseek.com`。

`SENDER_EMAIL`：
发送邮箱验证码的邮箱账号。

`SENDER_PASSWORD`：
邮箱授权码或 SMTP 密码。不能泄露，不能提交到 GitHub。

`SMTP_SERVER`：
SMTP 服务器地址，例如 `smtp.qq.com`。

`SMTP_PORT`：
SMTP 端口，例如 `465`。

重要提醒：

- `SECRET_KEY` 必须改成强随机字符串。
- 不能把 `.env` 或 `.env.production` 上传到 GitHub。
- 邮箱授权码不能泄露。
- `AI_API_KEY` 为空时 AI 润色功能不可用是正常的。

## 持久化目录说明

`docker-compose.prod.yml` 中包含：

```yaml
volumes:
  - ./data:/app/data
  - ./uploads:/app/uploads
```

说明：

- `./data` 保存 SQLite 数据库。
- `./uploads` 保存用户上传文件，例如头像和日记图片。
- 删除容器不会删除这两个目录中的数据。
- 删除 `data` 或 `uploads` 目录会导致数据丢失。
- 这两个目录需要定期备份。

## 备份建议

建议定期备份：

- `./data`
- `./uploads`
- `.env.production`

LeafVault 云端密文备份是应用层数据备份，用于在应用内导出、上传、下载和恢复日记/账本数据。

服务器目录备份是部署层灾备，用于恢复 SQLite 数据库、上传文件和运行配置。

两者不是一回事，建议都做。不要把 Docker 容器本身当成唯一备份。

## 更新部署

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

更新前建议先在 LeafVault 内上传一份云端加密备份，或者复制 `./data` 和 `./uploads` 做服务器级备份。

## 常用命令

本地 Docker 测试：

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml down
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml logs -f
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml ps
```

服务器生产：

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml logs -f
docker compose -f docker-compose.prod.yml ps
```

## 常见问题

### 本地 Docker 测试端口 8001 被占用怎么办

本地 Docker 测试通过 `docker-compose.local.yml` 将宿主机 `8001` 映射到容器内部 `8000`。如果宿主机 `8001` 被占用，可以只修改 `docker-compose.local.yml` 的宿主机端口，例如：

```yaml
ports:
  - "18001:8000"
```

然后访问 `http://127.0.0.1:18001`。服务器正式部署不要叠加 `docker-compose.local.yml`，应通过 Caddy 的 80/443 和 HTTPS 域名访问。

### 忘记修改 SECRET_KEY 怎么办

请立即停止服务，修改 `.env.production` 中的 `SECRET_KEY`，再重启容器。注意：修改 `SECRET_KEY` 后旧登录 token 会失效，用户需要重新登录。

### 容器启动失败怎么办

查看日志：

```bash
docker compose -f docker-compose.prod.yml logs -f
```

重点检查 `.env.production` 是否存在、`SECRET_KEY` 是否已修改、`data` / `uploads` 目录是否有写入权限。

### /api/health 不通怎么办

先检查容器状态：

```bash
docker compose -f docker-compose.prod.yml ps
```

再查看日志：

```bash
docker compose -f docker-compose.prod.yml logs -f
```

确认服务监听端口是 `8000`，并且端口映射没有被改错。

### 数据重启后丢失怎么办

确认 `docker-compose.prod.yml` 中仍然保留：

```yaml
- ./data:/app/data
```

如果删除了 `./data` 目录，SQLite 数据库会丢失。请从服务器备份或 LeafVault 云端密文备份恢复。

### 图片/头像不显示怎么办

确认 `docker-compose.prod.yml` 中仍然保留：

```yaml
- ./uploads:/app/uploads
```

如果删除了 `./uploads` 目录，已上传图片文件会丢失。数据库里的图片路径不会自动恢复文件本身。

### 邮箱验证码发不出去怎么办

检查：

- `SENDER_EMAIL`
- `SENDER_PASSWORD`
- `SMTP_SERVER`
- `SMTP_PORT`

很多邮箱要求使用授权码，不是网页登录密码。

### AI 润色不可用怎么办

如果 `AI_API_KEY` 为空，AI 润色不可用是正常的。填写密钥后重启容器。

### 手机访问电脑部署的 LeafVault 需要注意什么

手机和电脑需要在同一局域网中。不同运行方式的访问地址不同：

- 本地 Docker 测试：访问 `http://电脑局域网IP:8001`
- 本地 uvicorn 开发：通常访问 `http://电脑局域网IP:8000`
- 公网生产：访问 `https://你的域名`

```text
http://电脑局域网IP:8001
```

如果无法访问，请检查 Windows 防火墙、路由器隔离设置，以及 Docker Desktop 的网络配置。

## HTTPS 反向代理要求

本地 Docker 测试不强制 HTTPS；公网生产必须使用 HTTPS 反向代理。当前推荐 Caddy 负责公网 80/443 和自动 HTTPS，LeafVault 容器只在 Compose 网络内监听 `leafvault:8000`，不要直接暴露到公网。

Caddy 示例：

```caddyfile
{$LEAFVAULT_DOMAIN} {
    reverse_proxy leafvault:8000
}
```

使用时请注意：

- 替换成自己的域名。
- 配置 HTTPS 前要保证域名 DNS 正确。
- 不要把真实域名写死到项目配置。
- 上面的示例适用于 Caddy 与 LeafVault 同在 Docker Compose 网络中；只有 Caddy 不在 Compose 网络内时，才应改为反代宿主机地址。

## 安全注意事项

- 不要公开 `.env` 或 `.env.production`。
- 不要公开 `data` 目录。
- 不要公开 `uploads` 中的敏感图片。
- 生产环境必须修改 `SECRET_KEY`。
- 公网生产必须使用 HTTPS。
- 定期备份 `data` / `uploads`。
- 不要把真实数据库提交到 Git。
- 不要把 Docker 容器当成唯一备份。
