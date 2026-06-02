(function (window) {
  'use strict';

  const TOAST_DUPLICATE_MS = 1200;
  const TOAST_DURATION_MS = 3600;
  let lastToastKey = '';
  let lastToastAt = 0;
  let toastTimer = null;

  const ERROR_MESSAGES = {
    network: '网络连接异常，请检查网络后重试。',
    unauthorized: '登录状态已过期，请重新登录。',
    csrf: '登录状态校验失败，请刷新页面或重新登录。',
    forbidden: '你没有权限执行此操作。',
    notFound: '相关数据不存在，可能已经被删除。',
    tooLarge: '文件太大了，请压缩后再上传。',
    unsupportedMedia: '当前文件类型不支持，请上传 JPG、PNG、WEBP 或 GIF 图片。',
    rateLimited: '操作太频繁了，请稍后再试。',
    server: '服务器暂时开小差了，请稍后重试。',
    localDataLocked: '本地数据暂时无法解锁，请使用恢复面板处理本机缓存。',
    decrypt: '解密失败，请检查同步密码或备份密码是否正确。',
    fallback: '操作失败，请稍后重试。',
  };

  const EMPTY_STATE_COPY = {
    diary: '还没有写日记，今天可以先记录一句话。',
    ledger: '还没有账本记录，试着添加一笔收入或支出。',
    cloudBackup: '还没有云端备份，上传一份加密备份后会显示在这里。',
    noConflict: '当前没有需要处理的同步冲突。',
    noSyncHistory: '还没有同步历史，完成一次手动同步后会显示在这里。',
  };

  const SENSITIVE_PATTERNS = [
    /bearer\s+[a-z0-9._-]+/ig,
    /leafvault_access_token=[^;\s]+/ig,
    /leafvault_csrf_token=[^;\s]+/ig,
    /("?(?:token|csrf|password|key|payload|encrypted_blob|encrypted_change)"?\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/ig,
  ];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function sanitizeMessage(value) {
    let text = String(value ?? '').trim();
    if (!text) return '';
    SENSITIVE_PATTERNS.forEach((pattern) => {
      text = text.replace(pattern, (match, prefix) => (prefix ? `${prefix}[REDACTED]` : '[REDACTED]'));
    });
    text = text.replace(/\s+/g, ' ');
    if (text.length > 180) text = `${text.slice(0, 180)}...`;
    return text;
  }

  function getErrorStatus(error) {
    return Number(error?.status || error?.statusCode || error?.response?.status || 0);
  }

  function normalizeUserFacingError(error) {
    if (typeof error === 'number') {
      return normalizeUserFacingError({ status: error });
    }
    const status = getErrorStatus(error);
    const raw = sanitizeMessage(
      error?.userMessage
      || error?.message
      || error?.detail
      || error?.statusText
      || error
    );
    const lower = raw.toLowerCase();

    if (status === 401 || lower.includes('unauthorized') || lower.includes('token expired')) {
      return ERROR_MESSAGES.unauthorized;
    }
    if (status === 403 && (lower.includes('csrf') || lower.includes('validation failed'))) {
      return ERROR_MESSAGES.csrf;
    }
    if (status === 403) return ERROR_MESSAGES.forbidden;
    if (status === 404) return ERROR_MESSAGES.notFound;
    if (status === 413 || lower.includes('too large') || lower.includes('文件太大')) {
      return ERROR_MESSAGES.tooLarge;
    }
    if (status === 415 || lower.includes('unsupported media') || lower.includes('文件类型')) {
      return ERROR_MESSAGES.unsupportedMedia;
    }
    if (status === 429) return ERROR_MESSAGES.rateLimited;
    if (status >= 500) return ERROR_MESSAGES.server;
    if (
      lower.includes('fetch failed')
      || lower.includes('failed to fetch')
      || lower.includes('network')
      || lower.includes('load failed')
      || lower.includes('abort')
    ) {
      return ERROR_MESSAGES.network;
    }
    if (
      lower.includes('本地加密数据')
      || lower.includes('本地数据暂时无法解锁')
      || lower.includes('local encryption')
      || lower.includes('local data')
    ) {
      return ERROR_MESSAGES.localDataLocked;
    }
    if (
      lower.includes('decrypt')
      || lower.includes('解密')
      || lower.includes('密码错误')
      || lower.includes('已损坏')
    ) {
      return ERROR_MESSAGES.decrypt;
    }
    return raw || ERROR_MESSAGES.fallback;
  }

  function resolveContainer(container) {
    if (!container) return null;
    if (typeof container === 'string') return document.querySelector(container);
    return container;
  }

  function renderStateCard(container, type, options = {}) {
    const target = resolveContainer(container);
    if (!target) return null;
    const icon = options.icon || (type === 'error' ? '!' : type === 'loading' ? '...' : '·');
    const title = options.title || (type === 'error' ? '加载失败' : type === 'loading' ? '正在加载...' : '暂无内容');
    const description = options.description || '';
    const compact = options.compact ? ' is-compact' : '';
    const role = type === 'error' ? ' role="alert" aria-live="assertive"' : ' aria-live="polite"';
    const skeleton = options.skeleton
      ? '<div class="ui-skeleton"><span></span><span></span><span></span></div>'
      : '';
    const actionHtml = options.actionText
      ? `<button type="button" class="ui-state-action" data-ui-state-action>${escapeHtml(options.actionText)}</button>`
      : '';

    target.innerHTML = `
      <div class="ui-state-card ui-state-${escapeHtml(type)}${compact}"${role}>
        <span class="ui-state-icon" aria-hidden="true">${escapeHtml(icon)}</span>
        <strong class="ui-state-title">${escapeHtml(title)}</strong>
        ${description ? `<p class="ui-state-description">${escapeHtml(description)}</p>` : ''}
        ${skeleton}
        ${actionHtml}
      </div>
    `;

    const button = target.querySelector('[data-ui-state-action]');
    if (button && typeof options.onAction === 'function') {
      button.addEventListener('click', options.onAction, { once: false });
    }
    return target.firstElementChild;
  }

  function renderEmptyState(container, options = {}) {
    return renderStateCard(container, 'empty', {
      icon: options.icon || '·',
      title: options.title || '暂无内容',
      description: options.description || '',
      actionText: options.actionText,
      onAction: options.onAction,
      compact: options.compact,
    });
  }

  function renderLoadingState(container, options = {}) {
    return renderStateCard(container, 'loading', {
      icon: options.icon || '...',
      title: options.title || '正在加载...',
      description: options.description || '请稍等一下。',
      skeleton: options.skeleton !== false,
      compact: options.compact,
    });
  }

  function renderErrorState(container, options = {}) {
    const description = options.description || normalizeUserFacingError(options.detail || options.error || '');
    return renderStateCard(container, 'error', {
      icon: options.icon || '!',
      title: options.title || '加载失败',
      description,
      actionText: options.retryText,
      onAction: options.onRetry,
      compact: options.compact,
    });
  }

  function setButtonLoading(button, loading, options = {}) {
    if (!button) return;
    const target = button;
    if (loading) {
      if (!target.dataset.uiOriginalHtml) target.dataset.uiOriginalHtml = target.innerHTML;
      target.disabled = true;
      target.setAttribute('aria-busy', 'true');
      const text = options.text || '处理中...';
      target.innerHTML = `<span class="ui-button-spinner" aria-hidden="true"></span><span>${escapeHtml(text)}</span>`;
      return;
    }
    if (target.dataset.uiOriginalHtml) {
      target.innerHTML = target.dataset.uiOriginalHtml;
      delete target.dataset.uiOriginalHtml;
    }
    target.disabled = Boolean(options.disabled);
    target.removeAttribute('aria-busy');
  }

  function showInlineStatus(container, type, message) {
    const target = resolveContainer(container);
    if (!target) return null;
    const safeType = ['success', 'info', 'warning', 'error', 'loading'].includes(type) ? type : 'info';
    const role = safeType === 'error' ? 'alert' : 'status';
    target.innerHTML = `<div class="ui-inline-status ui-inline-${safeType}" role="${role}" aria-live="${safeType === 'error' ? 'assertive' : 'polite'}">${escapeHtml(normalizeStatusMessage(safeType, message))}</div>`;
    return target.firstElementChild;
  }

  function normalizeStatusMessage(type, message) {
    if (type === 'error') return normalizeUserFacingError(message);
    return sanitizeMessage(message) || (type === 'loading' ? '正在处理...' : '已更新');
  }

  function clearInlineStatus(container) {
    const target = resolveContainer(container);
    if (target) target.innerHTML = '';
  }

  function ensureToastElement() {
    let toast = document.getElementById('toast');
    if (toast) return toast;
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'ui-toast hidden';
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');
    document.body.appendChild(toast);
    return toast;
  }

  function showToast(message, typeOrIsError = 'info') {
    const type = typeOrIsError === true ? 'error' : typeOrIsError === false ? 'success' : String(typeOrIsError || 'info');
    const safeType = ['success', 'info', 'warning', 'error', 'loading'].includes(type) ? type : 'info';
    const text = safeType === 'error' ? normalizeUserFacingError(message) : sanitizeMessage(message);
    if (!text) return;

    const key = `${safeType}:${text}`;
    const now = Date.now();
    if (key === lastToastKey && now - lastToastAt < TOAST_DUPLICATE_MS) return;
    lastToastKey = key;
    lastToastAt = now;

    const toast = ensureToastElement();
    toast.className = `ui-toast ui-toast-${safeType} is-visible`;
    toast.innerHTML = `
      <span class="ui-toast-message">${escapeHtml(text)}</span>
      <button type="button" class="ui-toast-close" aria-label="关闭提示">×</button>
    `;
    toast.querySelector('.ui-toast-close')?.addEventListener('click', () => hideToast(toast), { once: true });
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => hideToast(toast), TOAST_DURATION_MS);
  }

  function hideToast(toast = ensureToastElement()) {
    toast.classList.remove('is-visible');
    toast.classList.add('hidden');
  }

  const api = {
    renderEmptyState,
    renderLoadingState,
    renderErrorState,
    setButtonLoading,
    showInlineStatus,
    clearInlineStatus,
    normalizeUserFacingError,
    showToast,
    EMPTY_STATE_COPY,
  };

  window.LeafVaultUIState = api;
  window.renderEmptyState = renderEmptyState;
  window.renderLoadingState = renderLoadingState;
  window.renderErrorState = renderErrorState;
  window.setButtonLoading = setButtonLoading;
  window.showInlineStatus = showInlineStatus;
  window.clearInlineStatus = clearInlineStatus;
  window.normalizeUserFacingError = normalizeUserFacingError;
  window.showToast = showToast;
}(window));
