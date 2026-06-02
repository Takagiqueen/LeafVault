# LeafVault v0.1.0 公网部署验收清单

本清单用于 LeafVault v0.1.0 公网部署前后的人工验收。它不是自动部署脚本，也不能替代服务器备份、HTTPS 配置和真实设备测试。

建议每次准备发布或服务器更新前都完整走一遍。完成后可以在每个条目前打勾，并记录验收人、验收时间和问题链接。

## 0. 发布信息

| 项目 | 内容 |
| --- | --- |
| 版本 | v0.1.0 |
| 分支 / Commit |  |
| 部署域名 | https://your-domain.com |
| 部署环境 | production |
| 验收日期 |  |
| 验收人 |  |
| 备注 |  |

## 1. 发布前冻结确认

- [ ] 当前版本只做 v0.1 缺陷修复、文档修正和部署验收补充。
- [ ] 没有临时加入新的大功能。
- [ ] 没有修改同步协议核心字段。
- [ ] 没有临时大改认证机制。
- [ ] 没有把 `.env`、数据库、真实截图隐私、API Key、SMTP 授权码提交到 Git。
- [ ] README 与文档中的截图均使用测试账号和演示数据。

## 2. 本地质量门禁

发布前在本地项目根目录运行：

```powershell
python scripts/quality_gate.py
```

通过标准：

- [ ] 后端 pytest 通过。
- [ ] 前端静态检查通过。
- [ ] 安全静态检查通过。
- [ ] PWA 静态检查通过。
- [ ] Docker 静态检查通过。
- [ ] 移动端 UI 静态检查通过。
- [ ] 文档与部署预检相关检查通过。

必要时单独运行：

```powershell
python -m pytest
python scripts/security_static_check.py
python scripts/pwa_static_check.py
python scripts/mobile_ui_static_check.py
python scripts/frontend_regression_check.py
python scripts/docker_static_check.py
```

## 3. 生产配置检查

准备真实 `.env` 后运行：

```powershell
python scripts/public_deploy_preflight.py --example
```

生产配置必须满足：

- [ ] `ENVIRONMENT=production`。
- [ ] `PUBLIC_BASE_URL` 使用 `https://`。
- [ ] `TRUSTED_HOSTS` 不是 `*`，且包含正式域名。
- [ ] `ALLOWED_ORIGINS` 不是 `*`，且包含正式 HTTPS 域名。
- [ ] `COOKIE_SECURE=true`。
- [ ] `SECRET_KEY` 已换成长随机字符串。
- [ ] `DATABASE_PATH` 指向 `/app/data/leafvault.db` 或生产实际路径。
- [ ] `UPLOAD_DIR` 指向 `/app/uploads` 或生产实际路径。
- [ ] `REGISTRATION_MODE` 不建议为 `open`，公开部署推荐 `invite` 或 `closed`。
- [ ] `SENDER_EMAIL` 与 `SENDER_PASSWORD` 已按生产需要配置，或注册模式不会依赖真实验证码。
- [ ] `AI_API_KEY` 如需 AI 润色则已配置；不需要时功能能温和提示不可用。
- [ ] `.env` 未进入 Git 跟踪。

安全配置建议：

- [ ] `AUTH_PREFER_COOKIE=true`。
- [ ] `AUTH_STORE_TOKEN_IN_LOCALSTORAGE=false`。
- [ ] `AUTH_ALLOW_BEARER_FALLBACK=true` 仅作为 v0.1 迁移兼容。
- [ ] `CSP_MODE` 使用生产推荐配置。
- [ ] `CSP_ALLOWED_CONNECT_SRC` 仅包含必要域名，例如 `https://api.deepseek.com`。

## 4. 服务器部署前检查

- [ ] 域名 DNS 已指向服务器公网 IP。
- [ ] 服务器安全组 / 防火墙已开放 80 和 443。
- [ ] Docker 已安装。
- [ ] Docker Compose 可用。
- [ ] 项目代码已同步到服务器。
- [ ] 项目目录存在 `docker-compose.prod.yml`。
- [ ] 项目目录存在 `.env`。
- [ ] `data/` 目录存在并可写。
- [ ] `uploads/` 目录存在并可写。
- [ ] `backups/` 目录存在。
- [ ] `deploy/` 目录存在。
- [ ] 旧版本数据已备份。

推荐命令：

```bash
mkdir -p data uploads backups deploy
docker compose version
docker --version
```

## 5. Docker 生产启动

在服务器项目目录执行：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

检查容器状态：

```bash
docker compose -f docker-compose.prod.yml ps
```

通过标准：

- [ ] `leafvault` 容器处于运行状态。
- [ ] `caddy` 容器处于运行状态。
- [ ] 8000 没有直接暴露公网，FastAPI 容器只在 Docker 网络内 expose 8000。
- [ ] 只有 Caddy 暴露 80/443。
- [ ] 日志中没有密钥、token、SMTP 授权码、AI Key 泄露。

查看日志：

```bash
docker compose -f docker-compose.prod.yml logs -f leafvault
docker compose -f docker-compose.prod.yml logs -f caddy
```

## 6. 健康检查

访问：

```text
https://your-domain.com/api/health
```

期望返回：

```json
{"status":"ok"}
```

检查项：

- [ ] HTTPS 可访问。
- [ ] `/api/health` 返回正常。
- [ ] 浏览器没有证书错误。
- [ ] 反向代理没有 502 / 503。
- [ ] 控制台没有明显静态资源加载失败。

## 7. 部署状态检查

访问：

```text
https://your-domain.com/api/deployment/status
```

确认返回包含：

- [ ] `deployment_mode`。
- [ ] `environment`。
- [ ] `registration_mode`。
- [ ] `registration_requires_invite`。
- [ ] `cookie_secure_required`。
- [ ] `https_required`。
- [ ] `max_upload_size_mb`。
- [ ] `max_cloud_snapshots_per_user`。
- [ ] `demo_server_upload_enabled`。

确认不返回：

- [ ] `SECRET_KEY`。
- [ ] 邀请码明文。
- [ ] AI Key。
- [ ] 邮箱密码或 SMTP 授权码。
- [ ] 数据库绝对路径。
- [ ] 上传目录绝对路径。
- [ ] token、CSRF、密文 payload 全文。

## 8. Demo 模式验收

- [ ] 打开首页正常。
- [ ] 可以进入 Demo 模式。
- [ ] Demo 模式显示本地体验提示。
- [ ] Demo 可以新建日记。
- [ ] Demo 可以编辑日记。
- [ ] Demo 可以删除日记。
- [ ] Demo 可以添加账本流水。
- [ ] Demo 可以查看生活日历。
- [ ] Demo 可以执行本地加密导出。
- [ ] Demo 云端备份被温和拦截。
- [ ] Demo 增量同步被温和拦截。
- [ ] Demo AI 润色被温和拦截。
- [ ] 清空 Demo 数据不会影响正式账号。

## 9. 注册与登录验收

- [ ] 邀请码注册流程可用。
- [ ] 错误邀请码无法注册。
- [ ] 正式账号可登录。
- [ ] 登录后能读取用户信息。
- [ ] 刷新页面后 Cookie session 仍有效。
- [ ] 退出登录后回到未登录状态。
- [ ] 退出后不能访问受保护数据。
- [ ] Cookie 模式写请求带正确 CSRF 后可用。
- [ ] 缺少 CSRF 的 Cookie 写请求不会被静默放行。

## 10. 日记与图片验收

- [ ] 新建纯文本日记成功。
- [ ] 新建带图片日记成功。
- [ ] 图片预览正常。
- [ ] 编辑日记正文成功。
- [ ] 追加图片时旧图片不丢失。
- [ ] 删除指定图片成功。
- [ ] 删除日记成功。
- [ ] 上传超大图片时有温和错误提示。
- [ ] 不允许上传 SVG 或危险文件类型。
- [ ] 手机端图片选择流程可用。
- [ ] 日记沉浸预览或详情展示正常。

## 11. 账本、报表与日历验收

- [ ] 新增支出成功。
- [ ] 新增收入成功。
- [ ] 删除账本流水成功。
- [ ] 当前月份流水展示正确。
- [ ] 切换月份后流水展示正确。
- [ ] 月度统计正确更新。
- [ ] 生活日历能显示对应日期记录。
- [ ] 报表页面可以打开。
- [ ] Excel 导出可按预期生成文件。
- [ ] 移动端按钮不遮挡、不横向溢出。

## 12. 本地加密备份验收

- [ ] 可以导出 `.lvbackup` 文件。
- [ ] 备份密码不会显示在页面或控制台。
- [ ] 使用正确密码可以导入恢复。
- [ ] 使用错误密码不能恢复，并给出温和提示。
- [ ] 备份文件不应包含明文密码或 token。

## 13. 云端密文快照验收

- [ ] 正式账号可以上传云端密文快照。
- [ ] 云端快照列表可显示名称、备注、时间、大小等元数据。
- [ ] 列表接口不返回完整 `encrypted_blob`。
- [ ] 下载详情时才返回密文 payload。
- [ ] 可以删除云端快照。
- [ ] 达到快照数量上限时拒绝新上传，并提示先删除旧备份。
- [ ] 用户 A 无法读取或删除用户 B 的快照。

## 14. 增量同步与冲突验收

- [ ] 本地变更可以进入待同步队列。
- [ ] 手动同步向导可以打开。
- [ ] 可以上传密文增量变更。
- [ ] 云端变更列表只显示元数据。
- [ ] 单条预览时才下载密文并尝试本地解密。
- [ ] 应用远端变更前有明确确认。
- [ ] 冲突不会自动覆盖本地数据。
- [ ] 冲突副本可以查看。
- [ ] 同步历史不包含日记正文、账本备注、token、密码或 payload 全文。
- [ ] 用户 A 无法读取用户 B 的增量变更。

## 15. AI 润色验收

- [ ] 未配置 `AI_API_KEY` 时，AI 功能给出温和提示。
- [ ] 配置 `AI_API_KEY` 后，普通模式可用。
- [ ] 普通模式调用极速模型映射，例如 `deepseek-v4-flash`。
- [ ] 深度模式调用 Pro 模型映射，例如 `deepseek-v4-pro`。
- [ ] 日记内容过短时不会调用 AI。
- [ ] 日记内容超过限制时提示分段润色。
- [ ] AI 错误不会把 API Key、请求头、堆栈返回给用户。

## 16. PWA 与移动端验收

- [ ] 可以在手机浏览器打开。
- [ ] 可以添加到桌面。
- [ ] 刷新后主页面正常。
- [ ] 离线时本地日记和账本仍尽量可用。
- [ ] Service Worker 不缓存 `/api/`、登录请求、同步密文 payload。
- [ ] 移动端底部导航不被 Toast 遮挡。
- [ ] 个人中心第一屏不被同步详情挤满。
- [ ] 高级同步区域默认折叠。
- [ ] 360px / 390px / 414px 宽度下没有明显横向滚动。

## 17. 安全与隐私验收

- [ ] 未登录访问受保护接口返回 401 或 403。
- [ ] 用户 A 不能读取、修改、删除用户 B 的日记、账本、快照、同步记录。
- [ ] 错误响应不返回 traceback。
- [ ] 错误响应不返回 token、csrf、密码、密文 payload 全文。
- [ ] 前端源码中没有真实 API Key、SMTP 授权码、邀请码。
- [ ] Git 仓库中没有 `.env`、真实数据库、真实上传图片。
- [ ] CSP 不使用 `default-src *`、`script-src *`、`connect-src *`。
- [ ] 上传文件经过扩展名、MIME、魔数和大小校验。

## 18. 服务器级备份验收

部署后立即生成一次备份：

```bash
python scripts/ops_backup.py --db ./data/leafvault.db --uploads ./uploads --out ./backups --keep 7
```

检查备份包：

```bash
python scripts/ops_backup_check.py --file ./backups/leafvault-backup-xxxx.zip
```

检查项：

- [ ] 备份包可以打开。
- [ ] 备份包包含数据库副本。
- [ ] 备份包包含 uploads 内容。
- [ ] 备份包包含 manifest。
- [ ] 备份包不包含 `.env`。
- [ ] 备份包不包含明显密钥、token、SMTP 授权码。
- [ ] 已将备份下载到本地或其他安全位置。
- [ ] `.env` 已单独安全保存。

## 19. 更新与回滚准备

更新前：

- [ ] 已运行质量门禁。
- [ ] 已生成服务器级备份。
- [ ] 已记录当前 Commit。
- [ ] 已记录当前 `.env` 配置版本。

如果更新失败，优先执行：

```bash
docker compose -f docker-compose.prod.yml logs leafvault
docker compose -f docker-compose.prod.yml logs caddy
```

必要时回滚：

- [ ] 停止当前容器。
- [ ] 切回上一个稳定 Commit。
- [ ] 恢复备份数据库和 uploads。
- [ ] 使用原 `.env` 启动。
- [ ] 重新跑健康检查。

## 20. 最终发布确认

- [ ] 首页可访问。
- [ ] Demo 可体验。
- [ ] 正式账号可注册 / 登录。
- [ ] 日记、图片、账本、日历、报表可用。
- [ ] 本地加密备份可用。
- [ ] 云端密文快照可用。
- [ ] 同步向导可打开且不静默覆盖。
- [ ] AI 功能按配置可用或温和降级。
- [ ] PWA 移动端体验可接受。
- [ ] 生产日志无敏感信息。
- [ ] 已完成服务器级备份。
- [ ] 已保存 `.env` 到安全位置。
- [ ] 已记录本次发布 Commit。
