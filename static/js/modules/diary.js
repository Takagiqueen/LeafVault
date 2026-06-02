// LeafVault diary module. Extracted from templates/index.html without changing behavior.
// It intentionally keeps legacy global function names while newer UI uses event delegation.

// 时光日记模块
// ====================================================
let retainedImages = [], demoRetainedImages = [], removedRetainedImages = [], newImageFiles = [], allDiariesData = [], profileArchiveData = [], profileArchiveMonth = 'recent', searchTimer = null;
let currentDiaryDetail = null;
let currentDiaryServerUpdatedAt = '';
let currentDiaryServerContent = '';
let currentDiaryServerMood = '一般';
let currentDiaryServerImagePaths = '';
let activeDiaryDateValue = '';
let diaryLoadSequence = 0;
let hasRemovedRetainedDiaryImage = false;
const HOME_RECENT_DAYS_LIMIT = 3;
const DIARY_PIN_LIMIT = 5;
const DIARY_PIN_LIMIT_MESSAGE = `最多只能置顶 ${DIARY_PIN_LIMIT} 篇日记，请先取消一篇置顶`;

function diaryMatchesKeyword(diary, keyword) {
  if (!keyword) return true;
  const kw = keyword.toLowerCase();
  return (
    (diary.content || '').toLowerCase().includes(kw) ||
    (diary.mood_label || '').toLowerCase().includes(kw) ||
    (diary.date || '').includes(kw)
  );
}

function isDiaryPinned(diary) {
  return Number(diary?.is_pinned || 0) === 1;
}

function sortDiariesForDisplay(diaries) {
  return [...diaries].sort((a, b) => {
    if (isDiaryPinned(a) && !isDiaryPinned(b)) return -1;
    if (!isDiaryPinned(a) && isDiaryPinned(b)) return 1;
    return new Date(b.date) - new Date(a.date);
  });
}

function getKnownDiaryMap() {
  const map = new Map();
  [profileArchiveData, allDiariesData].forEach((items) => {
    (items || []).forEach((diary) => {
      if (diary?.date && !map.has(diary.date)) map.set(diary.date, diary);
    });
  });
  if (currentDiaryDetail?.date && !map.has(currentDiaryDetail.date)) {
    map.set(currentDiaryDetail.date, currentDiaryDetail);
  }
  return map;
}

function shouldPreventDiaryPin(dateStr) {
  const knownDiaries = getKnownDiaryMap();
  const target = knownDiaries.get(dateStr);
  if (isDiaryPinned(target)) return false;
  const pinnedCount = Array.from(knownDiaries.values()).filter(isDiaryPinned).length;
  return pinnedCount >= DIARY_PIN_LIMIT;
}

function patchDiaryPinState(items, dateStr, isPinned) {
  return (items || []).map((diary) => (
    diary?.date === dateStr ? { ...diary, is_pinned: isPinned ? 1 : 0 } : diary
  ));
}

async function persistLocalDiaryPinState(dateStr, isPinned) {
  if (!window.LocalStorage) return;
  try {
    const localDiary = await LocalStorage.get('diaries', dateStr);
    if (localDiary) {
      await LocalStorage.set('diaries', { ...localDiary, is_pinned: isPinned ? 1 : 0 });
    }
  } catch (error) {
    console.warn('更新本地置顶缓存失败，将以服务器数据为准:', error);
  }
}

async function syncDiaryPinState(dateStr, isPinned) {
  allDiariesData = sortDiariesForDisplay(patchDiaryPinState(allDiariesData, dateStr, isPinned));
  profileArchiveData = sortDiariesForDisplay(patchDiaryPinState(profileArchiveData, dateStr, isPinned));
  if (currentDiaryDetail?.date === dateStr) {
    currentDiaryDetail = { ...currentDiaryDetail, is_pinned: isPinned ? 1 : 0 };
    updateDiaryDetailPinButton(currentDiaryDetail);
  }
  renderProfileDiaryArchive();
  await persistLocalDiaryPinState(dateStr, isPinned);
  const keyword = document.getElementById('diarySearchInput')?.value.trim() || '';
  await fetchDiaries(keyword);
}

function renderDiaryPinButton(dateStr, isPinned, actionAttribute) {
  const safeDate = escapeHtml(dateStr || '');
  const pinned = Boolean(Number(isPinned || 0));
  const label = pinned ? '取消置顶' : '置顶';
  const activeClass = pinned ? ' is-active' : '';
  return `
    <button type="button"
            ${actionAttribute}
            data-date="${safeDate}"
            class="diary-pin-toggle-btn${activeClass}"
            aria-label="${label} ${safeDate}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4.5 19.5 10l-2.2 2.2 1.3 4.7-1.4 1.4-4.7-3.1-3.8 3.8-.9-.9 3.8-3.8-3.1-4.7 1.4-1.4 4.7 1.3L16.8 7 14 4.5Z"/>
        <path d="M5 19l4-4"/>
      </svg>
      <span>${label}</span>
    </button>`;
}

window.LeafVaultDiaryPin = {
  limit: DIARY_PIN_LIMIT,
  limitMessage: DIARY_PIN_LIMIT_MESSAGE,
  shouldPreventPin: shouldPreventDiaryPin,
  syncAfterToggle: syncDiaryPinState,
};

function parseDiaryDate(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function sortDiariesByDateDesc(diaries) {
  return [...(diaries || [])].sort((a, b) => {
    const aTime = parseDiaryDate(a.date)?.getTime() || 0;
    const bTime = parseDiaryDate(b.date)?.getTime() || 0;
    return bTime - aTime;
  });
}

function getHomeTimelineData(diaries, keyword = '') {
  const recentDates = new Set();
  const allItems = diaries || [];

  for (const diary of sortDiariesByDateDesc(allItems)) {
    if (!diary.date || recentDates.has(diary.date)) continue;
    recentDates.add(diary.date);
    if (recentDates.size >= HOME_RECENT_DAYS_LIMIT) break;
  }

  const pinnedItems = sortDiariesByDateDesc(
    allItems.filter(diary => Number(diary.is_pinned || 0) === 1 && diaryMatchesKeyword(diary, keyword))
  ).map(diary => ({ ...diary, __home_section: 'pinned' }));

  const recentItems = sortDiariesByDateDesc(
    allItems.filter(diary => {
      if (Number(diary.is_pinned || 0) === 1) return false;
      return recentDates.has(diary.date) && diaryMatchesKeyword(diary, keyword);
    })
  ).map(diary => ({ ...diary, __home_section: 'recent' }));

  return [...pinnedItems, ...recentItems];
}

function getRecentMonthCutoffDate() {
  const today = parseDiaryDate(formatDateValue(new Date())) || new Date();
  const cutoff = new Date(today);
  cutoff.setMonth(cutoff.getMonth() - 1);
  cutoff.setHours(0, 0, 0, 0);
  return cutoff;
}

function isDiaryInRecentMonth(diary) {
  const date = parseDiaryDate(diary?.date);
  if (!date) return false;
  const today = parseDiaryDate(formatDateValue(new Date())) || new Date();
  today.setHours(23, 59, 59, 999);
  return date >= getRecentMonthCutoffDate() && date <= today;
}

function getArchiveMonths(diaries) {
  return Array.from(new Set(
    sortDiariesByDateDesc(diaries || [])
      .map(diary => String(diary.date || '').slice(0, 7))
      .filter(monthKey => /^\d{4}-\d{2}$/.test(monthKey))
  ));
}

function getVisibleArchiveDiaries(diaries) {
  if (profileArchiveMonth && profileArchiveMonth !== 'recent') {
    return (diaries || []).filter(diary => String(diary.date || '').startsWith(profileArchiveMonth));
  }
  return (diaries || []).filter(isDiaryInRecentMonth);
}

async function runDiaryBatches(items, batchSize, processFn) {
  const runner = typeof window.processInBatches === 'function'
    ? window.processInBatches
    : async (batchItems, size, fn) => {
        for (let i = 0; i < batchItems.length; i += size) {
          await Promise.all(batchItems.slice(i, i + size).map(fn));
        }
      };
  return runner(items, batchSize, processFn);
}

function moodIconSvg(mood) {
  const icons = {
    '开心': `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 21.5c-4.8-3.7-7.2-6.2-7.2-9.2 0-2.1 1.6-3.7 3.7-3.7 1.4 0 2.7.8 3.5 2 .8-1.2 2.1-2 3.5-2 2.1 0 3.7 1.6 3.7 3.7 0 3-2.4 5.5-7.2 9.2Z" fill="#fb7185"/><circle cx="8.3" cy="18.5" r="3.2" fill="#fde68a"/><circle cx="23.7" cy="18.5" r="3.2" fill="#a7f3d0"/><path d="M11.5 23.2c2.6 1.7 6.4 1.7 9 0" fill="none" stroke="#059669" stroke-width="1.9" stroke-linecap="round"/><circle cx="12.3" cy="12.8" r="1" fill="#fff"/></svg>`,
    '一般': `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M15.7 25.5c.1-6.2 1.8-11 6.8-14.7" fill="none" stroke="#047857" stroke-width="2.4" stroke-linecap="round"/><path d="M17.2 16.1c-4.4.2-7.4-2.1-8.9-6.2 4.6-.5 7.8 1.6 8.9 6.2Z" fill="#6ee7b7"/><path d="M18.7 17.6c4.6.2 7.4-2.1 8.4-6.5-4.7-.2-7.4 2.1-8.4 6.5Z" fill="#34d399"/><path d="M9.6 22.6c4.3 2.1 8.5 2.1 12.8 0" fill="none" stroke="#facc15" stroke-width="2.1" stroke-linecap="round"/><circle cx="21.8" cy="10.4" r="1.1" fill="#fff"/></svg>`,
    '有点累': `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8.5 17.2c1.1-4.2 4.3-6.9 8.3-6.9 4.4 0 8 3.4 8.3 7.7 2 .4 3.4 2 3.4 3.9 0 2.2-1.9 4-4.4 4H10c-3.1 0-5.5-2.1-5.5-4.8 0-2 1.6-3.7 4-3.9Z" fill="#bfdbfe"/><path d="M6.8 23.1c2.2 1.4 4.4 1.4 6.6 0s4.4-1.4 6.6 0 4.4 1.4 6.6 0" fill="none" stroke="#38bdf8" stroke-width="2.1" stroke-linecap="round"/><path d="M14.1 15.4c1.1-.7 2.4-.7 3.5 0" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round"/><circle cx="22.4" cy="15.5" r="1.3" fill="#60a5fa"/><circle cx="19.5" cy="13.3" r=".8" fill="#fff"/></svg>`,
    '想休息': `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M20.9 5.9c-1.9 6.1.9 12.4 6.5 15.2-2 3.4-5.7 5.7-9.9 5.7-6.1 0-11.1-4.6-11.1-10.4 0-5.4 4.4-9.9 10.1-10.4 1.5-.1 3 .1 4.4-.1Z" fill="#fde68a"/><path d="M20.9 5.9c-1.5 4.8 0 9.7 3.7 12.9-1.5.9-3.2 1.4-5 1.4-5.3 0-9.5-4-9.5-9 0-1.7.5-3.3 1.4-4.6 1.5-.5 3.2-.7 5-.6 1.5-.1 3 .1 4.4-.1Z" fill="#fff7ed" opacity=".82"/><path d="m9.1 22.8 1.5.8 1.5-.8-.8 1.5.8 1.5-1.5-.8-1.5.8.8-1.5-.8-1.5Z" fill="#a78bfa"/><path d="m25.2 8.5.9.5.9-.5-.5.9.5.9-.9-.5-.9.5.5-.9-.5-.9Z" fill="#818cf8"/></svg>`,
    '不太好': `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9.8 15.2c.8-3.2 3.4-5.3 6.6-5.3 3.5 0 6.3 2.6 6.6 5.9 2 .3 3.5 1.9 3.5 3.8 0 2.2-1.9 3.9-4.4 3.9H10.5c-2.8 0-5-1.9-5-4.3 0-2.1 1.7-3.8 4.3-4Z" fill="#e9d5ff"/><path d="m17.4 6.3-5.1 9h4.1l-1.7 8.5 5.8-10.1h-4.2l1.1-7.4Z" fill="#fb923c"/><path d="M10.1 25.2c1.9 1 3.8 1 5.7 0s3.8-1 5.7 0" fill="none" stroke="#a855f7" stroke-width="1.9" stroke-linecap="round"/><circle cx="23.4" cy="14.6" r=".9" fill="#fff"/></svg>`,
  };
  return icons[mood] || icons['一般'];
}

function setDiarySubmitMode(mode) {
  const isUpdate = mode === 'update';
  mainDiarySubmitBtn.dataset.mode = isUpdate ? 'update' : 'create';
  mainDiarySubmitBtn.classList.toggle('is-update', isUpdate);
  mainDiarySubmitBtn.innerHTML = isUpdate
    ? `<span class="submit-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 7.5h7.5a4.5 4.5 0 0 1 0 9H8"/><path d="M9.5 4.8 6.8 7.5l2.7 2.7"/><path d="M6 18.5c4 1.4 8 1.4 12 0"/></svg></span><span class="submit-label">更 新 补 充 记 录</span>`
    : `<span class="submit-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7"/><path d="M7.5 6.5c1.5-1.3 3.5-2 5.7-1.6 4 .7 6.5 4.7 5.3 8.5"/></svg></span><span class="submit-label">确 认 记 录</span>`;
  const headerSaveText = document.getElementById('editorHeaderSaveText');
  if (headerSaveText) headerSaveText.textContent = isUpdate ? '更新' : '保存';
}

function updateDiaryEditorHeader(value = dateInput.value) {
  const dateText = document.getElementById('editorDiaryDateText');
  if (dateText && value) dateText.textContent = value.replace(/-/g, '/');
}

function buildDiaryDraftMetadata() {
  const btn = document.getElementById('mainDiarySubmitBtn');
  return {
    mood_label: moodLabelInput?.value || '一般',
    mode: btn?.dataset.mode || 'create',
    server_updated_at: currentDiaryServerUpdatedAt || '',
    retained_images: serializeDiaryImagePaths(retainedImages)
  };
}

const DIARY_DATA_IMAGE_PREFIX_RE = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64$/i;
const DIARY_FULL_DATA_IMAGE_RE = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i;
const DIARY_RAW_BASE64_MARKERS = [
  { test: value => value.startsWith('/9j/') || value.startsWith('9j/'), mime: 'image/jpeg' },
  { test: value => value.startsWith('iVBOR'), mime: 'image/png' },
  { test: value => value.startsWith('UklGR'), mime: 'image/webp' },
  { test: value => value.startsWith('R0lGOD'), mime: 'image/gif' },
];

function inferDiaryRawBase64Mime(value) {
  const text = String(value || '').trim();
  const marker = DIARY_RAW_BASE64_MARKERS.find(item => item.test(text));
  return marker?.mime || '';
}

function isDiaryDataImagePrefix(value) {
  return DIARY_DATA_IMAGE_PREFIX_RE.test(String(value || '').trim());
}

function isFullDiaryDataImage(value) {
  return DIARY_FULL_DATA_IMAGE_RE.test(String(value || '').trim());
}

function collectDiaryImagePathParts(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => collectDiaryImagePathParts(item));
  }
  if (value === null || value === undefined) return [];
  const text = String(value).trim();
  if (!text) return [];
  if (isFullDiaryDataImage(text) || text.startsWith('blob:')) return [text];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return collectDiaryImagePathParts(parsed);
    } catch (_) {
      // 不是 JSON 数组时继续按旧 CSV 兼容。
    }
  }
  return text.split(',').map(part => part.trim()).filter(Boolean);
}

function repairDiaryImagePathParts(parts) {
  const repaired = [];
  for (let i = 0; i < parts.length; i += 1) {
    const current = String(parts[i] || '').trim();
    if (!current) continue;
    const next = String(parts[i + 1] || '').trim();
    // 兼容旧坏数据：["data:image/jpeg;base64", "/9j/..."] 必须重新合并为一张完整图片。
    if (isDiaryDataImagePrefix(current) && next) {
      repaired.push(`${current},${next}`);
      i += 1;
      continue;
    }
    repaired.push(current);
  }
  return repaired;
}

function normalizeImageSrc(src) {
  const text = String(src || '').trim();
  if (!text) return '';
  if (isFullDiaryDataImage(text)) return text;
  if (text.startsWith('blob:')) return text;
  const rawMime = inferDiaryRawBase64Mime(text);
  if (rawMime) return `data:${rawMime};base64,${text}`;
  if (text.startsWith('http://') || text.startsWith('https://')) return text;
  if (text.startsWith('/uploads/') || text.startsWith('/static/images/')) return text;
  if (text.startsWith('data:image/')) return '';
  if (text.startsWith('/')) return text;
  return '';
}

function parseDiaryImagePaths(value) {
  const merged = [];
  const seen = new Set();
  repairDiaryImagePathParts(collectDiaryImagePathParts(value)).forEach((path) => {
    const normalized = normalizeImageSrc(path);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(normalized);
  });
  return merged;
}

function serializeDiaryImagePaths(value) {
  const paths = parseDiaryImagePaths(value);
  return paths.some(path => path.startsWith('data:image/') || path.startsWith('blob:'))
    ? JSON.stringify(paths)
    : paths.join(',');
}

function normalizeDiaryImagePaths(value) {
  return serializeDiaryImagePaths(value);
}

function mergeDiaryImagePaths(...values) {
  const merged = [];
  const seen = new Set();
  values.flatMap(value => parseDiaryImagePaths(value)).forEach((path) => {
    if (seen.has(path)) return;
    seen.add(path);
    merged.push(path);
  });
  return merged;
}

function sleepDiarySync(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function isDemoMode() {
  return Boolean(window.LeafVaultSession?.isDemoMode?.());
}

function isDemoServerUploadEnabled() {
  const status = window.LeafVaultAuth?.getDeploymentStatus?.();
  return status?.demo_server_upload_enabled === true;
}

function fileToDiaryDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!(file instanceof Blob)) return resolve('');
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function filesToDiaryDataUrls(files = []) {
  const urls = [];
  for (const file of files) {
    try {
      const dataUrl = await fileToDiaryDataUrl(file);
      if (dataUrl) urls.push(dataUrl);
    } catch (_) {
      // 单张图片转换失败时跳过，避免影响整篇 Demo 日记保存。
    }
  }
  return urls;
}

function getDiaryDisplayImages(diary = {}) {
  return mergeDiaryImagePaths(
    diary.image_paths || diary.retained_images || '',
    Array.isArray(diary.demo_image_data_urls) ? diary.demo_image_data_urls.filter(Boolean) : []
  );
}

window.LeafVaultDiaryImages = {
  parseDiaryImagePaths,
  normalizeDiaryImagePaths,
  normalizeImageSrc,
  serializeDiaryImagePaths,
};

async function getRetainedImagesForSubmit(targetDate) {
  const currentRetained = mergeDiaryImagePaths(retainedImages);
  // 用户主动删除过旧图时，必须相信当前 retainedImages，不再从服务端/本地兜回已删除的旧图。
  if (hasRemovedRetainedDiaryImage) return currentRetained;

  let localImagePaths = '';
  let localRetainedImages = '';
  try {
    const localDiary = targetDate && window.LocalStorage
      ? await window.LocalStorage.get('diaries', targetDate)
      : null;
    localImagePaths = localDiary?.image_paths || '';
    localRetainedImages = localDiary?.retained_images || '';
  } catch (_) {
    localImagePaths = '';
    localRetainedImages = '';
  }

  const fallbackImages = mergeDiaryImagePaths(
    currentDiaryServerImagePaths,
    localImagePaths,
    localRetainedImages
  );
  if (!fallbackImages.length) return currentRetained;
  if (currentRetained.length >= fallbackImages.length) return currentRetained;
  return mergeDiaryImagePaths(fallbackImages, currentRetained);
}

function rememberActiveDiaryDate(value) {
  if (!value) return;
  activeDiaryDateValue = value;
  if (dateInput) dateInput.dataset.activeDate = value;
}

function getPreviousDiaryDateFromEvent(event) {
  const previousValue = event?.detail?.previousValue || dateInput?.dataset.previousValue || '';
  if (dateInput?.dataset.previousValue) delete dateInput.dataset.previousValue;
  return previousValue || activeDiaryDateValue || dateInput?.dataset.activeDate || '';
}

function isDiaryDraftSameAsServer(dateValue, contentValue, metadata = {}) {
  if ((metadata.mode || 'create') !== 'update') return false;
  const activeDate = activeDiaryDateValue || dateInput?.dataset.activeDate || dateInput?.value || '';
  if (dateValue !== activeDate) return false;
  const sameContent = String(contentValue || '') === currentDiaryServerContent;
  const sameMood = (metadata.mood_label || '一般') === (currentDiaryServerMood || '一般');
  const sameImages = normalizeDiaryImagePaths(metadata.retained_images) === normalizeDiaryImagePaths(currentDiaryServerImagePaths);
  return sameContent && sameMood && sameImages;
}

async function clearDiaryDraftForDate(dateValue, metadata = {}) {
  if (!dateValue) return;
  try {
    if (typeof window.setDiaryDraftEmergency === 'function') {
      window.setDiaryDraftEmergency(dateValue, '', metadata);
    }
    if (typeof window.deleteDiaryDraft === 'function') {
      await window.deleteDiaryDraft(dateValue);
    }
  } catch (error) {
    console.warn('清理无变化草稿失败:', error);
  }
}

function flashDiaryDraftHint() {
  const hint = document.getElementById('draftHint');
  if (!hint) return;
  hint.classList.remove('opacity-0');
  clearTimeout(window._draftHintTimer);
  window._draftHintTimer = setTimeout(() => hint.classList.add('opacity-0'), 1800);
}

function saveDiaryDraftEmergency(contentValue = contentInput?.value || '', options = {}) {
  const draftDate = options.dateValue || dateInput?.value || '';
  const metadata = options.metadata || buildDiaryDraftMetadata();
  if (!draftDate || typeof window.setDiaryDraftEmergency !== 'function') return;
  try {
    if (isDiaryDraftSameAsServer(draftDate, contentValue, metadata)) {
      window.setDiaryDraftEmergency(draftDate, '', metadata);
      return;
    }
    window.setDiaryDraftEmergency(draftDate, contentValue, metadata);
  } catch (error) {
    console.warn('紧急草稿保存失败:', error);
  }
}

async function saveDiaryDraftImmediately(contentValue = contentInput?.value || '', options = {}) {
  const draftDate = options.dateValue || dateInput?.value || '';
  const metadata = options.metadata || buildDiaryDraftMetadata();
  if (!draftDate) return;
  if (isDiaryDraftSameAsServer(draftDate, contentValue, metadata)) {
    await clearDiaryDraftForDate(draftDate, metadata);
    return;
  }
  saveDiaryDraftEmergency(contentValue, { dateValue: draftDate, metadata });
  if (typeof window.setDiaryDraft !== 'function') return;
  try {
    await window.setDiaryDraft(draftDate, contentValue, metadata);
    if (options.showHint) flashDiaryDraftHint();
  } catch (error) {
    console.warn('加密草稿保存失败:', error);
  }
}

function setActiveMood(mood = '一般') {
  const selectedMood = mood || '一般';
  document.querySelectorAll('.mood-bubble').forEach((bubble) => {
    bubble.classList.toggle('active', bubble.dataset.mood === selectedMood);
  });
  document.querySelectorAll('.editor-mood-chip').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.editorMood === selectedMood);
  });
  moodLabelInput.value = selectedMood;
}

function getDiaryEditorPanel() {
  return document.getElementById('diaryEditorPanel');
}

function hideDiaryEditor() {
  const panel = getDiaryEditorPanel();
  if (!panel) return;
  panel.classList.add('hidden');
  panel.classList.remove('is-open');
  document.body.classList.remove('diary-editor-active');
}

function showDiaryEditor(focusTarget = 'content') {
  const panel = getDiaryEditorPanel();
  if (!panel) return;
  // 打开时提升到 body 末尾，避免被首页卡片、滚动容器或底部导航压住。
  if (panel.parentElement !== document.body) document.body.appendChild(panel);
  updateDiaryEditorHeader();
  setActiveMood(moodLabelInput.value || '一般');
  panel.classList.remove('hidden');
  panel.classList.add('is-open');
  document.body.classList.add('diary-editor-active');
  setTimeout(() => {
    const target = focusTarget === 'ai'
      ? document.getElementById('aiPolishBtn')
      : document.getElementById('content');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.focus?.();
  }, 40);
}

function setupDiaryEditorBindings() {
  if (document.body.dataset.diaryEditorBound === '1') return;
  document.body.dataset.diaryEditorBound = '1';
  document.addEventListener('click', (event) => {
    const panel = getDiaryEditorPanel();
    if (!panel) return;

    const closeBtn = event.target.closest('[data-editor-action="close"]');
    if (closeBtn && panel.contains(closeBtn)) {
      saveDiaryDraftImmediately(contentInput.value);
      hideDiaryEditor();
      return;
    }

    const moodBtn = event.target.closest('[data-editor-mood]');
    if (moodBtn && panel.contains(moodBtn)) {
      event.preventDefault();
      setActiveMood(moodBtn.dataset.editorMood);
      saveDiaryDraftImmediately(contentInput.value, { showHint: true });
    }
  });
}

function normalizeDiaryPreviewText(content) {
  const text = String(content || '').replace(/\r\n/g, '\n').trim();
  return text || '这天主要留下了图片或心情，还没有写下更多文字。';
}

function renderTodayDiaryState(diary, targetDate, hasDraft = false) {
  const empty = document.getElementById('todayDiaryEmpty');
  const preview = document.getElementById('todayDiaryPreview');
  const emptyHint = document.getElementById('todayDiaryEmptyHint');
  if (!empty || !preview) return;

  if (!diary) {
    currentDiaryDetail = null;
    empty.classList.remove('hidden');
    preview.classList.add('hidden');
    if (emptyHint) {
      emptyHint.textContent = hasDraft
        ? '已恢复一份未保存草稿，点开就能继续写完。'
        : '给今天留一点声音，之后回看会很清楚。';
    }
    return;
  }

  currentDiaryDetail = diary;
  empty.classList.add('hidden');
  preview.classList.remove('hidden');

  const displayDate = (diary.date || targetDate || '').replace(/-/g, '/');
  const mood = diary.mood_label || moodLabelInput.value || '一般';
  const summary = normalizeDiaryPreviewText(diary.content);

  const dateEl = document.getElementById('todayDiaryPreviewDate');
  const moodEl = document.getElementById('todayDiaryPreviewMood');
  const iconEl = document.getElementById('todayDiaryMoodIcon');
  const summaryEl = document.getElementById('todayDiaryPreviewSummary');

  if (dateEl) dateEl.textContent = displayDate;
  if (moodEl) moodEl.textContent = mood;
  if (iconEl) iconEl.innerHTML = moodIconSvg(mood);
  if (summaryEl) summaryEl.textContent = summary;
}

function formatArchiveMonthLabel(monthKey) {
  const [year, month] = String(monthKey || '').split('-');
  if (!year || !month) return '未归档';
  return `${year} 年 ${month} 月`;
}

function getArchiveMonthOptionLabel(value) {
  return value === 'recent' ? '最近一个月' : formatArchiveMonthLabel(value);
}

function closeProfileArchiveMonthMenu() {
  const trigger = document.getElementById('profileArchiveMonthTrigger');
  const menu = document.getElementById('profileArchiveMonthMenu');
  if (!trigger || !menu) return;
  trigger.setAttribute('aria-expanded', 'false');
  menu.classList.add('hidden');
}

function renderArchiveMonthPicker(months) {
  const trigger = document.getElementById('profileArchiveMonthTrigger');
  const label = document.getElementById('profileArchiveMonthLabel');
  const menu = document.getElementById('profileArchiveMonthMenu');
  if (!trigger || !label || !menu) return;

  if (profileArchiveMonth !== 'recent' && !months.includes(profileArchiveMonth)) {
    profileArchiveMonth = 'recent';
  }

  const options = ['recent', ...months];
  label.textContent = getArchiveMonthOptionLabel(profileArchiveMonth);
  menu.innerHTML = options.map((value) => {
    const isActive = value === profileArchiveMonth;
    const safeValue = escapeHtml(value);
    const safeLabel = escapeHtml(getArchiveMonthOptionLabel(value));
    return `
      <button type="button"
              class="memory-month-option ${isActive ? 'is-active' : ''}"
              role="option"
              aria-selected="${isActive ? 'true' : 'false'}"
              data-archive-month-option="${safeValue}">
        <span>${safeLabel}</span>
      </button>`;
  }).join('');
}

function renderProfileDiaryArchive(data = profileArchiveData) {
  const container = document.getElementById('profileDiaryArchive');
  const countEl = document.getElementById('profileArchiveCount');
  if (!container) return;

  const diaries = sortDiariesByDateDesc(data || []);
  const months = getArchiveMonths(diaries);
  renderArchiveMonthPicker(months);

  const visibleDiaries = sortDiariesForDisplay(getVisibleArchiveDiaries(diaries));
  if (countEl) countEl.textContent = `${visibleDiaries.length} / ${diaries.length} 篇`;
  if (!diaries.length) {
    container.innerHTML = '<p class="text-center text-gray-400 text-sm py-8">还没有归档日记。写下第一篇后，它会悄悄来到这里。</p>';
    return;
  }
  if (!visibleDiaries.length) {
    container.innerHTML = profileArchiveMonth === 'recent'
      ? '<p class="text-center text-gray-400 text-sm py-8">最近一个月还没有日记，试试右上角选择更早月份。</p>'
      : '<p class="text-center text-gray-400 text-sm py-8">这个月份还没有日记。</p>';
    return;
  }

  const today = formatDateValue(new Date());
  const groups = new Map();
  visibleDiaries.forEach((diary) => {
    const monthKey = String(diary.date || '').slice(0, 7) || 'unknown';
    if (!groups.has(monthKey)) groups.set(monthKey, []);
    groups.get(monthKey).push(diary);
  });

  container.innerHTML = Array.from(groups.entries()).map(([monthKey, items]) => `
    <section class="memory-month-group">
      <h3 class="memory-month-title">${escapeHtml(formatArchiveMonthLabel(monthKey))}<span>${items.length} 篇</span></h3>
      <div class="space-y-3 mt-3">
        ${items.map((diary) => {
          const safeDate = escapeHtml(diary.date || '');
          const safeMood = escapeHtml(diary.mood_label || '一般');
          const summary = escapeHtml(normalizeDiaryPreviewText(diary.content));
          const isToday = diary.date === today;
          const pinned = isDiaryPinned(diary);
          const pinButton = renderDiaryPinButton(safeDate, pinned, 'data-archive-action="toggle-pin"');
          return `
            <article class="memory-entry-card ${pinned ? 'is-pinned' : ''}" data-archive-date="${safeDate}">
              <div class="memory-entry-head">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="memory-date-pill">${safeDate.replace(/-/g, '/')}</span>
                  ${isToday ? '<span class="memory-today-pill">今天</span>' : ''}
                </div>
                <div class="memory-entry-meta">
                  ${pinButton}
                  <span class="diary-mood-badge" data-mood="${safeMood}">${moodIconSvg(diary.mood_label)}<span>${safeMood}</span></span>
                </div>
              </div>
              <p class="memory-summary">${summary}</p>
              <div class="memory-actions">
                <button type="button" class="memory-action-btn" data-archive-action="view" data-date="${safeDate}">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6Z"/><circle cx="12" cy="12" r="2.7"/></svg>
                  <span>查看全文</span>
                </button>
                <button type="button" class="memory-action-btn" data-archive-action="edit" data-date="${safeDate}">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h4l10-10a2.4 2.4 0 0 0-3.4-3.4L5.6 15.6 5 19Z"/><path d="M14 7l3 3"/></svg>
                  <span>编辑</span>
                </button>
                <button type="button" class="memory-action-btn is-danger" data-archive-action="delete" data-date="${safeDate}">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>
                  <span>删除</span>
                </button>
              </div>
            </article>`;
        }).join('')}
      </div>
    </section>
  `).join('');
}

async function loadDiaryForArchive(dateStr) {
  const cached = profileArchiveData.find((diary) => diary.date === dateStr)
    || allDiariesData.find((diary) => diary.date === dateStr);
  if (cached) currentDiaryDetail = cached;
  if (isDemoMode()) return currentDiaryDetail;
  try {
    const res = await apiFetch(`/api/diaries/detail?date=${dateStr}`);
    const result = await res.json();
    if (result.status === 'success') {
      currentDiaryDetail = result.data;
      return result.data;
    }
  } catch (error) {
    console.warn('读取归档日记详情失败，使用缓存数据:', error);
  }
  return currentDiaryDetail;
}

async function handleArchiveAction(action, dateStr) {
  if (!dateStr) return;
  if (action === 'toggle-pin') {
    await togglePin(dateStr);
    return;
  }

  if (action === 'delete') {
    const deleted = await deleteDiary(dateStr);
    if (deleted) renderProfileDiaryArchive();
    return;
  }

  const diary = await loadDiaryForArchive(dateStr);
  if (!diary) return showToast('没有找到这篇日记', true);
  if (action === 'view') {
    openDiaryReadonlyPreview(diary);
    return;
  }

  const previousDate = dateInput.value || activeDiaryDateValue;
  if (previousDate && previousDate !== dateStr) {
    await saveDiaryDraftImmediately(contentInput.value, { dateValue: previousDate });
  }
  dateInput.value = dateStr;
  syncDiaryDateButton(dateStr);
  await checkExistingDiary(dateStr);
  if (action === 'edit') showDiaryEditor('content');
}

function setupProfileArchiveBindings() {
  const container = document.getElementById('profileDiaryArchive');
  const picker = document.getElementById('profileArchiveMonthPicker');
  const trigger = document.getElementById('profileArchiveMonthTrigger');
  const menu = document.getElementById('profileArchiveMonthMenu');

  if (container && container.dataset.archiveBound !== '1') {
    container.dataset.archiveBound = '1';
    container.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-archive-action]');
      if (!btn || !container.contains(btn)) return;
      event.stopPropagation();
      handleArchiveAction(btn.dataset.archiveAction, btn.dataset.date);
    });
  }

  if (picker && trigger && menu && picker.dataset.archiveMonthBound !== '1') {
    picker.dataset.archiveMonthBound = '1';

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = trigger.getAttribute('aria-expanded') !== 'true';
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      menu.classList.toggle('hidden', !willOpen);
    });

    menu.addEventListener('click', (event) => {
      const option = event.target.closest('[data-archive-month-option]');
      if (!option || !menu.contains(option)) return;
      event.stopPropagation();
      profileArchiveMonth = option.dataset.archiveMonthOption || 'recent';
      closeProfileArchiveMonthMenu();
      renderProfileDiaryArchive();
    });

    document.addEventListener('click', (event) => {
      if (!picker.contains(event.target)) closeProfileArchiveMonthMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeProfileArchiveMonthMenu();
    });
  }
}

function renderDiaryContentHtml(content) {
  const text = normalizeDiaryPreviewText(content);
  try {
    if (typeof marked !== 'undefined') {
      const rawHtml = marked.parse(text);
      return (typeof DOMPurify !== 'undefined')
        ? DOMPurify.sanitize(rawHtml)
        : escapeHtml(text).replace(/\n/g, '<br>');
    }
  } catch (_) {
    // 渲染失败时降级为安全纯文本，避免预览窗口空白。
  }
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function createMissingDiaryImagePlaceholder(path = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'diary-img-missing flex min-h-[96px] w-full items-center justify-center rounded-xl border border-dashed border-amber-200 bg-amber-50/75 px-3 py-4 text-center text-xs font-bold leading-5 text-amber-700';
  button.textContent = '图片文件缺失 / 未找到原图';
  button.dataset.missingImagePath = path;
  button.title = path ? `缺失图片路径：${path}` : '图片文件缺失';
  if (path && (String(path).startsWith('data:image/') || inferDiaryRawBase64Mime(path))) {
    button.dataset.missingImagePath = getSafeImagePathPreview(path);
    button.title = '图片数据异常，已尝试本地修复';
  }
  return button;
}

function getSafeImagePathPreview(path = '') {
  const text = String(path || '');
  if (!text) return '';
  if (text.startsWith('data:image/') || inferDiaryRawBase64Mime(text)) {
    return `${text.slice(0, 32)}...`;
  }
  return text;
}

function replaceMissingDiaryImage(img) {
  if (!img || img.dataset.missingHandled === '1') return;
  img.dataset.missingHandled = '1';
  const path = img.dataset.src || img.getAttribute('src') || '';
  img.replaceWith(createMissingDiaryImagePlaceholder(path));
}

function setupDiaryImageErrorFallback() {
  if (document.body?.dataset.diaryImageErrorBound === '1') return;
  if (document.body) document.body.dataset.diaryImageErrorBound = '1';
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('diary-img')) return;
    replaceMissingDiaryImage(img);
  }, true);
  document.addEventListener('click', (event) => {
    const missing = event.target.closest?.('.diary-img-missing');
    if (!missing) return;
    event.stopPropagation();
    const path = missing.dataset.missingImagePath || '';
    const message = path ? `图片文件缺失：${path}` : '图片文件缺失 / 未找到原图';
    if (window.LeafVaultUIState?.showToast) window.LeafVaultUIState.showToast(message, 'warning');
    else showToast(message, true);
  });
}

function renderDiaryPreviewImages(imagesEl, imagePaths) {
  if (!imagesEl) return;
  const paths = parseDiaryImagePaths(imagePaths);
  imagesEl.innerHTML = '';
  imagesEl.className = 'diary-detail-images hidden';
  if (!paths.length) return;

  imagesEl.classList.remove('hidden');
  if (paths.length === 1) imagesEl.classList.add('is-single');
  else if (paths.length === 2) imagesEl.classList.add('is-two');
  else imagesEl.classList.add('is-many');

  paths.forEach((path) => {
    const src = normalizeImageSrc(path);
    if (!src) return;
    const img = document.createElement('img');
    img.src = src;
    img.alt = '日记图片';
    img.dataset.src = src;
    img.className = 'diary-img';
    img.addEventListener('click', (event) => {
      event.stopPropagation();
      openLightbox(src);
    });
    imagesEl.appendChild(img);
  });
}

function renderDiaryFullPreview(diary) {
  const modal = document.getElementById('diaryFullPreviewModal');
  const panel = modal?.querySelector('[data-diary-full-panel]');
  if (!modal || !panel) return;

  const dateEl = document.getElementById('diaryFullPreviewDate');
  const moodEl = document.getElementById('diaryFullPreviewMood');
  const contentEl = document.getElementById('diaryFullPreviewContent');
  const imagesEl = document.getElementById('diaryFullPreviewImages');
  if (dateEl) dateEl.textContent = (diary.date || '').replace(/-/g, '/');
  if (moodEl) moodEl.textContent = diary.mood_label || '一般';
  if (contentEl) contentEl.innerHTML = renderDiaryContentHtml(diary.content);
  renderDiaryPreviewImages(imagesEl, getDiaryDisplayImages(diary));
  updateDiaryDetailPinButton(diary);
}

function openDiaryFullPreview() {
  const diary = currentDiaryDetail;
  if (!diary) return;
  const modal = document.getElementById('diaryFullPreviewModal');
  const panel = modal?.querySelector('[data-diary-full-panel]');
  if (!modal || !panel) return;

  modal.dataset.mode = 'detail';
  modal.classList.remove('diary-full-preview-readonly');
  renderDiaryFullPreview(diary);

  modal.classList.remove('hidden');
  document.body.classList.add('diary-detail-active');
  document.body.classList.add('overflow-hidden');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
    panel.classList.remove('translate-y-3');
  }, 10);
}

function renderDiaryReadonlyPreview(diary) {
  const modal = document.getElementById('diaryFullPreviewModal');
  if (!modal || !diary) return;
  modal.dataset.mode = 'readonly';
  modal.classList.add('diary-full-preview-readonly');
  renderDiaryFullPreview(diary);
}

function openDiaryPreviewModal() {
  const modal = document.getElementById('diaryFullPreviewModal');
  const panel = modal?.querySelector('[data-diary-full-panel]');
  if (!modal || !panel) return;
  modal.classList.remove('hidden');
  document.body.classList.add('diary-detail-active');
  document.body.classList.add('overflow-hidden');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
    panel.classList.remove('translate-y-3');
  }, 10);
}

async function getDiaryForReadonlyPreview(date) {
  const cached = allDiariesData.find((diary) => diary.date === date)
    || profileArchiveData.find((diary) => diary.date === date)
    || (currentDiaryDetail?.date === date ? currentDiaryDetail : null);
  if (cached?.content !== undefined) return cached;

  if (navigator.onLine) {
    try {
      const res = await apiFetch(`/api/diaries/detail?date=${encodeURIComponent(date)}`);
      const result = await res.json();
      if (result.status === 'success' && result.data) return result.data;
    } catch (_) {
      // 网络失败时继续尝试本地缓存。
    }
  }

  try {
    const localDiary = await LocalStorage.get('diaries', date);
    if (localDiary) return localDiary;
  } catch (_) {
    // 本地缓存不可用时交给调用方提示。
  }
  return cached;
}

async function openDiaryReadonlyPreview(dateOrDiary) {
  const date = typeof dateOrDiary === 'string' ? dateOrDiary : dateOrDiary?.date;
  if (!date) return;
  try {
    const diary = typeof dateOrDiary === 'object' && dateOrDiary?.content !== undefined
      ? dateOrDiary
      : await getDiaryForReadonlyPreview(date);
    if (!diary) throw new Error('diary_not_found');
    currentDiaryDetail = diary;
    renderDiaryReadonlyPreview(diary);
    openDiaryPreviewModal();
  } catch (_) {
    const message = '这篇日记暂时无法打开，请稍后再试。';
    if (window.LeafVaultUIState?.showToast) window.LeafVaultUIState.showToast(message, 'warning');
    else showToast(message, true);
  }
}

function closeDiaryReadonlyPreview() {
  closeDiaryFullPreview();
}

function closeDiaryFullPreview() {
  const modal = document.getElementById('diaryFullPreviewModal');
  const panel = modal?.querySelector('[data-diary-full-panel]');
  if (!modal || !panel) return;
  modal.classList.add('opacity-0');
  panel.classList.add('translate-y-3');
  document.body.classList.remove('diary-detail-active');
  document.body.classList.remove('overflow-hidden');
  setTimeout(() => modal.classList.add('hidden'), 220);
}

function updateDiaryDetailPinButton(diary = currentDiaryDetail) {
  const pinText = document.getElementById('diaryDetailPinText');
  const pinBtn = document.getElementById('diaryDetailPinBtn');
  if (!pinText || !pinBtn) return;
  const isPinned = Boolean(Number(diary?.is_pinned || 0));
  pinText.textContent = isPinned ? '取消置顶' : '置顶';
  pinBtn.classList.toggle('is-active', isPinned);
}

function setupTodayDiaryStateBindings() {
  const state = document.getElementById('todayDiaryState');
  if (state && state.dataset.todayStateBound !== '1') {
    state.dataset.todayStateBound = '1';
    state.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-today-action]');
      if (!btn || !state.contains(btn)) return;
      const action = btn.dataset.todayAction;
      if (action === 'start' || action === 'edit') showDiaryEditor('content');
      if (action === 'view') openDiaryFullPreview();
      if (action === 'ai') showDiaryEditor('ai');
    });
  }

  const modal = document.getElementById('diaryFullPreviewModal');
  if (modal && modal.dataset.todayModalBound !== '1') {
    modal.dataset.todayModalBound = '1';
    modal.addEventListener('click', async (event) => {
      if (event.target === modal) {
        closeDiaryFullPreview();
        return;
      }
      const actionBtn = event.target.closest('[data-detail-action]');
      if (!actionBtn || !modal.contains(actionBtn)) return;
      const action = actionBtn.dataset.detailAction;
      const diary = currentDiaryDetail;
      if (action === 'close') closeDiaryFullPreview();
      if (modal.dataset.mode === 'readonly') return;
      if (action === 'edit' && diary) {
        closeDiaryFullPreview();
        showDiaryEditor('content');
      }
      if (action === 'delete' && diary) {
        const deleted = await deleteDiary(diary.date);
        if (deleted) closeDiaryFullPreview();
      }
      if (action === 'pin' && diary) {
        const result = await togglePin(diary.date);
        if (result?.status === 'success') {
          currentDiaryDetail = { ...diary, is_pinned: result.is_pinned ? 1 : 0 };
          updateDiaryDetailPinButton(currentDiaryDetail);
          fetchDiaries(document.getElementById('diarySearchInput').value.trim());
        }
      }
    });
  }
}

const diaryDatePicker = typeof createDatePicker === 'function' ? createDatePicker({
  inputId: 'date',
  textId: 'diaryDateText',
  fieldId: 'diaryDateField',
  triggerId: 'diaryDateTrigger',
  panelId: 'diaryDatePicker',
  gridId: 'calendarDayGrid',
  titleId: 'calendarMonthTitle',
  prevId: 'calendarPrevMonth',
  nextId: 'calendarNextMonth',
  todayId: 'calendarTodayBtn',
}) : {
  syncButton(value = dateInput.value) {
    const textEl = document.getElementById('diaryDateText');
    if (textEl && value) textEl.textContent = value.replace(/-/g, '/');
  },
  render() {},
  show() {
    document.getElementById('date')?.showPicker?.();
  },
  hide() {},
  setup() {
    document.getElementById('diaryDateTrigger')?.addEventListener('click', () => this.show());
  },
};

function syncDiaryDateButton(value = dateInput.value) {
  diaryDatePicker.syncButton(value);
}

function renderDiaryDateCalendar() {
  diaryDatePicker.render();
}

function showDiaryDatePicker() {
  diaryDatePicker.show();
}

function hideDiaryDatePicker() {
  diaryDatePicker.hide();
}

function setupDiaryDatePicker() {
  diaryDatePicker.setup();
}

// 时光日记：列表渲染
// - Markdown 正文先渲染再消毒，防止 XSS。
// - 图片只写入 data-src，点击统一走事件监听，避免拼接 onclick。
// - 置顶记录始终排在前面，排序规则集中在 sortDiariesForDisplay。
// ============================================================
function renderDiaryList(data, kw = '') {
  const list = document.getElementById('diaryList');
  const careBanner = document.getElementById('careBanner');
  if (careBanner) careBanner.classList.add('hidden');
 
  if (!data.length) {
    if (window.LeafVaultUIState?.renderEmptyState) {
      window.LeafVaultUIState.renderEmptyState(list, {
        title: kw ? '没有找到匹配日记' : '还没有写日记',
        description: kw ? '换个关键词试试，或者回到最近记录看看。' : '今天可以先记录一句话。',
        compact: true,
      });
    } else {
      const emptyText = kw ? '最近 3 日没有匹配的日记' : '最近 3 日还没有日记';
      list.innerHTML = `<p class="text-center text-gray-400 text-sm py-10">${emptyText}</p>`;
    }
    return;
  }
 
  // 情绪关怀 Banner 逻辑
  if (!kw) {
    const neg = ['有点累', '想休息', '不太好'];
    const careData = data.filter(d => d.__home_section !== 'pinned');
    let count = 0;
    for (let i = 0; i < Math.min(3, careData.length); i++) {
      if (neg.includes(careData[i].mood_label)) count++;
      else break;
    }
    if (count >= 3 && careBanner) careBanner.classList.remove('hidden');
  }
 
  const renderSectionTitle = (label, meta) => `
    <div class="home-diary-section-title">
      <span>${label}</span>
      <small>${meta}</small>
    </div>`;

  const renderDiaryCard = (d) => {
    const pinned = isDiaryPinned(d);
    const pBadge = pinned ? '<span class="absolute top-0 right-10 bg-orange-500 text-white text-[9px] px-1.5 py-0.5 rounded-b-md font-bold shadow-sm">PINNED</span>' : '';
 
    // [安全] 图片路径：用 data-src 存储，不再拼接到 onclick 字符串中
    let imgHtml = '';
    {
      const paths = getDiaryDisplayImages(d).map(normalizeImageSrc).filter(Boolean);
      if (paths.length === 1) {
        imgHtml = `<div class="mt-3.5 overflow-hidden rounded-lg bg-gray-50 border border-gray-100"><img src="${escapeHtml(paths[0])}" data-src="${escapeHtml(paths[0])}" class="diary-img diary-img-stable w-full h-auto max-h-96 object-contain cursor-zoom-in" alt="日记图片"></div>`;
      } else if (paths.length > 1) {
        const cols = (paths.length === 2 || paths.length === 4) ? 'grid-cols-2' : 'grid-cols-3';
        imgHtml = `<div class="mt-3.5 grid ${cols} gap-1.5">${paths.map(x =>
          `<div class="overflow-hidden rounded-lg bg-gray-50"><img src="${escapeHtml(x)}" data-src="${escapeHtml(x)}" class="diary-img diary-img-stable w-full aspect-square object-cover cursor-zoom-in" alt="日记图片"></div>`
        ).join('')}</div>`;
      }
    }
 
    // [安全] 日记正文经 marked 渲染后，必须用 DOMPurify 消毒
    let cont = d.content;
    try {
      if (typeof marked !== 'undefined') {
        const rawHtml = marked.parse(d.content);
        // DOMPurify 消毒：如果未引入则降级为纯文本转义
        cont = (typeof DOMPurify !== 'undefined')
          ? DOMPurify.sanitize(rawHtml)
          : escapeHtml(d.content).replace(/\n/g, '<br>');
      } else {
        cont = escapeHtml(d.content).replace(/\n/g, '<br>');
      }
    } catch (e) {
      cont = escapeHtml(d.content).replace(/\n/g, '<br>');
    }
 
    if (kw) cont = highlightKeyword(cont, kw);
 
    // [安全] date 也要转义，防止 XSS（虽然日期格式受限，但养成好习惯）
    const safeDate = escapeHtml(d.date);
    const safeMood = escapeHtml(d.mood_label);
 
    return `
      <div id="diary-${safeDate}" data-date="${safeDate}" data-diary-card="true" data-diary-date="${safeDate}"
           role="button" tabindex="0" aria-label="打开 ${safeDate} 的日记预览"
           class="glass-card p-5 border relative transition-all duration-500 hover:-translate-y-0.5 hover:shadow-md cursor-pointer ${pinned ? 'ring-2 ring-orange-100 bg-orange-50/20' : 'border-gray-50'}">
        ${pBadge}
        <div class="flex flex-wrap justify-between items-center gap-2 text-sm mb-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-bold text-gray-500 bg-gray-100 px-3 py-1 rounded-full text-xs">${safeDate}</span>
            <span class="diary-mood-badge" data-mood="${safeMood}">${moodIconSvg(d.mood_label)}<span>${safeMood}</span></span>
            ${getSyncBadgeHtml(d.sync_status)}
          </div>
          <div class="flex flex-wrap items-center gap-3">
            ${renderDiaryPinButton(safeDate, pinned, 'data-diary-action="toggle-pin"')}
            <button type="button" data-diary-action="delete" data-date="${safeDate}" class="text-xs text-red-400 hover:text-red-600 font-bold">删除</button>
          </div>
        </div>
        <div class="prose prose-sm prose-green max-w-none text-gray-700 leading-relaxed">${cont}</div>
        ${imgHtml}
      </div>`;
  };

  const pinnedData = data.filter(d => d.__home_section === 'pinned');
  const recentData = data.filter(d => d.__home_section === 'recent');
  if (pinnedData.length || recentData.length) {
    const sections = [];
    if (pinnedData.length) {
      sections.push(renderSectionTitle('置顶日记', `${pinnedData.length} 篇`));
      sections.push(pinnedData.map(renderDiaryCard).join(''));
    }
    if (recentData.length) {
      sections.push(renderSectionTitle('最近 3 日', '普通日记'));
      sections.push(recentData.map(renderDiaryCard).join(''));
    }
    list.innerHTML = sections.join('');
    return;
  }

  list.innerHTML = data.map(renderDiaryCard).join('');
 
}

function isDiaryCardInteractiveTarget(target) {
  return !!target.closest('button, a, input, textarea, select, [data-diary-action], [data-detail-action], .diary-img');
}

function setupDiaryCardReadonlyPreview() {
  const list = document.getElementById('diaryList');
  if (!list) return;
  if (list.dataset.diaryListBound === '1') return;
  list.dataset.diaryListBound = '1';
  list.addEventListener('click', (event) => {
    const img = event.target.closest('.diary-img');
    if (img && list.contains(img)) {
      event.stopPropagation();
      openLightbox(normalizeImageSrc(img.dataset.src));
      return;
    }

    const action = event.target.closest('[data-diary-action]');
    if (action && list.contains(action)) {
      event.stopPropagation();
      const date = action.dataset.date;
      if (action.dataset.diaryAction === 'toggle-pin') togglePin(date);
      if (action.dataset.diaryAction === 'delete') deleteDiary(date);
      return;
    }

    if (isDiaryCardInteractiveTarget(event.target)) return;
    const card = event.target.closest('[data-diary-card="true"]');
    if (card && list.contains(card)) openDiaryReadonlyPreview(card.dataset.diaryDate);
  });

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (isDiaryCardInteractiveTarget(event.target)) return;
    const card = event.target.closest('[data-diary-card="true"]');
    if (!card || !list.contains(card)) return;
    event.preventDefault();
    openDiaryReadonlyPreview(card.dataset.diaryDate);
  });
}

function setupDiaryListBindings() {
  setupDiaryCardReadonlyPreview();
}

setupDiaryListBindings();
setupTodayDiaryStateBindings();
setupDiaryEditorBindings();
setupProfileArchiveBindings();

document.getElementById('diarySearchInput').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => fetchDiaries(e.target.value.trim()), 500);
});



dateInput.addEventListener('change', async e => {
    const nextDate = e.target.value;
    const previousDate = getPreviousDiaryDateFromEvent(e);
    const draftDate = previousDate && previousDate !== nextDate ? previousDate : nextDate;
    await saveDiaryDraftImmediately(contentInput.value, { dateValue: draftDate });
    hideDiaryEditor();
    checkExistingDiary(nextDate);
});

async function jumpToDiary(dateStr) {
    switchTab('diary');
    const previousDate = dateInput.value || activeDiaryDateValue;
    if (previousDate && previousDate !== dateStr) {
        await saveDiaryDraftImmediately(contentInput.value, { dateValue: previousDate });
    }
    dateInput.value = dateStr;
    syncDiaryDateButton(dateStr);
    hideDiaryEditor();
    checkExistingDiary(dateStr);

    setTimeout(() => {
        const targetCard = document.getElementById(`diary-${dateStr}`);
        if (targetCard) {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetCard.classList.add('ring-4', 'ring-green-400', 'bg-green-50', 'scale-[1.02]');
            setTimeout(() => {
                targetCard.classList.remove('ring-4', 'ring-green-400', 'bg-green-50', 'scale-[1.02]');
            }, 1500);
        }
    }, 300);
}

async function applyDiarySnapshotToEditor(d, targetDate, isCurrentLoad = () => true) {
    if (!d || !isCurrentLoad()) return false;
    currentDiaryServerUpdatedAt = d.updated_at || d.server_updated_at || '';
    currentDiaryServerContent = d.content || '';
    currentDiaryServerMood = d.mood_label || '一般';
    currentDiaryServerImagePaths = d.image_paths || d.retained_images || '';
    contentInput.value = currentDiaryServerContent;
    renderTodayDiaryState(d, targetDate);
    setActiveMood(currentDiaryServerMood);

    retainedImages = parseDiaryImagePaths(currentDiaryServerImagePaths);
    demoRetainedImages = Array.isArray(d.demo_image_data_urls) ? d.demo_image_data_urls.filter(Boolean) : [];
    removedRetainedImages = [];
    newImageFiles = [];
    hasRemovedRetainedDiaryImage = false;
    renderImagePreviews();
    setDiarySubmitMode('update');

    const savedDraft = typeof window.getDiaryDraftSnapshot === 'function'
        ? await window.getDiaryDraftSnapshot(targetDate)
        : null;
    if (!isCurrentLoad()) return false;
    const canRestoreDraft = savedDraft?.content
        && savedDraft.mode === 'update'
        && (!savedDraft.server_updated_at || savedDraft.server_updated_at === currentDiaryServerUpdatedAt)
        && savedDraft.content !== currentDiaryServerContent;
    if (canRestoreDraft) {
        const draftMood = savedDraft.mood_label || currentDiaryServerMood;
        contentInput.value = savedDraft.content;
        setActiveMood(draftMood);
        renderTodayDiaryState({ ...d, content: savedDraft.content, mood_label: draftMood }, targetDate);
        showToast(' 📑  已为你恢复未保存的编辑草稿');
    }
    return true;
}

async function restoreDraftOrEmptyDiary(targetDate, isCurrentLoad = () => true) {
    if (!isCurrentLoad()) return false;
    currentDiaryServerUpdatedAt = '';
    currentDiaryServerContent = '';
    currentDiaryServerMood = '一般';
    currentDiaryServerImagePaths = '';
    retainedImages = [];
    demoRetainedImages = [];
    removedRetainedImages = [];
    newImageFiles = [];
    hasRemovedRetainedDiaryImage = false;
    renderImagePreviews();
    setDiarySubmitMode('create');

    const savedDraft = typeof window.getDiaryDraftSnapshot === 'function'
        ? await window.getDiaryDraftSnapshot(targetDate)
        : { content: await getDiaryDraft(targetDate) };
    if (!isCurrentLoad()) return false;
    if (savedDraft?.content) {
        contentInput.value = savedDraft.content;
        setActiveMood(savedDraft.mood_label || '一般');
        renderTodayDiaryState(null, targetDate, true);
        showToast(' 📑  已为你恢复未保存的草稿');
    } else {
        contentInput.value = '';
        setActiveMood('一般');
        renderTodayDiaryState(null, targetDate);
    }
    return true;
}

async function restoreLocalDiaryOrDraft(targetDate, isCurrentLoad = () => true) {
    try {
        const localDiary = window.LocalStorage
            ? await LocalStorage.get('diaries', targetDate)
            : null;
        if (localDiary && isCurrentLoad()) {
            return applyDiarySnapshotToEditor(localDiary, targetDate, isCurrentLoad);
        }
    } catch (error) {
        console.warn('本地日记读取失败，降级读取草稿:', error);
    }
    return restoreDraftOrEmptyDiary(targetDate, isCurrentLoad);
}

async function checkExistingDiary(targetDate) {
    if (!targetDate) return;
    const loadId = ++diaryLoadSequence;
    const isCurrentLoad = () => loadId === diaryLoadSequence && dateInput.value === targetDate;
    syncDiaryDateButton(targetDate);
    updateDiaryEditorHeader(targetDate);
    renderDiaryDateCalendar();
    if (isDemoMode()) {
        await restoreLocalDiaryOrDraft(targetDate, isCurrentLoad);
        if (isCurrentLoad()) rememberActiveDiaryDate(targetDate);
        return;
    }
    try {
        const res = await apiFetch(`/api/diaries/detail?date=${targetDate}`);
        const result = await res.json();
        if (!isCurrentLoad()) return;
        if (result.status === 'success') {
            const d = result.data; 
            currentDiaryServerUpdatedAt = d.updated_at || '';
            currentDiaryServerContent = d.content || '';
            currentDiaryServerMood = d.mood_label || '一般';
            currentDiaryServerImagePaths = d.image_paths || '';
            contentInput.value = d.content;
            renderTodayDiaryState(d, targetDate);
            setActiveMood(d.mood_label || '一般');
            
            retainedImages = parseDiaryImagePaths(d.image_paths || d.retained_images || '');
            demoRetainedImages = [];
            removedRetainedImages = [];
            newImageFiles = []; 
            hasRemovedRetainedDiaryImage = false;
            renderImagePreviews();
            
            setDiarySubmitMode('update');
            const savedDraft = typeof window.getDiaryDraftSnapshot === 'function'
                ? await window.getDiaryDraftSnapshot(targetDate)
                : null;
            if (!isCurrentLoad()) return;
            const canRestoreDraft = savedDraft?.content
                && savedDraft.mode === 'update'
                && (!savedDraft.server_updated_at || savedDraft.server_updated_at === currentDiaryServerUpdatedAt)
                && savedDraft.content !== d.content;
            if (canRestoreDraft) {
                const draftMood = savedDraft.mood_label || d.mood_label || '一般';
                contentInput.value = savedDraft.content;
                setActiveMood(draftMood);
                renderTodayDiaryState({ ...d, content: savedDraft.content, mood_label: draftMood }, targetDate);
                showToast(' 📝  已为你恢复未保存的编辑草稿');
            }
        } else {
            currentDiaryServerUpdatedAt = '';
            currentDiaryServerContent = '';
            currentDiaryServerMood = '一般';
            currentDiaryServerImagePaths = '';
            retainedImages = []; 
            demoRetainedImages = [];
            removedRetainedImages = [];
            newImageFiles = []; 
            hasRemovedRetainedDiaryImage = false;
            renderImagePreviews();
            
            setDiarySubmitMode('create');
            
            const savedDraft = typeof window.getDiaryDraftSnapshot === 'function'
                ? await window.getDiaryDraftSnapshot(targetDate)
                : { content: await getDiaryDraft(targetDate) };
            if (!isCurrentLoad()) return;
            if (savedDraft?.content) {
                contentInput.value = savedDraft.content;
                setActiveMood(savedDraft.mood_label || '一般');
                renderTodayDiaryState(null, targetDate, true);
                showToast(' 📝  已为你恢复未保存的草稿'); 
            } else { 
                contentInput.value = ''; 
                setActiveMood('一般');
                renderTodayDiaryState(null, targetDate);
            }
        }
        rememberActiveDiaryDate(targetDate);
    } catch (e) {
        if (!isCurrentLoad()) return;
        console.error(e);
        await restoreLocalDiaryOrDraft(targetDate, isCurrentLoad);
        if (isCurrentLoad()) rememberActiveDiaryDate(targetDate);
    }
}

const MAX_DIARY_IMAGE_COUNT = 9;

function setupDiaryImageInputMultiSelect() {
    if (!hiddenImageInput) return;
    // 手机端必须显式保持 multiple，避免旧缓存或浏览器恢复表单状态后退回单选。
    hiddenImageInput.multiple = true;
    hiddenImageInput.setAttribute('multiple', 'multiple');
    hiddenImageInput.setAttribute('accept', 'image/*');
    hiddenImageInput.removeAttribute('capture');
    hiddenImageInput.dataset.diaryMultiSelect = '1';
}

function setupDiaryAnyFileImageInput() {
    if (!diaryAnyFileImageInput) return;
    diaryAnyFileImageInput.multiple = true;
    diaryAnyFileImageInput.setAttribute('multiple', 'multiple');
    diaryAnyFileImageInput.removeAttribute('accept');
    diaryAnyFileImageInput.removeAttribute('capture');
    diaryAnyFileImageInput.dataset.diaryMultiSelect = '1';
}

function isAllowedDiaryImageFile(file) {
    if (!file) return false;
    const name = String(file.name || '').toLowerCase();
    const type = String(file.type || '').toLowerCase();
    const allowedExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const allowedMime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const extOk = allowedExt.some(ext => name.endsWith(ext));
    const mimeOk = allowedMime.includes(type);
    return extOk || mimeOk;
}

function getSelectedDiaryImageFiles(fileList) {
    return Array.from(fileList || []).filter(isAllowedDiaryImageFile);
}

function getRemainingDiaryImageSlots() {
    return Math.max(0, MAX_DIARY_IMAGE_COUNT - retainedImages.length - demoRetainedImages.length - newImageFiles.length);
}

async function appendDiaryImageFiles(files) {
    const rawFiles = Array.from(files || []);
    const imageFiles = getSelectedDiaryImageFiles(rawFiles);
    if (!imageFiles.length) {
        const message = rawFiles.length > 0
            ? '请选择 JPG、PNG、WEBP 或 GIF 图片文件'
            : '请选择图片文件';
        showToast(message, true);
        return;
    }
    if (imageFiles.length < rawFiles.length) {
        showToast(`已自动忽略 ${rawFiles.length - imageFiles.length} 个非图片文件`, true);
    }

    const remaining = getRemainingDiaryImageSlots();
    if (remaining <= 0) {
        showToast('最多只能放9张图', true);
        return;
    }

    const acceptedFiles = imageFiles.slice(0, remaining);
    if (imageFiles.length > acceptedFiles.length) {
        showToast(`最多还能添加 ${remaining} 张，已自动保留前 ${remaining} 张`, true);
    }

    const compressed = [];
    let failedCount = 0;
    for (let i = 0; i < acceptedFiles.length; i += 1) {
        if (imgCountHint) {
            imgCountHint.textContent = `正在处理 ${i + 1}/${acceptedFiles.length}...`;
        }
        try {
            // 手机端逐张压缩，避免一次性并发处理多张大图造成内存抖动。
            const compressedFile = await compressImage(acceptedFiles[i], 1600, 0.85);
            if (compressedFile) {
                compressed.push(compressedFile);
            } else {
                failedCount += 1;
            }
        } catch (_) {
            failedCount += 1;
        }
    }

    if (compressed.length) {
        newImageFiles = newImageFiles.concat(compressed);
    }
    if (failedCount > 0) {
        showToast(`部分图片处理失败，已添加 ${compressed.length} 张`, true);
    } else if (compressed.length) {
        showToast(`已添加 ${compressed.length} 张图片`);
    } else {
        showToast('图片处理失败，请换几张再试', true);
    }
}

setupDiaryImageInputMultiSelect();
setupDiaryAnyFileImageInput();

hiddenImageInput.addEventListener('change', async function(e) {
    setupDiaryImageInputMultiSelect();
    try {
        await appendDiaryImageFiles(e.target.files);
    } finally {
        this.value = '';
        renderImagePreviews();
    }
});

async function openDiaryAnyFileImagePicker() {
    setupDiaryAnyFileImageInput();
    if (window.showOpenFilePicker) {
        try {
            const handles = await window.showOpenFilePicker({
                multiple: true,
            });
            const files = [];
            for (const handle of handles) {
                files.push(await handle.getFile());
            }
            await appendDiaryImageFiles(files);
            renderImagePreviews();
            return;
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.warn('文件管理器选择器不可用，回退到 input file', error?.name || error);
            }
        }
    }
    diaryAnyFileImageInput?.click();
}

openDiaryAnyFileImageBtn?.addEventListener('click', () => {
    openDiaryAnyFileImagePicker();
});

diaryAnyFileImageInput?.addEventListener('change', async function(e) {
    try {
        await appendDiaryImageFiles(e.target.files);
    } finally {
        this.value = '';
        renderImagePreviews();
    }
});

function removeImg(index) {
    const retainedCount = retainedImages.length;
    if (index < retainedCount) {
        const [removedPath] = retainedImages.splice(index, 1);
        removedRetainedImages = mergeDiaryImagePaths(removedRetainedImages, removedPath);
        hasRemovedRetainedDiaryImage = true;
    } else if (index < retainedCount + demoRetainedImages.length) {
        demoRetainedImages.splice(index - retainedCount, 1);
        hasRemovedRetainedDiaryImage = true;
    } else {
        const newIndex = index - retainedCount - demoRetainedImages.length;
        if (newIndex >= 0 && newIndex < newImageFiles.length) {
            newImageFiles.splice(newIndex, 1);
        }
    }
    renderImagePreviews();
}

function renderImagePreviews() {
    // 1. 清空旧的预览图
    document.querySelectorAll('.thumbnail-wrap').forEach(el => el.remove());

    // 2. 遍历所有图片并渲染
    [...retainedImages, ...demoRetainedImages, ...newImageFiles].forEach((img, i) => {
        const src = typeof img === 'string' ? normalizeImageSrc(img) : URL.createObjectURL(img);
        if (!src) return;
        
        // 创建外层容器
        const wrap = document.createElement('div');
        wrap.className = 'thumbnail-wrap relative w-full aspect-square rounded-xl shadow-sm border border-gray-100 overflow-hidden';
        
        // 创建图片元素
        const imgEl = document.createElement('img');
        imgEl.src = src;
        imgEl.className = 'diary-img w-full h-full object-cover cursor-zoom-in';
        imgEl.dataset.src = src;
        imgEl.addEventListener('click', () => openLightbox(src));
        
        // 创建删除按钮
        const delBadge = document.createElement('div');
        delBadge.className = 'del-badge';
        delBadge.textContent = ' ✕ ';
        delBadge.addEventListener('click', () => removeImg(i));
        
        // 将图片和按钮组装到容器中
        wrap.appendChild(imgEl);
        wrap.appendChild(delBadge);
        
        // 插入到页面中
        imagePreviewGrid.insertBefore(wrap, addImageBtnWrap);
    });

    // 3. 更新图片数量提示和“+”号按钮状态
    const t = retainedImages.length + demoRetainedImages.length + newImageFiles.length;
    imgCountHint.textContent = `${t}/${MAX_DIARY_IMAGE_COUNT}`;
    
    if (t >= MAX_DIARY_IMAGE_COUNT) {
        addImageBtnWrap.classList.add('hidden');
        addImageBtnWrap.classList.remove('flex');
    } else {
        addImageBtnWrap.classList.remove('hidden');
        addImageBtnWrap.classList.add('flex');
    }
}
async function deleteDiary(dateStr) {
    if(!confirm(`确定要删除 ${dateStr} 吗？`)) return false;
    if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('删除日记'))) return false;
    try {
        const previousDiary = await LocalStorage.get('diaries', dateStr).catch(() => null);
        const baseRevision = Number(previousDiary?.local_revision || 0);
        if (isDemoMode()) {
            await LocalStorage.delete('diaries', dateStr).catch(() => {});
            showToast('已删除 Demo 日记');
            if(dateInput.value === dateStr) checkExistingDiary(dateStr);
            profileArchiveData = profileArchiveData.filter((diary) => diary.date !== dateStr);
            renderProfileDiaryArchive();
            fetchDiaries();
            if(document.getElementById('view-profile').classList.contains('active')) renderCalendar();
            return true;
        }
        const res = await apiFetch(`/api/diaries/${dateStr}`, { method: 'DELETE' });
        if((await res.json()).status === 'success') {
            showToast(' ✅  已删除'); 
            if(dateInput.value === dateStr) checkExistingDiary(dateStr);
            profileArchiveData = profileArchiveData.filter((diary) => diary.date !== dateStr);
            window.markLocalDataChanged?.('diary_deleted');
            // 删除也只记录 tombstone 元数据，后续增量同步阶段再加密 payload。
            await window.LeafVaultIncrementalSync?.createLocalChange?.({
                entity_type: 'diary',
                entity_id: dateStr,
                operation: 'delete',
                base_revision: baseRevision,
                local_revision: baseRevision + 1,
            }).catch((error) => console.warn('本地日记删除变更日志记录失败', error));
            renderProfileDiaryArchive();
            fetchDiaries(); 
            if(document.getElementById('view-profile').classList.contains('active')) renderCalendar();
            return true;
        }
    } catch(e) {}
    return false;
}

// ====================================================

async function fetchDiaries(keyword = '') {
  const list = document.getElementById('diaryList');

  // 先展示骨架占位（仅空列表时）
  if (!list.innerHTML.trim()) {
    if (window.LeafVaultUIState?.renderLoadingState) {
      window.LeafVaultUIState.renderLoadingState(list, {
        title: '正在加载日记...',
        description: '把最近的记忆轻轻取出来。',
        compact: true,
        skeleton: true,
      });
    } else {
      list.innerHTML = '<p class="text-center text-gray-400 text-sm py-10">⏳ 记忆加载中...</p>';
    }
  }

  // ── 1. 读本地缓存（失败则容忍） ──────────────────────────
  let localData = [];
  try {
    const raw = await LocalStorage.getAll('diaries');
    localData = raw || [];
  } catch (dbErr) {
    console.warn('⚠️ IndexedDB 繁忙，将仅使用服务器数据');
  }

  const filteredLocal = sortDiariesForDisplay(
    localData.filter(d => diaryMatchesKeyword(d, keyword))
  );
  profileArchiveData = sortDiariesForDisplay(localData);
  renderProfileDiaryArchive();

  // 本地有数据 → 立即渲染（乐观展示）
  if (filteredLocal.length > 0 || !navigator.onLine) {
    allDiariesData = filteredLocal;
    renderDiaryList(getHomeTimelineData(localData, keyword), keyword);
  }

  if (isDemoMode()) {
    if (!localData.length) {
      allDiariesData = [];
      renderDiaryList([], keyword);
    }
    return;
  }

  if (!navigator.onLine) return;

  // ── 2. 拉取服务器数据 ─────────────────────────────────────
  try {
    const url = keyword
      ? `/api/diaries/list?keyword=${encodeURIComponent(keyword)}`
      : '/api/diaries/list';
    const res  = await apiFetch(url);
    const json = await res.json();

    if (json.status === 'success' && json.data) {
      const serverData = json.data;

      // 本地待同步(sync_status=1)的条目优先保留，避免被服务器旧版本覆盖
      const pendingLocal  = localData.filter(d => d.sync_status === 1 || d.sync_status === 2);
      const pendingDates  = new Set(pendingLocal.map(d => d.date));

      const merged = [...pendingLocal];
      for (const s of serverData) {
        if (!pendingDates.has(s.date)) merged.push({ ...s, sync_status: 0 });
      }

      const displayData = sortDiariesForDisplay(
        merged.filter(d => diaryMatchesKeyword(d, keyword))
      );
      profileArchiveData = sortDiariesForDisplay(merged);
      allDiariesData = displayData;
      renderDiaryList(getHomeTimelineData(merged, keyword), keyword);
      renderProfileDiaryArchive();

      // 后台静默更新本地缓存（用服务器真实图片路径覆盖临时 blob:// 路径）
      setTimeout(async () => {
        for (const item of serverData) {
          try {
            const existing = await LocalStorage.get('diaries', item.date);
            // 不覆盖本地待同步的记录
            if (!existing || existing.sync_status !== 1) {
              await LocalStorage.set('diaries', { ...item, sync_status: 0 });
            }
          } catch (_) { /* 单条写入失败不影响全局 */ }
        }
      }, 400);

    } else if (localData.length === 0) {
      profileArchiveData = [];
      renderProfileDiaryArchive();
      if (window.LeafVaultUIState?.renderEmptyState) {
        window.LeafVaultUIState.renderEmptyState(list, {
          title: '还没有写日记',
          description: '今天可以先记录一句话。',
          compact: true,
        });
      } else {
        list.innerHTML = '<p class="text-center text-gray-400 text-sm py-10">最近 3 日还没有日记</p>';
      }
    }
  } catch (e) {
    console.error('拉取日记失败:', e);
    // 已有本地数据的情况下不显示错误，静默降级
    if (localData.length === 0) {
      if (window.LeafVaultUIState?.renderErrorState) {
        window.LeafVaultUIState.renderErrorState(list, {
          title: '日记加载失败',
          description: window.LeafVaultUIState.normalizeUserFacingError?.(e) || '网络连接异常，请检查网络后重试。',
          retryText: '重新加载',
          onRetry: () => fetchDiaries(keyword),
          compact: true,
        });
      } else {
        list.innerHTML = '<p class="text-center text-red-400 text-sm py-10">❌ 加载失败，请刷新重试</p>';
      }
    }
  }
}


// =====================================================================

// 时光日记：提交保存
// 优先直传服务器并回读真实图片路径；离线或超时时写入 IndexedDB，联网后后台补偿同步。
// =====================================================================
async function handleDiarySubmit(e) {
  e.preventDefault();
  if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('保存日记'))) return;
  const btn      = document.getElementById('mainDiarySubmitBtn');
  const headerBtn = document.getElementById('editorHeaderSaveBtn');
  const origHtml = btn.innerHTML;
  const origHeaderHtml = headerBtn?.innerHTML || '';
  if (window.LeafVaultUIState?.setButtonLoading) {
    window.LeafVaultUIState.setButtonLoading(btn, true, { text: '保存中...' });
  } else {
    btn.disabled   = true;
    btn.textContent = '保存中...';
  }
  if (headerBtn) {
    if (window.LeafVaultUIState?.setButtonLoading) {
      window.LeafVaultUIState.setButtonLoading(headerBtn, true, { text: '保存中...' });
    } else {
      headerBtn.disabled = true;
      headerBtn.innerHTML = '<span>保存中...</span>';
    }
  }

  const targetDate = dateInput.value;

  try {
    const resolvedRetainedImages = await getRetainedImagesForSubmit(targetDate);
    const resolvedRetainedImageText = resolvedRetainedImages.join(',');
    const removedImageText = mergeDiaryImagePaths(removedRetainedImages).join(',');
    // ── 构建 FormData（把真实 File 对象传给服务器）────────────────
    const fd = new FormData();
    fd.append('date',            targetDate);
    fd.append('mood_label',      moodLabelInput.value);
    fd.append('content',         contentInput.value);
    fd.append('retained_images', resolvedRetainedImageText);
    fd.append('removed_images',  removedImageText);
    if (btn.dataset.mode === 'update' && currentDiaryServerUpdatedAt) {
      fd.append('updated_at', currentDiaryServerUpdatedAt);
    }
    // 把每个压缩后的文件直接 append
    newImageFiles.forEach(f => fd.append('images', f));

    let syncOk     = false;
    let serverItem = null;
    let savedImagePaths = '';
    let savedUpdatedAt = '';
    let hasConflict = false;
    const demoModeActive = isDemoMode();
    const demoServerUploadEnabled = demoModeActive && isDemoServerUploadEnabled();
    const shouldUploadDiaryToServer = navigator.onLine && (!demoModeActive || demoServerUploadEnabled);
    const previousDiaryBeforeSave = await LocalStorage.get('diaries', targetDate).catch(() => null);
    const demoNewImageDataUrls = demoModeActive ? await filesToDiaryDataUrls(newImageFiles) : [];
    const demoImagePathText = demoModeActive
      ? serializeDiaryImagePaths([...resolvedRetainedImages, ...demoRetainedImages, ...demoNewImageDataUrls])
      : '';

    if (shouldUploadDiaryToServer) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);  // 12秒超时
        const res   = await apiFetch('/api/diaries/', {
          method: 'POST',
          body:   fd,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const json = await res.json();
        if (json.status === 'success') {
          syncOk = true;
          savedImagePaths = json.image_paths || resolvedRetainedImageText;
          savedUpdatedAt = json.updated_at || new Date().toISOString();
          currentDiaryServerUpdatedAt = savedUpdatedAt;
          showToast('🎉 日记已保存！');

          // 拉取服务器上的真实图片路径（而不是本地 blob://）
          try {
            const dr   = await apiFetch(`/api/diaries/detail?date=${targetDate}`);
            const dj   = await dr.json();
            if (dj.status === 'success') serverItem = dj.data;
          } catch (_) { /* 获取详情失败不影响主流程 */ }

        } else if (json.status === 'conflict') {
          hasConflict = true;
          showToast('⚠️ 与云端版本冲突，请刷新后查看', true);
        } else {
          showToast('⚠️ ' + (json.message || json.detail || '保存异常，已离线备份'), true);
        }
      } catch (netErr) {
        showToast('📴 网络超时，已离线保存，联网后自动同步');
      }
    } else if (demoModeActive) {
      showToast('Demo 日记已保存在当前浏览器。');
    } else {
      showToast('📴 已离线保存，联网后自动同步');
    }

    if (hasConflict) return;

    // ── 构建本地缓存对象 ──────────────────────────────────────────
    // 优先使用服务器返回的真实路径；离线时暂用空路径（不用 blob://）
    const localDiaryObj = serverItem
      ? { ...serverItem, sync_status: 0, offline_files: [], demo_image_data_urls: [] }
      : {
          date:            targetDate,
          mood_label:      moodLabelInput.value,
          content:         contentInput.value,
          retained_images: demoModeActive ? demoImagePathText : resolvedRetainedImageText,
          removed_images:  syncOk ? '' : removedImageText,
          image_paths:     demoModeActive ? demoImagePathText : (syncOk ? savedImagePaths : resolvedRetainedImageText),  // 在线成功后使用服务端返回路径
          demo_image_data_urls: [],
          offline_files:   (!syncOk && !demoModeActive) ? [...newImageFiles] : [],        // 只有真正离线失败时才保留文件待同步
          server_updated_at: currentDiaryServerUpdatedAt || '',
          is_pinned:       0,
          sync_status:     (syncOk || demoModeActive) ? 0 : 1,
          created_at:      new Date().toISOString(),
          updated_at:      savedUpdatedAt || new Date().toISOString(),
        };

    try {
      const previousDiary = previousDiaryBeforeSave;
      const baseRevision = Number(previousDiary?.local_revision || 0);
      const localRevision = baseRevision + 1;
      const diaryOperation = btn.dataset.mode === 'update' || previousDiary ? 'update' : 'create';

      localDiaryObj.local_revision = localRevision;
      localDiaryObj.deleted_at = localDiaryObj.deleted_at || '';
      localDiaryObj.device_id = window.LeafVaultIncrementalSync?.getDeviceId?.() || localDiaryObj.device_id || '';

      await LocalStorage.set('diaries', localDiaryObj);
      window.markLocalDataChanged?.('diary_saved');

      // 仅记录同步所需元数据，不把日记正文写入 local_changes。
      if (!demoModeActive) await window.LeafVaultIncrementalSync?.createLocalChange?.({
        entity_type: 'diary',
        entity_id: targetDate,
        operation: diaryOperation,
        base_revision: baseRevision,
        local_revision: localRevision,
      }).catch((error) => console.warn('本地日记变更日志记录失败', error));
    } catch (dbErr) {
      console.warn('IndexedDB 写入失败，依赖服务器数据:', dbErr);
    }

    // ── 清理草稿和图片选择器 ──────────────────────────────────────
    await deleteDiaryDraft(targetDate);
    document.getElementById('diarySearchInput').value = '';
    removedRetainedImages = [];
    hasRemovedRetainedDiaryImage = false;
    newImageFiles = [];
    renderImagePreviews();
    hideDiaryEditor();

    // ── 刷新列表（稍后执行，给服务器处理完的时间） ───────────────
    setTimeout(() => {
      fetchDiaries();
      checkExistingDiary(targetDate);
    }, 300);

    // ── 离线时后台继续重试 ─────────────────────────────────────────
    if (!syncOk && !demoModeActive) triggerBackgroundSync();

  } catch (err) {
    console.error('日记保存失败:', err);
    const friendly = window.LeafVaultUIState?.normalizeUserFacingError?.(err) || '保存失败，请重试';
    showToast(friendly, true);
  } finally {
    if (window.LeafVaultUIState?.setButtonLoading) {
      window.LeafVaultUIState.setButtonLoading(btn, false);
    } else {
      btn.disabled    = false;
      btn.innerHTML = origHtml;
    }
    if (headerBtn) {
      if (window.LeafVaultUIState?.setButtonLoading) {
        window.LeafVaultUIState.setButtonLoading(headerBtn, false);
      } else {
        headerBtn.disabled = false;
        headerBtn.innerHTML = origHeaderHtml;
      }
    }
  }
}

window.__leafVaultDiarySubmitReady = true;
window.jumpToDiary = jumpToDiary;
window.handleDiarySubmit = handleDiarySubmit;
window.closeDiaryFullPreview = closeDiaryFullPreview;
window.openDiaryReadonlyPreview = openDiaryReadonlyPreview;
window.closeDiaryReadonlyPreview = closeDiaryReadonlyPreview;
window.renderProfileDiaryArchive = renderProfileDiaryArchive;
window.triggerBackgroundSync = triggerBackgroundSync;
document.getElementById('diaryForm').addEventListener('submit', handleDiarySubmit);


// =====================================================================
// 时光日记：后台补偿同步
// 只处理日记；账本由 _syncPendingLedgers 独立处理。同步成功后回读服务器详情覆盖本地缓存。
// =====================================================================
let isSyncing = false;
let lastDiarySyncTriggerAt = 0;
let lastBackgroundSyncRegisterAt = 0;
let diarySyncCooldownUntil = 0;
let diarySyncRateLimitToastAt = 0;
const DIARY_SYNC_TRIGGER_THROTTLE_MS = 5000;
const DIARY_SYNC_REGISTER_THROTTLE_MS = 30000;
const DIARY_SYNC_RATE_LIMIT_COOLDOWN_MS = 30000;
const DIARY_SYNC_ITEM_DELAY_MS = 220;

async function registerDiaryBackgroundSyncOnce() {
  const now = Date.now();
  if (now - lastBackgroundSyncRegisterAt < DIARY_SYNC_REGISTER_THROTTLE_MS) return false;
  lastBackgroundSyncRegisterAt = now;
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.sync.register('LeafVault-sync');
    return true;
  } catch (e) {
    console.warn('后台同步注册失败', e);
    return false;
  }
}

async function triggerBackgroundSync(options = {}) {
  if (isDemoMode()) return false;
  const source = typeof options === 'string' ? options : (options.source || 'manual');
  const force = Boolean(options.force);
  const now = Date.now();

  if (isSyncing) {
    console.info('已有日记同步任务进行中，跳过重复触发', { source });
    return false;
  }
  if (now < diarySyncCooldownUntil) {
    console.info('日记同步处于限流冷却中，跳过本次触发', { source });
    return false;
  }
  if (!force && now - lastDiarySyncTriggerAt < DIARY_SYNC_TRIGGER_THROTTLE_MS) {
    console.info('日记同步触发过于频繁，已节流', { source });
    return false;
  }
  lastDiarySyncTriggerAt = now;

  if (!navigator.onLine) {
    await registerDiaryBackgroundSyncOnce();
    return false;
  }

  isSyncing = true;
  try {
    const localDiaries   = await LocalStorage.getAll('diaries').catch(() => []);
    const pendingDiaries = (localDiaries || []).filter(d => d.sync_status === 1);

    console.info('[LeafVault:DiarySync] 待同步日记数量', { count: pendingDiaries.length, source });
    let hitRateLimit = false;
    for (const diary of pendingDiaries) {
      if (hitRateLimit) break;
      console.info('[LeafVault:DiarySync] 后台同步日记', { date: diary.date });
      const fd = new FormData();
      fd.append('date',            diary.date);
      fd.append('mood_label',      diary.mood_label);
      fd.append('content',         diary.content);
      if (diary.server_updated_at) fd.append('updated_at', diary.server_updated_at);
      const syncRetainedImages = mergeDiaryImagePaths(diary.image_paths || '', diary.retained_images || '');
      const syncRemovedImages = mergeDiaryImagePaths(diary.removed_images || '')
        .filter(path => !syncRetainedImages.includes(path));
      fd.append('retained_images', syncRetainedImages.join(','));
      fd.append('removed_images', syncRemovedImages.join(','));
      // 把离线保存的 File 对象传给服务器
      if (diary.offline_files && diary.offline_files.length > 0) {
        diary.offline_files.forEach(file => {
          if (file instanceof Blob) fd.append('images', file);
        });
      }

      try {
        const res  = await fetchWithRetry('/api/diaries/', { method: 'POST', body: fd });
        if (res.status === 429) {
          hitRateLimit = true;
          diarySyncCooldownUntil = Date.now() + DIARY_SYNC_RATE_LIMIT_COOLDOWN_MS;
          if (Date.now() - diarySyncRateLimitToastAt > DIARY_SYNC_RATE_LIMIT_COOLDOWN_MS) {
            diarySyncRateLimitToastAt = Date.now();
            showToast('同步请求过于频繁，稍后将自动重试。', true);
          }
          console.info('[LeafVault:DiarySync] 后端返回 429，本批次暂停', { date: diary.date });
          break;
        }
        const json = await res.json();

        if (json.status === 'success') {
          // 从服务器拉取包含真实图片路径的完整数据
          try {
            const dr = await apiFetch(`/api/diaries/detail?date=${diary.date}`);
            const dj = await dr.json();
            if (dj.status === 'success') {
              const serverItem = { ...dj.data, sync_status: 0, offline_files: [] };
              await LocalStorage.set('diaries', serverItem);
              console.log(`✅ 日记 ${diary.date} 同步完成，真实图片路径已更新`);
            } else {
              diary.sync_status = 0;
              delete diary.offline_files;
              await LocalStorage.set('diaries', diary);
            }
          } catch (_) {
            diary.sync_status = 0;
            delete diary.offline_files;
            await LocalStorage.set('diaries', diary);
          }
        } else if (json.status === 'conflict') {
          diary.sync_status = 2;
          await LocalStorage.set('diaries', diary);
          showToast(`⚠️ 日记 ${diary.date} 与云端冲突`, true);
        }
      } catch (err) {
        console.warn(`日记 ${diary.date} 同步失败，将在下次重试`);
      }
      await sleepDiarySync(DIARY_SYNC_ITEM_DELAY_MS);
    }

    if (pendingDiaries.length > 0) fetchDiaries();
    // 账本由独立函数处理
    if (!hitRateLimit) _syncPendingLedgers();

  } finally {
    isSyncing = false;
  }
  return true;
}

// 网络恢复时自动触发（只注册一次）
window.addEventListener('online', () => {
  if (isDemoMode()) return;
  showToast('🌐 网络已恢复，正在同步数据...');
  triggerBackgroundSync();
  _syncPendingLedgers();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const lightbox = document.getElementById('lightbox');
  if (lightbox && !lightbox.classList.contains('hidden')) return;
  closeDiaryFullPreview();
});

setupDiaryImageErrorFallback();

// 时光日记：草稿自动保存
// 只绑定一次 input 事件；仅在“新建日记”状态下写入本地草稿。
// ============================================================
(function setupDraftAutosave() {
  const box     = document.getElementById('content');
 
  if (!box) return;
 
  const scheduleDraftSave = (showHint = false) => {
    clearTimeout(window._draftTimer);
    window._draftTimer = setTimeout(() => {
      saveDiaryDraftImmediately(box.value, { showHint });
    }, 80);
  };

  box.addEventListener('input', function () {
    saveDiaryDraftEmergency(this.value);
    scheduleDraftSave(true);
  });

  box.addEventListener('keyup', function () {
    saveDiaryDraftEmergency(this.value);
  });

  box.addEventListener('compositionend', function () {
    saveDiaryDraftEmergency(this.value);
    scheduleDraftSave(true);
  });

  box.addEventListener('blur', function () {
    saveDiaryDraftEmergency(this.value);
    saveDiaryDraftImmediately(this.value);
  });

  const flushDraftBeforeLeave = () => {
    saveDiaryDraftEmergency(box.value);
    saveDiaryDraftImmediately(box.value);
  };

  window.addEventListener('beforeunload', flushDraftBeforeLeave);
  window.addEventListener('pagehide', flushDraftBeforeLeave);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushDraftBeforeLeave();
    }
  });

  document.addEventListener('freeze', flushDraftBeforeLeave);
})();
// ====================================================
