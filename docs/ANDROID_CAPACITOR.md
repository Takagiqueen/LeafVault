# LeafVault Capacitor Android 内测版

本文档说明 `apps/android-capacitor/` 下的 Capacitor Android WebView 壳。它用于国内 Android 内测，目标是产出一个不依赖 Chrome/TWA provider 的 APK，通过系统 Android WebView 打开线上入口：

```text
https://leafvault.cn
```

## 与 PWA / TWA 的区别

- PWA：LeafVault Web 端本身，包含 `manifest.json`、Service Worker、浏览器安装体验。
- TWA：Android 原生外壳 + Chrome/兼容浏览器 provider，用 Digital Asset Links 验证网站归属。
- Capacitor 版：独立 Android WebView 壳，不依赖 Chrome/TWA provider，安装后由 App 内 WebView 打开 `https://leafvault.cn`。

Capacitor 版不是原生重写。日记、账本、登录、同步、备份、加密等核心逻辑仍然运行在 LeafVault Web 端，本仓库没有为 Android 重写这些业务模块。

## 当前壳层策略

- App 名称：`LeafVault`
- Android 包名：`cn.leafvault.app`
- 启动地址：`https://leafvault.cn`
- 主题色 / 启动页背景色：`#f4f8f5`
- 默认只允许 `https://leafvault.cn` 在 App 内打开。
- 其他 HTTPS 链接交给系统浏览器。
- HTTP 明文和不支持的 scheme 会被阻止。
- 不忽略 HTTPS 证书错误。
- Cookie 开启并在后台/退出时 flush，尽量保持登录态。
- localStorage、IndexedDB、Web Crypto 依赖 Android System WebView 的标准能力。
- Android 返回键：WebView 有历史记录时返回上一页，否则二次确认退出。
- 主页面加载失败时显示友好错误页，提示检查网络。
- `.lvbackup` Blob 导出通过 Android 兼容层保存到系统下载目录。
- 普通 HTTPS 下载通过系统 DownloadManager 处理。

## 本地依赖

不要全局安装 Capacitor。依赖固定在：

```text
apps/android-capacitor/
```

首次安装：

```bash
cd apps/android-capacitor
npm install
npx cap sync android
```

当前工程使用 Capacitor 6.2.1，以匹配本机 JDK 17。Capacitor 7/8 新版本可能要求 Java 21，升级前需要先验证 Android 构建环境。

## 构建 Debug APK

如果 `ANDROID_HOME` 已配置：

```bash
cd apps/android-capacitor/android
./gradlew assembleDebug
```

Windows PowerShell 可临时指定 Android Studio 默认 SDK：

```powershell
cd apps/android-capacitor/android
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
.\gradlew.bat assembleDebug
```

构建产物：

```text
apps/android-capacitor/android/app/build/outputs/apk/debug/app-debug.apk
```

该 APK 是 debug 签名，仅用于内测安装，不用于正式分发。

## 构建 Release APK

先构建未正式签名的 release 包：

```powershell
cd apps/android-capacitor/android
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
.\gradlew.bat assembleRelease
```

正式分发需要 release keystore。生成示例：

```bash
keytool -genkeypair \
  -alias leafvault-release \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -keystore leafvault-release.jks
```

签名可在 Android Studio 中配置，或在本地创建不提交 Git 的 `keystore.properties` / `signing.properties` 后配置 Gradle signingConfig。keystore、密码文件、APK/AAB 绝对不能提交 GitHub。

## 真机测试清单

必须在真实 Android 设备上测试：

- 首次启动能打开 `https://leafvault.cn`，不要求安装 Chrome。
- 登录成功后杀掉 App / 重启手机 / 重新打开，Cookie 登录态尽量保持。
- 日记基础流程：新增、编辑、查看、图片预览。
- 账本基础流程：新增、编辑、统计刷新。
- 图片上传入口能调起系统文件选择器或相册。
- `.lvbackup` 本地导出能保存到系统下载目录。
- `.lvbackup` 导入能从文件选择器选择并完成导入。
- 云端备份上传、下载、恢复流程与浏览器端一致。
- 同步功能在移动网络和 Wi-Fi 下都可用。
- leafvault.cn 断网或不可达时显示错误页，而不是白屏。
- 外部链接不在 App 内打开。
- Android 返回键符合预期：先返回 WebView 历史，再二次确认退出。

## 已知风险

- Cookie：不同厂商 WebView 对 Cookie 持久化和清理策略可能不同，必须真机回归。
- IndexedDB：本地优先数据依赖 WebView IndexedDB，低版本或被系统清理时可能影响离线缓存。
- Web Crypto：加密备份、同步密文处理依赖 HTTPS secure context 和 WebView Web Crypto 支持。
- 图片上传：`<input type="file">` 由系统文件选择器处理，国产 ROM 可能有差异。
- 文件下载：普通 HTTPS 下载交给 DownloadManager；前端 Blob `.lvbackup` 下载由 Android 注入兼容层保存，超大备份可能受内存限制。
- 备份导入导出：必须用真实 `.lvbackup` 文件做端到端测试。
- Android System WebView：不依赖 Chrome/TWA provider，但仍依赖设备内置或系统更新的 Android WebView。

## 仓库边界

- Android 壳相关文件限制在 `apps/android-capacitor/`。
- 不修改 LeafVault Web 端业务逻辑。
- 不删除现有 PWA/TWA 配置。
- 不修改生产 Docker 部署逻辑。
- 不提交 keystore、APK、AAB、密码文件、真实 `.env`。
- 本阶段以稳定可用为目标，不追求完全离线。
