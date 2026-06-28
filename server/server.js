import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDB, migrate, closeDB, backupDatabase } from './db.js';
import { validatePhone } from './phone.js';
import { upsertDailyPlayer, searchDailyPlayers } from './players.js';
import { scheduleDailyReset } from './dailyReset.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'black-racks-dev-secret-change-in-production';
const app = express();
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for SSE
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP'
});
app.use(limiter);

// Body parsing and logging
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));

// CORS
const corsOrigins = process.env.CORS_ORIGIN?.split(',') || ['http://localhost:8080'];
app.use(cors({ 
  origin: corsOrigins,
  credentials: true 
}));

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = await getDB();
    const user = await db.get('SELECT * FROM users WHERE id = ? AND is_active = 1', decoded.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Admin role middleware
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const PUBLIC_API_PATHS = new Set(['/api/auth/login', '/api/health']);

const authenticateEventToken = async (req, res, next) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Access token required' });
  req.headers.authorization = `Bearer ${token}`;
  return authenticateToken(req, res, next);
};

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (req.path === '/api/events') return authenticateEventToken(req, res, next);
  return authenticateToken(req, res, next);
});

// Server-Sent Events for real-time updates
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.flushHeaders();
  
  // Send initial connection confirmation
  res.write('event: connected\ndata: {"message":"Connected to real-time updates"}\n\n');
  res.write('retry: 3000\n\n');

  const clientId = Date.now().toString();
  const client = { id: clientId, res, lastPing: Date.now() };
  clients.add(client);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    if (clients.has(client)) {
      res.write('event: heartbeat\ndata: {"timestamp":' + Date.now() + '}\n\n');
      client.lastPing = Date.now();
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
    console.log(`🔌 Client ${clientId} disconnected. Active clients: ${clients.size}`);
  });

  console.log(`🔌 Client ${clientId} connected. Active clients: ${clients.size}`);
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const deadClients = new Set();
  
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch (error) {
      console.error('📡 Failed to send to client:', error.message);
      deadClients.add(client);
    }
  }
  
  // Clean up dead connections
  for (const client of deadClients) {
    clients.delete(client);
  }
  
  if (deadClients.size > 0) {
    console.log(`🧹 Cleaned up ${deadClients.size} dead connections. Active: ${clients.size}`);
  }
}

// Utility functions
const now = () => Date.now();
const ceilToMinute = (ms) => Math.ceil(ms / 60000);
const formatCurrency = (amount) => `₹${amount.toLocaleString('en-IN')}`;
const formatDuration = (ms) => {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
};

const getRatePerMinute = (table) => table.hourly_rate / 60;

const getTableDisplayName = (table) => table.name || `Table ${table.id}`;

const calculateBillAmount = (table, minutes, { isFriendly = false, discountPercent = 0 } = {}) => {
  if (isFriendly) return 0;
  const perMinuteAmount = Math.round(minutes * getRatePerMinute(table));
  const baseAmount = Math.max(table.minimum_charge || 0, perMinuteAmount);
  const discount = (discountPercent || 0) / 100;
  return Math.round(baseAmount * (1 - discount));
};

async function applyEarningsToSummary(db, session, table) {
  if (session.is_friendly || !session.amount) return;
  const today = new Date().toISOString().slice(0, 10);
  const payment_method = session.payment_method || 'CASH';
  const finalAmount = session.amount;
  const earningsField = table.type === 'ENGLISH' ? 'english_earnings' : 'french_earnings';
  const paymentField = `${payment_method.toLowerCase()}_earnings`;
  const existingSummary = await db.get('SELECT * FROM daily_summaries WHERE date = ?', today);

  if (!existingSummary) {
    await db.run(`
      INSERT INTO daily_summaries (
        date, total_earnings, total_sessions, friendly_games,
        english_earnings, french_earnings, cash_earnings, upi_earnings, card_earnings
      ) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)
    `, today, finalAmount,
       table.type === 'ENGLISH' ? finalAmount : 0,
       table.type === 'FRENCH' ? finalAmount : 0,
       payment_method === 'CASH' ? finalAmount : 0,
       payment_method === 'UPI' ? finalAmount : 0,
       payment_method === 'CARD' ? finalAmount : 0);
  } else {
    await db.run(`
      UPDATE daily_summaries SET
        total_earnings = total_earnings + ?,
        ${earningsField} = ${earningsField} + ?,
        ${paymentField} = ${paymentField} + ?
      WHERE date = ?
    `, finalAmount, finalAmount, finalAmount, today);
  }
}

async function incrementDailySessionCounts(db, today, isFriendly) {
  const existingSummary = await db.get('SELECT * FROM daily_summaries WHERE date = ?', today);
  if (!existingSummary) {
    await db.run(`
      INSERT INTO daily_summaries (date, total_earnings, total_sessions, friendly_games)
      VALUES (?, 0, 1, ?)
    `, today, isFriendly ? 1 : 0);
  } else {
    await db.run(`
      UPDATE daily_summaries SET total_sessions = total_sessions + 1, friendly_games = friendly_games + ?
      WHERE date = ?
    `, isFriendly ? 1 : 0, today);
  }
}

// Enhanced computation with better error handling
async function computeRunningAmount(table) {
  try {
    const db = await getDB();
    const session = await db.get(`
      SELECT * FROM sessions 
      WHERE table_id = ? AND end_time IS NULL 
      ORDER BY id DESC LIMIT 1
    `, table.id);
    
    if (!session) return 0;
    
    const currentTime = now();
    const resumeTime = session.last_resume_time || session.start_time;
    const elapsed = currentTime - resumeTime;
    const effectiveMs = (session.duration_ms || 0) + elapsed - (session.paused_ms || 0);
    const minutes = Math.max(0, ceilToMinute(effectiveMs));
    const finalAmount = calculateBillAmount(table, minutes, {
      isFriendly: session.is_friendly,
      discountPercent: session.discount_percent
    });
    
    return {
      amount: finalAmount,
      minutes,
      duration: formatDuration(effectiveMs),
      elapsed_ms: effectiveMs
    };
  } catch (error) {
    console.error('❌ Error computing running amount:', error);
    return 0;
  }
}

// API Routes

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const db = await getDB();
    await db.get('SELECT 1');
    res.json({ 
      status: 'healthy', 
      timestamp: now(),
      version: '2.0.0',
      uptime: process.uptime(),
      clients: clients.size 
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: now() 
    });
  }
});

// Authentication endpoints
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const db = await getDB();
    const user = await db.get('SELECT * FROM users WHERE username = ? AND is_active = 1', username);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Verify password using bcrypt
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Update last login
    await db.run('UPDATE users SET last_login = ? WHERE id = ?', Date.now(), user.id);
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // Create session record
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
    
    await db.run(
      'INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
      sessionId, user.id, expiresAt
    );
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        full_name: user.full_name
      },
      sessionId
    });
    
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (sessionId) {
      const db = await getDB();
      await db.run('DELETE FROM user_sessions WHERE id = ?', sessionId);
    }
    
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      full_name: req.user.full_name
    }
  });
});

app.post('/api/auth/verify-password', authenticateToken, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }
    const db = await getDB();
    const admin = await db.get(`SELECT password_hash FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1`);
    if (!admin) {
      return res.status(500).json({ error: 'Admin account not found' });
    }
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Settings endpoints (admin only)
app.get('/api/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = await getDB();
    const settings = await db.all('SELECT * FROM settings ORDER BY key');
    
    const settingsObj = {};
    settings.forEach(setting => {
      settingsObj[setting.key] = {
        value: setting.value,
        description: setting.description,
        updated_at: setting.updated_at
      };
    });
    
    res.json(settingsObj);
  } catch (error) {
    console.error('❌ Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.patch('/api/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    const db = await getDB();
    
    for (const [key, value] of Object.entries(updates)) {
      await db.run(
        'INSERT OR REPLACE INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)',
        key, value, Date.now(), req.user.id
      );
    }
    
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (error) {
    console.error('❌ Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Table management endpoints (admin only)
app.post('/api/admin/tables', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { type, hourly_rate } = req.body;
    
    if (!type || !hourly_rate) {
      return res.status(400).json({ error: 'Type and hourly rate required' });
    }
    
    if (!['ENGLISH', 'FRENCH'].includes(type)) {
      return res.status(400).json({ error: 'Invalid table type' });
    }
    
    const db = await getDB();
    const result = await db.run(
      'INSERT INTO tables (type, hourly_rate) VALUES (?, ?)',
      type, parseInt(hourly_rate)
    );
    
    const newTable = await db.get('SELECT * FROM tables WHERE id = ?', result.lastID);
    
    broadcast('table:created', newTable);
    res.json({ success: true, table: newTable });
    
  } catch (error) {
    console.error('❌ Error creating table:', error);
    res.status(500).json({ error: 'Failed to create table' });
  }
});

app.patch('/api/admin/tables/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const tableId = parseInt(req.params.id);
    const { type, hourly_rate } = req.body;
    
    const db = await getDB();
    const updates = {};
    
    if (type && ['ENGLISH', 'FRENCH'].includes(type)) {
      updates.type = type;
    }
    
    if (hourly_rate) {
      updates.hourly_rate = parseInt(hourly_rate);
    }
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid updates provided' });
    }
    
    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(tableId);
    
    await db.run(`UPDATE tables SET ${setClause} WHERE id = ?`, ...values);
    
    const updatedTable = await db.get('SELECT * FROM tables WHERE id = ?', tableId);
    
    broadcast('table:updated', updatedTable);
    res.json({ success: true, table: updatedTable });
    
  } catch (error) {
    console.error('❌ Error updating table:', error);
    res.status(500).json({ error: 'Failed to update table' });
  }
});

app.delete('/api/admin/tables/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const tableId = parseInt(req.params.id);
    
    const db = await getDB();
    
    // Check if table has active sessions
    const activeSession = await db.get(
      'SELECT id FROM sessions WHERE table_id = ? AND end_time IS NULL',
      tableId
    );
    
    if (activeSession) {
      return res.status(400).json({ error: 'Cannot delete table with active session' });
    }
    
    await db.run('DELETE FROM tables WHERE id = ?', tableId);
    
    broadcast('table:deleted', { id: tableId });
    res.json({ success: true, message: 'Table deleted successfully' });
    
  } catch (error) {
    console.error('❌ Error deleting table:', error);
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

// Tables management
app.get('/api/tables', async (req, res) => {
  try {
    const db = await getDB();
    const tables = await db.all('SELECT * FROM tables ORDER BY id');
    
    // Enrich with running amounts and session info
    const enriched = await Promise.all(tables.map(async (table) => {
      const runningData = await computeRunningAmount(table);
      const activeSession = await db.get(`
        SELECT id, customer_name, start_time, last_resume_time, paused_ms, is_friendly, break_count 
        FROM sessions 
        WHERE table_id = ? AND end_time IS NULL 
        ORDER BY id DESC LIMIT 1
      `, table.id);
      
      return {
        ...table,
        running_amount: typeof runningData === 'object' ? runningData.amount : runningData,
        running_data: typeof runningData === 'object' ? runningData : null,
        active_session: activeSession
      };
    }));
    
    res.json(enriched);
  } catch (error) {
    console.error('❌ Error fetching tables:', error);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

app.patch('/api/table/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const tableId = parseInt(req.params.id);
    
    if (!['AVAILABLE', 'OCCUPIED', 'MAINTENANCE'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const db = await getDB();
    await db.run('UPDATE tables SET status = ?, updated_at = ? WHERE id = ?', 
      status, now(), tableId);
    
    const updatedTable = await db.get('SELECT * FROM tables WHERE id = ?', tableId);
    
    if (status === 'MAINTENANCE') {
      await db.run('UPDATE tables SET last_maintenance = ? WHERE id = ?', now(), tableId);
    }
    
    broadcast('table:update', updatedTable);
    res.json(updatedTable);
  } catch (error) {
    console.error('❌ Error updating table status:', error);
    res.status(500).json({ error: 'Failed to update table status' });
  }
});

// Session management - Enhanced
app.post('/api/table/:id/start', async (req, res) => {
  try {
    const tableId = parseInt(req.params.id);
    const { 
      is_friendly = false, 
      customer_name = null, 
      customer_phone = null,
      notes = null,
      discount_percent = 0,
      payment_method = 'CASH'
    } = req.body;

    let normalizedPhone = null;
    if (customer_phone) {
      const phoneCheck = validatePhone(customer_phone);
      if (!phoneCheck.valid) {
        return res.status(400).json({ error: phoneCheck.error });
      }
      normalizedPhone = phoneCheck.phone;
    }
    
    const db = await getDB();
    const table = await db.get('SELECT * FROM tables WHERE id = ?', tableId);
    
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }
    
    if (table.status === 'OCCUPIED') {
      return res.status(409).json({ error: 'Table already occupied' });
    }
    
    if (table.status === 'MAINTENANCE') {
      return res.status(409).json({ error: 'Table under maintenance' });
    }
    
    const startTime = now();
    
    // Create session
    const sessionResult = await db.run(`
      INSERT INTO sessions (
        table_id, start_time, is_friendly, customer_name, customer_phone,
        notes, last_resume_time, discount_percent, payment_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, tableId, startTime, is_friendly ? 1 : 0, customer_name, normalizedPhone, 
       notes, startTime, discount_percent, payment_method);
    
    // Update table status
    await db.run('UPDATE tables SET status = "OCCUPIED", light_on = 1 WHERE id = ?', tableId);
    
    const session = await db.get('SELECT * FROM sessions WHERE id = ?', sessionResult.lastID);
    const updatedTable = await db.get('SELECT * FROM tables WHERE id = ?', tableId);
    
    // Hardware integration
    await controlTableLight(tableId, true);
    
    broadcast('session:start', { session, table: updatedTable });
    
    res.json({ 
      success: true, 
      session, 
      table: updatedTable,
      message: `Session started on Table ${tableId}` 
    });
    
  } catch (error) {
    console.error('❌ Error starting session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

app.post('/api/table/:id/pause', async (req, res) => {
  try {
    const tableId = parseInt(req.params.id);
    const db = await getDB();
    
    const session = await db.get(`
      SELECT * FROM sessions 
      WHERE table_id = ? AND end_time IS NULL 
      ORDER BY id DESC LIMIT 1
    `, tableId);
    
    if (!session) {
      return res.status(404).json({ error: 'No active session found' });
    }
    
    if (!session.last_resume_time) {
      return res.status(400).json({ error: 'Session is already paused' });
    }
    
    const pauseTime = now();
    const additionalMs = pauseTime - session.last_resume_time;
    const newDuration = (session.duration_ms || 0) + additionalMs;
    
    await db.run(`
      UPDATE sessions SET 
        duration_ms = ?,
        last_resume_time = NULL,
        break_count = break_count + 1
      WHERE id = ?
    `, newDuration, session.id);
    
    broadcast('session:pause', { table_id: tableId, session_id: session.id });
    
    res.json({ 
      success: true, 
      message: 'Session paused',
      duration: formatDuration(newDuration)
    });
    
  } catch (error) {
    console.error('❌ Error pausing session:', error);
    res.status(500).json({ error: 'Failed to pause session' });
  }
});

app.post('/api/table/:id/resume', async (req, res) => {
  try {
    const tableId = parseInt(req.params.id);
    const db = await getDB();
    
    const session = await db.get(`
      SELECT * FROM sessions 
      WHERE table_id = ? AND end_time IS NULL 
      ORDER BY id DESC LIMIT 1
    `, tableId);
    
    if (!session) {
      return res.status(404).json({ error: 'No active session found' });
    }
    
    if (session.last_resume_time) {
      return res.status(400).json({ error: 'Session is not paused' });
    }
    
    const resumeTime = now();
    await db.run('UPDATE sessions SET last_resume_time = ? WHERE id = ?', resumeTime, session.id);
    
    broadcast('session:resume', { table_id: tableId, session_id: session.id });
    
    res.json({ 
      success: true, 
      message: 'Session resumed' 
    });
    
  } catch (error) {
    console.error('❌ Error resuming session:', error);
    res.status(500).json({ error: 'Failed to resume session' });
  }
});

app.post('/api/table/:id/stop', async (req, res) => {
  try {
    const tableId = parseInt(req.params.id);
    const { payment_method = 'CASH', discount_percent = 0 } = req.body;
    
    const db = await getDB();
    const table = await db.get('SELECT * FROM tables WHERE id = ?', tableId);
    const session = await db.get(`
      SELECT * FROM sessions 
      WHERE table_id = ? AND end_time IS NULL 
      ORDER BY id DESC LIMIT 1
    `, tableId);
    
    if (!table || !session) {
      return res.status(404).json({ error: 'Table or active session not found' });
    }
    
    const endTime = now();
    const additionalMs = session.last_resume_time ? (endTime - session.last_resume_time) : 0;
    const totalDurationMs = (session.duration_ms || 0) + additionalMs;
    const billedMinutes = Math.max(0, ceilToMinute(totalDurationMs));
    const perMinuteAmount = Math.round(billedMinutes * getRatePerMinute(table));
    const baseAmount = session.is_friendly ? 0 : Math.max(table.minimum_charge || 0, perMinuteAmount);
    const discountAmount = session.is_friendly ? 0 : Math.round(baseAmount * (discount_percent / 100));
    const finalAmount = session.is_friendly ? 0 : (baseAmount - discountAmount);
    const paymentStatus = session.is_friendly || finalAmount === 0 ? 'PAID' : 'PENDING';
    
    // Update session
    await db.run(`
      UPDATE sessions SET 
        end_time = ?,
        duration_ms = ?,
        billed_minutes = ?,
        amount = ?,
        payment_method = ?,
        discount_percent = ?,
        payment_status = ?
      WHERE id = ?
    `, endTime, totalDurationMs, billedMinutes, finalAmount, payment_method, discount_percent, paymentStatus, session.id);
    
    // Update table
    await db.run('UPDATE tables SET status = "AVAILABLE", light_on = 0 WHERE id = ?', tableId);
    
    const today = new Date().toISOString().slice(0, 10);
    if (session.customer_name && !session.is_friendly) {
      await upsertDailyPlayer(db, {
        name: session.customer_name,
        phone: session.customer_phone,
        amount: finalAmount,
        date: today
      });
    }

    if (!session.is_friendly && finalAmount > 0) {
      await applyEarningsToSummary(db, { ...session, amount: finalAmount, payment_method, is_friendly: session.is_friendly }, table);
    }

    await incrementDailySessionCounts(db, today, session.is_friendly);
    
    const finalSession = await db.get('SELECT * FROM sessions WHERE id = ?', session.id);
    const updatedTable = await db.get('SELECT * FROM tables WHERE id = ?', tableId);
    
    // Hardware integration
    await controlTableLight(tableId, false);
    
    broadcast('session:stop', { session: finalSession, table: updatedTable });
    
    res.json({ 
      success: true,
      session: finalSession, 
      table: updatedTable,
      receipt: {
        amount: finalAmount,
        duration: formatDuration(totalDurationMs),
        minutes: billedMinutes,
        rate: `₹${getRatePerMinute(table)}/min (min ₹${table.minimum_charge || 0})`,
        discount: discount_percent > 0 ? `${discount_percent}%` : null
      }
    });
    
  } catch (error) {
    console.error('❌ Error stopping session:', error);
    res.status(500).json({ error: 'Failed to stop session' });
  }
});

// Hardware integration functions
async function controlTableLight(tableId, on) {
  if (process.env.HARDWARE_ENABLED !== 'true') return;
  
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(`http://${process.env.ARDUINO_HOST}/light/${tableId}/${on ? 'on' : 'off'}`, {
      method: 'POST',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    const db = await getDB();
    await db.run(`
      INSERT INTO hardware_logs (table_id, action, status, response_time_ms)
      VALUES (?, ?, ?, ?)
    `, tableId, `light_${on ? 'on' : 'off'}`, response.ok ? 1 : 0, Date.now() - start);
    
  } catch (error) {
    // Only log hardware errors in development mode to reduce noise
    if (process.env.NODE_ENV === 'development') {
      console.log(`⚠️ Hardware not available for table ${tableId} (${error.name})`);
    }
    
    try {
      const db = await getDB();
      await db.run(`
        INSERT INTO hardware_logs (table_id, action, status, error_message)
        VALUES (?, ?, 0, ?)
      `, tableId, `light_${on ? 'on' : 'off'}`, error.name || error.message);
    } catch (dbError) {
      // Ignore database errors for hardware logs
    }
  }
}

// Reports and analytics
app.get('/api/summary/today', async (req, res) => {
  try {
    const db = await getDB();
    const today = new Date().toISOString().slice(0, 10);
    
    const summary = await db.get('SELECT * FROM daily_summaries WHERE date = ?', today);
    
    // Get real-time data for active sessions
    const activeSessions = await db.all(`
      SELECT s.*, t.hourly_rate, t.minimum_charge, t.type 
      FROM sessions s 
      JOIN tables t ON s.table_id = t.id 
      WHERE s.end_time IS NULL
    `);
    
    let activeEarnings = 0;
    for (const session of activeSessions) {
      if (!session.is_friendly) {
        const elapsed = now() - (session.last_resume_time || session.start_time);
        const totalMs = (session.duration_ms || 0) + elapsed - (session.paused_ms || 0);
        const minutes = Math.max(0, ceilToMinute(totalMs));
        activeEarnings += calculateBillAmount(session, minutes, {
          isFriendly: session.is_friendly,
          discountPercent: session.discount_percent
        });
      }
    }
    
    const result = summary || { 
      date: today, 
      total_earnings: 0, 
      total_sessions: 0, 
      friendly_games: 0,
      english_earnings: 0,
      french_earnings: 0,
      cash_earnings: 0,
      upi_earnings: 0,
      card_earnings: 0
    };
    
    res.json({
      ...result,
      active_earnings: activeEarnings,
      active_sessions: activeSessions.length,
      projected_earnings: result.total_earnings + activeEarnings,
      pending_payments: await db.get(`
        SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
        FROM sessions
        WHERE payment_status = 'PENDING' AND end_time IS NOT NULL
          AND start_time >= ? AND start_time < ?
      `, new Date(today + 'T00:00:00').getTime(), new Date(today + 'T00:00:00').getTime() + 86400000)
    });
    
  } catch (error) {
    console.error('❌ Error fetching today summary:', error);
    res.status(500).json({ error: 'Failed to fetch today summary' });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const { date, limit = 50, offset = 0, customer_phone } = req.query;
    const db = await getDB();
    
    let query = 'SELECT s.*, t.type as table_type, t.name as table_name FROM sessions s JOIN tables t ON s.table_id = t.id';
    let params = [];
    let conditions = [];
    
    if (date) {
      const startTime = new Date(date + 'T00:00:00Z').getTime();
      const endTime = startTime + 24 * 60 * 60 * 1000;
      conditions.push('s.start_time >= ? AND s.start_time < ?');
      params.push(startTime, endTime);
    }
    
    if (customer_phone) {
      conditions.push('s.customer_phone = ?');
      params.push(customer_phone);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY s.start_time DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const sessions = await db.all(query, ...params);
    
    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM sessions s';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countResult = await db.get(countQuery, ...params.slice(0, -2));
    
    res.json({
      sessions,
      total: countResult.total,
      limit: parseInt(limit),
      offset: parseInt(offset),
      has_more: countResult.total > parseInt(offset) + parseInt(limit)
    });
    
  } catch (error) {
    console.error('❌ Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const { search, limit = 10 } = req.query;
    if (!search || String(search).trim().length < 2) {
      return res.json([]);
    }
    const db = await getDB();
    const today = new Date().toISOString().slice(0, 10);
    const players = await searchDailyPlayers(db, search, today, parseInt(limit));
    res.json(players.map(p => ({
      id: p.player_code,
      player_code: p.player_code,
      name: p.name,
      phone: p.phone,
      sessions_count: p.sessions_count,
      total_spent: p.total_spent
    })));
  } catch (error) {
    console.error('Error fetching player suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

app.get('/api/players/today', async (req, res) => {
  try {
    const db = await getDB();
    const today = new Date().toISOString().slice(0, 10);
    const players = await db.all(
      'SELECT player_code, name, phone, sessions_count, total_spent FROM daily_players WHERE date = ? ORDER BY last_seen DESC',
      today
    );
    res.json({ date: today, total: players.length, players });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

app.post('/api/session/:id/mark-paid', authenticateToken, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const db = await getDB();
    const row = await db.get(`
      SELECT s.*, t.type, t.name as table_name
      FROM sessions s
      JOIN tables t ON t.id = s.table_id
      WHERE s.id = ?
    `, sessionId);

    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (row.payment_status === 'PAID') {
      return res.status(400).json({ error: 'Already marked as paid' });
    }
    if (!row.end_time) {
      return res.status(400).json({ error: 'Session is still active' });
    }

    await db.run(`UPDATE sessions SET payment_status = 'PAID' WHERE id = ?`, sessionId);

    const updated = await db.get('SELECT * FROM sessions WHERE id = ?', sessionId);
    broadcast('session:paid', { session: updated });
    res.json({ success: true, session: updated });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark as paid' });
  }
});

app.get('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const db = await getDB();

    const customer = await db.get('SELECT * FROM customers WHERE id = ?', customerId);

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json(customer);

  } catch (error) {
    console.error('❌ Error fetching customer:', error);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

app.post('/api/customers', authenticateToken, async (req, res) => {
  try {
    const {
      name, phone, email, date_of_birth, address,
      membership_type = 'REGULAR', membership_start_date,
      membership_expiry_date, emergency_contact, notes
    } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    const db = await getDB();

    // Check if customer with this phone already exists
    const existingCustomer = await db.get('SELECT * FROM customers WHERE phone = ?', phone);
    if (existingCustomer) {
      return res.status(409).json({ error: 'Customer with this phone number already exists' });
    }

    const result = await db.run(`
      INSERT INTO customers (
        name, phone, email, date_of_birth, address,
        membership_type, membership_start_date, membership_expiry_date,
        emergency_contact, notes, last_visit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, name, phone, email, date_of_birth, address,
       membership_type, membership_start_date, membership_expiry_date,
       emergency_contact, notes, Date.now());

    const newCustomer = await db.get('SELECT * FROM customers WHERE id = ?', result.lastID);
    res.json({ success: true, customer: newCustomer });

  } catch (error) {
    console.error('❌ Error creating customer:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// ===== MEMBERSHIP SYSTEM ENDPOINTS =====

// Membership Tiers
app.get('/api/membership/tiers', authenticateToken, async (req, res) => {
  try {
    const db = await getDB();
    const tiers = await db.all('SELECT * FROM membership_tiers WHERE is_active = 1 ORDER BY monthly_fee');
    res.json(tiers);
  } catch (error) {
    console.error('❌ Error fetching membership tiers:', error);
    res.status(500).json({ error: 'Failed to fetch membership tiers' });
  }
});

app.post('/api/membership/tiers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      name, description, monthly_fee, annual_fee, session_discount_percent,
      consumable_discount_percent, priority_booking, free_sessions_per_month,
      points_multiplier, min_spending_requirement
    } = req.body;

    const db = await getDB();
    const result = await db.run(`
      INSERT INTO membership_tiers (
        name, description, monthly_fee, annual_fee, session_discount_percent,
        consumable_discount_percent, priority_booking, free_sessions_per_month,
        points_multiplier, min_spending_requirement
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, name, description, monthly_fee, annual_fee, session_discount_percent,
       consumable_discount_percent, priority_booking, free_sessions_per_month,
       points_multiplier, min_spending_requirement);

    const newTier = await db.get('SELECT * FROM membership_tiers WHERE id = ?', result.lastID);
    res.json({ success: true, tier: newTier });

  } catch (error) {
    console.error('❌ Error creating membership tier:', error);
    res.status(500).json({ error: 'Failed to create membership tier' });
  }
});

// Customer Membership Management
app.patch('/api/customers/:id/membership', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const { membership_type, membership_start_date, membership_expiry_date } = req.body;

    const db = await getDB();

    // Update customer membership
    await db.run(`
      UPDATE customers SET
        membership_type = ?,
        membership_start_date = ?,
        membership_expiry_date = ?,
        membership_status = 'ACTIVE',
        updated_at = ?
      WHERE id = ?
    `, membership_type, membership_start_date, membership_expiry_date, now(), customerId);

    // Get updated customer
    const customer = await db.get('SELECT * FROM customers WHERE id = ?', customerId);
    res.json({ success: true, customer });

  } catch (error) {
    console.error('❌ Error updating customer membership:', error);
    res.status(500).json({ error: 'Failed to update customer membership' });
  }
});

// Loyalty Points System
app.get('/api/customers/:id/loyalty', authenticateToken, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const db = await getDB();

    // Get customer loyalty info
    const customer = await db.get('SELECT loyalty_points, membership_type FROM customers WHERE id = ?', customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get recent transactions
    const transactions = await db.all(`
      SELECT * FROM loyalty_transactions
      WHERE customer_id = ?
      ORDER BY created_at DESC LIMIT 10
    `, customerId);

    res.json({
      current_points: customer.loyalty_points,
      membership_type: customer.membership_type,
      transactions
    });

  } catch (error) {
    console.error('❌ Error fetching customer loyalty:', error);
    res.status(500).json({ error: 'Failed to fetch customer loyalty' });
  }
});

app.post('/api/customers/:id/loyalty/earn', authenticateToken, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const { points, description, reference_id, reference_type } = req.body;

    const db = await getDB();

    // Get current points
    const customer = await db.get('SELECT loyalty_points FROM customers WHERE id = ?', customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const previousBalance = customer.loyalty_points;
    const newBalance = previousBalance + points;

    // Record transaction
    const result = await db.run(`
      INSERT INTO loyalty_transactions (
        customer_id, transaction_type, points, previous_balance,
        new_balance, reference_id, reference_type, description
      ) VALUES (?, 'EARNED', ?, ?, ?, ?, ?, ?)
    `, customerId, points, previousBalance, newBalance, reference_id, reference_type, description);

    // Update customer points
    await db.run('UPDATE customers SET loyalty_points = ? WHERE id = ?', newBalance, customerId);

    const transaction = await db.get('SELECT * FROM loyalty_transactions WHERE id = ?', result.lastID);
    res.json({ success: true, transaction, new_balance: newBalance });

  } catch (error) {
    console.error('❌ Error earning loyalty points:', error);
    res.status(500).json({ error: 'Failed to earn loyalty points' });
  }
});

app.post('/api/customers/:id/loyalty/redeem', authenticateToken, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const { points, description } = req.body;

    const db = await getDB();

    // Get current points
    const customer = await db.get('SELECT loyalty_points FROM customers WHERE id = ?', customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (customer.loyalty_points < points) {
      return res.status(400).json({ error: 'Insufficient loyalty points' });
    }

    const previousBalance = customer.loyalty_points;
    const newBalance = previousBalance - points;

    // Record transaction
    const result = await db.run(`
      INSERT INTO loyalty_transactions (
        customer_id, transaction_type, points, previous_balance,
        new_balance, description
      ) VALUES (?, 'REDEEMED', ?, ?, ?, ?)
    `, customerId, points, previousBalance, newBalance, description);

    // Update customer points
    await db.run('UPDATE customers SET loyalty_points = ? WHERE id = ?', newBalance, customerId);

    const transaction = await db.get('SELECT * FROM loyalty_transactions WHERE id = ?', result.lastID);
    res.json({ success: true, transaction, new_balance: newBalance });

  } catch (error) {
    console.error('❌ Error redeeming loyalty points:', error);
    res.status(500).json({ error: 'Failed to redeem loyalty points' });
  }
});

// Membership Rewards
app.get('/api/membership/rewards', authenticateToken, async (req, res) => {
  try {
    const db = await getDB();
    const rewards = await db.all('SELECT * FROM membership_rewards WHERE is_active = 1 ORDER BY name');
    res.json(rewards);
  } catch (error) {
    console.error('❌ Error fetching membership rewards:', error);
    res.status(500).json({ error: 'Failed to fetch membership rewards' });
  }
});

app.post('/api/membership/rewards', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, description, reward_type, value, item_id, min_tier } = req.body;

    const db = await getDB();
    const result = await db.run(`
      INSERT INTO membership_rewards (name, description, reward_type, value, item_id, min_tier)
      VALUES (?, ?, ?, ?, ?, ?)
    `, name, description, reward_type, value, item_id, min_tier);

    const newReward = await db.get('SELECT * FROM membership_rewards WHERE id = ?', result.lastID);
    res.json({ success: true, reward: newReward });

  } catch (error) {
    console.error('❌ Error creating membership reward:', error);
    res.status(500).json({ error: 'Failed to create membership reward' });
  }
});

// Customer Analytics
app.get('/api/customers/:id/analytics', authenticateToken, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    const db = await getDB();

    // Get customer basic info
    const customer = await db.get('SELECT * FROM customers WHERE id = ?', customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get all session history for this customer
    const allSessions = await db.all(`
      SELECT s.*, t.type as table_type, t.hourly_rate
      FROM sessions s
      JOIN tables t ON s.table_id = t.id
      WHERE s.customer_phone = ?
      ORDER BY s.start_time DESC
    `, customer.phone);

    // Calculate basic analytics
    const totalSessions = allSessions.length;
    const totalSpent = allSessions.reduce((sum, s) => sum + (s.amount || 0), 0);
    const avgSessionDuration = totalSessions > 0 ?
      allSessions.reduce((sum, s) => sum + (s.billed_minutes || 0), 0) / totalSessions : 0;

    // Calculate spending by month (last 12 months)
    const monthlySpending = {};
    const currentDate = new Date();
    for (let i = 11; i >= 0; i--) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
      const monthKey = date.toISOString().slice(0, 7); // YYYY-MM format
      monthlySpending[monthKey] = 0;
    }

    allSessions.forEach(session => {
      if (session.start_time && session.amount) {
        const sessionDate = new Date(session.start_time);
        const monthKey = sessionDate.toISOString().slice(0, 7);
        if (monthlySpending.hasOwnProperty(monthKey)) {
          monthlySpending[monthKey] += session.amount;
        }
      }
    });

    // Calculate table usage statistics
    const tableUsage = {};
    allSessions.forEach(session => {
      const tableType = session.table_type;
      if (!tableUsage[tableType]) {
        tableUsage[tableType] = {
          sessions: 0,
          total_spent: 0,
          total_duration: 0
        };
      }
      tableUsage[tableType].sessions += 1;
      tableUsage[tableType].total_spent += session.amount || 0;
      tableUsage[tableType].total_duration += session.billed_minutes || 0;
    });

    // Generate streak calendar data (last 365 days)
    const streakData = {};
    const oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);

    // Initialize all days with 0
    for (let i = 0; i < 365; i++) {
      const date = new Date(Date.now() - (i * 24 * 60 * 60 * 1000));
      const dateKey = date.toISOString().slice(0, 10);
      streakData[dateKey] = 0;
    }

    // Mark days with sessions
    allSessions.forEach(session => {
      if (session.start_time && session.start_time > oneYearAgo) {
        const sessionDate = new Date(session.start_time);
        const dateKey = sessionDate.toISOString().slice(0, 10);
        if (streakData.hasOwnProperty(dateKey)) {
          streakData[dateKey] += 1; // Count sessions per day
        }
      }
    });

    // Calculate current streak
    let currentStreak = 0;
    let maxStreak = 0;
    let tempStreak = 0;

    const sortedDates = Object.keys(streakData).sort();
    for (const date of sortedDates) {
      if (streakData[date] > 0) {
        tempStreak++;
        maxStreak = Math.max(maxStreak, tempStreak);
      } else {
        tempStreak = 0;
      }
    }

    // Current streak (from today backwards)
    for (let i = 0; i < sortedDates.length; i++) {
      const date = sortedDates[sortedDates.length - 1 - i];
      if (streakData[date] > 0) {
        currentStreak++;
      } else {
        break;
      }
    }

    // Get recent sessions (last 10)
    const recentSessions = allSessions.slice(0, 10);

    // Get loyalty transactions
    const loyaltyTransactions = await db.all(`
      SELECT * FROM loyalty_transactions
      WHERE customer_id = ?
      ORDER BY created_at DESC LIMIT 10
    `, customerId);

    // Calculate additional metrics
    const paidSessions = allSessions.filter(s => !s.is_friendly).length;
    const friendlySessions = totalSessions - paidSessions;
    const avgSpendingPerSession = totalSessions > 0 ? totalSpent / totalSessions : 0;

    // Peak hours analysis
    const hourlyStats = {};
    for (let i = 0; i < 24; i++) {
      hourlyStats[i] = 0;
    }

    allSessions.forEach(session => {
      if (session.start_time) {
        const hour = new Date(session.start_time).getHours();
        hourlyStats[hour]++;
      }
    });

    res.json({
      customer,
      analytics: {
        total_sessions: totalSessions,
        paid_sessions: paidSessions,
        friendly_sessions: friendlySessions,
        total_spent: totalSpent,
        avg_session_duration: Math.round(avgSessionDuration),
        avg_spending_per_session: Math.round(avgSpendingPerSession),
        loyalty_points: customer.loyalty_points,
        membership_type: customer.membership_type,
        current_streak: currentStreak,
        max_streak: maxStreak,
        monthly_spending: monthlySpending,
        table_usage: tableUsage,
        hourly_stats: hourlyStats
      },
      streak_data: streakData,
      recent_sessions: recentSessions,
      loyalty_transactions: loyaltyTransactions
    });

  } catch (error) {
    console.error('❌ Error fetching customer analytics:', error);
    res.status(500).json({ error: 'Failed to fetch customer analytics' });
  }
});

// CSV Export
app.get('/api/reports/daily.csv', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const startTime = new Date(date + 'T00:00:00Z').getTime();
    const endTime = startTime + 24 * 60 * 60 * 1000;

    const db = await getDB();
    const sessions = await db.all(`
      SELECT s.*, t.type as table_type
      FROM sessions s
      JOIN tables t ON s.table_id = t.id
      WHERE s.start_time >= ? AND s.start_time < ?
      ORDER BY s.table_id, s.start_time
    `, startTime, endTime);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="daily-report-${date}.csv"`);

    // CSV Header
    const headers = [
      'Session ID', 'Table', 'Table Type', 'Customer Name', 'Customer Phone',
      'Start Time', 'End Time', 'Duration (min)', 'Amount', 'Payment Method',
      'Friendly Game', 'Discount %', 'Break Count', 'Notes'
    ].join(',');

    res.write(headers + '\n');

    // CSV Data
    for (const session of sessions) {
      const row = [
        session.id,
        session.table_id,
        session.table_type,
        session.customer_name || '',
        session.customer_phone || '',
        new Date(session.start_time).toLocaleString(),
        session.end_time ? new Date(session.end_time).toLocaleString() : 'Active',
        session.billed_minutes || 0,
        session.amount || 0,
        session.payment_method || 'CASH',
        session.is_friendly ? 'Yes' : 'No',
        session.discount_percent || 0,
        session.break_count || 0,
        (session.notes || '').replace(/,/g, ';')
      ].join(',');

      res.write(row + '\n');
    }

    res.end();

  } catch (error) {
    console.error('❌ Error generating CSV report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ===== INVENTORY MANAGEMENT ENDPOINTS =====

// Equipment Inventory
app.get('/api/inventory/equipment', authenticateToken, async (req, res) => {
  try {
    const { category, low_stock } = req.query;
    const db = await getDB();

    let query = 'SELECT e.*, v.name as supplier_name FROM equipment_inventory e LEFT JOIN vendors v ON e.supplier_id = v.id';
    let params = [];
    let conditions = [];

    if (category) {
      conditions.push('e.category = ?');
      params.push(category);
    }

    if (low_stock === 'true') {
      conditions.push('e.available_quantity <= e.reorder_level');
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY e.category, e.name';

    const equipment = await db.all(query, ...params);
    res.json(equipment);

  } catch (error) {
    console.error('❌ Error fetching equipment inventory:', error);
    res.status(500).json({ error: 'Failed to fetch equipment inventory' });
  }
});

app.post('/api/inventory/equipment', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      name, category, description, total_quantity, unit_cost,
      reorder_level, supplier_id, location, condition_status
    } = req.body;

    const db = await getDB();
    const result = await db.run(`
      INSERT INTO equipment_inventory (
        name, category, description, total_quantity, available_quantity,
        unit_cost, reorder_level, supplier_id, location, condition_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, name, category, description || '', total_quantity, total_quantity,
       unit_cost, reorder_level || 5, supplier_id, location || 'Main Storage',
       condition_status || 'GOOD');

    const newEquipment = await db.get('SELECT * FROM equipment_inventory WHERE id = ?', result.lastID);
    res.json({ success: true, equipment: newEquipment });

  } catch (error) {
    console.error('❌ Error creating equipment:', error);
    res.status(500).json({ error: 'Failed to create equipment' });
  }
});

app.patch('/api/inventory/equipment/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.id);
    const updates = req.body;

    const db = await getDB();
    const allowedFields = [
      'name', 'category', 'description', 'total_quantity', 'available_quantity',
      'damaged_quantity', 'maintenance_quantity', 'unit_cost', 'reorder_level',
      'supplier_id', 'location', 'condition_status', 'last_inventory_check'
    ];

    const setClause = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => `${field} = ?`).join(', ');

    if (!setClause) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const values = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => updates[field]);
    values.push(equipmentId);

    await db.run(`UPDATE equipment_inventory SET ${setClause} WHERE id = ?`, ...values);

    const updatedEquipment = await db.get('SELECT * FROM equipment_inventory WHERE id = ?', equipmentId);
    res.json({ success: true, equipment: updatedEquipment });

  } catch (error) {
    console.error('❌ Error updating equipment:', error);
    res.status(500).json({ error: 'Failed to update equipment' });
  }
});

app.delete('/api/inventory/equipment/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.id);
    const db = await getDB();

    await db.run('DELETE FROM equipment_inventory WHERE id = ?', equipmentId);
    res.json({ success: true, message: 'Equipment deleted successfully' });

  } catch (error) {
    console.error('❌ Error deleting equipment:', error);
    res.status(500).json({ error: 'Failed to delete equipment' });
  }
});

// Consumables Inventory
app.get('/api/inventory/consumables', authenticateToken, async (req, res) => {
  try {
    const { category, low_stock, expiring_soon } = req.query;
    const db = await getDB();

    let query = 'SELECT c.*, v.name as supplier_name FROM consumables_inventory c LEFT JOIN vendors v ON c.supplier_id = v.id';
    let params = [];
    let conditions = [];

    if (category) {
      conditions.push('c.category = ?');
      params.push(category);
    }

    if (low_stock === 'true') {
      conditions.push('c.current_stock <= c.reorder_level');
    }

    if (expiring_soon === 'true') {
      const thirtyDaysFromNow = Date.now() + (30 * 24 * 60 * 60 * 1000);
      conditions.push('c.expiry_date IS NOT NULL AND c.expiry_date <= ?');
      params.push(thirtyDaysFromNow);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY c.category, c.name';

    const consumables = await db.all(query, ...params);
    res.json(consumables);

  } catch (error) {
    console.error('❌ Error fetching consumables inventory:', error);
    res.status(500).json({ error: 'Failed to fetch consumables inventory' });
  }
});

app.post('/api/inventory/consumables', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      name, category, description, current_stock, unit_cost,
      reorder_level, supplier_id, expiry_date, storage_location
    } = req.body;

    const db = await getDB();
    const result = await db.run(`
      INSERT INTO consumables_inventory (
        name, category, description, current_stock, unit_cost,
        reorder_level, supplier_id, expiry_date, storage_location
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, name, category, description || '', current_stock, unit_cost,
       reorder_level || 10, supplier_id, expiry_date, storage_location || 'Pantry');

    const newConsumable = await db.get('SELECT * FROM consumables_inventory WHERE id = ?', result.lastID);
    res.json({ success: true, consumable: newConsumable });

  } catch (error) {
    console.error('❌ Error creating consumable:', error);
    res.status(500).json({ error: 'Failed to create consumable' });
  }
});

// Vendors
app.get('/api/vendors', authenticateToken, async (req, res) => {
  try {
    const { active } = req.query;
    const db = await getDB();

    let query = 'SELECT * FROM vendors';
    let params = [];

    if (active === 'true') {
      query += ' WHERE is_active = 1';
    }

    query += ' ORDER BY name';

    const vendors = await db.all(query, ...params);
    res.json(vendors);

  } catch (error) {
    console.error('❌ Error fetching vendors:', error);
    res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

app.post('/api/vendors', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, contact_person, phone, email, address, payment_terms, rating } = req.body;

    const db = await getDB();
    const result = await db.run(`
      INSERT INTO vendors (name, contact_person, phone, email, address, payment_terms, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, name, contact_person, email, phone, address, payment_terms || 'Net 30', rating || 5);

    const newVendor = await db.get('SELECT * FROM vendors WHERE id = ?', result.lastID);
    res.json({ success: true, vendor: newVendor });

  } catch (error) {
    console.error('❌ Error creating vendor:', error);
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});

// Inventory Transactions
app.get('/api/inventory/transactions', authenticateToken, async (req, res) => {
  try {
    const { item_type, item_id, limit = 50, offset = 0 } = req.query;
    const db = await getDB();

    let query = 'SELECT t.*, u.full_name as performed_by_name FROM inventory_transactions t LEFT JOIN users u ON t.performed_by = u.id';
    let params = [];
    let conditions = [];

    if (item_type) {
      conditions.push('t.item_type = ?');
      params.push(item_type);
    }

    if (item_id) {
      conditions.push('t.item_id = ?');
      params.push(parseInt(item_id));
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const transactions = await db.all(query, ...params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM inventory_transactions t';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countResult = await db.get(countQuery, ...params.slice(0, -2));

    res.json({
      transactions,
      total: countResult.total,
      limit: parseInt(limit),
      offset: parseInt(offset),
      has_more: countResult.total > parseInt(offset) + parseInt(limit)
    });

  } catch (error) {
    console.error('❌ Error fetching inventory transactions:', error);
    res.status(500).json({ error: 'Failed to fetch inventory transactions' });
  }
});

app.post('/api/inventory/transactions', authenticateToken, async (req, res) => {
  try {
    const {
      item_type, item_id, transaction_type, quantity,
      reference_id, reference_type, notes
    } = req.body;

    const db = await getDB();

    // Get current stock
    let currentStock;
    if (item_type === 'EQUIPMENT') {
      const item = await db.get('SELECT available_quantity FROM equipment_inventory WHERE id = ?', item_id);
      currentStock = item ? item.available_quantity : 0;
    } else {
      const item = await db.get('SELECT current_stock FROM consumables_inventory WHERE id = ?', item_id);
      currentStock = item ? item.current_stock : 0;
    }

    // Calculate new stock
    let newStock = currentStock;
    if (transaction_type === 'PURCHASE' || transaction_type === 'ADJUSTMENT') {
      newStock += quantity;
    } else {
      newStock -= quantity;
    }

    // Record transaction
    const result = await db.run(`
      INSERT INTO inventory_transactions (
        item_type, item_id, transaction_type, quantity,
        previous_stock, new_stock, reference_id, reference_type,
        notes, performed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, item_type, item_id, transaction_type, quantity,
       currentStock, newStock, reference_id, reference_type,
       notes, req.user.id);

    // Update inventory
    if (item_type === 'EQUIPMENT') {
      await db.run('UPDATE equipment_inventory SET available_quantity = ? WHERE id = ?',
                   newStock, item_id);
    } else {
      await db.run('UPDATE consumables_inventory SET current_stock = ? WHERE id = ?',
                   newStock, item_id);
    }

    const transaction = await db.get('SELECT * FROM inventory_transactions WHERE id = ?', result.lastID);
    res.json({ success: true, transaction });

  } catch (error) {
    console.error('❌ Error creating inventory transaction:', error);
    res.status(500).json({ error: 'Failed to create inventory transaction' });
  }
});

// ===== STAFF MANAGEMENT ENDPOINTS =====

// Staff Profiles
app.get('/api/staff', authenticateToken, async (req, res) => {
  try {
    const { active } = req.query;
    const db = await getDB();

    let query = `
      SELECT sp.*, u.username, u.email, u.role, u.last_login
      FROM staff_profiles sp
      JOIN users u ON sp.user_id = u.id
    `;
    let params = [];
    let conditions = [];

    if (active === 'true') {
      conditions.push('sp.is_active = 1');
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY sp.full_name';

    const staff = await db.all(query, ...params);
    res.json(staff);

  } catch (error) {
    console.error('❌ Error fetching staff:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

app.post('/api/staff', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      username, password, full_name, email, role,
      employee_id, phone, emergency_contact, address,
      date_of_birth, hire_date, department, position,
      hourly_rate, monthly_salary, employment_type, manager_id
    } = req.body;

    const db = await getDB();

    // Hash password
    const bcrypt = await import('bcrypt');
    const password_hash = await bcrypt.hash(password, 10);

    // Create user account
    const userResult = await db.run(`
      INSERT INTO users (username, password_hash, role, full_name, email)
      VALUES (?, ?, ?, ?, ?)
    `, username, password_hash, role || 'employee', full_name, email);

    // Create staff profile
    await db.run(`
      INSERT INTO staff_profiles (
        user_id, employee_id, full_name, phone, emergency_contact, address,
        date_of_birth, hire_date, department, position, hourly_rate,
        monthly_salary, employment_type, manager_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, userResult.lastID, employee_id, full_name, phone, emergency_contact, address,
       date_of_birth, hire_date, department || 'Operations', position,
       hourly_rate || 0, monthly_salary || 0, employment_type || 'Full-time', manager_id);

    const staff = await db.get(`
      SELECT sp.*, u.username, u.email, u.role
      FROM staff_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ?
    `, userResult.lastID);

    res.json({ success: true, staff });

  } catch (error) {
    console.error('❌ Error creating staff member:', error);
    res.status(500).json({ error: 'Failed to create staff member' });
  }
});

app.patch('/api/staff/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const updates = req.body;

    const db = await getDB();

    // Update user table fields
    const userFields = ['username', 'email', 'role', 'is_active'];
    const userUpdates = {};
    for (const field of userFields) {
      if (updates[field] !== undefined) {
        userUpdates[field] = updates[field];
      }
    }

    if (Object.keys(userUpdates).length > 0) {
      const setClause = Object.keys(userUpdates).map(key => `${key} = ?`).join(', ');
      const values = Object.values(userUpdates);
      values.push(userId);
      await db.run(`UPDATE users SET ${setClause} WHERE id = ?`, ...values);
    }

    // Update staff profile fields
    const profileFields = [
      'employee_id', 'full_name', 'phone', 'emergency_contact', 'address',
      'date_of_birth', 'hire_date', 'department', 'position', 'hourly_rate',
      'monthly_salary', 'employment_type', 'manager_id', 'is_active'
    ];
    const profileUpdates = {};
    for (const field of profileFields) {
      if (updates[field] !== undefined) {
        profileUpdates[field] = updates[field];
      }
    }

    if (Object.keys(profileUpdates).length > 0) {
      const setClause = Object.keys(profileUpdates).map(key => `${key} = ?`).join(', ');
      const values = Object.values(profileUpdates);
      values.push(userId);
      await db.run(`UPDATE staff_profiles SET ${setClause} WHERE user_id = ?`, ...values);
    }

    const staff = await db.get(`
      SELECT sp.*, u.username, u.email, u.role, u.is_active
      FROM staff_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ?
    `, userId);

    res.json({ success: true, staff });

  } catch (error) {
    console.error('❌ Error updating staff member:', error);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

// Staff Shifts
app.get('/api/staff/shifts', authenticateToken, async (req, res) => {
  try {
    const { user_id, date, week } = req.query;
    const db = await getDB();

    let query = `
      SELECT ss.*, u.full_name as staff_name, creator.full_name as created_by_name
      FROM staff_shifts ss
      JOIN users u ON ss.user_id = u.id
      LEFT JOIN users creator ON ss.created_by = creator.id
    `;
    let params = [];
    let conditions = [];

    if (user_id) {
      conditions.push('ss.user_id = ?');
      params.push(parseInt(user_id));
    }

    if (date) {
      const startTime = new Date(date + 'T00:00:00Z').getTime();
      const endTime = startTime + 24 * 60 * 60 * 1000;
      conditions.push('ss.shift_date >= ? AND ss.shift_date < ?');
      params.push(startTime, endTime);
    }

    if (week) {
      // Calculate week start and end
      const weekStart = new Date(week);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      conditions.push('ss.shift_date >= ? AND ss.shift_date <= ?');
      params.push(weekStart.getTime(), weekEnd.getTime());
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY ss.shift_date, ss.start_time';

    const shifts = await db.all(query, ...params);
    res.json(shifts);

  } catch (error) {
    console.error('❌ Error fetching staff shifts:', error);
    res.status(500).json({ error: 'Failed to fetch staff shifts' });
  }
});

app.post('/api/staff/shifts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      user_id, shift_date, start_time, end_time,
      break_duration, shift_type, notes
    } = req.body;

    const db = await getDB();
    const result = await db.run(`
      INSERT INTO staff_shifts (
        user_id, shift_date, start_time, end_time,
        break_duration, shift_type, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, user_id, shift_date, start_time, end_time,
       break_duration || 30, shift_type || 'Regular', notes, req.user.id);

    const shift = await db.get(`
      SELECT ss.*, u.full_name as staff_name
      FROM staff_shifts ss
      JOIN users u ON ss.user_id = u.id
      WHERE ss.id = ?
    `, result.lastID);

    res.json({ success: true, shift });

  } catch (error) {
    console.error('❌ Error creating staff shift:', error);
    res.status(500).json({ error: 'Failed to create staff shift' });
  }
});

// Attendance
app.get('/api/staff/attendance', authenticateToken, async (req, res) => {
  try {
    const { user_id, date, month } = req.query;
    const db = await getDB();

    let query = `
      SELECT ar.*, u.full_name as staff_name, approver.full_name as approved_by_name
      FROM attendance_records ar
      JOIN users u ON ar.user_id = u.id
      LEFT JOIN users approver ON ar.approved_by = approver.id
    `;
    let params = [];
    let conditions = [];

    if (user_id) {
      conditions.push('ar.user_id = ?');
      params.push(parseInt(user_id));
    }

    if (date) {
      conditions.push('ar.date = ?');
      params.push(new Date(date + 'T00:00:00Z').getTime());
    }

    if (month) {
      const monthStart = new Date(month + '-01T00:00:00Z');
      const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
      conditions.push('ar.date >= ? AND ar.date <= ?');
      params.push(monthStart.getTime(), monthEnd.getTime());
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY ar.date DESC, u.full_name';

    const attendance = await db.all(query, ...params);
    res.json(attendance);

  } catch (error) {
    console.error('❌ Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

app.post('/api/staff/attendance/checkin', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    const db = await getDB();

    // Check if already checked in today
    const existing = await db.get(
      'SELECT * FROM attendance_records WHERE user_id = ? AND date = ?',
      user_id || req.user.id, todayTimestamp
    );

    if (existing && existing.check_in_time) {
      return res.status(400).json({ error: 'Already checked in today' });
    }

    if (existing) {
      // Update existing record
      await db.run(
        'UPDATE attendance_records SET check_in_time = ? WHERE id = ?',
        Date.now(), existing.id
      );
    } else {
      // Create new record
      await db.run(`
        INSERT INTO attendance_records (user_id, date, check_in_time, status)
        VALUES (?, ?, ?, 'Present')
      `, user_id || req.user.id, todayTimestamp, Date.now());
    }

    const record = await db.get(`
      SELECT ar.*, u.full_name
      FROM attendance_records ar
      JOIN users u ON ar.user_id = u.id
      WHERE ar.user_id = ? AND ar.date = ?
    `, user_id || req.user.id, todayTimestamp);

    res.json({ success: true, record });

  } catch (error) {
    console.error('❌ Error checking in:', error);
    res.status(500).json({ error: 'Failed to check in' });
  }
});

app.post('/api/staff/attendance/checkout', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    const db = await getDB();

    const record = await db.get(
      'SELECT * FROM attendance_records WHERE user_id = ? AND date = ?',
      user_id || req.user.id, todayTimestamp
    );

    if (!record || !record.check_in_time) {
      return res.status(400).json({ error: 'Not checked in today' });
    }

    if (record.check_out_time) {
      return res.status(400).json({ error: 'Already checked out today' });
    }

    const checkOutTime = Date.now();
    const totalHours = (checkOutTime - record.check_in_time) / (1000 * 60 * 60);

    await db.run(`
      UPDATE attendance_records
      SET check_out_time = ?, total_hours = ?
      WHERE id = ?
    `, checkOutTime, totalHours, record.id);

    const updatedRecord = await db.get(`
      SELECT ar.*, u.full_name
      FROM attendance_records ar
      JOIN users u ON ar.user_id = u.id
      WHERE ar.id = ?
    `, record.id);

    res.json({ success: true, record: updatedRecord });

  } catch (error) {
    console.error('❌ Error checking out:', error);
    res.status(500).json({ error: 'Failed to check out' });
  }
});

// Leave Requests
app.get('/api/staff/leave', authenticateToken, async (req, res) => {
  try {
    const { user_id, status } = req.query;
    const db = await getDB();

    let query = `
      SELECT lr.*, u.full_name as staff_name, approver.full_name as approved_by_name
      FROM leave_requests lr
      JOIN users u ON lr.user_id = u.id
      LEFT JOIN users approver ON lr.approved_by = approver.id
    `;
    let params = [];
    let conditions = [];

    if (user_id) {
      conditions.push('lr.user_id = ?');
      params.push(parseInt(user_id));
    }

    if (status) {
      conditions.push('lr.status = ?');
      params.push(status);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY lr.created_at DESC';

    const leaveRequests = await db.all(query, ...params);
    res.json(leaveRequests);

  } catch (error) {
    console.error('❌ Error fetching leave requests:', error);
    res.status(500).json({ error: 'Failed to fetch leave requests' });
  }
});

app.post('/api/staff/leave', authenticateToken, async (req, res) => {
  try {
    const {
      leave_type, start_date, end_date, total_days, reason
    } = req.body;

    const db = await getDB();

    // Calculate total days if not provided
    let calculatedDays = total_days;
    if (!calculatedDays) {
      const start = new Date(start_date);
      const end = new Date(end_date);
      calculatedDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    }

    const result = await db.run(`
      INSERT INTO leave_requests (
        user_id, leave_type, start_date, end_date, total_days, reason
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, req.user.id, leave_type, start_date, end_date, calculatedDays, reason);

    const leaveRequest = await db.get(`
      SELECT lr.*, u.full_name as staff_name
      FROM leave_requests lr
      JOIN users u ON lr.user_id = u.id
      WHERE lr.id = ?
    `, result.lastID);

    res.json({ success: true, leaveRequest });

  } catch (error) {
    console.error('❌ Error creating leave request:', error);
    res.status(500).json({ error: 'Failed to create leave request' });
  }
});

app.patch('/api/staff/leave/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const leaveId = parseInt(req.params.id);
    const { status, rejection_reason } = req.body;

    const db = await getDB();
    await db.run(`
      UPDATE leave_requests
      SET status = ?, approved_by = ?, approved_at = ?, rejection_reason = ?
      WHERE id = ?
    `, status, req.user.id, Date.now(), rejection_reason || null, leaveId);

    const leaveRequest = await db.get(`
      SELECT lr.*, u.full_name as staff_name, approver.full_name as approved_by_name
      FROM leave_requests lr
      JOIN users u ON lr.user_id = u.id
      LEFT JOIN users approver ON lr.approved_by = approver.id
      WHERE lr.id = ?
    `, leaveId);

    res.json({ success: true, leaveRequest });

  } catch (error) {
    console.error('❌ Error approving leave request:', error);
    res.status(500).json({ error: 'Failed to approve leave request' });
  }
});

// Admin routes
app.patch('/api/session/:id', requireAdmin, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const allowedFields = [
      'end_time', 'duration_ms', 'billed_minutes', 'amount', 'is_friendly',
      'customer_name', 'customer_phone', 'notes', 'payment_method', 
      'payment_status', 'discount_percent'
    ];
    
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    const db = await getDB();
    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(sessionId);
    
    await db.run(`UPDATE sessions SET ${setClause} WHERE id = ?`, ...values);
    
    const updatedSession = await db.get('SELECT * FROM sessions WHERE id = ?', sessionId);
    broadcast('session:update', updatedSession);
    
    res.json(updatedSession);
    
  } catch (error) {
    console.error('❌ Error updating session:', error);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

app.post('/api/admin/backup', requireAdmin, async (req, res) => {
  try {
    const backupPath = await backupDatabase();
    res.json({ 
      success: true, 
      message: 'Database backup created', 
      path: backupPath 
    });
  } catch (error) {
    console.error('❌ Backup failed:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// Hardware integration endpoints
app.post('/api/lights/:id/toggle', authenticateToken, async (req, res) => {
  try {
    const tableId = parseInt(req.params.id);
    const { on } = req.body;
    
    const db = await getDB();
    const table = await db.get('SELECT * FROM tables WHERE id = ?', tableId);
    
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }
    
    // Update light status
    await db.run('UPDATE tables SET light_on = ? WHERE id = ?', on ? 1 : 0, tableId);
    
    // Auto session management based on light control
    if (on && table.status !== 'OCCUPIED') {
      // Auto-start session when light turns on
      const startTime = now();
      const sessionResult = await db.run(`
        INSERT INTO sessions (table_id, start_time, is_friendly, last_resume_time) 
        VALUES (?, ?, 0, ?)
      `, tableId, startTime, startTime);
      
      await db.run('UPDATE tables SET status = "OCCUPIED" WHERE id = ?', tableId);
      
      broadcast('session:auto_start', {
        table_id: tableId,
        session_id: sessionResult.lastID
      });
    }
    
    if (!on && table.status === 'OCCUPIED') {
      // Auto-stop session when light turns off
      const session = await db.get(`
        SELECT * FROM sessions
        WHERE table_id = ? AND end_time IS NULL
        ORDER BY id DESC LIMIT 1
      `, tableId);
      
      if (session) {
        const endTime = now();
        const additionalMs = session.last_resume_time ? (endTime - session.last_resume_time) : 0;
        const totalMs = (session.duration_ms || 0) + additionalMs;
        const minutes = Math.max(0, ceilToMinute(totalMs));
        const amount = calculateBillAmount(table, minutes, { isFriendly: session.is_friendly });
        
        await db.run(`
          UPDATE sessions SET
            end_time = ?, duration_ms = ?, billed_minutes = ?, amount = ?
          WHERE id = ?
        `, endTime, totalMs, minutes, amount, session.id);
        
        await db.run('UPDATE tables SET status = "AVAILABLE" WHERE id = ?', tableId);
        
        // Update daily summary
        const today = new Date().toISOString().slice(0, 10);
        const summary = await db.get('SELECT * FROM daily_summaries WHERE date = ?', today);
        
        if (!summary) {
          await db.run(`
            INSERT INTO daily_summaries (date, total_earnings, total_sessions, friendly_games)
            VALUES (?, ?, 1, ?)
          `, today, amount, session.is_friendly ? 1 : 0);
        } else {
          await db.run(`
            UPDATE daily_summaries SET
              total_earnings = total_earnings + ?,
              total_sessions = total_sessions + 1,
              friendly_games = friendly_games + ?
            WHERE date = ?
          `, amount, session.is_friendly ? 1 : 0, today);
        }
        
        broadcast('session:auto_stop', { table_id: tableId, session_id: session.id });
      }
    }
    
    // Hardware control
    await controlTableLight(tableId, on);
    
    const updatedTable = await db.get('SELECT * FROM tables WHERE id = ?', tableId);
    broadcast('table:update', updatedTable);
    
    res.json(updatedTable);
    
  } catch (error) {
    console.error('❌ Error toggling light:', error);
    res.status(500).json({ error: 'Failed to toggle light' });
  }
});

// ===== INDIVIDUAL CRUD ENDPOINTS =====

// Staff individual endpoints
app.get('/api/staff/:id', authenticateToken, async (req, res) => {
  try {
    const staffId = parseInt(req.params.id);
    const db = await getDB();

    const staff = await db.get(`
      SELECT u.id as user_id, u.username, u.full_name, u.email, u.role, u.created_at, u.updated_at,
             s.employee_id, s.phone, s.department, s.position, s.hire_date, s.hourly_rate, s.monthly_salary, s.employment_type
      FROM users u
      LEFT JOIN staff_profiles s ON u.id = s.user_id
      WHERE u.id = ? AND u.role IN ('employee', 'admin')
    `, staffId);

    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json(staff);
  } catch (error) {
    console.error('❌ Failed to get staff member:', error);
    res.status(500).json({ error: 'Failed to get staff member' });
  }
});

app.patch('/api/staff/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.id);
    const updates = req.body;
    const db = await getDB();

    // Update users table
    const userFields = ['username', 'full_name', 'email', 'phone', 'role'];
    const userUpdates = {};
    for (const field of userFields) {
      if (updates[field] !== undefined) {
        userUpdates[field] = updates[field];
      }
    }

    if (Object.keys(userUpdates).length > 0) {
      const userSetClause = Object.keys(userUpdates).map(key => `${key} = ?`).join(', ');
      const userValues = Object.values(userUpdates);
      userValues.push(staffId);

      await db.run(`UPDATE users SET ${userSetClause} WHERE id = ?`, ...userValues);
    }

    // Update or insert staff_profiles table
    const staffFields = ['employee_id', 'department', 'position', 'hire_date', 'hourly_rate', 'monthly_salary', 'employment_type'];
    const staffUpdates = {};
    for (const field of staffFields) {
      if (updates[field] !== undefined) {
        staffUpdates[field] = updates[field];
      }
    }

    if (Object.keys(staffUpdates).length > 0) {
      const staffSetClause = Object.keys(staffUpdates).map(key => `${key} = ?`).join(', ');
      const staffValues = Object.values(staffUpdates);
      staffValues.push(staffId);
      await db.run(`
        INSERT OR REPLACE INTO staff_profiles (user_id, ${Object.keys(staffUpdates).join(', ')})
        VALUES (?, ${Object.keys(staffUpdates).map(() => '?').join(', ')})
      `, staffId, ...staffValues);
    }

    res.json({ success: true, message: 'Staff member updated successfully' });
  } catch (error) {
    console.error('❌ Failed to update staff member:', error);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

app.delete('/api/staff/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.id);
    const db = await getDB();

    // Check if staff member exists
    const staff = await db.get('SELECT * FROM users WHERE id = ? AND role IN (\'employee\', \'admin\')', staffId);
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    // Delete from staff_profiles first (due to foreign key)
    await db.run('DELETE FROM staff_profiles WHERE user_id = ?', staffId);

    // Delete from users table
    await db.run('DELETE FROM users WHERE id = ?', staffId);

    res.json({ success: true, message: 'Staff member deleted successfully' });
  } catch (error) {
    console.error('❌ Failed to delete staff member:', error);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

// Equipment individual endpoints
app.get('/api/inventory/equipment/:id', authenticateToken, async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.id);
    const db = await getDB();

    const equipment = await db.get(`
      SELECT e.*, v.name as supplier_name
      FROM equipment_inventory e
      LEFT JOIN vendors v ON e.supplier_id = v.id
      WHERE e.id = ?
    `, equipmentId);

    if (!equipment) {
      return res.status(404).json({ error: 'Equipment not found' });
    }

    res.json(equipment);
  } catch (error) {
    console.error('❌ Failed to get equipment:', error);
    res.status(500).json({ error: 'Failed to get equipment' });
  }
});

app.patch('/api/inventory/equipment/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.id);
    const updates = req.body;
    const db = await getDB();

    const allowedFields = [
      'name', 'category', 'description', 'total_quantity', 'available_quantity',
      'damaged_quantity', 'maintenance_quantity', 'unit_cost', 'reorder_level',
      'supplier_id', 'location', 'condition_status', 'last_inventory_check'
    ];

    const setClause = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => `${field} = ?`).join(', ');

    if (!setClause) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const values = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => updates[field]);
    values.push(equipmentId);

    await db.run(`UPDATE equipment_inventory SET ${setClause} WHERE id = ?`, ...values);

    const updatedEquipment = await db.get('SELECT * FROM equipment_inventory WHERE id = ?', equipmentId);
    res.json({ success: true, equipment: updatedEquipment });

  } catch (error) {
    console.error('❌ Failed to update equipment:', error);
    res.status(500).json({ error: 'Failed to update equipment' });
  }
});

app.delete('/api/inventory/equipment/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.id);
    const db = await getDB();

    await db.run('DELETE FROM equipment_inventory WHERE id = ?', equipmentId);
    res.json({ success: true, message: 'Equipment deleted successfully' });

  } catch (error) {
    console.error('❌ Failed to delete equipment:', error);
    res.status(500).json({ error: 'Failed to delete equipment' });
  }
});

// Consumable individual endpoints
app.get('/api/inventory/consumables/:id', authenticateToken, async (req, res) => {
  try {
    const consumableId = parseInt(req.params.id);
    const db = await getDB();

    const consumable = await db.get(`
      SELECT c.*, v.name as supplier_name
      FROM consumables_inventory c
      LEFT JOIN vendors v ON c.supplier_id = v.id
      WHERE c.id = ?
    `, consumableId);

    if (!consumable) {
      return res.status(404).json({ error: 'Consumable not found' });
    }

    res.json(consumable);
  } catch (error) {
    console.error('❌ Failed to get consumable:', error);
    res.status(500).json({ error: 'Failed to get consumable' });
  }
});

app.patch('/api/inventory/consumables/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const consumableId = parseInt(req.params.id);
    const updates = req.body;
    const db = await getDB();

    const allowedFields = ['name', 'category', 'description', 'current_stock', 'unit_cost', 'reorder_level', 'supplier_id', 'expiry_date', 'storage_location'];

    const setClause = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => `${field} = ?`).join(', ');

    if (!setClause) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const values = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => updates[field]);
    values.push(consumableId);

    await db.run(`UPDATE consumables_inventory SET ${setClause} WHERE id = ?`, ...values);

    const updatedConsumable = await db.get('SELECT * FROM consumables_inventory WHERE id = ?', consumableId);
    res.json({ success: true, consumable: updatedConsumable });

  } catch (error) {
    console.error('❌ Failed to update consumable:', error);
    res.status(500).json({ error: 'Failed to update consumable' });
  }
});

app.delete('/api/inventory/consumables/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const consumableId = parseInt(req.params.id);
    const db = await getDB();

    await db.run('DELETE FROM consumables_inventory WHERE id = ?', consumableId);
    res.json({ success: true, message: 'Consumable deleted successfully' });

  } catch (error) {
    console.error('❌ Failed to delete consumable:', error);
    res.status(500).json({ error: 'Failed to delete consumable' });
  }
});

// Vendor individual endpoints
app.get('/api/vendors/:id', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.id);
    const db = await getDB();

    const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', vendorId);

    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    res.json(vendor);
  } catch (error) {
    console.error('❌ Failed to get vendor:', error);
    res.status(500).json({ error: 'Failed to get vendor' });
  }
});

app.patch('/api/vendors/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.id);
    const updates = req.body;
    const db = await getDB();

    const allowedFields = ['name', 'contact_person', 'phone', 'email', 'address', 'payment_terms', 'rating', 'is_active'];

    const setClause = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => `${field} = ?`).join(', ');

    if (!setClause) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const values = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => updates[field]);
    values.push(vendorId);

    await db.run(`UPDATE vendors SET ${setClause} WHERE id = ?`, ...values);

    const updatedVendor = await db.get('SELECT * FROM vendors WHERE id = ?', vendorId);
    res.json({ success: true, vendor: updatedVendor });

  } catch (error) {
    console.error('❌ Failed to update vendor:', error);
    res.status(500).json({ error: 'Failed to update vendor' });
  }
});

app.delete('/api/vendors/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.id);
    const db = await getDB();

    await db.run('DELETE FROM vendors WHERE id = ?', vendorId);
    res.json({ success: true, message: 'Vendor deleted successfully' });

  } catch (error) {
    console.error('❌ Failed to delete vendor:', error);
    res.status(500).json({ error: 'Failed to delete vendor' });
  }
});

// Shift individual endpoints
app.get('/api/staff/shifts/:id', authenticateToken, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const db = await getDB();

    const shift = await db.get(`
      SELECT s.*, u.full_name as staff_name
      FROM staff_shifts s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ?
    `, shiftId);

    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    res.json(shift);
  } catch (error) {
    console.error('❌ Failed to get shift:', error);
    res.status(500).json({ error: 'Failed to get shift' });
  }
});

app.patch('/api/staff/shifts/:id', authenticateToken, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const updates = req.body;
    const db = await getDB();

    const allowedFields = ['user_id', 'shift_date', 'start_time', 'end_time', 'break_duration', 'shift_type', 'notes'];

    const setClause = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => `${field} = ?`).join(', ');

    if (!setClause) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const values = allowedFields.filter(field => updates[field] !== undefined)
      .map(field => updates[field]);
    values.push(shiftId);

    await db.run(`UPDATE staff_shifts SET ${setClause} WHERE id = ?`, ...values);

    const updatedShift = await db.get('SELECT * FROM staff_shifts WHERE id = ?', shiftId);
    res.json({ success: true, shift: updatedShift });

  } catch (error) {
    console.error('❌ Failed to update shift:', error);
    res.status(500).json({ error: 'Failed to update shift' });
  }
});

app.delete('/api/staff/shifts/:id', authenticateToken, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const db = await getDB();

    await db.run('DELETE FROM staff_shifts WHERE id = ?', shiftId);
    res.json({ success: true, message: 'Shift deleted successfully' });

  } catch (error) {
    console.error('❌ Failed to delete shift:', error);
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

// Static files - serve the web interface (no browser cache in development)
app.use('/', (req, res, next) => {
  if (/\.(html|js|css|webmanifest)$/i.test(req.path) || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}, express.static(path.join(__dirname, '../web')));

// Global error handler
app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  // Close all SSE connections
  for (const client of clients) {
    try {
      client.res.write('event: shutdown\ndata: {"message":"Server shutting down"}\n\n');
      client.res.end();
    } catch (error) {
      // Ignore errors when closing connections
    }
  }
  clients.clear();
  
  // Close database
  try {
    await closeDB();
    console.log('✅ Database connection closed');
  } catch (error) {
    console.error('❌ Error closing database:', error);
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeDB();
  process.exit(0);
});

// Start server — always migrate (safe/idempotent) so deploys stay in sync
async function startServer() {
  try {
    await migrate();
    
    const host = process.env.HOST || '0.0.0.0';
    const server = app.listen(PORT, host, () => {
      console.log('Black Racks Server v1.0.0');
      console.log(`Server running on http://${host}:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      scheduleDailyReset();
    });

    // Graceful shutdown handling
    server.on('close', async () => {
      await closeDB();
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

if (isMainModule) {
  startServer();
}

export { app };