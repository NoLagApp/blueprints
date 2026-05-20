import { Observe } from '@nolag/agents';

// ── Mock Room ───────────────────────────────────────────────────────────────
function createMockRoom(name) {
  const handlers = {};
  return {
    name,
    on(event, handler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return this;
    },
    off(event, handler) {
      if (handler && handlers[event]) {
        handlers[event] = handlers[event].filter(h => h !== handler);
      } else {
        delete handlers[event];
      }
      return this;
    },
    publishState(data) { this._emit('stateChange', data); },
    publishEvent(data) { this._emit('event', data); },
    publishTask(data) { this._emit('task', data); },
    publishResult(data) { this._emit('result', data); },
    publishInbox(data) { this._emit('inbox', data); },
    publishTools(data) {
      if (data.type === 'tool_response') this._emit('toolResponse', data);
      else this._emit('toolRequest', data);
    },
    publishApproval(data) {
      if (data.type === 'approval_response') this._emit('approvalResponse', data);
      else this._emit('approvalRequest', data);
    },
    _emit(event, data) {
      for (const h of handlers[event] || []) {
        try { h(data); } catch (e) { console.error(e); }
      }
    },
  };
}

// ── State ───────────────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'monitor-agent', label: 'Monitor', color: 'badge-primary', defaultCategory: 'progress', defaultSeverity: 'info' },
  { id: 'validator-agent', label: 'Validator', color: 'badge-info', defaultCategory: 'error', defaultSeverity: 'error' },
  { id: 'metrics-agent', label: 'Metrics', color: 'badge-warning', defaultCategory: 'metrics', defaultSeverity: 'debug' },
];

const SEVERITIES = ['debug', 'info', 'warning', 'error', 'critical'];

const SEVERITY_BADGE = {
  debug: 'badge-ghost',
  info: 'badge-info',
  warning: 'badge-warning',
  error: 'badge-error',
  critical: 'badge-error pulse-critical',
};

const room = createMockRoom('observe-room');

// Create an Observe instance per agent (each emits as that agent)
const observers = AGENTS.map(a => ({
  ...a,
  observe: new Observe(room, a.id),
  autoInterval: null,
}));

// A single observer that listens to all events (the dashboard)
const dashboard = new Observe(room, 'dashboard');

// Event stream buffer
const eventStream = [];
const MAX_EVENTS = 200;

// Metrics state
const metrics = {
  timestamps: [],  // ring buffer of event timestamps for events/sec calculation
  bySeverity: { debug: 0, info: 0, warning: 0, error: 0, critical: 0 },
  byAgent: {},     // agentId -> count
};

// Filter state
let filterCategory = '';
let filterSeverity = '';

// ── Random event data for auto-emit ─────────────────────────────────────────
const RANDOM_PAYLOADS = {
  progress: [
    { step: 'parsing', percent: 42 },
    { step: 'indexing', percent: 78 },
    { step: 'complete', percent: 100 },
    { step: 'queued', position: 3 },
  ],
  error: [
    { code: 'TIMEOUT', message: 'Request timed out after 30s' },
    { code: 'VALIDATION', message: 'Invalid input schema' },
    { code: 'AUTH', message: 'Token expired' },
    { code: 'RATE_LIMIT', message: 'Too many requests' },
  ],
  metrics: [
    { cpu: 45.2, memory: 68.1 },
    { latency_ms: 120, throughput: 1500 },
    { queue_depth: 12, active_workers: 4 },
    { uptime_hours: 72.5, error_rate: 0.02 },
  ],
};

function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomPayload(category) {
  const payloads = RANDOM_PAYLOADS[category] || RANDOM_PAYLOADS.progress;
  return randomItem(payloads);
}

function randomSeverity() {
  const weights = [0.2, 0.35, 0.2, 0.15, 0.1]; // debug, info, warning, error, critical
  const r = Math.random();
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += weights[i];
    if (r <= sum) return SEVERITIES[i];
  }
  return 'info';
}

// ── Dashboard listener ──────────────────────────────────────────────────────
dashboard.on((envelope) => {
  eventStream.unshift(envelope);
  if (eventStream.length > MAX_EVENTS) eventStream.pop();

  // Update metrics
  metrics.timestamps.push(Date.now());
  metrics.bySeverity[envelope.severity] = (metrics.bySeverity[envelope.severity] || 0) + 1;
  metrics.byAgent[envelope.emittedBy] = (metrics.byAgent[envelope.emittedBy] || 0) + 1;

  renderMetrics();
  renderEventStream();
});

// ── Agent actions ───────────────────────────────────────────────────────────
function agentEmit(agentIdx) {
  const entry = observers[agentIdx];
  const catInput = document.getElementById(`cat-${agentIdx}`);
  const sevSelect = document.getElementById(`sev-${agentIdx}`);
  const payloadInput = document.getElementById(`payload-${agentIdx}`);

  const category = catInput.value.trim() || entry.defaultCategory;
  const severity = sevSelect.value;
  let payload;
  try {
    payload = JSON.parse(payloadInput.value);
  } catch {
    payload = { message: payloadInput.value };
  }

  entry.observe.emit(category, payload, severity);
}

function toggleAutoEmit(agentIdx) {
  const entry = observers[agentIdx];
  const btn = document.getElementById(`auto-${agentIdx}`);
  if (entry.autoInterval) {
    clearInterval(entry.autoInterval);
    entry.autoInterval = null;
    if (btn) { btn.textContent = 'Auto-emit'; btn.classList.remove('btn-error'); btn.classList.add('btn-outline'); }
  } else {
    entry.autoInterval = setInterval(() => {
      const category = document.getElementById(`cat-${agentIdx}`).value.trim() || entry.defaultCategory;
      const severity = randomSeverity();
      const payload = randomPayload(category);
      entry.observe.emit(category, payload, severity);
    }, 1500);
    if (btn) { btn.textContent = 'Stop'; btn.classList.add('btn-error'); btn.classList.remove('btn-outline'); }
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderEventStream() {
  const tbody = document.getElementById('stream-tbody');
  if (!tbody) return;

  const filtered = eventStream.filter(env => {
    if (filterCategory && env.category !== filterCategory) return false;
    if (filterSeverity && env.severity !== filterSeverity) return false;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-base-content/30 py-6">No events yet — use agent controls or enable auto-emit</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.slice(0, 100).map(env => {
    const time = new Date(env.timestamp).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 1 });
    const agent = AGENTS.find(a => a.id === env.emittedBy);
    const agentLabel = agent ? agent.label : env.emittedBy;
    const agentColor = agent ? agent.color : 'badge-ghost';
    const sevBadge = SEVERITY_BADGE[env.severity] || 'badge-ghost';
    const payloadStr = JSON.stringify(env.payload);

    return `
      <tr class="hover fade-in">
        <td class="text-xs text-base-content/50 font-mono whitespace-nowrap">${time}</td>
        <td><span class="badge badge-sm ${agentColor}">${escHtml(agentLabel)}</span></td>
        <td class="font-mono text-sm">${escHtml(env.category)}</td>
        <td><span class="badge badge-sm ${sevBadge}">${env.severity}</span></td>
        <td class="font-mono text-xs max-w-xs truncate" title="${escHtml(payloadStr)}">${escHtml(payloadStr)}</td>
      </tr>`;
  }).join('');

  // Update count badge
  const countEl = document.getElementById('event-count');
  if (countEl) countEl.textContent = eventStream.length;
}

function renderMetrics() {
  const el = document.getElementById('metrics-panel');
  if (!el) return;

  // Calculate events/sec over rolling 10s window
  const now = Date.now();
  const cutoff = now - 10000;
  metrics.timestamps = metrics.timestamps.filter(t => t > cutoff);
  const eventsPerSec = metrics.timestamps.length > 0 ? (metrics.timestamps.length / 10).toFixed(1) : '0.0';

  // Severity badges
  const sevHtml = SEVERITIES.map(s => {
    const count = metrics.bySeverity[s] || 0;
    const badge = SEVERITY_BADGE[s] || 'badge-ghost';
    return `<span class="badge ${badge} badge-sm gap-1">${s} <span class="font-bold">${count}</span></span>`;
  }).join(' ');

  // Per-agent breakdown
  const agentHtml = Object.entries(metrics.byAgent).map(([agentId, count]) => {
    const agent = AGENTS.find(a => a.id === agentId);
    const label = agent ? agent.label : agentId;
    const color = agent ? agent.color : 'badge-ghost';
    return `<span class="badge ${color} badge-sm gap-1">${escHtml(label)} <span class="font-bold">${count}</span></span>`;
  }).join(' ');

  el.innerHTML = `
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-2">
        <span class="text-xs text-base-content/40 uppercase font-bold">Rate</span>
        <span class="badge badge-primary badge-lg font-mono">${eventsPerSec}/s</span>
      </div>
      <div class="divider divider-horizontal mx-0"></div>
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-base-content/40 uppercase font-bold">Severity</span>
        ${sevHtml}
      </div>
      <div class="divider divider-horizontal mx-0"></div>
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-base-content/40 uppercase font-bold">By Agent</span>
        ${agentHtml}
      </div>
    </div>
  `;
}

function render() {
  const agentPanels = AGENTS.map((a, i) => {
    const sevOptions = SEVERITIES.map(s =>
      `<option value="${s}" ${s === a.defaultSeverity ? 'selected' : ''}>${s}</option>`
    ).join('');

    const defaultPayload = JSON.stringify(randomPayload(a.defaultCategory));

    return `
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body gap-3 p-4">
        <div class="flex items-center gap-2">
          <span class="badge ${a.color}">${escHtml(a.label)}</span>
          <span class="text-xs text-base-content/40 font-mono">${escHtml(a.id)}</span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Category</span></label>
            <input id="cat-${i}" type="text" value="${a.defaultCategory}" class="input input-bordered input-sm w-full" />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Severity</span></label>
            <select id="sev-${i}" class="select select-bordered select-sm w-full">${sevOptions}</select>
          </div>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Payload (JSON)</span></label>
          <input id="payload-${i}" type="text" value='${defaultPayload}' class="input input-bordered input-sm w-full font-mono" />
        </div>
        <div class="flex gap-2">
          <button id="emit-${i}" class="btn btn-primary btn-sm flex-1">Emit</button>
          <button id="auto-${i}" class="btn btn-outline btn-sm flex-1">Auto-emit</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const sevFilterOptions = ['', ...SEVERITIES].map(s =>
    `<option value="${s}">${s || 'All severities'}</option>`
  ).join('');

  document.getElementById('app').innerHTML = `
  <div class="flex flex-col h-screen bg-base-100 text-base-content">

    <!-- Header -->
    <header class="flex items-center gap-3 px-5 py-3 bg-base-200 border-b border-base-300 shrink-0">
      <span class="text-xl font-bold text-primary">@nolag/agents</span>
      <span class="text-base-content/40 text-sm">Observe Pattern Demo</span>
    </header>

    <!-- Main content -->
    <div class="flex flex-1 min-h-0">

      <!-- Left: Agent panels -->
      <div class="w-80 shrink-0 flex flex-col gap-3 p-4 overflow-y-auto border-r border-base-300">
        <h2 class="text-sm font-bold uppercase tracking-widest text-base-content/40">Agent Emitters</h2>
        ${agentPanels}
      </div>

      <!-- Right: Observer dashboard -->
      <div class="flex-1 flex flex-col p-4 min-w-0">

        <!-- Metrics panel -->
        <div id="metrics-panel" class="bg-base-200 rounded-lg border border-base-300 p-3 mb-3">
          <div class="text-xs text-base-content/30">Waiting for events...</div>
        </div>

        <!-- Filter bar -->
        <div class="flex items-center gap-3 mb-3">
          <h2 class="text-sm font-bold uppercase tracking-widest text-base-content/40">Observer Dashboard</h2>
          <span id="event-count" class="badge badge-sm badge-primary">0</span>
          <div class="ml-auto flex items-center gap-2">
            <input id="filter-category" type="text" placeholder="Filter category..." class="input input-bordered input-sm w-40" />
            <select id="filter-severity" class="select select-bordered select-sm">${sevFilterOptions}</select>
            <button id="btn-clear" class="btn btn-ghost btn-sm">Clear</button>
          </div>
        </div>

        <!-- Event stream table -->
        <div class="flex-1 overflow-y-auto bg-base-200 rounded-lg border border-base-300">
          <table class="table table-sm w-full">
            <thead class="sticky top-0 bg-base-200 z-10">
              <tr class="text-base-content/50">
                <th class="w-24">Time</th>
                <th class="w-24">Agent</th>
                <th class="w-28">Category</th>
                <th class="w-24">Severity</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody id="stream-tbody">
              <tr><td colspan="5" class="text-center text-base-content/30 py-6">No events yet — use agent controls or enable auto-emit</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;

  // Bind agent events
  AGENTS.forEach((_, i) => {
    document.getElementById(`emit-${i}`).addEventListener('click', () => agentEmit(i));
    document.getElementById(`auto-${i}`).addEventListener('click', () => toggleAutoEmit(i));
    document.getElementById(`payload-${i}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') agentEmit(i); });
  });

  // Bind filter events
  document.getElementById('filter-category').addEventListener('input', (e) => {
    filterCategory = e.target.value.trim();
    renderEventStream();
  });
  document.getElementById('filter-severity').addEventListener('change', (e) => {
    filterSeverity = e.target.value;
    renderEventStream();
  });
  document.getElementById('btn-clear').addEventListener('click', () => {
    eventStream.length = 0;
    metrics.timestamps = [];
    metrics.bySeverity = { debug: 0, info: 0, warning: 0, error: 0, critical: 0 };
    metrics.byAgent = {};
    renderMetrics();
    renderEventStream();
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────
render();
