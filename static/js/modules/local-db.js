(function (window) {
    'use strict';

    const DB_BASE_NAME = 'LeafVault_DB';
    const DB_VERSION = 7;
    const DEMO_WORKSPACE_ID = 'leafvault_demo_v1';
    let localDB = null;
    let localDBName = '';
    let dbInitPromise = null;

    function getActiveUserId() {
        if (window.LeafVaultSession?.isDemoMode?.()) {
            return window.LeafVaultSession.DEMO_USER_ID || 'demo-local-user';
        }
        if (typeof window.getCurrentUserId === 'function') {
            return window.getCurrentUserId();
        }
        if (window.LeafVaultSession && typeof window.LeafVaultSession.getCurrentUserId === 'function') {
            return window.LeafVaultSession.getCurrentUserId();
        }
        return '';
    }

    function sanitizeStorageSegment(value) {
        return String(value || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function getLocalDBName() {
        if (window.LeafVaultSession?.isDemoMode?.()) {
            return `${DB_BASE_NAME}_${DEMO_WORKSPACE_ID}`;
        }
        return `${DB_BASE_NAME}_${sanitizeStorageSegment(getActiveUserId())}`;
    }

    function getDemoLocalDBName() {
        return `${DB_BASE_NAME}_${DEMO_WORKSPACE_ID}`;
    }

    function getDiaryDraftKey(dateValue) {
        return `diary_draft_${sanitizeStorageSegment(getActiveUserId())}_${dateValue}`;
    }

    function getDiaryDraftPointerKey() {
        return `diary_draft_last_${sanitizeStorageSegment(getActiveUserId())}`;
    }

    const EMERGENCY_DRAFT_PREFIX = 'leafvault_draft_snapshot:';

    function rememberLatestDiaryDraft(dateValue, updatedAt = new Date().toISOString()) {
        if (!dateValue) return;
        window.localStorage.setItem(getDiaryDraftPointerKey(), JSON.stringify({
            date: dateValue,
            updated_at: updatedAt
        }));
    }

    function clearLatestDiaryDraft(dateValue) {
        const pointerKey = getDiaryDraftPointerKey();
        const raw = window.localStorage.getItem(pointerKey);
        if (!raw) return;
        try {
            const pointer = JSON.parse(raw);
            if (!dateValue || pointer?.date === dateValue) window.localStorage.removeItem(pointerKey);
        } catch (_) {
            window.localStorage.removeItem(pointerKey);
        }
    }

    function getLatestDiaryDraftDate() {
        try {
            const pointer = JSON.parse(window.localStorage.getItem(getDiaryDraftPointerKey()) || '{}');
            return /^\d{4}-\d{2}-\d{2}$/.test(pointer.date || '') ? pointer.date : '';
        } catch (_) {
            return '';
        }
    }

    function resetLocalDBConnection() {
        if (localDB) localDB.close();
        localDB = null;
        dbInitPromise = null;
        localDBName = '';
        try {
            if (window.CryptoEngine) window.CryptoEngine.clearKey?.();
        } catch (_) {}
    }

    async function requireLocalEncryptionUnlocked(options = {}) {
        const unlockFn = window.requireCryptoUnlocked || window.ensureLocalEncryptionUnlocked;
        if (typeof unlockFn === 'function') {
            const unlocked = await unlockFn(options);
            if (!unlocked) {
                throw new Error(window.CryptoEngine?.LOCAL_ENCRYPTION_LOCKED_MESSAGE || '本地加密空间尚未解锁，请先输入密码解锁。');
            }
        }
    }

    function reportLocalDecryptFailure(storeName, recordKey) {
        try {
            window.LeafVaultSession?.markLocalDataRecoveryNeeded?.({ storeName, recordKey });
        } catch (_) {}
    }

    function initLocalDB() {
        const userId = getActiveUserId();
        if (!userId) {
            return Promise.reject(new Error('Local database requires an authenticated user.'));
        }
        const targetDBName = getLocalDBName();
        if (localDB && localDBName === targetDBName) return Promise.resolve(localDB);
        if (dbInitPromise && localDBName === targetDBName) return dbInitPromise;
        if (localDB && localDBName !== targetDBName) resetLocalDBConnection();
        localDBName = targetDBName;

        dbInitPromise = new Promise((resolve, reject) => {
            const request = window.indexedDB.open(targetDBName, DB_VERSION);

            request.onerror = (event) => {
                console.error('本地数据库加载失败', event);
                dbInitPromise = null;
                reject(event);
            };

            request.onsuccess = (event) => {
                localDB = event.target.result;
                console.log('本地数据库连接成功');
                resolve(localDB);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('diaries')) {
                    const diaryStore = db.createObjectStore('diaries', { keyPath: 'date' });
                    diaryStore.createIndex('sync_status', 'sync_status', { unique: false });
                }
                if (!db.objectStoreNames.contains('ledgers')) {
                    const ledgerStore = db.createObjectStore('ledgers', { keyPath: 'local_id' });
                    ledgerStore.createIndex('sync_status', 'sync_status', { unique: false });
                    ledgerStore.createIndex('created_at', 'created_at', { unique: false });
                }
                if (!db.objectStoreNames.contains('diary_drafts')) {
                    db.createObjectStore('diary_drafts', { keyPath: 'date' });
                }
                if (!db.objectStoreNames.contains('local_changes')) {
                    const changeStore = db.createObjectStore('local_changes', { keyPath: 'change_id' });
                    changeStore.createIndex('sync_status', 'sync_status', { unique: false });
                    changeStore.createIndex('entity_type', 'entity_type', { unique: false });
                    changeStore.createIndex('entity_id', 'entity_id', { unique: false });
                    changeStore.createIndex('created_at', 'created_at', { unique: false });
                    changeStore.createIndex('device_id', 'device_id', { unique: false });
                }
                if (!db.objectStoreNames.contains('applied_remote_changes')) {
                    const appliedStore = db.createObjectStore('applied_remote_changes', { keyPath: 'change_id' });
                    appliedStore.createIndex('entity_type', 'entity_type', { unique: false });
                    appliedStore.createIndex('entity_id', 'entity_id', { unique: false });
                    appliedStore.createIndex('applied_at', 'applied_at', { unique: false });
                    appliedStore.createIndex('local_result', 'local_result', { unique: false });
                }
                if (!db.objectStoreNames.contains('sync_conflicts')) {
                    const conflictStore = db.createObjectStore('sync_conflicts', { keyPath: 'conflict_id' });
                    conflictStore.createIndex('change_id', 'change_id', { unique: false });
                    conflictStore.createIndex('entity_type', 'entity_type', { unique: false });
                    conflictStore.createIndex('entity_id', 'entity_id', { unique: false });
                    conflictStore.createIndex('conflict_status', 'conflict_status', { unique: false });
                    conflictStore.createIndex('created_at', 'created_at', { unique: false });
                }
                if (!db.objectStoreNames.contains('sync_history')) {
                    const historyStore = db.createObjectStore('sync_history', { keyPath: 'history_id' });
                    historyStore.createIndex('event_type', 'event_type', { unique: false });
                    historyStore.createIndex('entity_type', 'entity_type', { unique: false });
                    historyStore.createIndex('entity_id', 'entity_id', { unique: false });
                    historyStore.createIndex('status', 'status', { unique: false });
                    historyStore.createIndex('created_at', 'created_at', { unique: false });
                }
                if (!db.objectStoreNames.contains('device_vault')) {
                    db.createObjectStore('device_vault', { keyPath: 'id' });
                }
                console.log('本地数据库表结构构建完成');
            };
        });

        return dbInitPromise;
    }

    const LocalStorage = {
        async set(storeName, data) {
            if (!localDB) await initLocalDB();
            await requireLocalEncryptionUnlocked({ prompt: true, actionName: '保存本地加密数据', consume: false });
            if (!window.CryptoEngine || typeof window.CryptoEngine.encrypt !== 'function') {
                throw new Error('Local encryption module is unavailable.');
            }

            const secureData = await window.CryptoEngine.encrypt(data);

            return new Promise((resolve, reject) => {
                const transaction = localDB.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.put(secureData);
                request.onsuccess = () => resolve(data);
                request.onerror = () => reject(new Error('写入失败'));
            });
        },

        async get(storeName, key) {
            if (!localDB) await initLocalDB();
            await requireLocalEncryptionUnlocked({ prompt: false, notify: false });
            return new Promise((resolve, reject) => {
                const transaction = localDB.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.get(key);

                request.onsuccess = async () => {
                    if (!request.result) return resolve(null);

                    try {
                        const result = await window.CryptoEngine.decrypt(request.result);
                        resolve(result);
                    } catch (error) {
                        reportLocalDecryptFailure(storeName, key);
                        console.warn(`已隔离无法解密的本地缓存: ${storeName}/${key}`);
                        resolve(null);
                    }
                };
                request.onerror = () => reject(new Error('读取失败'));
            });
        },

        async getAll(storeName) {
            if (!localDB) await initLocalDB();
            await requireLocalEncryptionUnlocked({ prompt: false, notify: false });
            return new Promise((resolve, reject) => {
                const transaction = localDB.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.getAll();

                request.onsuccess = async () => {
                    const results = request.result || [];
                    const decryptedResults = [];

                    for (const result of results) {
                        try {
                            decryptedResults.push(await window.CryptoEngine.decrypt(result));
                        } catch (error) {
                            reportLocalDecryptFailure(storeName, result?.date || result?.local_id || result?.change_id || result?.history_id || '');
                            console.warn(`发现无法解密的历史缓存，已隔离跳过: ${storeName}`);
                        }
                    }
                    resolve(decryptedResults);
                };
                request.onerror = () => reject(new Error('获取全部失败'));
            });
        },

        async delete(storeName, key) {
            if (!localDB) await initLocalDB();
            await requireLocalEncryptionUnlocked({ prompt: true, actionName: '删除本地加密数据', consume: false });
            return new Promise((resolve, reject) => {
                const transaction = localDB.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.delete(key);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(new Error('删除失败'));
            });
        },

        async getAllByIndex(storeName, indexName, queryValue) {
            if (!localDB) await initLocalDB();
            await requireLocalEncryptionUnlocked({ prompt: false, notify: false });
            return new Promise((resolve, reject) => {
                const transaction = localDB.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const index = store.index(indexName);
                const request = index.getAll(queryValue);

                request.onsuccess = async () => {
                    const results = request.result || [];
                    const decryptedResults = [];
                    for (const result of results) {
                        try {
                            decryptedResults.push(await window.CryptoEngine.decrypt(result));
                        } catch (error) {
                            reportLocalDecryptFailure(storeName, `${indexName}:${queryValue || ''}`);
                            console.warn(`已隔离无法解密的本地变更记录: ${storeName}/${indexName}`);
                        }
                    }
                    resolve(decryptedResults);
                };
                request.onerror = () => reject(new Error('索引读取失败'));
            });
        }
    };

    function normalizeDiaryDraftSnapshot(dateValue, draft) {
        if (!draft) return null;
        if (typeof draft === 'string') {
            if (draft.startsWith(EMERGENCY_DRAFT_PREFIX)) {
                try {
                    const parsed = JSON.parse(draft.slice(EMERGENCY_DRAFT_PREFIX.length));
                    return normalizeDiaryDraftSnapshot(dateValue, parsed);
                } catch (_) {
                    return null;
                }
            }
            return {
                date: dateValue,
                content: draft,
                mood_label: '',
                mode: 'create',
                server_updated_at: '',
                retained_images: '',
                updated_at: ''
            };
        }
        if (typeof draft.content !== 'string') return null;
        return {
            date: draft.date || dateValue,
            content: draft.content,
            mood_label: draft.mood_label || '',
            mode: draft.mode === 'update' ? 'update' : 'create',
            server_updated_at: draft.server_updated_at || '',
            retained_images: draft.retained_images || '',
            updated_at: draft.updated_at || ''
        };
    }

    function pickNewerDraft(emergencyDraft, encryptedDraft) {
        if (!emergencyDraft) return encryptedDraft || null;
        if (!encryptedDraft) return emergencyDraft;

        const emergencyTime = Date.parse(emergencyDraft.updated_at || '');
        const encryptedTime = Date.parse(encryptedDraft.updated_at || '');
        if (Number.isNaN(emergencyTime) || Number.isNaN(encryptedTime)) {
            return emergencyDraft;
        }
        return emergencyTime >= encryptedTime ? emergencyDraft : encryptedDraft;
    }

    function setDiaryDraftEmergency(dateValue, content, metadata = {}) {
        const text = String(content || '');
        const key = getDiaryDraftKey(dateValue);
        if (!dateValue || !text.trim()) {
            return;
        }
        const updatedAt = metadata.updated_at || new Date().toISOString();
        const emergencySnapshot = {
            date: dateValue,
            content: text,
            mood_label: metadata.mood_label || '',
            mode: metadata.mode === 'update' ? 'update' : 'create',
            server_updated_at: metadata.server_updated_at || '',
            retained_images: Array.isArray(metadata.retained_images)
                ? JSON.stringify(metadata.retained_images.filter(Boolean))
                : (metadata.retained_images || ''),
            updated_at: updatedAt
        };
        // Mobile browsers can kill async IndexedDB writes; keep one synchronous recovery copy first.
        window.localStorage.setItem(key, EMERGENCY_DRAFT_PREFIX + JSON.stringify(emergencySnapshot));
        rememberLatestDiaryDraft(dateValue, updatedAt);
    }

    async function getDiaryDraftSnapshot(dateValue) {
        const emergencyKey = getDiaryDraftKey(dateValue);
        const emergencyDraft = normalizeDiaryDraftSnapshot(
            dateValue,
            window.localStorage.getItem(emergencyKey)
        );

        let encryptedDraft = null;
        try {
            const draft = await LocalStorage.get('diary_drafts', dateValue);
            encryptedDraft = normalizeDiaryDraftSnapshot(dateValue, draft);
        } catch (error) {
            console.warn('加密草稿读取失败，使用 localStorage 紧急草稿兜底:', error);
            return emergencyDraft;
        }

        return pickNewerDraft(emergencyDraft, encryptedDraft);
    }

    async function getDiaryDraft(dateValue) {
        const snapshot = await getDiaryDraftSnapshot(dateValue);
        return snapshot?.content || '';
    }

    async function setDiaryDraft(dateValue, content, metadata = {}) {
        const text = String(content || '');
        if (!text.trim()) {
            await deleteDiaryDraft(dateValue);
            return;
        }
        const updatedAt = new Date().toISOString();
        setDiaryDraftEmergency(dateValue, text, { ...metadata, updated_at: updatedAt });
        try {
            await LocalStorage.set('diary_drafts', {
                date: dateValue,
                content: text,
                mood_label: metadata.mood_label || '',
                mode: metadata.mode === 'update' ? 'update' : 'create',
                server_updated_at: metadata.server_updated_at || '',
                retained_images: Array.isArray(metadata.retained_images)
                    ? JSON.stringify(metadata.retained_images.filter(Boolean))
                    : (metadata.retained_images || ''),
                updated_at: updatedAt
            });
        } catch (error) {
            console.warn('加密草稿写入失败，已保留 localStorage 紧急草稿:', error);
        }
        rememberLatestDiaryDraft(dateValue);
    }

    async function deleteDiaryDraft(dateValue) {
        try {
            await LocalStorage.delete('diary_drafts', dateValue);
        } catch (error) {
            console.warn('加密草稿清理失败:', error);
        }
        window.localStorage.removeItem(getDiaryDraftKey(dateValue));
        clearLatestDiaryDraft(dateValue);
    }

    window.DB_BASE_NAME = DB_BASE_NAME;
    window.DB_VERSION = DB_VERSION;
    window.getLocalDBName = getLocalDBName;
    window.getDemoLocalDBName = getDemoLocalDBName;
    window.getDiaryDraftKey = getDiaryDraftKey;
    window.getLatestDiaryDraftDate = getLatestDiaryDraftDate;
    window.getDiaryDraftSnapshot = getDiaryDraftSnapshot;
    window.getDiaryDraft = getDiaryDraft;
    window.pickNewerDraft = pickNewerDraft;
    window.setDiaryDraft = setDiaryDraft;
    window.setDiaryDraftEmergency = setDiaryDraftEmergency;
    window.deleteDiaryDraft = deleteDiaryDraft;
    window.resetLocalDBConnection = resetLocalDBConnection;
    window.initLocalDB = initLocalDB;
    window.LocalStorage = LocalStorage;

    if (window.LeafVaultSession && (window.LeafVaultSession.isAuthenticated?.() || window.LeafVaultSession.getAuthToken() || window.LeafVaultSession.hasCookieSessionHint?.())) {
        initLocalDB().catch((error) => console.warn('本地数据库预热失败', error));
    }
})(window);
