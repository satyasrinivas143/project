require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'myspendmate';
const ROOT_DIR = path.join(__dirname, '..');
const SESSION_COOKIE = 'myspendmate_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
let pool;

app.use(express.json({ limit: '1mb' }));

function createId() {
  return crypto.randomBytes(18).toString('hex');
}

function validDatabaseName(name) {
  return /^[a-zA-Z0-9_]+$/.test(name);
}

async function initializeDatabase() {
  if (!validDatabaseName(DB_NAME)) {
    throw new Error('DB_NAME may contain only letters, numbers, and underscores');
  }

  const setupConnection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD
  });

  try {
    await setupConnection.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await setupConnection.end();
  }

  pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
  });

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(254) NOT NULL,
      password_salt CHAR(32) NOT NULL,
      password_hash CHAR(128) NOT NULL,
      degree VARCHAR(120) NOT NULL DEFAULT '',
      college VARCHAR(120) NOT NULL DEFAULT '',
      budget_reset_day TINYINT UNSIGNED NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY users_email_unique (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      type ENUM('income', 'expense') NOT NULL,
      description TEXT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      category VARCHAR(120) NOT NULL,
      date VARCHAR(32) NOT NULL,
      note TEXT NOT NULL,
      INDEX transactions_user_date (user_id, date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS savings_goals (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      icon VARCHAR(32) NOT NULL DEFAULT '🎯',
      description TEXT NOT NULL,
      target DECIMAL(12,2) NOT NULL DEFAULT 0,
      saved DECIMAL(12,2) NOT NULL DEFAULT 0,
      deadline VARCHAR(32) NOT NULL DEFAULT '',
      color VARCHAR(32) NOT NULL DEFAULT 'purple',
      INDEX savings_goals_user_deadline (user_id, deadline)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS budget_categories (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      icon VARCHAR(32) NOT NULL DEFAULT '📦',
      category VARCHAR(120) NOT NULL,
      budget DECIMAL(12,2) NOT NULL DEFAULT 0,
      spent DECIMAL(12,2) NOT NULL DEFAULT 0,
      color VARCHAR(32) NOT NULL DEFAULT '#94a3b8',
      INDEX budget_categories_user_name (user_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS income_sources (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      icon VARCHAR(32) NOT NULL DEFAULT '💰',
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      frequency VARCHAR(64) NOT NULL DEFAULT 'Monthly',
      color VARCHAR(32) NOT NULL DEFAULT '#34d399',
      INDEX income_sources_user_name (user_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];

  for (const statement of statements) await pool.query(statement);
  const [budgetResetDayColumn] = await pool.query("SHOW COLUMNS FROM users LIKE 'budget_reset_day'");
  if (!budgetResetDayColumn.length) {
    await pool.query('ALTER TABLE users ADD COLUMN budget_reset_day TINYINT UNSIGNED NOT NULL DEFAULT 1');
  }
}

async function queryRows(sql, values = []) {
  const [results] = await pool.execute(sql, values);
  return results;
}

async function publicUser(userId) {
  const users = await queryRows(
    'SELECT id, name, email, degree, college, budget_reset_day AS budgetResetDay FROM users WHERE id = ?',
    [userId]
  );
  return users[0] ? { ...users[0], budgetResetDay: Number(users[0].budgetResetDay) } : null;
}

async function readDatabase(userId) {
  const [transactions, savingsGoals, budgetCategories, incomeSources] = await Promise.all([
    queryRows(
      'SELECT id, type, description AS `desc`, amount, category, date, note FROM transactions WHERE user_id = ? ORDER BY date DESC',
      [userId]
    ),
    queryRows(
      'SELECT id, name, icon, description AS `desc`, target, saved, deadline, color FROM savings_goals WHERE user_id = ? ORDER BY deadline',
      [userId]
    ),
    queryRows(
      'SELECT id, name, icon, category, budget, spent, color FROM budget_categories WHERE user_id = ? ORDER BY name',
      [userId]
    ),
    queryRows(
      'SELECT id, name, icon, amount, frequency, color FROM income_sources WHERE user_id = ? ORDER BY name',
      [userId]
    )
  ]);

  return {
    transactions: transactions.map(item => ({ ...item, amount: Number(item.amount) })),
    savingsGoals: savingsGoals.map(item => ({
      ...item,
      target: Number(item.target),
      saved: Number(item.saved)
    })),
    budgetCategories: budgetCategories.map(item => ({
      ...item,
      budget: Number(item.budget),
      spent: Number(item.spent)
    })),
    incomeSources: incomeSources.map(item => ({ ...item, amount: Number(item.amount) }))
  };
}

function isValidStore(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return ['transactions', 'savingsGoals', 'budgetCategories', 'incomeSources']
    .every(key => data[key] === undefined || Array.isArray(data[key]));
}

async function replaceStore(data, userId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const table of ['transactions', 'savings_goals', 'budget_categories', 'income_sources']) {
      await connection.execute(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
    }

    for (const item of data.transactions || []) {
      await connection.execute(
        'INSERT INTO transactions (id, user_id, type, description, amount, category, date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [item.id, userId, item.type, item.desc, Number(item.amount), item.category, item.date, item.note || '']
      );
    }
    for (const item of data.savingsGoals || []) {
      await connection.execute(
        'INSERT INTO savings_goals (id, user_id, name, icon, description, target, saved, deadline, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [item.id, userId, item.name, item.icon || '🎯', item.desc || item.description || '', Number(item.target), Number(item.saved || 0), item.deadline || '', item.color || 'purple']
      );
    }
    for (const item of data.budgetCategories || []) {
      await connection.execute(
        'INSERT INTO budget_categories (id, user_id, name, icon, category, budget, spent, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [item.id, userId, item.name, item.icon || '📦', item.category, Number(item.budget), Number(item.spent || 0), item.color || '#94a3b8']
      );
    }
    for (const item of data.incomeSources || []) {
      await connection.execute(
        'INSERT INTO income_sources (id, user_id, name, icon, amount, frequency, color) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [item.id, userId, item.name, item.icon || '💰', Number(item.amount), item.frequency || 'Monthly', item.color || '#34d399']
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function getSessionToken(req) {
  const cookies = (req.headers.cookie || '').split(';');
  const cookie = cookies.find(item => item.trim().startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return '';
  return decodeURIComponent(cookie.trim().slice(SESSION_COOKIE.length + 1));
}

function setSessionCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}

function clearSessionCookie(req, res) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const requireAuth = asyncRoute(async (req, res, next) => {
  const token = getSessionToken(req);
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return res.status(401).json({ error: 'Please log in to continue' });
  }

  const user = await publicUser(session.userId);
  if (!user) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Please log in to continue' });
  }

  req.user = user;
  next();
});

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'MySpendMate API', database: 'MySQL', timestamp: new Date().toISOString() });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.post('/api/auth/signup', asyncRoute(async (req, res) => {
  const { name, email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254 ||
      typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Provide a name, valid email, and a password between 8 and 128 characters' });
  }

  const salt = crypto.randomBytes(16);
  const passwordHash = crypto.scryptSync(password, salt, 64);
  const userId = createId();
  try {
    await pool.execute(
      'INSERT INTO users (id, name, email, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)',
      [userId, name.trim(), normalizedEmail, salt.toString('hex'), passwordHash.toString('hex')]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    throw error;
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(req, res, token);
  res.status(201).json({ user: await publicUser(userId) });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Provide your email and password' });
  }

  const accounts = await queryRows(
    'SELECT id, password_salt, password_hash FROM users WHERE email = ?',
    [normalizedEmail]
  );
  const account = accounts[0];
  if (!account) return res.status(401).json({ error: 'Email or password is incorrect' });

  const actualHash = crypto.scryptSync(password, Buffer.from(account.password_salt, 'hex'), 64);
  const expectedHash = Buffer.from(account.password_hash, 'hex');
  if (actualHash.length !== expectedHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) {
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: account.id, expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(req, res, token);
  res.json({ user: await publicUser(account.id) });
}));

app.post('/api/auth/logout', (req, res) => {
  sessions.delete(getSessionToken(req));
  clearSessionCookie(req, res);
  res.json({ message: 'Logged out' });
});

app.use('/api', requireAuth);

app.get('/api/profile', (req, res) => res.json({ user: req.user }));

app.put('/api/profile', asyncRoute(async (req, res) => {
  const { name, degree = '', college = '' } = req.body || {};
  const budgetResetDay = req.body && req.body.budgetResetDay !== undefined
    ? Number(req.body.budgetResetDay)
    : req.user.budgetResetDay;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 ||
      typeof degree !== 'string' || degree.length > 120 ||
      typeof college !== 'string' || college.length > 120 ||
      !Number.isInteger(budgetResetDay) || budgetResetDay < 1 || budgetResetDay > 31) {
    return res.status(400).json({ error: 'Provide a name (up to 80 characters), course, college, and a budget reset day from 1 to 31' });
  }

  await pool.execute(
    'UPDATE users SET name = ?, degree = ?, college = ?, budget_reset_day = ? WHERE id = ?',
    [name.trim(), degree.trim(), college.trim(), budgetResetDay, req.user.id]
  );
  res.json({ user: await publicUser(req.user.id) });
}));

app.get('/api/store', asyncRoute(async (req, res) => {
  res.json(await readDatabase(req.user.id));
}));

app.put('/api/store', asyncRoute(async (req, res) => {
  if (!isValidStore(req.body)) {
    return res.status(400).json({ error: 'Expected arrays for transactions, savingsGoals, budgetCategories, and incomeSources' });
  }
  await replaceStore(req.body, req.user.id);
  res.json({ message: 'Data saved to MySQL', data: await readDatabase(req.user.id) });
}));

app.get('/api/transactions', asyncRoute(async (req, res) => {
  res.json((await readDatabase(req.user.id)).transactions);
}));

app.post('/api/transactions', asyncRoute(async (req, res) => {
  const { type, desc, amount, category, date, note = '' } = req.body || {};
  if (!['income', 'expense'].includes(type) || typeof desc !== 'string' || !desc.trim() ||
      !Number.isFinite(Number(amount)) || Number(amount) <= 0 ||
      typeof category !== 'string' || !category || typeof date !== 'string' || !date) {
    return res.status(400).json({ error: 'Provide a valid type, description, positive amount, category, and date' });
  }

  const item = { id: createId(), type, desc: desc.trim(), amount: Number(amount), category, date, note: String(note) };
  const data = await readDatabase(req.user.id);
  data.transactions.unshift(item);
  await replaceStore(data, req.user.id);
  res.status(201).json({ message: 'Transaction added', data: item });
}));

app.delete('/api/transactions/:id', asyncRoute(async (req, res) => {
  const data = await readDatabase(req.user.id);
  const transactions = data.transactions.filter(item => item.id !== req.params.id);
  if (transactions.length === data.transactions.length) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  data.transactions = transactions;
  await replaceStore(data, req.user.id);
  res.json({ message: 'Transaction deleted' });
}));

app.get('/api/goals', asyncRoute(async (req, res) => {
  const data = await readDatabase(req.user.id);
  const goals = data.savingsGoals.map(({ desc, ...goal }) => ({ ...goal, description: desc }));
  res.json(goals);
}));

app.post('/api/goals', asyncRoute(async (req, res) => {
  const { name, icon = '🎯', description = '', target, saved = 0, deadline = '', color = 'purple' } = req.body || {};
  if (typeof name !== 'string' || !name.trim() ||
      !Number.isFinite(Number(target)) || Number(target) <= 0 ||
      !Number.isFinite(Number(saved)) || Number(saved) < 0) {
    return res.status(400).json({ error: 'Provide a name, positive target, and valid saved amount' });
  }

  const item = { id: createId(), name: name.trim(), icon, desc: description, target: Number(target), saved: Number(saved), deadline, color };
  const data = await readDatabase(req.user.id);
  data.savingsGoals.push(item);
  await replaceStore(data, req.user.id);
  res.status(201).json({ message: 'Goal added', data: { ...item, description: item.desc } });
}));

app.get('/api/budget-categories', asyncRoute(async (req, res) => {
  res.json((await readDatabase(req.user.id)).budgetCategories);
}));

app.post('/api/budget-categories', asyncRoute(async (req, res) => {
  const { name, icon = '📦', category, budget, spent = 0, color = '#94a3b8' } = req.body || {};
  if (typeof name !== 'string' || !name.trim() ||
      typeof category !== 'string' || !category ||
      !Number.isFinite(Number(budget)) || Number(budget) <= 0 ||
      !Number.isFinite(Number(spent)) || Number(spent) < 0) {
    return res.status(400).json({ error: 'Provide a name, category, positive budget, and valid spent amount' });
  }

  const item = { id: createId(), name: name.trim(), icon, category, budget: Number(budget), spent: Number(spent), color };
  const data = await readDatabase(req.user.id);
  data.budgetCategories.push(item);
  await replaceStore(data, req.user.id);
  res.status(201).json({ message: 'Budget category added', data: item });
}));

app.get('/api/income-sources', asyncRoute(async (req, res) => {
  res.json((await readDatabase(req.user.id)).incomeSources);
}));

app.post('/api/income-sources', asyncRoute(async (req, res) => {
  const { name, icon = '💰', amount, frequency = 'Monthly', color = '#34d399' } = req.body || {};
  if (typeof name !== 'string' || !name.trim() ||
      !Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return res.status(400).json({ error: 'Provide a name and a valid non-negative amount' });
  }

  const item = { id: createId(), name: name.trim(), icon, amount: Number(amount), frequency, color };
  const data = await readDatabase(req.user.id);
  data.incomeSources.push(item);
  await replaceStore(data, req.user.id);
  res.status(201).json({ message: 'Income source added', data: item });
}));

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const data = await readDatabase(req.user.id);
  const totalIncome = data.transactions
    .filter(item => item.type === 'income')
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const totalExpense = data.transactions
    .filter(item => item.type === 'expense')
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const totalSavings = data.savingsGoals.reduce((sum, item) => sum + Number(item.saved), 0);
  const savingsGoalTarget = data.savingsGoals.reduce((sum, item) => sum + Number(item.target), 0);
  const totalBudget = data.budgetCategories.reduce((sum, item) => sum + Number(item.budget), 0);
  const totalBudgetSpent = data.budgetCategories.reduce((sum, item) => sum + Number(item.spent), 0);

  res.json({
    totalBalance: totalIncome - totalExpense,
    totalIncome,
    totalExpense,
    totalSavings,
    savingsGoalTarget,
    totalBudget,
    totalBudgetSpent
  });
}));

app.use(express.static(ROOT_DIR));
app.get('/', (req, res) => res.sendFile(path.join(ROOT_DIR, 'index.html')));

app.use((error, req, res, next) => {
  console.error(`Request failed for ${req.method} ${req.path}:`, error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'The server could not complete the request. Check the backend log for details.' });
});

async function start() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`MySpendMate API running at http://localhost:${PORT}`);
    console.log(`MySQL database "${DB_NAME}" is ready on ${DB_HOST}:${DB_PORT}`);
  });
}

start().catch(async error => {
  console.error('Could not start MySpendMate. Check that MySQL Server is running and the DB_* settings are correct.');
  console.error(error);
  if (pool) await pool.end();
  process.exitCode = 1;
});

async function shutdown() {
  if (pool) await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
