import { Approve, createApprovalRequest } from '@nolag/agents';

// ---------------------------------------------------------------------------
// Mock room (local pub/sub, no broker needed)
// ---------------------------------------------------------------------------
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
        try { h(data); } catch(e) { console.error(e); }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const room = createMockRoom('approval-room');
const agentApprove = new Approve(room, 'agent-1');
const humanApprove = new Approve(room, 'human-1');

const actions = [
  { id: 'deploy', label: 'Deploy to Production', context: { environment: 'production', branch: 'main', version: '2.4.1' }, status: 'idle', timeout: 0 },
  { id: 'delete', label: 'Delete User Data', context: { userId: 'usr_38291', reason: 'GDPR request', records: 1847 }, status: 'idle', timeout: 0 },
  { id: 'email', label: 'Send Email Blast', context: { template: 'promo-q2', recipients: 45200, subject: 'Summer Sale' }, status: 'idle', timeout: 0 },
  { id: 'slow', label: 'Slow Request (5s timeout)', context: { test: true, description: 'This request has a 5s timeout' }, status: 'idle', timeout: 5000 },
];

const pendingQueue = []; // { request, respond }

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg, type = 'event') {
  const logEl = document.getElementById('log');
  const ts = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${ts}] ${msg}`;
  logEl.prepend(entry);
}

// ---------------------------------------------------------------------------
// Human approver listens for requests
// ---------------------------------------------------------------------------
humanApprove.onRequest((request, respond) => {
  pendingQueue.push({ request, respond });
  log(`Approval request received: "${request.action}" (urgency: ${request.urgency})`, 'event');
  renderHumanQueue();
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function urgencyBadge(urgency) {
  const colors = {
    low: 'badge-info',
    medium: 'badge-warning',
    high: 'badge-error',
    critical: 'badge-error badge-outline',
  };
  return `<span class="badge ${colors[urgency] || 'badge-ghost'} badge-sm">${urgency}</span>`;
}

function renderAgentPanel() {
  const el = document.getElementById('agent-actions');
  el.innerHTML = actions.map((a) => {
    const statusColors = {
      idle: 'text-base-content/50',
      pending: 'text-warning',
      approved: 'text-success',
      rejected: 'text-error',
      deferred: 'text-info',
      'timed-out': 'text-error',
    };
    const statusIcons = {
      idle: '--',
      pending: 'Pending...',
      approved: 'Approved',
      rejected: 'Rejected',
      deferred: 'Deferred',
      'timed-out': 'Timed Out',
    };
    const disabled = a.status === 'pending';
    return `
      <div class="card bg-base-200 shadow-md">
        <div class="card-body p-4 gap-2">
          <div class="flex items-center justify-between">
            <h3 class="card-title text-sm font-semibold">${a.label}</h3>
            <span class="text-xs font-semibold ${statusColors[a.status]}">${statusIcons[a.status]}</span>
          </div>
          <p class="text-xs text-base-content/60 font-mono">${JSON.stringify(a.context)}</p>
          <div class="flex items-center gap-2 mt-1">
            <select id="urgency-${a.id}" class="select select-xs select-bordered w-28" ${disabled ? 'disabled' : ''}>
              <option value="low">Low</option>
              <option value="medium" selected>Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <input type="number" id="timeout-${a.id}" value="${a.timeout || 0}" min="0" step="1000"
                   class="input input-xs input-bordered w-20" placeholder="ms" title="Timeout in ms (0 = none)" ${disabled ? 'disabled' : ''} />
            <button class="btn btn-primary btn-xs" ${disabled ? 'disabled' : ''} data-action="${a.id}">
              Request Approval
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Bind buttons
  el.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => requestApproval(btn.dataset.action));
  });
}

function renderHumanQueue() {
  const el = document.getElementById('human-queue');
  if (pendingQueue.length === 0) {
    el.innerHTML = '<p class="text-base-content/40 text-sm text-center py-8">No pending requests</p>';
    return;
  }
  el.innerHTML = pendingQueue.map((item, idx) => {
    const r = item.request;
    const age = Math.round((Date.now() - r.requestedAt) / 1000);
    return `
      <div class="card bg-base-200 shadow-md">
        <div class="card-body p-4 gap-2">
          <div class="flex items-center justify-between">
            <h3 class="card-title text-sm font-semibold">${r.action}</h3>
            ${urgencyBadge(r.urgency)}
          </div>
          <p class="text-xs text-base-content/60 font-mono">${JSON.stringify(r.context)}</p>
          <div class="flex items-center gap-1 text-xs text-base-content/40">
            <span>by ${r.requestedBy}</span>
            <span class="mx-1">&middot;</span>
            <span>${age}s ago</span>
          </div>
          <input type="text" placeholder="Reason (optional)" class="input input-xs input-bordered w-full mt-1" id="reason-${idx}" />
          <div class="flex gap-2 mt-1">
            <button class="btn btn-success btn-xs flex-1" data-idx="${idx}" data-decision="approved">Approve</button>
            <button class="btn btn-error btn-xs flex-1" data-idx="${idx}" data-decision="rejected">Reject</button>
            <button class="btn btn-info btn-xs flex-1" data-idx="${idx}" data-decision="deferred">Defer</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Bind decision buttons
  el.querySelectorAll('button[data-decision]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const decision = btn.dataset.decision;
      const reasonInput = document.getElementById(`reason-${idx}`);
      const reason = reasonInput?.value || undefined;
      handleDecision(idx, decision, reason);
    });
  });
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="flex flex-col h-full">
      <!-- Header -->
      <div class="bg-base-200 border-b border-base-300 px-6 py-3 flex items-center gap-3">
        <h1 class="text-lg font-bold text-primary">@nolag/agents</h1>
        <span class="text-base-content/50 text-sm">Approve Pattern Demo</span>
      </div>

      <!-- Main panels -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Left: AI Agent -->
        <div class="w-1/2 border-r border-base-300 flex flex-col">
          <div class="px-4 py-3 border-b border-base-300 flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
            <h2 class="font-semibold text-sm">AI Agent</h2>
            <span class="text-xs text-base-content/40 ml-auto">agent-1</span>
          </div>
          <div id="agent-actions" class="flex-1 overflow-y-auto p-4 flex flex-col gap-3"></div>
        </div>

        <!-- Right: Human Approver -->
        <div class="w-1/2 flex flex-col">
          <div class="px-4 py-3 border-b border-base-300 flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-success"></div>
            <h2 class="font-semibold text-sm">Human Approver</h2>
            <span class="text-xs text-base-content/40 ml-auto">human-1</span>
          </div>
          <div id="human-queue" class="flex-1 overflow-y-auto p-4 flex flex-col gap-3"></div>
        </div>
      </div>

      <!-- Event log -->
      <div class="h-40 border-t border-base-300 flex flex-col">
        <div class="px-4 py-2 border-b border-base-300 flex items-center justify-between">
          <h2 class="font-semibold text-xs text-base-content/60">Event Log</h2>
          <button id="clear-log" class="btn btn-ghost btn-xs text-base-content/40">Clear</button>
        </div>
        <div id="log" class="flex-1 overflow-y-auto px-2 py-1"></div>
      </div>
    </div>
  `;

  document.getElementById('clear-log').addEventListener('click', () => {
    document.getElementById('log').innerHTML = '';
  });

  renderAgentPanel();
  renderHumanQueue();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function requestApproval(actionId) {
  const action = actions.find(a => a.id === actionId);
  if (!action || action.status === 'pending') return;

  const urgencySelect = document.getElementById(`urgency-${actionId}`);
  const urgency = urgencySelect?.value || 'medium';

  const timeoutInput = document.getElementById(`timeout-${actionId}`);
  const timeout = parseInt(timeoutInput?.value || '0', 10);

  action.status = 'pending';
  renderAgentPanel();
  log(`Agent requesting approval for: "${action.label}" (urgency: ${urgency}${timeout ? `, timeout: ${timeout}ms` : ''})`, 'action');

  try {
    const response = await agentApprove.request(action.label, action.context, { urgency, timeout: timeout || undefined });
    action.status = response.decision;
    const reasonText = response.reason ? ` — "${response.reason}"` : '';
    log(`Decision for "${action.label}": ${response.decision}${reasonText}`, response.decision === 'approved' ? 'event' : response.decision === 'rejected' ? 'error' : 'action');
    renderAgentPanel();
  } catch (err) {
    if (err.message.includes('timed out')) {
      action.status = 'timed-out';
      log(`Request "${action.label}" timed out`, 'error');
      // Remove from human's pending queue (the correlation already expired)
      const queueIdx = pendingQueue.findIndex(p => p.request.action === action.label);
      if (queueIdx !== -1) {
        pendingQueue.splice(queueIdx, 1);
        renderHumanQueue();
      }
    } else {
      action.status = 'idle';
      log(`Error requesting approval: ${err.message}`, 'error');
    }
    renderAgentPanel();
  }
}

function handleDecision(idx, decision, reason) {
  const item = pendingQueue[idx];
  if (!item) return;

  const reasonText = reason ? ` with reason: "${reason}"` : '';
  log(`Human ${decision} "${item.request.action}"${reasonText}`, 'action');

  item.respond(decision, reason);
  pendingQueue.splice(idx, 1);
  renderHumanQueue();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
render();
log('Approve pattern demo initialized. Click "Request Approval" to begin.', 'event');
