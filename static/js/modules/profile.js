// LeafVault profile module.
// 负责个人资料、头像、用户名/密码弹窗，以及个人中心生活日历。

const dailyGreetingLines = [
  '今天也把生活好好保存下来吧。',
  '愿今天的每一件小事都被温柔收好。',
  '慢慢来，把今天过成值得回看的样子。',
  '给今天留一点记录，也给自己留一点光。',
  '把日常安放好，心也会轻一点。',
  '今天也认真生活，轻轻收藏每个片刻。',
  '愿你的今天有热汤、有好心情、有被记住的小确幸。',
  '把今天写下来，未来会感谢现在的你。',
  '生活正在发生，LeafVault 会替你好好收着。',
  '今天也别急，重要的片刻会慢慢发亮。',
];

const profileMonthPicker = typeof createMonthPicker === 'function' ? createMonthPicker({
  fieldId: 'profileMonthField',
  inputId: 'calendarMonthPicker',
  textId: 'calendarMonthText',
  triggerId: 'calendarMonthTrigger',
  panelId: 'profileMonthPicker',
  titleId: 'profileYearTitle',
  gridId: 'profileMonthGrid',
  prevId: 'profileYearPrev',
  nextId: 'profileYearNext',
}) : {
  syncButton() {
    const input = document.getElementById('calendarMonthPicker');
    const text = document.getElementById('calendarMonthText');
    if (input && text) text.textContent = formatMonthLabel(input.value);
  },
  render() {},
  show() {
    document.getElementById('calendarMonthPicker')?.showPicker?.();
  },
  hide() {},
  setup() {
    document.getElementById('calendarMonthTrigger')?.addEventListener('click', () => this.show());
  },
};

function syncProfileMonthButton() {
  profileMonthPicker.syncButton();
}

function renderProfileMonthPicker() {
  profileMonthPicker.render();
}

function showProfileMonthPicker() {
  profileMonthPicker.show();
}

function hideProfileMonthPicker() {
  profileMonthPicker.hide();
}

function setupProfileMonthPicker() {
  profileMonthPicker.setup();
}

function updateProfileGreeting(username = 'LeafVault') {
  const titleEl = document.getElementById('profileGreetingTitle');
  const textEl = document.getElementById('profileGreetingText');
  if (!titleEl || !textEl) return;
  const safeName = (username || 'LeafVault').trim() || 'LeafVault';
  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  titleEl.textContent = `你好，${safeName}`;
  textEl.textContent = dailyGreetingLines[seed % dailyGreetingLines.length];
}

function isDemoMode() {
  return Boolean(window.LeafVaultSession?.isDemoMode?.());
}

function showDemoLocalOnlyNotice() {
  showToast('Demo 模式仅支持本地体验。云端备份、多设备同步和账号设置需要正式账号。', true);
}

function renderDemoProfile() {
  document.getElementById('profileUsername').textContent = 'Demo 访客';
  document.getElementById('profileEmail').textContent = '仅保存在当前浏览器';
  updateProfileGreeting('Demo');
  const avatar = document.getElementById('avatarDisplay');
  if (avatar) {
    avatar.style.backgroundImage = '';
    avatar.innerText = 'D';
  }
}

async function fetchProfile() {
  if (isDemoMode()) {
    renderDemoProfile();
    return;
  }
  try {
    const res = await apiFetch('/api/user/info');
    const json = await res.json();

    if (json.status === 'success') {
      if (json.data.user_id) {
        setCurrentUserId(json.data.user_id);
        await initLocalDB().catch(() => {});
      }
      document.getElementById('profileUsername').textContent = json.data.username;
      document.getElementById('profileEmail').textContent = json.data.email || '未绑定邮箱';
      updateProfileGreeting(json.data.username);
      if (json.data.avatar_url) {
        document.getElementById('avatarDisplay').style.backgroundImage = `url(${json.data.avatar_url})`;
        document.getElementById('avatarDisplay').innerText = '';
      }
    }
  } catch (error) {}
}

async function uploadAvatar(event) {
  if (isDemoMode()) {
    showDemoLocalOnlyNotice();
    event.target.value = '';
    return;
  }
  const file = event.target.files[0];
  if (!file) return;

  const compressed = await compressImage(file, 400, 0.85);
  const formData = new FormData();
  formData.append('avatar', compressed);

  try {
    const res = await apiFetch('/api/user/avatar', { method: 'POST', body: formData });
    const json = await res.json();
    if (json.status === 'success') {
      showToast('头像更新成功');
      document.getElementById('avatarDisplay').style.backgroundImage = `url(${json.avatar_url})`;
      document.getElementById('avatarDisplay').innerText = '';
      closeAvatarPreviewModal();
    }
  } catch (error) {
    showToast('头像上传失败', true);
  }
  event.target.value = '';
}

function getCurrentAvatarUrl() {
  const avatar = document.getElementById('avatarDisplay');
  const bg = avatar?.style.backgroundImage || '';
  const match = bg.match(/url\(["']?(.*?)["']?\)/);
  return match ? match[1] : '';
}

function openAvatarPreviewModal() {
  const modal = document.getElementById('avatarPreviewModal');
  const panel = document.getElementById('avatarPreviewPanel');
  const preview = document.getElementById('avatarPreviewImage');
  if (!modal || !panel || !preview) return;
  const url = getCurrentAvatarUrl();
  preview.style.backgroundImage = url ? `url("${url}")` : '';
  preview.classList.toggle('avatar-preview-placeholder', !url);
  preview.innerHTML = url ? '' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="8" r="4"></circle></svg>';
  modal.classList.remove('hidden');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
    panel.classList.remove('scale-95');
    panel.classList.add('scale-100');
  }, 10);
}

function closeAvatarPreviewModal() {
  const modal = document.getElementById('avatarPreviewModal');
  const panel = document.getElementById('avatarPreviewPanel');
  if (!modal || !panel || modal.classList.contains('hidden')) return;
  modal.classList.add('opacity-0');
  panel.classList.remove('scale-100');
  panel.classList.add('scale-95');
  setTimeout(() => modal.classList.add('hidden'), 220);
}

function chooseAvatarFromPreview() {
  closeAvatarPreviewModal();
  setTimeout(() => document.getElementById('avatarUploadInput')?.click(), 240);
}

function togglePwdModal() {
  const modal = document.getElementById('pwdModal');
  const content = document.getElementById('pwdModalContent');
  if (modal.classList.contains('hidden')) {
    modal.classList.remove('hidden');
    setTimeout(() => {
      modal.classList.remove('opacity-0');
      content.classList.remove('scale-95');
      content.classList.add('scale-100');
    }, 10);
  } else {
    modal.classList.add('opacity-0');
    content.classList.remove('scale-100');
    content.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
  }
}

function toggleUsernameModal() {
  const modal = document.getElementById('usernameModal');
  const content = document.getElementById('usernameModalContent');
  const input = document.getElementById('newUsernameInput');
  if (modal.classList.contains('hidden')) {
    if (input) input.value = document.getElementById('profileUsername')?.textContent?.trim() || '';
    modal.classList.remove('hidden');
    setTimeout(() => {
      modal.classList.remove('opacity-0');
      content.classList.remove('scale-95');
      content.classList.add('scale-100');
      input?.focus();
    }, 10);
  } else {
    modal.classList.add('opacity-0');
    content.classList.remove('scale-100');
    content.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
  }
}

function getCurrentAccountForPasswordVerify() {
  const emailText = document.getElementById('profileEmail')?.textContent?.trim() || '';
  if (emailText && emailText.includes('@') && emailText !== '未绑定邮箱') return emailText;
  const loginAccount = document.querySelector('#loginForm input[name="account"]')?.value?.trim() || '';
  return loginAccount.includes('@') ? loginAccount : '';
}

async function verifyOldPasswordBeforeLocalMigration(oldPassword) {
  const account = getCurrentAccountForPasswordVerify();
  if (!account) return { ok: true, skipped: true };
  const verifyData = new FormData();
  verifyData.append('account', account);
  verifyData.append('password', oldPassword);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      body: verifyData,
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => ({}));
    return { ok: json?.status === 'success', skipped: false };
  } catch (_) {
    return { ok: false, skipped: false, stage: 'verify_old_password' };
  }
}

function getPasswordMigrationErrorMessage(error) {
  const stage = error?.stage || '';
  if (stage === 'verify_old_password') return '原密码不正确。';
  if (stage === 'read_local_db') return '本地数据读取失败，已阻止修改密码。请先导出备份或清理本地数据。';
  if (stage === 'decrypt_old_data') return '发现无法解密的本地数据，为避免数据丢失，已阻止修改密码。请先导出备份或清理本地数据。';
  if (stage === 'encrypt_new_data') return '本地数据重新加密失败，已阻止修改密码。请先导出备份或清理本地数据。';
  if (stage === 'refresh_trusted_unlock') return '密码已修改，请重新解锁本地加密空间。';
  return error?.userMessage || '本地数据迁移失败，已阻止修改密码。请先导出本地加密备份。';
}

async function handleChangePassword(event) {
  event.preventDefault();
  if (isDemoMode()) return showDemoLocalOnlyNotice();
  const form = event.target;
  const formData = new FormData(form);
  const oldPassword = String(formData.get('old_password') || '');
  const newPassword = String(formData.get('new_password') || '');
  let migrationResult = { ok: true, mode: 'noop', migrated: 0, migratedCount: 0 };
  try {
    console.info('change password: start');
    console.info('change password: current userId', window.LeafVaultSession?.getCurrentUserId?.() || window.getCurrentUserId?.() || '(none)');
    console.info('change password: CryptoEngine.hasKey()', Boolean(window.CryptoEngine?.hasKey?.()));
    if (!oldPassword || !newPassword) {
      showToast('请填写原密码和新密码。', true);
      return;
    }
    if (typeof window.LeafVaultSession?.migrateLocalDataWithPasswords !== 'function') {
      showToast('本地加密迁移能力暂不可用，已阻止修改密码。请先导出本地加密备份。', true);
      return;
    }
    const verifyResult = await verifyOldPasswordBeforeLocalMigration(oldPassword);
    if (!verifyResult.ok) {
      console.info('change password: failed stage', 'verify_old_password');
      showToast('原密码不正确。', true);
      return;
    }
    // 修改后端密码前，先确认本地 IndexedDB 能从旧密码迁移到新密码。
    // 如果后端修改失败，会尽量把本地缓存回滚到旧密码，避免出现半迁移状态。
    try {
      migrationResult = await window.LeafVaultSession.migrateLocalDataWithPasswords(oldPassword, newPassword, {
        refreshTrustedUnlock: false,
        // 只有原密码已被后端登录校验过时，才允许复用当前内存 key；否则必须用原密码派生 key 读取，避免旧密码输错后本地数据被迁到错误 key。
        preferCurrentKey: verifyResult.skipped !== true,
      });
      console.info('change password: migration mode', migrationResult?.mode || 'unknown');
    } catch (error) {
      console.info('change password: failed stage', error?.stage || 'unknown');
      showToast(getPasswordMigrationErrorMessage(error), true);
      return;
    }

    const res = await apiFetch('/api/user/password', { method: 'POST', body: formData });
    const json = await res.json();
    if (json.status === 'success') {
      let trustedRefresh = null;
      try {
        trustedRefresh = await window.LeafVaultSession.refreshTrustedUnlockAfterPasswordChange?.(newPassword);
      } catch (_) {
        showToast('密码已修改，请重新解锁本地加密空间。', true);
      }
      if (migrationResult?.mode === 'noop') {
        showToast('未发现需要迁移的本地加密数据，已直接修改密码。');
      } else if (trustedRefresh?.sealCached === false) {
        showToast('密码已修改，请重新解锁本地加密空间。', true);
      } else {
        showToast('密码修改成功，本地加密空间已迁移到新密码。');
      }
      togglePwdModal();
      form.reset();
    } else {
      console.info('change password: failed stage', 'backend_change_password');
      if (migrationResult?.mode === 'migrated') {
        try {
          await window.LeafVaultSession.migrateLocalDataWithPasswords(newPassword, oldPassword, { refreshTrustedUnlock: false, preferCurrentKey: false });
        } catch (_) {
          showToast('后端密码未修改，但本地缓存回滚失败。请不要刷新页面，先导出本地加密备份。', true);
          return;
        }
      }
      showToast(String(json.message || '').includes('原密码') ? '原密码不正确。' : '服务器修改密码失败，请稍后重试。', true);
    }
  } catch (error) {
    console.info('change password: failed stage', 'backend_change_password');
    if (migrationResult?.mode === 'migrated') {
      try {
        await window.LeafVaultSession.migrateLocalDataWithPasswords(newPassword, oldPassword, { refreshTrustedUnlock: false, preferCurrentKey: false });
      } catch (_) {
        showToast('修改密码失败，且本地缓存回滚失败。请不要刷新页面，先导出本地加密备份。', true);
        return;
      }
    }
    showToast('服务器修改密码失败，请稍后重试。', true);
  }
}

async function handleChangeUsername(event) {
  event.preventDefault();
  if (isDemoMode()) return showDemoLocalOnlyNotice();
  const formData = new FormData(event.target);
  const newUsername = (formData.get('new_username') || '').trim();
  formData.set('new_username', newUsername);
  try {
    const res = await apiFetch('/api/user/username', { method: 'POST', body: formData });
    const json = await res.json();
    if (json.status === 'success') {
      if (json.token) LeafVaultSession.setAuthToken(json.token);
      document.getElementById('profileUsername').textContent = json.username;
      updateProfileGreeting(json.username);
      toggleUsernameModal();
      event.target.reset();
      showToast('用户名修改成功');
      fetchProfile();
      fetchDiaries();
      fetchLedgers();
      renderCalendar();
    } else {
      showToast(json.message, true);
    }
  } catch (error) {
    showToast('用户名修改失败，请稍后重试', true);
  }
}

async function getDemoCalendarData(monthValue) {
  const expenses = {};
  const moods = {};
  const ledgers = await LocalStorage.getAll('ledgers').catch(() => []);
  const diaries = await LocalStorage.getAll('diaries').catch(() => []);
  (ledgers || []).forEach((ledger) => {
    const dateKey = ledger.created_at || ledger.date || '';
    if (!dateKey.startsWith(monthValue) || ledger.type === 'income' || ledger.is_deleted) return;
    expenses[dateKey] = Number(expenses[dateKey] || 0) + Number(ledger.amount || 0);
  });
  (diaries || []).forEach((diary) => {
    const dateKey = diary.date || '';
    if (!dateKey.startsWith(monthValue) || !diary.mood_label) return;
    moods[dateKey] = diary.mood_label;
  });
  return { expenses, moods };
}

async function renderCalendar() {
  const monthInput = document.getElementById('calendarMonthPicker');
  const monthValue = monthInput.value;
  syncProfileMonthButton();
  const [year, month] = monthValue.split('-');
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  let expenses = {};
  let moods = {};
  try {
    if (isDemoMode()) {
      const demoData = await getDemoCalendarData(monthValue);
      expenses = demoData.expenses;
      moods = demoData.moods;
    } else {
    const res = await apiFetch(`/api/calendar?month=${monthValue}`);
    const json = await res.json();
    if (json.status === 'success') {
      expenses = json.data.expenses;
      moods = json.data.moods;
    }
    }
  } catch (error) {}

  let html = '';
  for (let i = 0; i < firstDay; i++) html += '<div class="life-calendar-blank" aria-hidden="true"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${year}-${month}-${String(day).padStart(2, '0')}`;
    const expenseAmount = expenses[dateKey];
    const expenseHtml = expenseAmount ? `<span class="life-expense">-¥${expenseAmount.toFixed(0)}</span>` : '<span class="life-expense life-expense-empty" aria-hidden="true"></span>';
    const moodHtml = moods[dateKey] ? `<span class="life-mood-icon">${moodIconSvg(moods[dateKey])}</span>` : '<span class="life-mood-spacer" aria-hidden="true"></span>';
    const isToday = dateKey === formatDateValue(new Date());
    const hasEntry = Boolean(expenseAmount || moods[dateKey]);
    html += `<button type="button" data-calendar-date="${dateKey}" class="life-calendar-card ${isToday ? 'is-today' : ''} ${hasEntry ? 'has-entry' : ''}" aria-label="${dateKey}"><span class="life-calendar-top"><span class="life-day-number">${day}</span>${moodHtml}</span>${expenseHtml}</button>`;
  }
  document.getElementById('calendarGrid').innerHTML = html;
}

function setupProfileForms() {
  const passwordForm = document.getElementById('changePwdForm');
  const usernameForm = document.getElementById('changeUsernameForm');
  const avatarInput = document.getElementById('avatarUploadInput');
  const calendarInput = document.getElementById('calendarMonthPicker');

  if (passwordForm && passwordForm.dataset.profileBound !== '1') {
    passwordForm.dataset.profileBound = '1';
    passwordForm.addEventListener('submit', handleChangePassword);
  }
  if (usernameForm && usernameForm.dataset.profileBound !== '1') {
    usernameForm.dataset.profileBound = '1';
    usernameForm.addEventListener('submit', handleChangeUsername);
  }
  if (avatarInput && avatarInput.dataset.profileBound !== '1') {
    avatarInput.dataset.profileBound = '1';
    avatarInput.addEventListener('change', uploadAvatar);
  }
  if (calendarInput && calendarInput.dataset.profileBound !== '1') {
    calendarInput.dataset.profileBound = '1';
    calendarInput.addEventListener('change', renderCalendar);
  }
}

setupProfileForms();

window.LeafVaultProfile = {
  syncProfileMonthButton,
  renderProfileMonthPicker,
  showProfileMonthPicker,
  hideProfileMonthPicker,
  setupProfileMonthPicker,
  updateProfileGreeting,
  fetchProfile,
  uploadAvatar,
  openAvatarPreviewModal,
  closeAvatarPreviewModal,
  chooseAvatarFromPreview,
  togglePwdModal,
  toggleUsernameModal,
  renderCalendar,
};
window.syncProfileMonthButton = syncProfileMonthButton;
window.renderProfileMonthPicker = renderProfileMonthPicker;
window.showProfileMonthPicker = showProfileMonthPicker;
window.hideProfileMonthPicker = hideProfileMonthPicker;
window.setupProfileMonthPicker = setupProfileMonthPicker;
window.updateProfileGreeting = updateProfileGreeting;
window.fetchProfile = fetchProfile;
window.uploadAvatar = uploadAvatar;
window.openAvatarPreviewModal = openAvatarPreviewModal;
window.closeAvatarPreviewModal = closeAvatarPreviewModal;
window.chooseAvatarFromPreview = chooseAvatarFromPreview;
window.togglePwdModal = togglePwdModal;
window.toggleUsernameModal = toggleUsernameModal;
window.renderCalendar = renderCalendar;
