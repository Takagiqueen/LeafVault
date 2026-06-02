/*
 * LeafVault 页面启动入口。
 * 这里承接原 index.html 底部的小段初始化逻辑，减少 inline script，
 * 为后续 CSP nonce/hash 或 strict 模式收紧做准备。
 */
(async function setupLeafVaultStartup() {
    const latestDraftDate = typeof window.getLatestDiaryDraftDate === 'function'
        ? window.getLatestDiaryDraftDate()
        : '';

    if (window.dateInput && typeof window.formatDateValue === 'function') {
        window.dateInput.value = latestDraftDate || window.formatDateValue(new Date());
    }

    window.setupDiaryDatePicker?.();
    window.syncDiaryDateButton?.();

    const ledgerDate = document.getElementById('ledgerDate');
    if (ledgerDate && typeof window.formatDateValue === 'function') {
        ledgerDate.value = window.formatDateValue(new Date());
    }

    window.setupLedgerDatePicker?.();
    window.syncLedgerDateButton?.();

    if (window.statsMonthPickerEl && window.currentMonth) {
        window.statsMonthPickerEl.value = window.currentMonth;
        window.setupStatsMonthPicker?.();
        window.syncStatsMonthButton?.();
    }

    const calendarMonthPicker = document.getElementById('calendarMonthPicker');
    if (calendarMonthPicker && window.currentMonth) {
        calendarMonthPicker.value = window.currentMonth;
    }

    window.setupProfileMonthPicker?.();
    window.syncProfileMonthButton?.();
    window.updateProfileGreeting?.();
    await window.LeafVaultSession?.refreshSessionStatus?.();
    window.initApp?.();
})();
