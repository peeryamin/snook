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
    this.renderPlayers();
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
      this.renderPlayers();
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
    if (this.eventSource) this.eventSource.close();
    const token = this.auth.token;
    this.eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    this.eventSource.addEventListener('connected', () => this.setOnline(true));
    this.eventSource.onerror = () => this.setOnline(false);
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
    card.className = `table-card ${table.status.toLowerCase()}`;
    const occupied = table.status === 'OCCUPIED';
    const name = this.getTableName(table);
    const rate = this.getRatePerMinute(table);
    const min = table.minimum_charge || 0;

    card.innerHTML = `
      <div class="table-header">
        <div class="table-number">${name}</div>
        <div class="status-badge ${table.status.toLowerCase()}">${table.status}</div>
      </div>
      <div class="table-info">
        <div class="rate-display">Rs.${rate}/min, minimum Rs.${min}</div>
        ${occupied ? `
          <div class="session-details">
            <div class="session-timer" data-table-id="${table.id}">00:00:00</div>
            <div class="running-amount">Rs.${(table.running_amount || 0).toLocaleString('en-IN')}</div>
            ${table.active_session?.customer_name ? `<div class="customer-info">${table.active_session.customer_name}</div>` : ''}
          </div>` : ''}
      </div>
      <div class="table-actions">${this.tableActions(table)}</div>
    `;

    if (occupied && table.active_session) {
      this.startTimer(table.id, table.active_session);
    }
    return card;
  }

  tableActions(table) {
    if (table.status === 'OCCUPIED') {
      return `
        <button class="btn btn-warning btn-sm" onclick="app.pauseSession(${table.id})">Pause</button>
        <button class="btn btn-success btn-sm" onclick="app.resumeSession(${table.id})">Resume</button>
        <button class="btn btn-danger btn-sm" onclick="app.showStopModal(${table.id})">Stop</button>
      `;
    }
    if (table.status === 'MAINTENANCE') {
      return `<button class="btn btn-success btn-sm" onclick="app.setStatus(${table.id}, 'AVAILABLE')">Mark Available</button>`;
    }
    return `<button class="btn btn-primary" onclick="app.showStartModal(${table.id})">Start Session</button>`;
  }

  startTimer(tableId, session) {
    if (this.timers.has(tableId)) clearInterval(this.timers.get(tableId));
    const sessionSnapshot = { ...session };
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
    this.timers.set(tableId, setInterval(tick, 1000));
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
    tbody.innerHTML = pending.map((s) => {
      const tableName = s.table_name || this.getTableName(this.tables.find((t) => t.id === s.table_id));
      return `<tr>
        <td>${tableName}</td>
        <td>${s.customer_name || 'Walk-in'}</td>
        <td>Rs.${s.amount}</td>
        <td>${s.payment_method || 'CASH'}</td>
        <td><button class="btn btn-success btn-sm" onclick="app.markPaid(${s.id})">Mark as Paid</button></td>
      </tr>`;
    }).join('');
  }

  renderSessions() {
    const tbody = document.getElementById('sessions-tbody');
    if (!tbody) return;
    const completed = this.sessions.filter((s) => s.end_time);
    if (!completed.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center">No sessions today</td></tr>';
      return;
    }
    tbody.innerHTML = completed.map((s) => {
      const tableName = s.table_name || this.getTableName(this.tables.find((t) => t.id === s.table_id));
      const status = s.payment_status === 'PAID' ? '<span class="badge-paid">Paid</span>' : '<span class="badge-pending">Pending</span>';
      return `<tr>
        <td>${tableName}</td>
        <td>${s.customer_name || '-'}</td>
        <td>${formatPhoneDisplay(s.customer_phone)}</td>
        <td>${s.start_time ? new Date(s.start_time).toLocaleTimeString() : '-'}</td>
        <td>${s.end_time ? new Date(s.end_time).toLocaleTimeString() : '-'}</td>
        <td>${s.billed_minutes ? `${s.billed_minutes}m` : '-'}</td>
        <td>${s.amount != null ? `Rs.${s.amount}` : '-'}</td>
        <td>${s.payment_method || '-'}</td>
        <td>${status}</td>
      </tr>`;
    }).join('');
  }

  renderPlayers() {
    const tbody = document.getElementById('players-tbody');
    if (!tbody) return;
    if (!this.players.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No players yet today</td></tr>';
      return;
    }
    tbody.innerHTML = this.players.map((p) => `<tr>
      <td>${p.player_code}</td>
      <td>${p.name}</td>
      <td>${formatPhoneDisplay(p.phone)}</td>
      <td>${p.sessions_count}</td>
      <td>Rs.${p.total_spent}</td>
    </tr>`).join('');
  }

  showStartModal(tableId) {
    const table = this.tables.find((t) => t.id === tableId);
    if (!table) return;
    document.getElementById('selected-table-id').value = tableId;
    document.getElementById('selected-table-info').innerHTML = `
      <strong>${this.getTableName(table)}</strong>
      <span>Rs.${this.getRatePerMinute(table)}/min, minimum Rs.${table.minimum_charge || 0}</span>
    `;
    document.getElementById('customer-name').value = '';
    document.getElementById('customer-phone-local').value = '';
    document.getElementById('is-friendly').checked = false;
    document.getElementById('customer-suggestions').innerHTML = '';
    document.getElementById('start-session-modal').classList.add('show');
    document.getElementById('customer-name').focus();
  }

  async submitStart(e) {
    e.preventDefault();
    const tableId = Number(document.getElementById('selected-table-id').value);
    const customer_name = document.getElementById('customer-name').value.trim();
    const phoneCheck = normalizePhoneLocalInput(document.getElementById('customer-phone-local').value);
    if (!phoneCheck.valid) {
      this.toast(phoneCheck.error, 'error');
      return;
    }
    if (!customer_name) {
      this.toast('Player name is required', 'error');
      return;
    }

    const res = await fetch(`/api/table/${tableId}/start`, {
      method: 'POST',
      headers: this.auth.getAuthHeaders(),
      body: JSON.stringify({
        customer_name,
        customer_phone: phoneCheck.phone,
        is_friendly: document.getElementById('is-friendly').checked
      })
    });
    if (res.status === 401) return this.auth.handleAuthError();
    const data = await res.json();
    if (!res.ok) return this.toast(data.error || 'Failed to start session', 'error');
    document.getElementById('start-session-modal').classList.remove('show');
    this.toast('Session started', 'success');
    if (data.table && data.session) {
      this.patchTableFromApi(data.table, data.session);
      this.renderTables();
    }
    clearTimeout(this.loadDataTimer);
    await this.refreshAuxiliaryData();
  }

  showStopModal(tableId) {
    const table = this.tables.find((t) => t.id === tableId);
    if (!table?.active_session) return;
    const session = table.active_session;
    const elapsed = Number(session.duration_ms || 0) + (session.last_resume_time ? Date.now() - session.last_resume_time : 0);
    const minutes = Math.ceil(elapsed / 60000);
    const perMin = Math.round(minutes * this.getRatePerMinute(table));
    const amount = this.calculateBill(table, minutes, session.is_friendly);

    document.getElementById('stop-table-id').value = tableId;
    document.getElementById('session-summary').innerHTML = `
      <div class="summary-row"><span>Table</span><span>${this.getTableName(table)}</span></div>
      <div class="summary-row"><span>Player</span><span>${session.customer_name || 'Walk-in'}</span></div>
      <div class="summary-row"><span>Duration</span><span>${minutes} minutes</span></div>
      <div class="summary-row"><span>Per-minute total</span><span>Rs.${perMin}</span></div>
      <div class="summary-row summary-total"><span>Bill amount</span><span>Rs.${amount}</span></div>
    `;
    document.getElementById('stop-session-modal').classList.add('show');
  }

  async confirmStop() {
    const tableId = Number(document.getElementById('stop-table-id').value);
    const res = await fetch(`/api/table/${tableId}/stop`, {
      method: 'POST',
      headers: this.auth.getAuthHeaders(),
      body: JSON.stringify({
        payment_method: document.getElementById('final-payment-method').value
      })
    });
    if (res.status === 401) return this.auth.handleAuthError();
    const data = await res.json();
    if (!res.ok) return this.toast(data.error || 'Failed to stop session', 'error');
    document.getElementById('stop-session-modal').classList.remove('show');
    this.toast(`Bill saved: Rs.${data.receipt?.amount || 0}. Mark as paid when money is received.`, 'success');
    if (data.table) {
      this.patchTableFromApi(data.table, null);
      this.renderTables();
    }
    if (data.session) this.upsertSessionRecord(data.session);
    clearTimeout(this.loadDataTimer);
    await this.refreshAuxiliaryData();
  }

  async markPaid(sessionId) {
    const res = await fetch(`/api/session/${sessionId}/mark-paid`, {
      method: 'POST',
      headers: this.auth.getAuthHeaders()
    });
    if (res.status === 401) return this.auth.handleAuthError();
    const data = await res.json();
    if (!res.ok) return this.toast(data.error || 'Failed to update payment', 'error');
    this.toast('Payment confirmed', 'success');
    await this.refreshAuxiliaryData();
  }

  async pauseSession(tableId) {
    await this.sessionAction(tableId, 'pause');
  }

  async resumeSession(tableId) {
    await this.sessionAction(tableId, 'resume');
  }

  async sessionAction(tableId, action) {
    const res = await fetch(`/api/table/${tableId}/${action}`, {
      method: 'POST',
      headers: this.auth.getAuthHeaders()
    });
    if (res.status === 401) return this.auth.handleAuthError();
    if (!res.ok) {
      const data = await res.json();
      return this.toast(data.error || `Failed to ${action}`, 'error');
    }
    await this.refreshTableById(tableId);
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
    const input = document.getElementById('customer-name');
    const box = document.getElementById('customer-suggestions');
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
    document.getElementById('customer-name').value = player.name;
    document.getElementById('customer-phone-local').value = phoneToLocalInput(player.phone);
    document.getElementById('customer-suggestions').innerHTML = '';
    document.getElementById('customer-suggestions').style.display = 'none';
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
    const format = document.querySelector('input[name="export-format"]:checked')?.value || 'xlsx';
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
      const endpoint = format === 'csv' ? '/api/reports/daily.csv' : '/api/reports/daily.xlsx';
      const res = await fetch(`${endpoint}${query}`, {
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
      const ext = format === 'csv' ? 'csv' : 'xlsx';
      const filename = match?.[1] || `sessions-${date || new Date().toISOString().slice(0, 10)}.${ext}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);

      document.getElementById('export-csv-modal').classList.remove('show');
      this.toast(`Sessions ${format.toUpperCase()} downloaded`, 'success');
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
