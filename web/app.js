class AuthManager {
  constructor() {
    this.token = localStorage.getItem('auth_token');
    this.user = JSON.parse(localStorage.getItem('user_data') || '{}');
    this.sessionId = localStorage.getItem('session_id');
  }

  isAuthenticated() {
    return !!this.token;
  }

  getAuthHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  }

  async logout() {
    try {
      if (this.sessionId) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({ sessionId: this.sessionId })
        });
      }
    } catch (_) {
      /* ignore */
    } finally {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user_data');
      localStorage.removeItem('session_id');
      sessionStorage.removeItem('earnings_unlocked');
      window.location.href = '/login.html';
    }
  }

  handleAuthError() {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = '/login.html';
  }
}

function normalizePhoneLocalInput(localDigits) {
  if (!localDigits || !String(localDigits).trim()) {
    return { valid: true, phone: null };
  }
  const local = String(localDigits).replace(/\D/g, '');
  if (local.length !== 10) {
    return { valid: false, error: 'Enter exactly 10 digits' };
  }
  if (local.startsWith('0')) {
    return { valid: false, error: 'Phone number cannot start with 0' };
  }
  return { valid: true, phone: `+91${local}` };
}

function formatPhoneDisplay(phone) {
  if (!phone) return '-';
  const local = phone.replace(/\D/g, '').slice(-10);
  if (local.length !== 10) return phone;
  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
}

function phoneToLocalInput(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

class App {
  constructor() {
    this.auth = new AuthManager();
    this.tables = [];
    this.sessions = [];
    this.players = [];
    this.todaySummary = {};
    this.eventSource = null;
    this.sseReconnectTimer = null;
    this.timers = new Map();
    this.suggestionIndex = -1;
    this.suggestions = [];
    this.earningsUnlocked = sessionStorage.getItem('earnings_unlocked') === 'true';
    this.pendingPasswordAction = null;
    this.loadDataGeneration = 0;
    this.loadDataTimer = null;
    this.loadDataInFlight = null;
  }

  async init() {
    if (!this.auth.isAuthenticated()) {
      window.location.href = '/login.html';
      return;
    }

    document.getElementById('user-name').textContent = this.auth.user.full_name || this.auth.user.username || 'Admin';
    this.bindEvents();
    this.startClock();
    await this.loadData();
    this.connectSSE();
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
  }

  bindEvents() {
    document.getElementById('refresh-btn')?.addEventListener('click', () => this.showRefreshPasswordModal());
    document.getElementById('logout-btn')?.addEventListener('click', () => this.auth.logout());
    document.getElementById('confirm-stop')?.addEventListener('click', () => this.confirmStop());
    document.getElementById('start-session-form')?.addEventListener('submit', (e) => this.submitStart(e));
    document.getElementById('view-earnings-btn')?.addEventListener('click', () => this.showEarningsPasswordModal());
    document.getElementById('confirm-earnings-password')?.addEventListener('click', () => this.unlockEarnings());

    document.querySelectorAll('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('.modal')?.classList.remove('show'));
    });

    document.getElementById('user-menu-btn')?.addEventListener('click', () => {
      document.getElementById('user-dropdown')?.classList.toggle('show');
    });

    document.getElementById('export-csv-btn')?.addEventListener('click', () => this.showExportCsvModal());
    document.getElementById('confirm-export-csv')?.addEventListener('click', () => this.downloadSessionsExport());
    document.querySelectorAll('input[name="export-range"]').forEach((radio) => {
      radio.addEventListener('change', () => this.toggleExportDateInput());
    });

    document.getElementById('earnings-password')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.unlockEarnings();
    });

    this.setupAutocomplete();
  }

  startClock() {
    const tick = () => {
      const el = document.getElementById('live-clock');
      if (el) el.textContent = new Date().toLocaleTimeString();
    };
    tick();
    setInterval(tick, 1000);
  }

  showRefreshPasswordModal() {
    this.pendingPasswordAction = 'refresh';
    this.showPasswordModal('Admin Password Required', 'Enter your admin password to hard refresh the dashboard.');
  }

  showEarningsPasswordModal() {
    if (this.earningsUnlocked) {
      this.lockEarnings();
      return;
    }
    this.pendingPasswordAction = 'earnings';
    this.showPasswordModal('Admin Password Required', 'Enter your admin password to view today\'s earnings.');
  }

  showPasswordModal(title, hint) {
    const inputEl = document.getElementById('earnings-password');
    const errEl = document.getElementById('earnings-password-error');
    const titleEl = document.getElementById('password-modal-title');
    const hintEl = document.getElementById('password-modal-hint');

    if (titleEl) titleEl.textContent = title;
    if (hintEl) hintEl.textContent = hint;
    if (inputEl) inputEl.value = '';
    if (errEl) {
      errEl.textContent = '';
      errEl.style.display = 'none';
    }

    document.getElementById('password-modal').classList.add('show');
    inputEl?.focus();
  }

  async unlockEarnings() {
    const password = document.getElementById('earnings-password').value;
    const errEl = document.getElementById('earnings-password-error');
    errEl.style.display = 'none';

    const res = await fetch('/api/auth/verify-password', {
      method: 'POST',
      headers: this.auth.getAuthHeaders(),
      body: JSON.stringify({ password })
    });

    if (!res.ok) {
      const data = await res.json();
      errEl.textContent = data.error || 'Incorrect password';
      errEl.style.display = 'block';
      return;
    }

    document.getElementById('password-modal').classList.remove('show');

    if (this.pendingPasswordAction === 'refresh') {
      this.pendingPasswordAction = null;
      window.location.reload(true);
      return;
    }

    this.pendingPasswordAction = null;
    this.earningsUnlocked = true;
    sessionStorage.setItem('earnings_unlocked', 'true');
    this.updateStats();
    this.toast('Earnings unlocked', 'success');
  }

  lockEarnings() {
    this.earningsUnlocked = false;
    sessionStorage.removeItem('earnings_unlocked');
    this.updateStats();
    document.getElementById('view-earnings-btn').textContent = "View Today's Earnings";
  }

  todayDateString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  clearAllTimers() {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  scheduleLoadData(delay = 250) {
    clearTimeout(this.loadDataTimer);
    this.loadDataTimer = setTimeout(() => {
      this.loadDataTimer = null;
      this.loadData();
    }, delay);
  }

  patchTableFromApi(table, activeSession = null) {
    const idx = this.tables.findIndex((t) => t.id === table.id);
    if (idx === -1) return;
    const next = {
      ...this.tables[idx],
      ...table,
      active_session: activeSession !== undefined ? activeSession : this.tables[idx].active_session
    };
    if (next.status !== 'OCCUPIED') {
      next.active_session = null;
      next.running_amount = 0;
      next.running_data = null;
    }
    this.tables[idx] = next;
  }

  mergeTablesFromApi(incoming) {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    const incomingById = new Map(incoming.map((t) => [t.id, t]));

    if (!this.tables.length) {
      this.tables = incoming;
      return;
    }

    this.tables = this.tables.map((local) => {
      const remote = incomingById.get(local.id);
      if (!remote) return local;

      const localActive = local.status === 'OCCUPIED' && local.active_session;
      const remoteActive = remote.status === 'OCCUPIED' && remote.active_session;

      // Stale API (e.g. another Vercel instance) — keep a session we still know is running
      if (localActive && !remoteActive) {
        return {
          ...remote,
          status: 'OCCUPIED',
          active_session: local.active_session,
          running_amount: local.running_amount,
          running_data: local.running_data
        };
      }

      return {
        ...local,
        ...remote,
        active_session: remoteActive ? remote.active_session : null
      };
    });
  }

  async refreshAuxiliaryData() {
    const headers = this.auth.getAuthHeaders();
    const today = this.todayDateString();
    const [summaryRes, sessionsRes, playersRes] = await Promise.all([
      fetch('/api/summary/today', { headers }),
      fetch(`/api/sessions?date=${today}&limit=100`, { headers }),
      fetch('/api/players/today', { headers })
    ]);

    if ([summaryRes, sessionsRes, playersRes].some((r) => r.status === 401)) {
      this.auth.handleAuthError();
      return;
    }

    this.todaySummary = await summaryRes.json();
    const sessionsPayload = await sessionsRes.json();
    this.sessions = sessionsPayload.sessions || [];
    const playersPayload = await playersRes.json();
    this.players = playersPayload.players || [];

    this.renderSessions();
    this.renderPending();
    this.renderActiveSessions();
    this.updateStats();
  }

  upsertSessionRecord(session) {
    if (!session) return;
    const table = this.tables.find((t) => t.id === session.table_id);
    const enriched = {
      ...session,
      table_name: table ? this.getTableName(table) : `Table ${session.table_id}`
    };
    const idx = this.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) this.sessions[idx] = { ...this.sessions[idx], ...enriched };
    else this.sessions.unshift(enriched);
  }

  handleRealtimeEvent(event, e) {
    try {
      const data = JSON.parse(e.data);
      if (event === 'session:start' && data.table && data.session) {
        this.patchTableFromApi(data.table, data.session);
        this.renderTables();
        clearTimeout(this.loadDataTimer);
        this.refreshAuxiliaryData();
        return;
      }
      if (event === 'session:stop' && data.table) {
        this.patchTableFromApi(data.table, null);
        this.renderTables();
        if (data.session) this.upsertSessionRecord(data.session);
        clearTimeout(this.loadDataTimer);
        this.refreshAuxiliaryData();
        return;
      }
      if ((event === 'session:pause' || event === 'session:resume') && data.table_id) {
        clearTimeout(this.loadDataTimer);
        this.refreshTableById(data.table_id);
        return;
      }
      if (event === 'session:paid' && data.session) {
        this.upsertSessionRecord(data.session);
        this.renderSessions();
        this.renderPending();
        this.updateStats();
        return;
      }
      if (event === 'table:update' && data.id) {
        this.patchTableFromApi(data, data.status === 'OCCUPIED' ? data.active_session : null);
        this.renderTables();
        return;
      }
    } catch (_) {
      /* fall through */
    }
    this.scheduleLoadData();
  }

  async refreshTableById(tableId) {
    const headers = this.auth.getAuthHeaders();
    const res = await fetch('/api/tables', { headers });
    if (res.status === 401) return this.auth.handleAuthError();
    if (!res.ok) return;
    const incoming = await res.json();
    if (!Array.isArray(incoming)) return;
    this.mergeTablesFromApi(incoming);
    this.renderTables();
  }

  async loadData() {
    const generation = ++this.loadDataGeneration;

    if (this.loadDataInFlight) {
      try { await this.loadDataInFlight; } catch (_) { /* ignore */ }
      if (generation !== this.loadDataGeneration) return;
    }

    const request = (async () => {
      const headers = this.auth.getAuthHeaders();
      const today = this.todayDateString();
      const [tablesRes, summaryRes, sessionsRes, playersRes] = await Promise.all([
        fetch('/api/tables', { headers }),
        fetch('/api/summary/today', { headers }),
        fetch(`/api/sessions?date=${today}&limit=100`, { headers }),
        fetch('/api/players/today', { headers })
      ]);

      if ([tablesRes, summaryRes, sessionsRes, playersRes].some((r) => r.status === 401)) {
        this.auth.handleAuthError();
        return;
      }

      if (generation !== this.loadDataGeneration) return;

      const incomingTables = await tablesRes.json();
      if (!Array.isArray(incomingTables)) {
        this.tables = [];
      } else if (!this.tables.length) {
        this.tables = incomingTables;
      } else {
        this.mergeTablesFromApi(incomingTables);
      }

      this.todaySummary = await summaryRes.json();
      const sessionsPayload = await sessionsRes.json();
      this.sessions = sessionsPayload.sessions || [];
      const playersPayload = await playersRes.json();
      this.players = playersPayload.players || [];

      this.renderTables();
      this.renderSessions();
      this.renderPending();
      this.renderActiveSessions();
      this.updateStats();
    })();

    this.loadDataInFlight = request;
    try {
      await request;
    } catch (_) {
      if (generation === this.loadDataGeneration) {
        this.toast('Failed to load data', 'error');
      }
    } finally {
      if (this.loadDataInFlight === request) this.loadDataInFlight = null;
    }
  }

  connectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }

    const token = this.auth.token;
    this.eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);

    this.eventSource.addEventListener('connected', () => {
      this.setOnline(true);
      if (this.sseReconnectTimer) {
        clearTimeout(this.sseReconnectTimer);
        this.sseReconnectTimer = null;
      }
    });

    this.eventSource.onerror = () => {
      this.setOnline(false);
      this.scheduleSseReconnect();
    };

    ['session:start', 'session:stop', 'session:pause', 'session:resume', 'session:paid', 'table:update'].forEach((evt) => {
      this.eventSource.addEventListener(evt, (e) => this.handleRealtimeEvent(evt, e));
    });
  }

  setOnline(online) {
    const dot = document.querySelector('#connection-status .status-dot');
    const text = document.querySelector('#connection-status .status-text');
    if (dot) dot.classList.toggle('online', online);
    if (dot) dot.classList.toggle('offline', !online);
    if (text) text.textContent = online ? 'Connected' : 'Offline';
  }

  scheduleSseReconnect(delay = 2000) {
    if (this.sseReconnectTimer) return;
    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      this.connectSSE();
    }, delay);
  }

  updateStats() {
    const s = this.todaySummary;
    const earningsEl = document.getElementById('total-earnings');
    const breakdownEl = document.getElementById('earnings-breakdown');
    const viewBtn = document.getElementById('view-earnings-btn');

    if (this.earningsUnlocked) {
      earningsEl.textContent = `Rs.${(s.total_earnings || 0).toLocaleString('en-IN')}`;
      breakdownEl.textContent =
        `Table 1: Rs.${(s.english_earnings || 0).toLocaleString('en-IN')} | Table 2: Rs.${(s.french_earnings || 0).toLocaleString('en-IN')}`;
      earningsEl.classList.remove('masked');
      breakdownEl.classList.remove('masked');
      viewBtn.textContent = 'Hide Earnings';
    } else {
      earningsEl.textContent = '****';
      breakdownEl.textContent = '****';
      earningsEl.classList.add('masked');
      breakdownEl.classList.add('masked');
      viewBtn.textContent = "View Today's Earnings";
    }

    document.getElementById('session-count').textContent = String(s.total_sessions || 0);
    document.getElementById('player-count').textContent = String(this.players.length);
  }

  getTableName(table) {
    return table?.name || `Table ${table?.id || ''}`;
  }

  getRatePerMinute(table) {
    return table.hourly_rate / 60;
  }

  calculateBill(table, minutes, isFriendly = false) {
    if (isFriendly) return 0;
    const perMin = Math.round(minutes * this.getRatePerMinute(table));
    return Math.max(table.minimum_charge || 0, perMin);
  }

  renderTables() {
    const grid = document.getElementById('tables-grid');
    if (!grid) return;
    this.clearAllTimers();
    grid.innerHTML = '';
    for (const table of [...this.tables].sort((a, b) => a.id - b.id)) {
      grid.appendChild(this.createTableCard(table));
    }
  }

  createTableCard(table) {
    const card = document.createElement('div');
    const occupied = table.status === 'OCCUPIED';
    const isPaused = occupied && !!table.active_session && !table.active_session.last_resume_time;
    const stateClass = occupied ? (isPaused ? 'paused' : 'occupied') : table.status.toLowerCase();
    card.className = `table-card ${stateClass}`;
    card.dataset.tableId = String(table.id);
    const name = this.getTableName(table);
    const rate = this.getRatePerMinute(table);
    const min = table.minimum_charge || 0;

    const statusLabel = isPaused ? 'PAUSED' : table.status;
    const statusClass = isPaused ? 'paused' : table.status.toLowerCase();

    card.innerHTML = `
      <div class="table-header">
        <div class="table-number">${name}</div>
        <div class="status-badge ${statusClass}" data-testid="table-${table.id}-status">${statusLabel}</div>
      </div>
      <div class="table-info">
        <div class="rate-display">Rs.${rate}/min, minimum Rs.${min}</div>
        ${occupied ? `
          <div class="session-details ${isPaused ? 'is-paused' : ''}">
            ${isPaused ? `<div class="paused-banner" data-testid="paused-banner-${table.id}"><span class="paused-dot"></span> Session Paused</div>` : ''}
            <div class="session-timer ${isPaused ? 'is-paused' : ''}" data-table-id="${table.id}" data-testid="timer-${table.id}">00:00:00</div>
            <div class="running-amount">Rs.${(table.running_amount || 0).toLocaleString('en-IN')}</div>
            ${table.active_session?.customer_name ? `<div class="customer-info">${table.active_session.customer_name}</div>` : ''}
          </div>` : ''}
      </div>
      <div class="table-actions" data-testid="table-${table.id}-actions">${this.tableActions(table, isPaused)}</div>
    `;

    if (occupied && table.active_session) {
      this.startTimer(table.id, table.active_session);
    }
    return card;
  }

  tableActions(table, isPausedArg) {
    if (table.status === 'OCCUPIED') {
      const isPaused = typeof isPausedArg === 'boolean'
        ? isPausedArg
        : !!table.active_session && !table.active_session.last_resume_time;
      const toggle = isPaused
        ? `<button class="btn btn-success btn-sm action-btn" data-action="resume" data-testid="resume-btn-${table.id}" onclick="app.resumeSession(${table.id})"><span class="btn-label">▶ Resume</span></button>`
        : `<button class="btn btn-warning btn-sm action-btn" data-action="pause" data-testid="pause-btn-${table.id}" onclick="app.pauseSession(${table.id})"><span class="btn-label">⏸ Pause</span></button>`;
      return `
        ${toggle}
        <button class="btn btn-danger btn-sm action-btn" data-action="stop" data-testid="stop-btn-${table.id}" onclick="app.showStopModal(${table.id})"><span class="btn-label">⏹ Stop</span></button>
      `;
    }
    if (table.status === 'MAINTENANCE') {
      return `<button class="btn btn-success btn-sm" onclick="app.setStatus(${table.id}, 'AVAILABLE')">Mark Available</button>`;
    }
    return `<button class="btn btn-primary" data-testid="start-btn-${table.id}" onclick="app.showStartModal(${table.id})">Start Session</button>`;
  }

  startTimer(tableId, session) {
    if (this.timers.has(tableId)) clearInterval(this.timers.get(tableId));
    const sessionSnapshot = { ...session };
    const isPaused = !sessionSnapshot.last_resume_time;
    const tick = () => {
      const activeMs = sessionSnapshot.last_resume_time ? Date.now() - sessionSnapshot.last_resume_time : 0;
      const elapsed = Math.max(0, Number(sessionSnapshot.duration_ms || 0) + activeMs);
      const el = document.querySelector(`.session-timer[data-table-id="${tableId}"]`);
      if (!el) return;
      const m = Math.floor(elapsed / 60000);
      const s = Math.floor((elapsed % 60000) / 1000);
      const h = Math.floor(m / 60);
      el.textContent = `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    tick();
    if (!isPaused) {
      this.timers.set(tableId, setInterval(tick, 1000));
    }
  }

  renderPending() {
    const tbody = document.getElementById('pending-tbody');
    const summary = document.getElementById('pending-summary');
    const pending = this.sessions.filter((s) => s.payment_status === 'PENDING' && s.end_time);
    if (summary) {
      const total = pending.reduce((sum, s) => sum + (s.amount || 0), 0);
      summary.textContent = `${pending.length} bill${pending.length === 1 ? '' : 's'} pending (Rs.${total})`;
    }
    if (!tbody) return;
    if (!pending.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No pending payments</td></tr>';
      return;
    }

    // Rules:
    //  - Loser row is ALWAYS shown (they pay game time). Label: "Loser" or "Loser + Food".
    //  - Winner row is shown ONLY if they ordered food (winner doesn't pay otherwise).
    //    Label: "Winner + Food".
    //  - "Mark Both Paid" on any row settles the whole session.
    const rows = [];
    for (const s of pending) {
      const tableName = s.table_name || this.getTableName(this.tables.find((t) => t.id === s.table_id));
      const gameAmount = Math.max(0, Number(s.amount || 0) - Number(s.food_charge_p1 || 0) - Number(s.food_charge_p2 || 0));
      const p1Name = s.player_one_name || 'Player One';
      const p2Name = s.player_two_name || 'Player Two';
      const p1Food = Number(s.food_charge_p1 || 0);
      const p2Food = Number(s.food_charge_p2 || 0);
      const loserIsP1 = s.loser === 'PLAYER_ONE';
      const method = s.payment_method || 'CASH';

      const loser = {
        name: loserIsP1 ? p1Name : p2Name,
        food: loserIsP1 ? p1Food : p2Food,
        total: gameAmount + (loserIsP1 ? p1Food : p2Food),
        pos: loserIsP1 ? 'p1' : 'p2'
      };
      const winner = {
        name: loserIsP1 ? p2Name : p1Name,
        food: loserIsP1 ? p2Food : p1Food,
        total: loserIsP1 ? p2Food : p1Food,
        pos: loserIsP1 ? 'p2' : 'p1'
      };

      const buildLabel = (role, food) => {
        const base = role === 'loser' ? 'Loser' : 'Winner';
        const suffix = food > 0 ? ' + Food' : '';
        const cls = role === 'loser' ? 'role-loser' : 'role-winner';
        return `<span class="role-chip ${cls}">${base}${suffix}</span>`;
      };

      const winnerOwes = winner.food > 0;
      const buttonLabel = winnerOwes ? 'Mark Both Paid' : 'Mark Paid';

      const renderRow = (entry, role) => `<tr class="pending-row pending-${entry.pos}" data-session-id="${s.id}" data-testid="pending-row-${s.id}-${entry.pos}">
        <td>${tableName}</td>
        <td class="player-cell"><span class="player-name">${entry.name}</span> ${buildLabel(role, entry.food)}</td>
        <td class="bill-amount">Rs.${entry.total}</td>
        <td>${method}</td>
        <td><button class="btn btn-success btn-sm pending-pay-btn" data-testid="mark-paid-${s.id}-${entry.pos}" onclick="app.markPaid(${s.id})">${buttonLabel}</button></td>
      </tr>`;

      // Always show loser
      rows.push(renderRow(loser, 'loser'));
      // Show winner ONLY when they had food
      if (winnerOwes) {
        rows.push(renderRow(winner, 'winner'));
      }
    }
    tbody.innerHTML = rows.join('');
  }

  renderSessions() {
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;
    const completed = this.sessions.filter((s) => s.end_time);
    if (!completed.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="text-center">No history records for today</td></tr>';
      return;
    }
    tbody.innerHTML = completed.map((s) => {
      const tableName = s.table_name || this.getTableName(this.tables.find((t) => t.id === s.table_id));
      const players = `${s.player_one_name || 'Player One'} vs ${s.player_two_name || 'Player Two'}`;
      const payer = s.payer_name || (s.loser === 'PLAYER_ONE' ? s.player_one_name : s.player_two_name) || 'Unknown';
      const status = s.payment_status === 'PAID' ? '<span class="badge-paid">Paid</span>' : '<span class="badge-pending">Pending</span>';
      const startTime = s.start_time ? new Date(s.start_time).toLocaleTimeString() : '-';
      const endTime = s.end_time ? new Date(s.end_time).toLocaleTimeString() : '-';
      const duration = s.billed_minutes != null ? `${s.billed_minutes}m` : '-';
      const sessionAmount = s.amount != null ? `Rs.${s.amount - (s.food_charge || 0)}` : '-';
      const foodP1 = s.food_charge_p1 != null ? `Rs.${s.food_charge_p1}` : (s.food_charge != null && s.loser === 'PLAYER_ONE' ? `Rs.${s.food_charge}` : 'Rs.0');
      const foodP2 = s.food_charge_p2 != null ? `Rs.${s.food_charge_p2}` : (s.food_charge != null && s.loser === 'PLAYER_TWO' ? `Rs.${s.food_charge}` : 'Rs.0');
      const totalAmount = s.amount != null ? `Rs.${s.amount}` : '-';
      return `<tr>
        <td>${tableName}</td>
        <td>${players}</td>
        <td>${payer}</td>
        <td>${startTime}</td>
        <td>${endTime}</td>
        <td>${duration}</td>
        <td>${sessionAmount}</td>
        <td>${foodP1}</td>
        <td>${foodP2}</td>
        <td>${totalAmount}</td>
        <td>${s.payment_method || '-'}</td>
        <td>${status}</td>
      </tr>`;
    }).join('');
  }

  renderActiveSessions() {
    const tbody = document.getElementById('active-tbody');
    const summary = document.getElementById('active-summary');
    const active = this.sessions.filter((s) => !s.end_time);
    if (summary) {
      summary.textContent = `${active.length} active session${active.length === 1 ? '' : 's'}`;
    }
    if (!tbody) return;
    if (!active.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No active sessions</td></tr>';
      return;
    }
    tbody.innerHTML = active.map((s) => {
      const tableName = s.table_name || this.getTableName(this.tables.find((t) => t.id === s.table_id));
      const players = `${s.player_one_name || 'Player One'} vs ${s.player_two_name || 'Player Two'}`;
      const startTime = s.start_time ? new Date(s.start_time).toLocaleTimeString() : '-';
      const duration = s.billed_minutes != null ? `${s.billed_minutes}m` : '-';
      const amount = s.amount != null ? `Rs.${s.amount}` : '-';
      const status = s.payment_status === 'PENDING' ? '<span class="badge-pending">Pending</span>' : '<span class="badge-active">Active</span>';
      return `<tr>
        <td>${tableName}</td>
        <td>${players}</td>
        <td>${formatPhoneDisplay(s.customer_phone)}</td>
        <td>${startTime}</td>
        <td>${duration}</td>
        <td>${amount}</td>
        <td>${status}</td>
      </tr>`;
    }).join('');
  }

  renderPlayers() {
    // players section has been replaced by History. Keep this for backward compatibility only.
  }

  showStartModal(tableId) {
    const table = this.tables.find((t) => t.id === tableId);
    if (!table) return;
    document.getElementById('selected-table-id').value = tableId;
    document.getElementById('selected-table-info').innerHTML = `
      <strong>${this.getTableName(table)}</strong>
      <span>Rs.${this.getRatePerMinute(table)}/min, minimum Rs.${table.minimum_charge || 0}</span>
    `;
    document.getElementById('player-one-name').value = '';
    document.getElementById('player-two-name').value = '';
    document.getElementById('customer-phone-local').value = '';
    document.getElementById('is-friendly').checked = false;
    document.getElementById('player-suggestions').innerHTML = '';
    document.getElementById('start-session-modal').classList.add('show');
    document.getElementById('player-one-name').focus();
  }

  async submitStart(e) {
    e.preventDefault();
    const tableId = Number(document.getElementById('selected-table-id').value);
    const player_one_name = document.getElementById('player-one-name').value.trim();
    const player_two_name = document.getElementById('player-two-name').value.trim();
    const phoneCheck = normalizePhoneLocalInput(document.getElementById('customer-phone-local').value);
    if (!phoneCheck.valid) {
      this.toast(phoneCheck.error, 'error');
      return;
    }
    if (!player_one_name || !player_two_name) {
      this.toast('Both player names are required', 'error');
      return;
    }

    const isFriendly = document.getElementById('is-friendly').checked;
    const table = this.tables.find((t) => t.id === tableId);

    // === Optimistic UI: close modal + add session + flip table to OCCUPIED instantly ===
    document.getElementById('start-session-modal').classList.remove('show');

    const startTime = Date.now();
    const tempId = -startTime; // negative IDs avoid collisions with real ones
    const tempSession = {
      id: tempId,
      table_id: tableId,
      start_time: startTime,
      last_resume_time: startTime,
      duration_ms: 0,
      paused_ms: 0,
      is_friendly: isFriendly ? 1 : 0,
      player_one_name,
      player_two_name,
      customer_name: `${player_one_name} vs ${player_two_name}`,
      customer_phone: phoneCheck.phone,
      end_time: null,
      payment_status: 'PENDING',
      break_count: 0,
      table_name: table ? this.getTableName(table) : `Table ${tableId}`,
      _optimistic: true
    };
    if (table) {
      this.patchTableFromApi(
        { ...table, status: 'OCCUPIED', light_on: 1, running_amount: 0 },
        tempSession
      );
    }
    this.upsertSessionRecord(tempSession);
    this.renderTables();
    this.renderSessions();
    this.renderActiveSessions();
    this.updateStats();
    this.toast('Session started', 'success');

    // === Background: confirm with server ===
    try {
      const res = await fetch(`/api/table/${tableId}/start`, {
        method: 'POST',
        headers: this.auth.getAuthHeaders(),
        body: JSON.stringify({
          player_one_name,
          player_two_name,
          player_one_phone: phoneCheck.phone,
          is_friendly: isFriendly
        })
      });
      if (res.status === 401) { this.auth.handleAuthError(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start session');

      // Swap temp session with the real one returned by the server.
      this.sessions = this.sessions.filter((s) => s.id !== tempId);
      if (data.session) {
        this.upsertSessionRecord({ ...data.session, end_time: null, payment_status: 'PENDING' });
      }
      if (data.table) {
        this.patchTableFromApi(data.table, data.session || null);
      }
      this.renderTables();
      this.renderSessions();
      this.renderActiveSessions();
      this.updateStats();
    } catch (err) {
      // Revert optimistic state
      this.sessions = this.sessions.filter((s) => s.id !== tempId);
      if (table) {
        this.patchTableFromApi({ ...table, status: 'AVAILABLE', light_on: 0 }, null);
      }
      this.renderTables();
      this.renderSessions();
      this.renderActiveSessions();
      this.updateStats();
      this.toast(err.message || 'Failed to start session', 'error');
    }
  }

  showStopModal(tableId) {
    const table = this.tables.find((t) => t.id === tableId);
    const fallbackSession = this.sessions.find((s) => s.table_id === tableId && !s.end_time);
    const session = table?.active_session || fallbackSession;
    if (!session) return;
    const elapsed = Number(session.duration_ms || 0) + (session.last_resume_time ? Date.now() - session.last_resume_time : 0);
    const minutes = Math.ceil(elapsed / 60000);
    const perMin = Math.round(minutes * this.getRatePerMinute(table));
    const amount = this.calculateBill(table, minutes, session.is_friendly);

    const p1 = session.player_one_name || 'Player One';
    const p2 = session.player_two_name || 'Player Two';

    document.getElementById('stop-table-id').value = tableId;

    // Loser radio labels — actual player names
    document.getElementById('loser-label-p1').textContent = p1;
    document.getElementById('loser-label-p2').textContent = p2;

    // Per-player food labels
    document.getElementById('food-p1-name').textContent = p1;
    document.getElementById('food-p1-name-items').textContent = p1;
    document.getElementById('food-p2-name').textContent = p2;
    document.getElementById('food-p2-name-items').textContent = p2;

    document.getElementById('session-summary').innerHTML = `
      <div class="summary-row"><span>Table</span><span>${this.getTableName(table)}</span></div>
      <div class="summary-row"><span>Players</span><span>${p1} vs ${p2}</span></div>
      <div class="summary-row"><span>Duration</span><span>${minutes} minutes</span></div>
      <div class="summary-row"><span>Per-minute total</span><span>Rs.${perMin}</span></div>
      <div class="summary-row summary-total"><span>Game-time bill</span><span>Rs.${amount}</span></div>
    `;

    // Reset inputs
    document.getElementById('food-charge-p1').value = '0';
    document.getElementById('food-items-p1').value = '';
    document.getElementById('food-charge-p2').value = '0';
    document.getElementById('food-items-p2').value = '';
    document.querySelector('input[name="loser"][value="PLAYER_ONE"]').checked = true;

    // Stash the game amount on the modal so previews can read it
    this._stopCtx = { p1, p2, gameAmount: amount, isFriendly: !!session.is_friendly };
    this._renderBillsPreview();

    // Wire up live preview (idempotent — replace listeners by re-binding only once per open)
    const update = () => this._renderBillsPreview();
    ['food-charge-p1', 'food-items-p1', 'food-charge-p2', 'food-items-p2'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.dataset.previewBound) {
        el.addEventListener('input', update);
        el.dataset.previewBound = '1';
      }
    });
    document.querySelectorAll('input[name="loser"]').forEach((el) => {
      if (!el.dataset.previewBound) {
        el.addEventListener('change', update);
        el.dataset.previewBound = '1';
      }
    });

    document.getElementById('stop-session-modal').classList.add('show');
  }

  _renderBillsPreview() {
    const ctx = this._stopCtx;
    const host = document.getElementById('bills-preview');
    if (!ctx || !host) return;
    const loser = document.querySelector('input[name="loser"]:checked')?.value || 'PLAYER_ONE';
    const foodP1 = Math.max(0, Number(document.getElementById('food-charge-p1')?.value) || 0);
    const foodP2 = Math.max(0, Number(document.getElementById('food-charge-p2')?.value) || 0);
    const itemsP1 = (document.getElementById('food-items-p1')?.value || '').trim();
    const itemsP2 = (document.getElementById('food-items-p2')?.value || '').trim();
    const game = ctx.isFriendly ? 0 : ctx.gameAmount;
    const gameP1 = loser === 'PLAYER_ONE' ? game : 0;
    const gameP2 = loser === 'PLAYER_TWO' ? game : 0;
    const totalP1 = gameP1 + foodP1;
    const totalP2 = gameP2 + foodP2;
    const combined = totalP1 + totalP2;

    const renderReceipt = (name, role, gameAmt, foodAmt, items, testid) => {
      const isLoser = role === 'loser';
      const tag = isLoser
        ? (foodAmt > 0 ? 'Loser + Food' : 'Loser')
        : (foodAmt > 0 ? 'Winner + Food' : 'Winner · No charge');
      const tagCls = isLoser ? 'tag-loser' : 'tag-winner';
      const lines = [];
      if (gameAmt > 0) {
        lines.push(`<div class="receipt-line"><span class="rl-label">Game time</span><span class="rl-value">Rs.${gameAmt}</span></div>`);
      }
      if (foodAmt > 0) {
        lines.push(`<div class="receipt-line"><span class="rl-label">Food${items ? ` · <em>${items}</em>` : ''}</span><span class="rl-value">Rs.${foodAmt}</span></div>`);
      }
      if (!lines.length) {
        lines.push(`<div class="receipt-empty">Nothing to pay</div>`);
      }
      const total = gameAmt + foodAmt;
      return `
        <div class="receipt-card ${isLoser ? 'is-loser' : 'is-winner'} ${total === 0 ? 'is-empty' : ''}" data-testid="${testid}">
          <div class="receipt-head">
            <div class="receipt-name">${name}</div>
            <div class="receipt-tag ${tagCls}">${tag}</div>
          </div>
          <div class="receipt-perforation" aria-hidden="true"></div>
          <div class="receipt-body">
            ${lines.join('')}
          </div>
          <div class="receipt-total">
            <span class="rt-label">To pay</span>
            <span class="rt-amount">Rs.${total}</span>
          </div>
        </div>`;
    };

    host.innerHTML = `
      <div class="bills-block">
        <div class="bills-heading">
          <span class="bills-heading-bar"></span>
          <span>Two separate bills</span>
        </div>
        <div class="receipts-grid">
          ${renderReceipt(ctx.p1, loser === 'PLAYER_ONE' ? 'loser' : 'winner', gameP1, foodP1, itemsP1, 'bill-p1')}
          ${renderReceipt(ctx.p2, loser === 'PLAYER_TWO' ? 'loser' : 'winner', gameP2, foodP2, itemsP2, 'bill-p2')}
        </div>
        <div class="bills-grand-card" data-testid="bills-grand-total">
          <div class="bg-label">Combined session total</div>
          <div class="bg-amount">Rs.${combined}</div>
        </div>
      </div>
    `;
  }

  async confirmStop() {
    const tableId = Number(document.getElementById('stop-table-id').value);
    const loser = document.querySelector('input[name="loser"]:checked')?.value || 'PLAYER_ONE';
    const foodP1 = Number(document.getElementById('food-charge-p1').value) || 0;
    const itemsP1 = document.getElementById('food-items-p1').value.trim();
    const foodP2 = Number(document.getElementById('food-charge-p2').value) || 0;
    const itemsP2 = document.getElementById('food-items-p2').value.trim();
    const paymentMethod = document.getElementById('final-payment-method').value;

    const table = this.tables.find((t) => t.id === tableId);
    const session = (table && table.active_session)
      || this.sessions.find((s) => s.table_id === tableId && !s.end_time);
    if (!session) return;

    // === Optimistic: close modal, move session to pending, free table ===
    document.getElementById('stop-session-modal').classList.remove('show');

    const endTime = Date.now();
    const additionalMs = session.last_resume_time ? (endTime - session.last_resume_time) : 0;
    const totalDurationMs = (session.duration_ms || 0) + additionalMs;
    const billedMinutes = Math.max(0, Math.ceil(totalDurationMs / 60000));
    const gameAmount = table ? this.calculateBill(table, billedMinutes, session.is_friendly) : 0;
    const totalFood = foodP1 + foodP2;
    const finalAmount = session.is_friendly ? 0 : gameAmount + totalFood;
    const payerName = loser === 'PLAYER_ONE' ? session.player_one_name : session.player_two_name;
    const paymentStatus = (session.is_friendly || finalAmount === 0) ? 'PAID' : 'PENDING';

    const prevSession = { ...session };
    const prevTable = table ? { ...table } : null;
    const prevActive = table ? table.active_session : null;

    const updatedSession = {
      ...session,
      end_time: endTime,
      duration_ms: totalDurationMs,
      billed_minutes: billedMinutes,
      amount: finalAmount,
      food_charge: totalFood,
      food_charge_p1: foodP1,
      food_items_p1: itemsP1,
      food_charge_p2: foodP2,
      food_items_p2: itemsP2,
      loser,
      payer_name: payerName,
      payment_method: paymentMethod,
      payment_status: paymentStatus,
      table_name: table ? this.getTableName(table) : session.table_name,
      _optimistic: true
    };
    this.upsertSessionRecord(updatedSession);
    if (table) {
      this.patchTableFromApi(
        { ...table, status: 'AVAILABLE', light_on: 0, running_amount: 0 },
        null
      );
    }

    // Optimistic dashboard stats — bump session count & earnings locally so the
    // top widgets update the instant the bill is saved (no waiting for /summary/today).
    {
      const s = this.todaySummary || {};
      const next = {
        ...s,
        total_sessions: (s.total_sessions || 0) + 1,
        friendly_games: (s.friendly_games || 0) + (session.is_friendly ? 1 : 0)
      };
      if (!session.is_friendly && finalAmount > 0) {
        next.total_earnings = (s.total_earnings || 0) + finalAmount;
        if (table && table.type === 'ENGLISH') next.english_earnings = (s.english_earnings || 0) + finalAmount;
        if (table && table.type === 'FRENCH')  next.french_earnings  = (s.french_earnings  || 0) + finalAmount;
        if (paymentMethod === 'CASH') next.cash_earnings = (s.cash_earnings || 0) + finalAmount;
        if (paymentMethod === 'UPI')  next.upi_earnings  = (s.upi_earnings  || 0) + finalAmount;
        if (paymentMethod === 'CARD') next.card_earnings = (s.card_earnings || 0) + finalAmount;
      }
      this.todaySummary = next;
    }

    this.renderTables();
    this.renderSessions();
    this.renderPending();
    this.renderActiveSessions();
    this.updateStats();
    this.toast(`Bill saved: Rs.${finalAmount}. Mark as paid when money is received.`, 'success');

    // === Background: confirm with server ===
    try {
      const res = await fetch(`/api/table/${tableId}/stop`, {
        method: 'POST',
        headers: this.auth.getAuthHeaders(),
        body: JSON.stringify({
          payment_method: paymentMethod,
          loser,
          food_charge_p1: foodP1,
          food_items_p1: itemsP1,
          food_charge_p2: foodP2,
          food_items_p2: itemsP2
        })
      });
      if (res.status === 401) { this.auth.handleAuthError(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to stop session');

      if (data.session) this.upsertSessionRecord(data.session);
      if (data.table) this.patchTableFromApi(data.table, null);
      this.renderTables();
      this.renderSessions();
      this.renderPending();
      this.updateStats();
    } catch (err) {
      // Revert optimistic state
      this.upsertSessionRecord(prevSession);
      if (table && prevTable) {
        this.patchTableFromApi(prevTable, prevActive);
      }
      this.renderTables();
      this.renderSessions();
      this.renderPending();
      this.renderActiveSessions();
      this.updateStats();
      this.toast(err.message || 'Failed to stop session', 'error');
    }
  }

  async markPaid(sessionId) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (session.payment_status === 'PAID') return;

    // === Optimistic: flip status, disable buttons, re-render pending + history ===
    const prevStatus = session.payment_status;
    session.payment_status = 'PAID';
    // Lock both pay-buttons for this session so users don't double-click.
    document.querySelectorAll(`[data-session-id="${sessionId}"] .pending-pay-btn`).forEach((btn) => {
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.textContent = 'Paid';
    });
    this.upsertSessionRecord(session);
    this.renderPending();
    this.renderSessions();
    this.updateStats();
    this.toast('Payment confirmed', 'success');

    // === Background: confirm with server ===
    try {
      const res = await fetch(`/api/session/${sessionId}/mark-paid`, {
        method: 'POST',
        headers: this.auth.getAuthHeaders()
      });
      if (res.status === 401) { this.auth.handleAuthError(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update payment');
      if (data.session) {
        this.upsertSessionRecord(data.session);
        this.renderPending();
        this.renderSessions();
        this.updateStats();
      }
    } catch (err) {
      // Revert
      session.payment_status = prevStatus;
      this.upsertSessionRecord(session);
      this.renderPending();
      this.renderSessions();
      this.updateStats();
      this.toast(err.message || 'Failed to mark as paid', 'error');
    }
  }

  async pauseSession(tableId) {
    await this.sessionAction(tableId, 'pause');
  }

  async resumeSession(tableId) {
    await this.sessionAction(tableId, 'resume');
  }

  async sessionAction(tableId, action) {
    // Optimistic UI: lock the button immediately and toggle the visual state.
    const card = document.querySelector(`.table-card[data-table-id="${tableId}"]`);
    const actionsHost = card?.querySelector('.table-actions');
    const clickedBtn = actionsHost?.querySelector(`button[data-action="${action}"]`);
    if (clickedBtn) {
      clickedBtn.classList.add('is-loading');
      clickedBtn.disabled = true;
      const label = clickedBtn.querySelector('.btn-label');
      if (label) label.textContent = action === 'pause' ? 'Pausing…' : 'Resuming…';
    }
    // Lock all action buttons on the card to prevent double-clicks.
    actionsHost?.querySelectorAll('button.action-btn').forEach((b) => { b.disabled = true; });

    const table = this.tables.find((t) => t.id === tableId);
    const session = (table && table.active_session)
      || this.sessions.find((s) => s.table_id === tableId && !s.end_time);

    // Snapshot previous state for revert on error.
    const prevLastResume = session?.last_resume_time ?? null;
    const prevDurationMs = session?.duration_ms ?? 0;

    // Optimistically update local state and re-render the single card.
    if (table && session) {
      let nextSession = { ...session };
      if (action === 'pause') {
        const addedMs = prevLastResume ? Math.max(0, Date.now() - prevLastResume) : 0;
        nextSession.duration_ms = (prevDurationMs || 0) + addedMs;
        nextSession.last_resume_time = null;
      } else {
        nextSession.last_resume_time = Date.now();
      }
      this.upsertSessionRecord(nextSession);
      table.active_session = nextSession;
      this._rerenderTableCard(table);
    }

    try {
      const res = await fetch(`/api/table/${tableId}/${action}`, {
        method: 'POST',
        headers: this.auth.getAuthHeaders()
      });
      if (res.status === 401) { this.auth.handleAuthError(); return; }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Revert optimistic update
        if (table && session) {
          const reverted = { ...session, last_resume_time: prevLastResume, duration_ms: prevDurationMs };
          this.upsertSessionRecord(reverted);
          table.active_session = reverted;
          this._rerenderTableCard(table);
        }
        this.toast(data.error || `Failed to ${action} session`, 'error');
        return;
      }
      this.toast(action === 'pause' ? 'Session paused' : 'Session resumed', 'success');
    } catch (err) {
      if (table && session) {
        const reverted = { ...session, last_resume_time: prevLastResume, duration_ms: prevDurationMs };
        this.upsertSessionRecord(reverted);
        table.active_session = reverted;
        this._rerenderTableCard(table);
      }
      this.toast(`Failed to ${action} session`, 'error');
      return;
    }

    // Reconcile from server in the background (will no-op if already in sync).
    this.refreshTableById(tableId).catch(() => undefined);
    this.renderSessions();
    this.renderActiveSessions();
    this.updateStats();
  }

  _rerenderTableCard(table) {
    const grid = document.getElementById('tables-grid');
    const old = grid?.querySelector(`.table-card[data-table-id="${table.id}"]`);
    if (!grid || !old) {
      this.renderTables();
      return;
    }
    if (this.timers.has(table.id)) {
      clearInterval(this.timers.get(table.id));
      this.timers.delete(table.id);
    }
    const next = this.createTableCard(table);
    old.replaceWith(next);
  }

  async setStatus(tableId, status) {
    const res = await fetch(`/api/table/${tableId}/status`, {
      method: 'PATCH',
      headers: this.auth.getAuthHeaders(),
      body: JSON.stringify({ status })
    });
    if (!res.ok) return this.toast('Failed to update table', 'error');
    await this.refreshTableById(tableId);
  }

  setupAutocomplete() {
    const input = document.getElementById('player-one-name');
    const box = document.getElementById('player-suggestions');
    if (!input || !box) return;

    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.fetchSuggestions(input.value, box), 250);
    });

    input.addEventListener('keydown', (e) => {
      if (!this.suggestions.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.suggestionIndex = Math.min(this.suggestionIndex + 1, this.suggestions.length - 1);
        this.renderSuggestions(box);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.suggestionIndex = Math.max(this.suggestionIndex - 1, 0);
        this.renderSuggestions(box);
      } else if (e.key === 'Enter' && this.suggestionIndex >= 0) {
        e.preventDefault();
        this.pickSuggestion(this.suggestions[this.suggestionIndex]);
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.autocomplete-container')) {
        box.innerHTML = '';
        box.style.display = 'none';
      }
    });
  }

  async fetchSuggestions(query, box) {
    if (!query || query.trim().length < 2) {
      box.innerHTML = '';
      this.suggestions = [];
      return;
    }
    const res = await fetch(`/api/customers?search=${encodeURIComponent(query)}&limit=8`, {
      headers: this.auth.getAuthHeaders()
    });
    if (!res.ok) return;
    this.suggestions = await res.json();
    this.suggestionIndex = -1;
    this.renderSuggestions(box);
  }

  renderSuggestions(box) {
    if (!this.suggestions.length) {
      box.innerHTML = '';
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.innerHTML = this.suggestions.map((s, i) => `
      <div class="suggestion-item ${i === this.suggestionIndex ? 'active' : ''}" data-index="${i}">
        <strong>${s.name}</strong>
        <span class="player-code">${s.player_code}</span>
        ${s.phone ? `<span class="phone">${formatPhoneDisplay(s.phone)}</span>` : ''}
      </div>
    `).join('');
    box.querySelectorAll('.suggestion-item').forEach((el) => {
      el.addEventListener('click', () => this.pickSuggestion(this.suggestions[Number(el.dataset.index)]));
    });
  }

  pickSuggestion(player) {
    document.getElementById('player-one-name').value = player.name;
    document.getElementById('customer-phone-local').value = phoneToLocalInput(player.phone);
    document.getElementById('player-suggestions').innerHTML = '';
    document.getElementById('player-suggestions').style.display = 'none';
    this.suggestions = [];
  }

  showExportCsvModal() {
    document.getElementById('user-dropdown')?.classList.remove('show');
    const today = new Date().toISOString().slice(0, 10);
    const todayLabel = document.getElementById('export-today-label');
    const dateInput = document.getElementById('export-date');
    if (todayLabel) {
      todayLabel.textContent = new Date().toLocaleDateString('en-IN', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
      });
    }
    if (dateInput) {
      dateInput.value = today;
      dateInput.max = today;
    }
    document.querySelector('input[name="export-range"][value="today"]').checked = true;
    this.toggleExportDateInput();
    document.getElementById('export-csv-modal').classList.add('show');
  }

  toggleExportDateInput() {
    const isCustom = document.querySelector('input[name="export-range"]:checked')?.value === 'custom';
    const group = document.getElementById('export-date-group');
    if (group) group.style.display = isCustom ? 'block' : 'none';
  }

  async downloadSessionsExport() {
    const range = document.querySelector('input[name="export-range"]:checked')?.value || 'today';
    let date = null;
    if (range === 'custom') {
      date = document.getElementById('export-date')?.value;
      if (!date) return this.toast('Please pick a date', 'error');
    }

    const btn = document.getElementById('confirm-export-csv');
    const defaultLabel = 'Download';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Downloading...';
    }

    try {
      const query = date ? `?date=${encodeURIComponent(date)}` : '';
      const res = await fetch(`/api/reports/daily.xlsx${query}`, {
        headers: { Authorization: `Bearer ${this.auth.token}` }
      });
      if (res.status === 401) return this.auth.handleAuthError();
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return this.toast(data.error || 'Download failed', 'error');
      }

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] || `history-${date || new Date().toISOString().slice(0, 10)}.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);

      document.getElementById('export-csv-modal').classList.remove('show');
      this.toast('History Excel downloaded', 'success');
    } catch {
      this.toast('Download failed', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = defaultLabel;
      }
    }
  }

  toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
}

const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());
