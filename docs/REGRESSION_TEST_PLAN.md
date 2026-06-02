# LeafVault v0.1 全链路回归测试计划

## 1. 测试目标

建立一套可重复执行的质量门禁，尽早发现登录、会话、CSRF、用户隔离、日记图片、账本统计、云端密文备份、增量同步、PWA 缓存、移动端入口和 Docker 配置的回归问题。

## 2. 测试范围

- 认证与会话：注册、登录、Bearer token、Cookie session、logout、`/api/session/status`。
- CSRF：Cookie 认证写请求强校验，Bearer 写请求兼容。
- 用户隔离：日记、账本、云端快照、增量同步变更、诊断摘要。
- 日记与图片：新增、更新、删除、追加图片不丢旧图、上传安全。
- 账本与统计：收入、支出、删除、月统计、日历统计。
- 云端密文快照：上传、列表、下载、删除、元数据、密文不泄露。
- 增量同步：批量上传、幂等、元数据列表、单条密文详情、越权保护。
- 前端静态入口：备份、同步、冲突、诊断、空/错/加载状态、移动端折叠区。
- PWA：Service Worker 不缓存 `/api/`、登录、同步和敏感 payload。
- Docker 与安全静态检查：部署文件、安全响应头、CSP、上传限制、敏感日志模式。

## 3. 不测试范围

- 不做浏览器自动化端到端测试。
- 不执行 `docker compose build` 或 `docker compose up`。
- 不访问外部网络。
- 不发送真实邮件。
- 不调用真实 AI API。
- 不覆盖性能压测、高并发集群、Kubernetes 或企业级部署。

## 4. 核心链路列表

1. 注册用户，登录，读取用户信息。
2. Cookie session 不依赖 `localStorage` token 也能恢复登录态。
3. Cookie 写请求必须带正确 CSRF header。
4. 写日记、追加图片、更新文本、删除指定图片。
5. 新增账本，删除账本，月统计和日历统计更新。
6. 上传云端密文快照，列表不返回 `encrypted_blob`，详情才返回密文。
7. 上传增量密文变更，元数据列表不返回 `encrypted_change`，详情才返回密文。
8. 前端关键入口仍存在，移动端高级同步区域默认折叠。
9. PWA 不缓存 API、认证请求或同步密文 payload。

## 5. 安全回归列表

- 未登录访问受保护接口应返回 401 或 403。
- 用户 A 不能读取、修改、删除用户 B 的业务数据。
- 列表接口不能返回 `encrypted_blob` 或 `encrypted_change`。
- 错误响应不能返回 traceback、token、csrf、密码、payload 全文。
- 前端源码不能保存同步密码、备份密码、CSRF token、派生密钥或 decrypted payload。
- Service Worker 不能缓存 `/api/`、Authorization 请求或用户上传请求。

## 6. 同步回归列表

- `local_changes` 相关函数仍存在。
- `uploadPendingLocalChanges()` 仍存在。
- `fetchRemoteChangeMetadata()` 只拉元数据。
- `previewRemoteChange()` 才下载并解密单条远端变更。
- `applyRemoteChange()` 只允许安全状态应用。
- `createConflictCopy()`、`resolveSyncConflict()`、`recordSyncHistory()`、`startManualSyncWizard()`、`runSyncDiagnostics()` 仍存在。
- 同步历史和诊断报告不得包含日记正文、账本备注、token、密码或 payload。

## 7. PWA 回归列表

- `static/service-worker.js` 存在。
- `static/manifest.json` 存在。
- Service Worker 有版本号和旧缓存清理逻辑。
- 不默认强制 `skipWaiting`。
- `/api/`、`/api/session/status`、`/api/login`、`/api/sync/` 不进入 Cache Storage。
- 带 Authorization 的请求不缓存。
- PWA 更新提示和离线提示入口仍存在。

## 8. 移动端静态回归列表

- 个人中心存在“数据与同步管理”区域。
- 高级同步内容默认折叠。
- 导出、导入、上传云端备份、开始手动同步、运行同步自检入口仍存在。
- `ui-state.js` 提供空状态、错误状态、加载状态和按钮 loading 工具。
- 不新增大量 inline `onclick`。
- 不出现固定超宽样式导致 360px 屏幕横向滚动。

## 9. 手动验收清单

- 打开手机端个人中心，第一屏不被同步详情挤满。
- 没有日记、账本、云端备份、同步历史时都有温和空状态。
- 保存日记和上传图片时按钮进入处理中状态，失败后可恢复。
- 云端备份列表在手机端不横向溢出。
- 断网时云端功能给出清晰提示，本地日记和账本仍可用。
- 登录、写日记、记账、备份、同步、诊断的主要按钮都能找到。

## 10. 每次发版前运行命令

完整质量门禁：

```powershell
python scripts/quality_gate.py
```

单独运行后端测试：

```powershell
python -m pytest
```

单独运行安全静态检查：

```powershell
python scripts/security_static_check.py
```

单独运行移动端 UI 静态检查：

```powershell
python scripts/mobile_ui_static_check.py
```

单独运行 PWA 静态检查：

```powershell
python scripts/pwa_static_check.py
```

单独运行前端回归静态检查：

```powershell
python scripts/frontend_regression_check.py
```

单独运行 Docker 静态检查：

```powershell
python scripts/docker_static_check.py
```

