import { Blackboard, createStateEnvelope } from '@nolag/agents';

// ── Mock Room ───────────────────────────────────────────────────────────────
// A simulated AgentRoom that feeds publish calls back into its own listeners,
// so multiple Blackboard instances on the same room see each other's writes.

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
  { id: 'planner-agent', label: 'Planner', color: 'badge-primary' },
  { id: 'researcher-agent', label: 'Researcher', color: 'badge-info' },
  { id: 'writer-agent', label: 'Writer', color: 'badge-warning' },
];

const room = createMockRoom('blackboard-room');
const boards = AGENTS.map(a => ({
  ...a,
  board: new Blackboard(room, a.id),
  autoInterval: null,
}));

let lateSubscriber = null;

// ── Logging ─────────────────────────────────────────────────────────────────
function addLog(msg, type = 'event') {
  const log = document.getElementById('event-log');
  if (!log) return;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const el = document.createElement('div');
  el.className = `log-entry ${type} fade-in`;
  el.textContent = `${time}  ${msg}`;
  log.prepend(el);
  if (log.children.length > 200) log.lastChild.remove();
}

// ── State Table ─────────────────────────────────────────────────────────────
function renderStateTable() {
  const tbody = document.getElementById('state-tbody');
  if (!tbody) return;

  // Collect all state from the first board (they all share the same room,
  // so any board's getAll() returns the same merged state)
  const allState = boards[0].board.getAll();
  tbody.innerHTML = '';

  if (allState.size === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-base-content/30 py-6">No state yet — use the agent controls above to set values</td></tr>`;
    return;
  }

  for (const [key, env] of allState) {
    const time = new Date(env.updatedAt).toLocaleTimeString('en-GB', { hour12: false });
    const agent = AGENTS.find(a => a.id === env.updatedBy);
    const agentLabel = agent ? agent.label : env.updatedBy;
    const agentColor = agent ? agent.color : 'badge-ghost';

    tbody.innerHTML += `
      <tr class="hover">
        <td class="font-mono text-sm">${escHtml(key)}</td>
        <td class="font-mono text-sm text-primary">${escHtml(String(env.value))}</td>
        <td class="text-center"><span class="badge badge-sm badge-ghost">${env.version}</span></td>
        <td><span class="badge badge-sm ${agentColor}">${escHtml(agentLabel)}</span></td>
        <td class="text-xs text-base-content/50">${time}</td>
      </tr>`;
  }
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Per-agent cache panels ───────────────────────────────────────────────────
function renderPerAgentCache() {
  const container = document.getElementById('agent-caches');
  if (!container) return;

  const allBoards = [...boards];
  if (lateSubscriber) allBoards.push({ label: 'Late Subscriber', color: 'badge-success', board: lateSubscriber });

  container.innerHTML = allBoards.map(b => {
    const state = b.board.getAll();
    const rows = [...state.entries()].map(([key, env]) =>
      `<tr><td class="text-xs font-mono">${escHtml(key)}</td><td class="text-xs">${escHtml(String(env.value))}</td><td class="text-xs">v${env.version}</td></tr>`
    ).join('') || '<tr><td colspan="3" class="text-xs text-base-content/30">empty</td></tr>';

    return `
      <div class="card bg-base-200 border border-base-300 p-3">
        <div class="flex items-center gap-2 mb-2">
          <span class="badge ${b.color} badge-sm">${escHtml(b.label)}</span>
          <span class="text-xs text-base-content/40">${state.size} entries</span>
        </div>
        <table class="table table-xs w-full">
          <thead><tr class="text-base-content/40"><th>Key</th><th>Value</th><th>Ver</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }).join('');
}

// ── Subscribe button ─────────────────────────────────────────────────────────
function renderSubscribeButton() {
  const btn = document.getElementById('btn-subscribe');
  if (!btn) return;
  if (lateSubscriber) {
    btn.textContent = 'Already Subscribed';
    btn.disabled = true;
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-disabled');
  }
}

function subscribeLate() {
  if (lateSubscriber) {
    addLog('Late subscriber already connected', 'error');
    return;
  }
  lateSubscriber = new Blackboard(room, 'late-subscriber');
  const state = lateSubscriber.getAll();
  addLog(`Late subscriber joined — received ${state.size} state entries`, 'action');

  // Listen for future changes
  room.on('stateChange', () => renderPerAgentCache());
  renderPerAgentCache();
  renderSubscribeButton();
}

// Listen for all state changes to update the table and log
room.on('stateChange', (env) => {
  const agent = AGENTS.find(a => a.id === env.updatedBy);
  addLog(`${agent ? agent.label : env.updatedBy} set "${env.key}" = "${env.value}" (v${env.version})`);
  renderStateTable();
  renderPerAgentCache();
});

// ── Agent actions ───────────────────────────────────────────────────────────
function agentSet(agentIdx) {
  const keyInput = document.getElementById(`key-${agentIdx}`);
  const valInput = document.getElementById(`val-${agentIdx}`);
  if (!keyInput || !valInput) return;
  const key = keyInput.value.trim();
  const value = valInput.value.trim();
  if (!key) { addLog('Key is required', 'error'); return; }
  boards[agentIdx].board.set(key, value);
}

function toggleAutoUpdate(agentIdx) {
  const entry = boards[agentIdx];
  const btn = document.getElementById(`auto-${agentIdx}`);
  if (entry.autoInterval) {
    clearInterval(entry.autoInterval);
    entry.autoInterval = null;
    if (btn) { btn.textContent = 'Auto-update'; btn.classList.remove('btn-error'); btn.classList.add('btn-outline'); }
    addLog(`${entry.label} auto-update stopped`, 'action');
  } else {
    entry.autoInterval = setInterval(() => {
      entry.board.set('status', 'active');
      entry.board.set(`${entry.id}/heartbeat`, new Date().toISOString());
    }, 2000);
    if (btn) { btn.textContent = 'Stop'; btn.classList.add('btn-error'); btn.classList.remove('btn-outline'); }
    addLog(`${entry.label} auto-update started (every 2s)`, 'action');
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const agentCards = AGENTS.map((a, i) => `
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body gap-3 p-4">
        <div class="flex items-center gap-2">
          <span class="badge ${a.color}">${escHtml(a.label)}</span>
          <span class="text-xs text-base-content/40 font-mono">${escHtml(a.id)}</span>
        </div>
        <div class="flex gap-2">
          <input id="key-${i}" type="text" placeholder="key" value="${i === 0 ? 'goal' : i === 1 ? 'findings' : 'draft'}" class="input input-bordered input-sm flex-1" />
          <input id="val-${i}" type="text" placeholder="value" value="${i === 0 ? 'write report' : i === 1 ? '3 sources found' : 'intro paragraph done'}" class="input input-bordered input-sm flex-1" />
        </div>
        <div class="flex gap-2">
          <button id="set-${i}" class="btn btn-primary btn-sm flex-1">Set</button>
          <button id="auto-${i}" class="btn btn-outline btn-sm flex-1">Auto-update</button>
        </div>
      </div>
    </div>
  `).join('');

  document.getElementById('app').innerHTML = `
  <div class="flex flex-col h-screen bg-base-100 text-base-content">

    <!-- Header -->
    <header class="flex items-center gap-3 px-5 py-3 bg-base-200 border-b border-base-300 shrink-0">
      <span class="text-xl font-bold text-primary">@nolag/agents</span>
      <span class="text-base-content/40 text-sm">Blackboard Pattern Demo</span>
    </header>

    <!-- Main content -->
    <div class="flex flex-1 min-h-0">

      <!-- Left: agents + state table -->
      <div class="flex-1 flex flex-col gap-4 p-4 overflow-y-auto">

        <!-- Agent cards -->
        <div>
          <h2 class="text-sm font-bold uppercase tracking-widest text-base-content/40 mb-2">Agent Controls</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            ${agentCards}
          </div>
        </div>

        <!-- Shared state table -->
        <div>
          <h2 class="text-sm font-bold uppercase tracking-widest text-base-content/40 mb-2">Shared Blackboard State</h2>
          <div class="overflow-x-auto bg-base-200 rounded-lg border border-base-300">
            <table class="table table-sm w-full">
              <thead>
                <tr class="text-base-content/50">
                  <th>Key</th>
                  <th>Value</th>
                  <th class="text-center">Version</th>
                  <th>Updated By</th>
                  <th>Updated At</th>
                </tr>
              </thead>
              <tbody id="state-tbody">
                <tr><td colspan="5" class="text-center text-base-content/30 py-6">No state yet — use the agent controls above to set values</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Late subscriber -->
        <div>
          <h2 class="text-sm font-bold uppercase tracking-widest text-base-content/40 mb-2">Late Subscriber</h2>
          <div class="flex items-center gap-3">
            <button id="btn-subscribe" class="btn btn-secondary btn-sm">Subscribe Now</button>
            <span class="text-xs text-base-content/40">Creates a 4th Blackboard instance mid-workflow and immediately receives all retained state</span>
          </div>
        </div>

        <!-- Per-agent cache panels -->
        <div>
          <h2 class="text-sm font-bold uppercase tracking-widest text-base-content/40 mb-2">Per-Agent Cache View</h2>
          <div id="agent-caches" class="grid grid-cols-1 md:grid-cols-3 gap-3"></div>
        </div>
      </div>

      <!-- Right: Event log -->
      <aside class="w-72 shrink-0 flex flex-col bg-base-200 border-l border-base-300">
        <div class="px-3 py-2 border-b border-base-300 flex items-center justify-between">
          <span class="text-xs font-bold uppercase tracking-widest text-base-content/40">Event Log</span>
          <button id="btn-clear-log" class="btn btn-xs btn-ghost">Clear</button>
        </div>
        <div id="event-log" class="flex-1 overflow-y-auto py-1"></div>
      </aside>
    </div>
  </div>`;

  // Bind events
  AGENTS.forEach((_, i) => {
    document.getElementById(`set-${i}`).addEventListener('click', () => agentSet(i));
    document.getElementById(`auto-${i}`).addEventListener('click', () => toggleAutoUpdate(i));

    // Enter key on inputs triggers set
    document.getElementById(`key-${i}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') agentSet(i); });
    document.getElementById(`val-${i}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') agentSet(i); });
  });

  document.getElementById('btn-clear-log').addEventListener('click', () => {
    document.getElementById('event-log').innerHTML = '';
  });

  document.getElementById('btn-subscribe').addEventListener('click', subscribeLate);
  renderSubscribeButton();

  addLog('Ready — 3 agents share a blackboard via a simulated room', 'action');
}

// ── Boot ────────────────────────────────────────────────────────────────────
render();
renderPerAgentCache();
