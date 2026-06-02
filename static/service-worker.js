const CACHE_VERSION = 'leafvault-v0.2.40-register-422-errors';
const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`;

const APP_SHELL_ASSETS = [
    '/static/output.css',
    '/static/manifest.json',
    '/static/profile-sky-bg.svg',
    '/static/vendor/dompurify/purify.min.js',
    '/static/vendor/marked/marked.min.js',
    '/static/vendor/echarts/echarts.min.js',
    '/static/vendor/html2canvas/html2canvas.min.js',
    '/static/vendor/xlsx/xlsx.full.min.js',
    '/static/js/modules/session.js?v=65-device-trusted-unlock',
    '/static/js/modules/ui-state.js?v=58-crypto-unlock-ux',
    '/static/js/api/request.js?v=59-demo-upload-status',
    '/static/js/modules/pwa-status.js?v=54-css-shell-refresh',
    '/static/js/modules/crypto-engine.js?v=65-device-trusted-unlock',
    '/static/js/modules/local-db.js?v=66-image-src-normalize',
    '/static/js/modules/incremental-sync.js?v=71-sync-v2-local-key',
    '/static/js/modules/backup.js?v=71-image-src-normalize',
    '/static/js/modules/auth.js?v=72-register-422-errors',
    '/static/js/modules/stats.js?v=36-mobile-chart-calendar',
    '/static/js/modules/profile.js?v=37-mobile-calendar-layout',
    '/static/js/modules/ui-actions.js?v=38-settings-page',
    '/static/js/modules/ledger.js?v=70-restore-backup-image-path',
    '/static/js/modules/diary.js?v=71-image-src-normalize',
    '/static/js/modules/app-startup.js?v=55-csp-vendor',
    '/static/js/utils/image.js?v=44-diary-image-upload',
    '/static/js/utils/date.js',
    '/static/js/utils/month-picker.js',
    '/static/js/utils/date-picker.js'
];

function isSensitiveRequest(request, url) {
    if (request.method !== 'GET') return true;
    if (request.headers.has('Authorization')) return true;
    if (url.origin !== self.location.origin) return true;
    if (url.pathname.startsWith('/api/')) return true;
    if (url.pathname === '/profile' || url.pathname.startsWith('/profile/')) return true;
    if (url.pathname.startsWith('/static/images/')) return true;
    if (url.pathname.startsWith('/static/uploads/')) return true;
    if (url.pathname.startsWith('/uploads/')) return true;
    if (looksLikeRawImageBase64Path(url.pathname)) return true;
    return false;
}

function looksLikeRawImageBase64Path(pathname) {
    const value = String(pathname || '').replace(/^\/+/, '');
    return value.startsWith('9j/')
        || value.startsWith('iVBOR')
        || value.startsWith('UklGR')
        || value.startsWith('R0lGOD');
}

function isStaticAsset(url) {
    return url.origin === self.location.origin
        && /\.(?:js|css|png|svg|ico|webmanifest|json)$/.test(url.pathname);
}

function isCodeAsset(url) {
    return url.origin === self.location.origin && /\.(?:js|css)$/.test(url.pathname);
}

function cacheResponse(cacheKey, response) {
    // Response body 只能消费一次；缓存前先 clone，原始 response 直接返回页面。
    const responseForCache = response.clone();
    return caches.open(APP_SHELL_CACHE)
        .then(cache => cache.put(cacheKey, responseForCache))
        .catch(() => null);
}

async function fetchNetworkOrError(request) {
    try {
        return await fetch(request);
    } catch (error) {
        return Response.error();
    }
}

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(APP_SHELL_CACHE).then(cache => (
            Promise.allSettled(APP_SHELL_ASSETS.map(asset => cache.add(asset)))
        ))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => (key !== APP_SHELL_CACHE ? caches.delete(key) : Promise.resolve()))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('fetch', event => {
    try {
        const request = event.request;
        if (request.url.startsWith('data:') || request.url.startsWith('blob:')) {
            return;
        }
        const url = new URL(request.url);

        if (looksLikeRawImageBase64Path(url.pathname)) {
            event.respondWith(new Response('Invalid LeafVault image path', { status: 400 }));
            return;
        }

        if (isSensitiveRequest(request, url)) {
            event.respondWith(fetchNetworkOrError(request));
            return;
        }

        if (request.mode === 'navigate') {
            event.respondWith((async () => {
                try {
                    // HTML App Shell 走网络优先且不写入缓存，避免 Docker/预生产环境继续显示旧页面。
                    return await fetch(request);
                } catch (error) {
                    return new Response('LeafVault 暂时离线，请稍后重试。', {
                        status: 503,
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
                    });
                }
            })());
            return;
        }

        if (isCodeAsset(url)) {
            event.respondWith((async () => {
                try {
                    const networkResponse = await fetch(request);
                    if (networkResponse.ok) {
                        event.waitUntil(cacheResponse(request, networkResponse));
                    }
                    return networkResponse;
                } catch (error) {
                    return (await caches.match(request)) || Response.error();
                }
            })());
            return;
        }

        if (isStaticAsset(url)) {
            event.respondWith((async () => {
                const cached = await caches.match(request);
                if (cached) return cached;
                try {
                    const networkResponse = await fetch(request);
                    if (networkResponse.ok) {
                        event.waitUntil(cacheResponse(request, networkResponse));
                    }
                    return networkResponse;
                } catch (error) {
                    return Response.error();
                }
            })());
            return;
        }

        event.respondWith(fetchNetworkOrError(request));
    } catch (error) {
        event.respondWith(fetchNetworkOrError(event.request));
    }
});

// 后台同步只发送轻量指令；真正的加密数据同步仍由前端主线程执行。
self.addEventListener('sync', event => {
    if (event.tag === 'LeafVault-sync') {
        event.waitUntil(executeBackgroundSync());
    }
});

async function executeBackgroundSync() {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 只唤醒一个可见/聚焦页面，避免多个窗口同时收到 EXECUTE_SYNC 后并发上传同一批记录。
    const target = clients.find(client => client.focused)
        || clients.find(client => client.visibilityState === 'visible')
        || clients[0];
    if (!target) return;
    target.postMessage({ type: 'SYNC_STARTED' });
    target.postMessage({ type: 'EXECUTE_SYNC' });
}
