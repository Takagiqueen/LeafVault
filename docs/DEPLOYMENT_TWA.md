# LeafVault TWA 打包准备

TWA（Trusted Web Activity）是 Android 上承载 PWA 的原生外壳。后续打包出的 APK/AAB 只是把用户带到受信任的 Web 体验中，LeafVault 的 Web 端入口仍然是 `https://leafvault.cn`，业务逻辑、登录、同步、备份和加密仍由现有 Web 应用负责。

## 当前 PWA 基础

LeafVault Web 端已经具备 TWA 需要依赖的 PWA 基础：

- `static/manifest.json` 提供 `name`、`short_name`、`start_url`、`scope`、`display`、`theme_color` 和应用图标。
- `static/service-worker.js` 已通过根路径 `/service-worker.js` 暴露，让 Service Worker scope 覆盖整个站点。
- 前端已有 PWA 状态与更新处理模块，能够注册 Service Worker 并处理在线/离线状态。
- 192x192 和 512x512 图标声明了 `purpose: any maskable`，便于 Android 启动器使用自适应图标裁切。

## 为什么需要 Digital Asset Links

TWA 必须证明 Android 应用包名和网站域名属于同一发布方。Android/Chrome 会请求：

```text
https://leafvault.cn/.well-known/assetlinks.json
```

这个文件里的 `package_name` 和 release 签名证书 SHA-256 指纹必须与最终 APK/AAB 一致。若该地址返回 404、内容不是合法 JSON、包名不匹配或 SHA-256 不匹配，TWA 验证会失败，应用可能无法以完整 TWA 方式打开。

仓库只保留模板 `static/.well-known/assetlinks.example.json`。真实 `static/.well-known/assetlinks.json` 是公开验证文件，但如果仓库开源，建议不要直接提交真实文件，改为服务器部署时放置。`static/.well-known/assetlinks.json` 已加入 `.gitignore`。

## Release Keystore

生成 release keystore 示例：

```bash
keytool -genkeypair \
  -alias leafvault-release \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -keystore leafvault-release.jks
```

keystore 绝对不能提交 GitHub，也不要放入公开备份、日志或文档截图中。

获取 SHA-256 指纹：

```bash
keytool -list -v \
  -keystore leafvault-release.jks \
  -alias leafvault-release
```

在输出中找到 `SHA256:`，复制冒号分隔的完整指纹。

## 配置 assetlinks.json

从模板复制真实文件：

```bash
cp static/.well-known/assetlinks.example.json static/.well-known/assetlinks.json
```

然后替换：

- `package_name`：改为 Bubblewrap/Android 项目实际使用的包名，例如 `cn.leafvault.app`。
- `REPLACE_WITH_RELEASE_KEY_SHA256`：改为 release keystore 对应的 SHA-256 指纹。

部署后确认：

```bash
curl -i https://leafvault.cn/.well-known/assetlinks.json
```

应返回 `200`、`Content-Type: application/json`，并且内容为真实 `assetlinks.json`。如果 `/.well-known/assetlinks.json` 返回 404，TWA 会验证失败。

## Bubblewrap 打包

安装 Bubblewrap CLI：

```bash
npm i -g @bubblewrap/cli
```

初始化 Android 壳：

```bash
bubblewrap init --manifest=https://leafvault.cn/static/manifest.json
```

构建：

```bash
bubblewrap build
```

安装到测试设备：

```bash
bubblewrap install
```

国内安卓设备可能因为 Chrome / 浏览器兼容性导致 TWA 体验不一致。测试时建议覆盖主流国产系统、Chrome 已安装/未安装、默认浏览器不同等场景。
