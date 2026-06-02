// LeafVault reusable date picker.
// 统一处理“选择日期”日历 UI：日记日期和账本日期共用。

function createDatePicker(config) {
  let visibleMonth = null;

  const getInput = () => document.getElementById(config.inputId);
  const getText = () => document.getElementById(config.textId);
  const getField = () => document.getElementById(config.fieldId);
  const getTrigger = () => document.getElementById(config.triggerId);
  const getPanel = () => document.getElementById(config.panelId);
  const getGrid = () => document.getElementById(config.gridId);
  const getTitle = () => document.getElementById(config.titleId);
  const getPrev = () => document.getElementById(config.prevId);
  const getNext = () => document.getElementById(config.nextId);
  const getToday = () => document.getElementById(config.todayId);

  function syncButton(value = getInput()?.value) {
    const textEl = getText();
    if (!textEl || !value) return;
    textEl.textContent = value.replace(/-/g, '/');
  }

  function ensureVisibleMonth() {
    const input = getInput();
    const selectedDate = parseDateValue(input?.value);
    if (!visibleMonth) {
      visibleMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    }
    return visibleMonth;
  }

  function dispatchDateChange(input, previousValue, nextValue) {
    const detail = { previousValue, value: nextValue };
    const event = typeof CustomEvent === 'function'
      ? new CustomEvent('change', { detail })
      : new Event('change');
    if (!event.detail) input.dataset.previousValue = previousValue || '';
    input.dispatchEvent(event);
  }

  function render() {
    const input = getInput();
    const grid = getGrid();
    const title = getTitle();
    if (!input || !grid || !title) return;

    const currentMonth = ensureVisibleMonth();
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayValue = formatDateValue(new Date());
    const selectedValue = input.value;

    title.textContent = `${year} 年 ${String(month + 1).padStart(2, '0')} 月`;
    grid.innerHTML = '';

    for (let i = 0; i < firstDay; i++) {
      const blank = document.createElement('button');
      blank.type = 'button';
      blank.className = 'calendar-day';
      blank.disabled = true;
      grid.appendChild(blank);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateValue = formatDateValue(new Date(year, month, day));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'calendar-day';
      btn.textContent = String(day);
      if (dateValue === todayValue) btn.classList.add('is-today');
      if (dateValue === selectedValue) btn.classList.add('is-selected');
      btn.addEventListener('click', () => {
        const previousValue = input.value;
        input.value = dateValue;
        syncButton(dateValue);
        hide();
        dispatchDateChange(input, previousValue, dateValue);
      });
      grid.appendChild(btn);
    }
  }

  function show() {
    const input = getInput();
    const panel = getPanel();
    const trigger = getTrigger();
    if (!input || !panel || !trigger) return;
    const selectedDate = parseDateValue(input.value);
    visibleMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    render();
    panel.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
  }

  function hide() {
    const panel = getPanel();
    const trigger = getTrigger();
    if (!panel || !trigger) return;
    panel.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
  }

  function setup() {
    const input = getInput();
    const field = getField();
    const trigger = getTrigger();
    const prev = getPrev();
    const next = getNext();
    const today = getToday();
    if (!input || !field || !trigger || !prev || !next || !today) return;
    if (field.dataset.datePickerBound === '1') return;
    field.dataset.datePickerBound = '1';

    trigger.addEventListener('click', () => {
      const panel = getPanel();
      if (panel && panel.classList.contains('hidden')) show();
      else hide();
    });

    prev.addEventListener('click', () => {
      ensureVisibleMonth().setMonth(ensureVisibleMonth().getMonth() - 1);
      render();
    });

    next.addEventListener('click', () => {
      ensureVisibleMonth().setMonth(ensureVisibleMonth().getMonth() + 1);
      render();
    });

    today.addEventListener('click', () => {
      const todayValue = formatDateValue(new Date());
      const previousValue = input.value;
      input.value = todayValue;
      syncButton(todayValue);
      visibleMonth = new Date();
      visibleMonth.setDate(1);
      hide();
      dispatchDateChange(input, previousValue, todayValue);
    });

    document.addEventListener('click', (event) => {
      if (!field.contains(event.target)) hide();
    });
  }

  return { syncButton, render, show, hide, setup };
}

window.LeafVaultDatePicker = { createDatePicker };
window.createDatePicker = createDatePicker;
