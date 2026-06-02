# LeafVault 生产环境安全加固基线


## 1. 文档目标

LeafVault 当前重点是：

- 可本地使用。
- 可自托管部署。
- 具备基础安全边界。
- 能清楚说明哪些能力已经落地，哪些仍属于过渡状态。
- 避免在 README、部署文档或演示中夸大“完全安全”“完全零知识”等结论。

本文件用于回答：

1. 当前 LeafVault 的安全边界是什么。
2. 生产部署前必须满足哪些配置。
3. 哪些兼容项属于过渡方案。
4. Cookie、CSRF、CSP、上传校验、日志脱敏和备份恢复应如何收口。
5. 后续版本继续加固的优先级。

## 2. 当前安全边界摘要

LeafVault采用本地优先思路：

- 日记、账本、生活日历等核心体验优先在浏览器本地 IndexedDB 中工作。
- 用户可以导出本地加密备份文件。
- 云端快照与增量同步围绕密文 payload 设计。
- 服务器保存 SQLite 数据库、上传图片目录和必要账号信息。
- 生产部署依赖 HTTPS、强随机密钥、Cookie/CSRF、防上传滥用、日志脱敏和定期备份。


## 3. 生产环境硬性要求

公网部署时，以下项必须满足：

| 检查项 | 生产要求 |
| --- | --- |
| HTTPS | 必须通过 HTTPS 访问正式域名 |
| `PUBLIC_BASE_URL` | 必须以 `https://` 开头 |
| `SECRET_KEY` | 必须是长随机字符串，不能使用默认值 |
| `COOKIE_SECURE` | 必须为 `true` |
| `TRUSTED_HOSTS` | 不能为空，不能为 `*` |
| `ALLOWED_ORIGINS` | 不能为 `*` |
| `DATABASE_PATH` | 明确指向持久化目录 |
| `UPLOAD_DIR` | 明确指向持久化目录 |
| `.env` | 不能提交到 Git，不能截图公开 |
| 注册策略 | 正式公开前不建议 `REGISTRATION_MODE=open` |
| Demo 上传 | 公开 Demo 建议保持 `DEMO_SERVER_UPLOAD_ENABLED=false` |

生产部署前建议运行：

```powershell
python scripts/quality_gate.py
python scripts/public_deploy_preflight.py --example
```

服务器部署后建议运行：

```powershell
python scripts/ops_status.py --data ./data --uploads ./uploads --backups ./backups --url https://your-domain.com
```

## 4. 密钥和环境变量管理

### 4.1 不允许提交的内容

以下内容不能进入 Git、README、Issue、截图、日志或公开文档：

- `.env`
- `.env.production`
- `SECRET_KEY`
- `AI_API_KEY`
- `SENDER_PASSWORD`
- SMTP 授权码
- 邀请码
- 真实数据库
- 真实用户上传图片
- `repomix-output.xml`
- 任何包含 token、Cookie、CSRF、密文 payload 的调试输出

### 4.2 推荐保存方式

生产环境至少需要单独保存三类材料：

```text
1. 项目代码仓库
2. 服务器数据备份：data/ + uploads/
3. 生产配置备份：.env 或 .env.production
```

注意：

- 自动服务器级备份默认不应包含 `.env`。
- `.env` 要单独离线保存。
- 更换 `SECRET_KEY` 后，旧登录 token 可能失效，用户需要重新登录。
- 邮箱授权码和 AI key 泄露后应立即撤销并重新生成。

## 5. 认证与登录态边界

### 5.1 当前状态

LeafVault v0.1 支持 Cookie 优先登录态，同时保留 Bearer token fallback 作为迁移兼容。

当前推荐：

```env
AUTH_PREFER_COOKIE=true
AUTH_STORE_TOKEN_IN_LOCALSTORAGE=false
AUTH_ALLOW_BEARER_FALLBACK=true
```

含义：

- 优先依赖 HttpOnly Cookie 保存登录态。
- 不再主动把 token 存入 `localStorage`。
- 暂时允许 Bearer fallback，用于旧 PWA 缓存、本地调试和异常兜底。

### 5.2 生产推荐路线

| 阶段 | 目标 |
| --- | --- |
| 阶段 A | Cookie preferred，Bearer fallback 保留 |
| 阶段 B | 默认不保存 localStorage token |
| 阶段 C | Cookie-only 预演 |
| 阶段 D | 关闭 `AUTH_ALLOW_BEARER_FALLBACK` |
| 阶段 E | 清理前端直接解析 JWT payload 的逻辑 |

v0.1 正式公开前可以暂时保留 Bearer fallback，但文档中必须说明这是迁移兼容边界，不是最终安全状态。

## 6. Cookie 与 CSRF 防护

Cookie 登录态需要 CSRF 防护，因为浏览器会自动随请求携带 Cookie。

当前策略：

- `GET` / `HEAD` / `OPTIONS` 不强制 CSRF。
- 登录、注册、发送验证码、重置密码等公开认证接口豁免。
- 带 `Authorization: Bearer` 的兼容请求不强制 CSRF。
- 依赖 Cookie 的 `POST` / `PUT` / `PATCH` / `DELETE` 必须携带正确 `X-CSRF-Token`。
- 后端应使用常量时间比较 CSRF Cookie 与 Header。

实现边界：

```text
HttpOnly access token Cookie：JS 不能读取，用于认证。
可读 CSRF Cookie：JS 可以读取，用于写入 X-CSRF-Token。
X-CSRF-Token Header：写请求必须携带。
```

生产建议：

```env
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
AUTH_PREFER_COOKIE=true
AUTH_STORE_TOKEN_IN_LOCALSTORAGE=false
CSRF_ENABLED=true
```

上线验收时至少测试：

1. 登录后刷新页面仍保持登录态。
2. Cookie 写请求带 CSRF 时可成功。
3. Cookie 写请求缺少 CSRF 时被拒绝。
4. 退出登录后 Cookie 被清理。
5. 旧 Bearer fallback 是否仍按预期受控。

## 7. 浏览器本地存储边界

LeafVault 使用 IndexedDB 保存本地工作数据。需要注意：

- IndexedDB 是本地优先工作空间，不等于自动加密保险箱。
- 本地加密备份文件才是用户主动加密导出的结果。
- 浏览器清理站点数据可能导致本地数据消失。
- 共享设备或浏览器同步可能带来隐私风险。
- 备份密码、同步密码、派生密钥不应落盘保存。

前端禁止长期保存：

- 备份密码
- 同步密码
- 派生密钥
- 明文密文解密结果
- CSRF token 的调试输出
- JWT access token 的长期 localStorage 兼容数据

如果后续仍需短期兼容 localStorage token，应在代码和文档中明确标注为迁移期逻辑。

## 8. 加密备份与同步边界

### 8.1 本地加密备份

本地备份应遵循：

- 用户输入备份密码。
- 前端使用 Web Crypto 派生密钥并加密 payload。
- 浏览器下载 `.lvbackup` 文件。
- 备份密码不上传服务器。
- 备份密码不写入 localStorage、IndexedDB 或日志。

用户必须知道：

- 忘记备份密码无法恢复备份。
- `.lvbackup` 文件丢失无法从服务器自动找回。
- 本地备份与服务器级备份不是一回事。

### 8.2 云端密文快照

云端快照应遵循：

- 服务端只保存密文 blob 和非敏感元数据。
- 列表接口只返回名称、备注、时间、设备、大小等元数据。
- 下载单条快照时才返回完整密文。
- 错误日志不能打印完整密文 payload。

### 8.3 增量同步

增量同步应遵循：

- 前端本地生成变更记录。
- 用户输入同步密码后在本地加密变更 payload。
- 后端只保存 `encrypted_change` 和必要元数据。
- 元数据列表不返回 `encrypted_change`。
- 单条预览时才下载密文并在本地解密。
- 冲突不能静默覆盖，应创建冲突副本或要求用户确认。

公开说明时建议使用：

> 云端同步工件以密文形式保存，服务端不解密云端快照和增量同步 payload。

不建议直接写成：

> 服务器永远不保存任何明文。

因为 v0.1 仍有账号、配置、上传文件索引和历史业务兼容表等服务端数据。

## 9. CSP 与前端资源策略

### 9.1 当前 CSP 基线

当前推荐 CSP 方向：

```text
default-src 'self'
base-uri 'self'
object-src 'none'
frame-ancestors 'none'
img-src 'self' data: blob:
font-src 'self' data:
connect-src 'self' https://api.deepseek.com
manifest-src 'self'
worker-src 'self'
```

说明：

- 如果 DeepSeek 调用完全由后端完成，浏览器不直接请求 `https://api.deepseek.com`，后续可以评估是否从 `connect-src` 中移除该域名。
- 开发阶段可以保留必要兼容项。
- 生产环境最终目标是去掉不必要的外部连接和 `'unsafe-inline'`。

### 9.2 CSP 模式

建议保留三种模式：

| 模式 | 用途 |
| --- | --- |
| `dev` | 本地开发，允许必要兼容 |
| `report-only` | 上线前观察违规，不阻断页面 |
| `strict` | 生产目标，尽量只允许本地资源 |

### 9.3 `unsafe-inline` 收口计划

当前仍可能保留：

- 历史 inline style。
- 少量启动脚本。
- 较大的单文件 HTML 结构遗留。

后续路线：

1. 继续移除 inline event handler。
2. 把启动脚本迁移到独立 JS 模块。
3. 把样式从模板内迁移到 CSS 文件。
4. 对必须保留的短脚本使用 nonce/hash。
5. 生产 CSP 删除 `'unsafe-inline'`。

## 10. 第三方前端资源和供应链

原则：

- 生产环境尽量使用本地化 vendor 文件。
- 不在运行时依赖 CDN。
- 不使用 `unsafe-eval`。
- 不使用 `script-src *`。
- 不使用 `connect-src *`。

已本地化或建议本地化的资源：

| 资源 | 用途 | 建议 |
| --- | --- | --- |
| DOMPurify | 清理 HTML/Markdown 内容 | 固定版本，登记来源 |
| marked | Markdown 解析 | 固定版本，登记来源 |
| ECharts | 报表图表 | 固定版本，按需裁剪 |
| html2canvas | 报告导出截图 | 评估是否长期保留 |
| SheetJS xlsx | Excel 导出 | 固定版本，评估模块拆分 |

如确实需要临时 CDN：

- 固定版本。
- 添加 SRI `integrity`。
- 添加 `crossorigin="anonymous"`。
- 在安全文档登记用途和风险。
- 在静态检查脚本中保持可见检查。

## 11. 上传文件安全

### 11.1 当前基线

用户上传图片必须经过后端校验，不能只信任前端。

当前基线：

- 限制单张图片大小，默认 `MAX_UPLOAD_SIZE_MB=10`。
- 限制单篇日记图片数量。
- 允许扩展名：`jpg,jpeg,png,webp,gif`。
- 允许 MIME：`image/jpeg,image/png,image/webp,image/gif`。
- 校验图片魔数，不只信任扩展名。
- 禁止 SVG。
- 禁止 `.html`、`.js`、`.exe`、`.php` 等危险类型。
- 文件名由后端重新生成。
- 不信任用户原始文件名。
- 防止路径穿越。
- 返回前端的路径必须是安全相对路径。

### 11.2 后续增强

后续可以继续增强：

- 上传图片重新编码，去除潜在异常结构。
- 更严格的图片内容嗅探。
- 头像和日记图片分目录隔离。
- 单用户上传总量限制。
- 图片垃圾清理前先 dry-run。
- 使用对象存储时增加私有桶和签名 URL 策略。

## 12. AI 润色安全边界

AI 润色涉及把用户输入发送给外部模型服务，应明确边界：

- API Key 只能保存在后端 `.env`。
- 前端不能暴露 `AI_API_KEY`。
- 日记内容会作为请求内容发送给模型服务，因此 UI 应提示用户不要提交极敏感内容。
- 后端日志不能打印完整日记正文、模型请求 payload 或 API Key。
- AI 接口应限流，避免被滥用导致费用失控。
- Demo 模式不调用真实 AI API。
- 生产环境建议保留内容长度限制，例如单次 2000 字以内。

推荐配置：

```env
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=你的真实密钥
```

如果提供“极速 / 深度”两档模型，应注意：

- 普通润色使用低成本模型。
- 深度润色应有更严格限流。
- 错误响应只返回用户可理解的温和提示，不返回上游完整错误堆栈。

## 13. 日志与错误处理

日志原则：

- 记录事件，不记录秘密。
- 记录错误摘要，不记录完整敏感 payload。
- 记录用户 ID 时避免拼接过多隐私信息。
- 生产环境不返回 traceback。
- 前端错误提示要温和，避免暴露内部路径、SQL、token 或密文。

禁止进入日志：

- 密码
- 邮箱授权码
- API Key
- access token
- refresh token
- CSRF token
- 备份密码
- 同步密码
- 完整日记正文
- 账本备注
- 加密 payload 全文
- `.env` 内容

建议错误响应：

```json
{"status": "error", "message": "服务暂时不可用，请稍后重试"}
```

不建议错误响应：

```json
{"traceback": "...", "sql": "...", "token": "..."}
```

## 14. Service Worker 与 PWA 缓存安全

PWA 缓存必须避免保存敏感接口响应。

Service Worker 不应缓存：

- `/api/`
- `/api/login`
- `/api/register`
- `/api/session/status`
- `/api/sync/`
- 任何带 `Authorization` 的请求
- 任何用户上传请求
- 任何云端快照或增量同步 payload
- 任何包含用户隐私的 JSON 响应

允许缓存：

- App Shell 静态资源。
- CSS / JS / 图标 / manifest。
- 不含用户隐私的基础页面资源。

上线前应验证：

```powershell
python scripts/pwa_static_check.py
```

## 15. CORS、Host 与反向代理

生产建议：

```env
TRUSTED_HOSTS=your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
PUBLIC_BASE_URL=https://your-domain.com
FORCE_HTTPS=true
COOKIE_SECURE=true
```

反向代理原则：

- FastAPI 容器不要直接暴露 8000 到公网。
- 只通过 Caddy / Nginx 的 80 和 443 入口访问。
- Caddy 负责自动 HTTPS。
- DNS 指向正确服务器。
- 服务器安全组开放 80/443，必要时限制 22。
- 后端健康接口不得泄露密钥和本地路径。

## 16. 资源滥用防护

便宜 VPS 应控制资源增长。

建议保留：

```env
MAX_UPLOAD_SIZE_MB=10
MAX_DIARY_IMAGES_PER_ENTRY=9
MAX_CLOUD_SNAPSHOTS_PER_USER=5
MAX_CLOUD_SNAPSHOT_PAYLOAD_MB=100
MAX_SYNC_BATCH_SIZE=100
MAX_SYNC_CHANGE_PAYLOAD_KB=512
DEMO_SERVER_UPLOAD_ENABLED=false
```

策略说明：

- 达到云端快照上限时拒绝新上传，并提示用户先删除旧备份。
- Demo 模式不上传服务器。
- AI 润色接口必须限流。
- 邮箱验证码接口必须限流。
- 登录失败应有频率限制。
- 不自动删除用户有效备份，避免误删。

## 17. 数据库与服务器备份

### 17.1 必须备份

```text
data/
uploads/
.env 或 .env.production
```

其中：

- `data/` 保存 SQLite 数据库。
- `uploads/` 保存头像和日记图片。
- `.env` 保存生产密钥和服务配置。

### 17.2 备份命令

```powershell
python scripts/ops_backup.py --db ./data/leafvault.db --uploads ./uploads --out ./backups --keep 7
python scripts/ops_backup_check.py --file ./backups/leafvault-backup-xxxx.zip
```

注意：

- Docker volume 不是备份。
- 云端密文快照不是服务器级完整备份。
- 自动备份包不应包含 `.env`。
- 恢复前必须先停止服务，并备份当前数据目录。

## 18. 发布前安全检查清单

发布前逐项确认：

- [ ] `python scripts/quality_gate.py` 通过。
- [ ] `python scripts/security_static_check.py` 通过。
- [ ] `python scripts/pwa_static_check.py` 通过。
- [ ] `python scripts/public_deploy_preflight.py --example` 通过。
- [ ] `SECRET_KEY` 已改为长随机字符串。
- [ ] `PUBLIC_BASE_URL` 使用 HTTPS。
- [ ] `TRUSTED_HOSTS` 不是 `*`。
- [ ] `ALLOWED_ORIGINS` 不是 `*`。
- [ ] `COOKIE_SECURE=true`。
- [ ] `.env` 未提交到 Git。
- [ ] 真实数据库未提交到 Git。
- [ ] `uploads/` 未被误提交。
- [ ] `repomix-output.xml` 未提交。
- [ ] Demo 模式不上传服务器。
- [ ] AI Key 未暴露到前端。
- [ ] SMTP 授权码未暴露。
- [ ] 上传图片限制仍生效。
- [ ] PWA 不缓存 `/api/`。
- [ ] Cookie 写请求 CSRF 校验正常。
- [ ] 退出登录能清理会话。
- [ ] 服务器已完成一次备份检查。
