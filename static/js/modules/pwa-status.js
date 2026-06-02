(function (window) {
  'use strict';

  const PWA_VERSION = 'leafvault-v0.2.12-css-shell-refresh';
  const UPDATE_DISMISSED_KEY = `LeafVault_pwa_update_dismissed_${PWA_VERSION}`;
  let pendingWorker = null;
  let reloadAfterControllerChange = false;
  let onlineMessageTimer = null;

  function ensureBanner() {
    let banner = document.getElementById('pwaStatusBanner');
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'pwaStatusBanner';
    banner.className = 'pwa-status-banner hidden';
    document.body.appendChild(banner);
    return banner;
  }

  function hidePwaStatusBanner() {
    const banner = ensureBanner();
    banner.classList.add('hidden');
    banner.innerHTML = '';
  }

  function showPwaStatusBanner({ type = 'info', message = '', actions = '', persistent = false } = {}) {
    const banner = ensureBanner();
    banner.className = `pwa-status-banner is-${type}${persistent ? ' is-persistent' : ''}`;
    banner.innerHTML = `
      <span class="pwa-status-text">${escapeHtml(message)}</span>
      ${actions ? `<span class="pwa-status-actions">${actions}</span>` : ''}
    `;
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

  function showOfflineStatus() {
    showPwaStatusBanner({
      type: 'offline',
      message: '当前处于离线状态，本地日记和账本仍可使用，云端备份暂不可用。',
      persistent: true,
    });
  }

  function showOnlineRecoveredStatus() {
    showPwaStatusBanner({
      type: 'online',
      message: '网络已恢复，可以继续使用云端备份功能。',
    });
    clearTimeout(onlineMessageTimer);
    onlineMessageTimer = setTimeout(hidePwaStatusBanner, 3200);
  }

  function showUpdatePrompt(worker) {
    if (!worker || window.localStorage.getItem(UPDATE_DISMISSED_KEY) === '1') return;
    pendingWorker = worker;
    showPwaStatusBanner({
      type: 'update',
      message: 'LeafVault 有新版本可用，刷新后即可体验最新内容。',
      persistent: true,
      actions: `
        <button type="button" data-pwa-action="update-now">立即更新</button>
        <button type="button" data-pwa-action="update-later">稍后</button>
      `,
    });
  }

  function bindPwaStatusActions() {
    if (document.body?.dataset.pwaStatusBound === '1') return;
    if (document.body) document.body.dataset.pwaStatusBound = '1';
    document.addEventListener('click', (event) => {
      const actionBtn = event.target.closest('[data-pwa-action]');
      if (!actionBtn) return;
      event.preventDefault();
      if (actionBtn.dataset.pwaAction === 'update-now' && pendingWorker) {
        reloadAfterControllerChange = true;
        pendingWorker.postMessage({ type: 'SKIP_WAITING' });
      }
      if (actionBtn.dataset.pwaAction === 'update-later') {
        window.localStorage.setItem(UPDATE_DISMISSED_KEY, '1');
        hidePwaStatusBanner();
      }
    });
  }

  function trackRegistration(registration) {
    if (!registration) return;
    if (registration.waiting) showUpdatePrompt(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const installingWorker = registration.installing;
      if (!installingWorker) return;
      installingWorker.addEventListener('statechange', () => {
        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdatePrompt(installingWorker);
        }
      });
    });
  }

  async function registerPWAUpdateHandler() {
    bindPwaStatusActions();
    if (!('serviceWorker' in navigator)) return null;
    const registration = await navigator.serviceWorker.register('/service-worker.js?v=55-css-shell-refresh', {
  scope: '/'
});
    trackRegistration(registration);
    navigator.serviceWorker.ready.then(trackRegistration).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloadAfterControllerChange) return;
      reloadAfterControllerChange = false;
      window.location.reload();
    });
    return registration;
  }

  function setupNetworkStatusBanner() {
    const renderInitialState = () => {
      if (!navigator.onLine) showOfflineStatus();
    };
    window.addEventListener('offline', showOfflineStatus);
    window.addEventListener('online', showOnlineRecoveredStatus);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderInitialState, { once: true });
    } else {
      renderInitialState();
    }
  }

  function ensureOnlineForCloudFeature() {
    if (navigator.onLine) return true;
    showOfflineStatus();
    if (typeof window.showToast === 'function') {
      window.showToast('当前离线，联网后再使用此功能。', true);
    }
    return false;
  }

  window.registerPWAUpdateHandler = registerPWAUpdateHandler;
  window.showPwaStatusBanner = showPwaStatusBanner;
  window.hidePwaStatusBanner = hidePwaStatusBanner;
  window.ensureOnlineForCloudFeature = ensureOnlineForCloudFeature;
  window.LeafVaultPWAStatus = {
    registerPWAUpdateHandler,
    showPwaStatusBanner,
    hidePwaStatusBanner,
    ensureOnlineForCloudFeature,
  };

  setupNetworkStatusBanner();
  registerPWAUpdateHandler().catch(() => {});
}(window));
