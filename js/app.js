// ===================================================
// MySpendMate – Student Money Manager | app.js
// ===================================================

// ─── DATA STORE ───────────────────────────────────
const store = {
  transactions: [],
  savingsGoals: [],
  budgetCategories: [],
  incomeSources: [],
  currentPage: 'dashboard',
  txType: 'expense',
  monthOffset: 0,
};

const API_URL = '/api';
let backendConnected = false;
let backendSaveQueue = Promise.resolve();
let currentUser = null;
let sessionCheckError = '';

// ─── CHART REGISTRY (prevents grow-on-re-render bug) ──
const charts = {};
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  // Also catch any chart Chart.js may have registered on the canvas itself
  const canvas = document.getElementById(id);
  if (canvas) {
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
  }
}
function makeChart(id, config) {
  destroyChart(id);
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const chart = new Chart(canvas, config);
  charts[id] = chart;
  return chart;
}

function cacheStore() {
  if (!currentUser) return;
  localStorage.setItem(`sf_${currentUser.id}_transactions`, JSON.stringify(store.transactions));
  localStorage.setItem(`sf_${currentUser.id}_goals`, JSON.stringify(store.savingsGoals));
  localStorage.setItem(`sf_${currentUser.id}_budget_cats`, JSON.stringify(store.budgetCategories));
  localStorage.setItem(`sf_${currentUser.id}_income_sources`, JSON.stringify(store.incomeSources));
}

function restoreLocalStore() {
  const load = (key) => {
    try {
      const value = localStorage.getItem(`sf_${currentUser.id}_${key}`);
      return value ? JSON.parse(value) : [];
    } catch (error) {
      console.error(`Could not restore ${key} from browser storage:`, error);
      showToast('Some locally saved data could not be read.', 'error');
      return [];
    }
  };
  store.transactions = load('transactions');
  store.savingsGoals = load('goals');
  store.budgetCategories = load('budget_cats');
  store.incomeSources = load('income_sources');
}

function saveStore() {
  cacheStore();
  if (!backendConnected) return Promise.resolve();

  const snapshot = {
    transactions: store.transactions,
    savingsGoals: store.savingsGoals,
    budgetCategories: store.budgetCategories,
    incomeSources: store.incomeSources,
  };

  backendSaveQueue = backendSaveQueue.then(async () => {
    const response = await fetch(`${API_URL}/store`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Could not save data to the database');
    }
  }).catch(error => {
    backendConnected = false;
    console.error('Backend save failed:', error);
    showToast('Could not save to the server. Your changes remain in this browser.', 'error');
  });

  return backendSaveQueue;
}

function recordSignature(item) {
  return JSON.stringify(
    Object.keys(item)
      .filter(key => key !== 'id')
      .sort()
      .map(key => [key, item[key]])
  );
}

function mergeLocalRecords(serverRecords, localRecords) {
  const merged = new Map(serverRecords.map(item => [item.id, item]));
  const serverSignatures = new Set(serverRecords.map(recordSignature));

  localRecords.forEach(item => {
    if (merged.has(item.id)) {
      merged.set(item.id, item);
    } else if (!serverSignatures.has(recordSignature(item))) {
      merged.set(item.id, item);
    }
  });

  return [...merged.values()];
}

async function initializeStore() {
  try {
    const response = await fetch(`${API_URL}/store`);
    if (!response.ok) throw new Error(`Backend returned ${response.status}`);
    const remote = await response.json();
    const remoteHasData = [
      remote.transactions,
      remote.savingsGoals,
      remote.budgetCategories,
      remote.incomeSources,
    ].some(items => Array.isArray(items) && items.length > 0);

    backendConnected = true;
    if (remoteHasData) {
      const local = {
        transactions: store.transactions,
        savingsGoals: store.savingsGoals,
        budgetCategories: store.budgetCategories,
        incomeSources: store.incomeSources,
      };
      const localHasData = Object.values(local).some(items => items.length > 0);
      store.transactions = mergeLocalRecords(remote.transactions || [], local.transactions);
      store.savingsGoals = mergeLocalRecords(remote.savingsGoals || [], local.savingsGoals).map(goal => ({
        ...goal,
        desc: goal.desc ?? goal.description ?? '',
      }));
      store.budgetCategories = mergeLocalRecords(remote.budgetCategories || [], local.budgetCategories);
      store.incomeSources = mergeLocalRecords(remote.incomeSources || [], local.incomeSources);
      cacheStore();
      if (localHasData) await saveStore();
      return;
    }

    const localHasData = [
      store.transactions,
      store.savingsGoals,
      store.budgetCategories,
      store.incomeSources,
    ].some(items => items.length > 0);

    if (localHasData) {
      await saveStore();
      return;
    }

  } catch (error) {
    backendConnected = false;
    console.error('Backend connection failed:', error);
    showToast('Backend unavailable. Using browser storage; start the server to sync.', 'error');
  }
}

// ─── UTILITIES ─────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function budgetResetDateValue(day, now = new Date()) {
  for (let monthOffset = 0; monthOffset < 12; monthOffset++) {
    const month = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    if (day <= daysInMonth) return localDateKey(new Date(month.getFullYear(), month.getMonth(), day));
  }
  return localDateKey(now);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}
function categoryDisplayName(category, explicitName = '') {
  if (explicitName) return explicitName;
  const budgetCategory = store.budgetCategories.find(item => item.category === category);
  if (budgetCategory?.name) return budgetCategory.name;
  const key = String(category || 'other');
  const inferredName = key.startsWith('custom_')
    ? key.slice(7).replace(/_[a-z0-9]{10,}$/i, '')
    : key;
  return inferredName.replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}
function createCustomCategoryKey(name) {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'category';
  return `custom_${slug}_${uid()}`;
}
function categoryIcon(category) {
  return catEmojis[category] || store.budgetCategories.find(item => item.category === category)?.icon || '📦';
}
function fmt(n) { return '₹' + Number(n).toLocaleString('en-IN'); }
function fmtDate(d) { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }

const catEmojis = {
  food: '🍕', transport: '🚌', education: '📚', entertainment: '🎮',
  health: '💊', shopping: '🛍️', utilities: '⚡', other: '📦'
};
const catColors = {
  food: '#fb923c', transport: '#60a5fa', education: '#a78bfa', entertainment: '#f472b6',
  health: '#34d399', shopping: '#fbbf24', utilities: '#818cf8', other: '#94a3b8'
};

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

function updateProfileDisplay(user) {
  const initials = user.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  document.getElementById('profileName').value = user.name;
  document.getElementById('profileEmail').value = user.email;
  document.getElementById('profileDegree').value = user.degree || '';
  document.getElementById('profileCollege').value = user.college || '';
  document.getElementById('budgetResetDay').value = budgetResetDateValue(Number(user.budgetResetDay) || 1);
  document.getElementById('profileAvatar').textContent = initials;
  document.getElementById('sidebarAvatar').textContent = initials;
  document.getElementById('sidebarStudentName').textContent = user.name;
  document.getElementById('sidebarStudentEmail').textContent = user.email;
}

function setAuthMode(mode) {
  const registering = mode === 'signup';
  document.getElementById('authNameField').hidden = !registering;
  document.getElementById('authName').required = registering;
  document.getElementById('authPassword').autocomplete = registering ? 'new-password' : 'current-password';
  document.getElementById('authTitle').textContent = registering ? 'Create your account' : 'Welcome back';
  document.getElementById('authDescription').textContent = registering
    ? 'Create an account to start managing your finances.'
    : 'Sign in to manage your finances.';
  document.getElementById('authSubmit').textContent = registering ? 'Create account' : 'Log in';
  document.getElementById('authSwitchText').textContent = registering ? 'Already have an account?' : 'New to MySpendMate?';
  document.getElementById('authSwitch').textContent = registering ? 'Log in' : 'Create an account';
  document.getElementById('authMessage').textContent = '';
  document.getElementById('authMessage').classList.remove('error');
  document.getElementById('authPassword').type = 'password';
  document.getElementById('passwordToggle').setAttribute('aria-label', 'Show password');
  document.getElementById('passwordToggle').setAttribute('aria-pressed', 'false');
  document.getElementById('authForm').dataset.mode = mode;
}

function openAuth(mode) {
  setAuthMode(mode);
  const authScreen = document.getElementById('authScreen');
  authScreen.hidden = false;
  const message = document.getElementById('authMessage');
  if (sessionCheckError) {
    message.textContent = sessionCheckError;
    message.classList.add('error');
  }
  document.getElementById(mode === 'signup' ? 'authName' : 'authEmail').focus();
}

function setupPromoInteractions() {
  const previewViews = {
    overview: {
      balanceLabel: 'Total balance',
      balanceValue: '₹12,480',
      balanceNote: 'Know where you stand',
      statOneLabel: 'Monthly budget',
      statOneValue: '₹8,000',
      statOneProgress: 58,
      statTwoLabel: 'Savings goal',
      statTwoValue: '68% there',
      statTwoProgress: 68,
      activityTitle: 'Recent activity',
      activity: [
        { icon: '🥗', name: 'Lunch', amount: '− ₹180', income: false },
        { icon: '📚', name: 'Scholarship', amount: '+ ₹2,500', income: true }
      ]
    },
    budget: {
      balanceLabel: 'Spent this month',
      balanceValue: '₹4,640',
      balanceNote: '₹3,360 left in your sample budget',
      statOneLabel: 'Monthly limit',
      statOneValue: '₹8,000',
      statOneProgress: 58,
      statTwoLabel: 'Top category',
      statTwoValue: 'Food · 32%',
      statTwoProgress: 32,
      activityTitle: 'Sample spending',
      activity: [
        { icon: '🥗', name: 'Food & dining', amount: '− ₹1,480', income: false },
        { icon: '🚌', name: 'Transport', amount: '− ₹620', income: false }
      ]
    },
    goals: {
      balanceLabel: 'Saved toward goals',
      balanceValue: '₹6,800',
      balanceNote: 'Every little bit adds up',
      statOneLabel: 'Laptop fund',
      statOneValue: '68% there',
      statOneProgress: 68,
      statTwoLabel: 'Trip fund',
      statTwoValue: '35% there',
      statTwoProgress: 35,
      activityTitle: 'Goal progress',
      activity: [
        { icon: '💻', name: 'Laptop fund', amount: '₹6,800 / ₹10k', income: true },
        { icon: '✈️', name: 'Trip fund', amount: '₹3,500 / ₹10k', income: true }
      ]
    }
  };

  const setText = (id, value) => {
    document.getElementById(id).textContent = value;
  };

  document.querySelectorAll('[data-promo-view]').forEach(button => {
    button.addEventListener('click', () => {
      const view = previewViews[button.dataset.promoView];
      if (!view) return;

      document.querySelectorAll('[data-promo-view]').forEach(tab => {
        const selected = tab === button;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-pressed', String(selected));
      });

      setText('promoBalanceLabel', view.balanceLabel);
      setText('promoBalanceValue', view.balanceValue);
      setText('promoBalanceNote', view.balanceNote);
      setText('promoStatOneLabel', view.statOneLabel);
      setText('promoStatOneValue', view.statOneValue);
      setText('promoStatTwoLabel', view.statTwoLabel);
      setText('promoStatTwoValue', view.statTwoValue);
      setText('promoActivityTitle', view.activityTitle);

      document.getElementById('promoStatOneProgress').style.width = `${view.statOneProgress}%`;
      document.getElementById('promoStatTwoProgress').style.width = `${view.statTwoProgress}%`;
      view.activity.forEach((item, index) => {
        const number = index + 1;
        setText(`promoActivityIcon${number === 1 ? 'One' : 'Two'}`, item.icon);
        setText(`promoActivity${number === 1 ? 'One' : 'Two'}`, item.name);
        setText(`promoActivityAmount${number === 1 ? 'One' : 'Two'}`, item.amount);
        document.getElementById(`promoActivityIcon${number === 1 ? 'One' : 'Two'}`)
          .classList.toggle('income', item.income);
      });
    });
  });

  const revealItems = document.querySelectorAll('.promo-section-heading, .promo-feature-card, .promo-how');
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    revealItems.forEach(item => item.classList.add('promo-reveal'));
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.14 });
    revealItems.forEach(item => observer.observe(item));
  }
}

async function activateAccount(user) {
  currentUser = user;
  document.getElementById('authScreen').hidden = true;
  document.body.classList.add('authenticated');
  restoreLocalStore();
  updateProfileDisplay(user);
  await initializeStore();
  updateMonthDisplay();
  navigateTo('dashboard');
}

async function logout() {
  try {
    const response = await fetch(`${API_URL}/auth/logout`, { method: 'POST' });
    if (!response.ok) throw new Error(`Logout failed with status ${response.status}`);
    currentUser = null;
    backendConnected = false;
    store.transactions = [];
    store.savingsGoals = [];
    store.budgetCategories = [];
    store.incomeSources = [];
    document.body.classList.remove('authenticated');
    document.getElementById('authScreen').hidden = true;
    document.getElementById('authForm').reset();
    setAuthMode('login');
  } catch (error) {
    console.error('Logout failed:', error);
    showToast('Could not log out. Please try again.', 'error');
  }
}

async function saveProfile() {
  const budgetResetDate = document.getElementById('budgetResetDay').value;
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(budgetResetDate);
  const budgetResetDay = dateParts ? Number(dateParts[3]) : 0;
  const profile = {
    name: document.getElementById('profileName').value.trim(),
    degree: document.getElementById('profileDegree').value.trim(),
    college: document.getElementById('profileCollege').value.trim(),
    budgetResetDay,
  };
  if (!profile.name) return showToast('Please enter your name.', 'error');
  if (!Number.isInteger(budgetResetDay) || budgetResetDay < 1 || budgetResetDay > 31) {
    return showToast('Choose a valid budget reset date.', 'error');
  }

  try {
    const response = await fetch(`${API_URL}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save your profile');
    currentUser = result.user;
    updateProfileDisplay(currentUser);
    renderBudget();
    showToast('Profile saved successfully!', 'success');
  } catch (error) {
    console.error('Profile save failed:', error);
    showToast(error.message || 'Could not save your profile.', 'error');
  }
}

// ─── NAVIGATION ────────────────────────────────────
function navigateTo(page) {
  store.currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const el = document.getElementById(`page-${page}`);
  if (el) el.classList.add('active');
  const nav = document.getElementById(`nav-${page}`);
  if (nav) nav.classList.add('active');

  const titles = {
    dashboard: ['Dashboard', `Welcome back, ${currentUser?.name || 'there'}! 👋`],
    budget: ['Budget Planner', 'Manage your monthly budget 💰'],
    expenses: ['Expenses', 'Track every rupee you spend 💳'],
    income: ['Income', 'All your money coming in 📥'],
    savings: ['Savings Goals', 'Dream it. Save for it. Achieve it 🎯'],
    reports: ['Reports & Analytics', 'Your financial story in numbers 📈'],
    profile: ['Profile & Settings', 'Customize your experience ⚙️'],
  };
  const [title, sub] = titles[page] || ['Page', ''];
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = sub;

  renderPage(page);
}

function renderPage(page) {
  switch (page) {
    case 'dashboard':  renderDashboard(); break;
    case 'budget':     renderBudget(); break;
    case 'expenses':   renderExpenses(); break;
    case 'income':     renderIncome(); break;
    case 'savings':    renderSavings(); break;
    case 'reports':    renderReports(); break;
    default: break;
  }
}

// ─── MONTH SELECTOR ────────────────────────────────
const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function getMonthlyTransactionTotals(count = 6) {
  const now = new Date();
  const firstMonth = new Date(now.getFullYear(), now.getMonth() - count + 1, 1);
  const labels = [];
  const income = Array(count).fill(0);
  const expenses = Array(count).fill(0);

  for (let index = 0; index < count; index++) {
    const month = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + index, 1);
    labels.push(month.toLocaleDateString('en-IN', { month: 'short' }));
  }

  store.transactions.forEach(item => {
    const date = new Date(`${item.date}T00:00:00`);
    const monthIndex = (date.getFullYear() - firstMonth.getFullYear()) * 12 + date.getMonth() - firstMonth.getMonth();
    if (Number.isNaN(date.getTime()) || monthIndex < 0 || monthIndex >= count) return;
    const totals = item.type === 'income' ? income : expenses;
    totals[monthIndex] += Number(item.amount);
  });

  return { labels, income, expenses };
}

function updateMonthDisplay() {
  const d = new Date();
  d.setMonth(d.getMonth() + store.monthOffset);
  document.getElementById('currentMonth').textContent = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
}

// ─── SPARKLINE CHART ────────────────────────────────
function createSparkline(id, data, color) {
  destroyChart(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
  charts[id] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{ data, borderColor: color, borderWidth: 2, fill: true,
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 50);
          g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00'); return g;
        }, pointRadius: 0, tension: 0.4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } }
    }
  });
}

// ─── DASHBOARD ─────────────────────────────────────
function renderDashboard() {
  const expenses = store.transactions.filter(item => item.type === 'expense');
  const income = store.transactions.filter(item => item.type === 'income');
  const totalSpent = expenses.reduce((sum, item) => sum + Number(item.amount), 0);
  const totalIncome = income.reduce((sum, item) => sum + Number(item.amount), 0);
  const totalSavings = store.savingsGoals.reduce((sum, goal) => sum + Number(goal.saved), 0);
  const totalBudget = store.budgetCategories.reduce((sum, category) => sum + Number(category.budget), 0);
  const remainingBudget = totalBudget - totalSpent;
  const budgetUsed = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;

  document.getElementById('balanceValue').textContent = fmt(totalIncome - totalSpent);
  document.getElementById('balanceSummary').textContent = `${fmt(totalIncome)} income · ${fmt(totalSpent)} spent`;
  document.getElementById('budgetValue').textContent = fmt(totalBudget);
  document.getElementById('budgetRemaining').textContent = `${fmt(remainingBudget)} remaining`;
  document.getElementById('spentValue').textContent = fmt(totalSpent);
  document.getElementById('spentSummary').textContent = totalBudget > 0
    ? `${budgetUsed}% of budget used`
    : 'Set a budget to track spending';
  document.getElementById('budgetProgress').style.width = `${Math.min(100, Math.max(0, budgetUsed))}%`;
  document.getElementById('savingsValue').textContent = fmt(totalSavings);
  document.getElementById('savingsSummary').textContent = `${store.savingsGoals.length} savings goals`;

  const sortedTransactions = [...store.transactions].sort((a, b) => a.date.localeCompare(b.date));
  const balanceHistory = [0];
  sortedTransactions.forEach(item => {
    const change = Number(item.amount) * (item.type === 'income' ? 1 : -1);
    balanceHistory.push(balanceHistory[balanceHistory.length - 1] + change);
  });
  createSparkline('sparkBalance', balanceHistory.slice(-7), '#a78bfa');
  createSparkline('sparkExpense', expenses.slice(-7).map(item => Number(item.amount)), '#f87171');
  createSparkline('sparkSavings', store.savingsGoals.map(goal => Number(goal.saved)), '#34d399');

  renderSpendingTrend('weekly');
  renderExpenseDonut();
  renderRecentTransactions();
}

function renderSpendingTrend(mode) {
  let labels;
  let data;
  if (mode === 'weekly') {
    labels = ['Week 1','Week 2','Week 3','Week 4'];
    data = [0, 0, 0, 0];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 27);
    store.transactions.filter(item => item.type === 'expense').forEach(item => {
      const date = new Date(`${item.date}T00:00:00`);
      const dayOffset = Math.floor((date - start) / 86400000);
      if (!Number.isNaN(date.getTime()) && dayOffset >= 0 && dayOffset < 28) {
        data[Math.min(3, Math.floor(dayOffset / 7))] += Number(item.amount);
      }
    });
  } else {
    const monthly = getMonthlyTransactionTotals();
    labels = monthly.labels;
    data = monthly.expenses;
  }

  const canvas = document.getElementById('spendingTrendChart');
  destroyChart('spendingTrendChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 200);
  grad.addColorStop(0, 'rgba(124,58,237,0.4)');
  grad.addColorStop(1, 'rgba(124,58,237,0.0)');

  charts['spendingTrendChart'] = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Spending (₹)', data,
        borderColor: '#7c3aed', borderWidth: 2.5, fill: true,
        backgroundColor: grad, pointBackgroundColor: '#7c3aed',
        pointRadius: 5, pointHoverRadius: 8, tension: 0.4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => '  ' + fmt(ctx.parsed.y) },
          backgroundColor: '#1a1e35', borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1, titleColor: '#e8eaf0', bodyColor: '#a78bfa', padding: 10 } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a8099' } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a8099', callback: v => '₹' + (v/1000).toFixed(0) + 'k' } }
      }
    }
  });
}

function renderExpenseDonut() {
  const cats = ['food','transport','education','entertainment','health','shopping','utilities','other'];
  getCustomExpenseCategories().forEach(category => cats.push(category.category));
  const labels = cats.map(category => `${categoryIcon(category)} ${categoryDisplayName(category)}`);
  const colors = cats.map(category => catColors[category] || store.budgetCategories.find(item => item.category === category)?.color || '#94a3b8');
  const expenses = store.transactions.filter(t => t.type === 'expense');
  const data = cats.map(c => expenses.filter(t => t.category === c).reduce((s, t) => s + t.amount, 0));

  makeChart('expenseDonutChart', {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors.map(c => c + 'cc'), borderColor: colors, borderWidth: 2, hoverOffset: 8 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => '  ' + fmt(ctx.parsed) },
          backgroundColor: '#1a1e35', borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1, titleColor: '#e8eaf0', bodyColor: '#e8eaf0', padding: 10 }
      }
    }
  });

  const legend = document.getElementById('donutLegend');
  if (!legend) return;
  legend.innerHTML = cats.map((c, i) =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${colors[i]}"></span>
      ${labels[i]}
    </div>`
  ).join('');
}

function renderRecentTransactions() {
  const container = document.getElementById('recentTransactions');
  if (!container) return;
  const recent = [...store.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  container.innerHTML = recent.length ? recent.map(buildTxHTML).join('') : '<p style="color:var(--text-muted);padding:1rem;">No transactions yet.</p>';
}

function buildTxHTML(tx) {
  const name = escapeHtml(categoryDisplayName(tx.category, tx.categoryName));
  return `<div class="tx-item">
    <div class="tx-cat-icon cat-${tx.category}">${categoryIcon(tx.category)}</div>
    <div class="tx-info">
      <div class="tx-desc">${tx.desc}</div>
      <div class="tx-date">${fmtDate(tx.date)} · <span class="tx-cat-badge cat-${tx.category}">${name}</span></div>
    </div>
    <div class="tx-amount ${tx.type}">${tx.type === 'expense' ? '−' : '+'}${fmt(tx.amount)}</div>
    <button class="tx-delete" onclick="deleteTransaction('${tx.id}')" title="Delete">✕</button>
  </div>`;
}

function deleteTransaction(id) {
  store.transactions = store.transactions.filter(t => t.id !== id);
  saveStore();
  renderPage(store.currentPage);
  showToast('Transaction deleted', 'info');
}

// ─── BUDGET ────────────────────────────────────────
function getBudgetPeriod(now = new Date()) {
  const resetDay = Number(currentUser?.budgetResetDay) || 1;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const currentMonthReset = new Date(
    now.getFullYear(),
    now.getMonth(),
    Math.min(resetDay, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())
  );
  const start = now >= currentMonthReset
    ? currentMonthReset
    : new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, Math.min(
      resetDay,
      new Date(monthStart.getFullYear(), monthStart.getMonth(), 0).getDate()
    ));
  const nextReset = new Date(
    start.getFullYear(),
    start.getMonth() + 1,
    Math.min(
      resetDay,
      new Date(start.getFullYear(), start.getMonth() + 2, 0).getDate()
    )
  );
  const end = new Date(nextReset);
  end.setDate(end.getDate() - 1);
  return { start, end };
}

function getCurrentMonthExpenseTotals() {
  const { start, end } = getBudgetPeriod();
  const startKey = localDateKey(start);
  const endKey = localDateKey(end);
  const byCategory = new Map();
  let total = 0;

  store.transactions.forEach(transaction => {
    if (transaction.type !== 'expense' || transaction.date < startKey || transaction.date > endKey) return;
    const amount = Number(transaction.amount) || 0;
    const category = transaction.category || 'other';
    byCategory.set(category, (byCategory.get(category) || 0) + amount);
    total += amount;
  });

  return { byCategory, total };
}

function renderBudget() {
  const { byCategory, total: spent } = getCurrentMonthExpenseTotals();
  const { start: periodStart, end: periodEnd } = getBudgetPeriod();
  const periodFormat = { day: 'numeric', month: 'short' };
  document.getElementById('budgetMonthLabel').textContent =
    `${periodStart.toLocaleDateString('en-IN', periodFormat)} – ${periodEnd.toLocaleDateString('en-IN', { ...periodFormat, year: 'numeric' })}`;

  const categoryBudgets = new Map();
  store.budgetCategories.forEach(category => {
    const key = category.category || 'other';
    const existing = categoryBudgets.get(key);
    if (existing) {
      existing.budget += Number(category.budget) || 0;
      if (category.name && !existing.names.includes(category.name)) existing.names.push(category.name);
    } else {
      categoryBudgets.set(key, {
        category: key,
        names: category.name ? [category.name] : [],
        icon: category.icon || catEmojis[key] || '📦',
        color: category.color,
        budget: Number(category.budget) || 0
      });
    }
  });
  const budgetTotal = [...categoryBudgets.values()].reduce((sum, category) => sum + category.budget, 0);
  const overBudgetCategories = [...categoryBudgets.values()]
    .map(category => ({
      name: category.names.join(' / ') || category.category,
      budget: category.budget,
      spent: byCategory.get(category.category) || 0
    }))
    .filter(category => category.spent > category.budget);
  const remaining = budgetTotal - spent;
  const pct = budgetTotal > 0 ? Math.round((spent / budgetTotal) * 100) : 0;

  document.getElementById('bStatTotal').textContent = fmt(budgetTotal);
  document.getElementById('bStatSpent').textContent = fmt(spent);
  document.getElementById('bStatRemaining').textContent = remaining < 0
    ? `${fmt(Math.abs(remaining))} over`
    : fmt(remaining);
  document.getElementById('bStatRemaining').classList.toggle('negative', remaining < 0);
  document.getElementById('bStatRemaining').classList.toggle('positive', remaining >= 0);
  document.getElementById('budgetPct').textContent = pct + '%';

  makeChart('budgetGaugeChart', {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [Math.min(pct, 100), Math.max(0, 100 - pct)],
        backgroundColor: [pct > 100 ? '#f87171' : pct > 80 ? '#fbbf24' : '#a78bfa', 'rgba(255,255,255,0.06)'],
        borderWidth: 0, hoverOffset: 0
      }]
    },
    options: { cutout: '75%', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 1000, easing: 'easeInOutQuart' } }
  });

  const grid = document.getElementById('budgetCatsGrid');
  if (!grid) return;
  grid.innerHTML = categoryBudgets.size ? [...categoryBudgets.values()].map(cat => {
    const categoryBudget = Number(cat.budget) || 0;
    const categorySpent = byCategory.get(cat.category) || 0;
    const categoryRemaining = categoryBudget - categorySpent;
    const p = categoryBudget > 0 ? Math.round((categorySpent / categoryBudget) * 100) : 0;
    const barWidth = Math.min(100, Math.max(0, p));
    const isOverBudget = categorySpent > categoryBudget;
    const safeColor = /^#[0-9a-f]{3,8}$/i.test(cat.color || '') ? cat.color : '#a78bfa';
    const barColor = isOverBudget
      ? 'linear-gradient(90deg,#dc2626,#f43f5e)'
      : p >= 80
        ? 'linear-gradient(90deg,#d97706,#f59e0b)'
        : `linear-gradient(90deg, ${safeColor}cc, ${safeColor})`;
    const categoryName = escapeHtml(cat.names.join(' / ') || cat.category);
    return `<div class="budget-cat-card">
      <div class="bcat-top">
        <div class="bcat-left">
          <span class="bcat-icon">${escapeHtml(cat.icon)}</span>
          <span class="bcat-name">${categoryName}</span>
        </div>
        <div class="bcat-actions">
          <span class="bcat-pct ${isOverBudget ? 'over-budget' : ''}">${p}%${isOverBudget ? ' · Over' : ''}</span>
          <button class="budget-category-delete" type="button" data-delete-budget-category="${escapeHtml(cat.category)}" aria-label="Delete ${categoryName} budget" title="Delete budget category">✕</button>
        </div>
      </div>
      <div class="progress-bar" role="progressbar" aria-label="${categoryName} budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${barWidth}">
        <div class="progress-fill" style="width:${barWidth}%;background:${barColor}"></div>
      </div>
      <div class="bcat-amounts"><span>Spent: ${fmt(categorySpent)}</span><span>Budget: ${fmt(categoryBudget)}</span></div>
      <div class="bcat-remaining ${isOverBudget ? 'over-budget' : ''}">${isOverBudget ? `Over budget by ${fmt(Math.abs(categoryRemaining))}` : `${fmt(categoryRemaining)} left this month`}</div>
    </div>`;
  }).join('') : '<p class="empty-state budget-empty-state">No budget categories yet. Add one to start tracking spending.</p>';

  const alert = document.getElementById('budgetAlert');
  if (overBudgetCategories.length) {
    const totalOver = overBudgetCategories.reduce((sum, category) => sum + category.spent - category.budget, 0);
    document.getElementById('budgetAlertTitle').textContent =
      `${overBudgetCategories.length} ${overBudgetCategories.length === 1 ? 'category is' : 'categories are'} over budget`;
    document.getElementById('budgetAlertMessage').textContent =
      `${overBudgetCategories.map(category => category.name).join(', ')} · ${fmt(totalOver)} over in total`;
    alert.hidden = false;
  } else {
    alert.hidden = true;
  }
}

// ─── EXPENSES ──────────────────────────────────────
function renderExpenses(filter = 'all', sort = 'date-desc', search = '') {
  const tbody = document.getElementById('expensesTableBody');
  if (!tbody) return;
  renderExpenseCategoryFilter(filter);
  let data = store.transactions.filter(t => t.type === 'expense');
  if (filter !== 'all') data = data.filter(t => t.category === filter);
  if (search) data = data.filter(t => t.desc.toLowerCase().includes(search.toLowerCase()));
  data.sort((a, b) => {
    if (sort === 'date-desc') return b.date.localeCompare(a.date);
    if (sort === 'date-asc')  return a.date.localeCompare(b.date);
    if (sort === 'amt-desc')  return b.amount - a.amount;
    if (sort === 'amt-asc')   return a.amount - b.amount;
    return 0;
  });

  tbody.innerHTML = data.length ? data.map(tx =>
    `<tr>
      <td>${fmtDate(tx.date)}</td>
      <td><strong>${tx.desc}</strong>${tx.note ? `<br><small style="color:var(--text-muted)">${tx.note}</small>` : ''}</td>
      <td><span class="tx-cat-badge cat-${tx.category}">${categoryIcon(tx.category)} ${escapeHtml(categoryDisplayName(tx.category, tx.categoryName))}</span></td>
      <td style="color:var(--red-light);font-weight:700">${fmt(tx.amount)}</td>
      <td><button class="tx-delete" onclick="deleteTransaction('${tx.id}')">✕ Delete</button></td>
    </tr>`
  ).join('') : `<tr><td colspan="5" style="color:var(--text-muted);text-align:center;padding:2rem">No expenses found.</td></tr>`;
}

function getCustomExpenseCategories() {
  const categories = new Map();
  store.budgetCategories.forEach(category => {
    if (String(category.category).startsWith('custom_')) {
      categories.set(category.category, {
        category: category.category,
        name: category.name || categoryDisplayName(category.category),
        icon: category.icon || '📦'
      });
    }
  });
  store.transactions.forEach(transaction => {
    if (String(transaction.category).startsWith('custom_') && !categories.has(transaction.category)) {
      categories.set(transaction.category, {
        category: transaction.category,
        name: transaction.categoryName || categoryDisplayName(transaction.category),
        icon: categoryIcon(transaction.category)
      });
    }
  });
  return [...categories.values()];
}

function renderExpenseCategoryFilter(selected = 'all') {
  const filter = document.getElementById('expenseCatFilter');
  if (!filter) return;
  const standard = ['food', 'transport', 'education', 'entertainment', 'health', 'shopping', 'utilities', 'other'];
  filter.innerHTML = '<option value="all">All Categories</option>' +
    standard.map(category => `<option value="${category}">${categoryIcon(category)} ${categoryDisplayName(category)}</option>`).join('') +
    getCustomExpenseCategories().map(category =>
      `<option value="${escapeHtml(category.category)}">${escapeHtml(category.icon)} ${escapeHtml(category.name)}</option>`
    ).join('');
  filter.value = [...standard, ...getCustomExpenseCategories().map(category => category.category)].includes(selected)
    ? selected
    : 'all';
}

function renderTransactionCategoryOptions(type = store.txType) {
  const select = document.getElementById('txCategory');
  if (!select) return;
  if (type === 'income') {
    select.innerHTML = '<option value="other">💰 Scholarship</option><option value="other">💼 Part-time Job</option><option value="other">🏠 Parental Support</option><option value="other">🖥️ Freelance</option><option value="other">📦 Other</option>';
    return;
  }
  const standard = ['food', 'transport', 'education', 'entertainment', 'health', 'shopping', 'utilities', 'other'];
  select.innerHTML = standard.map(category =>
    `<option value="${category}">${categoryIcon(category)} ${categoryDisplayName(category)}</option>`
  ).join('') + getCustomExpenseCategories().map(category =>
    `<option value="${escapeHtml(category.category)}">${escapeHtml(category.icon)} ${escapeHtml(category.name)}</option>`
  ).join('');
}

// ─── INCOME ────────────────────────────────────────
function renderIncome() {
  const recordedIncome = store.transactions
    .filter(item => item.type === 'income')
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const recordedExpenses = store.transactions
    .filter(item => item.type === 'expense')
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const monthlyExpected = store.incomeSources
    .filter(source => String(source.frequency || '').toLowerCase() === 'monthly')
    .reduce((sum, source) => sum + Number(source.amount), 0);
  document.getElementById('incomeTotalValue').textContent = fmt(recordedIncome);
  document.getElementById('incomeSourceCount').textContent = String(store.incomeSources.length);
  document.getElementById('monthlyIncomeValue').textContent = fmt(monthlyExpected);
  document.getElementById('incomePageExpenseValue').textContent = fmt(recordedExpenses);

  const list = document.getElementById('incomeSourcesList');
  if (!list) return;
  list.innerHTML = store.incomeSources.length ? store.incomeSources.map(s =>
    `<div class="income-source-item">
      <span class="income-source-icon">${escapeHtml(s.icon)}</span>
      <div class="income-source-info">
        <div class="income-source-name">${escapeHtml(s.name)}</div>
        <div class="income-source-freq">${escapeHtml(s.frequency)}</div>
      </div>
      <span class="income-source-amount">${s.amount > 0 ? fmt(s.amount) : '–'}</span>
    </div>`
  ).join('') : '<p class="empty-state">No income sources yet. Add one to get started.</p>';

  const monthly = getMonthlyTransactionTotals();
  makeChart('incomeExpenseChart', {
    type: 'bar',
    data: {
      labels: monthly.labels,
      datasets: [
        { label: 'Income', data: monthly.income, backgroundColor: 'rgba(52,211,153,0.7)', borderColor: '#34d399', borderWidth: 1, borderRadius: 6 },
        { label: 'Expenses', data: monthly.expenses, backgroundColor: 'rgba(248,113,113,0.7)', borderColor: '#f87171', borderWidth: 1, borderRadius: 6 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#7a8099', font: { family: 'Outfit' } } },
        tooltip: { callbacks: { label: ctx => '  ' + fmt(ctx.parsed.y) },
          backgroundColor: '#1a1e35', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
          titleColor: '#e8eaf0', bodyColor: '#e8eaf0', padding: 10 } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a8099' } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a8099', callback: v => '₹' + (v/1000).toFixed(0) + 'k' } }
      }
    }
  });
}

// ─── SAVINGS GOALS ─────────────────────────────────
function renderSavings() {
  const grid = document.getElementById('savingsGoalsGrid');
  if (!grid) return;
  const totalSaved = store.savingsGoals.reduce((sum, goal) => sum + Number(goal.saved || 0), 0);
  document.getElementById('savingsGoalsTotal').textContent = fmt(totalSaved);
  document.getElementById('savingsGoalsCount').textContent = String(store.savingsGoals.length);

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  grid.innerHTML = store.savingsGoals.map(g => {
    const target = Number(g.target) || 0;
    const saved = Number(g.saved) || 0;
    const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
    const deadline = g.deadline ? new Date(`${g.deadline}T00:00:00`) : null;
    const hasDeadline = deadline && !Number.isNaN(deadline.getTime());
    const daysLeft = hasDeadline ? Math.ceil((deadline - new Date()) / 86400000) : null;
    const goalName = escapeHtml(g.name);
    const description = escapeHtml(g.desc || g.description || '');
    const icon = escapeHtml(g.icon || '🎯');
    const color = ['purple', 'blue', 'green', 'amber'].includes(g.color) ? g.color : 'purple';
    const complete = pct >= 100;
    return `<div class="goal-card glow-${color}">
      <div class="goal-header">
        <span class="goal-icon">${icon}</span>
        <span class="goal-pct-badge">${pct}%</span>
      </div>
      <div class="goal-name">${goalName}</div>
      <div class="goal-desc">${description || 'One step closer to what matters to you.'}</div>
      <div class="goal-amounts">
        <span>Saved <strong>${fmt(saved)}</strong></span>
        <span>Target <strong>${fmt(target)}</strong></span>
      </div>
      <div class="progress-bar" style="height:10px">
        <div class="progress-fill" style="width:${pct}%;background:linear-gradient(90deg,#7c3aed,#4f46e5)"></div>
      </div>
      <div class="goal-deadline">${hasDeadline ? `📅 ${daysLeft < 0 ? 'Past due' : `${daysLeft} days left`} · Due ${fmtDate(g.deadline)}` : '🗓️ No target date'}</div>
      <div class="goal-card-actions">
        <button class="goal-add-btn" type="button" data-add-to-goal="${escapeHtml(g.id)}" ${complete ? 'disabled' : ''}>${complete ? '✓ Goal reached' : '+ Add savings'}</button>
        <button class="goal-delete-btn" type="button" data-delete-goal="${escapeHtml(g.id)}" aria-label="Delete ${goalName}" title="Delete goal">Delete</button>
      </div>
    </div>`;
  }).join('');

  if (!store.savingsGoals.length) {
    grid.innerHTML = `<div class="goals-empty-state">
      <span>🌱</span>
      <strong>Your first goal starts here</strong>
      <p>Saving for a laptop, a trip, or something just for you? Set a target and watch your progress grow.</p>
      <button class="btn-primary" type="button" id="emptyAddGoalBtn">Create your first goal</button>
    </div>`;
    document.getElementById('emptyAddGoalBtn').addEventListener('click', openGoalModal);
  }

  grid.querySelectorAll('[data-add-to-goal]').forEach(button => {
    button.addEventListener('click', () => addToGoal(button.dataset.addToGoal));
  });
  grid.querySelectorAll('[data-delete-goal]').forEach(button => {
    button.addEventListener('click', () => deleteGoal(button.dataset.deleteGoal));
  });
}

function addToGoal(id) {
  const goal = store.savingsGoals.find(item => item.id === id);
  if (!goal) return;
  const remaining = Math.max(0, Number(goal.target) - Number(goal.saved));
  if (remaining <= 0) return showToast('This goal has already been reached!', 'info');

  document.getElementById('contributionGoalId').value = goal.id;
  document.getElementById('goalContributionTitle').textContent = `Add to ${goal.name}`;
  document.getElementById('goalContributionDescription').textContent =
    `${fmt(goal.saved)} saved of ${fmt(goal.target)}. Add up to ${fmt(remaining)} more.`;
  const amountInput = document.getElementById('goalContributionAmount');
  amountInput.value = '';
  amountInput.max = String(remaining);
  document.getElementById('goalContributionModal').classList.add('open');
  amountInput.focus();
}

function openGoalModal() {
  const form = document.getElementById('goalForm');
  form.reset();
  document.getElementById('goalSaved').value = '0';
  document.getElementById('goalModal').classList.add('open');
  document.getElementById('goalName').focus();
}

function closeGoalModal(modalId) {
  document.getElementById(modalId).classList.remove('open');
}

function deleteGoal(id) {
  const goal = store.savingsGoals.find(item => item.id === id);
  if (!goal) return;
  if (!confirm(`Delete "${goal.name}" and its saved progress? This cannot be undone.`)) return;

  store.savingsGoals = store.savingsGoals.filter(item => item.id !== id);
  saveStore();
  renderSavings();
  renderDashboard();
  showToast(`"${goal.name}" deleted.`, 'success');
}

function saveGoal(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const name = String(formData.get('name') || '').trim();
  const description = String(formData.get('description') || '').trim();
  const target = Number(formData.get('target'));
  const saved = Number(formData.get('saved'));

  if (!name) return showToast('Enter a name for your goal.', 'error');
  if (!Number.isFinite(target) || target <= 0) return showToast('Enter a target amount greater than zero.', 'error');
  if (!Number.isFinite(saved) || saved < 0 || saved > target) {
    return showToast('Already saved must be zero or more, and cannot exceed the target.', 'error');
  }

  const colors = ['purple', 'blue', 'green', 'amber'];
  store.savingsGoals.push({
    id: uid(),
    name,
    icon: String(formData.get('icon') || '🎯'),
    desc: description,
    target,
    saved,
    deadline: String(formData.get('deadline') || ''),
    color: colors[store.savingsGoals.length % colors.length],
  });
  saveStore();
  closeGoalModal('goalModal');
  renderSavings();
  renderDashboard();
  showToast(`"${name}" goal created! 🎯`, 'success');
}

function saveGoalContribution(event) {
  event.preventDefault();
  const goalId = document.getElementById('contributionGoalId').value;
  const amount = Number(document.getElementById('goalContributionAmount').value);
  const goal = store.savingsGoals.find(item => item.id === goalId);
  if (!goal) return showToast('Could not find that savings goal.', 'error');
  if (!Number.isFinite(amount) || amount <= 0) return showToast('Enter an amount greater than zero.', 'error');

  const remaining = Math.max(0, Number(goal.target) - Number(goal.saved));
  if (amount > remaining) return showToast(`You can add up to ${fmt(remaining)} to this goal.`, 'error');

  goal.saved = Number(goal.saved) + amount;
  saveStore();
  closeGoalModal('goalContributionModal');
  renderSavings();
  renderDashboard();
  showToast(`${fmt(amount)} added to "${goal.name}"! 🎉`, 'success');
}

// ─── REPORTS ───────────────────────────────────────
function renderReports() {
  const yearly = getMonthlyTransactionTotals(12);
  const totalExpenses = yearly.expenses.reduce((sum, amount) => sum + amount, 0);
  const totalBudget = store.budgetCategories.reduce((sum, category) => sum + Number(category.budget), 0);

  makeChart('yearlyChart', {
    type: 'line',
    data: {
      labels: yearly.labels,
      datasets: [
        { label: 'Income', data: yearly.income, borderColor: '#34d399', fill: false, tension: 0.4, pointRadius: 4 },
        { label: 'Expenses', data: yearly.expenses, borderColor: '#f87171', fill: false, tension: 0.4, pointRadius: 4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#7a8099', font: { family: 'Outfit' } } }, tooltip: { callbacks: { label: ctx => '  ' + fmt(ctx.parsed.y) }, backgroundColor: '#1a1e35', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, titleColor: '#e8eaf0', bodyColor: '#e8eaf0', padding: 10 } },
      scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a8099' } }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a8099', callback: v => '₹' + (v/1000).toFixed(0) + 'k' } } }
    }
  });

  // Savings Progress
  makeChart('savingsProgressChart', {
    type: 'bar',
    data: {
      labels: store.savingsGoals.map(g => g.name),
      datasets: [
        { label: 'Saved', data: store.savingsGoals.map(g => g.saved), backgroundColor: 'rgba(167,139,250,0.7)', borderRadius: 6 },
        { label: 'Target', data: store.savingsGoals.map(g => g.target), backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 6 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#7a8099', font: { family: 'Outfit' } } }, tooltip: { callbacks: { label: ctx => '  ' + fmt(ctx.parsed.y) }, backgroundColor: '#1a1e35', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, titleColor: '#e8eaf0', bodyColor: '#e8eaf0', padding: 10 } },
      scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a8099' } }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a8099', callback: v => '₹' + (v/1000).toFixed(0) + 'k' } } }
    }
  });

  // Top Categories
  const cats = ['food','transport','education','entertainment','health','shopping','utilities','other'];
  getCustomExpenseCategories().forEach(category => cats.push(category.category));
  const expenses = store.transactions.filter(t => t.type === 'expense');
  const catData = cats.map(c => expenses.filter(t => t.category === c).reduce((s, t) => s + t.amount, 0));
  const catColorsForChart = cats.map(category => catColors[category] || store.budgetCategories.find(item => item.category === category)?.color || '#94a3b8');
  makeChart('topCatsChart', {
    type: 'bar',
    data: {
      labels: cats.map(category => `${categoryIcon(category)} ${categoryDisplayName(category)}`),
      datasets: [{ data: catData, backgroundColor: catColorsForChart.map(color => `${color}bb`), borderColor: catColorsForChart, borderWidth: 1, borderRadius: 6 }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => `  ${fmt(ctx.parsed.x)}` },
          backgroundColor: '#1a1e35',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#e8eaf0',
          bodyColor: '#e8eaf0',
          padding: 10
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#7a8099',
            callback: value => Number(value) >= 1000
              ? `₹${(Number(value) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}k`
              : fmt(value)
          }
        },
        y: { grid: { display: false }, ticks: { color: '#7a8099' } }
      }
    }
  });

  // Report Stats
  const totalIncome  = store.transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalExpense = store.transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const totalSaved   = store.savingsGoals.reduce((s, g) => s + g.saved, 0);
  const avgDaily     = totalExpense > 0 ? Math.round(totalExpense / 30) : 0;
  const stats = [
    { label: 'Total Income', value: fmt(totalIncome), cls: 'green' },
    { label: 'Total Expenses', value: fmt(totalExpense), cls: 'red' },
    { label: 'Net Savings', value: fmt(totalIncome - totalExpense), cls: 'purple' },
    { label: 'Total in Goals', value: fmt(totalSaved), cls: 'blue' },
    { label: 'Avg Daily Spend', value: fmt(avgDaily), cls: 'red' },
    { label: 'Budget Efficiency', value: totalBudget > 0 ? `${Math.round(((totalBudget - totalExpenses) / totalBudget) * 100)}%` : 'Not set', cls: 'green' },
  ];
  const rs = document.getElementById('reportStats');
  if (rs) rs.innerHTML = stats.map(s => `<div class="report-stat"><span class="report-stat-label">${s.label}</span><span class="report-stat-value ${s.cls}">${s.value}</span></div>`).join('');
}

// ─── MODAL ─────────────────────────────────────────
function openModal() {
  renderTransactionCategoryOptions();
  document.getElementById('transactionModal').classList.add('open');
  document.getElementById('txDate').value = localDateKey();
}
function closeModal() {
  document.getElementById('transactionModal').classList.remove('open');
}
function saveTransaction() {
  const desc   = document.getElementById('txDesc').value.trim();
  const amount = parseFloat(document.getElementById('txAmount').value);
  const date   = document.getElementById('txDate').value;
  const cat    = document.getElementById('txCategory').value;
  const note   = document.getElementById('txNote').value.trim();

  if (!desc)         return showToast('Please enter a description', 'error');
  if (!amount || amount <= 0) return showToast('Please enter a valid amount', 'error');
  if (!date)         return showToast('Please select a date', 'error');

  const transaction = { id: uid(), type: store.txType, desc, amount, category: cat, date, note };
  if (String(cat).startsWith('custom_')) transaction.categoryName = categoryDisplayName(cat);
  store.transactions.unshift(transaction);
  saveStore();
  closeModal();
  document.getElementById('txDesc').value = '';
  document.getElementById('txAmount').value = '';
  document.getElementById('txNote').value = '';
  showToast(`${store.txType === 'expense' ? '💳 Expense' : '📥 Income'} added successfully!`, 'success');
  renderPage(store.currentPage);
}

function openIncomeModal() {
  document.getElementById('incomeForm').reset();
  document.getElementById('incomeDate').value = localDateKey();
  document.getElementById('incomeModal').classList.add('open');
  document.getElementById('incomeDescription').focus();
}

function closeIncomeModal() {
  document.getElementById('incomeModal').classList.remove('open');
}

function saveIncome(event) {
  event.preventDefault();
  const description = document.getElementById('incomeDescription').value.trim();
  const amount = Number(document.getElementById('incomeAmount').value);
  const date = document.getElementById('incomeDate').value;
  const note = document.getElementById('incomeNote').value.trim();
  if (!description || !Number.isFinite(amount) || amount <= 0 || !date) {
    return showToast('Provide a description, positive amount, and date.', 'error');
  }

  store.transactions.unshift({
    id: uid(),
    type: 'income',
    desc: description,
    amount,
    category: 'other',
    date,
    note,
  });
  saveStore();
  closeIncomeModal();
  showToast('Income added successfully!', 'success');
  renderPage(store.currentPage);
}

function openIncomeSourceModal() {
  document.getElementById('incomeSourceForm').reset();
  document.getElementById('incomeSourceAmount').value = '0';
  document.getElementById('incomeSourceFrequency').value = 'Monthly';
  document.getElementById('incomeSourceModal').classList.add('open');
  document.getElementById('incomeSourceName').focus();
}

function closeIncomeSourceModal() {
  document.getElementById('incomeSourceModal').classList.remove('open');
}

function saveIncomeSource(event) {
  event.preventDefault();
  const name = document.getElementById('incomeSourceName').value.trim();
  const amount = Number(document.getElementById('incomeSourceAmount').value);
  const frequency = document.getElementById('incomeSourceFrequency').value.trim();
  if (!name || !Number.isFinite(amount) || amount < 0 || !frequency) {
    return showToast('Provide a source name, valid amount, and frequency.', 'error');
  }

  const icons = ['💼', '🎓', '🏠', '🖥️', '📱', '🎨'];
  store.incomeSources.push({
    id: uid(),
    name,
    icon: icons[Math.floor(Math.random() * icons.length)],
    amount,
    frequency,
    color: '#a78bfa',
  });
  saveStore();
  closeIncomeSourceModal();
  showToast(`Income source "${name}" added! 📥`, 'success');
  renderPage(store.currentPage);
}

function openBudgetCategoryModal() {
  document.getElementById('budgetCategoryForm').reset();
  document.getElementById('customBudgetCategoryField').hidden = true;
  document.getElementById('customBudgetCategoryName').required = false;
  document.getElementById('budgetCategoryModal').classList.add('open');
  document.getElementById('budgetCategoryType').focus();
}

function closeBudgetCategoryModal() {
  document.getElementById('budgetCategoryModal').classList.remove('open');
}

function saveBudgetCategory(event) {
  event.preventDefault();
  const categoryType = document.getElementById('budgetCategoryType').value;
  const customNameInput = document.getElementById('customBudgetCategoryName');
  const customName = customNameInput.value.trim();
  const budget = Number(document.getElementById('budgetCategoryAmount').value);
  const standardNames = {
    food: 'Food',
    transport: 'Transport',
    education: 'Education',
    entertainment: 'Entertainment',
    health: 'Health',
    shopping: 'Shopping',
    utilities: 'Utilities'
  };

  if (!Number.isFinite(budget) || budget <= 0) {
    showToast('Enter a monthly budget greater than zero.', 'error');
    return;
  }
  if (categoryType === 'other' && !customName) {
    customNameInput.focus();
    showToast('Enter a name for your custom category.', 'error');
    return;
  }

  let category;
  let name;
  if (categoryType === 'other') {
    const duplicate = store.budgetCategories.some(item =>
      String(item.category).startsWith('custom_') &&
      String(item.name || '').trim().toLocaleLowerCase() === customName.toLocaleLowerCase()
    );
    if (duplicate) {
      showToast('A custom budget category with that name already exists.', 'error');
      return;
    }
    category = createCustomCategoryKey(customName);
    name = customName;
  } else {
    if (store.budgetCategories.some(item => item.category === categoryType)) {
      showToast('A budget already exists for this category. Delete it first to replace it.', 'error');
      return;
    }
    category = categoryType;
    name = standardNames[categoryType];
  }

  store.budgetCategories.push({
    id: uid(),
    name,
    icon: categoryType === 'other' ? catEmojis.other : catEmojis[categoryType],
    category,
    budget,
    spent: 0,
    color: categoryType === 'other' ? catColors.other : catColors[categoryType]
  });
  saveStore();
  closeBudgetCategoryModal();
  renderPage(store.currentPage);
  showToast(`Budget category "${name}" added.`, 'success');
}

function deleteBudgetCategory(category) {
  const entries = store.budgetCategories.filter(item => item.category === category);
  if (!entries.length) return;
  const categoryName = categoryDisplayName(category);
  if (!confirm(`Delete the ${categoryName} budget? Existing transactions will not be deleted.`)) return;
  store.budgetCategories = store.budgetCategories.filter(item => item.category !== category);
  saveStore();
  renderPage(store.currentPage);
  showToast(`Budget category "${categoryName}" deleted.`, 'info');
}

// ─── EVENT LISTENERS ───────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupPromoInteractions();
  setAuthMode('login');
  document.querySelectorAll('[data-open-auth]').forEach(button => {
    button.addEventListener('click', () => openAuth(button.dataset.openAuth));
  });
  document.getElementById('authBackButton').addEventListener('click', () => {
    document.getElementById('authScreen').hidden = true;
  });
  document.getElementById('passwordToggle').addEventListener('click', event => {
    const password = document.getElementById('authPassword');
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    event.currentTarget.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    event.currentTarget.setAttribute('aria-pressed', String(visible));
  });
  document.getElementById('authSwitch').addEventListener('click', () => {
    const nextMode = document.getElementById('authForm').dataset.mode === 'login' ? 'signup' : 'login';
    setAuthMode(nextMode);
    document.getElementById(nextMode === 'signup' ? 'authName' : 'authEmail').focus();
  });
  document.getElementById('authForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const registering = form.dataset.mode === 'signup';
    const message = document.getElementById('authMessage');
    const submit = document.getElementById('authSubmit');
    const payload = {
      email: document.getElementById('authEmail').value.trim(),
      password: document.getElementById('authPassword').value,
    };
    if (registering) payload.name = document.getElementById('authName').value.trim();
    message.textContent = '';
    message.classList.remove('error');
    submit.disabled = true;

    try {
      const response = await fetch(`${API_URL}/auth/${registering ? 'signup' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Authentication failed');
      sessionCheckError = '';
      form.reset();
      await activateAccount(result.user);
    } catch (error) {
      console.error('Authentication failed:', error);
      message.textContent = error.message || 'Could not connect to the server.';
      message.classList.add('error');
    } finally {
      submit.disabled = false;
    }
  });

  try {
    const response = await fetch(`${API_URL}/auth/me`);
    if (response.ok) {
      const result = await response.json();
      await activateAccount(result.user);
    } else if (response.status !== 401) {
      throw new Error(`Authentication check failed with status ${response.status}`);
    }
  } catch (error) {
    console.error('Could not check the current session:', error);
    sessionCheckError = 'Could not connect to the server. Please start the backend and try again.';
  }

  // Sidebar navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => { e.preventDefault(); navigateTo(item.dataset.page); });
  });

  // Sidebar toggle
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed');
  });

  // Month navigation
  document.getElementById('prevMonth').addEventListener('click', () => { store.monthOffset--; updateMonthDisplay(); });
  document.getElementById('nextMonth').addEventListener('click', () => { store.monthOffset++; updateMonthDisplay(); });

  // Add Transaction button
  document.getElementById('addTransactionBtn').addEventListener('click', openModal);
  document.getElementById('closeModal').addEventListener('click', closeModal);
  document.getElementById('saveTxBtn').addEventListener('click', saveTransaction);
  document.getElementById('transactionModal').addEventListener('click', e => { if (e.target.id === 'transactionModal') closeModal(); });

  // Transaction type tabs
  document.querySelectorAll('.form-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.form-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      store.txType = tab.dataset.type;
      renderTransactionCategoryOptions(store.txType);
    });
  });

  // Spending trend tabs
  document.querySelectorAll('.chart-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chart-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderSpendingTrend(tab.dataset.chart);
    });
  });

  // Expense filters
  document.getElementById('expenseSearch')?.addEventListener('input', e => {
    renderExpenses(document.getElementById('expenseCatFilter').value, document.getElementById('expenseSortFilter').value, e.target.value);
  });
  document.getElementById('expenseCatFilter')?.addEventListener('change', e => {
    renderExpenses(e.target.value, document.getElementById('expenseSortFilter').value, document.getElementById('expenseSearch').value);
  });
  document.getElementById('expenseSortFilter')?.addEventListener('change', e => {
    renderExpenses(document.getElementById('expenseCatFilter').value, e.target.value, document.getElementById('expenseSearch').value);
  });

  // View all transactions button
  document.getElementById('viewAllTransactions')?.addEventListener('click', () => navigateTo('expenses'));

  // Add Goal button
  document.getElementById('addGoalBtn')?.addEventListener('click', openGoalModal);
  document.getElementById('goalForm').addEventListener('submit', saveGoal);
  document.getElementById('goalContributionForm').addEventListener('submit', saveGoalContribution);
  document.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => closeGoalModal(button.dataset.closeModal));
  });
  ['goalModal', 'goalContributionModal'].forEach(modalId => {
    document.getElementById(modalId).addEventListener('click', event => {
      if (event.target.id === modalId) closeGoalModal(modalId);
    });
  });

  // Profile actions
  document.getElementById('saveProfileBtn')?.addEventListener('click', saveProfile);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('profileLogoutBtn').addEventListener('click', logout);

  // Add Income button
  document.getElementById('addIncomeBtn')?.addEventListener('click', openIncomeModal);
  document.getElementById('incomeForm').addEventListener('submit', saveIncome);
  document.getElementById('closeIncomeModal').addEventListener('click', closeIncomeModal);
  document.getElementById('incomeModal').addEventListener('click', event => {
    if (event.target.id === 'incomeModal') closeIncomeModal();
  });

  document.getElementById('addIncomeSourceBtn')?.addEventListener('click', openIncomeSourceModal);
  document.getElementById('incomeSourceForm').addEventListener('submit', saveIncomeSource);
  document.getElementById('closeIncomeSourceModal').addEventListener('click', closeIncomeSourceModal);
  document.getElementById('incomeSourceModal').addEventListener('click', event => {
    if (event.target.id === 'incomeSourceModal') closeIncomeSourceModal();
  });

  // Budget category actions
  document.getElementById('addCategoryBtn')?.addEventListener('click', openBudgetCategoryModal);
  document.getElementById('budgetCategoryForm').addEventListener('submit', saveBudgetCategory);
  document.getElementById('closeBudgetCategoryModal').addEventListener('click', closeBudgetCategoryModal);
  document.getElementById('budgetCategoryModal').addEventListener('click', event => {
    if (event.target.id === 'budgetCategoryModal') closeBudgetCategoryModal();
  });
  document.getElementById('budgetCategoryType').addEventListener('change', event => {
    const showCustomName = event.target.value === 'other';
    const field = document.getElementById('customBudgetCategoryField');
    field.hidden = !showCustomName;
    document.getElementById('customBudgetCategoryName').required = showCustomName;
    if (showCustomName) document.getElementById('customBudgetCategoryName').focus();
  });
  document.getElementById('budgetCatsGrid').addEventListener('click', event => {
    const button = event.target.closest('[data-delete-budget-category]');
    if (button) deleteBudgetCategory(button.dataset.deleteBudgetCategory);
  });

  // Keyboard shortcut
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      closeBudgetCategoryModal();
      closeGoalModal('goalModal');
      closeGoalModal('goalContributionModal');
    }
    if (e.key === 'n' && !e.target.matches('input,textarea,select')) openModal();
  });
});
