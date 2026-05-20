/**
 * @nolag/agents — Combined Legal Matter Workflow
 *
 * Demonstrates all 6 agent patterns (Handoff, Blackboard, Inbox, Observe,
 * Approve, Tools) working together in a realistic legal-matter processing
 * pipeline.
 *
 * Agents:
 *   1. Orchestrator  — dispatches tasks, tracks overall progress
 *   2. Drafter       — handles "draft-contract" capability
 *   3. Reviewer      — handles "review-contract" capability
 *   4. Tool Provider — provides legal-search, template-fill, compliance-check
 *   5. Human Approver — the user, acting as the approval gate
 */

import { Handoff, Blackboard, Inbox, Observe, Approve, Tools } from '@nolag/agents';

// ---------------------------------------------------------------------------
// Mock room — shared pub/sub bus that all agents connect through
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
      } else { delete handlers[event]; }
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
// Shared room instance — every agent uses the same bus
// ---------------------------------------------------------------------------

const room = createMockRoom('legal-matter');

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

const STEPS = [
  { id: 'dispatch-draft',    label: 'Dispatch "draft-contract"',        icon: '1' },
  { id: 'tool-template',     label: 'Drafter invokes template-fill',    icon: '2' },
  { id: 'bb-draft',          label: 'Draft written to Blackboard',      icon: '3' },
  { id: 'event-draft-done',  label: 'Event: draft-completed',           icon: '4' },
  { id: 'dispatch-review',   label: 'Dispatch "review-contract"',       icon: '5' },
  { id: 'tool-compliance',   label: 'Reviewer invokes compliance-check',icon: '6' },
  { id: 'approval',          label: 'Human approval requested',         icon: '7' },
  { id: 'human-decision',    label: 'Human approves / rejects',         icon: '8' },
  { id: 'bb-status',         label: 'Status updated on Blackboard',     icon: '9' },
  { id: 'inbox-notify',      label: 'Inbox notification to Drafter',    icon: '10' },
  { id: 'event-complete',    label: 'Event: workflow-complete',          icon: '11' },
];

// Visual grouping of the 11 steps into 8 high-level phases.
// The workflow logic still uses step indices 0-10 via markStep() unchanged.
const PHASES = [
  {
    id: 'phase-dispatch-draft',
    label: 'Dispatch Draft Task',
    icon: '1',
    steps: [0],
  },
  {
    id: 'phase-draft',
    label: 'Draft Contract',
    icon: '2',
    steps: [1, 2, 3],
    subLabels: ['Invoke template-fill tool', 'Write draft to Blackboard', 'Emit draft-completed event'],
  },
  {
    id: 'phase-dispatch-review',
    label: 'Dispatch Review Task',
    icon: '3',
    steps: [4],
  },
  {
    id: 'phase-review',
    label: 'Review Contract',
    icon: '4',
    steps: [5],
    subLabels: ['Invoke compliance-check tool'],
  },
  {
    id: 'phase-approval',
    label: 'Human Approval Gate',
    icon: '5',
    steps: [6, 7],
    subLabels: ['Approval requested', 'Human decides'],
  },
  {
    id: 'phase-record',
    label: 'Record Decision',
    icon: '6',
    steps: [8],
  },
  {
    id: 'phase-notify',
    label: 'Notify Drafter',
    icon: '7',
    steps: [9],
  },
  {
    id: 'phase-complete',
    label: 'Workflow Complete',
    icon: '8',
    steps: [10],
  },
];

let workflowStatus = 'idle';           // idle | running | paused | completed
let activeStepIndex = -1;
let completedSteps = new Set();
let toolInvocationCount = 0;
const agentStatuses = {
  orchestrator: 'idle',
  drafter: 'idle',
  reviewer: 'idle',
  toolProvider: 'idle',
};
const logEntries = [];
const blackboardEntries = new Map();

// Store the approval respond function so the human can act on it
let pendingApproval = null;   // { request, respond }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(type, message) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
  logEntries.push({ type, message, ts });
  renderLog();
}

function setWorkflowStatus(s) {
  workflowStatus = s;
  renderTopBar();
}

function setAgentStatus(agent, status) {
  agentStatuses[agent] = status;
  renderAgents();
}

function markStep(index, state) {
  if (state === 'active') activeStepIndex = index;
  if (state === 'done') { completedSteps.add(index); activeStepIndex = -1; }
  renderTimeline();
}

function recordBlackboard(key, value, version, updatedBy) {
  blackboardEntries.set(key, { value, version, updatedBy });
  renderBlackboard();
}

// ---------------------------------------------------------------------------
// Render — top bar
// ---------------------------------------------------------------------------

function renderTopBar() {
  const statusColors = {
    idle: 'badge-ghost',
    running: 'badge-info',
    paused: 'badge-warning',
    completed: 'badge-success',
  };
  document.getElementById('workflow-status').className = `badge ${statusColors[workflowStatus]} badge-lg`;
  document.getElementById('workflow-status').textContent = workflowStatus.charAt(0).toUpperCase() + workflowStatus.slice(1);

  const btn = document.getElementById('btn-start');
  btn.disabled = workflowStatus === 'running' || workflowStatus === 'paused';
}

// ---------------------------------------------------------------------------
// Render — agent cards
// ---------------------------------------------------------------------------

function renderAgents() {
  const colors = { idle: 'text-base-content/40', working: 'text-info', done: 'text-success', error: 'text-error' };
  const dots  = { idle: 'bg-base-300', working: 'bg-info animate-pulse', done: 'bg-success', error: 'bg-error' };

  const agents = [
    { id: 'orchestrator', name: 'Orchestrator', detail: () => `Tasks dispatched: ${completedSteps.has(0) && completedSteps.has(4) ? 2 : completedSteps.has(0) ? 1 : 0}` },
    { id: 'drafter',      name: 'Drafter',      detail: () => `Capability: draft-contract` },
    { id: 'reviewer',     name: 'Reviewer',     detail: () => `Capability: review-contract` },
    { id: 'toolProvider', name: 'Tool Provider', detail: () => `Registered: 3 tools | Invocations: ${toolInvocationCount}` },
  ];

  for (const a of agents) {
    const st = agentStatuses[a.id];
    const card = document.getElementById(`agent-${a.id}`);
    if (!card) continue;
    card.querySelector('.agent-dot').className = `agent-dot w-2.5 h-2.5 rounded-full ${dots[st]}`;
    card.querySelector('.agent-status').className = `agent-status text-xs ${colors[st]}`;
    card.querySelector('.agent-status').textContent = st;
    card.querySelector('.agent-detail').textContent = a.detail();
  }
}

// ---------------------------------------------------------------------------
// Render — timeline
// ---------------------------------------------------------------------------

function renderTimeline() {
  for (let pi = 0; pi < PHASES.length; pi++) {
    const phase = PHASES[pi];
    const el = document.getElementById(`phase-${pi}`);
    if (!el) continue;

    const allDone   = phase.steps.every(s => completedSteps.has(s));
    const anyActive = phase.steps.some(s => s === activeStepIndex);

    // Phase card styling
    const card = el.querySelector('.phase-card');
    if (card) {
      card.className = `phase-card flex items-start gap-3 p-3 rounded-lg border transition-all duration-300 ${
        allDone   ? 'border-success/40 bg-success/5' :
        anyActive ? 'border-info/60 bg-info/5 shadow-md shadow-info/10' :
        'border-base-300/40 bg-base-200/50'
      }`;
    }

    // Phase badge
    const badge = el.querySelector('.phase-badge');
    if (badge) {
      badge.className = `phase-badge flex items-center justify-center w-7 h-7 min-w-7 rounded-full text-xs font-bold transition-all duration-300 ${
        allDone   ? 'bg-success text-success-content' :
        anyActive ? 'bg-info text-info-content animate-pulse' :
        'bg-base-300 text-base-content/50'
      }`;
      badge.textContent = allDone ? '\u2713' : phase.icon;
    }

    // Phase label
    const label = el.querySelector('.phase-label');
    if (label) {
      label.className = `phase-label text-sm transition-colors duration-300 ${
        allDone   ? 'text-success' :
        anyActive ? 'text-info font-semibold' :
        'text-base-content/50'
      }`;
    }

    // Sub-step dots and labels
    if (phase.subLabels) {
      phase.steps.forEach((stepIdx) => {
        const subEl = document.getElementById(`substep-${stepIdx}`);
        if (!subEl) return;
        const isDone   = completedSteps.has(stepIdx);
        const isActive = stepIdx === activeStepIndex;
        const dot = subEl.querySelector('.substep-dot');
        const lbl = subEl.querySelector('.substep-label');
        if (isDone) {
          if (dot) dot.className = 'substep-dot w-1.5 h-1.5 rounded-full bg-success';
          if (lbl) lbl.className = 'substep-label text-xs text-success';
        } else if (isActive) {
          if (dot) dot.className = 'substep-dot w-1.5 h-1.5 rounded-full bg-info animate-pulse';
          if (lbl) lbl.className = 'substep-label text-xs text-info font-semibold';
        } else {
          if (dot) dot.className = 'substep-dot w-1.5 h-1.5 rounded-full bg-base-300';
          if (lbl) lbl.className = 'substep-label text-xs text-base-content/40';
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Render — blackboard table
// ---------------------------------------------------------------------------

function renderBlackboard() {
  const tbody = document.getElementById('bb-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const [key, entry] of blackboardEntries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-primary font-mono text-xs">${key}</td>
      <td class="text-xs max-w-xs truncate">${typeof entry.value === 'object' ? JSON.stringify(entry.value) : entry.value}</td>
      <td class="text-xs text-base-content/50">v${entry.version}</td>
      <td class="text-xs text-base-content/50">${entry.updatedBy}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Render — event log
// ---------------------------------------------------------------------------

function renderLog() {
  const container = document.getElementById('event-log');
  if (!container) return;
  // Only append the newest entry
  const entry = logEntries[logEntries.length - 1];
  const div = document.createElement('div');
  div.className = `log-entry ${entry.type}`;
  div.innerHTML = `<span class="text-base-content/40 mr-2">${entry.ts}</span>${entry.message}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ---------------------------------------------------------------------------
// Render — approval panel
// ---------------------------------------------------------------------------

function renderApprovalPanel() {
  const panel = document.getElementById('approval-panel');
  if (!panel) return;

  if (!pendingApproval) {
    panel.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-base-content/30 gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        <span class="text-sm">No pending approvals</span>
      </div>
    `;
    return;
  }

  const req = pendingApproval.request;
  panel.innerHTML = `
    <div class="space-y-3">
      <div class="flex items-center gap-2">
        <span class="badge badge-warning badge-sm">Pending</span>
        <span class="text-sm font-semibold">${req.action}</span>
      </div>
      <div class="bg-base-100 rounded p-3 text-xs font-mono max-h-32 overflow-auto">
        ${JSON.stringify(req.context, null, 2).replace(/\n/g, '<br>').replace(/ /g, '&nbsp;')}
      </div>
      <div class="form-control">
        <label class="label"><span class="label-text text-xs">Reason (optional)</span></label>
        <input type="text" id="approval-reason" placeholder="Enter reason..." class="input input-sm input-bordered w-full" />
      </div>
      <div class="flex gap-2">
        <button id="btn-approve" class="btn btn-success btn-sm flex-1">Approve</button>
        <button id="btn-reject" class="btn btn-error btn-sm flex-1">Reject</button>
      </div>
    </div>
  `;

  document.getElementById('btn-approve').addEventListener('click', () => {
    const reason = document.getElementById('approval-reason').value || 'Approved by human reviewer';
    pendingApproval.respond('approved', reason);
    log('action', `Human approved: "${reason}"`);
    pendingApproval = null;
    renderApprovalPanel();
  });

  document.getElementById('btn-reject').addEventListener('click', () => {
    const reason = document.getElementById('approval-reason').value || 'Rejected by human reviewer';
    pendingApproval.respond('rejected', reason);
    log('action', `Human rejected: "${reason}"`);
    pendingApproval = null;
    renderApprovalPanel();
  });
}

// ---------------------------------------------------------------------------
// Build the DOM
// ---------------------------------------------------------------------------

function buildUI() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="flex flex-col h-screen">

      <!-- Top bar -->
      <header class="navbar bg-base-200 border-b border-base-300 px-6 gap-4 shrink-0">
        <div class="flex-1 flex items-center gap-3">
          <h1 class="text-lg font-bold text-primary">@nolag/agents</h1>
          <span class="text-base-content/50 text-sm hidden sm:inline">Combined Legal Matter Workflow</span>
        </div>
        <div class="flex items-center gap-3">
          <span id="workflow-status" class="badge badge-ghost badge-lg">Idle</span>
          <button id="btn-start" class="btn btn-primary btn-sm">Start Workflow</button>
        </div>
      </header>

      <!-- Main grid -->
      <div class="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_300px] gap-0 overflow-hidden">

        <!-- Left: Agent cards -->
        <aside class="bg-base-200/50 border-r border-base-300 p-4 overflow-y-auto">
          <h2 class="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-3">Agents</h2>
          <div class="space-y-2">
            ${buildAgentCard('orchestrator', 'Orchestrator', 'Tasks dispatched: 0')}
            ${buildAgentCard('drafter', 'Drafter', 'Capability: draft-contract')}
            ${buildAgentCard('reviewer', 'Reviewer', 'Capability: review-contract')}
            ${buildAgentCard('toolProvider', 'Tool Provider', 'Registered: 3 tools | Invocations: 0')}
          </div>

          <!-- Blackboard state (below agents on left panel) -->
          <h2 class="text-xs font-bold uppercase tracking-wider text-base-content/40 mt-6 mb-3">Blackboard State</h2>
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead>
                <tr>
                  <th class="text-base-content/40">Key</th>
                  <th class="text-base-content/40">Value</th>
                  <th class="text-base-content/40">Ver</th>
                  <th class="text-base-content/40">By</th>
                </tr>
              </thead>
              <tbody id="bb-body"></tbody>
            </table>
          </div>
        </aside>

        <!-- Center: Workflow timeline -->
        <main class="p-4 overflow-y-auto">
          <h2 class="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-3">Workflow Timeline</h2>
          <div class="space-y-2">
            ${PHASES.map((phase, pi) => {
              const subStepsHtml = phase.subLabels
                ? phase.steps.map((stepIdx, si) => `
                    <div id="substep-${stepIdx}" class="flex items-center gap-2 ml-10 mt-1">
                      <span class="substep-dot w-1.5 h-1.5 rounded-full bg-base-300"></span>
                      <span class="substep-label text-xs text-base-content/40">${phase.subLabels[si]}</span>
                    </div>
                  `).join('')
                : '';
              return `
                <div id="phase-${pi}" class="flex flex-col">
                  <div class="phase-card flex items-start gap-3 p-3 rounded-lg border border-base-300/40 bg-base-200/50 transition-all duration-300">
                    <span class="phase-badge flex items-center justify-center w-7 h-7 min-w-7 rounded-full text-xs font-bold bg-base-300 text-base-content/50">${phase.icon}</span>
                    <span class="phase-label text-sm text-base-content/50">${phase.label}</span>
                  </div>
                  ${subStepsHtml}
                </div>
              `;
            }).join('')}
          </div>

          <!-- Event log -->
          <h2 class="text-xs font-bold uppercase tracking-wider text-base-content/40 mt-6 mb-3">Event Log</h2>
          <div id="event-log" class="bg-base-200 rounded-lg border border-base-300 p-2 h-48 overflow-y-auto"></div>
        </main>

        <!-- Right: Human Approver -->
        <aside class="bg-base-200/50 border-l border-base-300 p-4 overflow-y-auto">
          <h2 class="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-3">Human Approver</h2>
          <div id="approval-panel" class="min-h-[200px]">
            <div class="flex flex-col items-center justify-center h-full text-base-content/30 gap-2 pt-8">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <span class="text-sm">No pending approvals</span>
            </div>
          </div>

          <h2 class="text-xs font-bold uppercase tracking-wider text-base-content/40 mt-6 mb-3">Pattern Legend</h2>
          <div class="space-y-1 text-xs">
            <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-primary"></span> Handoff (task dispatch)</div>
            <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-info"></span> Tools (RPC invocation)</div>
            <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-secondary"></span> Blackboard (shared state)</div>
            <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-warning"></span> Observe (events)</div>
            <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-error"></span> Approve (human gate)</div>
            <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-accent"></span> Inbox (direct message)</div>
          </div>
        </aside>
      </div>
    </div>
  `;

  // Wire start button
  document.getElementById('btn-start').addEventListener('click', runWorkflow);
}

function buildAgentCard(id, name, detail) {
  return `
    <div id="agent-${id}" class="card bg-base-200 border border-base-300 p-3">
      <div class="flex items-center gap-2 mb-1">
        <span class="agent-dot w-2.5 h-2.5 rounded-full bg-base-300"></span>
        <span class="font-semibold text-sm">${name}</span>
        <span class="agent-status text-xs text-base-content/40 ml-auto">idle</span>
      </div>
      <div class="agent-detail text-xs text-base-content/50">${detail}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Wire up agents (pattern instances)
// ---------------------------------------------------------------------------

// Orchestrator
const orchHandoff    = new Handoff(room);
const orchBlackboard = new Blackboard(room, 'orchestrator');
const orchObserve    = new Observe(room, 'orchestrator');
const orchInbox      = new Inbox(room, 'orchestrator');

// Drafter
const drafterHandoff    = new Handoff(room);
const drafterBlackboard = new Blackboard(room, 'drafter');
const drafterObserve    = new Observe(room, 'drafter');
const drafterTools      = new Tools(room, 'drafter');
const drafterInbox      = new Inbox(room, 'drafter');

// Reviewer
const reviewerHandoff  = new Handoff(room);
const reviewerObserve  = new Observe(room, 'reviewer');
const reviewerTools    = new Tools(room, 'reviewer');
const reviewerApprove  = new Approve(room, 'reviewer');

// Tool Provider — registers tool handlers
const providerTools = new Tools(room, 'tool-provider');

// Human Approver — listens for approval requests
const humanApprove = new Approve(room, 'human');

// ---------------------------------------------------------------------------
// Register tool handlers (Tool Provider)
// ---------------------------------------------------------------------------

providerTools.register('legal-search', async (args) => {
  await delay(300);
  toolInvocationCount++;
  renderAgents();
  return { results: [`Precedent found for "${args.query}"`, 'Case #2024-LM-0042 is relevant'] };
});

providerTools.register('template-fill', async (args) => {
  await delay(400);
  toolInvocationCount++;
  renderAgents();
  return {
    document: `CONTRACT: ${args.templateName || 'Standard NDA'}\nParties: ${args.parties || 'Party A, Party B'}\nTerms: ${args.terms || '12 months, mutual non-disclosure'}\nGenerated: ${new Date().toISOString()}`,
  };
});

providerTools.register('compliance-check', async (args) => {
  await delay(350);
  toolInvocationCount++;
  renderAgents();
  return {
    compliant: true,
    flags: [],
    checkedRules: ['GDPR Art.28', 'SOC-2 Type II', 'ISO 27001 Annex A'],
    summary: 'All compliance checks passed.',
  };
});

// ---------------------------------------------------------------------------
// Register worker handlers
// ---------------------------------------------------------------------------

// Drafter — processes "draft-contract" tasks
drafterHandoff.onTask(async (task, respond) => {
  if (task.capability !== 'draft-contract') return;

  setAgentStatus('drafter', 'working');
  log('action', `Drafter received task: ${task.capability}`);

  // Step 2: invoke template-fill tool
  markStep(1, 'active');
  log('action', 'Drafter invoking template-fill tool...');
  setAgentStatus('toolProvider', 'working');

  const toolResult = await drafterTools.invoke('template-fill', {
    templateName: task.payload.templateName || 'Standard NDA',
    parties: task.payload.parties || 'Acme Corp, Beta Inc',
    terms: task.payload.terms || '12 months, mutual non-disclosure',
  });

  log('event', `template-fill returned: ${toolResult.status}`);
  setAgentStatus('toolProvider', 'done');
  markStep(1, 'done');

  await delay(500);

  // Step 3: write draft to blackboard
  markStep(2, 'active');
  drafterBlackboard.set('contract-draft', {
    document: toolResult.result?.document,
    templateName: task.payload.templateName || 'Standard NDA',
    createdBy: 'drafter',
    createdAt: new Date().toISOString(),
  });
  recordBlackboard('contract-draft', '{ document, templateName, ... }', 1, 'drafter');
  log('action', 'Drafter wrote contract-draft to Blackboard');
  markStep(2, 'done');

  await delay(500);

  // Step 4: emit draft-completed event
  markStep(3, 'active');
  drafterObserve.emit('draft-completed', {
    taskId: task.taskId,
    templateName: task.payload.templateName || 'Standard NDA',
  });
  log('event', 'Event emitted: draft-completed');
  markStep(3, 'done');

  setAgentStatus('drafter', 'done');
  respond('completed', { status: 'draft-ready' });
});

// Reviewer — processes "review-contract" tasks
reviewerHandoff.onTask(async (task, respond) => {
  if (task.capability !== 'review-contract') return;

  setAgentStatus('reviewer', 'working');
  log('action', `Reviewer received task: ${task.capability}`);

  // Step 6: invoke compliance-check tool
  markStep(5, 'active');
  log('action', 'Reviewer invoking compliance-check tool...');
  setAgentStatus('toolProvider', 'working');

  const complianceResult = await reviewerTools.invoke('compliance-check', {
    documentKey: 'contract-draft',
  });

  log('event', `compliance-check returned: ${complianceResult.status} — ${complianceResult.result?.summary}`);
  setAgentStatus('toolProvider', 'done');
  markStep(5, 'done');

  await delay(500);

  // Step 7: request human approval
  markStep(6, 'active');
  log('action', 'Reviewer requesting human approval...');
  setWorkflowStatus('paused');

  const approvalResponse = await reviewerApprove.request(
    'approve-contract',
    {
      document: 'contract-draft',
      complianceStatus: complianceResult.result?.summary,
      checkedRules: complianceResult.result?.checkedRules,
    },
    { urgency: 'high', timeout: 300000 },
  );

  markStep(6, 'done');

  // Step 8: human decision recorded
  markStep(7, 'active');
  const decision = approvalResponse.decision;
  log('event', `Approval decision: ${decision} — "${approvalResponse.reason}"`);
  markStep(7, 'done');

  setWorkflowStatus('running');
  setAgentStatus('reviewer', 'done');
  respond('completed', { decision, reason: approvalResponse.reason });
});

// ---------------------------------------------------------------------------
// Human Approver — bridges UI buttons to the Approve pattern
// ---------------------------------------------------------------------------

humanApprove.onRequest((request, respond) => {
  log('event', `Approval request received: ${request.action}`);
  pendingApproval = { request, respond };
  renderApprovalPanel();
});

// ---------------------------------------------------------------------------
// Global observer — logs all events to the event log
// ---------------------------------------------------------------------------

const globalObserver = new Observe(room, 'observer');
globalObserver.on((envelope) => {
  log('event', `[${envelope.severity}] ${envelope.category}: ${JSON.stringify(envelope.payload)}`);
});

// ---------------------------------------------------------------------------
// Blackboard change observer — keeps the UI table in sync
// ---------------------------------------------------------------------------

orchBlackboard.onChange('contract-draft', (env) => {
  recordBlackboard('contract-draft', env.value, env.version, env.updatedBy);
});
orchBlackboard.onChange('workflow-status', (env) => {
  recordBlackboard('workflow-status', env.value, env.version, env.updatedBy);
});

// ---------------------------------------------------------------------------
// Inbox listener for Drafter — receives completion notifications
// ---------------------------------------------------------------------------

drafterInbox.onMessage((msg) => {
  log('action', `Drafter inbox message from ${msg.from}: ${JSON.stringify(msg.payload)}`);
});

// ---------------------------------------------------------------------------
// Main workflow orchestration
// ---------------------------------------------------------------------------

async function runWorkflow() {
  // Reset state
  workflowStatus = 'idle';
  activeStepIndex = -1;
  completedSteps = new Set();
  toolInvocationCount = 0;
  blackboardEntries.clear();
  logEntries.length = 0;
  pendingApproval = null;
  document.getElementById('event-log').innerHTML = '';
  Object.keys(agentStatuses).forEach(k => agentStatuses[k] = 'idle');

  renderTopBar();
  renderAgents();
  renderTimeline();
  renderBlackboard();
  renderApprovalPanel();

  setWorkflowStatus('running');
  setAgentStatus('orchestrator', 'working');
  log('action', 'Orchestrator starting legal matter workflow...');

  // Initialize blackboard
  orchBlackboard.set('workflow-status', 'in-progress');
  recordBlackboard('workflow-status', 'in-progress', 1, 'orchestrator');

  await delay(600);

  // -----------------------------------------------------------------------
  // Step 1: Dispatch "draft-contract" to Drafter
  // -----------------------------------------------------------------------
  markStep(0, 'active');
  log('action', 'Orchestrator dispatching "draft-contract" task...');

  const draftResult = await orchHandoff.dispatch('draft-contract', {
    matterType: 'NDA',
    templateName: 'Standard NDA',
    parties: 'Acme Corp, Beta Inc',
    terms: '12 months, mutual non-disclosure',
  }, { waitForResult: true, timeout: 30000 });

  log('event', `Draft task result: ${draftResult?.status}`);
  markStep(0, 'done');
  renderAgents();

  await delay(600);

  // -----------------------------------------------------------------------
  // Step 5: Dispatch "review-contract" to Reviewer
  // -----------------------------------------------------------------------
  markStep(4, 'active');
  log('action', 'Orchestrator dispatching "review-contract" task...');

  const reviewResult = await orchHandoff.dispatch('review-contract', {
    documentKey: 'contract-draft',
  }, { waitForResult: true, timeout: 300000 });

  log('event', `Review task result: ${reviewResult?.status}, decision: ${reviewResult?.payload?.decision}`);
  markStep(4, 'done');
  renderAgents();

  await delay(500);

  // -----------------------------------------------------------------------
  // Step 9: Update blackboard status
  // -----------------------------------------------------------------------
  markStep(8, 'active');
  const finalDecision = reviewResult?.payload?.decision || 'unknown';
  orchBlackboard.set('workflow-status', finalDecision);
  recordBlackboard('workflow-status', finalDecision, 2, 'orchestrator');
  log('action', `Blackboard updated: workflow-status = ${finalDecision}`);
  markStep(8, 'done');

  await delay(500);

  // -----------------------------------------------------------------------
  // Step 10: Inbox notification to Drafter
  // -----------------------------------------------------------------------
  markStep(9, 'active');
  orchInbox.send('drafter', {
    type: 'workflow-notification',
    matter: 'Standard NDA',
    decision: finalDecision,
    reason: reviewResult?.payload?.reason || '',
    message: `Your drafted contract has been ${finalDecision}.`,
  });
  log('action', `Orchestrator sent inbox notification to Drafter`);
  markStep(9, 'done');

  await delay(500);

  // -----------------------------------------------------------------------
  // Step 11: Final workflow-complete event
  // -----------------------------------------------------------------------
  markStep(10, 'active');
  orchObserve.emit('workflow-complete', {
    matter: 'Standard NDA',
    decision: finalDecision,
    stepsCompleted: STEPS.length,
  });
  log('event', 'Event emitted: workflow-complete');
  markStep(10, 'done');

  setAgentStatus('orchestrator', 'done');
  setWorkflowStatus('completed');
  log('action', `Workflow finished. Final decision: ${finalDecision}`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

buildUI();
renderTopBar();
renderAgents();
renderTimeline();
renderBlackboard();
