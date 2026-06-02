// LeafVault ledger module. Extracted from templates/index.html without changing behavior.
// It intentionally keeps legacy global function names while newer UI uses event delegation.

const ledgerDatePicker = typeof createDatePicker === 'function' ? createDatePicker({
  inputId: 'ledgerDate',
  textId: 'ledgerDateText',
  fieldId: 'ledgerDateField',
  triggerId: 'ledgerDateTrigger',
  panelId: 'ledgerDatePicker',
  gridId: 'ledgerCalendarDayGrid',
  titleId: 'ledgerCalendarMonthTitle',
  prevId: 'ledgerCalendarPrevMonth',
  nextId: 'ledgerCalendarNextMonth',
  todayId: 'ledgerCalendarTodayBtn',
}) : {
  syncButton(value = document.getElementById('ledgerDate')?.value) {
    const textEl = document.getElementById('ledgerDateText');
    if (textEl && value) textEl.textContent = value.replace(/-/g, '/');
  },
  render() {},
  show() {
    document.getElementById('ledgerDate')?.showPicker?.();
  },
  hide() {},
  setup() {
    document.getElementById('ledgerDateTrigger')?.addEventListener('click', () => this.show());
  },
};

function syncLedgerDateButton(value = document.getElementById('ledgerDate')?.value) {
  ledgerDatePicker.syncButton(value);
}

function renderLedgerDateCalendar() {
  ledgerDatePicker.render();
}

function showLedgerDatePicker() {
  ledgerDatePicker.show();
}

function hideLedgerDatePicker() {
  ledgerDatePicker.hide();
}

function setupLedgerDatePicker() {
  ledgerDatePicker.setup();
}

function getLocalLedgerMonthValue(date = new Date()) {
  if (typeof formatMonthValue === 'function') return formatMonthValue(date);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function normalizeLedgerMonthValue(value) {
  return /^\d{4}-\d{2}$/.test(String(value || '')) ? String(value) : getLocalLedgerMonthValue();
}

let selectedLedgerMonth = normalizeLedgerMonthValue(getLocalLedgerMonthValue());

const ledgerMonthPicker = typeof createMonthPicker === 'function' ? createMonthPicker({
  fieldId: 'ledgerMonthField',
  inputId: 'ledgerMonthPicker',
  textId: 'ledgerMonthText',
  triggerId: 'ledgerMonthTrigger',
  panelId: 'ledgerMonthPanel',
  titleId: 'ledgerMonthYearTitle',
  gridId: 'ledgerMonthGrid',
  prevId: 'ledgerMonthYearPrev',
  nextId: 'ledgerMonthYearNext',
}) : {
  syncButton() {
    const text = document.getElementById('ledgerMonthText');
    if (text) text.textContent = selectedLedgerMonth.replace('-', ' / ');
  },
  render() {},
  show() {
    document.getElementById('ledgerMonthPicker')?.showPicker?.();
  },
  hide() {},
  setup() {
    document.getElementById('ledgerMonthTrigger')?.addEventListener('click', () => this.show());
  },
};

function getLedgerMonthKey(ledger) {
  const value = String(ledger?.created_at || ledger?.date || '');
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : '';
}

function filterLedgersByMonth(ledgers, month = selectedLedgerMonth) {
  const targetMonth = normalizeLedgerMonthValue(month);
  return (ledgers || []).filter(item => getLedgerMonthKey(item) === targetMonth);
}

function filterLedgersByYear(ledgers, year) {
  const targetYear = String(year || '').slice(0, 4);
  return (ledgers || []).filter(item => getLedgerMonthKey(item).slice(0, 4) === targetYear);
}

function formatLedgerMonthHeading(month = selectedLedgerMonth) {
  const normalized = normalizeLedgerMonthValue(month);
  const [year, monthPart] = normalized.split('-');
  return normalized === getLocalLedgerMonthValue()
    ? `${monthPart} 月流水`
    : `${year} 年 ${monthPart} 月流水`;
}

function formatLedgerMonthShort(month = selectedLedgerMonth) {
  return normalizeLedgerMonthValue(month).replace('-', ' / ');
}

function renderLedgerMonthSummary(allData = window.allLedgersData || [], visibleData = filterLedgersByMonth(allData)) {
  const title = document.getElementById('ledgerMonthTitle');
  const totals = document.getElementById('ledgerMonthTotals');
  const count = document.getElementById('ledgerMonthCount');
  if (title) title.textContent = formatLedgerMonthHeading(selectedLedgerMonth);

  const income = visibleData
    .filter(item => item.type === 'income')
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const expense = visibleData
    .filter(item => item.type !== 'income')
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const balance = income - expense;

  if (totals) {
    totals.innerHTML = `
      <span>支出 ¥${expense.toFixed(2)}</span>
      <span>收入 ¥${income.toFixed(2)}</span>
      <span class="${balance >= 0 ? 'is-positive' : 'is-negative'}">净额 ${balance >= 0 ? '+' : '-'}¥${Math.abs(balance).toFixed(2)}</span>`;
  }
  if (count) count.textContent = `${visibleData.length} 条`;
}

function syncLedgerMonthButton(value = selectedLedgerMonth) {
  const input = document.getElementById('ledgerMonthPicker');
  if (input) input.value = normalizeLedgerMonthValue(value);
  ledgerMonthPicker.syncButton();
  const text = document.getElementById('ledgerMonthText');
  if (text) text.textContent = formatLedgerMonthShort(value);
}

function setSelectedLedgerMonth(value, options = {}) {
  selectedLedgerMonth = normalizeLedgerMonthValue(value);
  syncLedgerMonthButton(selectedLedgerMonth);
  renderLedgerMonthSummary();
  if (options.refresh !== false) renderLedgerList(window.allLedgersData || []);
}

function setupLedgerMonthPicker() {
  const input = document.getElementById('ledgerMonthPicker');
  if (!input) return;
  if (!input.value) input.value = selectedLedgerMonth;
  ledgerMonthPicker.setup();
  syncLedgerMonthButton(selectedLedgerMonth);
  renderLedgerMonthSummary();
  if (input.dataset.ledgerMonthBound !== '1') {
    input.dataset.ledgerMonthBound = '1';
    input.addEventListener('change', () => setSelectedLedgerMonth(input.value));
  }
}

// 流水账本模块：删除、渲染、拉取、离线补偿同步
// ====================================================
const LEDGER_CATEGORY_OPTIONS = {
  expense: [
    { label: '三餐', value: ' 🍱  三餐', color: '#10b981', bg: 'linear-gradient(135deg, #dcfce7, #f0fdf4)' },
    { label: '购物', value: ' 🛒  购物', color: '#38bdf8', bg: 'linear-gradient(135deg, #e0f2fe, #f0f9ff)' },
    { label: '聚餐', value: ' 🍻  聚餐', color: '#f59e0b', bg: 'linear-gradient(135deg, #fef3c7, #fffbeb)' },
    { label: '交通', value: ' 🚌  交通', color: '#0ea5e9', bg: 'linear-gradient(135deg, #dbeafe, #eff6ff)' },
    { label: '话费', value: ' 📱  话费', color: '#8b5cf6', bg: 'linear-gradient(135deg, #ede9fe, #f5f3ff)' },
    { label: '医疗', value: ' 💊  医疗', color: '#fb7185', bg: 'linear-gradient(135deg, #ffe4e6, #fff1f2)' },
    { label: '水果', value: ' 🍎  水果', color: '#22c55e', bg: 'linear-gradient(135deg, #dcfce7, #f7fee7)' },
    { label: '水电', value: ' ⚡  水电', color: '#06b6d4', bg: 'linear-gradient(135deg, #cffafe, #ecfeff)' },
    { label: '学习', value: ' 学习', color: '#6366f1', bg: 'linear-gradient(135deg, #e0e7ff, #eef2ff)' },
    { label: '日用品', value: ' 日用品', color: '#14b8a6', bg: 'linear-gradient(135deg, #ccfbf1, #f0fdfa)' },
    { label: '零食', value: ' 零食', color: '#f97316', bg: 'linear-gradient(135deg, #ffedd5, #fff7ed)' },
    { label: '奶茶', value: ' 奶茶', color: '#d946ef', bg: 'linear-gradient(135deg, #fae8ff, #fdf4ff)' },
    { label: '请客送礼', value: ' 请客送礼', color: '#f43f5e', bg: 'linear-gradient(135deg, #ffe4e6, #fff1f2)' },
    { label: '会员', value: ' 会员', color: '#8b5cf6', bg: 'linear-gradient(135deg, #ede9fe, #f5f3ff)' },
    { label: '其他', value: 'custom', color: '#94a3b8', bg: 'linear-gradient(135deg, #f1f5f9, #ffffff)', custom: true },
  ],
  income: [
    { label: '工资', value: ' 💼  工资', color: '#16a34a', bg: 'linear-gradient(135deg, #dcfce7, #f0fdf4)' },
    { label: '生活费', value: ' 🏠  生活费', color: '#14b8a6', bg: 'linear-gradient(135deg, #ccfbf1, #f0fdfa)' },
    { label: '收红包', value: ' 🧧  收红包', color: '#f43f5e', bg: 'linear-gradient(135deg, #ffe4e6, #fff1f2)' },
    { label: '外快', value: ' 🌟  外快', color: '#f59e0b', bg: 'linear-gradient(135deg, #fef3c7, #fffbeb)' },
    { label: '奖金', value: ' 🎁  奖金', color: '#8b5cf6', bg: 'linear-gradient(135deg, #ede9fe, #f5f3ff)' },
    { label: '报销', value: ' 🧾  报销', color: '#64748b', bg: 'linear-gradient(135deg, #f1f5f9, #ffffff)' },
    { label: '理财', value: ' 📈  理财', color: '#22c55e', bg: 'linear-gradient(135deg, #dcfce7, #f7fee7)' },
    { label: '其他收入', value: 'custom', color: '#94a3b8', bg: 'linear-gradient(135deg, #f1f5f9, #ffffff)', custom: true },
  ],
};

function ledgerCategoryIconSvg(label = '其他') {
  const icons = {
    '三餐': '<path d="M7 4v7"></path><path d="M4.8 4v3.2a2.2 2.2 0 0 0 4.4 0V4"></path><path d="M13 4v16"></path><path d="M16 5.5c1.2 1 2 2.8 2 4.8 0 2.3-1 4.1-2.5 4.7"></path>',
    '购物': '<path d="M6 8h12l-1.2 10.5a2 2 0 0 1-2 1.5H9.2a2 2 0 0 1-2-1.5L6 8Z"></path><path d="M9 8a3 3 0 0 1 6 0"></path>',
    '聚餐': '<path d="M7 5h4v6a2 2 0 0 1-4 0V5Z"></path><path d="M9 13v6"></path><path d="M6.5 19h5"></path><path d="M14 7h3.5a2.5 2.5 0 0 1 0 5H14V7Z"></path><path d="M15.8 12v5"></path>',
    '交通': '<path d="M6 6h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"></path><path d="M7 10h10"></path><path d="M8 17l-1 2"></path><path d="M16 17l1 2"></path><circle cx="8" cy="14" r="1"></circle><circle cx="16" cy="14" r="1"></circle>',
    '话费': '<path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"></path><path d="M10 18h4"></path><path d="M10 6h4"></path>',
    '医疗': '<path d="M12 5v14"></path><path d="M5 12h14"></path><path d="M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z"></path>',
    '水果': '<path d="M12 7c3-2.2 7 .4 7 5.2 0 4-2.5 7.3-5.1 7.3-.8 0-1.3-.4-1.9-.4s-1.1.4-1.9.4C7.5 19.5 5 16.2 5 12.2 5 7.4 9 4.8 12 7Z"></path><path d="M12 7c0-2 1.4-3.4 3.5-3.5"></path>',
    '水电': '<path d="M8 13c0 3 2 6 4 6s4-3 4-6c0-2.8-4-8-4-8s-4 5.2-4 8Z"></path><path d="M13 8l-2 5h3l-2 4"></path>',
    '学习': '<path d="M5 5.5h7a3 3 0 0 1 3 3V20a3 3 0 0 0-3-2.5H5V5.5Z"></path><path d="M19 5.5h-4a3 3 0 0 0-3 3"></path><path d="M8 9h3"></path><path d="M8 12h3"></path>',
    '日用品': '<path d="M8 9h8l1 11H7L8 9Z"></path><path d="M10 9V6a2 2 0 0 1 4 0v3"></path><path d="M10 13h4"></path>',
    '零食': '<path d="M7 5h10l-1 5 1 4-1 5H8l-1-5 1-4-1-5Z"></path><path d="M8 10h8"></path><path d="M9 15h6"></path>',
    '奶茶': '<path d="M8 8h9l-1 12H9L8 8Z"></path><path d="M7 8h11"></path><path d="M11 8 14 4"></path><path d="M10 13h5"></path><path d="M11 16h3"></path>',
    '请客送礼': '<path d="M4 10h16v10H4V10Z"></path><path d="M4 14h16"></path><path d="M12 10v10"></path><path d="M8 10c-2-1.8-1-4 1-4 1.4 0 2.3 1.2 3 4"></path><path d="M16 10c2-1.8 1-4-1-4-1.4 0-2.3 1.2-3 4"></path>',
    '会员': '<path d="M4 8h16l-3 10H7L4 8Z"></path><path d="M7 8l2.5-3 2.5 3 2.5-3L17 8"></path><path d="M9 14h6"></path>',
    '美妆': '<path d="M9 4h6v5H9V4Z"></path><path d="M8 9h8v11H8V9Z"></path><path d="M10 13h4"></path><path d="M10 16h4"></path>',
    '工资': '<path d="M5 7h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"></path><path d="M8 7V5h8v2"></path><path d="M12 11v4"></path><path d="M10.5 12.5h3"></path>',
    '生活费': '<path d="M4 11 12 4l8 7"></path><path d="M6.5 10.5V20h11v-9.5"></path><path d="M10 20v-5h4v5"></path>',
    '收红包': '<path d="M5 7h14v12H5V7Z"></path><path d="m5 8 7 5 7-5"></path><path d="M12 10v6"></path><path d="M10 13h4"></path>',
    '外快': '<path d="M12 3l1.4 4.4L18 9l-4.6 1.6L12 15l-1.4-4.4L6 9l4.6-1.6L12 3Z"></path><path d="M5 15l.7 2.1L8 18l-2.3.9L5 21l-.7-2.1L2 18l2.3-.9L5 15Z"></path>',
    '奖金': '<path d="M8 4h8v4a4 4 0 0 1-8 0V4Z"></path><path d="M6 5H4v2a3 3 0 0 0 3 3"></path><path d="M18 5h2v2a3 3 0 0 1-3 3"></path><path d="M12 12v4"></path><path d="M9 20h6"></path>',
    '报销': '<path d="M7 3h10v18l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2V3Z"></path><path d="M9 8h6"></path><path d="M9 12h6"></path><path d="M9 16h3"></path>',
    '理财': '<path d="M4 18h16"></path><path d="M6 15l4-4 3 3 5-7"></path><path d="M15 7h3v3"></path>',
    '其他': '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
    '其他收入': '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[label] || icons['其他']}</svg>`;
}

function normalizeLedgerCategoryLabel(category = '') {
  const cleaned = String(category)
    .replace(/[🍱🛒🍻🚌📱💊🍎⚡➕💼🏠🧧🌟🎁🧾📈]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '其他';
}

function formatLedgerDayTitle(dateStr = '') {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  if (!year || !month || !day) return escapeHtml(dateStr);
  const target = new Date(year, month - 1, day);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const suffix = sameDay(target, today) ? ' 今天' : sameDay(target, yesterday) ? ' 昨天' : '';
  return `${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}${suffix}`;
}

function renderLedgerCategories(type = 'expense') {
  const grid = document.getElementById('ledgerCategoryGrid');
  const customInput = document.getElementById('customCatInput');
  if (!grid || !customInput) return;

  const options = LEDGER_CATEGORY_OPTIONS[type] || LEDGER_CATEGORY_OPTIONS.expense;
  grid.innerHTML = options.map((item, index) => {
    const id = item.custom ? 'cat_custom' : `cat_${type}_${index + 1}`;
    const checked = index === 0 ? 'checked' : '';
    const labelClass = item.custom
      ? 'category-label ledger-category-label flex flex-col items-center justify-center border-2 border-dashed border-gray-300 bg-white rounded-xl cursor-pointer'
      : 'category-label ledger-category-label flex flex-col items-center justify-center border-2 border-transparent bg-gray-50 rounded-xl cursor-pointer';
    return `
      <input type="radio" name="category" id="${id}" value="${item.value}" ${checked} class="hidden">
      <label for="${id}" class="${labelClass}">
        <span class="category-icon-wrap" style="--cat-color: ${item.color}; --cat-bg: ${item.bg};">${ledgerCategoryIconSvg(item.label)}</span>
        <span class="ledger-category-text">${item.label}</span>
      </label>`;
  }).join('');

  customInput.value = '';
  customInput.placeholder = type === 'income' ? '输入收入来源' : '输入分类名称';
  customInput.classList.add('hidden');
}

function syncLedgerTypeVisual(type = document.querySelector('input[name="type"]:checked')?.value || 'expense') {
  const box = document.getElementById('ledgerAmountBox');
  if (!box) return;
  box.classList.toggle('is-income', type === 'income');
}

function createLedgerLocalId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `temp_${window.crypto.randomUUID()}`;
  }
  return `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function isDemoMode() {
  return Boolean(window.LeafVaultSession?.isDemoMode?.());
}

document.querySelectorAll('input[name="type"]').forEach(input => {
  input.addEventListener('change', () => {
    renderLedgerCategories(input.value);
    syncLedgerTypeVisual(input.value);
  });
});

document.getElementById('ledgerCategoryGrid').addEventListener('change', (e) => {
  if (e.target.name !== 'category') return;
  document.getElementById('customCatInput').classList.toggle('hidden', e.target.value !== 'custom');
});

renderLedgerCategories('expense');
syncLedgerTypeVisual('expense');
setupLedgerMonthPicker();

async function deleteLedger(id) {
  if (typeof window.deleteLedgerSafeImpl === 'function') return window.deleteLedgerSafeImpl(id);
  if (!confirm('确定要删除这笔流水吗？')) return;
  if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('删除账本'))) return;
  try {
    // 先删本地 IndexedDB
    try {
      await LocalStorage.delete('ledgers', String(id));
    } catch (dbErr) {
      console.warn('本地删除失败，继续尝试服务端删除', dbErr);
    }
 
    // 只有真实 id（非临时记录）才请求服务端删除
    if (!String(id).startsWith('temp_')) {
      const res = await apiFetch(`/api/ledgers/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.status !== 'success') {
        showToast('⚠️ 服务端删除失败，本地已清除', true);
        fetchLedgers();
        return;
      }
    }
 
    showToast('✅ 已删除');
    fetchLedgers();
  } catch (e) {
    showToast('❌ 删除失败，请检查网络', true);
    fetchLedgers(); // 强制刷新，保持 UI 与实际状态一致
  }
}

function renderLedgerList(data) {
    const list = document.getElementById('ledgerList');
    const sortedData = [...(data || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const visibleData = filterLedgersByMonth(sortedData);
    renderLedgerMonthSummary(sortedData, visibleData);

    if (!visibleData.length) {
        if (window.LeafVaultUIState?.renderEmptyState) {
            window.LeafVaultUIState.renderEmptyState(list, {
                title: `${formatLedgerMonthHeading(selectedLedgerMonth)}还没有记录`,
                description: '这个月还没有流水，记一笔开始记录吧。',
                compact: true,
            });
        } else {
            list.innerHTML = '<p class="text-center text-gray-400 text-sm py-4">这个月还没有流水，记一笔开始记录吧。</p>';
        }
        return;
    }

    const groups = visibleData.reduce((acc, item) => {
        const key = item.created_at || '未记录日期';
        if (!acc[key]) acc[key] = [];
        acc[key].push(item);
        return acc;
    }, {});

    list.innerHTML = Object.entries(groups).map(([date, items]) => {
        const incomeTotal = items
            .filter(item => item.type === 'income')
            .reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const expenseTotal = items
            .filter(item => item.type !== 'income')
            .reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const summaryParts = [
            expenseTotal > 0 ? `<span class="text-red-500">支:¥${expenseTotal.toFixed(2)}</span>` : '',
            incomeTotal > 0 ? `<span class="text-green-600">收:¥${incomeTotal.toFixed(2)}</span>` : '',
        ].filter(Boolean).join('');

        const rows = items.map(l => {
            const categoryLabel = normalizeLedgerCategoryLabel(l.category);
            const categoryMeta = [...LEDGER_CATEGORY_OPTIONS.expense, ...LEDGER_CATEGORY_OPTIONS.income]
                .find(item => item.label === categoryLabel) || LEDGER_CATEGORY_OPTIONS.expense[LEDGER_CATEGORY_OPTIONS.expense.length - 1];
            const isIncome = l.type === 'income';
            const amount = Number(l.amount || 0).toFixed(2);
            const noteHtml = l.note ? `<div class="ledger-flow-note">${escapeHtml(l.note)}</div>` : '';
            const ledgerId = escapeHtml(String(l.local_id || l.id || l.uuid || ''));
            const deleteBtn = ledgerId
                ? `<button type="button" class="ledger-delete-btn" data-ledger-action="delete" data-ledger-id="${ledgerId}" aria-label="删除这笔流水">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>
                   </button>`
                : '';
            return `
                <div class="ledger-flow-row">
                    <div class="flex items-center gap-3 min-w-0">
                        <span class="ledger-flow-dot" style="--flow-dot: ${isIncome ? '#22c55e' : '#fb7185'}; --flow-dot-bg: ${isIncome ? 'rgba(34,197,94,.12)' : 'rgba(251,113,133,.14)'};"></span>
                        <span class="ledger-list-icon" style="--cat-color: ${categoryMeta.color}; --cat-bg: ${categoryMeta.bg};">${ledgerCategoryIconSvg(categoryLabel)}</span>
                        <div class="min-w-0">
                            <div class="ledger-flow-title inline-flex items-center">${escapeHtml(categoryLabel)}${getSyncBadgeHtml(l.sync_status, 'mini')}</div>
                            ${noteHtml}
                        </div>
                    </div>
                    <div class="ledger-flow-actions">
                        <span class="ledger-flow-amount ${isIncome ? 'text-green-600' : 'text-red-500'}">${isIncome ? '+' : '-'} ${amount}</span>
                        ${deleteBtn}
                    </div>
                </div>`;
        }).join('');

        return `
            <div class="glass-card ledger-day-card px-4 py-3 transition-all hover:bg-white hover:shadow-md">
                <div class="ledger-day-header">
                    <div class="ledger-day-date">${formatLedgerDayTitle(date)}</div>
                    <div class="ledger-day-summary">${summaryParts || '<span class="text-gray-400">暂无合计</span>'}</div>
                </div>
                <div>${rows}</div>
            </div>`;
    }).join('');
}

function setupLedgerListBindings() {
    const list = document.getElementById('ledgerList');
    if (!list || list.dataset.ledgerListBound === '1') return;
    list.dataset.ledgerListBound = '1';
    list.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-ledger-action="delete"]');
        if (!btn || !list.contains(btn)) return;
        event.stopPropagation();
        deleteLedger(btn.dataset.ledgerId);
    });
}

setupLedgerListBindings();

async function fetchLedgers() {
    const list = document.getElementById('ledgerList');
    try {
        if (!list.innerHTML.trim()) {
            if (window.LeafVaultUIState?.renderLoadingState) {
                window.LeafVaultUIState.renderLoadingState(list, {
                    title: '正在加载账本...',
                    description: '正在整理最近的收入和支出。',
                    compact: true,
                    skeleton: true,
                });
            } else {
                list.innerHTML = '<p class="text-center text-gray-400 text-sm py-4">⏳ 数据加载中...</p>';
            }
        }
        
        let localData = [];
        try {
            const rawLocalData = await LocalStorage.getAll('ledgers');
            localData = (rawLocalData || []).filter(d => d.is_deleted !== 1);
        } catch (dbErr) { console.warn('跳过本地缓存'); }
        
        if (localData.length > 0 || !navigator.onLine) {
            localData.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            window.allLedgersData = localData;
            renderLedgerList(localData);
            
            // 【核心修复】：调用你源码里真正用来渲染图表的函数
            if (typeof initRealCharts === 'function') setTimeout(initRealCharts, 100);
        }

        if (isDemoMode()) {
            if (!localData.length) {
                window.allLedgersData = [];
                renderLedgerList([]);
                if (typeof initRealCharts === 'function') setTimeout(initRealCharts, 100);
            }
            return;
        }

        if (!navigator.onLine) return;
        
        const res = await apiFetch('/api/ledgers/list');
        const json = await res.json();
        
        if (json.status === 'success' && json.data) {
            const serverData = json.data;
            const pendingLocal = localData.filter(d => d.sync_status === 1);
            const mergedData = [...pendingLocal];
            
            for (const s of serverData) {
                s.local_id = s.id.toString();
                mergedData.push(s);
            }
            mergedData.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            
            window.allLedgersData = mergedData;
            renderLedgerList(mergedData);
            
            // 【核心修复】：合并完云端数据后，再次刷新图表
            if (typeof initRealCharts === 'function') setTimeout(initRealCharts, 100);

            setTimeout(async () => {
                for (const item of serverData) {
                    try {
                        const localKey = item.id.toString();
                        const existingLocal = await LocalStorage.get('ledgers', localKey);
                        if (!existingLocal || existingLocal.sync_status !== 1) {
                            await LocalStorage.set('ledgers', { ...item, local_id: localKey, sync_status: 0 });
                        }
                    } catch(err) {}
                }
            }, 500);
        } else if (localData.length === 0) {
            if (window.LeafVaultUIState?.renderEmptyState) {
                window.LeafVaultUIState.renderEmptyState(list, {
                    title: '还没有账本记录',
                    description: '试着添加一笔收入或支出。',
                    compact: true,
                });
            } else {
                list.innerHTML = '<p class="text-center text-gray-400 text-sm py-4">还没有流水记录</p>';
            }
            window.allLedgersData = [];
            if (typeof initRealCharts === 'function') setTimeout(initRealCharts, 100);
        }
    } catch(e) {
        if (window.LeafVaultUIState?.renderErrorState) {
            window.LeafVaultUIState.renderErrorState(list, {
                title: '账本加载失败',
                description: window.LeafVaultUIState.normalizeUserFacingError?.(e) || '网络连接异常，请检查网络后重试。',
                retryText: '重新加载',
                onRetry: fetchLedgers,
                compact: true,
            });
        } else {
            list.innerHTML = '<p class="text-center text-red-400 text-sm py-4">❌ 记录加载失败</p>';
        }
    }
}

// ====================================================

// 数据导出模块：使用 SheetJS 生成真正的 .xlsx，避免手机端 WPS/Excel 误判 CSV 编码。
// ====================================================
function closeLedgerExportMenu() {
    const menu = document.getElementById('ledgerExportMenu');
    const trigger = document.getElementById('ledgerExportBtn');
    if (!menu || !trigger) return;
    menu.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
}

function openLedgerExportMenu() {
    const menu = document.getElementById('ledgerExportMenu');
    const trigger = document.getElementById('ledgerExportBtn');
    if (!menu || !trigger) return;
    menu.classList.toggle('hidden');
    trigger.setAttribute('aria-expanded', menu.classList.contains('hidden') ? 'false' : 'true');
}

function getLedgerExportIdentity(ledger) {
    return String(ledger?.uuid || ledger?.local_id || ledger?.id || `${ledger?.created_at || ''}_${ledger?.amount || ''}_${ledger?.category || ''}_${ledger?.note || ''}`);
}

async function loadLedgerExportData() {
    const localData = (window.allLedgersData || []).filter(item => item?.is_deleted !== 1);
    if (isDemoMode() || !navigator.onLine) return localData;

    try {
        const res = await apiFetch('/api/ledgers/list');
        const json = await res.json();
        if (!json.data) return localData;

        const merged = json.data.map(item => ({ ...item, local_id: item.local_id || String(item.id || item.uuid || '') }));
        const known = new Set(merged.map(getLedgerExportIdentity));
        localData
            .filter(item => Number(item.sync_status || 0) === 1)
            .forEach(item => {
                const identity = getLedgerExportIdentity(item);
                if (!known.has(identity)) {
                    merged.push(item);
                    known.add(identity);
                }
            });
        return merged;
    } catch (error) {
        console.warn('导出时读取服务端账本失败，改用本地缓存:', error);
        return localData;
    }
}

function buildLedgerExportRows(data) {
    return data.map(row => ([
        row.created_at || '',
        row.type === 'income' ? '收入' : '支出',
        row.category || '',
        Number(row.amount || 0),
        row.note || ''
    ]));
}

async function exportLedgerCSV(scope = null) {
    if (scope !== 'month' && scope !== 'year') {
        openLedgerExportMenu();
        return;
    }

    try {
        closeLedgerExportMenu();
        if (typeof XLSX === 'undefined') {
            return showToast('导出组件还没有加载完成，请刷新后重试', true);
        }

        const allData = await loadLedgerExportData();
        const month = normalizeLedgerMonthValue(selectedLedgerMonth);
        const year = month.slice(0, 4);
        const exportData = scope === 'year'
            ? filterLedgersByYear(allData, year)
            : filterLedgersByMonth(allData, month);

        if (!exportData.length) {
            return showToast(scope === 'year' ? '这一年还没有流水可导出' : '这个月还没有流水可导出', true);
        }

        const rows = buildLedgerExportRows(
            [...exportData].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        );
        const worksheet = XLSX.utils.aoa_to_sheet([
            ['记录时间', '收支类型', '消费分类', '金额(元)', '备注信息'],
            ...rows
        ]);
        worksheet['!cols'] = [
            { wch: 22 },
            { wch: 10 },
            { wch: 14 },
            { wch: 12 },
            { wch: 28 }
        ];

        const workbook = XLSX.utils.book_new();
        workbook.Props = {
            Title: 'LeafVault 账单导出',
            Subject: 'Ledger Export',
            Author: 'LeafVault',
            CreatedDate: new Date()
        };
        XLSX.utils.book_append_sheet(workbook, worksheet, '账单');
        const filename = scope === 'year'
            ? `leafvault-ledger-${year}.xlsx`
            : `leafvault-ledger-${month}.xlsx`;
        XLSX.writeFile(workbook, filename, { compression: true });

        showToast(' ✅  账单已成功导出为 Excel 文件');
    } catch (e) {
        console.warn('账单导出失败:', e);
        showToast('导出失败，请检查网络或浏览器下载权限', true);
    }
}

function setupLedgerExportMenu() {
    const wrap = document.getElementById('ledgerExportWrap');
    const menu = document.getElementById('ledgerExportMenu');
    if (!wrap || !menu || wrap.dataset.exportMenuBound === '1') return;
    wrap.dataset.exportMenuBound = '1';

    menu.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-ledger-export-scope]');
        if (!btn || !menu.contains(btn)) return;
        event.stopPropagation();
        exportLedgerCSV(btn.dataset.ledgerExportScope);
    });

    document.addEventListener('click', (event) => {
        if (!wrap.contains(event.target)) closeLedgerExportMenu();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeLedgerExportMenu();
    });
}
setupLedgerExportMenu();
// ====================================================

// 流水账本：提交保存
// 先写 IndexedDB 保底，再后台静默同步到服务器，避免网络波动阻塞表单。
// =====================================================================
document.getElementById('ledgerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('保存账本'))) return;
  const btn      = document.getElementById('mainLedgerSubmitBtn');
  const origHtml = btn.innerHTML;
  if (window.LeafVaultUIState?.setButtonLoading) {
    window.LeafVaultUIState.setButtonLoading(btn, true, { text: '记录中...' });
  } else {
    btn.disabled   = true;
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v4"></path><path d="M12 15v4"></path><path d="M5 12h4"></path><path d="M15 12h4"></path></svg><span>记录中...</span>';
  }

  try {
    const typeEl    = document.querySelector('input[name="type"]:checked');
    const finalType = typeEl ? typeEl.value : 'expense';

    const defaultCustomCategory = finalType === 'income' ? '其他收入' : '其他';
    let finalCategory = defaultCustomCategory;
    const catEl = document.querySelector('input[name="category"]:checked');
    if (catEl) {
      finalCategory = catEl.value === 'custom'
        ? (document.getElementById('customCatInput').value.trim() || defaultCustomCategory)
        : catEl.value;
    }

    const rawAmount = parseFloat(document.getElementById('ledgerAmount').value);
    if (isNaN(rawAmount) || rawAmount <= 0) {
      showToast('❌ 请输入有效的金额', true);
      return;
    }
    const finalAmount = parseFloat(rawAmount.toFixed(2));

    const noteEl   = document.querySelector('input[name="note"]');
    const finalNote = noteEl ? noteEl.value.trim() : '';

    let finalDate = document.getElementById('ledgerDate').value;
    if (!finalDate) finalDate = new Date().toISOString().split('T')[0];

    const localId = createLedgerLocalId();

    // ── Step 1: 先存本地，数据绝不丢失 ───────────────────
    const localObj = {
      local_id: localId, uuid: localId, type: finalType, amount: finalAmount,
      category: finalCategory, note: finalNote,
      created_at: finalDate, sync_status: isDemoMode() ? 0 : 1, is_deleted: 0,
      local_revision: 1,
      deleted_at: '',
      device_id: window.LeafVaultIncrementalSync?.getDeviceId?.() || '',
    };
    await LocalStorage.set('ledgers', localObj);
    window.markLocalDataChanged?.('ledger_saved');
    // 仅记录账本增量同步元数据，不写入金额、分类、备注等明细。
    if (!isDemoMode()) await window.LeafVaultIncrementalSync?.createLocalChange?.({
      entity_type: 'ledger',
      entity_id: localObj.uuid || localId,
      operation: 'create',
      base_revision: 0,
      local_revision: 1,
    }).catch((error) => console.warn('本地账本变更日志记录失败', error));
    const entryMonth = getLedgerMonthKey(localObj);
    if (entryMonth && entryMonth !== selectedLedgerMonth) {
      setSelectedLedgerMonth(entryMonth, { refresh: false });
      showToast(`✅ 已记录到 ${entryMonth}，已切换到该月份查看`);
    } else {
      showToast('✅ 记账成功');
    }

    // ── Step 2: 重置表单 ──────────────────────────────────
    e.target.reset();
    const todayValue = formatDateValue(new Date());
    document.getElementById('ledgerDate').value = todayValue;
    syncLedgerDateButton(todayValue);
    document.getElementById('customCatInput').classList.add('hidden');
    renderLedgerCategories('expense');
    syncLedgerTypeVisual('expense');

    // ── Step 3: 立刻刷新列表（不等网络）──────────────────
    fetchLedgers();

    // ── Step 4: 在后台静默同步到服务器（完全不阻塞） ─────
    // 注意：不加 await，让它在后台跑
    if (!isDemoMode()) _syncOneLedgerRobust(localId, finalType, finalAmount, finalCategory, finalNote, finalDate);

  } catch (err) {
    console.error('记账异常:', err);
    const friendly = window.LeafVaultUIState?.normalizeUserFacingError?.(err) || '本地保存失败，请重试';
    showToast(friendly, true);
  } finally {
    // finally 保证按钮一定恢复
    if (window.LeafVaultUIState?.setButtonLoading) {
      window.LeafVaultUIState.setButtonLoading(btn, false);
    } else {
      btn.disabled    = false;
      btn.innerHTML = origHtml;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// 单条账本静默同步（后台运行，绝不阻塞 UI）
// ─────────────────────────────────────────────────────────────────────
async function _syncOneLedger(localId, type, amount, category, note, date) {
  if (isDemoMode()) return;
  if (!navigator.onLine) return;
  try {
    const fd = new FormData();
    fd.append('type',     type);
    fd.append('amount',   String(amount));
    fd.append('category', category);
    fd.append('note',     note || '');
    fd.append('date',     date);
    fd.append('uuid',     localId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res  = await apiFetch('/api/ledgers/', { method: 'POST', body: fd, signal: controller.signal });
    clearTimeout(timer);
    const json = await res.json();

    if (json.status === 'success') {
      // 服务端已入库，删除本地临时记录
      await LocalStorage.delete('ledgers', localId).catch(() => {});
      console.log('✅ 账单已同步到服务器');
      // 【修复月汇总不更新】：同步成功后刷新统计
      fetchLedgers();
      if (typeof initRealCharts === 'function') setTimeout(initRealCharts, 200);
    }
  } catch (e) {
    // 网络失败 → 本地有记录，等网络恢复后 _syncPendingLedgers 会重试
    console.warn('账单后台同步失败，已保留本地，联网后自动重试');
  }
}

// ─────────────────────────────────────────────────────────────────────
// 批量同步所有待同步账单（网络恢复时调用）
// ─────────────────────────────────────────────────────────────────────
let _ledgerSyncing = false;
let _ledgerSyncFailureNoticeKey = '';
async function _syncPendingLedgers() {
  if (isDemoMode()) return;
  if (!navigator.onLine || _ledgerSyncing) return;
  _ledgerSyncing = true;
  try {
    const all     = await LocalStorage.getAll('ledgers').catch(() => []);
    const pending = (all || []).filter(l => l.sync_status === 1 && !l.is_deleted);
    if (!pending.length) return;

    for (const l of pending) {
      if (!navigator.onLine) break;
      try {
        const fd = new FormData();
        fd.append('type',     l.type);
        fd.append('amount',   String(parseFloat(l.amount)));
        fd.append('category', l.category);
        fd.append('note',     l.note || '');
        fd.append('date',     l.created_at);
        fd.append('uuid',     l.local_id);

        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res   = await apiFetch('/api/ledgers/', { method: 'POST', body: fd, signal: ctrl.signal });
        clearTimeout(timer);
        const json  = await res.json();

        if (json.status === 'success') {
          await LocalStorage.delete('ledgers', l.local_id).catch(() => {});
        }
      } catch (_) { /* 单条失败，保留待下次 */ }
    }
    fetchLedgers();
    if (typeof initRealCharts === 'function') initRealCharts();
  } finally {
    _ledgerSyncing = false;
  }
}
function normalizePendingLedgerForUpload(ledger = {}) {
  const localId = String(ledger.local_id || ledger.uuid || ledger.id || '').trim();
  const uuid = String(ledger.uuid || localId).trim();
  const type = ledger.type === 'income' ? 'income' : 'expense';
  const amount = Number(ledger.amount);
  const category = String(ledger.category || '').trim() || (type === 'income' ? '其他收入' : '其他');
  const createdAt = String(ledger.created_at || ledger.date || '').slice(0, 10);
  if (!localId) throw new Error('待同步账本缺少本地编号');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('待同步账本金额无效');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) throw new Error('待同步账本日期无效');
  return {
    local_id: localId,
    uuid,
    type,
    amount: Number(amount.toFixed(2)),
    category: category.slice(0, 50),
    note: String(ledger.note || ''),
    created_at: createdAt,
  };
}

async function findServerLedgerByUuid(uuid) {
  const target = String(uuid || '').trim();
  if (!target || typeof apiFetch !== 'function') return null;
  for (let page = 1; page <= 10; page += 1) {
    const res = await apiFetch(`/api/ledgers/list?page=${page}&page_size=200`);
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.status !== 'success') return null;
    const rows = Array.isArray(json.data) ? json.data : [];
    const match = rows.find(row => String(row.uuid || '') === target);
    if (match) return match;
    if (rows.length < 200) break;
  }
  return null;
}

async function fetchServerLedgerMapByUuid(uuids) {
  const targets = new Set((uuids || []).map(uuid => String(uuid || '').trim()).filter(Boolean));
  const result = new Map();
  if (!targets.size || typeof apiFetch !== 'function') return result;
  for (let page = 1; page <= 10; page += 1) {
    const res = await apiFetch(`/api/ledgers/list?page=${page}&page_size=200`);
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.status !== 'success') break;
    const rows = Array.isArray(json.data) ? json.data : [];
    for (const row of rows) {
      const uuid = String(row.uuid || '').trim();
      if (targets.has(uuid)) result.set(uuid, row);
    }
    if (result.size >= targets.size || rows.length < 200) break;
  }
  return result;
}

async function syncLedgerRecordToServer(ledger, options = {}) {
  const normalized = normalizePendingLedgerForUpload(ledger);
  console.info('[LeafVault:LedgerSync] 准备上传账本', {
    source: options.source || 'pending',
    local_id: normalized.local_id,
    uuid: normalized.uuid,
    amount: normalized.amount,
    created_at: normalized.created_at,
  });

  const fd = new FormData();
  fd.append('type', normalized.type);
  fd.append('amount', String(normalized.amount));
  fd.append('category', normalized.category);
  fd.append('note', normalized.note);
  fd.append('date', normalized.created_at);
  fd.append('uuid', normalized.uuid);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let res;
  let json;
  try {
    res = await apiFetch('/api/ledgers/', { method: 'POST', body: fd, signal: controller.signal });
    json = await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }

  console.info('[LeafVault:LedgerSync] 服务端返回', {
    local_id: normalized.local_id,
    uuid: normalized.uuid,
    status: json?.status || res.status,
    message: json?.message || json?.detail || '',
  });

  if (!res.ok || json?.status !== 'success') {
    throw new Error(json?.message || json?.detail || `账本上传失败（${res.status}）`);
  }

  const serverLedger = await findServerLedgerByUuid(normalized.uuid);
  if (!serverLedger) throw new Error('账本上传后未能在服务器列表中确认，请稍后重试');

  console.info('[LeafVault:LedgerSync] 服务器回读确认成功', {
    local_id: normalized.local_id,
    uuid: normalized.uuid,
    server_id: serverLedger.id || '',
    created_at: serverLedger.created_at || normalized.created_at,
  });

  const serverLocalId = String(serverLedger.id || normalized.local_id);
  await LocalStorage.set('ledgers', {
    ...serverLedger,
    local_id: serverLocalId,
    uuid: serverLedger.uuid || normalized.uuid,
    sync_status: 0,
    is_deleted: 0,
  });
  if (serverLocalId !== normalized.local_id) {
    await LocalStorage.delete('ledgers', normalized.local_id).catch(() => null);
  }
  return serverLedger;
}

async function _syncOneLedgerRobust(localId, type, amount, category, note, date) {
  if (isDemoMode()) return;
  if (!navigator.onLine) return;
  try {
    const localLedger = await LocalStorage.get('ledgers', localId).catch(() => null);
    const ledger = localLedger || { local_id: localId, uuid: localId, type, amount, category, note, created_at: date };
    await syncLedgerRecordToServer(ledger, { source: 'single' });
    fetchLedgers();
    if (typeof initRealCharts === 'function') setTimeout(initRealCharts, 200);
  } catch (error) {
    const message = error?.message || '账本后台同步失败，已保留本地待同步记录';
    console.info('[LeafVault:LedgerSync] 单条账本同步失败', { local_id: localId, error: message });
    showToast(message, true);
  }
}

async function _syncPendingLedgersRobust() {
  if (isDemoMode()) return;
  if (!navigator.onLine || _ledgerSyncing) return;
  _ledgerSyncing = true;
  let successCount = 0;
  let failedCount = 0;
  const failedLedgerIds = [];
  try {
    const all = await LocalStorage.getAll('ledgers').catch(() => []);
    const pending = (all || []).filter(l => Number(l.sync_status || 0) === 1 && !l.is_deleted);
    console.info('[LeafVault:LedgerSync] 扫描待同步账本', { count: pending.length });
    if (!pending.length) return;

    for (const ledger of pending) {
      if (!navigator.onLine) break;
      try {
        await syncLedgerRecordToServer(ledger, { source: 'pending' });
        successCount += 1;
      } catch (error) {
        failedCount += 1;
        failedLedgerIds.push(String(ledger.local_id || ledger.uuid || ledger.id || 'unknown'));
        console.info('[LeafVault:LedgerSync] 待同步账本上传失败', {
          local_id: ledger.local_id || '',
          uuid: ledger.uuid || '',
          amount: Number(ledger.amount || 0),
          created_at: ledger.created_at || '',
          error: error?.message || '账本同步失败',
        });
      }
    }
    if (successCount) showToast(`账本同步完成：已上传 ${successCount} 条`);
    if (failedCount) showToast(`有 ${failedCount} 条账本同步失败，已保留为待同步`, true);
    fetchLedgers();
    if (typeof initRealCharts === 'function') initRealCharts();
  } finally {
    _ledgerSyncing = false;
  }
}

async function _syncPendingLedgersRobustQuiet() {
  if (isDemoMode()) return;
  if (!navigator.onLine || _ledgerSyncing) return;
  _ledgerSyncing = true;
  let successCount = 0;
  let failedCount = 0;
  const failedLedgerIds = [];
  try {
    const all = await LocalStorage.getAll('ledgers').catch(() => []);
    const pending = (all || []).filter(l => Number(l.sync_status || 0) === 1 && !l.is_deleted);
    console.info('[LeafVault:LedgerSync] scan pending ledgers', { count: pending.length });
    if (!pending.length) {
      _ledgerSyncFailureNoticeKey = '';
      return;
    }

    const normalizedItems = [];
    const localByUuid = new Map();
    for (const ledger of pending) {
      try {
        const normalized = normalizePendingLedgerForUpload(ledger);
        normalizedItems.push({
          type: normalized.type,
          amount: normalized.amount,
          category: normalized.category,
          note: normalized.note,
          date: normalized.created_at,
          uuid: normalized.uuid,
        });
        localByUuid.set(normalized.uuid, normalized.local_id);
      } catch (error) {
        failedCount += 1;
        failedLedgerIds.push(String(ledger.local_id || ledger.uuid || ledger.id || 'unknown'));
        console.info('[LeafVault:LedgerSync] pending ledger normalize failed', {
          local_id: ledger.local_id || '',
          uuid: ledger.uuid || '',
          amount: Number(ledger.amount || 0),
          created_at: ledger.created_at || '',
          error: error?.message || 'ledger sync failed',
        });
      }
    }

    if (normalizedItems.length) {
      const res = await apiFetch('/api/ledgers/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalizedItems),
      });
      const json = await res.json().catch(() => null);
      console.info('[LeafVault:LedgerSync] batch upload response', {
        status: json?.status || res.status,
        saved: Number(json?.saved || 0),
        skipped: Number(json?.skipped || 0),
        errors: Array.isArray(json?.errors) ? json.errors.length : 0,
      });

      if (!res.ok || !['success', 'partial_success'].includes(String(json?.status || ''))) {
        normalizedItems.forEach(item => {
          failedCount += 1;
          failedLedgerIds.push(localByUuid.get(item.uuid) || item.uuid);
        });
        console.info('[LeafVault:LedgerSync] batch upload rejected', {
          status: res.status,
          message: json?.message || json?.detail || 'ledger batch upload failed',
        });
      } else {
        const acceptedUuids = new Set([
          ...(Array.isArray(json?.saved_uuids) ? json.saved_uuids : []),
          ...(Array.isArray(json?.skipped_uuids) ? json.skipped_uuids : []),
        ].map(uuid => String(uuid || '').trim()).filter(Boolean));
        if (!acceptedUuids.size && json?.status === 'success') {
          normalizedItems.forEach(item => acceptedUuids.add(item.uuid));
        }

        const serverMap = await fetchServerLedgerMapByUuid([...acceptedUuids]);
        for (const item of normalizedItems) {
          const localId = localByUuid.get(item.uuid) || item.uuid;
          const serverLedger = serverMap.get(item.uuid);
          if (!acceptedUuids.has(item.uuid) || !serverLedger) {
            failedCount += 1;
            failedLedgerIds.push(localId);
            continue;
          }
          const serverLocalId = String(serverLedger.id || localId);
          await LocalStorage.set('ledgers', {
            ...serverLedger,
            local_id: serverLocalId,
            uuid: serverLedger.uuid || item.uuid,
            sync_status: 0,
            is_deleted: 0,
          });
          if (serverLocalId !== localId) {
            await LocalStorage.delete('ledgers', localId).catch(() => null);
          }
          successCount += 1;
        }
      }
    }

    if (successCount) showToast(`账本同步完成：已上传 ${successCount} 条`);
    if (failedCount) {
      const failureKey = failedLedgerIds.filter(Boolean).sort().join('|') || String(failedCount);
      if (failureKey !== _ledgerSyncFailureNoticeKey) {
        _ledgerSyncFailureNoticeKey = failureKey;
        showToast(`有 ${failedCount} 条账本同步失败，已保留为待同步`, true);
      }
    } else {
      _ledgerSyncFailureNoticeKey = '';
    }

    fetchLedgers();
    if (typeof initRealCharts === 'function') initRealCharts();
  } finally {
    _ledgerSyncing = false;
  }
}

window.exportLedgerCSV = exportLedgerCSV;
window.exportLedgerExcel = exportLedgerCSV;
window._syncPendingLedgers = _syncPendingLedgersRobustQuiet;
window.setupLedgerMonthPicker = setupLedgerMonthPicker;
window.setSelectedLedgerMonth = setSelectedLedgerMonth;
window.getSelectedLedgerMonth = () => selectedLedgerMonth;
// ====================================================

window.deleteLedgerSafeImpl = async function deleteLedgerSafe(id) {
  if (!confirm('确定要删除这笔流水吗？')) return;
  if (window.ensureCryptoOrPrompt && !(await window.ensureCryptoOrPrompt('删除账本'))) return;
  const ledgerId = String(id);

  try {
    const previousLedger = await LocalStorage.get('ledgers', ledgerId).catch(() => null);
    const baseRevision = Number(previousLedger?.local_revision || 0);
    if (!isDemoMode() && !ledgerId.startsWith('temp_')) {
      const res = await apiFetch(`/api/ledgers/${ledgerId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.status !== 'success') {
        showToast(json.message || '服务端删除失败，本地记录已保留', true);
        fetchLedgers();
        return;
      }
    }

    await LocalStorage.delete('ledgers', ledgerId).catch((error) => {
      console.warn('本地账本删除失败', error);
    });
    window.markLocalDataChanged?.('ledger_deleted');
    // 删除流水只记录实体标识和版本信息，不把账本明细写入 local_changes。
    if (!isDemoMode()) await window.LeafVaultIncrementalSync?.createLocalChange?.({
      entity_type: 'ledger',
      entity_id: previousLedger?.uuid || ledgerId,
      operation: 'delete',
      base_revision: baseRevision,
      local_revision: baseRevision + 1,
    }).catch((error) => console.warn('本地账本删除变更日志记录失败', error));

    showToast('已删除');
    fetchLedgers();
  } catch (error) {
    showToast('删除失败，请检查网络', true);
    fetchLedgers();
  }
};
window.deleteLedger = window.deleteLedgerSafeImpl;
