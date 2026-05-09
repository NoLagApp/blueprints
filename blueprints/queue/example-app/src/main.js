import { NoLagQueue } from '@nolag/queue';

// ─── State ───────────────────────────────────────────────────────────────────
let queue = null;
let activeRoom = null;
let activeQueueName = null;
let selectedJobId = null;
const roomCache = {};
const logs = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addLog(type, msg) {
  logs.unshift({ type, msg, time: ts() });
  if (logs.length > 200) logs.pop();
  renderLog();
}

function safeJson(str, fallback = {}) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function shortId(id) {
  return String(id).length > 12 ? String(id).slice(0, 12) + '…' : id;
}

function statusBadge(connected) {
  return connected
    ? '<span class="badge badge-success badge-sm gap-1"><span class="inline-block w-1.5 h-1.5 rounded-full bg-current"></span>Connected</span>'
    : '<span class="badge badge-error badge-sm gap-1"><span class="inline-block w-1.5 h-1.5 rounded-full bg-current"></span>Disconnected</span>';
}

function priorityBadge(priority) {
  const map = {
    critical: 'badge-error',
    high: 'badge-warning',
    normal: 'badge-info',
    low: 'badge-ghost',
  };
  const cls = map[priority] || 'badge-ghost';
  return `<span class="badge badge-xs ${cls}">${priority || 'normal'}</span>`;
}

function statusBadgeJob(status) {
  const map = {
    pending: 'badge-warning',
    active: 'badge-info',
    completed: 'badge-success',
    failed: 'badge-error',
  };
  const cls = map[status] || 'badge-ghost';
  return `<span class="badge badge-xs ${cls}">${status}</span>`;
}

function progressBar(pct) {
  const val = Math.max(0, Math.min(100, pct || 0));
  return `<div class="flex items-center gap-1.5"><progress class="progress progress-primary w-16 h-1.5" value="${val}" max="100"></progress><span class="text-xs text-base-content/50">${val}%</span></div>`;
}

// ─── Render: shell ───────────────────────────────────────────────────────────
function renderShell() {
  document.getElementById('app').innerHTML = `
    <div class="flex flex-col h-screen bg-base-100 text-base-content">
      <!-- Topbar -->
      <header class="flex items-center justify-between px-5 py-3 bg-base-200 border-b border-base-300 shrink-0">
        <div class="flex items-center gap-3">
          <span class="text-xl font-bold text-primary">@nolag/queue</span>
          <span class="text-base-content/40 text-sm">SDK Demo</span>
        </div>
        <div id="status-badge">${statusBadge(false)}</div>
      </header>

      <!-- Body -->
      <div class="flex flex-1 min-h-0">
        <!-- Left sidebar -->
        <aside class="w-56 shrink-0 flex flex-col bg-base-200 border-r border-base-300">
          <div class="px-4 pt-4 pb-2">
            <p class="text-xs font-semibold uppercase tracking-widest text-base-content/40 mb-2">Queues</p>
            <ul id="queue-list" class="menu menu-xs p-0 gap-1"></ul>
          </div>
          <div class="divider my-1 mx-4"></div>
          <div class="px-4 pb-4 flex-1 min-h-0 overflow-y-auto">
            <p class="text-xs font-semibold uppercase tracking-widest text-base-content/40 mb-2">Online Workers</p>
            <ul id="worker-list" class="space-y-1 text-xs"></ul>
          </div>
        </aside>

        <!-- Center -->
        <main class="flex-1 flex flex-col min-w-0 overflow-y-auto p-5 gap-5">
          <!-- Connect panel -->
          <section id="connect-panel" class="card bg-base-200 border border-base-300">
            <div class="card-body p-4">
              <h2 class="card-title text-sm">Connect</h2>
              <div class="grid grid-cols-4 gap-3">
                <div class="form-control col-span-2">
                  <label class="label py-0.5"><span class="label-text text-xs">Token</span></label>
                  <input id="inp-token" type="text" placeholder="Your NoLag token" class="input input-sm input-bordered w-full" />
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Role</span></label>
                  <select id="inp-role" class="select select-sm select-bordered w-full">
                    <option value="producer">producer</option>
                    <option value="worker">worker</option>
                    <option value="monitor">monitor</option>
                  </select>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Concurrency</span></label>
                  <input id="inp-concurrency" type="number" min="1" max="20" value="2" class="input input-sm input-bordered w-full" />
                </div>
              </div>
              <div class="form-control mt-1 w-48">
                <label class="label py-0.5"><span class="label-text text-xs">App Slug</span></label>
                <input id="inp-appname" type="text" placeholder="nolag-queue-demo" class="input input-sm input-bordered w-full" />
              </div>
              <div class="flex gap-2 mt-1">
                <button id="btn-connect" class="btn btn-primary btn-sm">Connect</button>
                <button id="btn-disconnect" class="btn btn-outline btn-sm" disabled>Disconnect</button>
              </div>
            </div>
          </section>

          <!-- Add job form -->
          <section id="add-job-panel" class="card bg-base-200 border border-base-300">
            <div class="card-body p-4">
              <h2 class="card-title text-sm">Add Job</h2>
              <div class="grid grid-cols-3 gap-3">
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Job Type</span></label>
                  <input id="inp-job-type" type="text" placeholder="resize-image" class="input input-sm input-bordered w-full" />
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Priority</span></label>
                  <select id="inp-priority" class="select select-sm select-bordered w-full">
                    <option value="low">low</option>
                    <option value="normal" selected>normal</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </select>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Payload (JSON)</span></label>
                  <input id="inp-payload" type="text" placeholder='{"url": "https://example.com/img.jpg"}' class="input input-sm input-bordered w-full font-mono" />
                </div>
              </div>
              <button id="btn-add-job" class="btn btn-primary btn-sm mt-1 w-fit" disabled>Add Job</button>
            </div>
          </section>

          <!-- Queue stats bar -->
          <div id="stats-bar" class="grid grid-cols-3 gap-3">
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-3 text-center">
                <div class="text-2xl font-bold text-warning" id="stat-pending">0</div>
                <div class="text-xs text-base-content/50 uppercase tracking-wider">Pending</div>
              </div>
            </div>
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-3 text-center">
                <div class="text-2xl font-bold text-info" id="stat-active">0</div>
                <div class="text-xs text-base-content/50 uppercase tracking-wider">Active</div>
              </div>
            </div>
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-3 text-center">
                <div class="text-2xl font-bold text-success" id="stat-completed">0</div>
                <div class="text-xs text-base-content/50 uppercase tracking-wider">Completed</div>
              </div>
            </div>
          </div>

          <!-- Jobs table -->
          <section class="card bg-base-200 border border-base-300">
            <div class="card-body p-4">
              <div class="flex items-center justify-between mb-2">
                <h2 class="card-title text-sm">Jobs <span id="queue-label" class="text-base-content/40 font-normal text-xs">— select a queue</span></h2>
                <div class="flex gap-2">
                  <select id="inp-filter-status" class="select select-xs select-bordered">
                    <option value="">All statuses</option>
                    <option value="pending">pending</option>
                    <option value="active">active</option>
                    <option value="completed">completed</option>
                    <option value="failed">failed</option>
                  </select>
                  <button id="btn-refresh-jobs" class="btn btn-ghost btn-xs" disabled>Refresh</button>
                </div>
              </div>
              <div class="overflow-x-auto">
                <table class="table table-xs w-full">
                  <thead>
                    <tr class="text-base-content/50">
                      <th>ID</th><th>Type</th><th>Priority</th><th>Status</th><th>Progress</th><th>Attempts</th><th>Claimed By</th><th></th>
                    </tr>
                  </thead>
                  <tbody id="jobs-tbody"></tbody>
                </table>
              </div>
            </div>
          </section>

          <!-- Job actions panel -->
          <section id="job-actions" class="card bg-base-200 border border-base-300 hidden">
            <div class="card-body p-4">
              <h2 class="card-title text-sm">Job Actions — <span id="action-job-id" class="text-primary font-mono"></span></h2>
              <div id="action-job-detail" class="text-xs text-base-content/60 font-mono mb-3"></div>
              <div class="flex flex-wrap gap-3 items-end">
                <button id="btn-claim-job" class="btn btn-primary btn-sm">Claim</button>
                <div class="flex items-center gap-2">
                  <label class="text-xs text-base-content/60">Progress</label>
                  <input id="inp-progress" type="range" min="0" max="100" value="0" class="range range-xs range-primary w-32" />
                  <span id="progress-val" class="text-xs w-8">0%</span>
                  <button id="btn-report-progress" class="btn btn-outline btn-sm">Report</button>
                </div>
                <button id="btn-complete-job" class="btn btn-success btn-sm">Complete</button>
                <button id="btn-fail-job" class="btn btn-error btn-sm">Fail</button>
              </div>
            </div>
          </section>
        </main>

        <!-- Right sidebar: event log -->
        <aside class="w-72 shrink-0 flex flex-col bg-base-200 border-l border-base-300">
          <div class="flex items-center justify-between px-4 pt-4 pb-2">
            <p class="text-xs font-semibold uppercase tracking-widest text-base-content/40">Event Log</p>
            <button id="btn-clear-log" class="btn btn-ghost btn-xs">Clear</button>
          </div>
          <ul id="event-log" class="flex-1 overflow-y-auto px-2 pb-4 space-y-0.5"></ul>
        </aside>
      </div>
    </div>
  `;
  bindStaticEvents();
  renderQueueList();
  renderWorkerList();
  renderJobTable();
  renderLog();
}

// ─── Render: queue list ───────────────────────────────────────────────────────
function renderQueueList() {
  const el = document.getElementById('queue-list');
  if (!el) return;
  const names = ['image-processing', 'email-dispatch'];
  el.innerHTML = names.map(name => {
    const active = name === activeQueueName;
    const room = roomCache[name];
    const pending = room ? (room.pendingCount ?? 0) : 0;
    return `
      <li>
        <a data-queue="${name}" class="flex justify-between ${active ? 'active' : ''}">
          <span class="truncate">${name}</span>
          <span class="badge badge-sm ${active ? 'badge-primary' : 'badge-ghost'}">${pending}</span>
        </a>
      </li>`;
  }).join('');
  el.querySelectorAll('[data-queue]').forEach(a => {
    a.addEventListener('click', () => switchQueue(a.dataset.queue));
  });
}

// ─── Render: worker list ──────────────────────────────────────────────────────
function renderWorkerList() {
  const el = document.getElementById('worker-list');
  if (!el) return;
  const workers = queue ? queue.getOnlineWorkers() : [];
  if (!workers.length) {
    el.innerHTML = '<li class="text-base-content/30 italic">None online</li>';
    return;
  }
  el.innerHTML = workers.map(w => `
    <li class="flex items-center gap-1.5 py-0.5">
      <span class="w-1.5 h-1.5 rounded-full bg-success shrink-0"></span>
      <span class="truncate flex-1">${w.id || 'worker'}</span>
      <span class="badge badge-xs badge-outline">${w.role || 'worker'}</span>
    </li>`).join('');
}

// ─── Render: stats bar ────────────────────────────────────────────────────────
function renderStats() {
  if (!activeRoom) {
    ['pending', 'active', 'completed'].forEach(k => {
      const el = document.getElementById(`stat-${k}`);
      if (el) el.textContent = '0';
    });
    return;
  }
  const jobs = activeRoom.getJobs({});
  const counts = { pending: 0, active: 0, completed: 0, failed: 0 };
  jobs.forEach(j => { if (counts[j.status] !== undefined) counts[j.status]++; });
  document.getElementById('stat-pending').textContent = activeRoom.pendingCount ?? counts.pending;
  document.getElementById('stat-active').textContent = activeRoom.activeCount ?? counts.active;
  document.getElementById('stat-completed').textContent = counts.completed;
}

// ─── Render: job table ────────────────────────────────────────────────────────
function renderJobTable() {
  const tbody = document.getElementById('jobs-tbody');
  const label = document.getElementById('queue-label');
  if (!tbody) return;
  if (!activeRoom) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-base-content/30 italic py-6">Select a queue to view jobs</td></tr>';
    return;
  }
  if (label) label.textContent = `— ${activeQueueName}`;
  const filterEl = document.getElementById('inp-filter-status');
  const filter = filterEl ? filterEl.value : '';
  let jobs = activeRoom.getJobs({});
  if (filter) jobs = jobs.filter(j => j.status === filter);
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-base-content/30 italic py-6">No jobs</td></tr>';
    return;
  }
  tbody.innerHTML = jobs.map(job => {
    const sel = job.id === selectedJobId ? 'bg-base-300' : '';
    return `
      <tr class="hover cursor-pointer ${sel}" data-job-id="${job.id}">
        <td class="font-mono">${shortId(job.id)}</td>
        <td>${job.type || '—'}</td>
        <td>${priorityBadge(job.priority)}</td>
        <td>${statusBadgeJob(job.status)}</td>
        <td>${progressBar(job.progress)}</td>
        <td>${job.attempts ?? 0}</td>
        <td class="font-mono text-xs">${job.claimedBy ? shortId(job.claimedBy) : '—'}</td>
        <td><button class="btn btn-ghost btn-xs" data-select-job="${job.id}">Select</button></td>
      </tr>`;
  }).join('');
  tbody.querySelectorAll('[data-select-job]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); selectJob(btn.dataset.selectJob); });
  });
  tbody.querySelectorAll('tr[data-job-id]').forEach(row => {
    row.addEventListener('click', () => selectJob(row.dataset.jobId));
  });
}

// ─── Render: job actions ──────────────────────────────────────────────────────
function renderJobActions() {
  const panel = document.getElementById('job-actions');
  if (!panel) return;
  if (!selectedJobId || !activeRoom) {
    panel.classList.add('hidden');
    return;
  }
  const job = activeRoom.getJob(selectedJobId);
  if (!job) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  document.getElementById('action-job-id').textContent = job.id;
  document.getElementById('action-job-detail').textContent =
    `type: ${job.type} | status: ${job.status} | priority: ${job.priority} | attempts: ${job.attempts ?? 0}`;
  // Only update slider if user isn't actively dragging it
  const progressInput = document.getElementById('inp-progress');
  if (progressInput && document.activeElement !== progressInput) {
    progressInput.value = job.progress || 0;
    const progressVal = document.getElementById('progress-val');
    if (progressVal) progressVal.textContent = `${job.progress || 0}%`;
  }
}

// ─── Render: log ─────────────────────────────────────────────────────────────
function renderLog() {
  const el = document.getElementById('event-log');
  if (!el) return;
  if (!logs.length) {
    el.innerHTML = '<li class="text-base-content/30 italic text-xs px-2 pt-2">No events yet</li>';
    return;
  }
  el.innerHTML = logs.map(l => `
    <li class="log-entry ${l.type} fade-in">
      <span class="text-base-content/30">${l.time}</span>
      <span class="ml-1">${l.msg}</span>
    </li>`).join('');
}

// ─── Actions ─────────────────────────────────────────────────────────────────
async function switchQueue(name) {
  if (!queue || !queue.connected) return;
  if (activeQueueName === name && activeRoom) {
    renderQueueList();
    renderJobTable();
    return;
  }
  if (activeRoom && activeQueueName) {
    try { await queue.leaveQueue(activeQueueName); } catch {}
    activeRoom = null;
  }
  activeQueueName = name;
  selectedJobId = null;
  addLog('action', `Joining queue "${name}"`);
  try {
    const room = await queue.joinQueue(name);
    roomCache[name] = room;
    activeRoom = room;
    bindRoomEvents(room, name);
    addLog('event', `Joined queue "${name}"`);
    const btnAdd = document.getElementById('btn-add-job');
    if (btnAdd) btnAdd.disabled = false;
    const btnRefresh = document.getElementById('btn-refresh-jobs');
    if (btnRefresh) btnRefresh.disabled = false;
  } catch (err) {
    addLog('error', `joinQueue error: ${err.message}`);
  }
  renderQueueList();
  renderJobTable();
  renderStats();
  renderJobActions();
}

function bindRoomEvents(room, name) {
  room.on('jobAdded', job => {
    addLog('event', `[${name}] jobAdded: ${job.id} type=${job.type} priority=${job.priority}`);
    renderJobTable();
    renderStats();
    renderQueueList();
  });
  room.on('jobClaimed', job => {
    addLog('event', `[${name}] jobClaimed: ${job.id} by ${job.claimedBy}`);
    renderJobTable();
    renderStats();
    if (selectedJobId === job.id) renderJobActions();
  });
  room.on('jobProgress', progress => {
    addLog('action', `[${name}] jobProgress: ${progress.jobId} → ${progress.progress}%`);
    renderJobTable();
    if (selectedJobId === progress.jobId) renderJobActions();
  });
  room.on('jobCompleted', job => {
    addLog('event', `[${name}] jobCompleted: ${job.id}`);
    renderJobTable();
    renderStats();
    renderQueueList();
    if (selectedJobId === job.id) renderJobActions();
  });
  room.on('jobFailed', job => {
    addLog('error', `[${name}] jobFailed: ${job.id}`);
    renderJobTable();
    renderStats();
    if (selectedJobId === job.id) renderJobActions();
  });
  room.on('jobRetrying', job => {
    addLog('action', `[${name}] jobRetrying: ${job.id} attempt ${job.attempts}`);
    renderJobTable();
    if (selectedJobId === job.id) renderJobActions();
  });
  room.on('workerJoined', worker => {
    addLog('event', `[${name}] workerJoined: ${worker.id}`);
    renderWorkerList();
  });
  room.on('workerLeft', worker => {
    addLog('event', `[${name}] workerLeft: ${worker.id}`);
    renderWorkerList();
  });
}

function selectJob(id) {
  selectedJobId = id;
  renderJobTable();
  renderJobActions();
}

function setConnectedUI(connected) {
  const badge = document.getElementById('status-badge');
  if (badge) badge.innerHTML = statusBadge(connected);
  const btnConnect = document.getElementById('btn-connect');
  const btnDisconnect = document.getElementById('btn-disconnect');
  if (btnConnect) btnConnect.disabled = connected;
  if (btnDisconnect) btnDisconnect.disabled = !connected;
  if (!connected) {
    const btnAdd = document.getElementById('btn-add-job');
    if (btnAdd) btnAdd.disabled = true;
    const btnRefresh = document.getElementById('btn-refresh-jobs');
    if (btnRefresh) btnRefresh.disabled = true;
  }
}

// ─── Static event bindings ───────────────────────────────────────────────────
function bindStaticEvents() {
  document.getElementById('btn-connect').addEventListener('click', async () => {
    const token = document.getElementById('inp-token').value.trim();
    const role = document.getElementById('inp-role').value;
    const concurrency = parseInt(document.getElementById('inp-concurrency').value, 10) || 2;
    const appName = document.getElementById('inp-appname').value.trim() || 'nolag-queue-demo';
    if (!token) { addLog('error', 'Token is required'); return; }
    addLog('action', `Connecting as role="${role}" concurrency=${concurrency}…`);
    try {
      queue = new NoLagQueue(token, {
        role,
        concurrency,
        appName,
        debug: false,
        url: 'wss://broker.dev.nolag.app/ws',
        queues: ['image-processing', 'email-dispatch'],
      });
      queue.on('connected', () => {
        addLog('event', 'connected');
        setConnectedUI(true);
        renderWorkerList();
      });
      queue.on('disconnected', reason => {
        addLog('error', `disconnected: ${reason}`);
        setConnectedUI(false);
        activeRoom = null;
        activeQueueName = null;
        selectedJobId = null;
        renderQueueList();
        renderJobTable();
        renderJobActions();
        renderWorkerList();
        renderStats();
      });
      queue.on('reconnected', () => {
        addLog('event', 'reconnected');
        setConnectedUI(true);
      });
      queue.on('error', err => {
        addLog('error', `error: ${err.message || err}`);
      });
      queue.on('workerOnline', worker => {
        addLog('event', `workerOnline: ${worker.id} role=${worker.role}`);
        renderWorkerList();
      });
      queue.on('workerOffline', worker => {
        addLog('event', `workerOffline: ${worker.id}`);
        renderWorkerList();
      });
      await queue.connect();
    } catch (err) {
      addLog('error', `connect failed: ${err.message}`);
    }
  });

  document.getElementById('btn-disconnect').addEventListener('click', async () => {
    if (!queue) return;
    addLog('action', 'Disconnecting…');
    try {
      await queue.disconnect();
    } catch (err) {
      addLog('error', `disconnect error: ${err.message}`);
    }
    queue = null;
    activeRoom = null;
    activeQueueName = null;
    selectedJobId = null;
    Object.keys(roomCache).forEach(k => delete roomCache[k]);
    setConnectedUI(false);
    renderQueueList();
    renderJobTable();
    renderJobActions();
    renderWorkerList();
    renderStats();
  });

  document.getElementById('btn-add-job').addEventListener('click', async () => {
    if (!activeRoom) return;
    const type = document.getElementById('inp-job-type').value.trim();
    const priority = document.getElementById('inp-priority').value;
    const payloadStr = document.getElementById('inp-payload').value.trim();
    if (!type) { addLog('error', 'Job type is required'); return; }
    const payload = safeJson(payloadStr, { raw: payloadStr });
    addLog('action', `addJob: type=${type} priority=${priority}`);
    try {
      await activeRoom.addJob({ type, payload, priority });
      document.getElementById('inp-job-type').value = '';
      document.getElementById('inp-payload').value = '';
    } catch (err) {
      addLog('error', `addJob error: ${err.message}`);
    }
  });

  document.getElementById('btn-refresh-jobs').addEventListener('click', () => {
    renderJobTable();
    renderStats();
    renderQueueList();
    addLog('action', 'Refreshed job list');
  });

  document.getElementById('inp-filter-status').addEventListener('change', () => {
    renderJobTable();
  });

  document.getElementById('inp-progress').addEventListener('input', e => {
    const el = document.getElementById('progress-val');
    if (el) el.textContent = `${e.target.value}%`;
    // Auto-report progress on slider change
    if (activeRoom && selectedJobId) {
      const pct = parseInt(e.target.value, 10);
      activeRoom.reportProgress(selectedJobId, pct);
    }
  });

  document.getElementById('btn-claim-job').addEventListener('click', async () => {
    if (!activeRoom || !selectedJobId) return;
    addLog('action', `claimJob: ${selectedJobId}`);
    try {
      await activeRoom.claimJob(selectedJobId);
    } catch (err) {
      addLog('error', `claimJob error: ${err.message}`);
    }
  });

  document.getElementById('btn-report-progress').addEventListener('click', async () => {
    if (!activeRoom || !selectedJobId) return;
    const pct = parseInt(document.getElementById('inp-progress').value, 10);
    addLog('action', `reportProgress: ${selectedJobId} → ${pct}%`);
    try {
      await activeRoom.reportProgress(selectedJobId, pct);
    } catch (err) {
      addLog('error', `reportProgress error: ${err.message}`);
    }
  });

  document.getElementById('btn-complete-job').addEventListener('click', async () => {
    if (!activeRoom || !selectedJobId) return;
    addLog('action', `completeJob: ${selectedJobId}`);
    try {
      await activeRoom.completeJob(selectedJobId, { completedAt: new Date().toISOString() });
      selectedJobId = null;
      renderJobActions();
    } catch (err) {
      addLog('error', `completeJob error: ${err.message}`);
    }
  });

  document.getElementById('btn-fail-job').addEventListener('click', async () => {
    if (!activeRoom || !selectedJobId) return;
    addLog('action', `failJob: ${selectedJobId}`);
    try {
      await activeRoom.failJob(selectedJobId, 'Manually failed via demo UI');
      selectedJobId = null;
      renderJobActions();
    } catch (err) {
      addLog('error', `failJob error: ${err.message}`);
    }
  });

  document.getElementById('btn-clear-log').addEventListener('click', () => {
    logs.length = 0;
    renderLog();
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
renderShell();
