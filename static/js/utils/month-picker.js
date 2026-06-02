// LeafVault reusable month picker.
// 统一处理“选择月份”这类 UI：统计报表和个人中心生活日历共用。

function createMonthPicker(config) {
  let visibleYear = new Date().getFullYear();

  const getInput = () => document.getElementById(config.inputId);
  const getText = () => document.getElementById(config.textId);
  const getField = () => document.getElementById(config.fieldId);
  const getPanel = () => document.getElementById(config.panelId);
  const getTrigger = () => document.getElementById(config.triggerId);
  const getTitle = () => document.getElementById(config.titleId);
  const getGrid = () => document.getElementById(config.gridId);
  const getPrev = () => document.getElementById(config.prevId);
  const getNext = () => document.getElementById(config.nextId);

  function syncButton() {
    const input = getInput();
    const text = getText();
    if (!input || !text) return;
    text.textContent = formatMonthLabel(input.value);
  }

  function render() {
    const input = getInput();
    const title = getTitle();
    const grid = getGrid();
    if (!input || !title || !grid) return;

    title.textContent = `${visibleYear} 年`;
    grid.innerHTML = '';
    for (let month = 1; month <= 12; month++) {
      const value = `${visibleYear}-${String(month).padStart(2, '0')}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'month-option';
      btn.textContent = `${month}月`;
      if (value === input.value) btn.classList.add('is-selected');
      btn.addEventListener('click', () => {
        input.value = value;
        syncButton();
        hide();
        input.dispatchEvent(new Event('change'));
      });
      grid.appendChild(btn);
    }
  }

  function show() {
    const input = getInput();
    const panel = getPanel();
    const trigger = getTrigger();
    if (!input || !panel || !trigger) return;
    visibleYear = Number((input.value || formatDateValue(new Date()).slice(0, 7)).slice(0, 4));
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
    const field = getField();
    const trigger = getTrigger();
    const prev = getPrev();
    const next = getNext();
    if (!field || !trigger || !prev || !next) return;
    if (field.dataset.monthPickerBound === '1') return;
    field.dataset.monthPickerBound = '1';

    trigger.addEventListener('click', () => {
      const panel = getPanel();
      if (panel && panel.classList.contains('hidden')) show();
      else hide();
    });

    prev.addEventListener('click', () => {
      visibleYear -= 1;
      render();
    });

    next.addEventListener('click', () => {
      visibleYear += 1;
      render();
    });

    document.addEventListener('click', (event) => {
      if (!field.contains(event.target)) hide();
    });
  }

  return { syncButton, render, show, hide, setup };
}

window.LeafVaultMonthPicker = { createMonthPicker };
window.createMonthPicker = createMonthPicker;
