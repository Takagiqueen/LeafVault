(function (window) {
    'use strict';

    const LOCAL_ENCRYPTION_LOCKED_MESSAGE = '本地加密空间尚未解锁，请先输入密码解锁。';
    const LOCAL_DATA_UNLOCK_FAILED_MESSAGE = '本地加密数据无法解锁，请确认本地加密密码是否正确。';
    const LOCAL_PASSWORD_KDF_ITERATIONS = 210000;
    const TRUSTED_UNLOCK_SEAL_KEY = 'LeafVault_crypto_unlock_seal_v1';
    const TRUSTED_UNLOCK_SEAL_VERSION = 2;
    const DEVICE_VAULT_STORE = 'device_vault';
    const DEVICE_WRAP_KEY_ID = 'device_wrap_key_v2';

    function readToken() {
        if (window.LeafVaultSession && typeof window.LeafVaultSession.getAuthToken === 'function') {
            return window.LeafVaultSession.getAuthToken();
        }
        return '';
    }

    // ===== 本设备可信解锁密钥 (IndexedDB device_vault) =====
    // deviceWrapKey 存在 IndexedDB 中，不依赖 localStorage token。
    // 退出登录、切换账号、手动锁定、7 天过期时一并清除。

    function getDeviceVaultDBName(userId) {
        const sanitized = String(userId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
        return `LeafVault_DB_${sanitized}`;
    }

    function openDeviceVaultDB(userId) {
        return new Promise((resolve, reject) => {
            const dbName = getDeviceVaultDBName(userId);
            if (!dbName || !window.indexedDB) return reject(new Error('IndexedDB unavailable'));
            const request = window.indexedDB.open(dbName);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(DEVICE_VAULT_STORE)) {
                    db.createObjectStore(DEVICE_VAULT_STORE, { keyPath: 'id' });
                }
            };
        });
    }

    async function readDeviceWrapKey(userId) {
        try {
            const db = await openDeviceVaultDB(userId);
            return new Promise((resolve, reject) => {
                const tx = db.transaction([DEVICE_VAULT_STORE], 'readonly');
                const store = tx.objectStore(DEVICE_VAULT_STORE);
                const req = store.get(DEVICE_WRAP_KEY_ID);
                req.onsuccess = () => {
                    const record = req.result;
                    if (record && Array.isArray(record.key_bytes) && record.key_bytes.length === 32) {
                        resolve(new Uint8Array(record.key_bytes));
                    } else {
                        resolve(null);
                    }
                };
                req.onerror = () => reject(req.error);
            });
        } catch (_) {
            return null;
        }
    }

    async function storeDeviceWrapKey(userId, rawKey) {
        try {
            const db = await openDeviceVaultDB(userId);
            return new Promise((resolve, reject) => {
                const tx = db.transaction([DEVICE_VAULT_STORE], 'readwrite');
                const store = tx.objectStore(DEVICE_VAULT_STORE);
                store.put({ id: DEVICE_WRAP_KEY_ID, key_bytes: Array.from(rawKey) });
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) {
            return false;
        }
    }

    async function deleteDeviceWrapKey(userId) {
        try {
            const db = await openDeviceVaultDB(userId);
            return new Promise((resolve, reject) => {
                const tx = db.transaction([DEVICE_VAULT_STORE], 'readwrite');
                const store = tx.objectStore(DEVICE_VAULT_STORE);
                store.delete(DEVICE_WRAP_KEY_ID);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) {
            return false;
        }
    }

    async function getOrCreateDeviceWrapKey(userId) {
        let existing = await readDeviceWrapKey(userId);
        if (existing) return existing;
        // 生成新 AES-256-GCM 密钥材料
        const rawKey = window.crypto.getRandomValues(new Uint8Array(32));
        const stored = await storeDeviceWrapKey(userId, rawKey);
        if (!stored) return null;
        return rawKey;
    }

    function readDemoSeed() {
        if (window.LeafVaultSession?.isDemoMode?.()) {
            return `${window.LeafVaultSession.DEMO_USER_ID || 'demo-local-user'}_${window.LeafVaultSession.DEMO_WORKSPACE_ID || 'leafvault_demo_v1'}_local_only`;
        }
        return '';
    }

    function getActiveUserId() {
        if (window.LeafVaultSession?.isDemoMode?.()) {
            return window.LeafVaultSession.DEMO_USER_ID || 'demo-local-user';
        }
        if (typeof window.getCurrentUserId === 'function') return window.getCurrentUserId();
        return window.LeafVaultSession?.getCurrentUserId?.() || '';
    }

    function decodeJwtPayload(token) {
        const payloadPart = (token || '').split('.')[1];
        if (!payloadPart) return null;
        const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
        return JSON.parse(window.atob(padded));
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
        }
        return window.btoa(binary);
    }

    function base64ToBytes(value) {
        const binary = window.atob(String(value || ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    async function deriveLegacySeedKey(stableSeed) {
        const enc = new TextEncoder();
        const hash = await window.crypto.subtle.digest('SHA-256', enc.encode(stableSeed));
        return window.crypto.subtle.importKey(
            'raw',
            hash,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function derivePasswordKeyMaterial(password, userId) {
        const enc = new TextEncoder();
        const saltSeed = `LeafVault_local_space_${userId || 'unknown'}_v1`;
        const saltHash = await window.crypto.subtle.digest('SHA-256', enc.encode(saltSeed));
        const baseKey = await window.crypto.subtle.importKey(
            'raw',
            enc.encode(String(password || '')),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const bits = await window.crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: new Uint8Array(saltHash),
                iterations: LOCAL_PASSWORD_KDF_ITERATIONS,
                hash: 'SHA-256',
            },
            baseKey,
            256
        );
        return new Uint8Array(bits);
    }

    function importAesKey(rawKeyBytes) {
        return window.crypto.subtle.importKey(
            'raw',
            rawKeyBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function derivePasswordKey(password, userId) {
        const material = await derivePasswordKeyMaterial(password, userId);
        try {
            return await importAesKey(material);
        } finally {
            material.fill(0);
        }
    }

    function readTrustedUnlockSeal() {
        try {
            const raw = window.localStorage.getItem(TRUSTED_UNLOCK_SEAL_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function clearTrustedUnlockSeal() {
        try {
            window.localStorage.removeItem(TRUSTED_UNLOCK_SEAL_KEY);
        } catch (_) {}
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function dataUrlToBlob(dataUrl) {
        const [meta, base64] = String(dataUrl || '').split(',');
        const mimeMatch = /^data:([^;]+);base64$/i.exec(meta || '');
        const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
        const raw = window.atob(base64 || '');
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        return new Blob([bytes], { type: mimeType });
    }

    async function fileToRecord(file) {
        if (!(file instanceof Blob)) return file;
        return {
            __leafvault_file: true,
            name: file.name || `offline-image-${Date.now()}.jpg`,
            type: file.type || 'application/octet-stream',
            lastModified: file.lastModified || Date.now(),
            data_url: await blobToDataUrl(file),
        };
    }

    function recordToFile(record) {
        if (!record || record instanceof Blob || !record.__leafvault_file || !record.data_url) return record;
        const blob = dataUrlToBlob(record.data_url);
        return new File([blob], record.name || `offline-image-${Date.now()}.jpg`, {
            type: record.type || blob.type,
            lastModified: record.lastModified || Date.now(),
        });
    }

    async function preparePayload(data) {
        const textData = { ...data };
        if (Array.isArray(textData.offline_files)) {
            // 离线图片也进入加密载荷，避免 File 对象绕过本地加密层。
            textData.offline_files = await Promise.all(textData.offline_files.map(fileToRecord));
        }
        return textData;
    }

    function restorePayload(textData, cipher) {
        if (Array.isArray(textData.offline_files)) {
            textData.offline_files = textData.offline_files.map(recordToFile).filter(Boolean);
        } else if (cipher.offline_files) {
            // 兼容旧版本缓存：历史 offline_files 曾经存放在加密载荷外部。
            textData.offline_files = cipher.offline_files;
        }
        return textData;
    }

    function copyCipherMetadata(data, encryptedBuffer, iv) {
        return {
            is_encrypted: true,
            iv: Array.from(iv),
            payload: Array.from(new Uint8Array(encryptedBuffer)),
            date: data.date,
            local_id: data.local_id,
            sync_status: data.sync_status,
            history_id: data.history_id,
            event_type: data.event_type,
            status: data.status,
            change_id: data.change_id,
            entity_type: data.entity_type,
            entity_id: data.entity_id,
            created_at: data.created_at,
            device_id: data.device_id,
            client_sequence: data.client_sequence,
            operation: data.operation,
            remote_device_id: data.remote_device_id,
            applied_at: data.applied_at,
            local_result: data.local_result,
            conflict_id: data.conflict_id,
            conflict_status: data.conflict_status,
            risk_level: data.risk_level,
            merge_status: data.merge_status,
            resolution_choice: data.resolution_choice,
            resolved_at: data.resolved_at,
            resolved_change_id: data.resolved_change_id,
            updated_at: data.updated_at,
        };
    }

    const CryptoEngine = {
        key: null,
        keySource: '',
        fallbackKeys: [],
        LOCAL_ENCRYPTION_LOCKED_MESSAGE,
        LOCAL_DATA_UNLOCK_FAILED_MESSAGE,
        LOCAL_PASSWORD_KDF_ITERATIONS,

        clearKey() {
            this.key = null;
            this.keySource = '';
            this.fallbackKeys = [];
        },

        clearTrustedUnlock() {
            clearTrustedUnlockSeal();
        },

        // 清除本设备可信解锁密钥（退出登录、切换账号、手动锁定时调用）
        async deleteDeviceWrapKeyForUser(userId) {
            const uid = userId || getActiveUserId();
            if (!uid) return false;
            // 同时清除 seal 和 meta 由调用方负责，这里只删 IndexedDB 密钥
            return await deleteDeviceWrapKey(uid);
        },

        hasKey() {
            return Boolean(this.key);
        },

        derivePasswordKey,

        // 使用本设备 IndexedDB 中的 deviceWrapKey 封装密钥材料，不再依赖 localStorage token。
        // deviceWrapKey 在退出登录、切换账号、手动锁定、过期时一起清除。
        async cacheTrustedUnlock(rawKeyMaterial, userId, expiresAt) {
            if (!rawKeyMaterial?.length || !userId || !window.crypto?.subtle) return false;
            const expiry = Number(expiresAt || 0);
            if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
            try {
                const deviceRawKey = await getOrCreateDeviceWrapKey(userId);
                if (!deviceRawKey) return false;
                const wrapKey = await importAesKey(deviceRawKey);
                const iv = window.crypto.getRandomValues(new Uint8Array(12));
                const sealedBuffer = await window.crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv },
                    wrapKey,
                    rawKeyMaterial
                );
                const seal = {
                    version: TRUSTED_UNLOCK_SEAL_VERSION,
                    userId: String(userId),
                    expiresAt: expiry,
                    iv: bytesToBase64(iv),
                    material: bytesToBase64(new Uint8Array(sealedBuffer)),
                };
                window.localStorage.setItem(TRUSTED_UNLOCK_SEAL_KEY, JSON.stringify(seal));
                return true;
            } catch (_) {
                return false;
            }
        },

        async restoreTrustedUnlock(meta = {}) {
            if (!window.crypto?.subtle) return false;
            const seal = readTrustedUnlockSeal();
            const userId = String(meta.userId || getActiveUserId() || '');
            const expiresAt = Number(meta.expiresAt || 0);
            if (
                !seal
                || seal.version !== TRUSTED_UNLOCK_SEAL_VERSION
                || !userId
                || seal.userId !== userId
                || !Number.isFinite(expiresAt)
                || expiresAt <= Date.now()
                || Number(seal.expiresAt || 0) <= Date.now()
            ) {
                clearTrustedUnlockSeal();
                return false;
            }
            // 从 IndexedDB 读取本设备 deviceWrapKey，不再依赖 localStorage token
            const deviceRawKey = await readDeviceWrapKey(userId);
            if (!deviceRawKey) {
                clearTrustedUnlockSeal();
                return false;
            }
            try {
                const wrapKey = await importAesKey(deviceRawKey);
                const rawBuffer = await window.crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: base64ToBytes(seal.iv) },
                    wrapKey,
                    base64ToBytes(seal.material)
                );
                const material = new Uint8Array(rawBuffer);
                try {
                    this.key = await importAesKey(material);
                    this.keySource = 'trusted-unlock';
                    this.fallbackKeys = [];
                    return true;
                } finally {
                    material.fill(0);
                }
            } catch (_) {
                clearTrustedUnlockSeal();
                return false;
            }
        },

        // 返回 { keySet: true, sealCached: boolean }
        // sealCached=true 表示 7 天可信 seal 已通过 deviceWrapKey 成功保存。
        // 即使 sealCached=false（IndexedDB 不可用），当前页面会话也已解锁。
        async unlockWithPassword(password, userId = getActiveUserId(), legacyToken = '', options = {}) {
            if (!password || !window.crypto || !window.crypto.subtle) {
                throw new Error(LOCAL_ENCRYPTION_LOCKED_MESSAGE);
            }
            const targetUserId = userId || getActiveUserId();
            if (!targetUserId) throw new Error(LOCAL_ENCRYPTION_LOCKED_MESSAGE);
            const material = await derivePasswordKeyMaterial(password, targetUserId);
            let sealCached = false;
            try {
                this.key = await importAesKey(material);
                this.keySource = 'password';
                this.fallbackKeys = [];

                // 迁移兼容：旧版本曾使用 user_id/token 派生本地 key。
                const token = legacyToken || readToken();
                if (token) {
                    try {
                        const payload = decodeJwtPayload(token);
                        const legacySeed = `${payload?.sub || targetUserId}_LeafVault_secure_v1`;
                        this.fallbackKeys.push(await deriveLegacySeedKey(legacySeed));
                    } catch (_) {}
                }

                // 始终尝试用 deviceWrapKey 缓存 7 天可信 seal，不再依赖 localStorage token 是否存在。
                if (options.trustedUntil) {
                    sealCached = await this.cacheTrustedUnlock(material, targetUserId, options.trustedUntil).catch(() => false);
                }
            } finally {
                material.fill(0);
            }
            return { keySet: true, sealCached };
        },

        async init(options = {}) {
            if (this.key && !options.force) return true;
            const demoSeed = readDemoSeed();
            const token = readToken();
            if ((!token && !demoSeed) || !window.crypto || !window.crypto.subtle) return false;

            let stableSeed = demoSeed || token;
            try {
                const payload = demoSeed ? null : decodeJwtPayload(token);
                if (payload && payload.sub) {
                    if (typeof window.setCurrentUserId === 'function') {
                        window.setCurrentUserId(payload.sub);
                    }
                    stableSeed = `${payload.sub}_LeafVault_secure_v1`;
                }
            } catch (_) {
                // 不输出 token 内容，只降级为旧 token seed。
            }

            this.key = await deriveLegacySeedKey(stableSeed);
            this.keySource = demoSeed ? 'demo' : 'legacy-token';
            this.fallbackKeys = [];
            return true;
        },

        async encrypt(data) {
            if (!this.key) await this.init();
            if (!this.key) throw new Error(LOCAL_ENCRYPTION_LOCKED_MESSAGE);
            return this.encryptWithKey(data, this.key);
        },

        async encryptWithKey(data, key) {
            if (!key) throw new Error(LOCAL_ENCRYPTION_LOCKED_MESSAGE);
            const textData = await preparePayload(data);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const encryptedBuffer = await window.crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                new TextEncoder().encode(JSON.stringify(textData))
            );
            return copyCipherMetadata(data, encryptedBuffer, iv);
        },

        async decrypt(cipher) {
            if (!cipher || !cipher.is_encrypted) return cipher;
            if (!this.key) await this.init();
            if (!this.key) throw new Error(LOCAL_ENCRYPTION_LOCKED_MESSAGE);

            const keys = [this.key, ...(this.fallbackKeys || [])].filter(Boolean);
            for (const candidateKey of keys) {
                try {
                    return await this.decryptWithKey(cipher, candidateKey);
                } catch (_) {}
            }
            throw new Error(LOCAL_DATA_UNLOCK_FAILED_MESSAGE);
        },

        async decryptWithKey(cipher, key) {
            if (!cipher || !cipher.is_encrypted) return cipher;
            if (!key) throw new Error(LOCAL_ENCRYPTION_LOCKED_MESSAGE);
            const decryptedBuffer = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(cipher.iv) },
                key,
                new Uint8Array(cipher.payload)
            );
            const textData = JSON.parse(new TextDecoder().decode(decryptedBuffer));
            return restorePayload(textData, cipher);
        },

        async encryptSyncPayload(plainPayload) {
            if (!this.key) await this.init();
            if (!this.key) throw new Error(LOCAL_ENCRYPTION_LOCKED_MESSAGE);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const payloadBytes = new TextEncoder().encode(JSON.stringify(plainPayload));
            const encryptedBuffer = await window.crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                this.key,
                payloadBytes
            );
            return {
                app: 'LeafVault',
                type: 'incremental_change',
                version: 2,
                kdf: 'local-encryption-key-v1',
                iv: bytesToBase64(iv),
                payload: bytesToBase64(new Uint8Array(encryptedBuffer)),
            };
        },

        async decryptSyncPayload(encryptedChange) {
            if (!encryptedChange || Number(encryptedChange.version) !== 2) {
                throw new Error('Unsupported sync payload version');
            }
            if (encryptedChange.app !== 'LeafVault' || encryptedChange.type !== 'incremental_change') {
                throw new Error('Invalid sync payload');
            }
            if (encryptedChange.kdf !== 'local-encryption-key-v1') {
                throw new Error('Unsupported sync payload key type');
            }
            if (!this.key) await this.init();
            if (!this.key) throw new Error(LOCAL_ENCRYPTION_LOCKED_MESSAGE);
            const decryptedBuffer = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: base64ToBytes(encryptedChange.iv) },
                this.key,
                base64ToBytes(encryptedChange.payload)
            );
            return JSON.parse(new TextDecoder().decode(decryptedBuffer));
        },

        async canDecryptWithCurrentKey(cipher) {
            if (!cipher || !cipher.is_encrypted) return true;
            try {
                await this.decrypt(cipher);
                return true;
            } catch (_) {
                return false;
            }
        },
    };

    window.CryptoEngine = CryptoEngine;
})(window);
