(function (window) {
    'use strict';

    function formatDateValue(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function parseDateValue(value) {
        const [y, m, d] = (value || formatDateValue(new Date())).split('-').map(Number);
        return new Date(y, (m || 1) - 1, d || 1);
    }

    function formatMonthValue(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        return `${y}-${m}`;
    }

    function formatMonthLabel(value) {
        const [year, month] = (value || '').split('-');
        return year && month ? `${year}年${month}月` : '';
    }

    window.LeafVaultDateUtils = {
        formatDateValue,
        parseDateValue,
        formatMonthValue,
        formatMonthLabel,
    };
    window.formatDateValue = formatDateValue;
    window.parseDateValue = parseDateValue;
    window.formatMonthValue = formatMonthValue;
    window.formatMonthLabel = formatMonthLabel;
})(window);
