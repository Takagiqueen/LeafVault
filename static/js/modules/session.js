(function (window) {
    'use strict';

    const TOKEN_KEY = 'LeafVault_token';
    const USER_ID_KEY = 'LeafVault_user_id';
    const AUTH_MODE_KEY = 'LeafVault_auth_mode';
    const SESSION_MODE_KEY = 'LeafVault_session_mode';
    const CRYPTO_UNLOCK_META_KEY = 'LeafVault_crypto_unlock_meta_v1';
    const DEMO_USER_ID = 'demo-local-user';
    const DEMO_WORKSPACE_ID = 'leafvault_demo_v1';
    const CRYPTO_UNLOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const CRYPTO_UNLOCK_VERSION = 1;
    const PASSWORD_MIGRATION_STORES = [
        'diaries',
        'ledgers',
        'diary_drafts',
        'local_changes',
        'applied_remote_changes',
        'sync_conflicts',
        'sync_history',
    ];
    let authMode = localStorage.getItem(AUTH_MODE_KEY) || 'bearer';
    let sessionMode = localStorage.getItem(SESSION_MODE_KEY) || 'guest';
    let cookieSessionAuthenticated = false;
    let localStorageTokenCompat = true;
    let storeTokenInLocalStorage = true;
    let bearerFallbackEnabled = true;
    let deprecationHintShown = false;
    let sessionStatusCache = null;
    let unlockPromptPromise = null;
    let cryptoState = 'locked';

    function getAuthToken() {
        return localStorage.getItem(TOKEN_KEY);
    }

    function shouldStoreTokenInLocalStorage() {
        return storeTokenInLocalStorage !== false && localStorageTokenCompat !== false;
    }

    function setStoreTokenInLocalStorage(value) {
        storeTokenInLocalStorage = value !== false;
    }

    function persistAuthToken(token) {
        if (!token) return;
        localStorage.setItem(TOKEN_KEY, String(token));
    }

    function setAuthToken(token, options = {}) {
        if (!token) return;
        if (options.force === true || shouldStoreTokenInLocalStorage()) {
            persistAuthToken(token);
        }
    }

    function setAuthTokenCompat(token) {
        // 仅用于开发或迁移兼容，生产默认不推荐继续把 access token 写入 localStorage。
        setAuthToken(token, { force: true });
    }

    function clearAuthSession() {
        const currentUserId = getCurrentUserId();
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_ID_KEY);
        localStorage.removeItem(AUTH_MODE_KEY);
        localStorage.removeItem(SESSION_MODE_KEY);
        window.CryptoEngine?.clearKey?.();
        // 清除 7 天可信解锁：meta + seal + deviceWrapKey 一并删除
        clearCryptoUnlockMeta();
        window.CryptoEngine?.clearTrustedUnlock?.();
        if (currentUserId) {
            window.CryptoEngine?.deleteDeviceWrapKeyForUser?.(currentUserId)?.catch(() => null);
        }
        setCryptoLocked({ showBanner: false, clearMeta: false, clearKey: false });
        hideCryptoLockedBanner();
        authMode = 'bearer';
        sessionMode = 'guest';
        cookieSessionAuthenticated = false;
        localStorageTokenCompat = true;
        storeTokenInLocalStorage = true;
        bearerFallbackEnabled = true;
        sessionStatusCache = null;
    }

    function readCryptoUnlockMeta() {
        try {
            const raw = localStorage.getItem(CRYPTO_UNLOCK_META_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function clearCryptoUnlockMeta() {
        try {
            localStorage.removeItem(CRYPTO_UNLOCK_META_KEY);
        } catch (_) {}
    }

    function getValidCryptoUnlockMeta(userId = getCurrentUserId()) {
        const meta = readCryptoUnlockMeta();
        if (!meta || meta.unlockVersion !== CRYPTO_UNLOCK_VERSION || !meta.userId || meta.userId !== userId) {
            return null;
        }
        if (!Number.isFinite(Number(meta.expiresAt)) || Number(meta.expiresAt) <= Date.now()) {
            clearCryptoUnlockMeta();
            return null;
        }
        return meta;
    }

    function persistCryptoUnlockMeta(userId = getCurrentUserId()) {
        if (!userId || isDemoMode()) return null;
        const now = Date.now();
        const meta = {
            userId: String(userId),
            unlockedAt: now,
            expiresAt: now + CRYPTO_UNLOCK_TTL_MS,
            unlockVersion: CRYPTO_UNLOCK_VERSION,
        };
        localStorage.setItem(CRYPTO_UNLOCK_META_KEY, JSON.stringify(meta));
        return meta;
    }

    function getTrustedUnlockOptions() {
        return { trustedUntil: Date.now() + CRYPTO_UNLOCK_TTL_MS };
    }

    function setSessionMode(mode) {
        sessionMode = ['guest', 'demo', 'user'].includes(mode) ? mode : 'guest';
        try {
            localStorage.setItem(SESSION_MODE_KEY, sessionMode);
        } catch (_) {}
    }

    function getSessionMode() {
        return sessionMode;
    }

    function isDemoMode() {
        return sessionMode === 'demo';
    }

    async function enterDemoMode() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AUTH_MODE_KEY);
        window.CryptoEngine?.clearKey?.();
        setCryptoLocked({ showBanner: false });
        hideCryptoLockedBanner();
        localStorage.setItem(USER_ID_KEY, DEMO_USER_ID);
        setSessionMode('demo');
        authMode = 'bearer';
        cookieSessionAuthenticated = false;
        sessionStatusCache = {
            status: 'success',
            authenticated: true,
            auth_source: 'demo',
            user_id: DEMO_USER_ID,
            username: 'Demo',
        };
        if (typeof window.resetLocalDBConnection === 'function') window.resetLocalDBConnection();
        await window.initLocalDB?.().catch(() => null);
        await window.CryptoEngine?.init?.({ force: true }).catch(() => null);
        if (window.CryptoEngine?.hasKey?.()) setCryptoUnlocked();
        return sessionStatusCache;
    }

    function exitDemoMode() {
        if (isDemoMode()) {
            localStorage.removeItem(USER_ID_KEY);
        }
        window.CryptoEngine?.clearKey?.();
        setCryptoLocked({ showBanner: false });
        hideCryptoLockedBanner();
        setSessionMode('guest');
        authMode = 'bearer';
        cookieSessionAuthenticated = false;
        sessionStatusCache = null;
        if (typeof window.resetLocalDBConnection === 'function') window.resetLocalDBConnection();
    }

    function restoreDemoSession() {
        if (localStorage.getItem(SESSION_MODE_KEY) !== 'demo') return false;
        sessionMode = 'demo';
        localStorage.setItem(USER_ID_KEY, DEMO_USER_ID);
        cookieSessionAuthenticated = false;
        sessionStatusCache = {
            status: 'success',
            authenticated: true,
            auth_source: 'demo',
            user_id: DEMO_USER_ID,
            username: 'Demo',
        };
        return true;
    }

    function deleteIndexedDBDatabase(dbName) {
        return new Promise((resolve) => {
            if (!dbName || !window.indexedDB) return resolve(false);
            const request = window.indexedDB.deleteDatabase(dbName);
            request.onsuccess = () => resolve(true);
            request.onerror = () => resolve(false);
            request.onblocked = () => resolve(false);
        });
    }

    async function clearDemoData() {
        const wasDemo = isDemoMode();
        if (typeof window.resetLocalDBConnection === 'function') window.resetLocalDBConnection();
        const dbName = typeof window.getDemoLocalDBName === 'function'
            ? window.getDemoLocalDBName()
            : `LeafVault_DB_${DEMO_WORKSPACE_ID}`;
        await deleteIndexedDBDatabase(dbName);
        if (wasDemo) {
            localStorage.setItem(USER_ID_KEY, DEMO_USER_ID);
            setSessionMode('demo');
            await window.initLocalDB?.().catch(() => null);
            await window.CryptoEngine?.init?.({ force: true }).catch(() => null);
            if (window.CryptoEngine?.hasKey?.()) setCryptoUnlocked();
        }
    }

    function getCookie(name) {
        const target = `${encodeURIComponent(name)}=`;
        const item = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(target));
        return item ? decodeURIComponent(item.slice(target.length)) : '';
    }

    function getCsrfToken() {
        return getCookie('leafvault_csrf_token');
    }

    function hasCookieSessionHint() {
        return Boolean(getCsrfToken());
    }

    function setAuthMode(mode) {
        authMode = ['bearer', 'cookie', 'dual'].includes(mode) ? mode : 'bearer';
        try {
            localStorage.setItem(AUTH_MODE_KEY, authMode);
        } catch (_) {}
    }

    function getAuthMode() {
        return authMode;
    }

    function readUserIdFromToken(token = getAuthToken()) {
        if (!token) return '';
        try {
            const payloadPart = token.split('.')[1] || '';
            const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
            const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
            const payload = JSON.parse(atob(padded));
            return payload.sub || '';
        } catch (_) {
            return '';
        }
    }

    function getCurrentUserId() {
        if (isDemoMode()) return DEMO_USER_ID;
        return localStorage.getItem(USER_ID_KEY) || readUserIdFromToken();
    }

    function setCurrentUserId(userId) {
        if (!userId) return;
        const nextUserId = String(userId);
        const prevUserId = localStorage.getItem(USER_ID_KEY) || '';
        if (prevUserId && prevUserId !== nextUserId) {
            clearCryptoUnlockMeta();
            window.CryptoEngine?.clearTrustedUnlock?.();
            window.CryptoEngine?.deleteDeviceWrapKeyForUser?.(prevUserId)?.catch(() => null);
            window.CryptoEngine?.clearKey?.();
            setCryptoLocked({ showBanner: false, clearMeta: false, clearKey: false });
        }
        localStorage.setItem(USER_ID_KEY, nextUserId);
        if (prevUserId && prevUserId !== nextUserId && typeof window.resetLocalDBConnection === 'function') {
            window.resetLocalDBConnection();
        }
    }

    function applySessionPolicy(status = {}) {
        if (Object.prototype.hasOwnProperty.call(status, 'store_token_in_localstorage')) {
            storeTokenInLocalStorage = status.store_token_in_localstorage !== false;
        }
        if (Object.prototype.hasOwnProperty.call(status, 'localstorage_compat')) {
            localStorageTokenCompat = status.localstorage_compat !== false;
        }
        if (Object.prototype.hasOwnProperty.call(status, 'bearer_fallback')) {
            bearerFallbackEnabled = status.bearer_fallback !== false;
        }
    }

    function maybeShowLocalStorageDeprecationHint(status = {}) {
        if (!status?.localstorage_deprecation_warning || !getAuthToken() || deprecationHintShown) return;
        deprecationHintShown = true;
        window.showToast?.('当前仍启用 localStorage token 兼容模式。生产环境建议逐步切换到 Cookie 优先登录态。');
    }

    function migrateLegacyLocalStorageTokenIfNeeded() {
        // 本阶段只提示、不强删旧 token，避免旧会话在刷新后突然掉登录。
        if (cookieSessionAuthenticated && !shouldStoreTokenInLocalStorage() && getAuthToken() && !deprecationHintShown) {
            deprecationHintShown = true;
            window.showToast?.('检测到旧版本地 token。Cookie 登录态已可用，退出登录会清理本地 token。');
        }
    }

    async function refreshSessionStatus() {
        if (restoreDemoSession()) {
            return sessionStatusCache;
        }
        try {
            const token = getAuthToken();
            const headers = token && authMode !== 'cookie' && bearerFallbackEnabled ? { Authorization: `Bearer ${token}` } : {};
            const res = await fetch(`/api/session/status?_t=${Date.now()}`, {
                method: 'GET',
                credentials: 'same-origin',
                headers,
            });
            const json = await res.json();
            sessionStatusCache = json;
            applySessionPolicy(json);
            cookieSessionAuthenticated = Boolean(json?.authenticated && json?.auth_source === 'cookie');
            maybeShowLocalStorageDeprecationHint(json);
            if (json?.authenticated) {
                setSessionMode('user');
                setAuthMode(json.auth_source === 'cookie' ? 'cookie' : 'bearer');
                if (json.user_id) setCurrentUserId(json.user_id);
                migrateLegacyLocalStorageTokenIfNeeded();
                if (!window.CryptoEngine?.hasKey?.()) {
                    const validMeta = getValidCryptoUnlockMeta();
                    if (validMeta) {
                        await window.CryptoEngine?.restoreTrustedUnlock?.(validMeta).catch(() => false);
                    }
                    if (!window.CryptoEngine?.hasKey?.()) {
                        await window.CryptoEngine?.init?.().catch(() => null);
                    }
                }
                if (window.CryptoEngine?.hasKey?.() && getValidCryptoUnlockMeta()) {
                    markCryptoUnlockedActive();
                } else {
                    setCryptoLocked({ showBanner: true });
                }
            } else {
                setCryptoLocked({ showBanner: false });
                hideCryptoLockedBanner();
            }
            return json;
        } catch (_) {
            sessionStatusCache = null;
            cookieSessionAuthenticated = false;
            return { status: 'error', authenticated: false };
        }
    }

    function isAuthenticated() {
        return Boolean(isDemoMode() || getAuthToken() || cookieSessionAuthenticated);
    }

    function isLocalStorageTokenCompatEnabled() {
        return localStorageTokenCompat;
    }

    function isBearerFallbackEnabled() {
        return bearerFallbackEnabled;
    }

    function getSessionStatusCache() {
        return sessionStatusCache;
    }

    // 当前页面会话是否已解锁：只要 CryptoEngine 持有有效 key 即可操作。
    // 7 天免解锁 meta 只影响刷新后能否自动恢复，不影响当前页面会话。
    function isCryptoUnlocked() {
        if (isDemoMode()) return Boolean(window.CryptoEngine?.hasKey?.());
        // 优先检查内存中的 key，不因 meta 缺失而清除 key
        if (window.CryptoEngine?.hasKey?.()) return true;
        // 无 key 时检查 meta，尝试自动恢复
        if (!getValidCryptoUnlockMeta()) return false;
        return false;
    }

    function setCryptoLocked(options = {}) {
        cryptoState = 'locked';
        if (options.clearMeta !== false) {
            clearCryptoUnlockMeta();
            window.CryptoEngine?.clearTrustedUnlock?.();
            // 同时清除 deviceWrapKey，确保下次必须重新输入密码
            const uid = getCurrentUserId();
            if (uid) {
                window.CryptoEngine?.deleteDeviceWrapKeyForUser?.(uid)?.catch(() => null);
            }
        }
        if (options.clearKey !== false) window.CryptoEngine?.clearKey?.();
        hideCryptoLockedBanner();
    }

    // 标记当前页面会话已解锁。trusted=true 时额外保存 7 天免解锁 meta。
    function setCryptoUnlocked(options = {}) {
        cryptoState = 'unlocked';
        if (options.trusted === true) {
            persistCryptoUnlockMeta(options.userId || getCurrentUserId());
        }
        // 向后兼容：persist 参数仍支持
        if (options.persist !== false && options.trusted === undefined) {
            persistCryptoUnlockMeta(options.userId || getCurrentUserId());
        }
    }

    function markCryptoUnlockedActive() {
        cryptoState = 'unlocked';
    }

    function getCryptoState() {
        // 只要内存中有 key，当前会话就是 unlocked
        if (window.CryptoEngine?.hasKey?.()) return 'unlocked';
        // 无 key 时检查 meta 和 cryptoState 标记
        if (isDemoMode()) return cryptoState;
        return getValidCryptoUnlockMeta() ? 'unlocked' : cryptoState;
    }

    function notifyLocalEncryptionLocked() {
        const message = window.CryptoEngine?.LOCAL_ENCRYPTION_LOCKED_MESSAGE || '本地加密空间尚未解锁，请重新输入密码解锁。';
        if (window.LeafVaultUIState?.showToast) {
            window.LeafVaultUIState.showToast(message, 'warning');
        } else {
            window.showToast?.(message, true);
        }
    }

    function showCryptoLockedBanner() {
        hideCryptoLockedBanner();
    }

    function hideCryptoLockedBanner() {
        document.getElementById('cryptoLockedBanner')?.remove();
    }

    function lockLocalCryptoSpace() {
        // 清除 7 天可信解锁：meta + seal + deviceWrapKey 一并删除
        clearCryptoUnlockMeta();
        window.CryptoEngine?.clearTrustedUnlock?.();
        const uid = getCurrentUserId();
        if (uid) {
            window.CryptoEngine?.deleteDeviceWrapKeyForUser?.(uid)?.catch(() => null);
        }
        setCryptoLocked({ showBanner: false, clearMeta: false, clearKey: true });
        window.showToast?.('本地加密空间已锁定');
    }

    function getOrCreateUnlockPanel() {
        let panel = document.getElementById('localEncryptionUnlockPanel');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'localEncryptionUnlockPanel';
        panel.className = 'local-unlock-overlay hidden';
        panel.innerHTML = `
            <div class="local-unlock-card" role="dialog" aria-modal="true" aria-labelledby="localEncryptionUnlockTitle">
                <div class="local-unlock-head">
                    <div class="local-unlock-icon">
                        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="3"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path><path d="M12 14v2"></path></svg>
                    </div>
                    <div class="min-w-0 text-left">
                        <h2 id="localEncryptionUnlockTitle">解锁本地加密空间</h2>
                        <p>输入一次密码后，本设备 7 天内无需重复解锁。密码不会保存到服务器或本地明文存储。</p>
                    </div>
                </div>
                <form id="localEncryptionUnlockForm" class="local-unlock-form">
                    <input name="account" type="email" autocomplete="username" required placeholder="登录邮箱">
                    <input name="password" type="password" autocomplete="current-password" required placeholder="登录密码">
                    <div id="localEncryptionUnlockHint" class="local-unlock-hint" aria-live="polite"></div>
                    <div class="local-unlock-actions">
                        <button type="button" data-local-unlock-cancel class="local-unlock-secondary">稍后</button>
                        <button type="submit" class="local-unlock-primary">解锁</button>
                    </div>
                </form>
            </div>`;
        document.body.appendChild(panel);
        return panel;
    }

    function showLocalEncryptionUnlockPanel() {
        if (unlockPromptPromise) return unlockPromptPromise;
        const panel = getOrCreateUnlockPanel();
        const form = panel.querySelector('#localEncryptionUnlockForm');
        const hint = panel.querySelector('#localEncryptionUnlockHint');
        const cancelBtn = panel.querySelector('[data-local-unlock-cancel]');
        panel.classList.remove('hidden');
        panel.classList.add('flex');
        form?.querySelector('input[name="account"]')?.focus();

        unlockPromptPromise = new Promise((resolve) => {
            const cleanup = (result) => {
                panel.classList.add('hidden');
                panel.classList.remove('flex');
                form?.reset();
                if (hint) hint.textContent = '';
                form?.removeEventListener('submit', onSubmit);
                cancelBtn?.removeEventListener('click', onCancel);
                unlockPromptPromise = null;
                resolve(result);
            };
            const onCancel = () => cleanup(false);
            const onSubmit = async (event) => {
                event.preventDefault();
                const submitBtn = form.querySelector('button[type="submit"]');
                const originalText = submitBtn?.textContent || '解锁';
                const fd = new FormData(form);
                const account = String(fd.get('account') || '').trim();
                const password = String(fd.get('password') || '');
                if (!account || !password) {
                    if (hint) hint.textContent = '请输入登录邮箱和密码。';
                    return;
                }
                try {
                    if (submitBtn) {
                        submitBtn.disabled = true;
                        submitBtn.textContent = '解锁中...';
                    }
                    const loginData = new FormData();
                    loginData.append('account', account);
                    loginData.append('password', password);
                    const res = await fetch('/api/login', {
                        method: 'POST',
                        body: loginData,
                        credentials: 'same-origin',
                    });
                    const json = await res.json();
                    if (json?.status !== 'success') {
                        if (hint) hint.textContent = json?.message || '账号或密码不正确。';
                        return;
                    }
                    const currentUserId = getCurrentUserId();
                    if (currentUserId && json.user_id && currentUserId !== json.user_id) {
                        if (hint) hint.textContent = '请使用当前账号对应的密码解锁。';
                        return;
                    }
                    applySessionPolicy(json);
                    setSessionMode('user');
                    setAuthMode(json.prefer_cookie ? 'cookie' : 'bearer');
                    if (json.user_id) setCurrentUserId(json.user_id);
                    if (json.token && json.localstorage_compat !== false) setAuthToken(json.token);
                    const unlockResult = await window.CryptoEngine?.unlockWithPassword?.(password, json.user_id || getCurrentUserId(), json.token || '', getTrustedUnlockOptions());
                    // keySet=true → 当前页面会话立即解锁，后续操作不再弹密码
                    markCryptoUnlockedActive();
                    if (unlockResult?.sealCached) {
                        // deviceWrapKey 封存成功 → 持久化 7 天免解锁 meta
                        const meta = persistCryptoUnlockMeta(json.user_id || getCurrentUserId());
                        const expiryDate = meta ? new Date(meta.expiresAt) : null;
                        const expiryStr = expiryDate && !isNaN(expiryDate.getTime())
                            ? `${expiryDate.getFullYear()}-${String(expiryDate.getMonth() + 1).padStart(2, '0')}-${String(expiryDate.getDate()).padStart(2, '0')} ${String(expiryDate.getHours()).padStart(2, '0')}:${String(expiryDate.getMinutes()).padStart(2, '0')}`
                            : '';
                        window.showToast?.(`本地加密空间已解锁，有效至 ${expiryStr}`);
                    } else {
                        // IndexedDB / Web Crypto 不可用 → 无法保存 7 天状态
                        clearCryptoUnlockMeta();
                        window.showToast?.('当前浏览器无法保存 7 天免解锁状态，本次页面会话已解锁');
                    }
                    await refreshSessionStatus();
                    cleanup(true);
                } catch (_) {
                    if (hint) hint.textContent = '解锁失败，请稍后再试。';
                } finally {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = originalText;
                    }
                }
            };
            form?.addEventListener('submit', onSubmit);
            cancelBtn?.addEventListener('click', onCancel);
        });
        return unlockPromptPromise;
    }

    function openUnlockCryptoModal(reason = '') {
        return showLocalEncryptionUnlockPanel(reason);
    }

    async function requireCryptoUnlocked(options = {}) {
        const prompt = options.prompt === true;
        // 最高优先级：内存中已有 key → 当前会话已解锁，立即返回
        if (window.CryptoEngine?.hasKey?.()) {
            markCryptoUnlockedActive();
            return true;
        }
        if (isDemoMode()) {
            await window.CryptoEngine?.init?.({ force: true }).catch(() => null);
            if (window.CryptoEngine?.hasKey?.()) {
                markCryptoUnlockedActive();
                return true;
            }
            return false;
        }
        if (!isAuthenticated()) return false;
        // 无 key → 尝试从 7 天 seal 恢复
        const validMeta = getValidCryptoUnlockMeta();
        if (validMeta) {
            await window.CryptoEngine?.restoreTrustedUnlock?.(validMeta).catch(() => false);
            if (window.CryptoEngine?.hasKey?.()) {
                markCryptoUnlockedActive();
                return true;
            }
        }
        // 尝试 legacy init 回退
        await window.CryptoEngine?.init?.().catch(() => null);
        if (window.CryptoEngine?.hasKey?.()) {
            markCryptoUnlockedActive();
            return true;
        }
        // 所有恢复手段都失败 → 确实需要用户输入密码
        setCryptoLocked({ showBanner: !prompt });
        if (!prompt) return false;
        notifyLocalEncryptionLocked();
        return Boolean(await openUnlockCryptoModal(options.actionName || 'encrypted_action'));
    }

    async function ensureCryptoOrPrompt(actionName = '') {
        return requireCryptoUnlocked({ prompt: true, actionName });
    }

    async function ensureLocalEncryptionUnlocked(options = {}) {
        return requireCryptoUnlocked({
            prompt: options.prompt !== false,
            actionName: options.actionName || 'legacy_unlock',
            consume: options.consume,
        });
    }

    async function unlockCryptoWithPassword(email, password) {
        if (!email || !password) return false;
        const loginData = new FormData();
        loginData.append('account', String(email).trim());
        loginData.append('password', String(password));
        const res = await fetch('/api/login', {
            method: 'POST',
            body: loginData,
            credentials: 'same-origin',
        });
        const json = await res.json();
        if (json?.status !== 'success') return false;
        const currentUserId = getCurrentUserId();
        if (currentUserId && json.user_id && currentUserId !== json.user_id) return false;
        applySessionPolicy(json);
        setSessionMode('user');
        setAuthMode(json.prefer_cookie ? 'cookie' : 'bearer');
        if (json.user_id) setCurrentUserId(json.user_id);
        if (json.token && json.localstorage_compat !== false) setAuthToken(json.token);
        const unlockResult = await window.CryptoEngine?.unlockWithPassword?.(password, json.user_id || getCurrentUserId(), json.token || '', getTrustedUnlockOptions());
        // keySet=true → 当前页面会话立即解锁
        markCryptoUnlockedActive();
        if (unlockResult?.sealCached) {
            persistCryptoUnlockMeta(json.user_id || getCurrentUserId());
        } else {
            clearCryptoUnlockMeta();
        }
        await refreshSessionStatus();
        return true;
    }

    function openIndexedDBByName(dbName) {
        return new Promise((resolve, reject) => {
            if (!dbName || !window.indexedDB) return reject(new Error('IndexedDB unavailable'));
            const request = window.indexedDB.open(dbName);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
        });
    }

    function getAllRecords(db, storeName) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
        });
    }

    function putRecords(db, storeName, records) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);
            records.forEach((record) => store.put(record));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
        });
    }

    function createPasswordMigrationError(stage, message, cause) {
        const error = new Error(message || '本地数据迁移失败');
        error.stage = stage || 'unknown';
        error.userMessage = message || '本地数据迁移失败';
        if (cause) error.cause = cause;
        return error;
    }

    async function refreshTrustedUnlockAfterPasswordChange(currentPassword) {
        const userId = getCurrentUserId();
        if (!userId || !currentPassword) {
            throw createPasswordMigrationError('refresh_trusted_unlock', '密码已修改，请重新解锁本地加密空间。');
        }
        // 修改密码后旧 seal / meta / deviceWrapKey 都不能继续使用，避免 7 天可信解锁仍指向旧密码 key。
        clearCryptoUnlockMeta();
        window.CryptoEngine?.clearTrustedUnlock?.();
        await window.CryptoEngine?.deleteDeviceWrapKeyForUser?.(userId)?.catch(() => false);
        const unlockResult = await window.CryptoEngine?.unlockWithPassword?.(
            currentPassword,
            userId,
            getAuthToken() || '',
            getTrustedUnlockOptions()
        );
        markCryptoUnlockedActive();
        if (unlockResult?.sealCached) {
            persistCryptoUnlockMeta(userId);
        } else {
            clearCryptoUnlockMeta();
        }
        hideLocalDataRecoveryPanel();
        return { ok: true, sealCached: Boolean(unlockResult?.sealCached) };
    }

    async function getStoreRecordsForPasswordMigration(db, storeName) {
        if (!db?.objectStoreNames?.contains?.(storeName)) return [];
        try {
            return await getAllRecords(db, storeName);
        } catch (error) {
            throw createPasswordMigrationError('read_local_db', '本地数据读取失败，已阻止修改密码。', error);
        }
    }

    async function migrateLocalDataWithPasswords(oldPassword, currentPassword, options = {}) {
        const userId = getCurrentUserId();
        const dbName = typeof window.getLocalDBName === 'function' ? window.getLocalDBName() : '';
        const shouldRefreshTrustedUnlock = options.refreshTrustedUnlock !== false;
        const preferCurrentKey = options.preferCurrentKey !== false;
        console.info('change password: current userId', userId || '(none)');
        console.info('change password: CryptoEngine.hasKey()', Boolean(window.CryptoEngine?.hasKey?.()));
        if (!userId || !dbName) {
            throw createPasswordMigrationError('read_local_db', '本地数据空间不存在');
        }
        let db = null;
        const recordsByStore = new Map();
        let migratedCount = 0;
        try {
            try {
                db = await openIndexedDBByName(dbName);
            } catch (error) {
                throw createPasswordMigrationError('read_local_db', '本地数据读取失败，已阻止修改密码。', error);
            }

            for (const storeName of PASSWORD_MIGRATION_STORES) {
                const records = await getStoreRecordsForPasswordMigration(db, storeName);
                recordsByStore.set(storeName, records);
            }
            const diaryCount = recordsByStore.get('diaries')?.length || 0;
            const ledgerCount = recordsByStore.get('ledgers')?.length || 0;
            console.info('change password: local diary count', diaryCount);
            console.info('change password: local ledger count', ledgerCount);

            const totalRecords = Array.from(recordsByStore.values()).reduce((sum, records) => sum + records.length, 0);
            if (totalRecords === 0) {
                console.info('change password: migration mode', 'noop');
                if (shouldRefreshTrustedUnlock) await refreshTrustedUnlockAfterPasswordChange(currentPassword);
                return { ok: true, mode: 'noop', migrated: 0, migratedCount: 0, failedCount: 0 };
            }

            let oldKey = null;
            let newKey = null;
            try {
                if (!preferCurrentKey || !window.CryptoEngine?.hasKey?.()) {
                    oldKey = await window.CryptoEngine?.derivePasswordKey?.(oldPassword, userId);
                }
            } catch (error) {
                console.info('change password: failed stage', 'verify_old_password');
                throw createPasswordMigrationError('verify_old_password', '原密码不正确。', error);
            }
            try {
                newKey = await window.CryptoEngine?.derivePasswordKey?.(currentPassword, userId);
            } catch (error) {
                console.info('change password: failed stage', 'encrypt_new_data');
                throw createPasswordMigrationError('encrypt_new_data', '本地数据重新加密失败，已阻止修改密码。', error);
            }
            if ((!preferCurrentKey || !window.CryptoEngine?.hasKey?.()) && !oldKey) {
                console.info('change password: failed stage', 'verify_old_password');
                throw createPasswordMigrationError('verify_old_password', '原密码不正确。');
            }
            if (!newKey) {
                console.info('change password: failed stage', 'encrypt_new_data');
                throw createPasswordMigrationError('encrypt_new_data', '本地数据重新加密失败，已阻止修改密码。');
            }

            const writes = [];
            for (const [storeName, records] of recordsByStore.entries()) {
                if (!records.length) continue;
                const nextRecords = [];
                for (const record of records) {
                    let plain = null;
                    try {
                        if (record?.is_encrypted) {
                            plain = preferCurrentKey && window.CryptoEngine?.hasKey?.()
                                ? await window.CryptoEngine.decrypt(record)
                                : await window.CryptoEngine.decryptWithKey(record, oldKey);
                        } else {
                            plain = record;
                        }
                    } catch (error) {
                        console.info('change password: failed stage', 'decrypt_old_data');
                        throw createPasswordMigrationError(
                            'decrypt_old_data',
                            '发现无法解密的本地数据，为避免数据丢失，已阻止修改密码。请先导出备份或清理本地数据。',
                            error
                        );
                    }
                    try {
                        nextRecords.push(await window.CryptoEngine.encryptWithKey(plain, newKey));
                        migratedCount += 1;
                    } catch (error) {
                        console.info('change password: failed stage', 'encrypt_new_data');
                        throw createPasswordMigrationError('encrypt_new_data', '本地数据重新加密失败，已阻止修改密码。', error);
                    }
                }
                writes.push({ storeName, records: nextRecords });
            }

            for (const item of writes) {
                try {
                    if (item.records.length) await putRecords(db, item.storeName, item.records);
                } catch (error) {
                    console.info('change password: failed stage', 'encrypt_new_data');
                    throw createPasswordMigrationError('encrypt_new_data', '本地数据重新加密失败，已阻止修改密码。', error);
                }
            }
            console.info('change password: migration mode', migratedCount > 0 ? 'migrated' : 'noop');
            if (shouldRefreshTrustedUnlock) await refreshTrustedUnlockAfterPasswordChange(currentPassword);
            return { ok: true, mode: migratedCount > 0 ? 'migrated' : 'noop', migrated: migratedCount, migratedCount, failedCount: 0 };
        } catch (error) {
            if (!error.stage) error.stage = 'unknown';
            console.info('change password: migration mode', 'failed');
            console.info('change password: failed stage', error.stage);
            throw error;
        } finally {
            try { db?.close?.(); } catch (_) {}
        }
    }

    async function clearCurrentUserLocalCache() {
        const dbName = typeof window.getLocalDBName === 'function' ? window.getLocalDBName() : '';
        if (!dbName) throw new Error('本地数据空间不存在');
        if (!window.confirm('清空本地缓存不会删除云端账号，但会删除当前浏览器里的本地日记、账本缓存和待同步记录。是否继续？')) {
            return false;
        }
        if (!window.confirm('请再次确认：此操作不会自动恢复，请确保你有本地加密备份或云端密文备份。继续清空？')) {
            return false;
        }
        if (typeof window.resetLocalDBConnection === 'function') window.resetLocalDBConnection();
        const deleted = await deleteIndexedDBDatabase(dbName);
        await window.initLocalDB?.().catch(() => null);
        setCryptoLocked({ showBanner: true });
        hideLocalDataRecoveryPanel();
        window.showToast?.(deleted ? '本地缓存已清空，请重新解锁后继续使用。' : '本地缓存清理未完成，请刷新后再试。', !deleted);
        return deleted;
    }

    function getOrCreateLocalDataRecoveryPanel() {
        let panel = document.getElementById('localDataRecoveryPanel');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'localDataRecoveryPanel';
        panel.className = 'hidden fixed inset-0 z-[240] items-center justify-center overflow-y-auto px-4 py-6 bg-emerald-950/18 backdrop-blur-sm';
        panel.innerHTML = `
            <div class="w-full max-w-md rounded-[28px] border border-emerald-100/80 bg-white/94 p-5 shadow-2xl shadow-emerald-900/12">
                <div class="mb-4">
                    <p class="text-xs font-bold uppercase tracking-[0.2em] text-emerald-500">Local Recovery</p>
                    <h2 class="mt-1 text-xl font-extrabold text-slate-800">本地数据暂时无法解锁</h2>
                    <p class="mt-2 text-sm leading-6 text-slate-500">账号登录已经成功，但当前浏览器里的旧本地缓存无法用当前密码 key 解开。你仍可进入账号，下面的选项只处理本机 IndexedDB 缓存。</p>
                </div>
                <div class="space-y-3">
                    <button type="button" data-recovery-action="show-migrate" class="w-full min-h-[46px] rounded-2xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 text-left text-sm font-bold text-emerald-800">输入旧登录密码，尝试迁移本地数据</button>
                    <div data-recovery-migrate-form class="hidden rounded-2xl border border-emerald-100 bg-white/80 p-3">
                        <input name="old_password" type="password" autocomplete="current-password" placeholder="旧登录密码" class="mb-2 w-full rounded-2xl border border-emerald-100 bg-emerald-50/55 px-4 py-3 text-sm outline-none focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100">
                        <input name="current_password" type="password" autocomplete="current-password" placeholder="当前登录密码" class="mb-2 w-full rounded-2xl border border-emerald-100 bg-emerald-50/55 px-4 py-3 text-sm outline-none focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100">
                        <button type="button" data-recovery-action="migrate" class="w-full min-h-[44px] rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-bold text-white">开始迁移</button>
                    </div>
                    <button type="button" data-recovery-action="clear-cache" class="w-full min-h-[46px] rounded-2xl border border-amber-100 bg-amber-50/80 px-4 py-3 text-left text-sm font-bold text-amber-800">清空当前用户本地 IndexedDB 缓存后进入账号</button>
                    <button type="button" data-recovery-action="restore-backup" class="w-full min-h-[46px] rounded-2xl border border-sky-100 bg-sky-50/80 px-4 py-3 text-left text-sm font-bold text-sky-800">从本地 .lvbackup 或云端密文备份恢复</button>
                    <button type="button" data-recovery-action="later" class="w-full min-h-[44px] rounded-2xl bg-slate-100 px-4 py-3 text-sm font-bold text-slate-500">稍后处理</button>
                    <div data-recovery-hint class="min-h-[20px] text-sm text-slate-500" aria-live="polite"></div>
                </div>
            </div>`;
        document.body.appendChild(panel);
        panel.addEventListener('click', async (event) => {
            const actionEl = event.target.closest('[data-recovery-action]');
            if (!actionEl) return;
            const action = actionEl.dataset.recoveryAction;
            const hint = panel.querySelector('[data-recovery-hint]');
            const migrateForm = panel.querySelector('[data-recovery-migrate-form]');
            if (action === 'show-migrate') {
                migrateForm?.classList.toggle('hidden');
                return;
            }
            if (action === 'later') {
                hideLocalDataRecoveryPanel();
                showCryptoLockedBanner();
                return;
            }
            if (action === 'restore-backup') {
                hideLocalDataRecoveryPanel();
                window.showToast?.('请到“数据与同步管理”中选择导入本地加密备份，或登录后查看云端密文备份。');
                document.querySelector('[data-mobile-section="sync-management"]')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                return;
            }
            if (action === 'clear-cache') {
                await clearCurrentUserLocalCache().catch(() => window.showToast?.('本地缓存清理失败，请稍后再试。', true));
                return;
            }
            if (action === 'migrate') {
                const oldPassword = String(migrateForm?.querySelector('input[name="old_password"]')?.value || '');
                const currentPassword = String(migrateForm?.querySelector('input[name="current_password"]')?.value || '');
                if (!oldPassword || !currentPassword) {
                    if (hint) hint.textContent = '请输入旧登录密码和当前登录密码。';
                    return;
                }
                actionEl.disabled = true;
                const oldText = actionEl.textContent;
                actionEl.textContent = '迁移中...';
                try {
                    const result = await migrateLocalDataWithPasswords(oldPassword, currentPassword);
                    window.showToast?.(`本地数据迁移完成，已处理 ${result.migratedCount} 条记录。`);
                } catch (_) {
                    if (hint) hint.textContent = '旧密码无法解锁本地缓存，或迁移过程中出现错误。';
                } finally {
                    actionEl.disabled = false;
                    actionEl.textContent = oldText;
                    if (migrateForm) {
                        migrateForm.querySelectorAll('input').forEach((input) => { input.value = ''; });
                    }
                }
            }
        });
        return panel;
    }

    function showLocalDataRecoveryPanel(reason = '') {
        const panel = getOrCreateLocalDataRecoveryPanel();
        panel.dataset.reason = reason || 'unknown';
        panel.classList.remove('hidden');
        panel.classList.add('flex');
        setCryptoLocked({ showBanner: false });
    }

    function hideLocalDataRecoveryPanel() {
        const panel = document.getElementById('localDataRecoveryPanel');
        panel?.classList.add('hidden');
        panel?.classList.remove('flex');
    }

    function markLocalDataRecoveryNeeded(detail = {}) {
        if (isDemoMode() || getSessionMode() !== 'user') return;
        setCryptoLocked({ showBanner: false });
        showLocalDataRecoveryPanel(detail?.storeName || 'local_decrypt_failed');
    }

    async function legacyEnsureLocalEncryptionUnlocked() {
        // 最高优先级：内存中已有 key → 当前会话已解锁
        if (window.CryptoEngine?.hasKey?.()) return true;
        if (isDemoMode()) {
            await window.CryptoEngine?.init?.({ force: true }).catch(() => null);
            return Boolean(window.CryptoEngine?.hasKey?.());
        }
        if (!isAuthenticated()) return false;
        // 尝试 7 天 seal 恢复
        const validMeta = getValidCryptoUnlockMeta();
        if (validMeta) {
            await window.CryptoEngine?.restoreTrustedUnlock?.(validMeta).catch(() => false);
            if (window.CryptoEngine?.hasKey?.()) return true;
        }
        // legacy init 回退
        await window.CryptoEngine?.init?.().catch(() => null);
        if (window.CryptoEngine?.hasKey?.()) return true;
        // 所有恢复手段都失败 → 提示用户输入密码
        notifyLocalEncryptionLocked();
        return Boolean(await showLocalEncryptionUnlockPanel());
    }

    window.LeafVaultSession = {
        TOKEN_KEY,
        USER_ID_KEY,
        AUTH_MODE_KEY,
        SESSION_MODE_KEY,
        CRYPTO_UNLOCK_META_KEY,
        CRYPTO_UNLOCK_TTL_MS,
        DEMO_USER_ID,
        DEMO_WORKSPACE_ID,
        getAuthToken,
        setAuthToken,
        setAuthTokenCompat,
        clearAuthSession,
        setSessionMode,
        getSessionMode,
        isDemoMode,
        enterDemoMode,
        exitDemoMode,
        restoreDemoSession,
        clearDemoData,
        getCookie,
        getCsrfToken,
        hasCookieSessionHint,
        setAuthMode,
        getAuthMode,
        shouldStoreTokenInLocalStorage,
        setStoreTokenInLocalStorage,
        refreshSessionStatus,
        isAuthenticated,
        isLocalStorageTokenCompatEnabled,
        isBearerFallbackEnabled,
        getSessionStatusCache,
        migrateLegacyLocalStorageTokenIfNeeded,
        readUserIdFromToken,
        getCurrentUserId,
        setCurrentUserId,
        isCryptoUnlocked,
        getCryptoState,
        setCryptoLocked,
        setCryptoUnlocked,
        lockLocalCryptoSpace,
        clearCryptoUnlockMeta,
        getValidCryptoUnlockMeta,
        showCryptoLockedBanner,
        hideCryptoLockedBanner,
        openUnlockCryptoModal,
        unlockCryptoWithPassword,
        requireCryptoUnlocked,
        ensureCryptoOrPrompt,
        showLocalDataRecoveryPanel,
        hideLocalDataRecoveryPanel,
        markLocalDataRecoveryNeeded,
        migrateLocalDataWithPasswords,
        refreshTrustedUnlockAfterPasswordChange,
        clearCurrentUserLocalCache,
        showLocalEncryptionUnlockPanel,
        ensureLocalEncryptionUnlocked,
    };

    window.readUserIdFromToken = readUserIdFromToken;
    window.getCurrentUserId = getCurrentUserId;
    window.setCurrentUserId = setCurrentUserId;
    window.requireCryptoUnlocked = requireCryptoUnlocked;
    window.ensureCryptoOrPrompt = ensureCryptoOrPrompt;
    window.openUnlockCryptoModal = openUnlockCryptoModal;
    window.showLocalDataRecoveryPanel = showLocalDataRecoveryPanel;
    window.markLocalDataRecoveryNeeded = markLocalDataRecoveryNeeded;
    window.ensureLocalEncryptionUnlocked = ensureLocalEncryptionUnlocked;
}(window));
