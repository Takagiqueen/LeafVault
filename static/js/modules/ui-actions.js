// LeafVault shared UI action bindings.
// 这里集中处理模板上的 data-* 事件绑定，避免在 HTML 中继续堆 onclick。

function setupProfileActionBindings() {
  function openSettingsView() {
    const settingsView = document.getElementById('view-settings');
    if (!settingsView) return;
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    settingsView.classList.add('active');
    // 设置页打开时顺手刷新一次云端备份列表，列表渲染仍复用 backup.js。
    window.fetchCloudBackupSnapshots?.();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeSettingsView() {
    // 设置页没有独立底部导航项，返回时沿用原有“我的”页切换逻辑。
    window.switchTab?.('profile');
  }

  const actionMap = {
    'open-settings': openSettingsView,
    'close-settings': closeSettingsView,
    'open-avatar-preview': () => window.openAvatarPreviewModal?.(),
    'close-avatar-preview': () => window.closeAvatarPreviewModal?.(),
    'choose-avatar': () => window.chooseAvatarFromPreview?.(),
    'toggle-password-modal': () => window.togglePwdModal?.(),
    'toggle-username-modal': () => window.toggleUsernameModal?.(),
    'toggle-reset-password-modal': () => window.toggleSettingsResetModal?.(),
    'logout': () => window.logout?.(),
  };

  document.querySelectorAll('[data-profile-action]').forEach((el) => {
    if (el.dataset.profileActionBound === '1') return;
    el.dataset.profileActionBound = '1';
    el.addEventListener('click', () => actionMap[el.dataset.profileAction]?.());
  });

  document.querySelectorAll('[data-stop-click]').forEach((el) => {
    if (el.dataset.stopClickBound === '1') return;
    el.dataset.stopClickBound = '1';
    el.addEventListener('click', (event) => event.stopPropagation());
  });
}

function setupUIActionBindings() {
  const actionMap = {
    'undo': () => window.triggerNativeUndo?.(),
    'redo': () => window.triggerNativeRedo?.(),
    'hide-care-banner': () => document.getElementById('careBanner')?.classList.add('hidden'),
    'export-ledger': () => window.exportLedgerCSV?.(),
    'generate-report': (event) => window.generateReport?.(event),
    'export-report-image': () => window.exportReportImage?.(),
    'trend-range': (event) => window.setTrendRange?.(Number(event.currentTarget.dataset.days || 7)),
  };

  document.querySelectorAll('[data-ui-action]').forEach((el) => {
    if (el.dataset.uiActionBound === '1') return;
    el.dataset.uiActionBound = '1';
    el.addEventListener('click', (event) => actionMap[el.dataset.uiAction]?.(event));
  });
}

function setupProfileCalendarBindings() {
  const grid = document.getElementById('calendarGrid');
  if (!grid || grid.dataset.calendarBound === '1') return;
  grid.dataset.calendarBound = '1';
  grid.addEventListener('click', (event) => {
    const dayCard = event.target.closest('[data-calendar-date]');
    if (!dayCard || !grid.contains(dayCard)) return;
    window.jumpToDiary?.(dayCard.dataset.calendarDate);
  });
}

function setupNavigationAndLightboxBindings() {
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    if (btn.dataset.tabBound === '1') return;
    btn.dataset.tabBound = '1';
    btn.addEventListener('click', () => window.switchTab?.(btn.dataset.tab));
  });

  document.querySelectorAll('[data-lightbox-close]').forEach((el) => {
    if (el.dataset.lightboxBound === '1') return;
    el.dataset.lightboxBound = '1';
    el.addEventListener('click', () => window.closeLightbox?.());
  });
}

function setupMoodPickerBindings() {
  const moodInput = document.getElementById('mood_label_input');
  document.querySelectorAll('.mood-bubble').forEach((bubble) => {
    if (bubble.dataset.moodBound === '1') return;
    bubble.dataset.moodBound = '1';
    bubble.addEventListener('click', () => {
      document.querySelectorAll('.mood-bubble').forEach((el) => el.classList.remove('active'));
      bubble.classList.add('active');
      if (moodInput) moodInput.value = bubble.dataset.mood || '一般';
    });
  });
}

function setupAIPolishBindings() {
  const actionMap = {
    'toggle-model-menu': () => window.toggleAIModelMenu?.(),
    'toggle-style-menu': () => window.toggleAIStyleMenu?.(),
    'polish': () => window.triggerAIPolish?.(),
    'discard-polish': () => window.discardAIPolish?.(),
    'apply-polish': () => window.applyAIPolish?.(),
  };

  document.querySelectorAll('[data-ai-action]').forEach((el) => {
    if (el.dataset.aiActionBound === '1') return;
    el.dataset.aiActionBound = '1';
    el.addEventListener('click', () => actionMap[el.dataset.aiAction]?.());
  });

  document.querySelectorAll('#aiModelMenu .ai-style-option').forEach((btn) => {
    if (btn.dataset.aiModelBound === '1') return;
    btn.dataset.aiModelBound = '1';
    btn.addEventListener('click', () => window.selectAIModel?.(btn));
  });

  document.querySelectorAll('#aiStyleMenu .ai-style-option').forEach((btn) => {
    if (btn.dataset.aiStyleBound === '1') return;
    btn.dataset.aiStyleBound = '1';
    btn.addEventListener('click', () => window.selectAIStyle?.(btn));
  });

  document.addEventListener('click', (event) => {
    const stylePicker = document.getElementById('aiStylePicker');
    const modelPicker = document.getElementById('aiModelPicker');
    if (stylePicker && !stylePicker.contains(event.target)) window.closeAIStyleMenu?.();
    if (modelPicker && !modelPicker.contains(event.target)) window.closeAIModelMenu?.();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    window.closeAIStyleMenu?.();
    window.closeAIModelMenu?.();
  });
}

function setupLeafVaultUIActions() {
  setupProfileActionBindings();
  setupUIActionBindings();
  setupProfileCalendarBindings();
  setupNavigationAndLightboxBindings();
  setupMoodPickerBindings();
  setupAIPolishBindings();
}

window.LeafVaultUIActions = {
  setupLeafVaultUIActions,
  setupProfileActionBindings,
  setupUIActionBindings,
  setupProfileCalendarBindings,
  setupNavigationAndLightboxBindings,
  setupMoodPickerBindings,
  setupAIPolishBindings,
};

setupLeafVaultUIActions();
