import { NoLagDash } from '@nolag/dash';

// --- State ---
let dash = null;
let activePanel = null;
let autoPublishInterval = null;
let isAutoPublishing = false;

const STREAMS = [
  { id: 'cpu', label: 'CPU %', unit: '%', tags: ['system'] },
  { id: 'memory', label: 'Memory %', unit: '%', tags: ['system'] },
  { id: 'requests', label: 'Requests/s', unit: 'req/s', tags: ['network'] },
  { id: 'errors', label: 'Errors/s', unit: 'err/s', tags: ['network'] },
];

const metricLatest = { cpu: null, memory: null, requests: null, errors: null };
const metricAgg = { cpu: null, memory: null, requests: null, errors: null };
const widgets = {};
let viewers = [];
let logEntries = [];

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
          <h2 class="card-title text-2xl">@nolag/dash SDK Demo</h2>
          <p class="text-base-content/60 text-sm">Live dashboard with real-time metrics, widgets, and data streams.</p>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">Token</span></label>
            <input id="inp-token" type="text" placeholder="Your NoLag token" class="input input-bordered w-full" />
          </div>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">Username</span></label>
            <input id="inp-username" type="text" placeholder="e.g. operator-1" value="operator-1" class="input input-bordered w-full" />
          </div>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">App Name</span></label>
            <input id="inp-appname" type="text" placeholder="e.g. dash-demo" value="dash-demo" class="input input-bordered w-full" />
          </div>
          <div id="connect-error" class="text-error text-sm hidden"></div>
          <button id="btn-connect" class="btn btn-primary w-full">Connect</button>
        </div>
      </div>
    </div>`;
}

function renderMain() {
  return `
    <div class="flex flex-col h-screen bg-base-100">
      <!-- Topbar -->
      <div class="flex items-center justify-between px-4 py-2 bg-base-200 border-b border-base-300">
        <span class="font-bold text-lg">@nolag/dash Demo</span>
        <div class="flex items-center gap-3">
          <span class="badge badge-success gap-1"><span class="w-2 h-2 rounded-full bg-success-content inline-block"></span>Connected</span>
          <button id="btn-disconnect" class="btn btn-sm btn-ghost text-error">Disconnect</button>
        </div>
      </div>
      <!-- Body -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Left sidebar -->
        <div class="w-52 flex-shrink-0 bg-base-200 border-r border-base-300 flex flex-col p-3 gap-4 overflow-y-auto">
          <div>
            <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Panels</div>
            ${(dash.panels || []).length === 0
              ? '<div class="text-xs text-base-content/40">No panels joined</div>'
              : (dash.panels || []).map(p => `
                <div class="flex items-center justify-between mb-1">
                  <button class="btn btn-xs btn-ghost text-left flex-1 ${activePanel && activePanel.name === p.name ? 'btn-active' : ''}" data-panel="${p.name}">${p.name}</button>
                  <button class="btn btn-xs btn-ghost text-error" data-leave-panel="${p.name}">x</button>
                </div>`).join('')
            }
            <div class="flex gap-1 mt-2">
              <input id="inp-join-panel" type="text" placeholder="panel name" class="input input-xs input-bordered flex-1" value="overview" />
              <button id="btn-join-panel" class="btn btn-xs btn-primary">Join</button>
            </div>
          </div>
          <div>
            <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Viewers Online</div>
            ${viewers.length === 0
              ? '<div class="text-xs text-base-content/40">None</div>'
              : viewers.map(v => `<div class="text-xs py-0.5 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-success inline-block"></span>${v.username || v.id || 'Unknown'}</div>`).join('')
            }
          </div>
        </div>

        <!-- Center -->
        <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          <!-- Metric cards -->
          <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
            ${STREAMS.map(s => `
              <div class="card bg-base-200 p-3">
                <div class="text-xs text-base-content/50 mb-1">${s.label}</div>
                <div class="text-2xl font-bold text-primary">${metricLatest[s.id] !== null ? Number(metricLatest[s.id]).toFixed(1) : '--'}</div>
                <div class="text-xs text-base-content/40">${s.unit}</div>
              </div>`).join('')
            }
          </div>

          <!-- Aggregation table -->
          <div class="card bg-base-200">
            <div class="card-body p-3">
              <div class="flex items-center justify-between mb-2">
                <h3 class="font-bold text-sm">Aggregations (last 30s)</h3>
                <button id="btn-refresh-agg" class="btn btn-xs btn-ghost" ${!activePanel ? 'disabled' : ''}>Refresh</button>
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

          <!-- Widget display -->
          <div class="card bg-base-200">
            <div class="card-body p-3">
              <div class="flex items-center justify-between mb-2">
                <h3 class="font-bold text-sm">Widgets</h3>
                <button id="btn-get-widgets" class="btn btn-xs btn-ghost" ${!activePanel ? 'disabled' : ''}>Fetch All</button>
              </div>
              <div class="flex flex-wrap gap-2">
                ${Object.keys(widgets).length === 0
                  ? '<div class="text-xs text-base-content/40">No widgets yet — publish one below</div>'
                  : Object.entries(widgets).map(([id, w]) => `
                    <div class="badge badge-outline gap-1 p-3">
                      <span class="font-mono text-xs text-primary">${id}</span>
                      <span class="text-xs">[${w.type || '?'}]</span>
                      <span class="text-xs text-base-content/60">${JSON.stringify(w.data).slice(0, 40)}</span>
                    </div>`).join('')
                }
              </div>
            </div>
          </div>

          <!-- Publish controls -->
          <div class="card bg-base-200">
            <div class="card-body p-3">
              <h3 class="font-bold text-sm mb-3">Publish Controls</h3>
              <div class="flex flex-wrap gap-3 items-end">
                <div class="form-control gap-1">
                  <label class="label py-0"><span class="label-text text-xs">Stream</span></label>
                  <select id="sel-stream" class="select select-bordered select-sm">
                    ${STREAMS.map(s => `<option value="${s.id}">${s.label}</option>`).join('')}
                  </select>
                </div>
                <div class="form-control gap-1">
                  <label class="label py-0"><span class="label-text text-xs">Value</span></label>
                  <input id="inp-metric-value" type="number" step="0.1" min="0" max="100" value="42" class="input input-bordered input-sm w-24" />
                </div>
                <button id="btn-publish-metric" class="btn btn-sm btn-primary" ${!activePanel ? 'disabled' : ''}>Publish Metric</button>
                <div class="divider divider-horizontal mx-0"></div>
                <div class="form-control gap-1">
                  <label class="label py-0"><span class="label-text text-xs">Widget ID</span></label>
                  <input id="inp-widget-id" type="text" value="status-card" placeholder="widget-id" class="input input-bordered input-sm w-32" />
                </div>
                <div class="form-control gap-1">
                  <label class="label py-0"><span class="label-text text-xs">Type</span></label>
                  <select id="sel-widget-type" class="select select-bordered select-sm">
                    <option value="stat">stat</option>
                    <option value="chart">chart</option>
                    <option value="gauge">gauge</option>
                    <option value="table">table</option>
                  </select>
                </div>
                <button id="btn-publish-widget" class="btn btn-sm btn-secondary" ${!activePanel ? 'disabled' : ''}>Publish Widget</button>
              </div>
              <div class="flex items-center gap-3 mt-3">
                <label class="label cursor-pointer gap-2">
                  <input id="chk-auto" type="checkbox" class="checkbox checkbox-primary checkbox-sm" ${isAutoPublishing ? 'checked' : ''} />
                  <span class="label-text text-sm">Auto-publish every 2s (random values)</span>
                </label>
                ${isAutoPublishing ? '<span class="badge badge-primary badge-sm animate-pulse">Running</span>' : ''}
              </div>
            </div>
          </div>
        </div>

        <!-- Right sidebar: event log -->
        <div class="w-64 flex-shrink-0 bg-base-200 border-l border-base-300 flex flex-col">
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

// --- Listeners ---
function attachListeners() {
  if (!dash || !dash.connected) {
    document.getElementById('btn-connect')?.addEventListener('click', handleConnect);
    document.getElementById('inp-token')?.addEventListener('keydown', e => e.key === 'Enter' && handleConnect());
    return;
  }

  document.getElementById('btn-disconnect')?.addEventListener('click', handleDisconnect);
  document.getElementById('btn-join-panel')?.addEventListener('click', handleJoinPanel);
  document.getElementById('inp-join-panel')?.addEventListener('keydown', e => e.key === 'Enter' && handleJoinPanel());
  document.getElementById('btn-publish-metric')?.addEventListener('click', handlePublishMetric);
  document.getElementById('btn-publish-widget')?.addEventListener('click', handlePublishWidget);
  document.getElementById('btn-refresh-agg')?.addEventListener('click', handleRefreshAgg);
  document.getElementById('btn-get-widgets')?.addEventListener('click', handleGetWidgets);
  document.getElementById('btn-clear-log')?.addEventListener('click', () => { logEntries = []; render(); });
  document.getElementById('chk-auto')?.addEventListener('change', e => {
    isAutoPublishing = e.target.checked;
    if (isAutoPublishing) startAutoPublish(); else stopAutoPublish();
    render();
  });

  document.querySelectorAll('[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = (dash.panels || []).find(x => x.name === btn.dataset.panel);
      if (p) { activePanel = p; render(); }
    });
  });

  document.querySelectorAll('[data-leave-panel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.leavePanel;
      addLog('action', `Leaving panel: ${name}`);
      await dash.leavePanel(name);
      if (activePanel && activePanel.name === name) activePanel = null;
      render();
    });
  });
}

// --- Handlers ---
async function handleConnect() {
  const token = document.getElementById('inp-token').value.trim();
  const username = document.getElementById('inp-username').value.trim() || 'operator-1';
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
      username,
      appName,
      debug: false,
      panels: ['overview'],
    });

    dash.on('connected', async () => {
      addLog('event', 'connected');
      // Auto-join the overview panel
      await joinPanel('overview');
      render();
    });

    dash.on('disconnected', reason => {
      addLog('error', `disconnected: ${reason || ''}`);
      stopAutoPublish();
      activePanel = null;
      render();
    });

    dash.on('reconnected', () => {
      addLog('event', 'reconnected');
      render();
    });

    dash.on('error', err => {
      addLog('error', `error: ${err?.message || err}`);
      render();
    });

    dash.on('viewerOnline', viewer => {
      addLog('event', `viewerOnline: ${viewer.username || viewer.id}`);
      viewers = [...viewers.filter(v => v.id !== viewer.id), viewer];
      render();
    });

    dash.on('viewerOffline', viewer => {
      addLog('event', `viewerOffline: ${viewer.username || viewer.id}`);
      viewers = viewers.filter(v => v.id !== viewer.id);
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
  const panel = await dash.joinPanel(name);

  panel.on('metric', point => {
    if (metricLatest.hasOwnProperty(point.streamId)) {
      metricLatest[point.streamId] = point.value;
    }
    addLog('event', `metric [${point.streamId}] = ${point.value} ${point.unit || ''}`);
    render();
  });

  panel.on('widgetUpdate', update => {
    widgets[update.widgetId] = { type: update.type, data: update.data, label: update.label };
    addLog('event', `widgetUpdate [${update.widgetId}] type=${update.type}`);
    render();
  });

  panel.on('viewerJoined', viewer => {
    addLog('event', `viewerJoined panel [${name}]: ${viewer.username || viewer.id}`);
    viewers = [...viewers.filter(v => v.id !== viewer.id), viewer];
    render();
  });

  panel.on('viewerLeft', viewer => {
    addLog('event', `viewerLeft panel [${name}]: ${viewer.username || viewer.id}`);
    viewers = viewers.filter(v => v.id !== viewer.id);
    render();
  });

  panel.on('replayStart', ({ count }) => {
    addLog('action', `replayStart: ${count} messages incoming`);
  });

  panel.on('replayEnd', ({ replayed }) => {
    addLog('action', `replayEnd: replayed ${replayed} messages`);
    refreshAggregations(panel);
  });

  activePanel = panel;
  return panel;
}

async function handleJoinPanel() {
  const name = document.getElementById('inp-join-panel')?.value.trim();
  if (!name || !dash) return;
  try {
    await joinPanel(name);
    render();
  } catch (err) {
    addLog('error', `joinPanel failed: ${err.message}`);
    render();
  }
}

async function handleDisconnect() {
  stopAutoPublish();
  addLog('action', 'Disconnecting...');
  await dash.disconnect();
  dash = null;
  activePanel = null;
  viewers = [];
  render();
}

async function handlePublishMetric() {
  if (!activePanel) return;
  const streamId = document.getElementById('sel-stream').value;
  const value = parseFloat(document.getElementById('inp-metric-value').value);
  const stream = STREAMS.find(s => s.id === streamId);
  try {
    await activePanel.publishMetric(streamId, value, { unit: stream.unit, tags: stream.tags });
    addLog('action', `publishMetric [${streamId}] = ${value}`);
    // Immediately fetch updated metrics
    const metrics = await activePanel.getMetrics(streamId);
    addLog('event', `getMetrics [${streamId}]: ${metrics?.length ?? 0} points`);
  } catch (err) {
    addLog('error', `publishMetric failed: ${err.message}`);
  }
  render();
}

async function handlePublishWidget() {
  if (!activePanel) return;
  const widgetId = document.getElementById('inp-widget-id').value.trim() || 'status-card';
  const type = document.getElementById('sel-widget-type').value;
  const data = { value: Math.round(Math.random() * 100), timestamp: Date.now() };
  const label = `${type} widget`;
  try {
    await activePanel.publishWidget(widgetId, type, data, label);
    addLog('action', `publishWidget [${widgetId}] type=${type}`);
    // Fetch the widget back
    const w = await activePanel.getWidget(widgetId);
    if (w) widgets[widgetId] = { type: w.type, data: w.data, label: w.label };
  } catch (err) {
    addLog('error', `publishWidget failed: ${err.message}`);
  }
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
      const agg = await panel.getAggregation(s.id, 30000);
      if (agg) metricAgg[s.id] = agg;
    } catch (_) {}
  }
}

async function handleGetWidgets() {
  if (!activePanel) return;
  try {
    const all = await activePanel.getWidgets();
    addLog('action', `getWidgets: ${all?.length ?? 0} widgets`);
    if (all) {
      for (const w of all) {
        widgets[w.widgetId] = { type: w.type, data: w.data, label: w.label };
      }
    }
    // Also fetch panel viewers
    const panelViewers = await activePanel.getViewers();
    addLog('action', `getViewers: ${panelViewers?.length ?? 0} viewers in panel`);
  } catch (err) {
    addLog('error', `getWidgets failed: ${err.message}`);
  }
  render();
}

function startAutoPublish() {
  if (autoPublishInterval) return;
  autoPublishInterval = setInterval(async () => {
    if (!activePanel || !dash?.connected) return;
    for (const s of STREAMS) {
      const value = parseFloat((Math.random() * 100).toFixed(2));
      try {
        await activePanel.publishMetric(s.id, value, { unit: s.unit, tags: s.tags });
      } catch (_) {}
    }
    // Refresh aggregations every other tick
    await refreshAggregations(activePanel);
    render();
  }, 2000);
}

function stopAutoPublish() {
  if (autoPublishInterval) {
    clearInterval(autoPublishInterval);
    autoPublishInterval = null;
  }
  isAutoPublishing = false;
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