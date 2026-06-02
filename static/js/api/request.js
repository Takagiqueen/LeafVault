(function (window) {
    'use strict';

    function getSession() {
        return window.LeafVaultSession || {
            getAuthToken: () => '',
            clearAuthSession: () => {},
        };
    }

    function showLoginOverlay() {
        const loginOverlayEl = document.getElementById('loginOverlay');
        if (!loginOverlayEl) return;
        loginOverlayEl.classList.remove('hidden');
        loginOverlayEl.classList.add('flex');
    }

    const DEMO_LOCAL_ONLY_MESSAGE = 'Demo 模式仅支持本地体验。云端备份、多设备同步和账号设置需要正式账号。';
    const DEMO_ALLOWED_API_PATHS = new Set(['/api/deployment/status']);

    function getRequestPath(url) {
        try {
            return new URL(String(url), window.location.origin).pathname;
        } catch (_) {
            return String(url || '').split('?')[0];
        }
    }

    function notifyDemoLocalOnly() {
        if (window.LeafVaultUIState?.showToast) {
            window.LeafVaultUIState.showToast(DEMO_LOCAL_ONLY_MESSAGE, 'warning');
        } else if (typeof window.showToast === 'function') {
            window.showToast(DEMO_LOCAL_ONLY_MESSAGE, true);
        }
    }

    function shouldBlockDemoApiRequest(url) {
        const session = getSession();
        if (!session.isDemoMode?.()) return false;
        const path = getRequestPath(url);
        if (DEMO_ALLOWED_API_PATHS.has(path)) return false;
        const deploymentStatus = window.LeafVaultAuth?.getDeploymentStatus?.();
        const demoServerUploadEnabled = deploymentStatus?.demo_server_upload_enabled === true;
        if (demoServerUploadEnabled && path === '/api/diaries/') return false;
        return path.startsWith('/api/');
    }

    async function apiFetch(url, options = {}) {
        if (shouldBlockDemoApiRequest(url)) {
            notifyDemoLocalOnly();
            const error = new Error('Demo mode local only');
            error.isDemoBlocked = true;
            throw error;
        }

        const requestOptions = { ...options };
        requestOptions.headers = { ...(options.headers || {}) };
        requestOptions.credentials = options.credentials || 'same-origin';

        if (!(requestOptions.body instanceof FormData) && !requestOptions.headers['Content-Type']) {
            requestOptions.headers['Content-Type'] = 'application/json';
        }

        const session = getSession();
        const token = session.getAuthToken();
        const preferCookieSession = session.getAuthMode?.() === 'cookie' && session.hasCookieSessionHint?.();
        const tokenCompatEnabled = session.isLocalStorageTokenCompatEnabled?.() !== false;
        const bearerFallbackEnabled = session.isBearerFallbackEnabled?.() !== false;
        if (token && tokenCompatEnabled && bearerFallbackEnabled && !preferCookieSession && !requestOptions.headers.Authorization) {
            requestOptions.headers.Authorization = `Bearer ${token}`;
        }
        const method = String(requestOptions.method || 'GET').toUpperCase();
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !requestOptions.headers['X-CSRF-Token']) {
            const csrfToken = getSession().getCsrfToken?.() || '';
            if (csrfToken) requestOptions.headers['X-CSRF-Token'] = csrfToken;
        }

        const separator = url.includes('?') ? '&' : '?';
        const noCacheUrl = `${url}${separator}_t=${Date.now()}`;
        const res = await fetch(noCacheUrl, requestOptions);

        if (res.status === 403) {
            try {
                const body = await res.clone().json();
                if (body?.message === 'CSRF validation failed') {
                    const message = '登录状态校验失败，请刷新页面或重新登录。';
                    if (window.LeafVaultUIState?.showToast) {
                        window.LeafVaultUIState.showToast(message, 'error');
                    } else if (typeof window.showToast === 'function') {
                        window.showToast(message, true);
                    }
                    throw new Error('CSRF validation failed');
                }
            } catch (err) {
                if (err?.message === 'CSRF validation failed') throw err;
            }
        }

        if (res.status === 401) {
            const refreshed = await getSession().refreshSessionStatus?.();
            if (refreshed?.authenticated) return res;
            getSession().clearAuthSession();
            if (typeof window.resetLocalDBConnection === 'function') window.resetLocalDBConnection();
            showLoginOverlay();
            const message = '登录状态已过期，请重新登录。';
            if (window.LeafVaultUIState?.showToast) {
                window.LeafVaultUIState.showToast(message, 'error');
            } else if (typeof window.showToast === 'function') {
                window.showToast(message, true);
            }
            throw new Error('Unauthorized');
        }

        return res;
    }

    async function fetchWithRetry(url, options, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                const fetchOptions = { ...options, signal: controller.signal };
                const res = await apiFetch(url, fetchOptions);
                clearTimeout(timeoutId);

                if (!res.ok && res.status >= 500) throw new Error(`服务端异常: ${res.status}`);
                return res;
            } catch (err) {
                if (i === maxRetries - 1) throw err;
                const delay = (1000 * Math.pow(2, i)) + (Math.random() * 500);
                console.warn(`⏳ [网络波动] ${url} 失败，${Math.round(delay)}ms 后执行第 ${i + 1} 次重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    window.LeafVaultRequest = {
        apiFetch,
        fetchWithRetry,
    };

    window.apiFetch = apiFetch;
    window.fetchWithRetry = fetchWithRetry;
}(window));
