/**
 * @nolag/agents — Handoff Pattern Demo
 *
 * Demonstrates the orchestrator-worker handoff pattern:
 *   - An orchestrator dispatches tasks filtered by capability
 *   - Workers listen for tasks matching their capability
 *   - Correlation: dispatch with waitForResult gets the result back
 *   - Priority routing and timeout handling
 *
 * Uses a local mock pub/sub to simulate agent coordination without a broker.
 */

import {
  EventEmitter,
  Handoff,
  createTaskEnvelope,
  createResultEnvelope,
} from '@nolag/agents';

// ============================================================
// State
// ============================================================
const eventLog = [];
const taskFlow = []; // { id, capability, priority, status, payload, result?, error?, dispatchedAt, completedAt? }
let simulating = false;

// ============================================================
// Helpers
// ============================================================
function esc(text) {
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}

function time(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function log(type, text) {
  eventLog.push({ time: Date.now(), type, text });
  if (eventLog.length > 200) eventLog.shift();
  renderEventLog();
}

function $(sel) { return document.querySelector(sel); }

// ============================================================
// Mock AgentRoom — wires EventEmitter as local pub/sub
// ============================================================
class MockAgentRoom extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
  }

  publishTask(envelope) {
    log('event', `[room] publishTask: ${envelope.capability} (${envelope.taskId.slice(0, 8)}...)`);
    // Simulate async delivery
    setTimeout(() => this.emit('task', envelope), 50);
  }

  publishResult(envelope) {
    log('event', `[room] publishResult: ${envelope.status} (${envelope.taskId.slice(0, 8)}...)`);
    setTimeout(() => this.emit('result', envelope), 50);
  }
}

// ============================================================
// Worker definitions
// ============================================================
const WORKERS = [
  { id: 'worker-1', name: 'Contract Drafter', capability: 'draft-contract', color: 'badge-info' },
  { id: 'worker-2', name: 'Contract Reviewer', capability: 'review-contract', color: 'badge-warning' },
  { id: 'worker-3', name: 'Motion Filer', capability: 'file-motion', color: 'badge-error' },
  { id: 'worker-4', name: 'Contract Drafter B', capability: 'draft-contract', color: 'badge-success' },
];

// ============================================================
// Simulation — mock agents on a shared room
// ============================================================
let mockRoom = null;
let orchestratorHandoff = null;
const workerHandoffs = [];
const claimedTasks = new Set();

function startSimulation() {
  if (simulating) return;
  simulating = true;

  // Create shared mock room
  mockRoom = new MockAgentRoom('default-workflow');

  // Orchestrator handoff
  orchestratorHandoff = new Handoff(mockRoom);
  log('action', 'Created orchestrator Handoff on mock room');

  // Worker handoffs — each listens for tasks matching its capability
  WORKERS.forEach((w) => {
    const handoff = new Handoff(mockRoom);

    handoff.onTask((task, respond) => {
      // Only handle tasks matching this worker's capability
      if (task.capability !== w.capability) return;

      // Load-balance: for capabilities handled by multiple workers, only the
      // first to claim the task processes it; others skip.
      const isShared = WORKERS.filter(x => x.capability === w.capability).length > 1;
      if (isShared) {
        if (claimedTasks.has(task.taskId)) {
          log('event', `${w.name} skipped task (already claimed): ${task.capability} (${task.taskId.slice(0, 8)}...)`);
          return;
        }
        claimedTasks.add(task.taskId);
      }

      log('event', `${w.name} received task: ${task.capability} (priority: ${task.priority})`);

      // Update flow UI
      const flowEntry = taskFlow.find(f => f.id === task.taskId);
      if (flowEntry) {
        flowEntry.status = 'processing';
        flowEntry.worker = w.name;
        renderTaskFlow();
      }

      // Simulate processing delay based on priority
      const delay = task.priority === 'critical' ? 300
        : task.priority === 'high' ? 600
        : task.priority === 'medium' ? 1000
        : 1500;

      setTimeout(() => {
        const resultPayload = generateResult(task.capability, task.payload);
        respond('success', resultPayload);
        log('event', `${w.name} completed task: ${task.capability}`);
      }, delay);
    });

    workerHandoffs.push({ worker: w, handoff });
  });

  log('action', `Registered ${WORKERS.length} workers: ${WORKERS.map(w => w.name).join(', ')}`);
  renderApp();
}

function generateResult(capability, payload) {
  switch (capability) {
    case 'draft-contract':
      return {
        documentId: `doc-${crypto.randomUUID().slice(0, 8)}`,
        title: `Contract for: ${payload.description || 'Untitled'}`,
        sections: 12,
        wordCount: 3450,
      };
    case 'review-contract':
      return {
        reviewId: `rev-${crypto.randomUUID().slice(0, 8)}`,
        issues: Math.floor(Math.random() * 5),
        riskLevel: ['low', 'medium', 'high'][Math.floor(Math.random() * 3)],
        recommendation: 'Approved with minor revisions',
      };
    case 'file-motion':
      return {
        filingId: `fil-${crypto.randomUUID().slice(0, 8)}`,
        court: 'District Court',
        caseNumber: `2026-CV-${Math.floor(Math.random() * 9000) + 1000}`,
        status: 'Filed successfully',
      };
    default:
      return { result: 'completed' };
  }
}

async function dispatchTask(capability, payloadText, priority, timeoutMs) {
  if (!orchestratorHandoff) return;

  const payload = { description: payloadText };
  const taskId = crypto.randomUUID();

  const flowEntry = {
    id: taskId,
    capability,
    priority,
    status: 'dispatched',
    payload: payloadText,
    dispatchedAt: Date.now(),
    worker: null,
    result: null,
    error: null,
    completedAt: null,
  };
  taskFlow.unshift(flowEntry);
  if (taskFlow.length > 20) taskFlow.pop();
  renderTaskFlow();

  log('action', `Dispatch: ${capability} (priority: ${priority})`);

  const resolvedTimeout = timeoutMs ?? (priority === 'critical' ? 2000 : 5000);

  try {
    const result = await orchestratorHandoff.dispatch(capability, payload, {
      priority,
      timeout: resolvedTimeout,
      waitForResult: true,
    });

    // The dispatch created its own taskId, so find by correlation
    // Since we can't know the internal taskId ahead of time, match by timing
    const recentEntry = taskFlow.find(f => f.status === 'dispatched' || f.status === 'processing');
    if (recentEntry) {
      recentEntry.status = result.status;
      recentEntry.result = result.payload;
      recentEntry.completedAt = result.completedAt;
    } else {
      flowEntry.status = result.status;
      flowEntry.result = result.payload;
      flowEntry.completedAt = result.completedAt;
    }

    log('event', `Result received: ${result.status} for ${capability}`);
    renderTaskFlow();
  } catch (err) {
    flowEntry.status = 'error';
    flowEntry.error = err.message;
    flowEntry.completedAt = Date.now();
    log('error', `Dispatch failed: ${err.message}`);
    renderTaskFlow();
  }
}

// ============================================================
// Render: Full App Shell
// ============================================================
function renderApp() {
  const app = $('#app');

  app.innerHTML = `
    <div class="h-screen flex flex-col bg-base-200">
      <!-- Navbar -->
      <div class="navbar bg-base-100 shadow-lg px-4 flex-shrink-0">
        <div class="flex-1 gap-2">
          <span class="text-xl font-bold">@nolag/agents — Handoff Pattern</span>
          <div class="badge ${simulating ? 'badge-success' : 'badge-error'} badge-sm">
            ${simulating ? 'Simulating' : 'Idle'}
          </div>
        </div>
        <div class="flex-none gap-2">
          ${WORKERS.map(w => `
            <div class="badge ${w.color} badge-sm gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-current opacity-60"></span>
              ${esc(w.name)}
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Main content -->
      <div class="flex-1 flex overflow-hidden min-h-0">
        ${!simulating ? renderConnectPanel() : renderMainLayout()}
      </div>
    </div>
  `;

  if (!simulating) {
    attachConnectListeners();
  } else {
    renderTaskFlow();
    renderEventLog();
    attachDispatchListeners();
  }
}

// ============================================================
// Render: Connect Panel
// ============================================================
function renderConnectPanel() {
  return `
    <div class="flex-1 flex items-center justify-center">
      <div class="card bg-base-100 shadow-xl w-[28rem]">
        <div class="card-body">
          <h2 class="card-title justify-center text-2xl">Handoff Pattern</h2>
          <p class="text-center text-base-content/60 text-sm">
            Orchestrator dispatches tasks to workers, waits for correlated results
          </p>

          <div class="divider text-xs">CONNECT TO BROKER</div>

          <div class="form-control">
            <label class="label"><span class="label-text">Access Token</span></label>
            <input id="token-input" type="text" placeholder="Paste your NoLag access token"
                   class="input input-bordered input-sm" />
          </div>

          <div class="form-control">
            <label class="label"><span class="label-text">App Slug</span></label>
            <input id="appslug-input" type="text" placeholder="NoLag app slug"
                   class="input input-bordered input-sm" value="agents-app" />
          </div>

          <div id="connect-error" class="alert alert-error text-sm hidden mt-2"></div>

          <div class="card-actions justify-center mt-4 gap-2">
            <button id="btn-connect" class="btn btn-primary btn-wide" disabled>Connect (requires broker)</button>
            <button id="btn-simulate" class="btn btn-accent btn-wide">Simulate Locally</button>
          </div>

          <div class="divider text-xs">WHAT THIS SHOWS</div>
          <ul class="text-xs text-base-content/60 space-y-1">
            <li>Orchestrator dispatches tasks with <code class="badge badge-xs badge-ghost">handoff.dispatch()</code></li>
            <li>Workers receive tasks via <code class="badge badge-xs badge-ghost">handoff.onTask()</code></li>
            <li>Correlated results with <code class="badge badge-xs badge-ghost">waitForResult: true</code></li>
            <li>Priority routing: critical, high, medium, low</li>
            <li>Timeout handling for unresponsive workers</li>
          </ul>

          <div class="divider text-xs">WORKERS</div>
          <div class="flex flex-wrap gap-2 justify-center">
            ${WORKERS.map(w => `
              <div class="badge ${w.color} gap-1">
                <span class="text-xs font-semibold">${esc(w.name)}</span>
                <span class="opacity-60 text-xs">(${w.capability})</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// Render: Main Layout (simulating)
// ============================================================
function renderMainLayout() {
  return `
    <!-- Left panel: Orchestrator controls -->
    <div class="w-80 bg-base-100 border-r border-base-300 flex flex-col flex-shrink-0">
      <div class="p-4 border-b border-base-300">
        <h3 class="font-semibold text-sm mb-3">Orchestrator Controls</h3>

        <div class="form-control mb-2">
          <label class="label py-1"><span class="label-text text-xs">Capability</span></label>
          <select id="capability-select" class="select select-bordered select-sm">
            <option value="draft-contract">draft-contract</option>
            <option value="review-contract">review-contract</option>
            <option value="file-motion">file-motion</option>
            <option value="unknown-task">unknown-task (no match)</option>
          </select>
        </div>

        <div class="form-control mb-2">
          <label class="label py-1"><span class="label-text text-xs">Payload</span></label>
          <input id="payload-input" type="text" placeholder="Task description..."
                 class="input input-bordered input-sm" value="NDA for Acme Corp" />
        </div>

        <div class="form-control mb-3">
          <label class="label py-1"><span class="label-text text-xs">Priority</span></label>
          <div class="flex gap-1">
            <label class="label cursor-pointer gap-1">
              <input type="radio" name="priority" value="low" class="radio radio-xs" />
              <span class="text-xs">Low</span>
            </label>
            <label class="label cursor-pointer gap-1">
              <input type="radio" name="priority" value="medium" class="radio radio-xs" checked />
              <span class="text-xs">Medium</span>
            </label>
            <label class="label cursor-pointer gap-1">
              <input type="radio" name="priority" value="high" class="radio radio-xs" />
              <span class="text-xs">High</span>
            </label>
            <label class="label cursor-pointer gap-1">
              <input type="radio" name="priority" value="critical" class="radio radio-xs" />
              <span class="text-xs">Critical</span>
            </label>
          </div>
        </div>

        <button id="btn-dispatch" class="btn btn-primary btn-sm w-full">Dispatch Task</button>
      </div>

      <div class="p-4 border-b border-base-300">
        <h3 class="font-semibold text-sm mb-2">Quick Actions</h3>
        <div class="flex flex-col gap-1">
          <button class="btn btn-ghost btn-xs justify-start quick-dispatch" data-cap="draft-contract" data-desc="Employment Agreement for new hire" data-pri="high">
            Draft: Employment Agreement (high)
          </button>
          <button class="btn btn-ghost btn-xs justify-start quick-dispatch" data-cap="review-contract" data-desc="Vendor SLA renewal" data-pri="medium">
            Review: Vendor SLA (medium)
          </button>
          <button class="btn btn-ghost btn-xs justify-start quick-dispatch" data-cap="file-motion" data-desc="Motion to dismiss - Case 2026" data-pri="critical">
            File: Motion to Dismiss (critical)
          </button>
          <button class="btn btn-ghost btn-xs justify-start quick-dispatch" data-cap="draft-contract" data-desc="Licensing agreement" data-pri="low">
            Draft: License Agreement (low)
          </button>
          <button class="btn btn-ghost btn-xs justify-start text-error/70 quick-dispatch" data-cap="unknown-task" data-desc="No handler for this capability" data-pri="medium" data-timeout="3000">
            No Match: unknown-task (3s timeout)
          </button>
        </div>
      </div>

      <div class="p-4 flex-1 overflow-y-auto">
        <h3 class="font-semibold text-sm mb-2">Active Workers</h3>
        ${WORKERS.map(w => `
          <div class="flex items-center gap-2 py-1.5 border-b border-base-300/50">
            <span class="w-2 h-2 rounded-full bg-success"></span>
            <span class="text-xs font-semibold">${esc(w.name)}</span>
            <span class="text-xs text-base-content/50 ml-auto">${w.capability}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Center: Task flow visualization -->
    <div class="flex-1 flex flex-col min-w-0">
      <div class="px-4 py-2 bg-base-100 border-b border-base-300 flex items-center gap-2 flex-shrink-0">
        <span class="font-bold">Task Flow</span>
        <span class="text-xs text-base-content/50">${taskFlow.length} task${taskFlow.length !== 1 ? 's' : ''}</span>
        <button id="btn-clear-flow" class="btn btn-ghost btn-xs ml-auto">Clear</button>
      </div>
      <div id="task-flow" class="flex-1 overflow-y-auto p-4 space-y-2"></div>
    </div>

    <!-- Right: Event log -->
    <div class="w-72 bg-base-100 border-l border-base-300 flex flex-col flex-shrink-0">
      <div class="p-3 border-b border-base-300 flex items-center justify-between">
        <h3 class="font-semibold text-sm">Event Log</h3>
        <button id="btn-clear-log" class="btn btn-ghost btn-xs">Clear</button>
      </div>
      <div id="event-log" class="flex-1 overflow-y-auto p-2 text-xs bg-base-200/50"></div>
    </div>
  `;
}

// ============================================================
// Render: Task Flow
// ============================================================
function renderTaskFlow() {
  const el = $('#task-flow');
  if (!el) return;

  if (taskFlow.length === 0) {
    el.innerHTML = `
      <div class="text-center text-base-content/40 py-12">
        <p class="text-lg">No tasks dispatched yet</p>
        <p class="text-sm mt-1">Use the controls on the left to dispatch a task</p>
      </div>
    `;
    return;
  }

  el.innerHTML = taskFlow.map(f => {
    const statusBadge = {
      dispatched: '<span class="badge badge-info badge-xs">dispatched</span>',
      processing: '<span class="badge badge-warning badge-xs">processing</span>',
      success: '<span class="badge badge-success badge-xs">success</span>',
      error: '<span class="badge badge-error badge-xs">error</span>',
      partial: '<span class="badge badge-warning badge-xs">partial</span>',
    }[f.status] || '<span class="badge badge-ghost badge-xs">unknown</span>';

    const priorityBadge = {
      critical: '<span class="badge badge-error badge-xs">critical</span>',
      high: '<span class="badge badge-warning badge-xs">high</span>',
      medium: '<span class="badge badge-info badge-xs">medium</span>',
      low: '<span class="badge badge-ghost badge-xs">low</span>',
    }[f.priority];

    const duration = f.completedAt
      ? `<span class="text-xs text-base-content/50">${f.completedAt - f.dispatchedAt}ms</span>`
      : '';

    return `
      <div class="card bg-base-100 shadow-sm border border-base-300">
        <div class="card-body p-3">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-sm">${esc(f.capability)}</span>
            ${statusBadge}
            ${priorityBadge}
            ${duration}
          </div>
          <p class="text-xs text-base-content/60 mt-1">Payload: "${esc(f.payload)}"</p>
          ${f.worker ? `<p class="text-xs text-base-content/60">Worker: <span class="text-primary">${esc(f.worker)}</span></p>` : ''}
          ${f.result ? `
            <div class="bg-base-200 rounded p-2 mt-1">
              <p class="text-xs font-semibold text-success mb-1">Result:</p>
              <pre class="text-xs text-base-content/70 whitespace-pre-wrap">${esc(JSON.stringify(f.result, null, 2))}</pre>
            </div>
          ` : ''}
          ${f.error ? `
            <div class="bg-error/10 rounded p-2 mt-1">
              <p class="text-xs text-error">${esc(f.error)}</p>
            </div>
          ` : ''}
          <p class="text-xs text-base-content/40 mt-1">${time(f.dispatchedAt)}</p>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// Render: Event Log
// ============================================================
function renderEventLog() {
  const el = $('#event-log');
  if (!el) return;

  el.innerHTML = eventLog.slice(-50).map(e => `
    <div class="log-entry ${e.type}">
      <span class="opacity-50">${time(e.time)}</span>
      ${esc(e.text)}
    </div>
  `).join('');

  el.scrollTop = el.scrollHeight;
}

// ============================================================
// Event Listeners
// ============================================================
function attachConnectListeners() {
  $('#btn-simulate')?.addEventListener('click', () => {
    startSimulation();
  });
}

function attachDispatchListeners() {
  const capSelect = $('#capability-select');
  const payloadInput = $('#payload-input');
  const dispatchBtn = $('#btn-dispatch');
  const clearFlowBtn = $('#btn-clear-flow');
  const clearLogBtn = $('#btn-clear-log');

  dispatchBtn?.addEventListener('click', () => {
    const capability = capSelect?.value;
    const payload = payloadInput?.value?.trim() || 'Unnamed task';
    const priority = document.querySelector('input[name="priority"]:checked')?.value || 'medium';
    dispatchTask(capability, payload, priority);
  });

  // Quick dispatch buttons
  document.querySelectorAll('.quick-dispatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const timeout = btn.dataset.timeout ? Number(btn.dataset.timeout) : undefined;
      dispatchTask(btn.dataset.cap, btn.dataset.desc, btn.dataset.pri, timeout);
    });
  });

  clearFlowBtn?.addEventListener('click', () => {
    taskFlow.length = 0;
    renderTaskFlow();
  });

  clearLogBtn?.addEventListener('click', () => {
    eventLog.length = 0;
    renderEventLog();
  });

  // Enter key on payload input
  payloadInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dispatchBtn?.click();
  });
}

// ============================================================
// Boot
// ============================================================
renderApp();
