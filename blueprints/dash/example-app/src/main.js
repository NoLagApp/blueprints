/**
 * @nolag/dash SDK — Interactive Demo
 *
 * Demonstrates NoLag's real-time dashboard with FILTERS:
 *   - Each connected user auto-publishes their system stats (cpu, memory, etc.)
 *   - All users appear in the sidebar with toggle switches
 *   - Toggling a user ON adds their username as a NoLag filter → server starts delivering their metrics
 *   - Toggling a user OFF removes the filter → server stops delivering their metrics
 *   - This is SERVER-SIDE filtering — unsubscribed metrics never reach the client
 *
 * Uses DaisyUI v5 + Tailwind v4 (CDN).
 */

import { NoLagDash } from '@nolag/dash';

// --- State ---
let dash = null;
let activePanel = null;
let autoPublishInterval = null;
let localUsername = '';

// Track online viewers: { viewerId, username, actorTokenId }
let viewers = [];
// Which usernames we're filtering for (receiving metrics from)
const enabledFilters = new Set();
// Latest metric values per user per stream: { 'alice': { cpu: 72.3, memory: 45.1, ... } }
const userMetrics = {};
// Aggregation data per stream (own stats only)
const metricAgg = {};
let logEntries = [];

const STREAMS = [
  { id: 'cpu', label: 'CPU %', unit: '%' },
  { id: 'memory', label: 'Memory %', unit: '%' },
  { id: 'requests', label: 'Req/s', unit: 'req/s' },
  { id: 'errors', label: 'Errors/s', unit: 'err/s' },
];

// --- Render ---
function render() {
  document.getElementById('app').innerHTML = dash && dash.connected ? renderMain() : renderConnect();
  attachListeners();
}

function renderConnect() {
  return `
    <div class="flex items-center justify-center min-h-screen bg-base-100">
      <div class="card bg-base-200 shadow-xl w-full max-w-md">
        <div class="card-body gap-4">
          <h2 class="card-title text-2xl">@nolag/dash</h2>
          <p class="text-base-content/60 text-sm">Real-time dashboard with <strong>NoLag Filters</strong>. Each user publishes system stats. Toggle users ON/OFF to control which metrics you receive — filtering happens server-side.</p>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">Token</span></label>
            <input id="inp-token" type="text" placeholder="Your NoLag token" class="input input-bordered w-full" />
          </div>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">Username</span></label>
            <input id="inp-username" type="text" placeholder="e.g. alice" value="operator-${Math.random().toString(36).slice(2, 5)}" class="input input-bordered w-full" />
          </div>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">App Slug</span></label>
            <input id="inp-appname" type="text" placeholder="e.g. dash-demo" value="my-nolag-dash-sdk-demo" class="input input-bordered w-full" />
          </div>
          <div id="connect-error" class="text-error text-sm hidden"></div>
          <button id="btn-connect" class="btn btn-primary w-full">Connect</button>
        </div>
      </div>
    </div>`;
}

function renderMain() {
  // Collect all known usernames (self + viewers)
  const allUsers = [localUsername, ...viewers.map(v => v.username || v.viewerId)].filter(Boolean);
  const uniqueUsers = [...new Set(allUsers)];

  return `
    <div class="flex flex-col h-screen bg-base-100">
      <!-- Topbar -->
      <div class="flex items-center justify-between px-4 py-2 bg-base-200 border-b border-base-300">
        <div class="flex items-center gap-3">
          <span class="font-bold text-lg">@nolag/dash</span>
          <span class="badge badge-primary badge-sm">${localUsername}</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="badge badge-success gap-1"><span class="w-2 h-2 rounded-full bg-success-content inline-block"></span>Connected</span>
          <button id="btn-disconnect" class="btn btn-sm btn-ghost text-error">Disconnect</button>
        </div>
      </div>

      <!-- Body -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Left sidebar: Users + Filter toggles -->
        <div class="w-64 flex-shrink-0 bg-base-200 border-r border-base-300 flex flex-col p-3 gap-4 overflow-y-auto">

          <div>
            <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Users Online</div>
            <div class="flex flex-col gap-1">
              ${uniqueUsers.map(username => {
                const isSelf = username === localUsername;
                const isEnabled = enabledFilters.has(username);
                return `
                  <div class="flex items-center justify-between py-1 px-2 rounded ${isEnabled || isSelf ? 'bg-base-300/50' : ''}">
                    <div class="flex items-center gap-2">
                      <span class="w-2 h-2 rounded-full ${isSelf ? 'bg-primary' : 'bg-success'} inline-block"></span>
                      <span class="text-sm">${username}${isSelf ? ' (you)' : ''}</span>
                    </div>
                    ${isSelf
                      ? '<span class="badge badge-ghost badge-xs">publishing</span>'
                      : `<input type="checkbox" class="toggle toggle-primary toggle-xs" data-filter-user="${username}" ${isEnabled ? 'checked' : ''} />`
                    }
                  </div>`;
              }).join('')}
              ${uniqueUsers.length <= 1 ? '<div class="text-xs text-base-content/40 mt-1">Open another tab to see filters in action</div>' : ''}
            </div>
          </div>

          <div class="divider my-0"></div>

          <div>
            <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Active Filters</div>
            <div class="flex flex-wrap gap-1">
              ${enabledFilters.size === 0
                ? '<span class="text-xs text-base-content/40">No filters — toggle a user to receive their metrics</span>'
                : [...enabledFilters].map(f => `<span class="badge badge-primary badge-sm gap-1">${f}</span>`).join('')
              }
            </div>
            <div class="text-xs text-base-content/40 mt-2">Filters are applied <strong>server-side</strong> — only matching metrics are sent over the wire.</div>
          </div>

          <div class="divider my-0"></div>

          <div>
            <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Your Stats (Publishing)</div>
            <div class="flex flex-col gap-1">
              ${STREAMS.map(s => {
                const val = userMetrics[localUsername]?.[s.id];
                return `<div class="flex items-center justify-between text-xs">
                  <span class="text-base-content/60">${s.label}</span>
                  <span class="font-mono text-primary">${val !== undefined ? Number(val).toFixed(1) : '--'} ${s.unit}</span>
                </div>`;
              }).join('')}
            </div>
            <div class="badge badge-success badge-xs mt-2 animate-pulse">Auto-publishing every 2s</div>
          </div>
        </div>

        <!-- Center: Dashboard -->
        <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          <!-- Per-user metric cards -->
          ${renderUserDashboards(uniqueUsers)}

          <!-- Aggregation table -->
          <div class="card bg-base-200">
            <div class="card-body p-3">
              <div class="flex items-center justify-between mb-2">
                <h3 class="font-bold text-sm">Aggregations (last 30s)</h3>
                <button id="btn-refresh-agg" class="btn btn-xs btn-ghost">Refresh</button>
              </div>
              <div class="overflow-x-auto">
                <table class="table table-xs w-full">
                  <thead><tr><th>Stream</th><th>Min</th><th>Max</th><th>Avg</th><th>Count</th></tr></thead>
                  <tbody>
                    ${STREAMS.map(s => {
                      const a = metricAgg[s.id];
                      return `<tr>
                        <td class="font-mono">${s.id}</td>
                        <td>${a ? Number(a.min).toFixed(1) : '--'}</td>
                        <td>${a ? Number(a.max).toFixed(1) : '--'}</td>
                        <td>${a ? Number(a.avg).toFixed(1) : '--'}</td>
                        <td>${a ? a.count : '--'}</td>
                      </tr>`;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- Right sidebar: event log -->
        <div class="w-72 flex-shrink-0 bg-base-200 border-l border-base-300 flex flex-col">
          <div class="flex items-center justify-between px-3 py-2 border-b border-base-300">
            <span class="text-xs font-bold text-base-content/50 uppercase">Event Log</span>
            <button id="btn-clear-log" class="btn btn-xs btn-ghost">Clear</button>
          </div>
          <div id="log-container" class="flex-1 overflow-y-auto py-1">
            ${logEntries.slice(-100).reverse().map(e =>
              `<div class="log-entry ${e.type} fade-in"><span class="text-base-content/40">${e.time}</span> ${e.msg}</div>`
            ).join('')}
          </div>
        </div>
      </div>
    </div>`;
}

function renderUserDashboards(users) {
  // Show metric cards for each user whose filter is enabled (or self)
  const visibleUsers = users.filter(u => u === localUsername || enabledFilters.has(u));

  if (visibleUsers.length === 0) {
    return `<div class="card bg-base-200 p-8 text-center">
      <div class="text-base-content/40 text-sm">Toggle a user in the sidebar to see their live metrics.</div>
    </div>`;
  }

  return visibleUsers.map(username => {
    const isSelf = username === localUsername;
    const data = userMetrics[username] || {};
    return `
      <div class="card bg-base-200">
        <div class="card-body p-3">
          <div class="flex items-center gap-2 mb-2">
            <span class="w-2.5 h-2.5 rounded-full ${isSelf ? 'bg-primary' : 'bg-success'} inline-block"></span>
            <h3 class="font-bold text-sm">${username}${isSelf ? ' (you)' : ''}</h3>
            ${!isSelf ? `<span class="badge badge-primary badge-xs ml-auto">filtered</span>` : '<span class="badge badge-ghost badge-xs ml-auto">local</span>'}
          </div>
          <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
            ${STREAMS.map(s => `
              <div class="bg-base-300/50 rounded-lg p-3">
                <div class="text-xs text-base-content/50 mb-1">${s.label}</div>
                <div class="text-2xl font-bold ${isSelf ? 'text-primary' : 'text-success'}">${data[s.id] !== undefined ? Number(data[s.id]).toFixed(1) : '--'}</div>
                <div class="text-xs text-base-content/40">${s.unit}</div>
              </div>`).join('')}
          </div>
        </div>
      </div>`;
  }).join('');
}

// --- Listeners ---
function attachListeners() {
  if (!dash || !dash.connected) {
    document.getElementById('btn-connect')?.addEventListener('click', handleConnect);
    document.getElementById('inp-token')?.addEventListener('keydown', e => e.key === 'Enter' && handleConnect());
    return;
  }

  document.getElementById('btn-disconnect')?.addEventListener('click', handleDisconnect);
  document.getElementById('btn-refresh-agg')?.addEventListener('click', handleRefreshAgg);
  document.getElementById('btn-clear-log')?.addEventListener('click', () => { logEntries = []; render(); });

  // Filter toggles
  document.querySelectorAll('[data-filter-user]').forEach(toggle => {
    toggle.addEventListener('change', (e) => {
      const username = e.target.dataset.filterUser;
      if (e.target.checked) {
        enableFilter(username);
      } else {
        disableFilter(username);
      }
    });
  });
}

// --- Filter management ---
function enableFilter(username) {
  enabledFilters.add(username);
  if (activePanel) {
    activePanel.addMetricFilters([username]);
    addLog('filter', `addMetricFilters(["${username}"]) → server will deliver ${username}'s metrics`);
  }
  render();
}

function disableFilter(username) {
  enabledFilters.delete(username);
  if (activePanel) {
    if (enabledFilters.size === 0) {
      // No filters left — use setMetricFilters with placeholder to avoid wildcard
      activePanel.setMetricFilters(['__none__']);
      addLog('filter', `setMetricFilters(["__none__"]) → no users selected, receiving nothing`);
    } else {
      activePanel.removeMetricFilters([username]);
      addLog('filter', `removeMetricFilters(["${username}"]) → server stops delivering ${username}'s metrics`);
    }
  }
  // Clear their metrics from display
  delete userMetrics[username];
  render();
}

// --- Handlers ---
async function handleConnect() {
  const token = document.getElementById('inp-token').value.trim();
  localUsername = document.getElementById('inp-username').value.trim() || 'operator-1';
  const appName = document.getElementById('inp-appname').value.trim() || 'dash-demo';
  const errEl = document.getElementById('connect-error');

  if (!token) {
    errEl.textContent = 'Token is required.';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    dash = new NoLagDash(token, {
      username: localUsername,
      appName,
      debug: false,
      url: 'wss://broker.dev.nolag.app/ws',
    });

    dash.on('connected', async () => {
      addLog('event', 'Connected to NoLag');
      await joinPanel('overview');
      startAutoPublish();
      render();
    });

    dash.on('disconnected', reason => {
      addLog('error', `Disconnected: ${reason || ''}`);
      stopAutoPublish();
      activePanel = null;
      render();
    });

    dash.on('reconnected', () => {
      addLog('event', 'Reconnected');
      render();
    });

    dash.on('error', err => {
      addLog('error', `Error: ${err?.message || err}`);
    });

    dash.on('viewerOnline', viewer => {
      const name = viewer.username || viewer.viewerId;
      addLog('event', `${name} came online`);
      viewers = [...viewers.filter(v => v.viewerId !== viewer.viewerId), viewer];
      render();
    });

    dash.on('viewerOffline', viewer => {
      const name = viewer.username || viewer.viewerId;
      addLog('event', `${name} went offline`);
      viewers = viewers.filter(v => v.viewerId !== viewer.viewerId);
      // Clean up their filter and metrics
      if (name && enabledFilters.has(name)) {
        enabledFilters.delete(name);
      }
      delete userMetrics[name];
      render();
    });

    await dash.connect();
  } catch (err) {
    errEl.textContent = `Connection failed: ${err.message}`;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

async function joinPanel(name) {
  addLog('action', `Joining panel: ${name}`);
  // Subscribe with empty filters — receive no metrics until user toggles someone ON
  // Own metrics are stored locally, not via the subscription
  const panel = dash.joinPanel(name, { metricFilters: [] });
  addLog('filter', 'Subscribed to metrics with empty filters (only local stats visible)');

  panel.on('metric', (point) => {
    const fromUser = point.tags?.username;
    addLog('event', `metric from ${fromUser || '?'}: ${point.streamId}=${point.value}`);
    if (fromUser && fromUser !== localUsername) {
      if (!userMetrics[fromUser]) userMetrics[fromUser] = {};
      userMetrics[fromUser][point.streamId] = point.value;
      render();
    }
  });

  panel.on('viewerJoined', viewer => {
    addLog('event', `${viewer.username || viewer.viewerId} joined panel`);
    viewers = [...viewers.filter(v => v.viewerId !== viewer.viewerId), viewer];
    render();
  });

  panel.on('viewerLeft', viewer => {
    addLog('event', `${viewer.username || viewer.viewerId} left panel`);
    viewers = viewers.filter(v => v.viewerId !== viewer.viewerId);
    render();
  });

  panel.on('replayStart', ({ count }) => addLog('action', `Replaying ${count} messages`));
  panel.on('replayEnd', ({ replayed }) => {
    addLog('action', `Replayed ${replayed} messages`);
    refreshAggregations(panel);
  });

  activePanel = panel;
  return panel;
}

async function handleDisconnect() {
  stopAutoPublish();
  addLog('action', 'Disconnecting...');
  dash.disconnect();
  dash = null;
  activePanel = null;
  viewers = [];
  enabledFilters.clear();
  Object.keys(userMetrics).forEach(k => delete userMetrics[k]);
  render();
}

async function handleRefreshAgg() {
  if (!activePanel) return;
  await refreshAggregations(activePanel);
  render();
}

async function refreshAggregations(panel) {
  for (const s of STREAMS) {
    try {
      const agg = panel.getAggregation(s.id, 30000);
      if (agg) metricAgg[s.id] = agg;
    } catch (_) {}
  }
}

// --- Auto-publish own stats ---
function startAutoPublish() {
  if (autoPublishInterval) return;
  // Initialize own metrics
  userMetrics[localUsername] = {};

  autoPublishInterval = setInterval(() => {
    if (!activePanel || !dash?.connected) return;

    for (const s of STREAMS) {
      let value;
      switch (s.id) {
        case 'cpu': value = 30 + Math.random() * 50; break;
        case 'memory': value = 40 + Math.random() * 40; break;
        case 'requests': value = Math.random() * 200; break;
        case 'errors': value = Math.random() * 5; break;
        default: value = Math.random() * 100;
      }
      value = parseFloat(value.toFixed(1));

      // Store locally
      userMetrics[localUsername][s.id] = value;

      // Publish with our username as the filter value
      // Other users who have addMetricFilters([ourUsername]) will receive this
      activePanel.publishMetric(s.id, value, {
        unit: s.unit,
        tags: { username: localUsername },
        filter: localUsername,
      });
    }

    refreshAggregations(activePanel);
    render();
  }, 2000);

  addLog('action', `Auto-publishing metrics with filter: "${localUsername}"`);
}

function stopAutoPublish() {
  if (autoPublishInterval) {
    clearInterval(autoPublishInterval);
    autoPublishInterval = null;
  }
}

// --- Utils ---
function addLog(type, msg) {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  logEntries.push({ type, msg, time });
  if (logEntries.length > 200) logEntries.shift();
}

// --- Boot ---
render();
