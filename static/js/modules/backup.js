(function (window) {
  'use strict';

  const BACKUP_ITERATIONS = 310000;
  const BACKUP_APP_NAME = 'LeafVault';
  const DEFAULT_CLOUD_SNAPSHOT_NAME = '手动云端备份';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;

  // 缓存最新配额信息（由 fetchCloudBackupSnapshots 更新）
  let _latestQuota = null;
  let _backupStatusPanelTimer = null;
  let _refreshAfterImportInFlight = null;
  let _lastRefreshAfterImportAt = 0;
  const BACKUP_STATUS_PANEL_THROTTLE_MS = 1000;
  const REFRESH_AFTER_IMPORT_THROTTLE_MS = 3000;

  // 单张图片资产大小限制（MB），取自后端 max_upload_size_mb
  function getBackupAssetLimitBytes() {
    const mb = _latestQuota?.max_upload_size_mb
      || window.LeafVaultAuth?.getDeploymentStatus?.()?.max_upload_size_mb
      || 10;
    return mb * 1024 * 1024;
  }

  // 云端备份总 payload 大小限制（MB），取自后端 max_cloud_snapshot_payload_mb
  function getCloudSnapshotPayloadLimitBytes() {
    const mb = _latestQuota?.max_cloud_snapshot_payload_mb
      || window.LeafVaultAuth?.getDeploymentStatus?.()?.max_cloud_snapshot_payload_mb
      || 100;
    return mb * 1024 * 1024;
  }

  function getCloudSnapshotPayloadLimitMB() {
    return Math.round(getCloudSnapshotPayloadLimitBytes() / 1024 / 1024);
  }

  function getBackupAssetLimitMB() {
    return Math.round(getBackupAssetLimitBytes() / 1024 / 1024);
  }
  const BACKUP_STATUS_KEYS = {
    lastLocalChangeAt: 'LeafVault_backup_last_local_change_at',
    lastLocalChangeReason: 'LeafVault_backup_last_local_change_reason',
    lastCloudUploadAt: 'LeafVault_backup_last_cloud_upload_at',
    reminderLastShownAt: 'LeafVault_backup_reminder_last_shown_at',
    reminderSnoozedUntil: 'LeafVault_backup_reminder_snoozed_until',
    reminderDismissedAt: 'LeafVault_backup_reminder_dismissed_at',
  };

  function uiState() {
    return window.LeafVaultUIState || {};
  }

  function friendlyError(error, fallback = '操作失败，请稍后重试') {
    if (typeof uiState().normalizeUserFacingError === 'function') {
      return uiState().normalizeUserFacingError(error || fallback);
    }
    return error?.message || String(error || fallback);
  }

  function notify(message, typeOrIsError = false) {
    if (typeof uiState().showToast === 'function') {
      const type = typeOrIsError === true ? 'error' : typeOrIsError === false ? 'success' : String(typeOrIsError || 'info');
      uiState().showToast(message, type);
      return;
    }
    if (typeof window.showToast === 'function') {
      window.showToast(message, typeOrIsError === true || typeOrIsError === 'error' || typeOrIsError === 'warning');
      return;
    }
  }

  function isDemoMode() {
    return Boolean(window.LeafVaultSession?.isDemoMode?.());
  }

  function notifyDemoLocalOnly() {
    notify('Demo 模式仅支持本地体验。云端备份、多设备同步和账号设置需要正式账号。', true);
  }

  function ensureOnlineForCloudBackup() {
    if (isDemoMode()) {
      notifyDemoLocalOnly();
      return false;
    }
    if (typeof window.ensureOnlineForCloudFeature === 'function') {
      return window.ensureOnlineForCloudFeature();
    }
    if (navigator.onLine) return true;
    notify('当前离线，联网后再使用此功能。', true);
    return false;
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
    try {
      const binary = atob(String(value || ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (_) {
      throw new Error('备份文件格式不正确');
    }
  }

  function parseEncryptedBackupJson(raw) {
    const encryptedBackup = typeof raw === 'string' ? JSON.parse(raw) : raw;
    validateEncryptedBackupFile(encryptedBackup);
    return encryptedBackup;
  }

  async function decryptBackupPayload(encryptedBackup, password) {
    validateEncryptedBackupFile(encryptedBackup);
    const key = await deriveBackupKey(
      password,
      base64ToBytes(encryptedBackup.salt),
      Number(encryptedBackup.iterations),
      ['decrypt']
    );
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(encryptedBackup.iv) },
      key,
      base64ToBytes(encryptedBackup.payload)
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuffer));
  }

  async function deriveBackupKey(password, salt, iterations = BACKUP_ITERATIONS, usages = ['encrypt']) {
    const passwordBytes = new TextEncoder().encode(password);
    const baseKey = await crypto.subtle.importKey(
      'raw',
      passwordBytes,
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  function normalizeRecordForBackup(record) {
    const safeRecord = { ...(record || {}) };
    delete safeRecord.offline_files;
    return safeRecord;
  }

  function parseDiaryImagePathList(value) {
    const seen = new Set();
    const parts = repairDiaryImagePathParts(collectDiaryImagePathParts(value));
    return parts
      .map(normalizeDiaryAssetPath)
      .filter(Boolean)
      .filter(item => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      });
  }

  function collectDiaryImagePathParts(value) {
    if (Array.isArray(value)) return value.flatMap(item => collectDiaryImagePathParts(item));
    if (value === null || value === undefined) return [];
    const text = String(value).trim();
    if (!text) return [];
    if (/^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i.test(text) || text.startsWith('blob:')) return [text];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return collectDiaryImagePathParts(parsed);
      } catch (_) {
        // 兼容旧 CSV。
      }
    }
    return text.split(',').map(item => item.trim()).filter(Boolean);
  }

  function repairDiaryImagePathParts(parts) {
    const repaired = [];
    for (let i = 0; i < parts.length; i += 1) {
      const current = String(parts[i] || '').trim();
      if (!current) continue;
      const next = String(parts[i + 1] || '').trim();
      if (/^data:image\/(?:jpeg|jpg|png|webp|gif);base64$/i.test(current) && next) {
        repaired.push(`${current},${next}`);
        i += 1;
      } else {
        repaired.push(current);
      }
    }
    return repaired;
  }

  function inferRawImageMime(value) {
    const text = String(value || '').trim();
    if (text.startsWith('/9j/') || text.startsWith('9j/')) return 'image/jpeg';
    if (text.startsWith('iVBOR')) return 'image/png';
    if (text.startsWith('UklGR')) return 'image/webp';
    if (text.startsWith('R0lGOD')) return 'image/gif';
    return '';
  }

  function normalizeDiaryAssetPath(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i.test(text)) return text;
    const rawMime = inferRawImageMime(text);
    if (rawMime) return `data:${rawMime};base64,${text}`;
    if (text.startsWith('blob:') || text.startsWith('http://') || text.startsWith('https://')) return text;
    if (text.startsWith('/uploads/') || text.startsWith('/static/images/')) return text;
    if (text.startsWith('/')) return text;
    return '';
  }

  function serializeDiaryImagePathList(value) {
    const paths = parseDiaryImagePathList(value);
    return paths.some(path => path.startsWith('data:image/') || path.startsWith('blob:'))
      ? JSON.stringify(paths)
      : paths.join(',');
  }

  function inferAssetMime(path, fallback = '') {
    const lower = String(path || '').toLowerCase();
    if (fallback) return fallback;
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function collectDiaryBackupAssets(diaries = [], options = {}) {
    const assetLimitBytes = getBackupAssetLimitBytes();
    const payloadLimitBytes = getCloudSnapshotPayloadLimitBytes();
    const assetLimitMB = getBackupAssetLimitMB();
    const enforceTotalLimit = options.enforceTotalLimit !== false;
    const assets = [];
    const seenByHash = new Map();
    const failed = [];
    let totalBytes = 0;

    for (const diary of diaries || []) {
      for (const oldPath of parseDiaryImagePathList(diary.image_paths || diary.retained_images || '')) {
        if (!oldPath || oldPath.startsWith('data:')) continue;
        try {
          const assetFetch = window.fetch?.bind(window);
          if (!assetFetch) throw new Error('fetch unavailable');
          const res = await assetFetch(oldPath, { credentials: 'same-origin', cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          if (!String(blob.type || '').startsWith('image/')) throw new Error('not image');
          if (blob.size > assetLimitBytes) throw new Error(`single image > ${assetLimitMB}MB`);
          if (enforceTotalLimit && totalBytes + blob.size > payloadLimitBytes) throw new Error('total assets exceeds payload limit');
          const buffer = await blob.arrayBuffer();
          const hash = await sha256Hex(buffer);
          if (!seenByHash.has(hash)) {
            const asset = {
              old_path: oldPath,
              old_paths: [oldPath],
              filename: String(oldPath).split('/').pop() || `${hash}.jpg`,
              mime: inferAssetMime(oldPath, blob.type),
              size: blob.size,
              sha256: hash,
              data_base64: bytesToBase64(new Uint8Array(buffer)),
            };
            seenByHash.set(hash, asset);
            totalBytes += blob.size;
            assets.push(asset);
          } else {
            const asset = seenByHash.get(hash);
            if (asset && !asset.old_paths.includes(oldPath)) asset.old_paths.push(oldPath);
          }
        } catch (error) {
          const reason = error?.message || 'read failed';
          if (reason.startsWith('single image >')) {
            failed.push({ path: oldPath, reason: `单张图片超过 ${assetLimitMB}MB，无法加入备份。` });
          } else {
            failed.push({ path: oldPath, reason });
          }
        }
      }
    }

    return { assets, failed, totalBytes };
  }

  function replaceDiaryImagePathsWithMap(diary, pathMap = {}) {
    const imagePaths = parseDiaryImagePathList(diary?.image_paths || diary?.retained_images || '');
    if (!imagePaths.length) return diary;
    const replaced = parseDiaryImagePathList(imagePaths.map(path => pathMap[path] || path));
    return {
      ...diary,
      image_paths: serializeDiaryImagePathList(replaced),
      retained_images: serializeDiaryImagePathList(replaced),
    };
  }

  async function restoreBackupAssets(backupPayload) {
    const assets = Array.isArray(backupPayload?.assets)
      ? backupPayload.assets
      : Array.isArray(backupPayload?.diary_assets)
        ? backupPayload.diary_assets
        : [];
    if (!assets.length) return { pathMap: {}, restored: 0, failed: 0 };
    if (typeof window.apiFetch !== 'function') return { pathMap: {}, restored: 0, failed: assets.length };

    const hashToPath = {};
    const pathMap = {};
    let restored = 0;
    let failed = 0;
    for (const asset of assets) {
      try {
        if (!asset?.data_base64 || !asset?.old_path) throw new Error('invalid asset');
        let newPath = hashToPath[asset.sha256 || ''];
        if (!newPath) {
          const res = await window.apiFetch('/api/backup/assets/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              old_path: asset.old_path,
              filename: asset.filename || '',
              mime: asset.mime || '',
              size: asset.size || 0,
              sha256: asset.sha256 || '',
              data_base64: asset.data_base64,
            }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || body?.status !== 'success' || !body?.data?.path) {
            throw new Error(body?.message || body?.detail || `asset restore failed ${res.status}`);
          }
          newPath = body.data.path;
          if (asset.sha256) hashToPath[asset.sha256] = newPath;
          restored += 1;
        }
        pathMap[asset.old_path] = newPath;
        for (const oldPath of Array.isArray(asset.old_paths) ? asset.old_paths : []) {
          if (oldPath) pathMap[oldPath] = newPath;
        }
      } catch (error) {
        failed += 1;
        console.info('[LeafVault:Restore] backup asset restore failed', {
          old_path: asset?.old_path || '',
          filename: asset?.filename || '',
          size: Number(asset?.size || 0),
          error: error?.message || 'asset restore failed',
        });
      }
    }
    return { pathMap, restored, failed };
  }

  function getBackupDeviceName() {
    const platform = navigator.platform || 'Web';
    return `LeafVault ${platform}`.slice(0, 120);
  }

  function getBackupStatusUserId() {
    const userId = typeof window.getCurrentUserId === 'function' ? window.getCurrentUserId() : '';
    return String(userId || 'anonymous').trim() || 'anonymous';
  }

  function getBackupStatusKey(name) {
    return `${BACKUP_STATUS_KEYS[name]}_${getBackupStatusUserId()}`;
  }

  function readBackupStatusValue(name) {
    try {
      return window.localStorage.getItem(getBackupStatusKey(name)) || '';
    } catch (_) {
      return '';
    }
  }

  function writeBackupStatusValue(name, value) {
    try {
      window.localStorage.setItem(getBackupStatusKey(name), String(value || ''));
    } catch (_) {
      /* localStorage 不可用时只影响提醒，不影响备份主流程。 */
    }
  }

  function removeBackupStatusValue(name) {
    try {
      window.localStorage.removeItem(getBackupStatusKey(name));
    } catch (_) {
      /* ignore */
    }
  }

  function parseTimeMs(value) {
    const ms = Date.parse(value || '');
    return Number.isNaN(ms) ? 0 : ms;
  }

  function isSameLocalDay(a, b) {
    if (!a || !b) return false;
    const first = new Date(a);
    const second = new Date(b);
    if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) return false;
    return first.getFullYear() === second.getFullYear()
      && first.getMonth() === second.getMonth()
      && first.getDate() === second.getDate();
  }

  function markLocalDataChanged(reason = 'local_change') {
    writeBackupStatusValue('lastLocalChangeAt', new Date().toISOString());
    writeBackupStatusValue('lastLocalChangeReason', reason);
    updateBackupStatusPanel();
  }

  function clearBackupReminderState() {
    removeBackupStatusValue('reminderLastShownAt');
    removeBackupStatusValue('reminderSnoozedUntil');
    removeBackupStatusValue('reminderDismissedAt');
  }

  function markCloudBackupUploaded(uploadedAt = new Date().toISOString()) {
    writeBackupStatusValue('lastCloudUploadAt', uploadedAt);
    removeBackupStatusValue('lastLocalChangeAt');
    removeBackupStatusValue('lastLocalChangeReason');
    clearBackupReminderState();
    updateBackupStatusPanel();
  }

  function getBackupStatus() {
    const lastLocalChangeAt = readBackupStatusValue('lastLocalChangeAt');
    const lastCloudUploadAt = readBackupStatusValue('lastCloudUploadAt');
    return {
      user_id: getBackupStatusUserId(),
      last_local_change_at: lastLocalChangeAt,
      last_local_change_reason: readBackupStatusValue('lastLocalChangeReason'),
      last_cloud_upload_at: lastCloudUploadAt,
      reminder_last_shown_at: readBackupStatusValue('reminderLastShownAt'),
      reminder_snoozed_until: readBackupStatusValue('reminderSnoozedUntil'),
      reminder_dismissed_at: readBackupStatusValue('reminderDismissedAt'),
      has_local_changes: Boolean(lastLocalChangeAt),
      has_cloud_backup: Boolean(lastCloudUploadAt),
    };
  }

  function shouldShowBackupReminder(status = getBackupStatus(), nowValue = new Date()) {
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
    const nowMs = now.getTime();
    const snoozedUntilMs = parseTimeMs(status.reminder_snoozed_until);
    if (snoozedUntilMs && snoozedUntilMs > nowMs) return { show: false, muted: false, message: '' };

    let message = '';
    if (!status.last_cloud_upload_at) {
      message = '还没有云端加密备份，建议找个时间上传一份。';
    } else if (status.has_local_changes) {
      const lastUploadMs = parseTimeMs(status.last_cloud_upload_at);
      const ageMs = lastUploadMs ? nowMs - lastUploadMs : 0;
      if (ageMs >= WEEK_MS) {
        message = '距离上次云端加密备份已经有一段时间了，可以考虑更新一份备份。';
      } else if (ageMs >= DAY_MS) {
        message = '本地数据已有新变化，建议空闲时上传一份新的云端加密备份。';
      }
    }

    if (!message) return { show: false, muted: false, message: '' };

    const shownToday = isSameLocalDay(status.reminder_last_shown_at, now);
    const dismissedToday = isSameLocalDay(status.reminder_dismissed_at, now);
    return {
      show: true,
      muted: shownToday || dismissedToday,
      message,
    };
  }

  function snoozeBackupReminder(hours = 24) {
    const until = new Date(Date.now() + Math.max(1, Number(hours) || 24) * 60 * 60 * 1000).toISOString();
    writeBackupStatusValue('reminderSnoozedUntil', until);
    updateBackupStatusPanel();
  }

  function dismissBackupReminderForWeek() {
    snoozeBackupReminder(24 * 7);
  }

  function dismissBackupReminderToday() {
    writeBackupStatusValue('reminderDismissedAt', new Date().toISOString());
    updateBackupStatusPanel();
  }

  function isBackupStatusPanelVisible() {
    const panel = document.getElementById('backupStatusPanel');
    const tab = panel?.closest('.tab-content');
    return Boolean(panel && (!tab || tab.classList.contains('active')));
  }

  function renderBackupReminder(status) {
    const reminder = shouldShowBackupReminder(status);
    if (!reminder.show) return '';
    if (!reminder.muted && isBackupStatusPanelVisible()) {
      writeBackupStatusValue('reminderLastShownAt', new Date().toISOString());
    }
    const className = reminder.muted ? 'backup-reminder is-muted' : 'backup-reminder';
    const actionHtml = reminder.muted
      ? '<button type="button" data-backup-action="reminder-upload">去上传</button>'
      : `
          <button type="button" data-backup-action="reminder-upload">去上传</button>
          <button type="button" data-backup-action="reminder-snooze">稍后提醒</button>
          <button type="button" data-backup-action="reminder-week">本周不提醒</button>
          <button type="button" data-backup-action="reminder-dismiss">我知道了</button>
        `;
    return `
      <div class="${className}">
        <div class="backup-reminder-text">
          <strong>备份小提醒</strong>
          <span>${escapeHtml(reminder.message)}</span>
        </div>
        <div class="backup-reminder-actions">${actionHtml}</div>
      </div>
    `;
  }

  async function updatePendingLocalChangeCount() {
    if (typeof window.LeafVaultIncrementalSync?.refreshIncrementalSyncStatus === 'function') {
      await window.LeafVaultIncrementalSync.refreshIncrementalSyncStatus();
      return;
    }
    const el = document.getElementById('pendingLocalChangeCount');
    if (!el) return;
    const changes = await window.LeafVaultIncrementalSync?.listPendingLocalChanges?.().catch(() => []);
    el.textContent = `本地待上传：${Array.isArray(changes) ? changes.length : 0} 条`;
  }

  function updateBackupStatusPanel() {
    const nowMs = Date.now();
    const lastRenderAt = Number(updateBackupStatusPanel._lastRenderAt || 0);
    if (lastRenderAt && nowMs - lastRenderAt < BACKUP_STATUS_PANEL_THROTTLE_MS) {
      if (!updateBackupStatusPanel._scheduled) {
        updateBackupStatusPanel._scheduled = true;
        const delay = BACKUP_STATUS_PANEL_THROTTLE_MS - (nowMs - lastRenderAt);
        _backupStatusPanelTimer = window.setTimeout(() => {
          updateBackupStatusPanel._scheduled = false;
          updateBackupStatusPanel();
        }, Math.max(80, delay));
      }
      return;
    }
    updateBackupStatusPanel._lastRenderAt = nowMs;
    const panel = document.getElementById('backupStatusPanel');
    if (!panel) return;
    const status = getBackupStatus();
    const lastLocalText = status.last_local_change_at ? formatCloudBackupTime(status.last_local_change_at) : '暂无新的本地变化';
    const lastCloudText = status.last_cloud_upload_at ? formatCloudBackupTime(status.last_cloud_upload_at) : '尚未上传云端备份';
    const stateText = status.has_local_changes ? '本地有新变化' : '已是最近一次云端备份后的状态';
    const stateClass = status.has_local_changes ? 'is-pending' : 'is-clean';
    panel.innerHTML = `
      <div class="backup-status-head">
        <div>
          <p class="backup-status-kicker">备份与同步状态</p>
          <h3>云端密文备份</h3>
        </div>
        <span class="backup-status-pill ${stateClass}">${stateText}</span>
      </div>
      <div class="backup-status-grid">
        <span>最近本地变化：${escapeHtml(lastLocalText)}</span>
        <span>最近云端备份：${escapeHtml(lastCloudText)}</span>
      </div>
      <div class="incremental-sync-status" aria-live="polite">
        <div class="incremental-sync-main">
          <strong>增量同步状态</strong>
          <div class="sync-status-metrics" aria-label="增量同步摘要">
            <span id="pendingLocalChangeCount">本地待上传：计算中...</span>
            <span id="remoteChangeCount">云端新变更：0 条</span>
            <span id="remoteChangeCheckAt">最近检查：暂无</span>
            <span id="syncDashboardSummary">已处理/冲突：计算中...</span>
          </div>
        </div>
        <div class="incremental-sync-actions">
          <button type="button" data-incremental-action="start-manual-sync">开始手动同步</button>
          <button type="button" id="uploadPendingChangesBtn" data-backup-action="upload-incremental-changes">上传待同步变更</button>
          <button type="button" data-backup-action="check-remote-changes">检查云端变更</button>
        </div>
      </div>
      <div class="manual-sync-hint">手动同步会先上传本地待同步变更，再检查其他设备的云端变更。冲突不会自动覆盖。</div>
      <div id="syncAttentionBadge" class="sync-attention-badge hidden" aria-live="polite"></div>
      <div id="manualSyncWizardPanel" class="manual-sync-wizard hidden"></div>
      <details class="mobile-collapsible sync-advanced-tools">
        <summary>同步历史、失败重试、冲突副本与诊断</summary>
        <div class="mobile-collapsible-body">
          <div id="failedLocalChangesPanel" class="failed-local-change-panel hidden">
            <div class="sync-panel-heading">
              <strong>失败变更</strong>
              <span>只处理上传失败的本地变更，不会删除日记或账本。</span>
            </div>
            <div id="failedLocalChangeList" class="failed-local-change-list"></div>
          </div>
          <div id="remoteChangeNotice" class="remote-change-notice hidden">检测到其他设备上传的云端变更。当前阶段仅展示列表，暂不自动合并。</div>
          <div id="remoteChangeMetadataList" class="remote-change-list"></div>
          <div id="remoteChangePreviewPanel" class="remote-change-preview hidden"></div>
          <div class="sync-conflict-status">
            <div>
              <strong>同步冲突</strong>
              <span id="syncConflictCount">待处理冲突：计算中...</span>
            </div>
            <button type="button" data-incremental-action="toggle-sync-conflicts">查看冲突副本</button>
          </div>
          <div id="syncConflictList" class="sync-conflict-list hidden"></div>
          <div id="syncConflictDetailPanel" class="sync-conflict-detail hidden"></div>
          <div class="sync-history-panel">
            <div class="sync-panel-heading">
              <strong>同步历史</strong>
              <span>最近 5 条同步事件</span>
            </div>
            <div id="syncHistoryList" class="sync-history-list"></div>
            <button type="button" class="sync-history-toggle" data-incremental-action="toggle-sync-history">查看全部同步历史</button>
            <div id="syncHistoryAllList" class="sync-history-list hidden"></div>
          </div>
          <div class="sync-cleanup-panel">
            <div class="sync-panel-heading">
              <strong>同步清理</strong>
              <span>清理同步历史不会删除你的日记、账本或云端备份。</span>
            </div>
            <div class="sync-cleanup-actions">
              <button type="button" data-incremental-action="cleanup-synced-local-changes">清理已同步本地变更</button>
              <button type="button" data-incremental-action="cleanup-resolved-conflicts">清理已解决冲突记录</button>
            </div>
          </div>
          <details class="sync-diagnostics-panel">
            <summary>同步诊断</summary>
            <div class="sync-panel-heading">
              <strong>同步诊断、自检与测试面板</strong>
              <span>只生成不含日记正文、账本备注、密码或密钥的健康报告，不会自动同步或修改数据。</span>
            </div>
            <div class="sync-diagnostics-actions">
              <button type="button" data-incremental-action="run-sync-diagnostics">运行同步自检</button>
              <button type="button" data-incremental-action="export-sync-diagnostics">导出诊断报告</button>
            </div>
            <div id="syncDiagnosticsResult" class="sync-diagnostics-result">
              <p class="sync-diagnostics-empty">尚未运行同步自检。</p>
            </div>
          </details>
        </div>
      </details>
      ${renderBackupReminder(status)}
    `;
    updatePendingLocalChangeCount();
  }

  function syncBackupStatusFromCloudSnapshots(snapshots) {
    if (!Array.isArray(snapshots) || !snapshots.length) {
      updateBackupStatusPanel();
      return;
    }
    const latest = snapshots
      .map(item => item?.uploaded_at)
      .filter(Boolean)
      .sort((a, b) => parseTimeMs(b) - parseTimeMs(a))[0];
    if (latest && parseTimeMs(latest) > parseTimeMs(readBackupStatusValue('lastCloudUploadAt'))) {
      writeBackupStatusValue('lastCloudUploadAt', latest);
    }
    updateBackupStatusPanel();
  }

  function normalizeApiListResponse(body) {
    if (Array.isArray(body?.data)) return body.data;
    if (Array.isArray(body?.items)) return body.items;
    if (Array.isArray(body?.results)) return body.results;
    if (Array.isArray(body)) return body;
    return [];
  }

  async function fetchCompleteServerCollection(endpoint, pageSize) {
    if (typeof window.apiFetch !== 'function') return [];
    const records = [];
    const seenPageSignatures = new Set();
    for (let page = 1; page <= 200; page += 1) {
      const separator = endpoint.includes('?') ? '&' : '?';
      const res = await window.apiFetch(`${endpoint}${separator}page=${page}&page_size=${pageSize}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.status === 'error') {
        throw new Error(body?.message || body?.detail || '从服务器读取备份数据失败');
      }
      const pageItems = normalizeApiListResponse(body);
      const signature = JSON.stringify(pageItems.map(item => item?.uuid || item?.local_id || item?.date || item?.id || '').slice(0, 8));
      if (page > 1 && seenPageSignatures.has(signature)) break;
      seenPageSignatures.add(signature);
      records.push(...pageItems);

      const total = Number(body?.total ?? body?.count ?? 0);
      const hasMore = body?.has_more ?? body?.hasMore ?? body?.next;
      if (hasMore === false) break;
      if (total && records.length >= total) break;
      if (pageItems.length < pageSize) break;
      if (!pageItems.length) break;
    }
    return records;
  }

  function isDeletedBackupRecord(record) {
    return Number(record?.is_deleted || 0) === 1 || Boolean(record?.deleted_at);
  }

  function isVisibleDiaryForBackup(record) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(record?.date || '').trim()) && !isDeletedBackupRecord(record);
  }

  function isVisibleLedgerForBackup(record) {
    return Boolean(record) && !isDeletedBackupRecord(record);
  }

  function getDiaryBackupKey(record) {
    return String(record?.date || '').trim();
  }

  function getLedgerBackupKey(record) {
    const uuid = normalizeLedgerText(record?.uuid);
    if (uuid) return `uuid:${uuid}`;
    const localId = normalizeLedgerText(record?.local_id);
    if (localId) return `local:${localId}`;
    const id = normalizeLedgerText(record?.id);
    if (id) return `id:${id}`;
    return '';
  }

  function mergeDiaryBackupRecords(serverRecords = [], localPendingRecords = []) {
    const merged = new Map();
    for (const diary of serverRecords || []) {
      const key = getDiaryBackupKey(diary);
      if (!key || !isVisibleDiaryForBackup(diary)) continue;
      merged.set(key, normalizeRecordForBackup({ ...diary, sync_status: Number(diary.sync_status || 0) }));
    }
    for (const diary of localPendingRecords || []) {
      const key = getDiaryBackupKey(diary);
      if (!key || !isVisibleDiaryForBackup(diary)) continue;
      const existing = merged.get(key);
      const diaryImagePaths = parseDiaryImagePathList(diary.image_paths || diary.retained_images || '');
      const existingImagePaths = parseDiaryImagePathList(existing?.image_paths || existing?.retained_images || '');
      const imagePathText = diaryImagePaths.length
        ? serializeDiaryImagePathList(diaryImagePaths)
        : serializeDiaryImagePathList(existingImagePaths);
      // 本地待同步日记可能只保存了正文/心情，不能把服务端已有图片路径覆盖为空。
      merged.set(key, normalizeRecordForBackup({
        ...existing,
        ...diary,
        image_paths: imagePathText,
        retained_images: imagePathText,
      }));
    }
    return Array.from(merged.values());
  }

  function mergeLedgerBackupRecords(serverRecords = [], localPendingRecords = []) {
    const merged = new Map();
    for (const ledger of serverRecords || []) {
      const key = getLedgerBackupKey(ledger);
      if (!key || !isVisibleLedgerForBackup(ledger)) continue;
      merged.set(key, normalizeRecordForBackup({ ...ledger, sync_status: Number(ledger.sync_status || 0), is_deleted: 0 }));
    }
    for (const ledger of localPendingRecords || []) {
      const key = getLedgerBackupKey(ledger);
      if (!key || !isVisibleLedgerForBackup(ledger)) continue;
      merged.set(key, normalizeRecordForBackup({ ...ledger, is_deleted: 0 }));
    }
    return Array.from(merged.values());
  }

  async function buildBackupPayload(options = {}) {
    if (!window.LocalStorage || typeof window.LocalStorage.getAll !== 'function') {
      throw new Error('本地数据库模块尚未加载');
    }
    const userId = typeof window.getCurrentUserId === 'function' ? window.getCurrentUserId() : '';
    if (!userId) throw new Error('请先登录后再导出备份');

    const [localDiaries, localLedgers] = await Promise.all([
      window.LocalStorage.getAll('diaries'),
      window.LocalStorage.getAll('ledgers'),
    ]);
    const localPendingDiaries = (localDiaries || []).filter((diary) => (
      [1, 2].includes(Number(diary?.sync_status || 0)) && isVisibleDiaryForBackup(diary)
    ));
    const localPendingLedgers = (localLedgers || []).filter((ledger) => (
      Number(ledger?.sync_status || 0) === 1 && isVisibleLedgerForBackup(ledger)
    ));

    let serverDiaries = [];
    let serverLedgers = [];
    let backupSource = 'local_cache';
    const canUseServer = !isDemoMode() && navigator.onLine && typeof window.apiFetch === 'function';
    if (canUseServer) {
      [serverDiaries, serverLedgers] = await Promise.all([
        fetchCompleteServerCollection('/api/diaries/list', 100),
        fetchCompleteServerCollection('/api/ledgers/list', 200),
      ]);
      backupSource = 'server_plus_pending_local';
    } else {
      notify('当前备份来自本机缓存', 'warning');
    }

    const diaries = mergeDiaryBackupRecords(serverDiaries, localPendingDiaries);
    const ledgers = mergeLedgerBackupRecords(serverLedgers, localPendingLedgers);
    const assetResult = await collectDiaryBackupAssets(diaries, {
      enforceTotalLimit: options.forCloud === true,
    });
    if (assetResult.failed.length) {
      notify(`有 ${assetResult.failed.length} 张图片未能加入备份，文字和账本仍会继续备份。`, 'warning');
    }

    // [诊断日志] 备份 payload 构建摘要，不输出日记正文
    console.info('[LeafVault:Backup] buildBackupPayload 摘要:', {
      backupSource,
      diariesCount: diaries.length,
      diaryDates: diaries.map(d => d.date).sort(),
      ledgersCount: ledgers.length,
      serverDiariesCount: serverDiaries.length,
      serverLedgersCount: serverLedgers.length,
      localPendingDiariesCount: localPendingDiaries.length,
      localPendingLedgersCount: localPendingLedgers.length,
      assetCount: assetResult.assets.length,
      assetFailedCount: assetResult.failed.length,
    });
    if (!diaries.length && !ledgers.length) {
      throw new Error('当前备份内容为空，请确认数据是否已加载或本地加密空间是否已解锁');
    }

    return {
      version: 1,
      app: BACKUP_APP_NAME,
      created_at: new Date().toISOString(),
      user_id: userId,
      source: backupSource,
      diaries,
      ledgers,
      assets: assetResult.assets,
      assets_meta: {
        count: assetResult.assets.length,
        failed_count: assetResult.failed.length,
        total_bytes: assetResult.totalBytes,
      },
    };
  }

  async function encryptBackupPayload(backupPayload, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveBackupKey(password, salt, BACKUP_ITERATIONS, ['encrypt']);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(backupPayload));
    const encryptedBytes = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payloadBytes)
    );

    return {
      version: 1,
      app: BACKUP_APP_NAME,
      kdf: 'PBKDF2',
      iterations: BACKUP_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      payload: bytesToBase64(encryptedBytes),
      created_at: backupPayload.created_at || new Date().toISOString(),
      device_name: getBackupDeviceName(),
    };
  }

  function downloadBackupFile(encryptedBackup, filename = '') {
    const blob = new Blob([JSON.stringify(encryptedBackup, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || `leafvault-backup-${new Date().toISOString().slice(0, 10)}.lvbackup`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function ensureBackupPasswordDialog() {
    if (!document.getElementById('backupPasswordStyle')) {
      const style = document.createElement('style');
      style.id = 'backupPasswordStyle';
      style.textContent = `
        .backup-password-modal{position:fixed;inset:0;z-index:220;display:grid;place-items:center;padding:20px;background:rgba(15,23,42,.42);backdrop-filter:blur(12px)}
        .backup-password-modal.hidden{display:none}
        .backup-password-panel{width:min(92vw,380px);border-radius:28px;border:1px solid rgba(167,243,208,.88);background:radial-gradient(circle at 16% 0%,rgba(220,252,231,.9),transparent 38%),linear-gradient(145deg,rgba(255,255,255,.98),rgba(240,253,244,.94));box-shadow:0 28px 70px rgba(15,23,42,.22),inset 0 1px 0 rgba(255,255,255,.96);padding:22px}
        .backup-password-title{color:#065f46;font-size:18px;font-weight:900;margin:0 0 6px}
        .backup-password-subtitle{color:#64748b;font-size:12px;font-weight:700;line-height:1.6;margin:0 0 16px}
        .backup-password-input{width:100%;height:48px;border-radius:16px;border:1px solid rgba(187,247,208,.95);background:rgba(255,255,255,.86);padding:0 14px;color:#0f172a;font-size:14px;font-weight:800;outline:none}
        .backup-password-input:focus{box-shadow:0 0 0 4px rgba(187,247,208,.42);border-color:rgba(34,197,94,.9)}
        .backup-password-error{min-height:18px;margin:8px 0 14px;color:#ef4444;font-size:12px;font-weight:800}
        .backup-password-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .backup-password-btn{height:44px;border-radius:15px;font-size:13px;font-weight:900}
        .backup-password-btn.cancel{color:#64748b;background:rgba(255,255,255,.78);border:1px solid rgba(203,213,225,.86)}
        .backup-password-btn.confirm{color:#fff;background:linear-gradient(135deg,#22c55e,#14b8a6);box-shadow:0 14px 28px rgba(20,184,166,.2)}
      `;
      document.head.appendChild(style);
    }

    let modal = document.getElementById('backupPasswordModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'backupPasswordModal';
      modal.className = 'backup-password-modal hidden';
      modal.innerHTML = `
        <form class="backup-password-panel" id="backupPasswordForm">
          <h3 class="backup-password-title"></h3>
          <p class="backup-password-subtitle"></p>
          <input id="backupPasswordInput" class="backup-password-input" type="password" autocomplete="new-password" placeholder="至少 8 位备份密码">
          <div id="backupPasswordError" class="backup-password-error" aria-live="polite"></div>
          <div class="backup-password-actions">
            <button type="button" class="backup-password-btn cancel" id="backupPasswordCancel">取消</button>
            <button type="submit" class="backup-password-btn confirm"></button>
          </div>
        </form>
      `;
      document.body.appendChild(modal);
    }
    return modal;
  }

  function requestBackupPassword(mode = 'export') {
    return new Promise((resolve) => {
      const modal = ensureBackupPasswordDialog();
      const form = modal.querySelector('#backupPasswordForm');
      const input = modal.querySelector('#backupPasswordInput');
      const error = modal.querySelector('#backupPasswordError');
      const cancelBtn = modal.querySelector('#backupPasswordCancel');
      const title = modal.querySelector('.backup-password-title');
      const subtitle = modal.querySelector('.backup-password-subtitle');
      const confirmBtn = modal.querySelector('.backup-password-btn.confirm');
      let settled = false;

      title.textContent = mode === 'import' ? '导入加密备份' : '导出加密备份';
      subtitle.textContent = mode === 'import'
        ? '请输入导出时设置的备份密码。LeafVault 不会保存这个密码。'
        : '请输入一个只用于本次备份文件的密码。LeafVault 不会保存这个密码。';
      confirmBtn.textContent = mode === 'import' ? '开始导入' : '开始导出';

      if (mode === 'upload') {
        title.textContent = '上传云端加密备份';
        subtitle.textContent = '请输入本次云端密文快照的备份密码。LeafVault 不会保存这个密码。';
        confirmBtn.textContent = '开始上传';
      }

      if (mode === 'restore') {
        title.textContent = '恢复云端加密备份';
        subtitle.textContent = '请输入该云端备份对应的备份密码。LeafVault 不会保存这个密码。';
        confirmBtn.textContent = '开始恢复';
      }

      const finish = (value) => {
        if (settled) return;
        settled = true;
        modal.classList.add('hidden');
        input.value = '';
        error.textContent = '';
        document.removeEventListener('keydown', onKeyDown);
        resolve(value);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') finish(null);
      };

      form.onsubmit = (event) => {
        event.preventDefault();
        const password = input.value;
        if (password.length < 8) {
          error.textContent = '备份密码太短';
          notify('备份密码太短', true);
          return;
        }
        finish(password);
      };

      cancelBtn.onclick = () => finish(null);
      modal.onclick = (event) => {
        if (event.target === modal) finish(null);
      };

      modal.classList.remove('hidden');
      error.textContent = '';
      document.addEventListener('keydown', onKeyDown);
      setTimeout(() => input.focus(), 30);
    });
  }

  async function exportEncryptedBackup() {
    try {
      if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('导出加密备份'))) return;
      if (!window.crypto?.subtle) {
        notify('当前浏览器不支持 Web Crypto，无法导出加密备份', true);
        return;
      }

      const password = await requestBackupPassword('export');
      if (password === null) return;

      const backupPayload = await buildBackupPayload({ forCloud: false });
      const encryptedBackup = await encryptBackupPayload(backupPayload, password);
      downloadBackupFile(encryptedBackup);

      notify('加密备份已导出');
    } catch (error) {
      notify(error?.message || '导出加密备份失败', true);
    }
  }

  async function uploadEncryptedBackupSnapshot() {
    try {
      if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('上传云端备份'))) return null;
      if (!ensureOnlineForCloudBackup()) return null;
      if (!window.crypto?.subtle) {
        notify('当前浏览器不支持 Web Crypto，无法上传云端加密备份', true);
        return null;
      }
      if (typeof window.apiFetch !== 'function') {
        throw new Error('网络请求模块尚未加载');
      }

      const password = await requestBackupPassword('upload');
      if (password === null) return null;
      if (password.length < 8) {
        notify('备份密码太短', true);
        return null;
      }

      const snapshotMeta = requestCloudSnapshotMetadata();
      if (!snapshotMeta) return null;

      const backupPayload = await buildBackupPayload({ forCloud: true });
      const encryptedBackup = await encryptBackupPayload(backupPayload, password);

      // 检查加密后的云端备份 payload 大小是否超过服务器限制
      const payloadBytes = new TextEncoder().encode(JSON.stringify({
        ...encryptedBackup,
        snapshot_name: snapshotMeta.snapshot_name,
        snapshot_note: snapshotMeta.snapshot_note,
      })).length;
      const payloadLimitMB = getCloudSnapshotPayloadLimitMB();
      if (payloadBytes > getCloudSnapshotPayloadLimitBytes()) {
        notify(`云端备份超过 ${payloadLimitMB}MB，请减少图片或改用本地备份。`, true);
        return null;
      }

      const res = await window.apiFetch('/api/sync/snapshot', {
        method: 'POST',
        body: JSON.stringify({
          ...encryptedBackup,
          snapshot_name: snapshotMeta.snapshot_name,
          snapshot_note: snapshotMeta.snapshot_note,
        }),
      });

      let body = null;
      try {
        body = await res.json();
      } catch (_) {
        body = null;
      }

      if (!res.ok || body?.status !== 'success') {
        throw new Error(body?.message || body?.detail || `云端加密备份上传失败（${res.status}）`);
      }

      notify('云端加密备份上传成功');
      markCloudBackupUploaded(body?.uploaded_at || new Date().toISOString());
      if (document.getElementById('cloudBackupList')) {
        fetchCloudBackupSnapshots();
      }
      return body;
    } catch (error) {
      notify(error?.message || '云端加密备份上传失败', true);
      return null;
    }
  }

  function formatCloudBackupTime(value) {
    const time = new Date(value || '');
    if (Number.isNaN(time.getTime())) return value || '-';
    return time.toLocaleString('zh-CN', { hour12: false });
  }

  function formatBackupSize(sizeBytes) {
    const size = Number(sizeBytes) || 0;
    if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(2)} MB`;
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${size} B`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function getCloudBackupDownloadName(encryptedBackup) {
    const sourceDate = String(encryptedBackup?.created_at || new Date().toISOString());
    const datePart = /^\d{4}-\d{2}-\d{2}/.test(sourceDate)
      ? sourceDate.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const safeName = sanitizeFilenamePart(encryptedBackup?.snapshot_name);
    if (safeName) return `leafvault-${safeName}-${datePart}.lvbackup`;
    return `leafvault-cloud-backup-${datePart}.lvbackup`;
  }

  function sanitizeFilenamePart(value) {
    return String(value || '')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 60);
  }

  function requestCloudSnapshotMetadata() {
    // 名称和备注是云端管理元数据，不参与加密；提示用户不要写入敏感正文。
    const rawName = window.prompt(
      '请输入备份名称（最多 60 字，名称/备注不会加密，请勿填写日记正文或账本明细）',
      DEFAULT_CLOUD_SNAPSHOT_NAME
    );
    if (rawName === null) return null;
    const snapshotName = String(rawName || '').trim() || DEFAULT_CLOUD_SNAPSHOT_NAME;
    if (snapshotName.length > 60) {
      notify('备份名称不能超过 60 字', true);
      return null;
    }

    const rawNote = window.prompt('请输入备份备注（可选，最多 200 字）', '');
    if (rawNote === null) return null;
    const snapshotNote = String(rawNote || '').trim();
    if (snapshotNote.length > 200) {
      notify('备份备注不能超过 200 字', true);
      return null;
    }

    return {
      snapshot_name: snapshotName,
      snapshot_note: snapshotNote,
    };
  }

  function renderCloudBackupSnapshots(snapshots, quota = {}) {
    const listEl = document.getElementById('cloudBackupList');
    if (!listEl) return;
    const maxCloudSnapshots = Number(quota.max_cloud_snapshots_per_user || 0);
    const snapshotCount = Number(quota.count ?? (Array.isArray(snapshots) ? snapshots.length : 0));
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      if (typeof uiState().renderEmptyState === 'function') {
        const payloadLimitMB = Number(quota.max_cloud_snapshot_payload_mb) || getCloudSnapshotPayloadLimitMB();
        const descParts = [`单次云端备份上限：${payloadLimitMB}MB`];
        if (maxCloudSnapshots) descParts.push(`最多保存 ${maxCloudSnapshots} 份`);
        uiState().renderEmptyState(listEl, {
          title: '还没有云端备份',
          description: descParts.join(' · ') + '。',
          actionText: '上传云端加密备份',
          onAction: uploadEncryptedBackupSnapshot,
          compact: true,
        });
        listEl.querySelector('.ui-state-card')?.classList.add('cloud-backup-empty');
        return;
      }
      listEl.innerHTML = '<p class="cloud-backup-empty">暂无云端备份</p>';
      return;
    }

    const payloadLimitMB = Number(quota.max_cloud_snapshot_payload_mb) || getCloudSnapshotPayloadLimitMB();
    const sizeLimitHtml = payloadLimitMB ? ` · 单次云端备份上限：${payloadLimitMB}MB` : '';
    const quotaHtml = maxCloudSnapshots
      ? `<div class="cloud-backup-quota text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-2xl px-3 py-2 mb-3">云端备份：${escapeHtml(snapshotCount)}/${escapeHtml(maxCloudSnapshots)}${sizeLimitHtml}。达到上限后，请先删除旧备份再上传。</div>`
      : `<div class="cloud-backup-quota text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-2xl px-3 py-2 mb-3">单次云端备份上限：${payloadLimitMB}MB</div>`;
    listEl.innerHTML = quotaHtml + snapshots.map((snapshot) => {
      const snapshotId = escapeHtml(snapshot.id);
      const snapshotName = escapeHtml(String(snapshot.snapshot_name || '').trim() || '未命名备份');
      const snapshotNote = String(snapshot.snapshot_note || '').trim();
      const noteHtml = snapshotNote
        ? `<span class="cloud-backup-note">备注：${escapeHtml(snapshotNote)}</span>`
        : '<span class="cloud-backup-note muted">无备注</span>';
      return `
        <article class="cloud-backup-item">
          <div class="cloud-backup-main">
            <strong class="cloud-backup-name">${snapshotName}</strong>
            ${noteHtml}
            <span>上传：${escapeHtml(formatCloudBackupTime(snapshot.uploaded_at))}</span>
            <span>创建：${escapeHtml(formatCloudBackupTime(snapshot.created_at))}</span>
            <span>${escapeHtml(snapshot.device_name || '未知设备')} · ${escapeHtml(formatBackupSize(snapshot.size_bytes))}</span>
          </div>
          <div class="cloud-backup-actions">
            <button type="button" class="cloud-backup-download" data-backup-action="download-cloud" data-snapshot-id="${snapshotId}">下载</button>
            <button type="button" class="cloud-backup-restore" data-backup-action="restore-cloud" data-snapshot-id="${snapshotId}">恢复</button>
            <button type="button" class="cloud-backup-delete" data-backup-action="delete-cloud" data-snapshot-id="${snapshotId}">删除</button>
          </div>
        </article>
      `;
    }).join('');
  }

  async function fetchCloudBackupSnapshots() {
    const listEl = document.getElementById('cloudBackupList');
    try {
      if (!ensureOnlineForCloudBackup()) {
        renderCloudBackupSnapshots([]);
        updateBackupStatusPanel();
        return [];
      }
      if (listEl && typeof uiState().renderLoadingState === 'function') {
        uiState().renderLoadingState(listEl, {
          title: '正在获取云端备份...',
          description: '只加载备份元数据，不会解密你的内容。',
          compact: true,
          skeleton: true,
        });
      }
      if (typeof window.apiFetch !== 'function') {
        throw new Error('网络请求模块尚未加载');
      }
      const res = await window.apiFetch('/api/sync/snapshots');
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.status !== 'success' || !Array.isArray(body.data)) {
        throw new Error(body?.message || body?.detail || `云端备份列表加载失败（${res.status}）`);
      }
      renderCloudBackupSnapshots(body.data, {
        count: body.count,
        max_cloud_snapshots_per_user: body.max_cloud_snapshots_per_user,
        max_cloud_snapshot_payload_mb: body.max_cloud_snapshot_payload_mb,
        max_upload_size_mb: body.max_upload_size_mb,
      });
      _latestQuota = {
        max_cloud_snapshots_per_user: body.max_cloud_snapshots_per_user,
        max_cloud_snapshot_payload_mb: body.max_cloud_snapshot_payload_mb,
        max_upload_size_mb: body.max_upload_size_mb,
      };
      syncBackupStatusFromCloudSnapshots(body.data);
      return body.data;
    } catch (error) {
      if (listEl && typeof uiState().renderErrorState === 'function') {
        uiState().renderErrorState(listEl, {
          title: '云端备份加载失败',
          description: friendlyError(error, '云端备份列表加载失败'),
          retryText: '重新加载',
          onRetry: fetchCloudBackupSnapshots,
          compact: true,
        });
      } else {
        renderCloudBackupSnapshots([]);
      }
      notify(friendlyError(error, '云端备份列表加载失败'), true);
      return [];
    }
  }

  async function downloadCloudBackupSnapshot(snapshotId) {
    try {
      if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('下载云端备份'))) return null;
      if (!ensureOnlineForCloudBackup()) return null;
      const id = String(snapshotId || '').trim();
      if (!id) throw new Error('备份编号无效');
      if (typeof window.apiFetch !== 'function') {
        throw new Error('网络请求模块尚未加载');
      }

      const res = await window.apiFetch(`/api/sync/snapshots/${encodeURIComponent(id)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.status !== 'success' || !body.data) {
        throw new Error(body?.message || body?.detail || `云端加密备份下载失败（${res.status}）`);
      }

      downloadBackupFile(body.data, getCloudBackupDownloadName(body.data));
      notify('云端加密备份已下载');
      return body.data;
    } catch (error) {
      notify(error?.message || '云端加密备份下载失败', true);
      return null;
    }
  }

  async function restoreCloudBackupSnapshot(snapshotId) {
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('恢复云端备份'))) return null;
    if (!ensureOnlineForCloudBackup()) return null;
    if (!window.confirm('恢复云端备份会把该备份中的日记和账本合并到本地数据中，不会清空现有数据。是否继续？')) {
      return null;
    }
    if (!window.crypto?.subtle) {
      notify('当前浏览器不支持 Web Crypto，无法恢复云端加密备份', true);
      return null;
    }

    const password = await requestBackupPassword('restore');
    if (password === null) return null;
    if (password.length < 8) {
      notify('备份密码太短', true);
      return null;
    }

    try {
      const id = String(snapshotId || '').trim();
      if (!id) throw new Error('备份编号无效');
      if (typeof window.apiFetch !== 'function') {
        throw new Error('网络请求模块尚未加载');
      }

      const res = await window.apiFetch(`/api/sync/snapshots/${encodeURIComponent(id)}`);
      const body = await res.json().catch(() => null);
      if ([401, 403, 404].includes(res.status)) {
        throw new Error('无权访问该备份或登录已失效');
      }
      if (!res.ok || body?.status !== 'success' || !body.data) {
        throw new Error(body?.message || body?.detail || `云端备份恢复失败（${res.status}）`);
      }

      const encryptedBackup = parseEncryptedBackupJson(body.data);
      let backupPayload;
      try {
        backupPayload = await decryptBackupPayload(encryptedBackup, password);
      } catch (_) {
        notify('备份密码错误或备份已损坏', true);
        return null;
      }

      validateBackupPayload(backupPayload);
      const result = await mergeBackupPayloadToLocalDB(backupPayload, {
        mode: 'restore',
        forceRestore: true,
        markPendingSync: true,
        source: 'cloud_backup_restore',
      });
      if (result.diaries || result.ledgers) markLocalDataChanged('cloud_backup_restore');
      await refreshAfterImport();
      if (!result.diaries && !result.ledgers) {
        notify('备份中没有可恢复的数据或均被判定无效', 'warning');
      } else {
        notify(`云端备份恢复完成：已恢复 ${result.diaries} 篇日记、${result.ledgers} 条账本`);
      }
      return result;
    } catch (error) {
      const message = error?.message === 'Unauthorized'
        ? '无权访问该备份或登录已失效'
        : (error?.message || '云端备份恢复失败');
      notify(message, true);
      return null;
    }
  }

  async function deleteCloudBackupSnapshot(snapshotId) {
    if (!ensureOnlineForCloudBackup()) return null;
    if (!window.confirm('删除后该云端加密备份将无法恢复，但不会影响你本地的日记和账本。是否继续？')) {
      return null;
    }
    try {
      const id = String(snapshotId || '').trim();
      if (!id) throw new Error('备份编号无效');
      if (typeof window.apiFetch !== 'function') {
        throw new Error('网络请求模块尚未加载');
      }

      const res = await window.apiFetch(`/api/sync/snapshots/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => null);
      if ([401, 403, 404].includes(res.status)) {
        throw new Error('无权删除该备份或登录已失效');
      }
      if (!res.ok || body?.status !== 'success') {
        throw new Error(body?.message || body?.detail || `云端备份删除失败（${res.status}）`);
      }

      notify('云端备份已删除');
      await fetchCloudBackupSnapshots();
      return body;
    } catch (error) {
      const message = error?.message === 'Unauthorized'
        ? '无权删除该备份或登录已失效'
        : (error?.message || '云端备份删除失败');
      notify(message, true);
      return null;
    }
  }

  function validateEncryptedBackupFile(encryptedBackup) {
    if (
      !encryptedBackup
      || encryptedBackup.app !== BACKUP_APP_NAME
      || encryptedBackup.version !== 1
      || encryptedBackup.kdf !== 'PBKDF2'
      || !encryptedBackup.salt
      || !encryptedBackup.iv
      || !encryptedBackup.payload
      || !Number.isFinite(Number(encryptedBackup.iterations))
      || Number(encryptedBackup.iterations) <= 0
    ) {
      throw new Error('备份文件格式不正确');
    }
  }

  function validateBackupPayload(backupPayload) {
    if (
      !backupPayload
      || backupPayload.app !== BACKUP_APP_NAME
      || backupPayload.version !== 1
      || !Array.isArray(backupPayload.diaries)
      || !Array.isArray(backupPayload.ledgers)
    ) {
      throw new Error('备份文件格式不正确');
    }
  }

  function parseBackupTime(value) {
    const time = Date.parse(value || '');
    return Number.isNaN(time) ? null : time;
  }

  function shouldReplaceDiary(localDiary, incomingDiary) {
    if (!localDiary) return true;
    const localTime = parseBackupTime(localDiary.updated_at);
    const incomingTime = parseBackupTime(incomingDiary.updated_at);
    return localTime !== null && incomingTime !== null && incomingTime > localTime;
  }

  function normalizeImportedDiary(diary) {
    const date = String(diary?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const imagePathText = serializeDiaryImagePathList(diary?.image_paths || diary?.retained_images || '');
    return normalizeRecordForBackup({
      ...diary,
      date,
      mood_label: diary.mood_label || '一般',
      content: typeof diary.content === 'string' ? diary.content : '',
      image_paths: imagePathText,
      retained_images: imagePathText,
      sync_status: Number.isFinite(Number(diary.sync_status)) ? Number(diary.sync_status) : 0,
    });
  }

  function normalizeLedgerText(value) {
    return String(value ?? '').trim();
  }

  function getLedgerIdentity(ledger) {
    const uuid = normalizeLedgerText(ledger?.uuid);
    if (uuid) return `uuid:${uuid}`;
    const id = normalizeLedgerText(ledger?.id);
    if (id) return `id:${id}`;
    return [
      'compact',
      normalizeLedgerText(ledger?.created_at),
      normalizeLedgerText(ledger?.amount),
      normalizeLedgerText(ledger?.category),
      normalizeLedgerText(ledger?.note),
    ].join(':');
  }

  function getLedgerLocalId(ledger) {
    const existingLocalId = normalizeLedgerText(ledger?.local_id);
    if (existingLocalId) return existingLocalId;
    const uuid = normalizeLedgerText(ledger?.uuid);
    if (uuid) return uuid;
    const id = normalizeLedgerText(ledger?.id);
    if (id) return `server_${id}`;
    return `import_${getLedgerIdentity(ledger).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  function normalizeImportedLedger(ledger) {
    if (!ledger || typeof ledger !== 'object') return null;
    const localId = getLedgerLocalId(ledger);
    if (!localId) return null;
    return normalizeRecordForBackup({
      ...ledger,
      local_id: localId,
      type: ledger.type === 'income' ? 'income' : 'expense',
      amount: Number(ledger.amount) || 0,
      category: normalizeLedgerText(ledger.category) || '其他',
      note: normalizeLedgerText(ledger.note),
      created_at: normalizeLedgerText(ledger.created_at) || new Date().toISOString().slice(0, 10),
      sync_status: Number.isFinite(Number(ledger.sync_status)) ? Number(ledger.sync_status) : 0,
      is_deleted: Number(ledger.is_deleted || 0),
    });
  }

  const SOURCE_OWNER_FIELDS = [
    'id',
    'user_id',
    'userId',
    'username',
    'email',
    'account',
    'owner_id',
    'server_id',
  ];

  function stripSourceOwnershipFields(record) {
    const safeRecord = { ...(record || {}) };
    for (const field of SOURCE_OWNER_FIELDS) delete safeRecord[field];
    return safeRecord;
  }

  function normalizeRevision(value) {
    const revision = Number(value || 0);
    return Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 0;
  }

  function getRestoreLedgerLocalId(ledger) {
    const uuid = normalizeLedgerText(ledger?.uuid);
    if (uuid) return uuid;
    const sourceIdentity = normalizeLedgerText(ledger?.local_id)
      || normalizeLedgerText(ledger?.id)
      || getLedgerIdentity(ledger);
    return `import_${sourceIdentity.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || Date.now()}`;
  }

  function getRestoreLedgerEntityId(ledger) {
    return normalizeLedgerText(ledger?.uuid) || normalizeLedgerText(ledger?.local_id);
  }

  function buildEntityIdSet(...values) {
    return new Set(values.flat().map(value => normalizeLedgerText(value)).filter(Boolean));
  }

  async function discardPendingLocalChangesForEntity(entityType, entityIds, operations = ['delete']) {
    if (!window.LocalStorage || typeof window.LocalStorage.getAll !== 'function' || typeof window.LocalStorage.set !== 'function') {
      return 0;
    }
    const idSet = entityIds instanceof Set ? entityIds : buildEntityIdSet(entityIds);
    if (!idSet.size) return 0;
    const operationSet = new Set(operations);
    const allChanges = await window.LocalStorage.getAll('local_changes').catch(() => []);
    const now = new Date().toISOString();
    let ignored = 0;
    for (const change of allChanges || []) {
      if (
        change?.entity_type !== entityType
        || !idSet.has(normalizeLedgerText(change.entity_id))
        || !operationSet.has(change.operation)
        || !['pending', 'failed'].includes(change.sync_status)
      ) {
        continue;
      }
      await window.LocalStorage.set('local_changes', {
        ...change,
        sync_status: 'ignored',
        ignored_at: now,
        last_error: '恢复备份已取消旧的删除变更',
      });
      ignored += 1;
    }
    if (ignored && typeof window.LeafVaultIncrementalSync?.recordSyncHistory === 'function') {
      await window.LeafVaultIncrementalSync.recordSyncHistory({
        event_type: 'backup_restore_delete_change_ignored',
        entity_type: entityType,
        entity_id: Array.from(idSet).join(',').slice(0, 160),
        status: 'info',
        message: '恢复备份已取消旧的删除变更',
        metadata: { operations, ignored },
      }).catch(() => null);
    }
    return ignored;
  }

  async function createRestoreLocalChange({ entityType, entityId, operation, baseRevision, localRevision }) {
    if (isDemoMode() || !entityId || typeof window.LeafVaultIncrementalSync?.createLocalChange !== 'function') {
      return null;
    }
    return window.LeafVaultIncrementalSync.createLocalChange({
      entity_type: entityType,
      entity_id: entityId,
      operation,
      base_revision: baseRevision,
      local_revision: localRevision,
    });
  }

  function findLocalLedgerForRestore(incomingLedger, localLedgers = []) {
    const ids = buildEntityIdSet(
      incomingLedger?.uuid,
      incomingLedger?.local_id,
      incomingLedger?.id,
      getRestoreLedgerLocalId(incomingLedger)
    );
    return (localLedgers || []).find((ledger) => (
      ids.has(normalizeLedgerText(ledger?.uuid))
      || ids.has(normalizeLedgerText(ledger?.local_id))
      || ids.has(normalizeLedgerText(ledger?.id))
    )) || null;
  }

  function buildRestoreResult(diaries = 0, ledgers = 0, ignoredDeletes = 0) {
    return { diaries, ledgers, ignoredDeletes };
  }

  async function restoreBackupPayloadToLocalDB(backupPayload, options = {}) {
    if (!window.LocalStorage || typeof window.LocalStorage.get !== 'function' || typeof window.LocalStorage.set !== 'function') {
      throw new Error('本地数据库模块尚未加载');
    }

    let restoredDiaries = 0;
    let restoredLedgers = 0;
    let ignoredDeletes = 0;
    let skippedDiaries = 0;
    let failedDiaries = 0;
    const now = new Date().toISOString();
    const markPendingSync = options.markPendingSync !== false;
    const hasDiaryImageRefs = (backupPayload.diaries || []).some(diary => parseDiaryImagePathList(diary?.image_paths || diary?.retained_images || '').length > 0);
    const hasEmbeddedAssets = Array.isArray(backupPayload.assets) || Array.isArray(backupPayload.diary_assets);
    let assetPayloadForRestore = backupPayload;
    let legacyAssetCollect = null;
    if (!hasEmbeddedAssets && hasDiaryImageRefs) {
      try {
        legacyAssetCollect = await collectDiaryBackupAssets(backupPayload.diaries || []);
        if (legacyAssetCollect.assets.length) {
          assetPayloadForRestore = { ...backupPayload, assets: legacyAssetCollect.assets };
          notify(`这份旧备份只包含图片路径，已尝试从当前服务器补回 ${legacyAssetCollect.assets.length} 张图片。`, 'warning');
        } else {
          notify('这份旧备份只包含图片路径，不包含图片文件本体；文字会恢复，缺失图片需要从原设备或服务器级备份找回。', 'warning');
        }
      } catch (_) {
        notify('这份旧备份只包含图片路径，不包含图片文件本体；文字会恢复，缺失图片需要从原设备或服务器级备份找回。', 'warning');
      }
    }
    const assetRestore = await restoreBackupAssets(assetPayloadForRestore);
    if (assetRestore.failed) {
      notify(`文字已恢复，但有 ${assetRestore.failed} 张图片未恢复。`, 'warning');
    }

    // [诊断日志] 恢复开始摘要
    console.info('[LeafVault:Restore] restoreBackupPayloadToLocalDB 开始:', {
      mode: options.mode || 'merge',
      forceRestore: Boolean(options.forceRestore),
      markPendingSync,
      incomingDiariesCount: backupPayload.diaries?.length || 0,
      incomingLedgersCount: backupPayload.ledgers?.length || 0,
    });

    for (const diary of backupPayload.diaries) {
      const diaryDate = String(diary?.date || '').trim();
      if (isDeletedBackupRecord(diary)) {
        console.info('[LeafVault:Restore] 日记跳过(已删除标记):', { date: diaryDate });
        continue;
      }
      const incomingDiary = normalizeImportedDiary(replaceDiaryImagePathsWithMap(diary, assetRestore.pathMap));
      if (!incomingDiary) {
        skippedDiaries += 1;
        console.info('[LeafVault:Restore] 日记跳过(normalize 返回 null):', { date: diaryDate, hasContent: typeof diary?.content === 'string', mood: diary?.mood_label });
        continue;
      }
      const localDiary = await window.LocalStorage.get('diaries', incomingDiary.date).catch(() => null);
      const baseRevision = normalizeRevision(localDiary?.local_revision);
      const localRevision = Math.max(baseRevision + 1, normalizeRevision(incomingDiary.local_revision));
      const incomingImagePaths = parseDiaryImagePathList(incomingDiary.image_paths || incomingDiary.retained_images || '');
      const localImagePaths = parseDiaryImagePathList(localDiary?.image_paths || localDiary?.retained_images || '');
      const restoreRemovedImages = localImagePaths.filter(path => !incomingImagePaths.includes(path));
      const imagePathText = serializeDiaryImagePathList(incomingImagePaths);
      const restoredDiary = stripSourceOwnershipFields({
        ...incomingDiary,
        date: incomingDiary.date,
        sync_status: markPendingSync ? 1 : Number(incomingDiary.sync_status || 0),
        is_deleted: 0,
        deleted_at: '',
        // 备份恢复会把图片资产重新写入当前账号，旧路径和新路径可能指向同一张图。
        // 同步到服务器时显式带上 removed_images，避免后端把旧路径和新路径合并成重复图片。
        image_paths: imagePathText,
        retained_images: imagePathText,
        removed_images: markPendingSync ? restoreRemovedImages.join(',') : '',
        local_revision: localRevision,
        updated_at: incomingDiary.updated_at || now,
      });
      ignoredDeletes += await discardPendingLocalChangesForEntity('diary', incomingDiary.date, ['delete']);
      try {
        await window.LocalStorage.set('diaries', restoredDiary);
        // 验证写入
        const verify = await window.LocalStorage.get('diaries', incomingDiary.date).catch(() => null);
        if (verify) {
          restoredDiaries += 1;
          console.info('[LeafVault:Restore] 日记恢复成功:', {
            date: incomingDiary.date,
            sync_status: verify.sync_status,
            hadLocal: Boolean(localDiary),
            localRevision,
          });
        } else {
          failedDiaries += 1;
          console.warn('[LeafVault:Restore] 日记写入后验证失败(读取为空):', { date: incomingDiary.date });
        }
      } catch (setError) {
        failedDiaries += 1;
        console.warn('[LeafVault:Restore] 日记 set 失败:', { date: incomingDiary.date, error: setError?.message || String(setError) });
      }
      if (markPendingSync) {
        await createRestoreLocalChange({
          entityType: 'diary',
          entityId: restoredDiary.date,
          operation: localDiary ? 'update' : 'create',
          baseRevision,
          localRevision,
        }).catch((error) => console.warn('备份恢复日记变更日志记录失败', error));
      }
    }

    const localLedgers = typeof window.LocalStorage.getAll === 'function'
      ? await window.LocalStorage.getAll('ledgers').catch(() => [])
      : [];

    for (const ledger of backupPayload.ledgers) {
      if (isDeletedBackupRecord(ledger)) continue;
      const incomingLedger = normalizeImportedLedger(ledger);
      if (!incomingLedger) continue;
      const localLedger = findLocalLedgerForRestore(incomingLedger, localLedgers);
      const restoredLocalId = getRestoreLedgerLocalId(incomingLedger);
      const baseRevision = normalizeRevision(localLedger?.local_revision);
      const localRevision = Math.max(baseRevision + 1, normalizeRevision(incomingLedger.local_revision));
      const restoredLedger = stripSourceOwnershipFields({
        ...incomingLedger,
        local_id: restoredLocalId,
        // 跨账号恢复时不沿用来源账号的服务端标识；用当前恢复 ID 作为本账号上传幂等 uuid。
        uuid: restoredLocalId,
        sync_status: markPendingSync ? 1 : Number(incomingLedger.sync_status || 0),
        is_deleted: 0,
        deleted_at: '',
        local_revision: localRevision,
        updated_at: incomingLedger.updated_at || now,
      });
      if (!restoredLedger.uuid) delete restoredLedger.uuid;
      const entityId = getRestoreLedgerEntityId(restoredLedger);
      const entityIds = buildEntityIdSet(
        restoredLedger.uuid,
        restoredLedger.local_id,
        incomingLedger.uuid,
        incomingLedger.local_id,
        incomingLedger.id,
        localLedger?.uuid,
        localLedger?.local_id,
        localLedger?.id
      );
      ignoredDeletes += await discardPendingLocalChangesForEntity('ledger', entityIds, ['delete']);
      if (localLedger?.local_id && localLedger.local_id !== restoredLedger.local_id) {
        await window.LocalStorage.delete('ledgers', localLedger.local_id).catch(() => null);
      }
      await window.LocalStorage.set('ledgers', restoredLedger);
      localLedgers.push(restoredLedger);
      if (markPendingSync) {
        await createRestoreLocalChange({
          entityType: 'ledger',
          entityId,
          operation: localLedger ? 'update' : 'create',
          baseRevision,
          localRevision,
        }).catch((error) => console.warn('备份恢复账本变更日志记录失败', error));
      }
      restoredLedgers += 1;
    }

    // [诊断日志] 恢复完成摘要
    console.info('[LeafVault:Restore] restoreBackupPayloadToLocalDB 完成:', {
      restoredDiaries,
      restoredLedgers,
      skippedDiaries,
      failedDiaries,
      ignoredDeletes,
    });
    return buildRestoreResult(restoredDiaries, restoredLedgers, ignoredDeletes);
  }

  async function mergeBackupPayloadToLocalDB(backupPayload, options = {}) {
    const mode = options.mode || 'merge';
    if (mode === 'restore' || options.forceRestore) {
      return restoreBackupPayloadToLocalDB(backupPayload, options);
    }
    if (!window.LocalStorage || typeof window.LocalStorage.get !== 'function' || typeof window.LocalStorage.set !== 'function') {
      throw new Error('本地数据库模块尚未加载');
    }

    let restoredDiaries = 0;
    let restoredLedgers = 0;

    for (const diary of backupPayload.diaries) {
      if (isDeletedBackupRecord(diary)) continue;
      const incomingDiary = normalizeImportedDiary(diary);
      if (!incomingDiary) continue;
      const localDiary = await window.LocalStorage.get('diaries', incomingDiary.date);
      if (shouldReplaceDiary(localDiary, incomingDiary)) {
        await window.LocalStorage.set('diaries', incomingDiary);
        restoredDiaries += 1;
      }
    }

    const localLedgers = typeof window.LocalStorage.getAll === 'function'
      ? await window.LocalStorage.getAll('ledgers').catch(() => [])
      : [];
    const knownLedgers = new Set((localLedgers || []).map(getLedgerIdentity));
    const knownLocalIds = new Set((localLedgers || []).map(item => normalizeLedgerText(item.local_id)).filter(Boolean));

    for (const ledger of backupPayload.ledgers) {
      if (isDeletedBackupRecord(ledger)) continue;
      const incomingLedger = normalizeImportedLedger(ledger);
      if (!incomingLedger) continue;
      const identity = getLedgerIdentity(incomingLedger);
      if (knownLedgers.has(identity) || knownLocalIds.has(incomingLedger.local_id)) continue;
      await window.LocalStorage.set('ledgers', incomingLedger);
      knownLedgers.add(identity);
      knownLocalIds.add(incomingLedger.local_id);
      restoredLedgers += 1;
    }

    return buildRestoreResult(restoredDiaries, restoredLedgers, 0);
  }

  async function refreshAfterImport() {
    const nowMs = Date.now();
    if (_refreshAfterImportInFlight) return _refreshAfterImportInFlight;
    if (nowMs - _lastRefreshAfterImportAt < REFRESH_AFTER_IMPORT_THROTTLE_MS) {
      console.info('[LeafVault:Restore] refreshAfterImport 已节流，跳过重复刷新');
      return null;
    }
    _lastRefreshAfterImportAt = nowMs;
    _refreshAfterImportInFlight = (async () => {
    const diarySearch = document.getElementById('diarySearchInput');
    if (diarySearch) diarySearch.value = '';
    if (typeof window.fetchDiaries === 'function') await window.fetchDiaries().catch(() => null);
    if (typeof window.fetchLedgers === 'function') await window.fetchLedgers().catch(() => null);
    if (typeof window.fetchStats === 'function') window.fetchStats();
    if (typeof window.renderCalendar === 'function') window.renderCalendar();
    if (typeof window.renderProfileDiaryArchive === 'function') window.renderProfileDiaryArchive();
    if (typeof window.LeafVaultIncrementalSync?.refreshIncrementalSyncStatus === 'function') {
      window.LeafVaultIncrementalSync.refreshIncrementalSyncStatus();
    }
    if (typeof window.updateBackupStatusPanel === 'function') window.updateBackupStatusPanel();
    // 恢复后主动上传恢复数据到服务器，避免只留在 IndexedDB 中
    if (navigator.onLine && !isDemoMode()) {
      // 日记后台同步（sync_status=1 → POST /api/diaries/）
      if (typeof window.triggerBackgroundSync === 'function') {
        await window.triggerBackgroundSync({ source: 'restore', force: true });
      }
      // 账本后台同步（sync_status=1 → POST /api/ledgers/）
      if (typeof window._syncPendingLedgers === 'function') {
        await window._syncPendingLedgers();
      }
      // 增量同步变更记录上传
      if (typeof window.LeafVaultIncrementalSync?.checkRemoteChangesQuietly === 'function') {
        window.LeafVaultIncrementalSync.checkRemoteChangesQuietly().catch(() => null);
      }
    }
    })();
    try {
      return await _refreshAfterImportInFlight;
    } finally {
      _refreshAfterImportInFlight = null;
    }
  }

  async function importEncryptedBackup(file, password) {
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('导入加密备份'))) return null;
    if (!window.crypto?.subtle) {
      notify('当前浏览器不支持 Web Crypto，无法导入加密备份', true);
      return null;
    }
    if (!file) {
      notify('请选择备份文件', true);
      return null;
    }
    if (!password || password.length < 8) {
      notify('备份密码太短', true);
      return null;
    }

    let encryptedBackup;
    try {
      encryptedBackup = parseEncryptedBackupJson(await file.text());
    } catch (error) {
      notify(error?.message || '备份文件格式不正确', true);
      return null;
    }

    let backupPayload;
    try {
      backupPayload = await decryptBackupPayload(encryptedBackup, password);
    } catch (_) {
      notify('备份密码错误或文件已损坏', true);
      return null;
    }

    try {
      validateBackupPayload(backupPayload);
      const result = await mergeBackupPayloadToLocalDB(backupPayload, {
        mode: 'restore',
        forceRestore: true,
        markPendingSync: true,
        source: 'encrypted_backup_import',
      });
      if (result.diaries || result.ledgers) markLocalDataChanged('encrypted_backup_import');
      await refreshAfterImport();
      if (!result.diaries && !result.ledgers) {
        notify('备份中没有可恢复的数据或均被判定无效', 'warning');
      } else {
        notify(`备份导入完成：已恢复 ${result.diaries} 篇日记、${result.ledgers} 条账本`);
      }
      return result;
    } catch (error) {
      notify(error?.message || '备份文件格式不正确', true);
      return null;
    }
  }

  function ensureBackupFileInput() {
    let input = document.getElementById('encryptedBackupFileInput');
    if (!input) {
      input = document.createElement('input');
      input.id = 'encryptedBackupFileInput';
      input.type = 'file';
      input.accept = '.lvbackup,application/json';
      input.className = 'hidden';
      document.body.appendChild(input);
    }
    return input;
  }

  async function handleImportClick() {
    if (!window.confirm('导入备份会把备份中的日记和账本合并到本地数据中，不会清空现有数据。是否继续？')) {
      return;
    }
    const input = ensureBackupFileInput();
    input.value = '';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const password = await requestBackupPassword('import');
      if (password === null) return;
      if (password.length < 8) {
        notify('备份密码太短', true);
        return;
      }
      await importEncryptedBackup(file, password);
      input.value = '';
    };
    input.click();
  }

  function setupBackupActions() {
    if (document.body?.dataset.backupActionsBound === '1') return;
    if (document.body) document.body.dataset.backupActionsBound = '1';
    document.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-backup-action]');
      if (!btn) return;
      event.preventDefault();
      const action = btn.dataset.backupAction;
      const loadingActions = new Set([
        'export-encrypted',
        'upload-encrypted',
        'refresh-cloud',
        'download-cloud',
        'restore-cloud',
        'delete-cloud',
        'upload-incremental-changes',
        'check-remote-changes',
        'reminder-upload',
      ]);
      if (loadingActions.has(action)) {
        uiState().setButtonLoading?.(btn, true, { text: '处理中...' });
      }
      try {
        if (action === 'export-encrypted') await exportEncryptedBackup();
        if (action === 'import-encrypted') handleImportClick();
        if (action === 'upload-encrypted') await uploadEncryptedBackupSnapshot();
        if (action === 'refresh-cloud') await fetchCloudBackupSnapshots();
        if (action === 'download-cloud') await downloadCloudBackupSnapshot(btn.dataset.snapshotId);
        if (action === 'restore-cloud') await restoreCloudBackupSnapshot(btn.dataset.snapshotId);
        if (action === 'delete-cloud') await deleteCloudBackupSnapshot(btn.dataset.snapshotId);
        if (action === 'upload-incremental-changes') await window.LeafVaultIncrementalSync?.uploadPendingLocalChanges?.();
        if (action === 'check-remote-changes') await window.LeafVaultIncrementalSync?.refreshRemoteChangeStatus?.();
        if (action === 'reminder-upload') await uploadEncryptedBackupSnapshot();
        if (action === 'reminder-snooze') snoozeBackupReminder(24);
        if (action === 'reminder-week') dismissBackupReminderForWeek();
        if (action === 'reminder-dismiss') dismissBackupReminderToday();
      } finally {
        if (loadingActions.has(action)) {
          uiState().setButtonLoading?.(btn, false);
        }
      }
    });
  }

  window.exportEncryptedBackup = exportEncryptedBackup;
  window.importEncryptedBackup = importEncryptedBackup;
  window.uploadEncryptedBackupSnapshot = uploadEncryptedBackupSnapshot;
  window.fetchCloudBackupSnapshots = fetchCloudBackupSnapshots;
  window.downloadCloudBackupSnapshot = downloadCloudBackupSnapshot;
  window.restoreCloudBackupSnapshot = restoreCloudBackupSnapshot;
  window.deleteCloudBackupSnapshot = deleteCloudBackupSnapshot;
  window.buildBackupPayload = buildBackupPayload;
  window.mergeBackupPayloadToLocalDB = mergeBackupPayloadToLocalDB;
  window.discardPendingLocalChangesForEntity = discardPendingLocalChangesForEntity;
  window.getBackupStatus = getBackupStatus;
  window.updateBackupStatusPanel = updateBackupStatusPanel;
  window.shouldShowBackupReminder = shouldShowBackupReminder;
  window.snoozeBackupReminder = snoozeBackupReminder;
  window.dismissBackupReminderForWeek = dismissBackupReminderForWeek;
  window.clearBackupReminderState = clearBackupReminderState;
  window.markLocalDataChanged = markLocalDataChanged;
  window.markCloudBackupUploaded = markCloudBackupUploaded;
  window.LeafVaultBackup = {
    exportEncryptedBackup,
    importEncryptedBackup,
    uploadEncryptedBackupSnapshot,
    fetchCloudBackupSnapshots,
    downloadCloudBackupSnapshot,
    restoreCloudBackupSnapshot,
    deleteCloudBackupSnapshot,
    buildBackupPayload,
    mergeBackupPayloadToLocalDB,
    discardPendingLocalChangesForEntity,
    getBackupStatus,
    updateBackupStatusPanel,
    shouldShowBackupReminder,
    snoozeBackupReminder,
    dismissBackupReminderForWeek,
    clearBackupReminderState,
    markLocalDataChanged,
    markCloudBackupUploaded,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateBackupStatusPanel, { once: true });
  } else {
    updateBackupStatusPanel();
  }
  setupBackupActions();
}(window));
