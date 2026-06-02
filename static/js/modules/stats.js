// LeafVault stats/report module.
// 负责智能报表、月度汇总、ECharts 图表和报表长图导出。

let trendRangeDays = 7;
let chartUpdateTimer = null;

const statsMonthPicker = typeof createMonthPicker === 'function' ? createMonthPicker({
  fieldId: 'statsMonthField',
  inputId: 'statsMonthPicker',
  textId: 'statsMonthText',
  triggerId: 'statsMonthTrigger',
  panelId: 'statsMonthPanel',
  titleId: 'statsYearTitle',
  gridId: 'statsMonthGrid',
  prevId: 'statsYearPrev',
  nextId: 'statsYearNext',
}) : {
  syncButton() {
    const input = document.getElementById('statsMonthPicker');
    const text = document.getElementById('statsMonthText');
    if (input && text) text.textContent = formatMonthLabel(input.value);
  },
  render() {},
  show() {
    document.getElementById('statsMonthPicker')?.showPicker?.();
  },
  hide() {},
  setup() {
    document.getElementById('statsMonthTrigger')?.addEventListener('click', () => this.show());
  },
};

function getStatsMonthPicker() {
  return document.getElementById('statsMonthPicker');
}

function getSelectedStatsMonth() {
  return getStatsMonthPicker()?.value || formatMonthValue(new Date());
}

function getChartInstance(id) {
  const el = document.getElementById(id);
  if (!el || typeof echarts === 'undefined') return null;
  return echarts.getInstanceByDom(el) || echarts.init(el);
}

function isDemoMode() {
  return Boolean(window.LeafVaultSession?.isDemoMode?.());
}

async function getDemoLedgersForMonth(month) {
  const ledgers = await LocalStorage.getAll('ledgers').catch(() => []);
  return (ledgers || []).filter(item => !item.is_deleted && String(item.created_at || '').startsWith(month));
}

async function getDemoFinanceSummary(month) {
  const ledgers = await getDemoLedgersForMonth(month);
  const income = ledgers.filter(item => item.type === 'income').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const expense = ledgers.filter(item => item.type !== 'income').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return { total_income: income, total_expense: expense, balance: income - expense };
}

async function getDemoPieData(month) {
  const ledgers = await getDemoLedgersForMonth(month);
  const groups = new Map();
  ledgers.filter(item => item.type !== 'income').forEach((item) => {
    const name = normalizeLedgerCategoryLabel?.(item.category || '') || item.category || '其他';
    groups.set(name, Number(groups.get(name) || 0) + Number(item.amount || 0));
  });
  return Array.from(groups.entries()).map(([name, value]) => ({ name, value }));
}

async function getDemoTrendData(days) {
  const ledgers = await LocalStorage.getAll('ledgers').catch(() => []);
  const dates = [];
  const amounts = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = formatDateValue(date);
    dates.push(key);
    amounts.push((ledgers || [])
      .filter(item => !item.is_deleted && item.type !== 'income' && (item.created_at || '') === key)
      .reduce((sum, item) => sum + Number(item.amount || 0), 0));
  }
  return { dates, amounts };
}

async function generateReport(event) {
  const period = getSelectedStatsMonth();
  const container = document.getElementById('reportContainer');
  const contentEl = document.getElementById('reportContent');
  const btn = event.currentTarget;
  const originalHtml = btn.innerHTML;

  btn.innerHTML = '<span class="report-fresh-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 4v3"></path><path d="M12 17v3"></path><path d="M4 12h3"></path><path d="M17 12h3"></path><path d="m6.6 6.6 2.1 2.1"></path><path d="m15.3 15.3 2.1 2.1"></path></svg></span><span>正在生成复盘...</span>';
  btn.disabled = true;

  try {
    if (isDemoMode()) {
      const summary = await getDemoFinanceSummary(period);
      document.getElementById('reportTitle').innerText = `${period.replace('-', '年')}月 Demo 本地复盘`;
      contentEl.innerHTML = `
        <div class="report-section-grid">
          <div class="report-insight-card">
            <div class="report-insight-title"><span>心情走向</span></div>
            <p>Demo 模式仅基于当前浏览器本地数据生成简要展示，不调用 AI API。</p>
          </div>
          <div class="report-insight-card">
            <div class="report-insight-title"><span>消费变化</span></div>
            <p>本期收入 ${Number(summary.total_income || 0).toFixed(2)} 元，支出 ${Number(summary.total_expense || 0).toFixed(2)} 元，结余 ${Number(summary.balance || 0).toFixed(2)} 元。</p>
          </div>
          <div class="report-insight-card">
            <div class="report-insight-title"><span>温和建议</span></div>
            <p>可以把 Demo 当作练手空间。正式账号可使用云端加密备份、多设备同步和完整 AI 复盘。</p>
          </div>
        </div>`;
      container.classList.remove('hidden');
      return;
    }
    const res = await apiFetch(`/api/report/v2?period=${period}`);
    const json = await res.json();
    if (json.status === 'success') {
      const data = json.data;
      document.getElementById('reportTitle').innerText = `${period.replace('-', '年')}月 专属复盘`;

      const sectionIcon = {
        mood: '<svg viewBox="0 0 24 24"><path d="M8.5 10h.01"></path><path d="M15.5 10h.01"></path><path d="M8.5 15c2.2 1.6 4.8 1.6 7 0"></path><circle cx="12" cy="12" r="8"></circle></svg>',
        diary: '<svg viewBox="0 0 24 24"><path d="M6.5 4.8h8a3 3 0 0 1 3 3v10.4H7.5a2 2 0 0 1-2-2V5.8a1 1 0 0 1 1-1Z"></path><path d="M9 9h5.5M9 12h4"></path></svg>',
        money: '<svg viewBox="0 0 24 24"><path d="M5 7.5h14v9H5z"></path><path d="M8 12h.01M16 12h.01"></path><path d="M12 9.5v5"></path></svg>',
        leaf: '<svg viewBox="0 0 24 24"><path d="M12 19c3.8-2.1 6.2-5.4 6.8-10.1"></path><path d="M11.8 18.8c-1.8-3.4-1.3-6.4 1.5-9.1 1.2-1.2 2.8-2.1 4.7-2.7.2 3.3-.7 5.9-2.6 7.8-1.1 1.1-2.3 1.7-3.6 2"></path></svg>',
      };
      const card = (title, body, icon) => `
        <div class="report-insight-card">
          <div class="report-insight-title">${sectionIcon[icon]}<span>${escapeHtml(title)}</span></div>
          <p>${escapeHtml(body || '暂无可分析内容。')}</p>
        </div>`;
      const tags = [...(data.top_tags || []), ...(data.top_keywords || [])]
        .slice(0, 8)
        .map(tag => `<span class="report-chip">${escapeHtml(tag)}</span>`)
        .join('');
      const moodParts = Object.entries(data.mood_distribution || {})
        .map(([mood, count]) => `${escapeHtml(mood)} ${escapeHtml(String(count))}天`)
        .join(' / ');

      contentEl.innerHTML = `
        <div class="report-section-grid">
          ${card('心情走向', `${data.mood_summary || ''}${moodParts ? ' 分布：' + moodParts + '。' : ''}`, 'mood')}
          ${card('消费变化', `${data.finance_summary || ''}${data.finance_change ? ' ' + data.finance_change : ''} ${data.spending_pace || ''}`, 'money')}
          ${card('温和建议', data.insight, 'leaf')}
        </div>
        ${tags ? `<div class="report-chip-row">${tags}</div>` : ''}
      `;
      container.classList.remove('hidden');
    }
  } catch (error) {
    showToast('复盘引擎暂时离线', true);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

async function fetchMonthlySummary() {
  try {
    const month = getSelectedStatsMonth();
    const json = isDemoMode()
      ? { status: 'success', data: await getDemoFinanceSummary(month) }
      : await (async () => {
          const res = await apiFetch(`/api/stats/monthly_summary?month=${month}`);
          return res.json();
        })();

    if (json.status === 'success') {
      const data = json.data;
      const income = Number(data.total_income || 0);
      const expense = Number(data.total_expense || 0);
      const balance = Number(data.balance || 0);
      const totalFlow = income + expense;
      const incomeShare = totalFlow > 0 ? (income / totalFlow) * 100 : 50;
      const expenseShare = totalFlow > 0 ? (expense / totalFlow) * 100 : 50;

      document.getElementById('summaryIncome').textContent = `¥ ${income.toFixed(2)}`;
      document.getElementById('summaryExpense').textContent = `¥ ${expense.toFixed(2)}`;
      const balanceEl = document.getElementById('summaryBalance');
      balanceEl.textContent = `¥ ${balance.toFixed(2)}`;
      balanceEl.className = `finance-balance-value ${balance < 0 ? 'is-negative' : ''}`;

      // 前端只做展示层推导：收支占比和状态提示不改变后端统计结果。
      const flowHint = document.getElementById('summaryFlowHint');
      const incomeHint = document.getElementById('summaryIncomeHint');
      const expenseHint = document.getElementById('summaryExpenseHint');
      const balanceLabel = document.getElementById('summaryBalanceLabel');
      const balanceHint = document.getElementById('summaryBalanceHint');
      const incomeBar = document.getElementById('summaryIncomeBar');
      const expenseBar = document.getElementById('summaryExpenseBar');
      const incomeTip = document.getElementById('summaryIncomeTip');
      const expenseTip = document.getElementById('summaryExpenseTip');
      const incomeLegend = document.getElementById('summaryIncomeLegend');
      const expenseLegend = document.getElementById('summaryExpenseLegend');

      if (flowHint) flowHint.textContent = balance >= 0 ? '现金流健康' : '本月需控支';
      if (incomeHint) incomeHint.textContent = totalFlow > 0 ? `占本月流入流出 ${incomeShare.toFixed(0)}%` : '等待收入记录';
      if (expenseHint) expenseHint.textContent = totalFlow > 0 ? `占本月流入流出 ${expenseShare.toFixed(0)}%` : '等待支出记录';
      if (balanceLabel) balanceLabel.textContent = balance >= 0 ? '本月净结余' : '本月超支';
      if (balanceHint) {
        balanceHint.textContent = balance >= 0
          ? `可支配余额约为收入的 ${income > 0 ? (balance / income * 100).toFixed(0) : 0}%`
          : '支出已经超过收入，建议复盘大额分类';
      }
      if (incomeBar) {
        incomeBar.style.width = `${Math.max(incomeShare, totalFlow > 0 ? 8 : 50)}%`;
        incomeBar.setAttribute('aria-label', `收入 ¥ ${income.toFixed(2)}，占本月流入流出 ${incomeShare.toFixed(0)}%`);
        incomeBar.title = `收入 ¥ ${income.toFixed(2)} · ${incomeShare.toFixed(0)}%`;
      }
      if (expenseBar) {
        expenseBar.style.width = `${Math.max(expenseShare, totalFlow > 0 ? 8 : 50)}%`;
        expenseBar.setAttribute('aria-label', `支出 ¥ ${expense.toFixed(2)}，占本月流入流出 ${expenseShare.toFixed(0)}%`);
        expenseBar.title = `支出 ¥ ${expense.toFixed(2)} · ${expenseShare.toFixed(0)}%`;
      }
      if (incomeTip) incomeTip.textContent = `收入 ¥ ${income.toFixed(2)} · ${incomeShare.toFixed(0)}%`;
      if (expenseTip) expenseTip.textContent = `支出 ¥ ${expense.toFixed(2)} · ${expenseShare.toFixed(0)}%`;
      if (incomeLegend) incomeLegend.innerHTML = `<i class="income-dot"></i>收入占比 ${incomeShare.toFixed(0)}%`;
      if (expenseLegend) expenseLegend.innerHTML = `<i class="expense-dot"></i>支出占比 ${expenseShare.toFixed(0)}%`;
    }
  } catch (error) {}
}

async function initPieChart() {
  try {
    const chart = getChartInstance('pieChart');
    if (!chart) return;
    const month = getSelectedStatsMonth();
    const json = isDemoMode()
      ? { status: 'success', data: await getDemoPieData(month) }
      : await (async () => {
          const res = await apiFetch(`/api/stats/pie?month=${month}`);
          return res.json();
        })();

    if (json.status === 'success') {
      const data = Array.isArray(json.data) ? json.data : [];
      const total = data.reduce((sum, item) => sum + Number(item.value || 0), 0);
      const isMobile = window.matchMedia('(max-width: 640px)').matches;
      const chartData = data.map((item) => {
        const value = Number(item.value || 0);
        const percent = total > 0 ? (value / total) * 100 : 0;
        const showDirectLabel = percent >= 2;
        return {
          ...item,
          label: { show: showDirectLabel },
          labelLine: { show: showDirectLabel },
        };
      });

      chart.setOption({
        color: ['#ff6b6b', '#fca311', '#ffd166', '#06d6a0', '#118ab2', '#2f80ed', '#7bd957', '#14b8a6', '#5ecac2', '#7c95ff', '#c084fc', '#fb5ac8'],
        tooltip: {
          trigger: 'item',
          formatter: '{b}<br/>¥ {c} · {d}%',
        },
        legend: {
          show: false,
        },
        graphic: data.length ? [{
          type: 'text',
          left: 'center',
          top: isMobile ? '50%' : '48%',
          style: {
            text: '支出比例',
            fill: '#0f172a',
            fontSize: isMobile ? 16 : 18,
            fontWeight: 800,
            textAlign: 'center',
          },
          silent: true,
        }] : [{
          type: 'text',
          left: 'center',
          top: '42%',
          style: {
            text: '本月暂无分类支出',
            fill: '#94a3b8',
            fontSize: 13,
            fontWeight: 700,
          },
        }],
        series: [{
          name: '结构占比',
          type: 'pie',
          radius: isMobile ? ['28%', '47%'] : ['36%', '62%'],
          center: isMobile ? ['50%', '54%'] : ['50%', '52%'],
          minAngle: 3,
          padAngle: data.length > 1 ? 2 : 0,
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 10, borderColor: '#fff', borderWidth: 3 },
          label: {
            show: true,
            position: 'outer',
            formatter: (params) => {
              const name = params.name || '';
              const percent = Number(params.percent || 0);
              return `${name} ${percent.toFixed(1)}%`;
            },
            color: 'inherit',
            fontSize: isMobile ? 11 : 15,
            fontWeight: 800,
            lineHeight: isMobile ? 14 : 20,
            width: isMobile ? 78 : 132,
            overflow: 'breakAll',
            distanceToLabelLine: isMobile ? 4 : 6,
          },
          labelLine: {
            show: true,
            length: isMobile ? 10 : 18,
            length2: isMobile ? 8 : 20,
            lineStyle: { width: 2 },
          },
          labelLayout: {
            hideOverlap: true,
          },
          emphasis: {
            scaleSize: 6,
            label: {
              show: true,
              formatter: '{b} {d}%',
              fontWeight: 900,
            },
          },
          data: chartData,
        }],
      }, true);
    }
  } catch (error) {}
}

async function initLineChart() {
  try {
    const chart = getChartInstance('lineChart');
    if (!chart) return;
    const json = isDemoMode()
      ? { status: 'success', data: await getDemoTrendData(trendRangeDays) }
      : await (async () => {
          const res = await apiFetch(`/api/stats/trend_7d?days=${trendRangeDays}`);
          return res.json();
        })();

    if (json.status === 'success') {
      const dates = json.data.dates || [];
      const amounts = (json.data.amounts || []).map(value => Number(value || 0));
      const total = amounts.reduce((sum, value) => sum + value, 0);
      const avg = amounts.length ? total / amounts.length : 0;
      const peak = amounts.length ? Math.max(...amounts) : 0;
      const peakIndex = amounts.indexOf(peak);
      const subtitle = document.getElementById('trendChartSubtitle');
      const title = document.getElementById('trendChartTitle');
      if (title) title.textContent = `近 ${trendRangeDays} 日消费趋势`;
      if (subtitle) {
        subtitle.textContent = peak > 0
          ? `累计 ¥ ${total.toFixed(2)} · 日均 ¥ ${avg.toFixed(2)} · 峰值 ${dates[peakIndex]?.slice(5) || '--'}`
          : `近 ${trendRangeDays} 日暂无支出波动`;
      }
      chart.setOption({
        color: ['#ec4899'],
        grid: { left: 42, right: 20, top: 42, bottom: 38 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(255,255,255,0.96)',
          borderColor: 'rgba(167,243,208,0.9)',
          borderWidth: 1,
          padding: [8, 10],
          textStyle: { color: '#334155', fontWeight: 700 },
          axisPointer: {
            type: 'line',
            lineStyle: { color: '#ec4899', width: 2, type: 'dashed' },
          },
          formatter: (params) => {
            const point = params[0];
            return `${point.axisValue}<br/>支出 ¥ ${Number(point.value || 0).toFixed(2)}`;
          },
        },
        xAxis: {
          type: 'category',
          data: dates.map(value => value.slice(5)),
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#cbd5e1' } },
          axisTick: { show: false },
          axisLabel: { color: '#64748b', fontSize: 11, fontWeight: 700 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: 'rgba(148,163,184,0.18)', type: 'dashed' } },
          axisLabel: { color: '#64748b', fontSize: 11, fontWeight: 700 },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [{
          name: '支出',
          data: amounts,
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 8,
          showSymbol: true,
          lineStyle: {
            width: 4,
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: '#fb7185' },
              { offset: 0.52, color: '#ec4899' },
              { offset: 1, color: '#be5cf6' },
            ]),
            shadowColor: 'rgba(236,72,153,0.24)',
            shadowBlur: 10,
          },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(236,72,153,0.26)' },
              { offset: 0.58, color: 'rgba(251,113,133,0.11)' },
              { offset: 1, color: 'rgba(255,255,255,0)' },
            ]),
          },
          itemStyle: {
            color: '#ffffff',
            borderColor: '#ec4899',
            borderWidth: 3,
            shadowColor: 'rgba(236,72,153,0.24)',
            shadowBlur: 8,
          },
          emphasis: {
            scale: 1.5,
            itemStyle: { borderColor: '#be185d', borderWidth: 4 },
          },
        }],
      }, true);
    }
  } catch (error) {}
}

function setTrendRange(days) {
  trendRangeDays = days === 15 ? 15 : 7;
  document.querySelectorAll('.trend-range-btn').forEach((btn) => {
    const active = Number(btn.dataset.days) === trendRangeDays;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  initLineChart();
}

function initRealCharts() {
  clearTimeout(chartUpdateTimer);
  // 等待本地数据和云端同步完成后，再向服务器请求最新统计总和。
  chartUpdateTimer = setTimeout(() => {
    fetchMonthlySummary();
    initPieChart();
    initLineChart();
  }, 500);
}

async function exportReportImage() {
  const reportDom = document.getElementById('reportContainer');
  if (!reportDom || reportDom.classList.contains('hidden')) {
    return showToast('请先生成复盘报告', true);
  }

  if (typeof html2canvas === 'undefined') {
    return showToast('Report image tool is still loading. Please try again shortly.', true);
  }

  const originalStyle = reportDom.style.cssText;
  reportDom.style.borderRadius = '0px';
  showToast(' 📸 正在生成高清长图...');

  try {
    const canvas = await html2canvas(reportDom, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#faf5ff',
    });
    reportDom.style.cssText = originalStyle;

    const imgUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `LeafVault_生活复盘_${getSelectedStatsMonth()}.png`;
    link.href = imgUrl;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (error) {
    reportDom.style.cssText = originalStyle;
    showToast('生成长图失败', true);
  }
}

getStatsMonthPicker()?.addEventListener('change', initRealCharts);

function syncStatsMonthButton() {
  statsMonthPicker.syncButton();
}

function renderStatsMonthPicker() {
  statsMonthPicker.render();
}

function showStatsMonthPicker() {
  statsMonthPicker.show();
}

function hideStatsMonthPicker() {
  statsMonthPicker.hide();
}

function setupStatsMonthPicker() {
  statsMonthPicker.setup();
}

window.LeafVaultStats = {
  generateReport,
  fetchMonthlySummary,
  initPieChart,
  initLineChart,
  setTrendRange,
  initRealCharts,
  exportReportImage,
  syncStatsMonthButton,
  renderStatsMonthPicker,
  showStatsMonthPicker,
  hideStatsMonthPicker,
  setupStatsMonthPicker,
};
window.generateReport = generateReport;
window.fetchMonthlySummary = fetchMonthlySummary;
window.initPieChart = initPieChart;
window.initLineChart = initLineChart;
window.setTrendRange = setTrendRange;
window.initRealCharts = initRealCharts;
window.exportReportImage = exportReportImage;
window.syncStatsMonthButton = syncStatsMonthButton;
window.renderStatsMonthPicker = renderStatsMonthPicker;
window.showStatsMonthPicker = showStatsMonthPicker;
window.hideStatsMonthPicker = hideStatsMonthPicker;
window.setupStatsMonthPicker = setupStatsMonthPicker;
