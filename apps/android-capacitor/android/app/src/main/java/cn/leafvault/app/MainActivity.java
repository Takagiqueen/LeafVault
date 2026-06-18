package cn.leafvault.app;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private static final String LEAFVAULT_ORIGIN = "https://leafvault.cn";
    private static final String LEAFVAULT_HOST = "leafvault.cn";
    private static final String DOWNLOAD_SUBDIR = "LeafVault";
    private static final long EXIT_CONFIRM_WINDOW_MS = 2000L;

    private final ExecutorService fileExecutor = Executors.newSingleThreadExecutor();
    private long lastBackPressedAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Bridge bridge = getBridge();
        if (bridge == null) return;

        WebView webView = bridge.getWebView();
        configureWindow();
        configureWebView(webView);
        configureDownloads(webView);
        bridge.setWebViewClient(new LeafVaultWebViewClient(bridge));
        configureBackButton(webView);
    }

    @Override
    public void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    public void onStop() {
        CookieManager.getInstance().flush();
        super.onStop();
    }

    @Override
    public void onDestroy() {
        CookieManager.getInstance().flush();
        fileExecutor.shutdown();
        super.onDestroy();
    }

    private void configureWindow() {
        Window window = getWindow();
        window.setStatusBarColor(ContextCompat.getColor(this, R.color.leafvault_background));
        window.setNavigationBarColor(ContextCompat.getColor(this, R.color.leafvault_background));
    }

    @SuppressLint({ "SetJavaScriptEnabled", "JavascriptInterface" })
    private void configureWebView(WebView webView) {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, false);
        }

        webView.addJavascriptInterface(new LeafVaultAndroidBridge(), "LeafVaultAndroidBridge");
    }

    private void configureDownloads(WebView webView) {
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            Uri uri = Uri.parse(url);
            if (!isLeafVaultHttps(uri)) {
                showToast("已阻止非 LeafVault 下载。");
                return;
            }
            String filename = sanitizeFilename(URLUtil.guessFileName(url, contentDisposition, mimeType));
            DownloadManager.Request request = new DownloadManager.Request(uri)
                .setTitle(filename)
                .setDescription("LeafVault 正在保存文件")
                .setMimeType(mimeType)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false);

            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null && !cookies.isEmpty()) request.addRequestHeader("Cookie", cookies);
            if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, DOWNLOAD_SUBDIR + "/" + filename);

            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                showToast("系统下载服务不可用。");
                return;
            }
            manager.enqueue(request);
            showToast("文件已开始下载，请在系统下载通知或下载目录查看。");
        });
    }

    private void configureBackButton(WebView webView) {
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack();
                        return;
                    }
                    long now = System.currentTimeMillis();
                    if (now - lastBackPressedAt < EXIT_CONFIRM_WINDOW_MS) {
                        finish();
                        return;
                    }
                    lastBackPressedAt = now;
                    showToast("再按一次退出 LeafVault");
                }
            }
        );
    }

    private boolean isLeafVaultHttps(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme()) && LEAFVAULT_HOST.equalsIgnoreCase(uri.getHost());
    }

    private boolean isTrustedLeafVaultUrl(String url) {
        try {
            return isLeafVaultHttps(Uri.parse(url));
        } catch (Exception ignored) {
            return false;
        }
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            showToast("没有可打开该链接的应用。");
        }
    }

    private void showToast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show());
    }

    private String sanitizeFilename(String value) {
        String name = value == null ? "" : value.trim();
        if (name.isEmpty()) name = "leafvault-download";
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        if (name.length() > 120) name = name.substring(0, 120);
        return name;
    }

    private void injectAndroidCompat(WebView webView) {
        try (InputStream input = getAssets().open("leafvault_android_bridge.js")) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            String script = buffer.toString(StandardCharsets.UTF_8.name());
            webView.evaluateJavascript(script, null);
        } catch (IOException ignored) {
            showToast("Android 兼容层加载失败。");
        }
    }

    private void showNetworkErrorPage(WebView webView, String detail) {
        String safeDetail = detail == null ? "" : detail.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        String html =
            "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<title>LeafVault</title><style>" +
            "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f8f5;color:#244234;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}" +
            "main{max-width:360px;text-align:center;}h1{font-size:24px;margin:0 0 12px;}p{line-height:1.7;color:#4f6a5b;}button{height:44px;border:0;border-radius:8px;padding:0 18px;background:#2f6b4f;color:white;font-size:16px;}" +
            "</style></head><body><main><h1>无法连接 LeafVault</h1>" +
            "<p>请检查网络连接后重试。LeafVault Android 内测版需要访问 leafvault.cn。</p>" +
            (safeDetail.isEmpty() ? "" : "<p>" + safeDetail + "</p>") +
            "<button onclick=\"location.href='https://leafvault.cn/'\">重新加载</button>" +
            "</main></body></html>";
        webView.loadDataWithBaseURL(LEAFVAULT_ORIGIN + "/", html, "text/html", "UTF-8", null);
    }

    private class LeafVaultWebViewClient extends BridgeWebViewClient {
        LeafVaultWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);

            if ("https".equals(scheme) && LEAFVAULT_HOST.equalsIgnoreCase(uri.getHost())) {
                return false;
            }
            if ("https".equals(scheme)) {
                openExternal(uri);
                return true;
            }
            if ("mailto".equals(scheme) || "tel".equals(scheme)) {
                openExternal(uri);
                return true;
            }
            showToast("已阻止非 HTTPS 或不受支持的链接。");
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (isTrustedLeafVaultUrl(url)) injectAndroidCompat(view);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                CharSequence description = error == null ? "" : error.getDescription();
                showNetworkErrorPage(view, description == null ? "" : description.toString());
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            super.onReceivedHttpError(view, request, errorResponse);
            if (request.isForMainFrame()) {
                int statusCode = errorResponse == null ? 0 : errorResponse.getStatusCode();
                showNetworkErrorPage(view, statusCode > 0 ? "服务器返回 HTTP " + statusCode : "");
            }
        }
    }

    private class LeafVaultAndroidBridge {
        @JavascriptInterface
        public void notify(String message) {
            showToast(message == null ? "" : message);
        }

        @JavascriptInterface
        public void saveBackup(String filename, String base64Data, String mimeType) {
            String safeName = sanitizeFilename(filename);
            if (!safeName.toLowerCase(Locale.ROOT).endsWith(".lvbackup")) {
                safeName = safeName + ".lvbackup";
            }
            String safeMimeType = mimeType == null || mimeType.trim().isEmpty() ? "application/json" : mimeType.trim();
            final String outputName = safeName;
            final String outputMimeType = safeMimeType;
            fileExecutor.execute(() -> {
                try {
                    byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                    saveBytesToDownloads(outputName, outputMimeType, bytes);
                    showToast("备份已保存到系统下载目录。");
                } catch (Exception error) {
                    showToast("备份保存失败，请稍后重试或改用浏览器导出。");
                }
            });
        }
    }

    private void saveBytesToDownloads(String filename, String mimeType, byte[] bytes) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_SUBDIR);
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            ContentResolver resolver = getContentResolver();
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Unable to create download entry");
            try (OutputStream output = resolver.openOutputStream(uri)) {
                if (output == null) throw new IOException("Unable to open download output stream");
                output.write(bytes);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            return;
        }

        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), DOWNLOAD_SUBDIR);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Unable to create download directory");
        File file = new File(dir, filename);
        try (OutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
        }
        MediaScannerConnection.scanFile(this, new String[] { file.getAbsolutePath() }, new String[] { mimeType }, null);
    }
}
