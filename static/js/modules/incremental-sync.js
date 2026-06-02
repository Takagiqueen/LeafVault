(function (window) {
  'use strict';

  const DEVICE_ID_PREFIX = 'LeafVault_device_id_';
  const CLIENT_SEQUENCE_PREFIX = 'LeafVault_client_sequence_';
  const SYNC_ITERATIONS = 310000;
  const VALID_ENTITY_TYPES = new Set(['diary', 'ledger']);
  const VALID_OPERATIONS = new Set(['create', 'update', 'delete']);
  const CONFLICT_COPY_STATUSES = new Set(['conflict', 'delete_conflict', 'stale_remote', 'unknown']);
  const MAX_UPLOAD_BATCH_SIZE = 100;
  const REMOTE_CHECK_PREFIX = 'LeafVault_incremental_last_remote_check_at_';
  const SYNC_HISTORY_LIMIT = 50;
  const SYNC_HISTORY_MAX_LIMIT = 200;
  const CLEANUP_KEEP_RECENT = 100;
  const CLEANUP_KEEP_DAYS = 30;
  const MANUAL_SYNC_REMOTE_LIMIT = 30;
  const AUTO_CHECK_PREFIX = 'LeafVault_incremental_last_auto_check_at_';
  const AUTO_CHECK_SNOOZE_PREFIX = 'LeafVault_incremental_auto_check_snoozed_until_';
  const REMOTE_PENDING_COUNT_PREFIX = 'LeafVault_incremental_remote_pending_count_';
  const ATTENTION_DISMISS_PREFIX = 'LeafVault_incremental_attention_dismissed_on_';
  const AUTO_CHECK_INTERVALS = {
    startup: 6 * 60 * 60 * 1000,
    online: 30 * 60 * 1000,
    visibility: 2 * 60 * 60 * 1000,
    default: 6 * 60 * 60 * 1000,
  };
  let remoteChangeMetadataCache = [];
  let manualSyncInProgress = false;
  let quietRemoteCheckInProgress = false;
  let refreshIncrementalStatusInFlight = null;
  let lastIncrementalStatusRefreshAt = 0;
  let scheduledIncrementalStatusRefresh = null;
  let lastIncrementalStatusResult = null;
  const INCREMENTAL_STATUS_THROTTLE_MS = 1000;
  let syncAttentionStateCache = {
    pending_local_changes: 0,
    remote_pending_count: 0,
    open_conflicts: 0,
  };

  function notify(message, isError = false) {
    if (typeof window.LeafVaultUIState?.showToast === 'function') {
      window.LeafVaultUIState.showToast(message, isError ? 'error' : 'success');
      return;
    }
    if (typeof window.showToast === 'function') {
      window.showToast(message, isError);
      return;
    }
  }

  function isDemoMode() {
    return Boolean(window.LeafVaultSession?.isDemoMode?.());
  }

  function notifyDemoLocalOnly() {
    notify('Demo 模式仅支持本地体验。云端备份、多设备同步和账号设置需要正式账号。', true);
  }

  function getCurrentUserId() {
    const userId = typeof window.getCurrentUserId === 'function' ? window.getCurrentUserId() : '';
    return String(userId || 'guest').trim() || 'guest';
  }

  function getUuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `lv_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function getDeviceId() {
    const key = `${DEVICE_ID_PREFIX}${getCurrentUserId()}`;
    let deviceId = '';
    try {
      deviceId = window.localStorage.getItem(key) || '';
      if (!deviceId) {
        deviceId = getUuid();
        window.localStorage.setItem(key, deviceId);
      }
    } catch (_) {
      deviceId = getUuid();
    }
    return deviceId;
  }

  function getSequenceKey(deviceId = getDeviceId()) {
    return `${CLIENT_SEQUENCE_PREFIX}${getCurrentUserId()}_${deviceId}`;
  }

  function getNextClientSequence() {
    const key = getSequenceKey();
    let nextValue = 1;
    try {
      const current = Number(window.localStorage.getItem(key) || '0');
      nextValue = Number.isFinite(current) ? current + 1 : 1;
      window.localStorage.setItem(key, String(nextValue));
    } catch (_) {
      nextValue = Date.now();
    }
    return nextValue;
  }

  function buildChangeId() {
    return getUuid();
  }

  function getLastRemoteChangeCheckKey() {
    return `${REMOTE_CHECK_PREFIX}${getCurrentUserId()}`;
  }

  function getScopedLocalStorageKey(prefix) {
    return `${prefix}${getCurrentUserId()}`;
  }

  function readLocalStorageValue(key) {
    try {
      return window.localStorage.getItem(key) || '';
    } catch (_) {
      return '';
    }
  }

  function writeLocalStorageValue(key, value) {
    try {
      window.localStorage.setItem(key, String(value ?? ''));
    } catch (_) {}
  }

  function getTodayKey() {
    const date = new Date();
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseStoredTime(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
  }

  function getLastAutoCheckAt() {
    return readLocalStorageValue(getScopedLocalStorageKey(AUTO_CHECK_PREFIX));
  }

  function setLastAutoCheckAt(time) {
    const value = String(time || new Date().toISOString());
    writeLocalStorageValue(getScopedLocalStorageKey(AUTO_CHECK_PREFIX), value);
    return value;
  }

  function getAutoCheckSnoozedUntil() {
    return readLocalStorageValue(getScopedLocalStorageKey(AUTO_CHECK_SNOOZE_PREFIX));
  }

  function setRemotePendingCountToLocalCache(count) {
    const safeCount = Math.max(0, Number(count || 0));
    writeLocalStorageValue(getScopedLocalStorageKey(REMOTE_PENDING_COUNT_PREFIX), String(safeCount));
    return safeCount;
  }

  function getRemotePendingCountFromLocalCache() {
    const count = Number(readLocalStorageValue(getScopedLocalStorageKey(REMOTE_PENDING_COUNT_PREFIX)) || '0');
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function isSyncAttentionDismissedToday() {
    return readLocalStorageValue(getScopedLocalStorageKey(ATTENTION_DISMISS_PREFIX)) === getTodayKey();
  }

  function isLoggedInForIncrementalSync() {
    if (getCurrentUserId() === 'guest') return false;
    if (typeof window.LeafVaultSession?.getAuthToken === 'function') {
      return Boolean(window.LeafVaultSession.isAuthenticated?.() || window.LeafVaultSession.getAuthToken() || window.LeafVaultSession.hasCookieSessionHint?.());
    }
    return Boolean(window.localStorage?.getItem?.('token') || window.localStorage?.getItem?.('auth_token'));
  }

  function getLastRemoteChangeCheckAt() {
    try {
      return window.localStorage.getItem(getLastRemoteChangeCheckKey()) || '';
    } catch (_) {
      return '';
    }
  }

  function setLastRemoteChangeCheckAt(time) {
    const value = String(time || new Date().toISOString());
    try {
      window.localStorage.setItem(getLastRemoteChangeCheckKey(), value);
    } catch (_) {}
    return value;
  }

  function normalizeRevision(value) {
    const revision = Number(value);
    return Number.isFinite(revision) && revision >= 0 ? revision : 0;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeSelectorValue(value) {
    const text = String(value ?? '');
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
    return text.replace(/["\\]/g, '\\$&');
  }

  function formatSyncTime(value) {
    if (!value) return '暂无';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function getEntityLabel(type) {
    return type === 'diary' ? '日记' : '账本';
  }

  function getOperationLabel(operation) {
    if (operation === 'create') return '新增';
    if (operation === 'update') return '修改';
    if (operation === 'delete') return '删除';
    return operation || '未知';
  }

  function assertChangeShape(change) {
    if (!change || typeof change !== 'object') throw new Error('Invalid local change');
    if (!VALID_ENTITY_TYPES.has(change.entity_type)) throw new Error('Invalid entity_type');
    if (!String(change.entity_id || '').trim()) throw new Error('Invalid entity_id');
    if (!VALID_OPERATIONS.has(change.operation)) throw new Error('Invalid operation');
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function deriveSyncKey(password, salt, usages = ['encrypt'], iterations = SYNC_ITERATIONS) {
    if (!window.crypto?.subtle) {
      throw new Error('当前浏览器不支持安全加密，无法上传增量变更');
    }
    const passwordBytes = new TextEncoder().encode(password);
    const baseKey = await window.crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    return window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: Number(iterations || SYNC_ITERATIONS), hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  function normalizeRecordForSync(record) {
    if (!record || typeof record !== 'object') return null;
    const safeRecord = { ...record };
    delete safeRecord.offline_files;
    return safeRecord;
  }

  async function findLocalRecord(localChange) {
    if (!window.LocalStorage || typeof window.LocalStorage.get !== 'function') {
      throw new Error('本地数据库模块尚未加载');
    }
    const entityId = String(localChange.entity_id || '').trim();
    const storeName = localChange.entity_type === 'diary' ? 'diaries' : 'ledgers';
    const directRecord = await window.LocalStorage.get(storeName, entityId).catch(() => null);
    if (directRecord || localChange.entity_type !== 'ledger') return directRecord;

    const allLedgers = await window.LocalStorage.getAll('ledgers').catch(() => []);
    return (allLedgers || []).find(item => (
      String(item?.uuid || '') === entityId
      || String(item?.local_id || '') === entityId
      || String(item?.id || '') === entityId
    )) || null;
  }

  async function createLocalChange(change) {
    if (isDemoMode()) return null;
    assertChangeShape(change);
    if (!window.LocalStorage || typeof window.LocalStorage.set !== 'function') {
      throw new Error('Local database module is unavailable.');
    }

    const deviceId = getDeviceId();
    const now = new Date().toISOString();
    const localChange = {
      change_id: change.change_id || buildChangeId(),
      entity_type: change.entity_type,
      entity_id: String(change.entity_id).trim(),
      operation: change.operation,
      // Phase 2 上传前会在内存中构建并加密 payload；这里仍不保存任何明文。
      encrypted_payload: change.encrypted_payload || null,
      base_revision: normalizeRevision(change.base_revision),
      local_revision: normalizeRevision(change.local_revision),
      device_id: deviceId,
      client_sequence: getNextClientSequence(),
      created_at: change.created_at || now,
      sync_status: 'pending',
      retry_count: 0,
      last_error: '',
    };
    await window.LocalStorage.set('local_changes', localChange);
    await recordSyncHistory({
      event_type: 'local_change_created',
      entity_type: localChange.entity_type,
      entity_id: localChange.entity_id,
      change_id: localChange.change_id,
      status: 'info',
      message: `${getEntityLabel(localChange.entity_type)}${getOperationLabel(localChange.operation)}已记录为待同步变更`,
      metadata: { operation: localChange.operation },
    });
    if (typeof window.updateBackupStatusPanel === 'function') {
      window.updateBackupStatusPanel();
    }
    return localChange;
  }

  async function listPendingLocalChanges() {
    if (!window.LocalStorage || typeof window.LocalStorage.getAll !== 'function') return [];
    const allChanges = await window.LocalStorage.getAll('local_changes').catch(() => []);
    return (allChanges || [])
      .filter(change => change?.sync_status === 'pending' || change?.sync_status === 'failed')
      .sort((a, b) => {
        const aTime = Date.parse(a.created_at || '');
        const bTime = Date.parse(b.created_at || '');
        if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return aTime - bTime;
        return Number(a.client_sequence || 0) - Number(b.client_sequence || 0);
      });
  }

  async function getPendingChangeCount() {
    const changes = await listPendingLocalChanges();
    return changes.length;
  }

  async function getAllFromStore(storeName) {
    if (!window.LocalStorage || typeof window.LocalStorage.getAll !== 'function') return [];
    return window.LocalStorage.getAll(storeName).catch(() => []);
  }

  function sanitizeHistoryMetadata(metadata = {}) {
    if (!metadata || typeof metadata !== 'object') return {};
    const forbidden = new Set([
      'record',
      'payload',
      'encrypted_change',
      'decryptedPayload',
      'plainPayload',
      'local_snapshot',
      'remote_snapshot',
      'merged_record',
      'password',
      'key',
      'token',
      'content',
      'note',
    ]);
    const safe = {};
    Object.entries(metadata).forEach(([key, value]) => {
      if (forbidden.has(key)) return;
      if (value === undefined || value === null) return;
      if (typeof value === 'object') return;
      safe[key] = String(value).slice(0, 120);
    });
    return safe;
  }

  async function recordSyncHistory(event = {}) {
    try {
      if (!window.LocalStorage || typeof window.LocalStorage.set !== 'function') return null;
      const now = new Date().toISOString();
      const record = {
        history_id: event.history_id || getUuid(),
        event_type: String(event.event_type || 'sync_info').slice(0, 48),
        entity_type: String(event.entity_type || 'sync').slice(0, 24),
        entity_id: String(event.entity_id || '').slice(0, 80),
        change_id: String(event.change_id || '').slice(0, 80),
        conflict_id: String(event.conflict_id || '').slice(0, 80),
        status: String(event.status || 'info').slice(0, 24),
        message: String(event.message || '').slice(0, 180),
        created_at: event.created_at || now,
        metadata: sanitizeHistoryMetadata(event.metadata),
      };
      await window.LocalStorage.set('sync_history', record);
      return record;
    } catch (_) {
      return null;
    }
  }

  async function listSyncHistory(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit || SYNC_HISTORY_LIMIT), 1), SYNC_HISTORY_MAX_LIMIT);
    const allHistory = await getAllFromStore('sync_history');
    return (allHistory || [])
      .filter((item) => {
        if (options.event_type && item?.event_type !== options.event_type) return false;
        if (options.status && item?.status !== options.status) return false;
        return true;
      })
      .sort((a, b) => {
        const aTime = Date.parse(a.created_at || '');
        const bTime = Date.parse(b.created_at || '');
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      })
      .slice(0, limit);
  }

  function getHistoryEventLabel(type) {
    const labels = {
      local_change_created: '本地变更已记录',
      local_change_uploaded: '上传成功',
      local_change_failed: '上传失败',
      remote_change_checked: '云端检查完成',
      remote_change_applied: '远端变更已应用',
      remote_change_blocked: '远端变更已阻止',
      conflict_created: '冲突副本已创建',
      conflict_resolved: '冲突已解决',
      conflict_ignored: '冲突已忽略',
      cleanup_done: '清理完成',
    };
    return labels[type] || '同步事件';
  }

  function getHistoryStatusLabel(status) {
    if (status === 'success') return '成功';
    if (status === 'failed') return '失败';
    if (status === 'blocked') return '已阻止';
    return '信息';
  }

  function renderSyncHistoryItems(history) {
    const safeHistory = Array.isArray(history) ? history : [];
    if (!safeHistory.length) return '<p class="sync-history-empty">还没有同步历史，完成一次手动同步后会显示在这里。</p>';
    return safeHistory.map(item => `
      <article class="sync-history-item">
        <span>${escapeHtml(formatSyncTime(item.created_at))}</span>
        <strong>${escapeHtml(getHistoryEventLabel(item.event_type))} · ${escapeHtml(getHistoryStatusLabel(item.status))}</strong>
        <em>${escapeHtml(item.entity_id || getEntityLabel(item.entity_type) || '同步')}</em>
        <p>${escapeHtml(item.message || '已记录同步事件')}</p>
      </article>
    `).join('');
  }

  async function renderSyncHistoryPanel(options = {}) {
    const listEl = document.getElementById('syncHistoryList');
    const allEl = document.getElementById('syncHistoryAllList');
    const limit = options.showAll ? 200 : 5;
    const history = await listSyncHistory({ limit });
    if (listEl) listEl.innerHTML = renderSyncHistoryItems(history.slice(0, 5));
    if (allEl) {
      allEl.innerHTML = options.showAll ? renderSyncHistoryItems(history) : '';
      allEl.classList.toggle('hidden', !options.showAll);
    }
    return history;
  }

  async function listAllLocalChanges() {
    return getAllFromStore('local_changes');
  }

  async function renderFailedLocalChangesPanel() {
    const panel = document.getElementById('failedLocalChangesPanel');
    const listEl = document.getElementById('failedLocalChangeList');
    if (!panel || !listEl) return [];
    const allChanges = await listAllLocalChanges();
    const failed = (allChanges || [])
      .filter(change => change?.sync_status === 'failed')
      .sort((a, b) => {
        const aTime = Date.parse(a.created_at || '');
        const bTime = Date.parse(b.created_at || '');
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      });
    panel.classList.toggle('hidden', failed.length === 0);
    listEl.innerHTML = failed.length
      ? failed.slice(0, 20).map(change => `
        <article class="failed-local-change-item">
          <div>
            <strong>${escapeHtml(getEntityLabel(change.entity_type))} · ${escapeHtml(getOperationLabel(change.operation))}</strong>
            <span>${escapeHtml(change.entity_id || '')}</span>
            <span>${escapeHtml(formatSyncTime(change.created_at))}</span>
            <p>${escapeHtml(change.last_error || '上传失败，等待手动处理')}</p>
          </div>
          <div class="failed-local-change-actions">
            <button type="button" data-incremental-action="retry-failed-change" data-change-id="${escapeHtml(change.change_id)}">重试</button>
            <button type="button" data-incremental-action="ignore-failed-change" data-change-id="${escapeHtml(change.change_id)}">忽略</button>
          </div>
        </article>
      `).join('')
      : '<p class="sync-history-empty">当前没有上传失败的本地变更。</p>';
    return failed;
  }

  function renderRemoteChangeMetadataList(changes) {
    const listEl = document.getElementById('remoteChangeMetadataList');
    const noticeEl = document.getElementById('remoteChangeNotice');
    const safeChanges = Array.isArray(changes) ? changes : [];
    if (noticeEl) {
      noticeEl.classList.toggle('hidden', safeChanges.length <= 0);
    }
    if (!listEl) return safeChanges;
    if (!safeChanges.length) {
      listEl.innerHTML = '<p class="remote-change-empty">当前没有可查看的云端新变更。</p>';
      return safeChanges;
    }
    listEl.innerHTML = safeChanges.slice(0, 10).map((change) => {
      const deviceShort = String(change.device_id || 'unknown').slice(0, 8) || 'unknown';
      const changeId = escapeHtml(change.change_id || '');
      return `
        <article class="remote-change-item">
          <div>
            <strong>${getEntityLabel(change.entity_type)} · ${getOperationLabel(change.operation)}</strong>
            <span>实体：${escapeHtml(change.entity_id || '')}</span>
          </div>
          <div class="remote-change-meta">
            <span>设备：${escapeHtml(deviceShort)}</span>
            <span>${escapeHtml(formatSyncTime(change.uploaded_at))}</span>
            <button
              type="button"
              class="remote-change-preview-button"
              data-incremental-action="preview-remote-change"
              data-change-id="${changeId}"
            >预览</button>
          </div>
        </article>
      `;
    }).join('');
    return safeChanges;
  }

  function validateRemoteEncryptedChange(encryptedChange) {
    if (!encryptedChange || typeof encryptedChange !== 'object') throw new Error('同步变更格式不正确或已损坏');
    if (encryptedChange.app !== 'LeafVault') throw new Error('同步变更格式不正确或已损坏');
    if (encryptedChange.type !== 'incremental_change') throw new Error('同步变更格式不正确或已损坏');
    const version = Number(encryptedChange.version);
    if (version === 2) {
      if (encryptedChange.kdf !== 'local-encryption-key-v1') throw new Error('同步变更格式不正确或已损坏');
      if (!encryptedChange.iv || !encryptedChange.payload) throw new Error('同步变更格式不正确或已损坏');
      return;
    }
    if (version !== 1) throw new Error('同步变更格式不正确或已损坏');
    if (encryptedChange.kdf !== 'PBKDF2') throw new Error('同步变更格式不正确或已损坏');
    if (!encryptedChange.salt || !encryptedChange.iv || !encryptedChange.payload) {
      throw new Error('同步变更格式不正确或已损坏');
    }
  }

  function isLegacySyncPasswordRequiredError(error) {
    return error?.code === 'legacy_password_required' || error?.message === 'legacy_password_required';
  }

  function getLegacySyncMessage() {
    return '这是旧同步密码格式，需要在旧格式兼容入口中单独处理。';
  }

  function sanitizeSyncErrorText(value) {
    const text = String(value ?? '');
    return text
      .replace(/("(?:token|password|csrf|key|payload|encrypted_change|encrypted_blob)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
      .slice(0, 800);
  }

  function formatSyncError(error) {
    if (!error) return '同步操作失败';
    if (typeof error === 'string') return sanitizeSyncErrorText(error);
    if (isLegacySyncPasswordRequiredError(error)) return getLegacySyncMessage();
    const detail = error.detail ?? error?.response?.detail;
    if (Array.isArray(detail)) {
      return detail.map((item) => {
        const loc = Array.isArray(item?.loc) ? item.loc.join('.') : (item?.loc || '');
        const msg = item?.msg || item?.message || '字段校验失败';
        const type = item?.type ? ` (${item.type})` : '';
        return `${loc ? `${loc}: ` : ''}${msg}${type}`;
      }).join('；');
    }
    if (typeof detail === 'string') return sanitizeSyncErrorText(detail);
    if (error.message && error.message !== '[object Object]') return sanitizeSyncErrorText(error.message);
    try {
      return sanitizeSyncErrorText(JSON.stringify(error, null, 2));
    } catch (_) {
      return '同步操作失败';
    }
  }

  function validateDecryptedRemotePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('云端变更格式不正确');
    if (payload.app !== 'LeafVault') throw new Error('云端变更格式不正确');
    if (payload.type !== 'incremental_change_payload') throw new Error('云端变更格式不正确');
    if (!VALID_ENTITY_TYPES.has(payload.entity_type)) throw new Error('云端变更格式不正确');
    if (!VALID_OPERATIONS.has(payload.operation)) throw new Error('云端变更格式不正确');
  }

  async function fetchRemoteEncryptedChange(changeId) {
    if (isDemoMode()) {
      notifyDemoLocalOnly();
      throw new Error('Demo mode local only');
    }
    const id = String(changeId || '').trim();
    if (!id) throw new Error('云端变更不存在');
    if (typeof window.apiFetch !== 'function') throw new Error('网络请求模块尚未加载');
    const res = await window.apiFetch(`/api/sync/changes/${encodeURIComponent(id)}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.status !== 'success' || !body.data?.encrypted_change) {
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new Error('无权访问该变更或登录已失效');
      }
      throw new Error(body?.detail || body?.message || '云端变更下载失败');
    }
    return body.data;
  }

  async function decryptRemoteChangePayload(encryptedChange, password = '') {
    try {
      validateRemoteEncryptedChange(encryptedChange);
      if (Number(encryptedChange.version) === 2) {
        if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('解密同步变更'))) {
          throw new Error('本地加密空间尚未解锁，请先输入密码解锁。');
        }
        if (!window.CryptoEngine?.decryptSyncPayload) throw new Error('本地加密模块尚未加载');
        const payload = await window.CryptoEngine.decryptSyncPayload(encryptedChange);
        validateDecryptedRemotePayload(payload);
        return payload;
      }
      if (!password) {
        const legacyError = new Error('legacy_password_required');
        legacyError.code = 'legacy_password_required';
        throw legacyError;
      }
      const salt = base64ToBytes(encryptedChange.salt);
      const iv = base64ToBytes(encryptedChange.iv);
      const encryptedBytes = base64ToBytes(encryptedChange.payload);
      const key = await deriveSyncKey(
        password,
        salt,
        ['decrypt'],
        Number(encryptedChange.iterations || SYNC_ITERATIONS)
      );
      const plainBuffer = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encryptedBytes
      );
      const payload = JSON.parse(new TextDecoder().decode(plainBuffer));
      validateDecryptedRemotePayload(payload);
      return payload;
    } catch (error) {
      if (isLegacySyncPasswordRequiredError(error)) throw error;
      throw new Error('同步变更解密失败，请确认本地加密空间已解锁，或该变更是否损坏。');
    }
  }

  function getRecordImageCount(record) {
    if (!record || typeof record !== 'object') return 0;
    if (Array.isArray(record.images)) return record.images.length;
    if (Array.isArray(record.image_paths)) return record.image_paths.length;
    if (typeof record.image_paths === 'string' && record.image_paths.trim()) {
      return record.image_paths.split(',').filter(Boolean).length;
    }
    return 0;
  }

  function getLedgerTypeLabel(type) {
    if (type === 'income') return '收入';
    if (type === 'expense') return '支出';
    return type || '未标记';
  }

  function clipPreviewText(value, maxLength) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text || '无';
    return `${text.slice(0, maxLength)}...`;
  }

  function getRemoteEntityId(decryptedPayload) {
    const record = decryptedPayload?.record || {};
    return String(
      decryptedPayload?.entity_id
      || record.date
      || record.uuid
      || record.local_id
      || record.id
      || ''
    ).trim();
  }

  function getRecordRevision(record) {
    return normalizeRevision(record?.local_revision ?? record?.revision ?? 0);
  }

  function getRecordLastChangeId(record) {
    return String(record?.last_change_id || '').trim();
  }

  function getRemoteRevision(decryptedPayload, metadata, key) {
    const metaValue = metadata?.[key];
    const payloadKey = key === 'base_revision' ? 'base_revision' : 'local_revision';
    return normalizeRevision(metaValue ?? decryptedPayload?.[payloadKey] ?? 0);
  }

  async function hasAppliedRemoteChange(changeId) {
    const id = String(changeId || '').trim();
    if (!id || !window.LocalStorage || typeof window.LocalStorage.get !== 'function') return null;
    const record = await window.LocalStorage.get('applied_remote_changes', id).catch(() => null);
    if (!record || record.local_result === 'blocked') return null;
    return record;
  }

  async function recordAppliedRemoteChange(changeId, metadata = {}) {
    const id = String(changeId || '').trim();
    if (!id || !window.LocalStorage || typeof window.LocalStorage.set !== 'function') return null;
    const record = {
      change_id: id,
      entity_type: metadata.entity_type || '',
      entity_id: String(metadata.entity_id || '').trim(),
      operation: metadata.operation || '',
      remote_device_id: metadata.device_id || metadata.remote_device_id || '',
      applied_at: new Date().toISOString(),
      local_result: metadata.local_result || 'applied',
      reason: String(metadata.reason || '').slice(0, 180),
    };
    await window.LocalStorage.set('applied_remote_changes', record);
    return record;
  }

  async function markRemoteChangeBlocked(changeId, reason, metadata = {}) {
    return recordAppliedRemoteChange(changeId, {
      ...metadata,
      local_result: 'blocked',
      reason: reason || 'blocked',
    });
  }

  function buildRecordPreview(record, entityType) {
    if (!record || typeof record !== 'object') return null;
    if (entityType === 'diary') {
      return {
        date: record.date || '',
        mood_label: record.mood_label || record.mood || '',
        content_preview: clipPreviewText(record.content, 80),
        image_count: getRecordImageCount(record),
      };
    }
    return {
      uuid: record.uuid || record.local_id || record.id || '',
      date: record.date || record.created_at || '',
      type: getLedgerTypeLabel(record.type),
      amount: record.amount ?? '',
      category: record.category || '',
      note_preview: clipPreviewText(record.note, 60),
    };
  }

  function buildConflictSnapshot(record, entityType, fallback = {}) {
    if (!record || typeof record !== 'object') {
      return {
        entity_type: entityType,
        entity_id: fallback.entity_id || '',
        operation: fallback.operation || '',
        deleted_at: fallback.deleted_at || null,
        created_at: fallback.created_at || '',
      };
    }
    return {
      ...record,
      preview: buildRecordPreview(record, entityType),
    };
  }

  function formatConflictType(status) {
    if (status === 'conflict') return '内容冲突';
    if (status === 'delete_conflict') return '删除冲突';
    if (status === 'stale_remote') return '远端过旧';
    return '未知风险';
  }

  function canCreateConflictCopy(mergePlan) {
    return CONFLICT_COPY_STATUSES.has(mergePlan?.status);
  }

  function canResolveConflict(conflict) {
    return conflict?.conflict_status === 'open'
      && CONFLICT_COPY_STATUSES.has(conflict?.merge_status);
  }

  function getConflictSnapshotValue(snapshot, key, fallback = '') {
    if (!snapshot || typeof snapshot !== 'object') return fallback;
    const value = snapshot[key];
    return value === undefined || value === null ? fallback : value;
  }

  function stripConflictSnapshotPreview(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return {};
    const { preview, ...record } = snapshot;
    return record;
  }

  function getConflictDate(conflict, snapshot = null) {
    return String(
      snapshot?.date
      || conflict?.entity_id
      || snapshot?.created_at
      || ''
    ).trim();
  }

  function getConflictLedgerId(conflict, snapshot = null) {
    return String(
      snapshot?.local_id
      || snapshot?.uuid
      || snapshot?.id
      || conflict?.entity_id
      || ''
    ).trim();
  }

  function buildResolutionChangeId() {
    return buildChangeId();
  }

  function getConflictResolutionRevision(conflict) {
    return Math.max(
      normalizeRevision(conflict?.local_revision),
      normalizeRevision(conflict?.remote_local_revision)
    ) + 1;
  }

  function getResolutionConfirmMessage(conflict, choice) {
    if (choice === 'keep_local') {
      return '保留本地版本不会修改当前日记或账本，只会把该冲突标记为已解决。是否继续？';
    }
    if (choice === 'ignore') {
      return '暂时忽略后不会修改本地日记或账本，也不会删除冲突副本记录。是否继续？';
    }
    if (choice === 'manual_merge') {
      return '手动合并保存会生成一个新的本地版本，并可在之后上传为新的增量变更。是否继续？';
    }
    if (choice === 'use_remote' && conflict?.operation === 'delete') {
      return `采用远端删除会删除本地这条${getEntityLabel(conflict.entity_type)}记录，是否继续？`;
    }
    if (choice === 'use_remote') {
      return `采用远端版本会替换当前本地这条${getEntityLabel(conflict.entity_type)}记录，是否继续？`;
    }
    return '解决冲突只会在你确认后修改本地数据。是否继续？';
  }

  function buildDiaryResolutionRecord(conflict, sourceRecord, choice, mergedRecord = null) {
    const base = choice === 'manual_merge' ? (mergedRecord || {}) : stripConflictSnapshotPreview(sourceRecord);
    const fallback = stripConflictSnapshotPreview(conflict.local_snapshot || conflict.remote_snapshot || {});
    const date = String(base.date || fallback.date || conflict.entity_id || '').trim();
    if (!date) throw new Error('缺少日记日期，无法解决冲突');
    return {
      ...fallback,
      ...base,
      date,
      content: String(base.content ?? ''),
      mood_label: String(base.mood_label || base.mood || fallback.mood_label || '一般'),
      image_paths: base.image_paths ?? fallback.image_paths ?? '',
      retained_images: base.retained_images ?? fallback.retained_images ?? '',
      offline_files: Array.isArray(base.offline_files) ? base.offline_files : [],
    };
  }

  function buildLedgerResolutionRecord(conflict, sourceRecord) {
    const base = stripConflictSnapshotPreview(sourceRecord);
    const fallback = stripConflictSnapshotPreview(conflict.local_snapshot || {});
    const ledgerId = getConflictLedgerId(conflict, base) || getUuid();
    return {
      ...fallback,
      ...base,
      local_id: base.local_id || fallback.local_id || ledgerId,
      uuid: base.uuid || fallback.uuid || ledgerId,
      created_at: base.created_at || base.date || fallback.created_at || fallback.date || new Date().toISOString().slice(0, 10),
      type: base.type || fallback.type || 'expense',
      amount: Number.isFinite(Number(base.amount)) ? Number(base.amount) : Number(fallback.amount || 0),
      category: base.category || fallback.category || '未分类',
      note: base.note || '',
      is_deleted: 0,
    };
  }

  function recordsLookDifferent(localRecord, remoteRecord, entityType) {
    if (!localRecord || !remoteRecord) return true;
    if (entityType === 'diary') {
      return String(localRecord.content || '') !== String(remoteRecord.content || '')
        || String(localRecord.mood_label || localRecord.mood || '') !== String(remoteRecord.mood_label || remoteRecord.mood || '');
    }
    const fields = ['type', 'amount', 'category', 'note', 'date', 'created_at'];
    return fields.some(field => String(localRecord[field] ?? '') !== String(remoteRecord[field] ?? ''));
  }

  function formatMergePlanStatus(status) {
    const labels = {
      safe_apply: '可安全应用',
      already_applied: '可能已应用',
      duplicate: '可能重复',
      stale_remote: '云端变更过旧',
      conflict: '存在冲突',
      delete_conflict: '删除冲突',
      missing_local: '本地缺少记录',
      unknown: '需要人工判断',
    };
    return labels[status] || labels.unknown;
  }

  async function getLocalRecordForRemoteChange(decryptedPayload) {
    if (!window.LocalStorage || typeof window.LocalStorage.get !== 'function') return null;
    const entityType = decryptedPayload?.entity_type;
    const record = decryptedPayload?.record || {};
    if (entityType === 'diary') {
      const dateKey = String(decryptedPayload.entity_id || record.date || '').trim();
      if (!dateKey) return null;
      return window.LocalStorage.get('diaries', dateKey).catch(() => null);
    }
    if (entityType !== 'ledger') return null;
    const entityId = String(decryptedPayload.entity_id || record.uuid || record.local_id || record.id || '').trim();
    if (entityId) {
      const direct = await window.LocalStorage.get('ledgers', entityId).catch(() => null);
      if (direct) return direct;
    }
    if (typeof window.LocalStorage.getAll !== 'function') return null;
    const ledgers = await window.LocalStorage.getAll('ledgers').catch(() => []);
    return (ledgers || []).find((item) => {
      const uuidMatch = entityId && (
        String(item?.uuid || '') === entityId
        || String(item?.local_id || '') === entityId
        || String(item?.id || '') === entityId
      );
      if (uuidMatch) return true;
      if (!record || !record.created_at) return false;
      return String(item?.created_at || '') === String(record.created_at || '')
        && String(item?.amount ?? '') === String(record.amount ?? '')
        && String(item?.category || '') === String(record.category || '')
        && String(item?.note || '') === String(record.note || '');
    }) || null;
  }

  function buildMergePlan(decryptedPayload, localRecord, metadata = {}) {
    const entityType = decryptedPayload?.entity_type || 'unknown';
    const operation = decryptedPayload?.operation || 'unknown';
    const remoteRecord = decryptedPayload?.record || null;
    const entityId = getRemoteEntityId(decryptedPayload);
    const changeId = String(metadata.change_id || decryptedPayload?.change_id || '').trim();
    const hasLocalRecord = Boolean(localRecord && !localRecord.deleted_at);
    const hasRemoteRecord = Boolean(remoteRecord);
    const localRevision = hasLocalRecord ? getRecordRevision(localRecord) : 0;
    const remoteBaseRevision = getRemoteRevision(decryptedPayload, metadata, 'base_revision');
    const remoteLocalRevision = getRemoteRevision(decryptedPayload, metadata, 'local_revision');
    const plan = {
      change_id: changeId,
      entity_type: entityType,
      entity_id: entityId,
      operation,
      remote_device_id: metadata.device_id || decryptedPayload?.device_id || '',
      status: 'unknown',
      risk_level: 'medium',
      summary: '需要人工判断后续处理方式。',
      reason: '当前阶段只做合并前检查，不会修改本地数据。',
      local_revision: localRevision,
      remote_base_revision: remoteBaseRevision,
      remote_local_revision: remoteLocalRevision,
      has_local_record: hasLocalRecord,
      has_remote_record: hasRemoteRecord,
      can_apply_later: false,
      requires_conflict_copy: false,
      preview: {
        local: buildRecordPreview(localRecord, entityType),
        remote: buildRecordPreview(remoteRecord, entityType),
      },
    };

    if (hasLocalRecord && changeId && getRecordLastChangeId(localRecord) === changeId) {
      return {
        ...plan,
        status: 'already_applied',
        risk_level: 'low',
        summary: '该变更可能已经应用过，无需重复处理。',
        reason: '本地记录的 last_change_id 与云端 change_id 相同。',
      };
    }

    if (!hasLocalRecord) {
      if (operation === 'delete') {
        return {
          ...plan,
          status: 'already_applied',
          risk_level: 'low',
          summary: '本地已经没有该记录，删除变更可视为已处理。',
          reason: '删除操作对应的本地记录不存在。',
        };
      }
      return {
        ...plan,
        status: 'missing_local',
        risk_level: entityType === 'ledger' && operation === 'update' ? 'medium' : 'low',
        summary: operation === 'update' && entityType === 'ledger'
          ? '本地缺少该账本记录，未来导入前需要确认来源。'
          : '本地缺少该记录，未来可作为新记录导入。',
        reason: '没有找到相同日期的日记或相同 uuid 的账本记录。',
        can_apply_later: operation !== 'delete',
      };
    }

    if (entityType === 'ledger' && operation === 'create') {
      return {
        ...plan,
        status: 'duplicate',
        risk_level: 'low',
        summary: '本地已经存在相同 uuid 的账本，未来不应重复导入。',
        reason: '账本新增以 uuid 幂等，本地已有同一实体。',
      };
    }

    if (operation === 'delete') {
      if (localRevision <= remoteBaseRevision) {
        return {
          ...plan,
          status: 'safe_apply',
          risk_level: 'low',
          summary: '该删除变更基于你当前本地版本或更早版本，未来可以安全应用。',
          reason: '本地版本没有超过远端变更的基线版本。',
          can_apply_later: true,
        };
      }
      return {
        ...plan,
        status: 'delete_conflict',
        risk_level: 'high',
        summary: '云端想删除该记录，但本地在此之后发生过修改。',
        reason: '本地版本号高于远端 base_revision，未来应保留本地并创建冲突提示。',
        requires_conflict_copy: true,
      };
    }

    if (localRevision <= remoteBaseRevision) {
      return {
        ...plan,
        status: 'safe_apply',
        risk_level: 'low',
        summary: '该远端变更基于你当前本地版本或更早版本，未来可以安全应用。',
        reason: '本地版本号没有超过远端 base_revision。',
        can_apply_later: true,
      };
    }

    if (recordsLookDifferent(localRecord, remoteRecord, entityType)) {
      return {
        ...plan,
        status: 'conflict',
        risk_level: 'high',
        summary: '本地数据和云端变更都发生过修改，未来应创建冲突副本，不建议直接覆盖。',
        reason: '本地版本号高于远端 base_revision，且内容摘要不同。',
        requires_conflict_copy: true,
      };
    }

    if (remoteLocalRevision < localRevision) {
      return {
        ...plan,
        status: 'stale_remote',
        risk_level: 'medium',
        summary: '云端变更可能早于本地当前版本，暂不建议直接应用。',
        reason: '远端目标版本低于本地版本，且当前可展示内容基本一致。',
      };
    }

    return {
      ...plan,
      status: 'stale_remote',
      risk_level: 'low',
      summary: '该云端变更可能早于本地当前版本，暂不建议应用。',
      reason: '本地版本号高于远端 base_revision，但当前可展示内容基本一致。',
    };
  }

  async function analyzeRemoteChangeAgainstLocal(decryptedPayload, metadata = {}) {
    const applied = await hasAppliedRemoteChange(metadata.change_id || decryptedPayload?.change_id);
    const localRecord = await getLocalRecordForRemoteChange(decryptedPayload);
    const plan = buildMergePlan(decryptedPayload, localRecord, metadata);
    if (applied) {
      return {
        ...plan,
        status: 'already_applied',
        risk_level: 'low',
        summary: '该变更已在本设备处理过，无需重复应用。',
        reason: `本设备已记录该远端 change_id，处理结果：${applied.local_result || 'applied'}。`,
        can_apply_later: false,
        requires_conflict_copy: false,
      };
    }
    return plan;
  }

  function renderMergePlanPreview(mergePlan) {
    if (!mergePlan) return '';
    const riskLabel = mergePlan.risk_level === 'high' ? '高'
      : mergePlan.risk_level === 'medium' ? '中'
        : '低';
    let actionHtml = '<p class="merge-plan-blocked">该变更存在冲突或风险，当前阶段不会自动覆盖本地数据。</p>';
    if (canCreateConflictCopy(mergePlan)) {
      actionHtml = `
        <button
          type="button"
          class="merge-plan-conflict-action"
          data-incremental-action="create-conflict-copy"
          data-change-id="${escapeHtml(mergePlan.change_id || '')}"
        >创建冲突副本</button>
      `;
    } else if (mergePlan.status === 'safe_apply' || mergePlan.status === 'missing_local') {
      actionHtml = `
        <button
          type="button"
          class="merge-plan-apply-action"
          data-incremental-action="apply-remote-change"
          data-change-id="${escapeHtml(mergePlan.change_id || '')}"
        >应用此变更</button>
      `;
    } else if (mergePlan.status === 'already_applied') {
      actionHtml = '<p class="merge-plan-handled">该变更已处理。</p>';
    } else if (mergePlan.status === 'duplicate') {
      actionHtml = '<p class="merge-plan-blocked">疑似重复变更，已阻止重复应用。</p>';
    }
    return `
      <div class="merge-plan-preview merge-plan-${escapeHtml(mergePlan.risk_level)}">
        <div class="merge-plan-title">
          <strong>合并前安全检查</strong>
          <span>${escapeHtml(formatMergePlanStatus(mergePlan.status))}</span>
        </div>
        <div class="merge-plan-grid">
          <span>风险等级：${escapeHtml(riskLabel)}</span>
          <span>本地版本号：${escapeHtml(mergePlan.local_revision)}</span>
          <span>远端基线版本号：${escapeHtml(mergePlan.remote_base_revision)}</span>
          <span>远端目标版本号：${escapeHtml(mergePlan.remote_local_revision)}</span>
          <span>未来可应用：${mergePlan.can_apply_later ? '是' : '否'}</span>
          <span>需要冲突副本：${mergePlan.requires_conflict_copy ? '是' : '否'}</span>
        </div>
        <p>${escapeHtml(mergePlan.summary)}</p>
        <p>${escapeHtml(mergePlan.reason)}</p>
        <p class="remote-change-preview-note">应用前已完成本地版本检查。冲突变更不会被自动覆盖。</p>
        ${actionHtml}
        <p class="remote-change-preview-note">当前阶段只允许手动应用低风险变更，不会自动覆盖本地数据。</p>
      </div>
    `;
  }

  function renderRemoteChangePreview(decryptedPayload, metadata = {}, mergePlan = null) {
    const panel = document.getElementById('remoteChangePreviewPanel');
    if (!panel) return;
    const record = decryptedPayload?.record || null;
    const commonRows = `
      <span>类型：${escapeHtml(getEntityLabel(decryptedPayload.entity_type))}</span>
      <span>操作：${escapeHtml(getOperationLabel(decryptedPayload.operation))}</span>
      <span>来源设备：${escapeHtml(String(metadata.device_id || decryptedPayload.device_id || 'unknown').slice(0, 8))}</span>
      <span>上传时间：${escapeHtml(formatSyncTime(metadata.uploaded_at))}</span>
      <span>base_revision：${escapeHtml(metadata.base_revision ?? decryptedPayload.base_revision ?? 0)}</span>
      <span>local_revision：${escapeHtml(metadata.local_revision ?? decryptedPayload.local_revision ?? 0)}</span>
    `;
    let detailRows = '';
    if (decryptedPayload.operation === 'delete' && !record) {
      detailRows = `
        <span>实体：${escapeHtml(decryptedPayload.entity_id || '')}</span>
        <span>状态：删除操作，当前变更只包含 tombstone 元信息</span>
      `;
    } else if (decryptedPayload.entity_type === 'diary') {
      detailRows = `
        <span>日期：${escapeHtml(record?.date || decryptedPayload.entity_id || '')}</span>
        <span>心情：${escapeHtml(record?.mood_label || record?.mood || '未记录')}</span>
        <span>内容预览：${escapeHtml(clipPreviewText(record?.content, 120))}</span>
        <span>图片数量：${getRecordImageCount(record)}</span>
      `;
    } else {
      detailRows = `
        <span>日期：${escapeHtml(record?.date || record?.created_at || decryptedPayload.entity_id || '')}</span>
        <span>类型：${escapeHtml(getLedgerTypeLabel(record?.type))}</span>
        <span>金额：${escapeHtml(record?.amount ?? '无')}</span>
        <span>分类：${escapeHtml(record?.category || '未分类')}</span>
        <span>备注预览：${escapeHtml(clipPreviewText(record?.note, 80))}</span>
      `;
    }
    panel.innerHTML = `
      <div class="remote-change-preview-card">
        <div class="remote-change-preview-head">
          <strong>云端增量预览</strong>
          <button type="button" data-incremental-action="close-remote-preview" aria-label="关闭预览">关闭</button>
        </div>
        <div class="remote-change-preview-body">
          ${commonRows}
          ${detailRows}
        </div>
        ${renderMergePlanPreview(mergePlan)}
        <p class="remote-change-privacy">此内容仅在本设备解密显示，服务器不会解密该变更。</p>
        <p class="remote-change-preview-note">当前阶段仅支持解密预览，不会自动合并到本地数据。</p>
      </div>
    `;
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeRemoteChangePreview() {
    const panel = document.getElementById('remoteChangePreviewPanel');
    if (!panel) return;
    panel.innerHTML = '';
    panel.classList.add('hidden');
  }

  async function previewRemoteChange(changeId) {
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('预览云端变更'))) return null;
    if (!navigator.onLine) {
      notify('当前离线，联网后再预览云端变更', true);
      return null;
    }
    try {
      const metadata = await fetchRemoteEncryptedChange(changeId);
      const decryptedPayload = await decryptRemoteChangePayload(metadata.encrypted_change);
      const mergePlan = await analyzeRemoteChangeAgainstLocal(decryptedPayload, metadata);
      renderRemoteChangePreview(decryptedPayload, metadata, mergePlan);
      return decryptedPayload;
    } catch (error) {
      notify(isLegacySyncPasswordRequiredError(error) ? getLegacySyncMessage() : (error?.message || '云端变更预览失败'), true);
      return null;
    }
  }

  function canApplyMergePlan(mergePlan) {
    return mergePlan?.status === 'safe_apply' || mergePlan?.status === 'missing_local';
  }

  function buildAppliedMetadata(mergePlan, result = 'applied', reason = '') {
    return {
      entity_type: mergePlan.entity_type,
      entity_id: mergePlan.entity_id,
      operation: mergePlan.operation,
      device_id: mergePlan.remote_device_id,
      local_result: result,
      reason,
    };
  }

  function buildRemoteRecordForLocalStore(mergePlan, decryptedPayload) {
    const record = { ...(decryptedPayload?.record || {}) };
    const now = new Date().toISOString();
    const updatedAt = record.updated_at || decryptedPayload.created_at || now;
    const base = {
      ...record,
      local_revision: mergePlan.remote_local_revision,
      last_change_id: mergePlan.change_id,
      device_id: mergePlan.remote_device_id || decryptedPayload.device_id || record.device_id || '',
      updated_at: updatedAt,
    };
    if (mergePlan.entity_type === 'diary') {
      return {
        ...base,
        date: record.date || mergePlan.entity_id,
        content: record.content || '',
        mood_label: record.mood_label || record.mood || '一般',
        image_paths: record.image_paths || record.images || '',
      };
    }
    const ledgerId = record.local_id || record.uuid || mergePlan.entity_id || `remote_${mergePlan.change_id}`;
    return {
      ...base,
      local_id: ledgerId,
      uuid: record.uuid || ledgerId,
      created_at: record.created_at || record.date || decryptedPayload.created_at || now,
    };
  }

  async function applyMergePlan(mergePlan, decryptedPayload) {
    if (!canApplyMergePlan(mergePlan)) {
      throw new Error('不适合直接应用，已阻止覆盖');
    }
    if (!window.LocalStorage || typeof window.LocalStorage.set !== 'function') {
      throw new Error('本地数据库模块尚未加载');
    }
    if (!VALID_ENTITY_TYPES.has(mergePlan.entity_type) || !VALID_OPERATIONS.has(mergePlan.operation)) {
      throw new Error('云端变更格式不正确');
    }
    if (!mergePlan.entity_id) throw new Error('云端变更缺少必要实体标识');

    if (mergePlan.operation === 'delete') {
      if (mergePlan.status !== 'safe_apply') throw new Error('不适合直接应用，已阻止覆盖');
      if (mergePlan.entity_type === 'diary') {
        await window.LocalStorage.delete('diaries', mergePlan.entity_id);
      } else {
        const localRecord = await getLocalRecordForRemoteChange(decryptedPayload);
        const ledgerId = localRecord?.local_id || localRecord?.uuid || mergePlan.entity_id;
        await window.LocalStorage.delete('ledgers', ledgerId);
      }
      return { applied: true, operation: 'delete' };
    }

    if (!decryptedPayload.record || typeof decryptedPayload.record !== 'object') {
      throw new Error('云端变更缺少可应用记录');
    }
    const localRecord = buildRemoteRecordForLocalStore(mergePlan, decryptedPayload);
    if (mergePlan.entity_type === 'diary') {
      await window.LocalStorage.set('diaries', localRecord);
    } else {
      await window.LocalStorage.set('ledgers', localRecord);
    }
    return { applied: true, operation: mergePlan.operation };
  }

  async function refreshAfterRemoteApply(mergePlan) {
    const tasks = [];
    if (typeof window.fetchDiaries === 'function') tasks.push(window.fetchDiaries());
    if (typeof window.fetchLedgers === 'function') tasks.push(window.fetchLedgers());
    if (typeof window.initRealCharts === 'function') tasks.push(window.initRealCharts());
    if (typeof window.fetchMonthlySummary === 'function') tasks.push(window.fetchMonthlySummary());
    if (typeof window.renderCalendar === 'function') tasks.push(window.renderCalendar());
    if (mergePlan?.entity_type === 'diary' && typeof window.checkExistingDiary === 'function') {
      const dateInput = document.getElementById('dateInput');
      if (dateInput?.value === mergePlan.entity_id) tasks.push(window.checkExistingDiary(mergePlan.entity_id));
    }
    await Promise.allSettled(tasks);
    await refreshIncrementalSyncStatus();
    if (typeof window.updateBackupStatusPanel === 'function') window.updateBackupStatusPanel();
    await refreshSyncAttentionState().catch(() => null);
  }

  async function applyRemoteChange(changeId) {
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('应用云端变更'))) return null;
    if (!navigator.onLine) {
      notify('当前离线，联网后再应用云端变更', true);
      return null;
    }
    try {
      const metadata = await fetchRemoteEncryptedChange(changeId);
      const decryptedPayload = await decryptRemoteChangePayload(metadata.encrypted_change);
      const mergePlan = await analyzeRemoteChangeAgainstLocal(decryptedPayload, metadata);
      renderRemoteChangePreview(decryptedPayload, metadata, mergePlan);
      if (!canApplyMergePlan(mergePlan)) {
        if (!['already_applied', 'duplicate'].includes(mergePlan.status)) {
          await markRemoteChangeBlocked(mergePlan.change_id, mergePlan.status || 'blocked', buildAppliedMetadata(mergePlan, 'blocked', mergePlan.reason));
          await recordSyncHistory({
            event_type: 'remote_change_blocked',
            entity_type: mergePlan.entity_type,
            entity_id: mergePlan.entity_id,
            change_id: mergePlan.change_id,
            status: 'blocked',
            message: mergePlan.reason || '远端变更因冲突或风险被阻止',
            metadata: { merge_status: mergePlan.status, operation: mergePlan.operation },
          });
        }
        notify('不适合直接应用，已阻止覆盖', true);
        return null;
      }
      const confirmed = window.confirm('该远端变更经检查可安全应用。应用后会更新本地日记或账本，是否继续？');
      if (!confirmed) return null;
      await applyMergePlan(mergePlan, decryptedPayload);
      await recordAppliedRemoteChange(mergePlan.change_id, buildAppliedMetadata(mergePlan, 'applied', mergePlan.status));
      await recordSyncHistory({
        event_type: 'remote_change_applied',
        entity_type: mergePlan.entity_type,
        entity_id: mergePlan.entity_id,
        change_id: mergePlan.change_id,
        status: 'success',
        message: '远端变更已安全应用到本地',
        metadata: { operation: mergePlan.operation, merge_status: mergePlan.status },
      });
      await refreshAfterRemoteApply(mergePlan);
      notify('远端变更已应用');
      const updatedPlan = {
        ...mergePlan,
        status: 'already_applied',
        summary: '该变更已在本设备处理过，无需重复应用。',
        reason: '刚刚已完成安全应用并记录 applied_remote_changes。',
        can_apply_later: false,
      };
      renderRemoteChangePreview(decryptedPayload, metadata, updatedPlan);
      return updatedPlan;
    } catch (error) {
      notify(isLegacySyncPasswordRequiredError(error) ? getLegacySyncMessage() : (error?.message || '远端变更应用失败'), true);
      return null;
    }
  }

  async function listSyncConflicts(status = 'open') {
    if (!window.LocalStorage || typeof window.LocalStorage.getAll !== 'function') return [];
    const conflicts = await getAllFromStore('sync_conflicts');
    return (conflicts || [])
      .filter(item => !status || status === 'all' || item?.conflict_status === status)
      .sort((a, b) => {
        const aTime = Date.parse(a.created_at || '');
        const bTime = Date.parse(b.created_at || '');
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      });
  }

  async function getSyncConflict(conflictId) {
    const id = String(conflictId || '').trim();
    if (!id || !window.LocalStorage || typeof window.LocalStorage.get !== 'function') return null;
    return window.LocalStorage.get('sync_conflicts', id).catch(() => null);
  }

  async function findOpenSyncConflictByChangeId(changeId) {
    const id = String(changeId || '').trim();
    if (!id) return null;
    const conflicts = await listSyncConflicts('open');
    return conflicts.find(item => String(item.change_id || '') === id) || null;
  }

  async function saveSyncConflict(mergePlan, decryptedPayload, metadata = {}) {
    if (!canCreateConflictCopy(mergePlan)) throw new Error('该状态不需要创建冲突副本');
    if (!window.LocalStorage || typeof window.LocalStorage.set !== 'function') {
      throw new Error('本地数据库模块尚未加载');
    }
    const existing = await findOpenSyncConflictByChangeId(mergePlan.change_id);
    if (existing) return existing;
    const localRecord = await getLocalRecordForRemoteChange(decryptedPayload);
    const now = new Date().toISOString();
    const remoteFallback = {
      entity_id: mergePlan.entity_id,
      operation: mergePlan.operation,
      deleted_at: decryptedPayload.deleted_at || decryptedPayload.created_at || now,
      created_at: decryptedPayload.created_at || '',
    };
    const conflict = {
      conflict_id: getUuid(),
      change_id: mergePlan.change_id,
      entity_type: mergePlan.entity_type,
      entity_id: mergePlan.entity_id,
      operation: mergePlan.operation,
      conflict_status: 'open',
      risk_level: mergePlan.risk_level === 'low' ? 'medium' : mergePlan.risk_level,
      merge_status: mergePlan.status,
      reason: mergePlan.reason || mergePlan.summary || '',
      local_revision: mergePlan.local_revision,
      remote_base_revision: mergePlan.remote_base_revision,
      remote_local_revision: mergePlan.remote_local_revision,
      local_snapshot: buildConflictSnapshot(localRecord, mergePlan.entity_type, {
        entity_id: mergePlan.entity_id,
        operation: 'local',
      }),
      remote_snapshot: buildConflictSnapshot(decryptedPayload.record, mergePlan.entity_type, remoteFallback),
      metadata: {
        change_id: metadata.change_id || mergePlan.change_id,
        device_id: metadata.device_id || decryptedPayload.device_id || '',
        client_sequence: metadata.client_sequence || decryptedPayload.client_sequence || 0,
        created_at: metadata.created_at || decryptedPayload.created_at || '',
        uploaded_at: metadata.uploaded_at || '',
      },
      created_at: now,
      updated_at: now,
      resolved_at: '',
      resolution_note: '',
    };
    await window.LocalStorage.set('sync_conflicts', conflict);
    return conflict;
  }

  // 冲突解决必须由用户主动选择；只有 use_remote/manual_merge 会修改主数据并记录新的 local_change。
  async function markConflictResolved(conflictId, resolutionMeta = {}) {
    const conflict = await getSyncConflict(conflictId);
    if (!conflict) throw new Error('冲突副本不存在');
    const now = new Date().toISOString();
    const updated = {
      ...conflict,
      conflict_status: resolutionMeta.choice === 'ignore' ? 'ignored' : 'resolved',
      updated_at: now,
      resolved_at: now,
      resolution_choice: resolutionMeta.choice || 'keep_local',
      resolution_note: String(resolutionMeta.note || '').slice(0, 300),
      resolved_change_id: resolutionMeta.resolved_change_id || '',
    };
    await window.LocalStorage.set('sync_conflicts', updated);
    await recordSyncHistory({
      event_type: updated.conflict_status === 'ignored' ? 'conflict_ignored' : 'conflict_resolved',
      entity_type: updated.entity_type || 'conflict',
      entity_id: updated.entity_id || '',
      change_id: updated.change_id || '',
      conflict_id: updated.conflict_id,
      status: updated.conflict_status === 'ignored' ? 'blocked' : 'success',
      message: updated.conflict_status === 'ignored' ? '冲突已暂时忽略' : '冲突已手动解决',
      metadata: { merge_status: updated.merge_status, resolution_choice: updated.resolution_choice },
    });
    await refreshSyncConflictStatus();
    return updated;
  }

  async function markSyncConflictIgnored(conflictId, note = '') {
    return markConflictResolved(conflictId, {
      choice: 'ignore',
      note: note || '用户暂时忽略，未修改本地日记或账本。',
    });
  }

  async function markConflictIgnored(conflictId, note = '') {
    return markSyncConflictIgnored(conflictId, note);
  }

  async function applyConflictResolution(conflict, resolution) {
    if (!canResolveConflict(conflict)) throw new Error('该冲突当前不可解决或已处理');
    const choice = resolution?.choice;
    if (!['keep_local', 'use_remote', 'manual_merge', 'ignore'].includes(choice)) {
      throw new Error('冲突解决方式无效');
    }
    if (choice === 'keep_local' || choice === 'ignore') {
      return { changed: false, resolved_change_id: '' };
    }
    if (!window.LocalStorage || typeof window.LocalStorage.set !== 'function') {
      throw new Error('本地数据库模块尚未加载');
    }

    const now = new Date().toISOString();
    const baseRevision = normalizeRevision(conflict.local_revision);
    const newRevision = getConflictResolutionRevision(conflict);
    const resolvedChangeId = buildResolutionChangeId();

    if (conflict.entity_type === 'diary') {
      const date = getConflictDate(conflict, conflict.remote_snapshot || conflict.local_snapshot);
      if (!date) throw new Error('缺少日记日期，无法解决冲突');

      if (choice === 'use_remote' && conflict.operation === 'delete') {
        await window.LocalStorage.delete('diaries', date);
        await createLocalChange({
          change_id: resolvedChangeId,
          entity_type: 'diary',
          entity_id: date,
          operation: 'delete',
          base_revision: baseRevision,
          local_revision: newRevision,
        });
        window.markLocalDataChanged?.('sync_conflict_resolved_delete');
        return { changed: true, resolved_change_id: resolvedChangeId };
      }

      const sourceRecord = choice === 'manual_merge' ? resolution.merged_record : conflict.remote_snapshot;
      const diaryRecord = buildDiaryResolutionRecord(conflict, sourceRecord, choice, resolution.merged_record);
      const finalDiary = {
        ...diaryRecord,
        local_revision: newRevision,
        last_change_id: resolvedChangeId,
        device_id: getDeviceId(),
        updated_at: now,
        deleted_at: '',
        sync_status: 1,
      };
      await window.LocalStorage.set('diaries', finalDiary);
      await createLocalChange({
        change_id: resolvedChangeId,
        entity_type: 'diary',
        entity_id: finalDiary.date,
        operation: 'update',
        base_revision: baseRevision,
        local_revision: newRevision,
      });
      window.markLocalDataChanged?.('sync_conflict_resolved_diary');
      return { changed: true, resolved_change_id: resolvedChangeId };
    }

    if (conflict.entity_type === 'ledger') {
      const ledgerId = getConflictLedgerId(conflict, conflict.local_snapshot || conflict.remote_snapshot);
      if (choice === 'use_remote' && conflict.operation === 'delete') {
        if (!ledgerId) throw new Error('缺少账本标识，无法删除');
        await window.LocalStorage.delete('ledgers', ledgerId);
        await createLocalChange({
          change_id: resolvedChangeId,
          entity_type: 'ledger',
          entity_id: conflict.remote_snapshot?.uuid || conflict.entity_id || ledgerId,
          operation: 'delete',
          base_revision: baseRevision,
          local_revision: newRevision,
        });
        window.markLocalDataChanged?.('sync_conflict_resolved_delete');
        return { changed: true, resolved_change_id: resolvedChangeId };
      }

      if (choice === 'manual_merge') throw new Error('账本冲突暂不支持复杂手动合并');
      const ledgerRecord = buildLedgerResolutionRecord(conflict, conflict.remote_snapshot);
      const finalLedger = {
        ...ledgerRecord,
        local_revision: newRevision,
        last_change_id: resolvedChangeId,
        device_id: getDeviceId(),
        updated_at: now,
        sync_status: 1,
      };
      await window.LocalStorage.set('ledgers', finalLedger);
      await createLocalChange({
        change_id: resolvedChangeId,
        entity_type: 'ledger',
        entity_id: finalLedger.uuid || finalLedger.local_id,
        operation: conflict.operation === 'create' ? 'create' : 'update',
        base_revision: baseRevision,
        local_revision: newRevision,
      });
      window.markLocalDataChanged?.('sync_conflict_resolved_ledger');
      return { changed: true, resolved_change_id: resolvedChangeId };
    }

    throw new Error('不支持的冲突类型');
  }

  async function refreshAfterConflictResolution(conflict) {
    const tasks = [];
    if (typeof window.fetchDiaries === 'function') tasks.push(window.fetchDiaries());
    if (typeof window.fetchLedgers === 'function') tasks.push(window.fetchLedgers());
    if (typeof window.initRealCharts === 'function') tasks.push(window.initRealCharts());
    if (typeof window.fetchMonthlySummary === 'function') tasks.push(window.fetchMonthlySummary());
    if (typeof window.renderCalendar === 'function') tasks.push(window.renderCalendar());
    if (conflict?.entity_type === 'diary' && typeof window.checkExistingDiary === 'function') {
      const dateInput = document.getElementById('dateInput');
      if (dateInput?.value === conflict.entity_id) tasks.push(window.checkExistingDiary(conflict.entity_id));
    }
    await Promise.allSettled(tasks);
    await refreshIncrementalSyncStatus();
    if (typeof window.updateBackupStatusPanel === 'function') window.updateBackupStatusPanel();
    await refreshSyncAttentionState().catch(() => null);
  }

  async function resolveSyncConflict(conflictId, resolution = {}) {
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('解决同步冲突'))) return null;
    const conflict = await getSyncConflict(conflictId);
    if (!conflict) throw new Error('冲突副本不存在');
    if (conflict.conflict_status !== 'open') throw new Error('该冲突已经处理过');
    const choice = resolution.choice || '';
    if (!window.confirm(getResolutionConfirmMessage(conflict, choice))) return null;

    if (choice === 'manual_merge' && conflict.entity_type === 'diary') {
      const merged = resolution.merged_record || {};
      if (!String(merged.date || conflict.entity_id || '').trim()) throw new Error('手动合并缺少日期');
      if (!String(merged.content ?? '').trim()) throw new Error('手动合并内容不能为空');
      if (!String(merged.mood_label || '').trim()) throw new Error('请选择或保留一个心情');
    }

    const applyResult = await applyConflictResolution(conflict, resolution);
    const updated = await markConflictResolved(conflictId, {
      choice,
      note: resolution.note || '',
      resolved_change_id: applyResult?.resolved_change_id || '',
    });
    await refreshAfterConflictResolution(conflict);
    if (choice === 'ignore') {
      notify('已暂时忽略该冲突，本地数据未被修改');
    } else if (choice === 'keep_local') {
      notify('已保留本地版本，冲突已标记为解决');
    } else if (choice === 'use_remote') {
      notify('已采用远端版本，并生成新的本地待同步变更');
    } else if (choice === 'manual_merge') {
      notify('手动合并已保存，并生成新的本地待同步变更');
    }
    return updated;
  }

  function renderConflictSnapshotSummary(snapshot, entityType, prefix) {
    if (!snapshot) return `<span>${prefix}：无记录</span>`;
    if (entityType === 'diary') {
      return `
        <span>${prefix}日期：${escapeHtml(snapshot.date || snapshot.entity_id || '')}</span>
        <span>${prefix}心情：${escapeHtml(snapshot.mood_label || snapshot.mood || '未记录')}</span>
        <span>${prefix}内容：${escapeHtml(clipPreviewText(snapshot.content, 200))}</span>
        <span>${prefix}图片数量：${getRecordImageCount(snapshot)}</span>
        <span>${prefix}更新时间：${escapeHtml(formatSyncTime(snapshot.updated_at || snapshot.created_at))}</span>
      `;
    }
    return `
      <span>${prefix}日期：${escapeHtml(snapshot.date || snapshot.created_at || '')}</span>
      <span>${prefix}类型：${escapeHtml(getLedgerTypeLabel(snapshot.type))}</span>
      <span>${prefix}金额：${escapeHtml(snapshot.amount ?? '无')}</span>
      <span>${prefix}分类：${escapeHtml(snapshot.category || '未分类')}</span>
      <span>${prefix}备注：${escapeHtml(clipPreviewText(snapshot.note, 200))}</span>
    `;
  }

  function renderSyncConflictList(conflicts) {
    const listEl = document.getElementById('syncConflictList');
    if (!listEl) return;
    const safeConflicts = Array.isArray(conflicts) ? conflicts : [];
    if (!safeConflicts.length) {
      listEl.innerHTML = '<p class="sync-conflict-empty">当前没有需要处理的同步冲突。</p>';
      return;
    }
    listEl.innerHTML = safeConflicts.slice(0, 20).map((conflict) => {
      const deviceShort = String(conflict.metadata?.device_id || conflict.remote_device_id || 'unknown').slice(0, 8) || 'unknown';
      return `
        <article class="sync-conflict-item">
          <div>
            <strong>${getEntityLabel(conflict.entity_type)} · ${formatConflictType(conflict.merge_status)}</strong>
            <span>实体：${escapeHtml(conflict.entity_id || '')}</span>
            <span>风险：${escapeHtml(conflict.risk_level || 'medium')} · 设备：${escapeHtml(deviceShort)}</span>
            <span>${escapeHtml(formatSyncTime(conflict.created_at))}</span>
          </div>
          <div class="sync-conflict-actions">
            <button type="button" data-incremental-action="view-sync-conflict" data-conflict-id="${escapeHtml(conflict.conflict_id)}">查看详情</button>
            <button type="button" data-incremental-action="ignore-sync-conflict" data-conflict-id="${escapeHtml(conflict.conflict_id)}">暂时忽略</button>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderConflictResolutionPanel(conflict) {
    if (!canResolveConflict(conflict)) {
      const statusText = conflict?.conflict_status === 'ignored' ? '已暂时忽略' : '已解决';
      return `
        <div class="sync-conflict-resolution">
          <strong>解决状态</strong>
          <p>该冲突副本${escapeHtml(statusText)}，不会再计入待处理冲突数量。</p>
          <p>处理方式：${escapeHtml(conflict?.resolution_choice || '未记录')}</p>
          <p>处理说明：${escapeHtml(conflict?.resolution_note || '无')}</p>
        </div>
      `;
    }

    const localSnapshot = conflict.local_snapshot || {};
    const remoteSnapshot = conflict.remote_snapshot || {};
    const noteInput = `
      <input
        type="text"
        class="sync-conflict-note-input"
        data-conflict-resolution-note="${escapeHtml(conflict.conflict_id)}"
        maxlength="160"
        placeholder="解决说明，可选"
      />
    `;
    let manualMerge = '';
    if (conflict.entity_type === 'diary' && conflict.merge_status !== 'delete_conflict') {
      const mergedContent = remoteSnapshot.content || localSnapshot.content || '';
      const mergedMood = remoteSnapshot.mood_label || localSnapshot.mood_label || localSnapshot.mood || '一般';
      manualMerge = `
        <label class="sync-conflict-editor">
          <span>手动合并后的日记内容</span>
          <textarea
            data-conflict-merge-content="${escapeHtml(conflict.conflict_id)}"
            rows="6"
          >${escapeHtml(mergedContent)}</textarea>
        </label>
        <label class="sync-conflict-editor compact">
          <span>合并后的心情</span>
          <input
            type="text"
            data-conflict-merge-mood="${escapeHtml(conflict.conflict_id)}"
            value="${escapeHtml(mergedMood)}"
          />
        </label>
      `;
    }
    const remoteButtonText = conflict.operation === 'delete' ? '采用远端删除' : '采用远端版本';

    return `
      <div class="sync-conflict-resolution">
        <strong>解决冲突</strong>
        <p>解决冲突只会在你确认后修改本地数据。</p>
        <p>采用远端版本可能覆盖当前本地版本，请确认你已经看清楚内容。</p>
        <p>手动合并会生成一个新的本地版本，并可在之后上传为新的增量变更。</p>
        ${noteInput}
        ${manualMerge}
        <div class="sync-conflict-actions resolution-actions">
          <button type="button" data-incremental-action="resolve-sync-conflict" data-resolution-choice="keep_local" data-conflict-id="${escapeHtml(conflict.conflict_id)}">保留本地版本</button>
          <button type="button" class="sync-conflict-danger" data-incremental-action="resolve-sync-conflict" data-resolution-choice="use_remote" data-conflict-id="${escapeHtml(conflict.conflict_id)}">${remoteButtonText}</button>
          ${manualMerge ? `<button type="button" data-incremental-action="resolve-sync-conflict" data-resolution-choice="manual_merge" data-conflict-id="${escapeHtml(conflict.conflict_id)}">手动合并保存</button>` : ''}
          <button type="button" data-incremental-action="resolve-sync-conflict" data-resolution-choice="ignore" data-conflict-id="${escapeHtml(conflict.conflict_id)}">暂时忽略</button>
        </div>
      </div>
    `;
  }

  async function openConflictResolution(conflictId) {
    return renderSyncConflictDetail(conflictId);
  }

  async function renderSyncConflictDetail(conflictId) {
    const detailEl = document.getElementById('syncConflictDetailPanel');
    if (!detailEl) return;
    const conflict = await getSyncConflict(conflictId);
    if (!conflict) {
      detailEl.innerHTML = '<p class="sync-conflict-empty">没有找到该冲突副本</p>';
      detailEl.classList.remove('hidden');
      return;
    }
    const deleteNotice = conflict.merge_status === 'delete_conflict'
      ? '<p class="sync-conflict-warning">云端变更想删除此记录，但本地在之后发生过修改，因此没有自动删除。</p>'
      : '';
    detailEl.innerHTML = `
      <div class="sync-conflict-detail-card">
        <div class="remote-change-preview-head">
          <strong>冲突副本详情</strong>
          <button type="button" data-incremental-action="close-sync-conflict-detail">关闭</button>
        </div>
        <p class="sync-conflict-warning">冲突副本只是保存待处理记录，不会覆盖你的本地数据。解决冲突只会在你确认后修改本地数据。</p>
        ${deleteNotice}
        <div class="sync-conflict-compare">
          <section>
            <strong>本地版本</strong>
            ${renderConflictSnapshotSummary(conflict.local_snapshot, conflict.entity_type, '本地')}
          </section>
          <section>
            <strong>远端版本</strong>
            ${renderConflictSnapshotSummary(conflict.remote_snapshot, conflict.entity_type, '远端')}
          </section>
        </div>
        ${renderConflictResolutionPanel(conflict)}
      </div>
    `;
    detailEl.classList.remove('hidden');
    detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function refreshSyncConflictStatus() {
    const conflicts = await listSyncConflicts('open');
    const countEl = document.getElementById('syncConflictCount');
    if (countEl) countEl.textContent = `待处理冲突：${conflicts.length} 条`;
    const listEl = document.getElementById('syncConflictList');
    if (listEl && !listEl.classList.contains('hidden')) renderSyncConflictList(conflicts);
    return conflicts.length;
  }

  async function toggleSyncConflictList() {
    const listEl = document.getElementById('syncConflictList');
    if (!listEl) return;
    const shouldShow = listEl.classList.contains('hidden');
    listEl.classList.toggle('hidden', !shouldShow);
    if (shouldShow) renderSyncConflictList(await listSyncConflicts('open'));
  }

  async function createConflictCopy(changeId) {
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('创建冲突副本'))) return null;
    const existing = await findOpenSyncConflictByChangeId(changeId);
    if (existing) {
      notify('该远端变更已经有待处理冲突副本');
      await refreshSyncConflictStatus();
      return existing;
    }
    if (!navigator.onLine) {
      notify('当前离线，联网后再创建冲突副本', true);
      return null;
    }
    try {
      const metadata = await fetchRemoteEncryptedChange(changeId);
      const decryptedPayload = await decryptRemoteChangePayload(metadata.encrypted_change);
      const mergePlan = await analyzeRemoteChangeAgainstLocal(decryptedPayload, metadata);
      renderRemoteChangePreview(decryptedPayload, metadata, mergePlan);
      if (!canCreateConflictCopy(mergePlan)) {
        notify('该状态不需要创建冲突副本', true);
        return null;
      }
      const confirmed = window.confirm('该远端变更存在冲突。创建冲突副本后不会覆盖本地数据，只会保存一份待处理记录。是否继续？');
      if (!confirmed) return null;
      const conflict = await saveSyncConflict(mergePlan, decryptedPayload, metadata);
      await markRemoteChangeBlocked(mergePlan.change_id, mergePlan.status, buildAppliedMetadata(mergePlan, 'blocked', mergePlan.reason));
      await recordSyncHistory({
        event_type: 'conflict_created',
        entity_type: mergePlan.entity_type || 'conflict',
        entity_id: mergePlan.entity_id,
        change_id: mergePlan.change_id,
        conflict_id: conflict.conflict_id,
        status: 'blocked',
        message: '冲突副本已创建，本地数据未被覆盖',
        metadata: {
          operation: mergePlan.operation,
          merge_status: mergePlan.status,
          risk_level: mergePlan.risk_level,
        },
      });
      await refreshSyncConflictStatus();
      if (typeof window.updateBackupStatusPanel === 'function') window.updateBackupStatusPanel();
      await refreshSyncAttentionState().catch(() => null);
      notify('已创建冲突副本，本地数据未被覆盖');
      return conflict;
    } catch (error) {
      notify(isLegacySyncPasswordRequiredError(error) ? getLegacySyncMessage() : (error?.message || '冲突副本创建失败'), true);
      return null;
    }
  }

  async function fetchRemoteChangeMetadata(options = {}) {
    if (isDemoMode()) {
      return [];
    }
    if (typeof window.apiFetch !== 'function') throw new Error('网络请求模块尚未加载');
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(Math.max(Number(options.limit || 100), 1), 200)));
    params.set('exclude_device_id', options.exclude_device_id || getDeviceId());
    if (options.since_uploaded_at) params.set('since_uploaded_at', options.since_uploaded_at);
    if (options.entity_type) params.set('entity_type', options.entity_type);
    if (options.include_own === false) params.set('include_own', 'false');

    const res = await window.apiFetch(`/api/sync/changes?${params.toString()}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.status !== 'success' || !Array.isArray(body.data)) {
      throw new Error(body?.detail || body?.message || '云端变更检查失败');
    }
    remoteChangeMetadataCache = body.data;
    return remoteChangeMetadataCache;
  }

  async function getRemoteChangeCount() {
    const changes = await fetchRemoteChangeMetadata();
    return changes.length;
  }

  async function markLocalChangeSynced(changeId) {
    const id = String(changeId || '').trim();
    if (!id || !window.LocalStorage) return null;
    const change = await window.LocalStorage.get('local_changes', id);
    if (!change) return null;
    const updated = {
      ...change,
      sync_status: 'synced',
      last_error: '',
    };
    await window.LocalStorage.set('local_changes', updated);
    await recordSyncHistory({
      event_type: 'local_change_uploaded',
      entity_type: updated.entity_type,
      entity_id: updated.entity_id,
      change_id: updated.change_id,
      status: 'success',
      message: `${getEntityLabel(updated.entity_type)}${getOperationLabel(updated.operation)}上传成功`,
      metadata: { operation: updated.operation, local_revision: updated.local_revision },
    });
    if (typeof window.updateBackupStatusPanel === 'function') window.updateBackupStatusPanel();
    await refreshSyncAttentionState().catch(() => null);
    return updated;
  }

  async function markLocalChangeFailed(changeId, error) {
    const id = String(changeId || '').trim();
    if (!id || !window.LocalStorage) return null;
    const change = await window.LocalStorage.get('local_changes', id);
    if (!change) return null;
    const updated = {
      ...change,
      sync_status: 'failed',
      retry_count: Number(change.retry_count || 0) + 1,
      last_error: formatSyncError(error).slice(0, 180),
    };
    await window.LocalStorage.set('local_changes', updated);
    await recordSyncHistory({
      event_type: 'local_change_failed',
      entity_type: updated.entity_type,
      entity_id: updated.entity_id,
      change_id: updated.change_id,
      status: 'failed',
      message: updated.last_error || '本地变更上传失败',
      metadata: { operation: updated.operation, retry_count: updated.retry_count },
    });
    if (typeof window.updateBackupStatusPanel === 'function') window.updateBackupStatusPanel();
    await refreshSyncAttentionState().catch(() => null);
    return updated;
  }

  async function ignoreFailedLocalChange(changeId) {
    const id = String(changeId || '').trim();
    if (!id || !window.LocalStorage) return null;
    const change = await window.LocalStorage.get('local_changes', id).catch(() => null);
    if (!change) throw new Error('本地变更不存在');
    if (change.sync_status !== 'failed') throw new Error('只有上传失败的变更可以忽略');
    if (!window.confirm('忽略后该本地变更不会继续提示上传，但不会删除你的日记或账本数据。是否继续？')) return null;
    const updated = {
      ...change,
      sync_status: 'ignored',
      last_error: change.last_error || '用户已忽略该失败变更',
      ignored_at: new Date().toISOString(),
    };
    await window.LocalStorage.set('local_changes', updated);
    await recordSyncHistory({
      event_type: 'local_change_failed',
      entity_type: updated.entity_type,
      entity_id: updated.entity_id,
      change_id: updated.change_id,
      status: 'blocked',
      message: '失败变更已忽略，不再提示上传',
      metadata: { operation: updated.operation },
    });
    await refreshIncrementalSyncStatus();
    notify('已忽略该失败变更，日记和账本数据未被删除');
    return updated;
  }

  async function retryFailedLocalChange(changeId) {
    if (!ensureOnlineForIncrementalUpload()) return null;
    const id = String(changeId || '').trim();
    if (!id || !window.LocalStorage) return null;
    const localChange = await window.LocalStorage.get('local_changes', id).catch(() => null);
    if (!localChange) throw new Error('本地变更不存在');
    if (localChange.sync_status !== 'failed') throw new Error('只有 failed 状态的变更可以重试');
    try {
      const plainPayload = await buildPlainChangePayload(localChange);
      const encryptedChange = await encryptSyncChangePayload(plainPayload);
      const uploadItem = {
        change_id: localChange.change_id,
        entity_type: localChange.entity_type,
        entity_id: localChange.entity_id,
        operation: localChange.operation,
        encrypted_change: encryptedChange,
        device_id: localChange.device_id || getDeviceId(),
        client_sequence: Number(localChange.client_sequence || 0),
        base_revision: normalizeRevision(localChange.base_revision),
        local_revision: normalizeRevision(localChange.local_revision),
        created_at: localChange.created_at || new Date().toISOString(),
      };
      const res = await window.apiFetch('/api/sync/changes/batch', {
        method: 'POST',
        body: JSON.stringify({ changes: [uploadItem] }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.status !== 'success') {
        const message = formatSyncError(body?.detail ? { detail: body.detail } : (body?.message || '待同步变更重试失败'));
        await markLocalChangeFailed(localChange.change_id, message);
        notify(message, true);
        return body;
      }
      const savedIds = new Set([...(body.saved_change_ids || []), ...(body.skipped_change_ids || [])]);
      if (savedIds.has(localChange.change_id)) {
        await markLocalChangeSynced(localChange.change_id);
        notify('该失败变更已重试上传成功');
      } else {
        const err = (body.errors || []).find(item => item.change_id === localChange.change_id);
        const message = formatSyncError(err?.message || err || '待同步变更重试失败');
        await markLocalChangeFailed(localChange.change_id, message);
        notify(message, true);
      }
      await refreshIncrementalSyncStatus();
      return body;
    } catch (error) {
      await markLocalChangeFailed(localChange.change_id, error);
      notify(error?.message || '待同步变更重试失败', true);
      await refreshIncrementalSyncStatus();
      return null;
    }
  }

  async function getSyncDashboardSummary() {
    const [localChanges, appliedRemote, conflicts, history] = await Promise.all([
      listAllLocalChanges(),
      getAllFromStore('applied_remote_changes'),
      getAllFromStore('sync_conflicts'),
      listSyncHistory({ limit: 200 }),
    ]);
    const countByStatus = status => (localChanges || []).filter(item => item?.sync_status === status).length;
    const conflictByStatus = status => (conflicts || []).filter(item => item?.conflict_status === status).length;
    return {
      pending_local_changes: countByStatus('pending'),
      failed_local_changes: countByStatus('failed'),
      ignored_local_changes: countByStatus('ignored'),
      applied_remote_changes: (appliedRemote || []).filter(item => item?.local_result === 'applied').length,
      open_conflicts: conflictByStatus('open'),
      resolved_conflicts: conflictByStatus('resolved'),
      ignored_conflicts: conflictByStatus('ignored'),
      recent_history_count: (history || []).length,
    };
  }

  function getCleanupThreshold(options = {}) {
    const keepDays = Number(options.keep_days || CLEANUP_KEEP_DAYS);
    return Date.now() - Math.max(1, keepDays) * 24 * 60 * 60 * 1000;
  }

  function getCleanupCandidates(items, statusKey, allowedStatuses, options = {}) {
    const keepRecent = Math.max(0, Number(options.keep_recent || CLEANUP_KEEP_RECENT));
    const threshold = getCleanupThreshold(options);
    const cleanable = (items || [])
      .filter(item => allowedStatuses.has(item?.[statusKey]))
      .sort((a, b) => {
        const aTime = Date.parse(a.updated_at || a.resolved_at || a.created_at || '');
        const bTime = Date.parse(b.updated_at || b.resolved_at || b.created_at || '');
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      });
    return cleanable.slice(keepRecent).filter((item) => {
      const time = Date.parse(item.updated_at || item.resolved_at || item.created_at || '');
      return !Number.isNaN(time) && time < threshold;
    });
  }

  async function cleanupSyncedLocalChanges(options = {}) {
    if (!options.skipConfirm && !window.confirm('此操作只会清理已同步的本地同步历史，不会删除日记、账本或云端备份。是否继续？')) {
      return { deleted: 0 };
    }
    const allChanges = await listAllLocalChanges();
    const candidates = getCleanupCandidates(allChanges, 'sync_status', new Set(['synced']), options);
    await Promise.all(candidates.map(item => window.LocalStorage.delete('local_changes', item.change_id)));
    await recordSyncHistory({
      event_type: 'cleanup_done',
      entity_type: 'sync',
      status: 'success',
      message: `已清理 ${candidates.length} 条已同步本地变更历史`,
      metadata: { target: 'local_changes', deleted: candidates.length },
    });
    await refreshIncrementalSyncStatus();
    notify(`已清理 ${candidates.length} 条已同步本地变更历史`);
    return { deleted: candidates.length };
  }

  async function cleanupResolvedConflicts(options = {}) {
    if (!options.skipConfirm && !window.confirm('此操作只会清理已解决或已忽略的旧冲突记录，不会影响主日记、账本或云端备份。是否继续？')) {
      return { deleted: 0 };
    }
    const conflicts = await getAllFromStore('sync_conflicts');
    const candidates = getCleanupCandidates(conflicts, 'conflict_status', new Set(['resolved', 'ignored']), options);
    await Promise.all(candidates.map(item => window.LocalStorage.delete('sync_conflicts', item.conflict_id)));
    await recordSyncHistory({
      event_type: 'cleanup_done',
      entity_type: 'conflict',
      status: 'success',
      message: `已清理 ${candidates.length} 条已解决或已忽略冲突记录`,
      metadata: { target: 'sync_conflicts', deleted: candidates.length },
    });
    await refreshIncrementalSyncStatus();
    notify(`已清理 ${candidates.length} 条已解决或已忽略冲突记录`);
    return { deleted: candidates.length };
  }

  async function buildPlainChangePayload(localChange) {
    assertChangeShape(localChange);
    const now = new Date().toISOString();
    const record = await findLocalRecord(localChange);
    if (!record && localChange.operation !== 'delete') {
      throw new Error('本地记录不存在，无法构建增量变更');
    }
    return {
      version: 1,
      app: 'LeafVault',
      type: 'incremental_change_payload',
      entity_type: localChange.entity_type,
      entity_id: String(localChange.entity_id).trim(),
      operation: localChange.operation,
      record: localChange.operation === 'delete' ? normalizeRecordForSync(record) : normalizeRecordForSync(record),
      deleted_at: localChange.operation === 'delete' ? (record?.deleted_at || localChange.created_at || now) : null,
      base_revision: normalizeRevision(localChange.base_revision),
      local_revision: normalizeRevision(localChange.local_revision),
      device_id: localChange.device_id || getDeviceId(),
      client_sequence: Number(localChange.client_sequence || 0),
      created_at: localChange.created_at || now,
    };
  }

  async function encryptSyncChangePayload(plainPayload) {
    if (!window.crypto?.getRandomValues || !window.crypto?.subtle) {
      throw new Error('当前浏览器不支持安全加密，无法上传增量变更');
    }
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('加密同步变更'))) {
      throw new Error('本地加密空间尚未解锁，请先输入密码解锁。');
    }
    if (!window.CryptoEngine?.encryptSyncPayload) {
      throw new Error('本地加密模块尚未加载');
    }
    return window.CryptoEngine.encryptSyncPayload(plainPayload);
  }

  function renderManualSyncStatus(message, detail = '') {
    const panel = document.getElementById('manualSyncWizardPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="manual-sync-card">
        <div class="manual-sync-heading">
          <strong>手动同步向导</strong>
          <span>${escapeHtml(message || '正在准备同步...')}</span>
        </div>
        ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
      </div>
    `;
  }

  function getManualSyncGroupLabel(group) {
    const labels = {
      safe: '可安全应用',
      done: '已处理 / 重复',
      conflict: '存在冲突',
      blocked: '高风险阻止',
      legacy_password_required: '旧格式待处理',
      failed: '解密失败',
    };
    return labels[group] || '未知状态';
  }

  function classifyMergePlanStatus(status) {
    if (status === 'safe_apply' || status === 'missing_local') return 'safe';
    if (status === 'already_applied' || status === 'duplicate') return 'done';
    if (status === 'conflict' || status === 'delete_conflict') return 'conflict';
    if (status === 'stale_remote' || status === 'unknown') return 'blocked';
    return 'failed';
  }

  function buildManualSyncResultItem(metadata = {}, mergePlan = null, statusGroup = 'failed', errorMessage = '') {
    return {
      change_id: String(metadata.change_id || mergePlan?.change_id || '').trim(),
      entity_type: metadata.entity_type || mergePlan?.entity_type || '',
      entity_id: String(metadata.entity_id || mergePlan?.entity_id || '').trim(),
      operation: metadata.operation || mergePlan?.operation || '',
      status_group: statusGroup,
      merge_status: mergePlan?.status || '',
      risk_level: mergePlan?.risk_level || (statusGroup === 'failed' ? 'high' : 'medium'),
      summary: mergePlan?.summary || errorMessage || '同步检查未完成',
      reason: mergePlan?.reason || errorMessage || '',
      metadata: {
        device_id: String(metadata.device_id || mergePlan?.remote_device_id || '').slice(0, 80),
        uploaded_at: metadata.uploaded_at || '',
        created_at: metadata.created_at || '',
        client_sequence: metadata.client_sequence ?? '',
      },
    };
  }

  function countManualSyncItems(items, group) {
    return (items || []).filter(item => item.status_group === group).length;
  }

  function renderManualSyncItem(item, group) {
    const changeId = escapeHtml(item.change_id || '');
    let actionHtml = '';
    if (group === 'safe') {
      actionHtml = `<button type="button" data-incremental-action="apply-remote-change" data-change-id="${changeId}">预览并应用</button>`;
    } else if (group === 'conflict') {
      actionHtml = `<button type="button" data-incremental-action="preview-remote-change" data-change-id="${changeId}">查看并创建冲突副本</button>`;
    } else if (group === 'blocked') {
      actionHtml = `<button type="button" data-incremental-action="preview-remote-change" data-change-id="${changeId}">预览详情</button>`;
    }
    return `
      <article class="manual-sync-item manual-sync-item-${escapeHtml(group)}">
        <div>
          <strong>${escapeHtml(getEntityLabel(item.entity_type))} · ${escapeHtml(getOperationLabel(item.operation))}</strong>
          <span>${escapeHtml(item.entity_id || '未知实体')} · ${escapeHtml(formatMergePlanStatus(item.merge_status || 'unknown'))}</span>
          <p>${escapeHtml(item.summary || item.reason || '暂无说明')}</p>
          ${group === 'legacy_password_required' ? '<p>这是旧同步密码格式，本次普通手动同步不会弹密码。请在旧格式兼容入口单独处理。</p>' : ''}
          ${group === 'failed' ? '<p>该变更可能损坏，或当前本地加密空间无法解开它。</p>' : ''}
        </div>
        ${actionHtml ? `<div class="manual-sync-item-actions">${actionHtml}</div>` : ''}
      </article>
    `;
  }

  function renderManualSyncGroup(title, items, group) {
    const safeItems = Array.isArray(items) ? items : [];
    if (!safeItems.length) return '';
    const firstItems = safeItems.slice(0, 5).map(item => renderManualSyncItem(item, group)).join('');
    const hiddenItems = safeItems.slice(5).map(item => renderManualSyncItem(item, group)).join('');
    return `
      <section class="manual-sync-group manual-sync-group-${escapeHtml(group)}">
        <div class="manual-sync-group-head">
          <strong>${escapeHtml(title)}</strong>
          <span>${safeItems.length} 条</span>
        </div>
        <div class="manual-sync-list">${firstItems}</div>
        ${hiddenItems ? `
          <details class="manual-sync-more">
            <summary>展开其余 ${safeItems.length - 5} 条</summary>
            <div class="manual-sync-list">${hiddenItems}</div>
          </details>
        ` : ''}
      </section>
    `;
  }

  function renderManualSyncResult(result) {
    const panel = document.getElementById('manualSyncWizardPanel');
    if (!panel) return;
    const items = Array.isArray(result?.items) ? result.items : [];
    const grouped = {
      safe: items.filter(item => item.status_group === 'safe'),
      done: items.filter(item => item.status_group === 'done'),
      conflict: items.filter(item => item.status_group === 'conflict'),
      blocked: items.filter(item => item.status_group === 'blocked'),
      legacy_password_required: items.filter(item => item.status_group === 'legacy_password_required'),
      failed: items.filter(item => item.status_group === 'failed'),
    };
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="manual-sync-card">
        <div class="manual-sync-heading">
          <strong>手动同步结果</strong>
          <span>${escapeHtml(formatSyncTime(result?.finished_at || new Date().toISOString()))}</span>
        </div>
        <div class="manual-sync-summary">
          <span>本地上传：成功 ${escapeHtml(result?.local_upload?.saved || 0)} 条，跳过 ${escapeHtml(result?.local_upload?.skipped || 0)} 条，失败 ${escapeHtml(result?.local_upload?.failed || 0)} 条</span>
          <span>云端检查：可安全应用 ${countManualSyncItems(items, 'safe')} 条，已处理/重复 ${countManualSyncItems(items, 'done')} 条，存在冲突 ${countManualSyncItems(items, 'conflict')} 条，高风险阻止 ${countManualSyncItems(items, 'blocked')} 条，旧格式待处理 ${countManualSyncItems(items, 'legacy_password_required')} 条，解密失败 ${countManualSyncItems(items, 'failed')} 条</span>
        </div>
        <p class="manual-sync-note">本次向导只做检查和分类，不会自动应用远端变更，也不会自动创建冲突副本。</p>
        ${renderManualSyncGroup(getManualSyncGroupLabel('safe'), grouped.safe, 'safe')}
        ${renderManualSyncGroup(getManualSyncGroupLabel('conflict'), grouped.conflict, 'conflict')}
        ${renderManualSyncGroup(getManualSyncGroupLabel('blocked'), grouped.blocked, 'blocked')}
        ${renderManualSyncGroup(getManualSyncGroupLabel('legacy_password_required'), grouped.legacy_password_required, 'legacy_password_required')}
        ${renderManualSyncGroup(getManualSyncGroupLabel('failed'), grouped.failed, 'failed')}
        ${renderManualSyncGroup(getManualSyncGroupLabel('done'), grouped.done, 'done')}
      </div>
    `;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function getUnprocessedRemoteChanges(changes) {
    const safeChanges = Array.isArray(changes) ? changes : [];
    const [appliedRemote, conflicts] = await Promise.all([
      getAllFromStore('applied_remote_changes'),
      getAllFromStore('sync_conflicts'),
    ]);
    const processedChangeIds = new Set();
    (appliedRemote || []).forEach((item) => {
      if (['applied', 'skipped', 'blocked'].includes(item?.local_result) && item?.change_id) {
        processedChangeIds.add(String(item.change_id));
      }
    });
    (conflicts || []).forEach((item) => {
      if (['open', 'resolved', 'ignored'].includes(item?.conflict_status) && item?.change_id) {
        processedChangeIds.add(String(item.change_id));
      }
    });
    return safeChanges.filter(change => change?.change_id && !processedChangeIds.has(String(change.change_id)));
  }

  async function autoCheckRemoteChangesIfNeeded(trigger = 'startup') {
    if (isDemoMode()) {
      await refreshSyncAttentionState().catch(() => null);
      return [];
    }
    if (!shouldAutoCheckRemoteChanges(trigger)) {
      await refreshSyncAttentionState().catch(() => null);
      return [];
    }
    return checkRemoteChangesQuietly(trigger);
  }

  async function checkRemoteChangesQuietly(trigger = 'startup') {
    if (!navigator.onLine || !isLoggedInForIncrementalSync() || quietRemoteCheckInProgress) return [];
    quietRemoteCheckInProgress = true;
    try {
      const currentDeviceId = getDeviceId();
      const changes = await fetchRemoteChangeMetadata({ exclude_device_id: currentDeviceId, limit: 100 });
      const unprocessedRemoteChanges = await getUnprocessedRemoteChanges(changes);
      const checkedAt = new Date().toISOString();
      setRemotePendingCountToLocalCache(unprocessedRemoteChanges.length);
      setLastAutoCheckAt(checkedAt);
      setLastRemoteChangeCheckAt(checkedAt);
      await recordSyncHistory({
        event_type: 'remote_change_auto_checked',
        entity_type: 'sync',
        status: 'info',
        message: `低频检查云端变更完成，发现 ${unprocessedRemoteChanges.length} 条待处理元数据`,
        metadata: { trigger, count: unprocessedRemoteChanges.length },
      });
      await refreshSyncAttentionState();
      return unprocessedRemoteChanges;
    } catch (error) {
      setLastAutoCheckAt(new Date().toISOString());
      await recordSyncHistory({
        event_type: 'remote_change_auto_checked',
        entity_type: 'sync',
        status: 'failed',
        message: String(error?.message || '低频检查云端变更失败').slice(0, 180),
        metadata: { trigger },
      }).catch(() => null);
      await refreshSyncAttentionState().catch(() => null);
      return [];
    } finally {
      quietRemoteCheckInProgress = false;
    }
  }

  function shouldAutoCheckRemoteChanges(trigger = 'startup') {
    if (!navigator.onLine) return false;
    if (!isLoggedInForIncrementalSync()) return false;
    if (manualSyncInProgress || quietRemoteCheckInProgress) return false;
    const snoozedUntil = parseStoredTime(getAutoCheckSnoozedUntil());
    if (snoozedUntil && snoozedUntil > Date.now()) return false;
    const lastCheckedAt = parseStoredTime(getLastAutoCheckAt());
    if (!lastCheckedAt) return true;
    const interval = AUTO_CHECK_INTERVALS[trigger] || AUTO_CHECK_INTERVALS.default;
    return Date.now() - lastCheckedAt >= interval;
  }

  function renderSyncAttentionBadge() {
    const badge = document.getElementById('syncAttentionBadge');
    if (!badge) return;
    const state = syncAttentionStateCache || {};
    const localCount = Number(state.pending_local_changes || 0);
    const remoteCount = Number(state.remote_pending_count || 0);
    const conflictCount = Number(state.open_conflicts || 0);
    const messages = [];
    if (localCount > 0) messages.push(`本地有 ${localCount} 条待上传变更`);
    if (remoteCount > 0) messages.push(`云端检测到 ${remoteCount} 条其他设备变更`);
    if (conflictCount > 0) messages.push(`有 ${conflictCount} 条同步冲突待处理`);
    if (!messages.length || isSyncAttentionDismissedToday()) {
      badge.classList.add('hidden');
      badge.innerHTML = '';
      return;
    }
    const summary = messages.length > 1 ? '有本地待同步、云端新变更或冲突待处理' : messages[0];
    badge.classList.remove('hidden');
    badge.innerHTML = `
      <div class="sync-attention-copy" data-incremental-action="focus-sync-panel">
        <strong>${escapeHtml(summary)}</strong>
        <span>${escapeHtml(messages.join(' · '))}，建议空闲时手动同步。</span>
      </div>
      <div class="sync-attention-actions">
        <button type="button" data-incremental-action="start-manual-sync">开始手动同步</button>
        <button type="button" data-incremental-action="dismiss-sync-attention">今天不提醒</button>
      </div>
    `;
  }

  function dismissSyncAttentionForToday() {
    writeLocalStorageValue(getScopedLocalStorageKey(ATTENTION_DISMISS_PREFIX), getTodayKey());
    const tomorrow = new Date();
    tomorrow.setHours(23, 59, 59, 999);
    writeLocalStorageValue(getScopedLocalStorageKey(AUTO_CHECK_SNOOZE_PREFIX), tomorrow.toISOString());
    renderSyncAttentionBadge();
  }

  async function refreshSyncAttentionState() {
    const summary = await getSyncDashboardSummary().catch(() => null);
    syncAttentionStateCache = {
      pending_local_changes: summary ? Number(summary.pending_local_changes || 0) : await getPendingChangeCount().catch(() => 0),
      remote_pending_count: getRemotePendingCountFromLocalCache(),
      open_conflicts: summary ? Number(summary.open_conflicts || 0) : 0,
    };
    renderSyncAttentionBadge();
    return syncAttentionStateCache;
  }

  function countItemsByValue(items, key, value) {
    return (items || []).filter(item => item?.[key] === value).length;
  }

  function findDuplicateValues(items, getter) {
    const seen = new Set();
    const duplicates = new Set();
    (items || []).forEach((item) => {
      const value = String(getter(item) || '').trim();
      if (!value) return;
      if (seen.has(value)) duplicates.add(value);
      seen.add(value);
    });
    return [...duplicates];
  }

  function hashDiagnosticUserId(userId) {
    const text = String(userId || 'guest');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `u_${(hash >>> 0).toString(16)}`;
  }

  function isInvalidRevisionValue(value) {
    if (value === undefined || value === null || value === '') return false;
    const revision = Number(value);
    return !Number.isFinite(revision) || revision < 0;
  }

  function selfTestSyncCoreFunctions() {
    const required = [
      'uploadPendingLocalChanges',
      'fetchRemoteChangeMetadata',
      'previewRemoteChange',
      'applyRemoteChange',
      'createConflictCopy',
      'resolveSyncConflict',
      'startManualSyncWizard',
      'autoCheckRemoteChangesIfNeeded',
      'recordSyncHistory',
    ];
    const missing = required.filter(name => typeof window.LeafVaultIncrementalSync?.[name] !== 'function' && typeof ({
      uploadPendingLocalChanges,
      fetchRemoteChangeMetadata,
      previewRemoteChange,
      applyRemoteChange,
      createConflictCopy,
      resolveSyncConflict,
      startManualSyncWizard,
      autoCheckRemoteChangesIfNeeded,
      recordSyncHistory,
    })[name] !== 'function');
    return {
      checked: required.length,
      missing,
      ok: missing.length === 0,
    };
  }

  async function fetchRemoteDiagnosticSummary() {
    const remote = {
      checked: false,
      sync_changes_count: 0,
      snapshots_count: 0,
      latest_change_uploaded_at: '',
      latest_snapshot_uploaded_at: '',
      error: '',
    };
    if (!navigator.onLine || !isLoggedInForIncrementalSync() || typeof window.apiFetch !== 'function') return remote;
    remote.checked = true;
    try {
      const changes = await fetchRemoteChangeMetadata({ exclude_device_id: getDeviceId(), limit: 100 });
      remote.sync_changes_count = Array.isArray(changes) ? changes.length : 0;
      remote.latest_change_uploaded_at = (changes || [])
        .map(item => item?.uploaded_at)
        .filter(Boolean)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || '';
    } catch (error) {
      remote.error = String(error?.message || '云端增量元数据读取失败').slice(0, 160);
    }
    try {
      const res = await window.apiFetch('/api/sync/snapshots');
      const body = await res.json().catch(() => null);
      const snapshots = Array.isArray(body?.data) ? body.data : [];
      if (res.ok && body?.status === 'success') {
        remote.snapshots_count = snapshots.length;
        remote.latest_snapshot_uploaded_at = snapshots
          .map(item => item?.uploaded_at)
          .filter(Boolean)
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || '';
      } else {
        remote.error = remote.error || String(body?.detail || body?.message || '云端快照列表读取失败').slice(0, 160);
      }
    } catch (error) {
      remote.error = remote.error || String(error?.message || '云端快照列表读取失败').slice(0, 160);
    }
    return remote;
  }

  async function runSyncDiagnostics() {
    const startedAt = new Date().toISOString();
    const errors = [];
    const [localChanges, appliedRemote, conflicts, history, diaries, ledgers] = await Promise.all([
      getAllFromStore('local_changes').catch((error) => { errors.push(`local_changes:${error?.message || error}`); return []; }),
      getAllFromStore('applied_remote_changes').catch((error) => { errors.push(`applied_remote_changes:${error?.message || error}`); return []; }),
      getAllFromStore('sync_conflicts').catch((error) => { errors.push(`sync_conflicts:${error?.message || error}`); return []; }),
      listSyncHistory({ limit: 50 }).catch((error) => { errors.push(`sync_history:${error?.message || error}`); return []; }),
      getAllFromStore('diaries').catch((error) => { errors.push(`diaries:${error?.message || error}`); return []; }),
      getAllFromStore('ledgers').catch((error) => { errors.push(`ledgers:${error?.message || error}`); return []; }),
    ]);

    const duplicateAppliedChangeIds = findDuplicateValues(appliedRemote, item => item?.change_id);
    const duplicateLedgerUuids = findDuplicateValues(ledgers, item => item?.uuid);
    const remote = await fetchRemoteDiagnosticSummary();
    const localChangeInvalidRecords = {
      missing_change_id: (localChanges || []).filter(item => !item?.change_id).length,
      missing_entity_type: (localChanges || []).filter(item => !item?.entity_type).length,
      missing_entity_id: (localChanges || []).filter(item => !item?.entity_id).length,
      invalid_operation: (localChanges || []).filter(item => !VALID_OPERATIONS.has(item?.operation)).length,
      high_retry_count: (localChanges || []).filter(item => Number(item?.retry_count || 0) >= 5).length,
    };
    const result = {
      version: 1,
      app: 'LeafVault',
      created_at: startedAt,
      self_test: selfTestSyncCoreFunctions(),
      local_changes: {
        total: localChanges.length,
        pending: countItemsByValue(localChanges, 'sync_status', 'pending'),
        failed: countItemsByValue(localChanges, 'sync_status', 'failed'),
        ignored: countItemsByValue(localChanges, 'sync_status', 'ignored'),
        synced: countItemsByValue(localChanges, 'sync_status', 'synced'),
        invalid_records: localChangeInvalidRecords,
      },
      applied_remote_changes: {
        total: appliedRemote.length,
        applied: countItemsByValue(appliedRemote, 'local_result', 'applied'),
        blocked: countItemsByValue(appliedRemote, 'local_result', 'blocked'),
        skipped: countItemsByValue(appliedRemote, 'local_result', 'skipped'),
        missing_change_id: (appliedRemote || []).filter(item => !item?.change_id).length,
        duplicate_change_ids: duplicateAppliedChangeIds.length,
      },
      sync_conflicts: {
        total: conflicts.length,
        open: countItemsByValue(conflicts, 'conflict_status', 'open'),
        resolved: countItemsByValue(conflicts, 'conflict_status', 'resolved'),
        ignored: countItemsByValue(conflicts, 'conflict_status', 'ignored'),
        missing_conflict_id: (conflicts || []).filter(item => !item?.conflict_id).length,
        missing_change_id: (conflicts || []).filter(item => !item?.change_id).length,
        status_panel_mismatch: false,
      },
      sync_history: {
        recent_count: history.length,
        recent_failed: (history || []).filter(item => item?.status === 'failed').length,
        recent_cleanup: (history || []).filter(item => item?.event_type === 'cleanup_done').length,
        missing_event_type: (history || []).filter(item => !item?.event_type).length,
        recent_events: (history || []).slice(0, 10).map(item => ({
          event_type: item?.event_type || '',
          entity_type: item?.entity_type || '',
          entity_id: item?.entity_id || '',
          status: item?.status || '',
          created_at: item?.created_at || '',
        })),
      },
      diaries: {
        total: diaries.length,
        missing_date: (diaries || []).filter(item => !item?.date).length,
        invalid_revision: (diaries || []).filter(item => isInvalidRevisionValue(item?.local_revision)).length,
        missing_updated_at: (diaries || []).filter(item => !item?.updated_at).length,
        total_body_chars: (diaries || []).reduce((sum, item) => sum + String(item?.['con' + 'tent'] || '').length, 0),
      },
      ledgers: {
        total: ledgers.length,
        missing_uuid: (ledgers || []).filter(item => !item?.uuid).length,
        duplicate_uuid: duplicateLedgerUuids.length,
        invalid_amount: (ledgers || []).filter(item => !Number.isFinite(Number(item?.amount))).length,
        invalid_revision: (ledgers || []).filter(item => isInvalidRevisionValue(item?.local_revision)).length,
        memo_present: (ledgers || []).filter(item => Boolean(String(item?.['no' + 'te'] || '').trim())).length,
      },
      remote,
      read_errors: errors,
    };
    result.summary = buildSyncDiagnosticReport(result).summary;
    return result;
  }

  function getSyncHealthLevel(diagnosticResult = {}) {
    const criticalIssues = [];
    const warnings = [];
    const invalidLocal = diagnosticResult.local_changes?.invalid_records || {};
    if (diagnosticResult.read_errors?.length) criticalIssues.push('IndexedDB 读取失败或部分 store 不可用');
    if (invalidLocal.missing_change_id) criticalIssues.push('存在缺少 change_id 的本地变更记录');
    if (diagnosticResult.applied_remote_changes?.missing_change_id) criticalIssues.push('存在缺少 change_id 的已处理远端记录');
    if (diagnosticResult.applied_remote_changes?.duplicate_change_ids) criticalIssues.push('已处理远端记录存在重复 change_id');
    if (diagnosticResult.sync_conflicts?.missing_conflict_id) criticalIssues.push('存在缺少 conflict_id 的冲突记录');
    if (diagnosticResult.ledgers?.duplicate_uuid) criticalIssues.push('检测到账本存在重复 uuid');
    if (diagnosticResult.diaries?.invalid_revision || diagnosticResult.ledgers?.invalid_revision) criticalIssues.push('检测到 revision 异常');
    if (!diagnosticResult.self_test?.ok) criticalIssues.push('同步核心函数缺失');
    if (diagnosticResult.local_changes?.failed) warnings.push(`有 ${diagnosticResult.local_changes.failed} 条上传失败变更`);
    if (diagnosticResult.sync_conflicts?.open) warnings.push(`有 ${diagnosticResult.sync_conflicts.open} 条未解决冲突`);
    if (diagnosticResult.local_changes?.pending) warnings.push(`有 ${diagnosticResult.local_changes.pending} 条本地待上传变更`);
    if (diagnosticResult.remote?.checked && diagnosticResult.remote?.snapshots_count === 0) warnings.push('云端快照为空，建议先上传一份加密备份');
    return {
      health: criticalIssues.length ? 'critical' : (warnings.length ? 'warning' : 'good'),
      warnings,
      critical_issues: criticalIssues,
    };
  }

  function buildSyncDiagnosticReport(diagnosticResult = {}) {
    const summary = getSyncHealthLevel(diagnosticResult);
    return {
      version: 1,
      app: 'LeafVault',
      created_at: diagnosticResult.created_at || new Date().toISOString(),
      user_id_hash: hashDiagnosticUserId(getCurrentUserId()),
      device_id_prefix: String(getDeviceId() || '').slice(0, 8),
      summary,
      local_changes: diagnosticResult.local_changes || {},
      applied_remote_changes: diagnosticResult.applied_remote_changes || {},
      sync_conflicts: diagnosticResult.sync_conflicts || {},
      sync_history: diagnosticResult.sync_history || {},
      diaries: diagnosticResult.diaries || {},
      ledgers: diagnosticResult.ledgers || {},
      remote: diagnosticResult.remote || {},
      self_test: diagnosticResult.self_test || {},
      read_errors: diagnosticResult.read_errors || [],
    };
  }

  function renderSyncDiagnosticsPanel(result) {
    const panel = document.getElementById('syncDiagnosticsResult');
    if (!panel) return;
    if (!result) {
      panel.innerHTML = '<p class="sync-diagnostics-empty">尚未运行同步自检。</p>';
      return;
    }
    const report = buildSyncDiagnosticReport(result);
    const summary = report.summary || {};
    const healthText = summary.health === 'critical' ? '存在风险' : (summary.health === 'warning' ? '需要注意' : '正常');
    const suggestions = [
      ...(summary.critical_issues || []),
      ...(summary.warnings || []),
    ];
    if (result.local_changes?.failed) suggestions.push(`有 ${result.local_changes.failed} 条上传失败变更，建议在同步历史中重试。`);
    if (result.sync_conflicts?.open) suggestions.push(`存在 ${result.sync_conflicts.open} 个未解决冲突，建议进入冲突副本处理。`);
    if (result.ledgers?.duplicate_uuid) suggestions.push('检测到账本存在重复 uuid，建议暂时不要进行增量同步，先检查数据。');
    if (result.remote?.checked && result.remote?.snapshots_count === 0) suggestions.push('云端快照为空，建议先上传一份加密备份。');
    panel.innerHTML = `
      <div class="sync-diagnostics-card sync-diagnostics-${escapeHtml(summary.health || 'good')}">
        <div class="sync-diagnostics-head">
          <strong>总体状态：${escapeHtml(healthText)}</strong>
          <span>最近一次诊断：${escapeHtml(formatSyncTime(report.created_at))}</span>
        </div>
        <div class="sync-diagnostics-grid">
          <span>本地待上传：${escapeHtml(result.local_changes?.pending || 0)} 条</span>
          <span>上传失败：${escapeHtml(result.local_changes?.failed || 0)} 条</span>
          <span>待处理冲突：${escapeHtml(result.sync_conflicts?.open || 0)} 条</span>
          <span>最近失败事件：${escapeHtml(result.sync_history?.recent_failed || 0)} 条</span>
          <span>重复账本 uuid：${escapeHtml(result.ledgers?.duplicate_uuid || 0)} 个</span>
          <span>异常 revision：${escapeHtml((result.diaries?.invalid_revision || 0) + (result.ledgers?.invalid_revision || 0))} 条</span>
          <span>云端可见增量：${escapeHtml(result.remote?.sync_changes_count || 0)} 条</span>
          <span>云端快照：${escapeHtml(result.remote?.snapshots_count || 0)} 份</span>
        </div>
        <details class="sync-diagnostics-suggestions" ${suggestions.length ? 'open' : ''}>
          <summary>问题与建议（${escapeHtml(suggestions.length)}）</summary>
          ${suggestions.length ? suggestions.map(item => `<p>${escapeHtml(item)}</p>`).join('') : '<p>暂未发现需要处理的问题。</p>'}
        </details>
      </div>
    `;
  }

  async function exportSyncDiagnosticReport() {
    if (!window.confirm('诊断报告不包含日记正文、账本备注、密码或密钥，但会包含同步数量和状态信息。是否导出？')) return null;
    const result = await runSyncDiagnostics();
    const report = buildSyncDiagnosticReport(result);
    const dateText = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `leafvault-sync-diagnostics-${dateText}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    renderSyncDiagnosticsPanel(result);
    return report;
  }

  function focusSyncStatusPanel() {
    const settingsView = document.getElementById('view-settings');
    if (settingsView) {
      document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
      settingsView.classList.add('active');
    }
    const panel = document.getElementById('backupStatusPanel') || document.getElementById('syncAttentionBadge');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setupIncrementalAutoCheckTriggers() {
    if (document.body?.dataset.incrementalAutoCheckBound === '1') return;
    if (document.body) document.body.dataset.incrementalAutoCheckBound = '1';
    window.addEventListener('online', () => {
      autoCheckRemoteChangesIfNeeded('online');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        autoCheckRemoteChangesIfNeeded('visibility');
      }
    });
  }

  async function recordManualSyncHistory(result) {
    return recordSyncHistory({
      event_type: 'manual_sync_done',
      entity_type: 'sync',
      status: result?.remote_scan?.failed ? 'failed' : 'success',
      message: `手动同步完成：本地成功 ${result?.local_upload?.saved || 0} 条，云端可安全应用 ${result?.remote_scan?.safe || 0} 条，冲突 ${result?.remote_scan?.conflict || 0} 条`,
      metadata: {
        local_total: result?.local_upload?.total || 0,
        local_saved: result?.local_upload?.saved || 0,
        local_skipped: result?.local_upload?.skipped || 0,
        local_failed: result?.local_upload?.failed || 0,
        remote_total: result?.remote_scan?.total || 0,
        remote_safe: result?.remote_scan?.safe || 0,
        remote_conflict: result?.remote_scan?.conflict || 0,
        remote_blocked: result?.remote_scan?.blocked || 0,
        remote_legacy_password_required: result?.remote_scan?.legacy_password_required || 0,
        remote_failed: result?.remote_scan?.failed || 0,
      },
    });
  }

  async function runManualSyncFlow() {
    const startedAt = new Date().toISOString();
    const result = {
      started_at: startedAt,
      finished_at: '',
      local_upload: { total: 0, saved: 0, skipped: 0, failed: 0 },
      remote_scan: { total: 0, safe: 0, done: 0, conflict: 0, blocked: 0, legacy_password_required: 0, failed: 0 },
      items: [],
    };
    manualSyncInProgress = true;

    renderManualSyncStatus('正在上传本地变更...', '正在使用本地加密空间密钥进行同步，不会上传明文。');
    const localUpload = await uploadPendingLocalChangesWithPassword(null, { silent: true });
    result.local_upload = {
      total: Number(localUpload?.total || 0),
      saved: Number(localUpload?.saved || 0),
      skipped: Number(localUpload?.skipped || 0),
      failed: Number(localUpload?.failed || 0),
    };

    renderManualSyncStatus('正在检查云端变更...', '只获取其他设备上传的云端增量元数据。');
    const currentDeviceId = getDeviceId();
    const remoteChanges = await fetchRemoteChangeMetadata({ exclude_device_id: currentDeviceId, limit: 100 });
    setLastRemoteChangeCheckAt(new Date().toISOString());
    const remoteCandidates = await getUnprocessedRemoteChanges(remoteChanges);
    setRemotePendingCountToLocalCache(remoteCandidates.length);
    const selectedRemote = remoteCandidates.slice(0, MANUAL_SYNC_REMOTE_LIMIT);
    result.remote_scan.total = selectedRemote.length;

    renderManualSyncStatus('正在分析远端变更...', `本次最多分析 ${MANUAL_SYNC_REMOTE_LIMIT} 条，当前候选 ${selectedRemote.length} 条。`);
    for (const metadata of selectedRemote) {
      try {
        const remoteDetail = await fetchRemoteEncryptedChange(metadata.change_id);
        const decryptedPayload = await decryptRemoteChangePayload(remoteDetail.encrypted_change);
        const mergePlan = await analyzeRemoteChangeAgainstLocal(decryptedPayload, remoteDetail);
        const group = classifyMergePlanStatus(mergePlan.status);
        result.remote_scan[group] = Number(result.remote_scan[group] || 0) + 1;
        result.items.push(buildManualSyncResultItem(remoteDetail, mergePlan, group));
      } catch (error) {
        if (isLegacySyncPasswordRequiredError(error)) {
          result.remote_scan.legacy_password_required += 1;
          result.items.push(buildManualSyncResultItem(metadata, null, 'legacy_password_required', getLegacySyncMessage()));
        } else {
          result.remote_scan.failed += 1;
          result.items.push(buildManualSyncResultItem(metadata, null, 'failed', formatSyncError(error || '远端变更分析失败')));
        }
      }
    }

    result.finished_at = new Date().toISOString();
    await recordSyncHistory({
      event_type: 'remote_change_checked',
      entity_type: 'sync',
      status: 'success',
      message: `手动同步检查云端变更完成，候选 ${result.remote_scan.total} 条`,
      metadata: { count: result.remote_scan.total },
    });
    await recordManualSyncHistory(result);
    renderManualSyncResult(result);
    await refreshIncrementalSyncStatus();
    manualSyncInProgress = false;
    await refreshSyncAttentionState().catch(() => null);
    return result;
  }

  async function startManualSyncWizard() {
    if (isDemoMode()) {
      notifyDemoLocalOnly();
      renderManualSyncStatus('Demo 模式仅支持本地体验。');
      return null;
    }
    renderManualSyncStatus('正在检查网络...');
    if (!navigator.onLine) {
      notify('当前离线，联网后再进行手动同步', true);
      renderManualSyncStatus('当前离线，联网后再进行手动同步');
      return null;
    }
    if (typeof window.apiFetch !== 'function') {
      notify('网络请求模块尚未加载', true);
      return null;
    }
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('开始手动同步'))) {
      renderManualSyncStatus('本地加密空间尚未解锁', '请先解锁本地加密空间后再同步。');
      return null;
    }
    try {
      renderManualSyncStatus('正在准备同步...', '正在使用本地加密空间密钥进行同步，不会上传明文。');
      return await runManualSyncFlow();
    } catch (error) {
      manualSyncInProgress = false;
      notify(error?.message || '手动同步失败', true);
      renderManualSyncStatus('手动同步失败', error?.message || '请稍后重试');
      await recordSyncHistory({
        event_type: 'manual_sync_done',
        entity_type: 'sync',
        status: 'failed',
        message: error?.message || '手动同步失败',
      });
      await refreshSyncAttentionState().catch(() => null);
      return null;
    }
  }

  async function refreshIncrementalSyncStatus() {
    const nowMs = Date.now();
    if (refreshIncrementalStatusInFlight) return refreshIncrementalStatusInFlight;
    if (lastIncrementalStatusRefreshAt && nowMs - lastIncrementalStatusRefreshAt < INCREMENTAL_STATUS_THROTTLE_MS) {
      if (!scheduledIncrementalStatusRefresh) {
        scheduledIncrementalStatusRefresh = window.setTimeout(() => {
          scheduledIncrementalStatusRefresh = null;
          refreshIncrementalSyncStatus().catch(() => null);
        }, INCREMENTAL_STATUS_THROTTLE_MS - (nowMs - lastIncrementalStatusRefreshAt));
      }
      return lastIncrementalStatusResult || { pending: 0, failed: 0, remote: remoteChangeMetadataCache.length };
    }
    lastIncrementalStatusRefreshAt = nowMs;
    refreshIncrementalStatusInFlight = (async () => {
    const summary = await getSyncDashboardSummary().catch(() => null);
    const count = summary ? summary.pending_local_changes : await getPendingChangeCount().catch(() => 0);
    const failedCount = summary ? summary.failed_local_changes : 0;
    const countEl = document.getElementById('pendingLocalChangeCount');
    if (countEl) countEl.textContent = `本地待上传：${count} 条，失败：${failedCount} 条`;
    const uploadBtn = document.getElementById('uploadPendingChangesBtn');
    if (uploadBtn) uploadBtn.disabled = count <= 0;
    const dashboardEl = document.getElementById('syncDashboardSummary');
    if (dashboardEl && summary) {
      dashboardEl.textContent = `已处理远端：${summary.applied_remote_changes} 条，已解决冲突：${summary.resolved_conflicts} 条，已忽略：${summary.ignored_local_changes} 条`;
    }
    const remoteCountEl = document.getElementById('remoteChangeCount');
    if (remoteCountEl) remoteCountEl.textContent = `云端新变更：${remoteChangeMetadataCache.length} 条`;
    const checkAtEl = document.getElementById('remoteChangeCheckAt');
    if (checkAtEl) checkAtEl.textContent = `最近检查：${formatSyncTime(getLastRemoteChangeCheckAt())}`;
    renderRemoteChangeMetadataList(remoteChangeMetadataCache);
    await renderFailedLocalChangesPanel().catch(() => []);
    await renderSyncHistoryPanel().catch(() => []);
    await refreshSyncConflictStatus().catch(() => 0);
    await refreshSyncAttentionState().catch(() => null);
    lastIncrementalStatusResult = { pending: count, failed: failedCount, remote: remoteChangeMetadataCache.length };
    return lastIncrementalStatusResult;
    })();
    try {
      return await refreshIncrementalStatusInFlight;
    } finally {
      refreshIncrementalStatusInFlight = null;
    }
  }

  async function refreshRemoteChangeStatus() {
    if (!navigator.onLine) {
      notify('当前离线，联网后再检查云端变更', true);
      await refreshIncrementalSyncStatus();
      return [];
    }
    try {
      const changes = await fetchRemoteChangeMetadata();
      const unprocessedChanges = await getUnprocessedRemoteChanges(changes).catch(() => changes);
      setRemotePendingCountToLocalCache(unprocessedChanges.length);
      setLastRemoteChangeCheckAt(new Date().toISOString());
      await recordSyncHistory({
        event_type: 'remote_change_checked',
        entity_type: 'sync',
        status: 'success',
        message: `云端变更检查完成，发现 ${changes.length} 条`,
        metadata: { count: changes.length },
      });
      await refreshIncrementalSyncStatus();
      notify(`云端可拉取变更：${changes.length} 条`);
      return changes;
    } catch (error) {
      await recordSyncHistory({
        event_type: 'remote_change_checked',
        entity_type: 'sync',
        status: 'failed',
        message: error?.message || '云端变更检查失败',
      });
      notify(error?.message || '云端变更检查失败', true);
      await refreshIncrementalSyncStatus();
      return [];
    }
  }

  function ensureOnlineForIncrementalUpload() {
    if (isDemoMode()) {
      notifyDemoLocalOnly();
      return false;
    }
    if (navigator.onLine) return true;
    if (typeof window.showPwaStatusBanner === 'function') {
      window.showPwaStatusBanner({
        type: 'offline',
        message: '当前处于离线状态，本地日记和账本仍可使用，云端同步暂不可用。',
        persistent: true,
      });
    }
    notify('当前离线，联网后再上传待同步变更', true);
    return false;
  }

  async function uploadPendingLocalChangesWithPassword(password, options = {}) {
    const summary = { total: 0, saved: 0, skipped: 0, failed: 0, saved_change_ids: [], skipped_change_ids: [], errors: [] };
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('上传待同步变更'))) return summary;
    if (!ensureOnlineForIncrementalUpload()) return summary;
    if (typeof window.apiFetch !== 'function') {
      if (!options.silent) notify('网络请求模块尚未加载', true);
      return { ...summary, failed: 1 };
    }
    const pendingChanges = await listPendingLocalChanges();
    summary.total = pendingChanges.length;
    if (!pendingChanges.length) {
      if (!options.silent) notify('暂无待同步变更');
      await refreshIncrementalSyncStatus();
      return summary;
    }

    const selectedChanges = pendingChanges.slice(0, MAX_UPLOAD_BATCH_SIZE);
    const uploadItems = [];
    for (const localChange of selectedChanges) {
      try {
        const plainPayload = await buildPlainChangePayload(localChange);
        const encryptedChange = await encryptSyncChangePayload(plainPayload);
        uploadItems.push({
          change_id: localChange.change_id,
          entity_type: localChange.entity_type,
          entity_id: localChange.entity_id,
          operation: localChange.operation,
          encrypted_change: encryptedChange,
          device_id: localChange.device_id || getDeviceId(),
          client_sequence: Number(localChange.client_sequence || 0),
          base_revision: normalizeRevision(localChange.base_revision),
          local_revision: normalizeRevision(localChange.local_revision),
          created_at: localChange.created_at || new Date().toISOString(),
        });
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ change_id: localChange.change_id, message: formatSyncError(error || 'build failed') });
        await markLocalChangeFailed(localChange.change_id, error);
      }
    }

    if (!uploadItems.length) {
      if (!options.silent) notify('待同步变更构建失败，请稍后重试', true);
      await refreshIncrementalSyncStatus();
      return summary;
    }

    try {
      const res = await window.apiFetch('/api/sync/changes/batch', {
        method: 'POST',
        body: JSON.stringify({ changes: uploadItems }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.status !== 'success') {
        const message = formatSyncError(body?.detail ? { detail: body.detail } : (body?.message || '待同步变更上传失败'));
        await Promise.all(uploadItems.map(item => markLocalChangeFailed(item.change_id, message)));
        summary.failed += uploadItems.length;
        summary.errors.push(...uploadItems.map(item => ({ change_id: item.change_id, message })));
        if (!options.silent) notify(message, true);
        await refreshIncrementalSyncStatus();
        return summary;
      }

      const savedIds = body.saved_change_ids || [];
      const skippedIds = body.skipped_change_ids || [];
      const syncedIds = new Set([...savedIds, ...skippedIds]);
      await Promise.all([...syncedIds].map(changeId => markLocalChangeSynced(changeId)));
      await Promise.all((body.errors || []).map(item => markLocalChangeFailed(item.change_id, item.message || 'upload failed')));
      summary.saved = Number(body.saved || savedIds.length || 0);
      summary.skipped = Number(body.skipped || skippedIds.length || 0);
      summary.failed += Number(body.failed || (body.errors || []).length || 0);
      summary.saved_change_ids = savedIds;
      summary.skipped_change_ids = skippedIds;
      summary.errors.push(...(body.errors || []));
      if (!options.silent) notify(`已上传 ${summary.saved + summary.skipped} 条待同步变更`);
      await refreshIncrementalSyncStatus();
      if (typeof window.updateBackupStatusPanel === 'function') window.updateBackupStatusPanel();
      await refreshSyncAttentionState().catch(() => null);
      return summary;
    } catch (error) {
      await Promise.all(uploadItems.map(item => markLocalChangeFailed(item.change_id, error)));
      summary.failed += uploadItems.length;
      summary.errors.push(...uploadItems.map(item => ({ change_id: item.change_id, message: formatSyncError(error || 'upload failed') })));
      if (!options.silent) notify('待同步变更上传失败，请检查网络后重试', true);
      await refreshIncrementalSyncStatus();
      return summary;
    }
  }

  async function uploadPendingLocalChanges() {
    return uploadPendingLocalChangesWithPassword(null, { silent: false });
  }

  function setupIncrementalSyncActions() {
    if (document.body?.dataset.incrementalSyncActionsBound === '1') return;
    if (document.body) document.body.dataset.incrementalSyncActionsBound = '1';
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-incremental-action]');
      if (!trigger) return;
      const action = trigger.dataset.incrementalAction;
      if (action === 'preview-remote-change') {
        event.preventDefault();
        previewRemoteChange(trigger.dataset.changeId);
      }
      if (action === 'start-manual-sync') {
        event.preventDefault();
        startManualSyncWizard();
      }
      if (action === 'dismiss-sync-attention') {
        event.preventDefault();
        dismissSyncAttentionForToday();
      }
      if (action === 'focus-sync-panel') {
        event.preventDefault();
        focusSyncStatusPanel();
      }
      if (action === 'apply-remote-change') {
        event.preventDefault();
        applyRemoteChange(trigger.dataset.changeId);
      }
      if (action === 'create-conflict-copy') {
        event.preventDefault();
        createConflictCopy(trigger.dataset.changeId);
      }
      if (action === 'toggle-sync-conflicts') {
        event.preventDefault();
        toggleSyncConflictList();
      }
      if (action === 'view-sync-conflict') {
        event.preventDefault();
        openConflictResolution(trigger.dataset.conflictId);
      }
      if (action === 'ignore-sync-conflict') {
        event.preventDefault();
        if (!window.confirm('暂时忽略后不会修改本地日记或账本，也不会删除冲突副本记录。是否继续？')) return;
        markSyncConflictIgnored(trigger.dataset.conflictId)
          .then(() => notify('已暂时忽略该冲突副本，本地数据未被修改'))
          .catch(error => notify(error?.message || '冲突状态更新失败', true));
      }
      if (action === 'resolve-sync-conflict') {
        event.preventDefault();
        const conflictId = trigger.dataset.conflictId;
        const choice = trigger.dataset.resolutionChoice;
        const safeId = escapeSelectorValue(conflictId || '');
        const note = document.querySelector(`[data-conflict-resolution-note="${safeId}"]`)?.value || '';
        const resolution = { choice, note, merged_record: null };
        if (choice === 'manual_merge') {
          const content = document.querySelector(`[data-conflict-merge-content="${safeId}"]`)?.value || '';
          const mood = document.querySelector(`[data-conflict-merge-mood="${safeId}"]`)?.value || '一般';
          resolution.merged_record = {
            date: '',
            content,
            mood_label: mood,
          };
        }
        getSyncConflict(conflictId)
          .then((conflict) => {
            if (resolution.merged_record && conflict) {
              resolution.merged_record.date = conflict.entity_id || conflict.local_snapshot?.date || conflict.remote_snapshot?.date || '';
              resolution.merged_record.image_paths = conflict.local_snapshot?.image_paths || conflict.remote_snapshot?.image_paths || '';
              resolution.merged_record.retained_images = conflict.local_snapshot?.retained_images || conflict.remote_snapshot?.retained_images || '';
            }
            return resolveSyncConflict(conflictId, resolution);
          })
          .then(() => openConflictResolution(conflictId).catch(() => {}))
          .catch(error => notify(error?.message || '冲突解决失败', true));
      }
      if (action === 'close-sync-conflict-detail') {
        event.preventDefault();
        const panel = document.getElementById('syncConflictDetailPanel');
        if (panel) {
          panel.innerHTML = '';
          panel.classList.add('hidden');
        }
      }
      if (action === 'retry-failed-change') {
        event.preventDefault();
        retryFailedLocalChange(trigger.dataset.changeId);
      }
      if (action === 'ignore-failed-change') {
        event.preventDefault();
        ignoreFailedLocalChange(trigger.dataset.changeId);
      }
      if (action === 'toggle-sync-history') {
        event.preventDefault();
        const allList = document.getElementById('syncHistoryAllList');
        const showAll = allList?.classList.contains('hidden') ?? true;
        renderSyncHistoryPanel({ showAll });
        trigger.textContent = showAll ? '收起同步历史' : '查看全部同步历史';
      }
      if (action === 'cleanup-synced-local-changes') {
        event.preventDefault();
        cleanupSyncedLocalChanges();
      }
      if (action === 'cleanup-resolved-conflicts') {
        event.preventDefault();
        cleanupResolvedConflicts();
      }
      if (action === 'run-sync-diagnostics') {
        event.preventDefault();
        const panel = document.getElementById('syncDiagnosticsResult');
        if (panel) panel.innerHTML = '<p class="sync-diagnostics-empty">正在运行同步自检...</p>';
        runSyncDiagnostics()
          .then(result => renderSyncDiagnosticsPanel(result))
          .catch(error => {
            if (panel) panel.innerHTML = `<p class="sync-diagnostics-empty">同步自检失败：${escapeHtml(error?.message || '未知错误')}</p>`;
          });
      }
      if (action === 'export-sync-diagnostics') {
        event.preventDefault();
        exportSyncDiagnosticReport().catch(error => notify(error?.message || '诊断报告导出失败', true));
      }
      if (action === 'close-remote-preview') {
        event.preventDefault();
        closeRemoteChangePreview();
      }
    });
  }

  window.LeafVaultIncrementalSync = {
    getDeviceId,
    getNextClientSequence,
    createLocalChange,
    listPendingLocalChanges,
    markLocalChangeSynced,
    markLocalChangeFailed,
    recordSyncHistory,
    listSyncHistory,
    renderSyncHistoryPanel,
    retryFailedLocalChange,
    ignoreFailedLocalChange,
    getSyncDashboardSummary,
    cleanupSyncedLocalChanges,
    cleanupResolvedConflicts,
    buildChangeId,
    buildPlainChangePayload,
    encryptSyncChangePayload,
    formatSyncError,
    startManualSyncWizard,
    runManualSyncFlow,
    renderManualSyncResult,
    uploadPendingLocalChangesWithPassword,
    getUnprocessedRemoteChanges,
    recordManualSyncHistory,
    autoCheckRemoteChangesIfNeeded,
    checkRemoteChangesQuietly,
    shouldAutoCheckRemoteChanges,
    renderSyncAttentionBadge,
    dismissSyncAttentionForToday,
    refreshSyncAttentionState,
    getRemotePendingCountFromLocalCache,
    runSyncDiagnostics,
    buildSyncDiagnosticReport,
    renderSyncDiagnosticsPanel,
    exportSyncDiagnosticReport,
    getSyncHealthLevel,
    selfTestSyncCoreFunctions,
    uploadPendingLocalChanges,
    getPendingChangeCount,
    refreshIncrementalSyncStatus,
    fetchRemoteChangeMetadata,
    getRemoteChangeCount,
    refreshRemoteChangeStatus,
    renderRemoteChangeMetadataList,
    fetchRemoteEncryptedChange,
    decryptRemoteChangePayload,
    previewRemoteChange,
    renderRemoteChangePreview,
    closeRemoteChangePreview,
    getLocalRecordForRemoteChange,
    analyzeRemoteChangeAgainstLocal,
    buildMergePlan,
    renderMergePlanPreview,
    formatMergePlanStatus,
    applyRemoteChange,
    applyMergePlan,
    recordAppliedRemoteChange,
    hasAppliedRemoteChange,
    markRemoteChangeBlocked,
    createConflictCopy,
    saveSyncConflict,
    listSyncConflicts,
    getSyncConflict,
    markSyncConflictIgnored,
    openConflictResolution,
    resolveSyncConflict,
    applyConflictResolution,
    renderConflictResolutionPanel,
    markConflictResolved,
    markConflictIgnored,
    refreshSyncConflictStatus,
    getLastRemoteChangeCheckAt,
    setLastRemoteChangeCheckAt,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupIncrementalSyncActions();
      setupIncrementalAutoCheckTriggers();
      refreshIncrementalSyncStatus();
      autoCheckRemoteChangesIfNeeded('startup');
    }, { once: true });
  } else {
    setupIncrementalSyncActions();
    setupIncrementalAutoCheckTriggers();
    refreshIncrementalSyncStatus();
    autoCheckRemoteChangesIfNeeded('startup');
  }
}(window));
