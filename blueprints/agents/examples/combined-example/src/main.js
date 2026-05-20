/**
 * @nolag/agents — All Patterns Test App
 *
 * Tests all 6 agent coordination patterns using REAL NoLag connections:
 *   1. Handoff    — dispatch tasks, workers respond with correlated results
 *   2. Blackboard — shared key-value state across agents
 *   3. Observe    — observability event stream with severity/category
 *   4. Inbox      — per-agent direct messaging
 *   5. Approve    — human-in-the-loop approval gates
 *   6. Tools      — typed RPC tool invocations over pub/sub
 *
 * Each agent connects independently via its own access token.
 */

import {
  NoLagAgents,
  Handoff,
  Blackboard,
  Observe,
  Inbox,
  Approve,
  Tools,
} from '@nolag/agents';

// ============================================================
// State
// ============================================================
const eventLog = [];
let activeTab = 'handoff';
let connecting = false;
let connected = false;

// Form values (set on connect)
let APP_NAME = '';
let ROOM_NAME = '';

// Connections (one per agent)
const connections = {};

// Pattern instances (set on connect)
let orchestratorHandoff = null;
let workerHandoffs = [];
const claimedTasks = new Set();
const taskFlow = [];

// Blackboard
let blackboardA = null;
let blackboardB = null;
const stateEntries = [];

// Observe
let observerEmitter = null;
let observerListener = null;
const observeEvents = [];

// Inbox
let inboxAgent1 = null;
let inboxAgent2 = null;
const inboxMessages = [];

// Approve
let approveRequester = null;
let approveResponder = null;
const approvalFlow = [];

// Tools
let toolsCaller = null;
let toolsProvider = null;
const toolFlow = [];

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
  if (eventLog.length > 300) eventLog.shift();
  renderEventLog();
}

function $(sel) { return document.querySelector(sel); }

// ============================================================
// Workers for Handoff
// ============================================================
const WORKERS = [
  { id: 'worker-1', name: 'Researcher', capability: 'research', color: 'badge-info' },
  { id: 'worker-2', name: 'Summarizer', capability: 'summarize', color: 'badge-warning' },
  { id: 'worker-3', name: 'Reviewer', capability: 'review', color: 'badge-error' },
  { id: 'worker-4', name: 'Researcher B', capability: 'research', color: 'badge-success' },
];

// ============================================================
// Connect — real NoLag connections
// ============================================================

async function connectAgent(name, token) {
  const client = new NoLagAgents(token, {
    appName: APP_NAME,
    rooms: [ROOM_NAME],
    debug: false,
  });
  await client.connect();
  connections[name] = client;
  return client.room(ROOM_NAME);
}

async function startConnection() {
  if (connecting || connected) return;

  // Read form values
  const appSlug = $('#input-app-slug')?.value?.trim();
  const roomSlug = $('#input-room-slug')?.value?.trim() || 'default-workflow';
  const orchToken = $('#input-orch-token')?.value?.trim();
  const w1Token = $('#input-w1-token')?.value?.trim();
  const w2Token = $('#input-w2-token')?.value?.trim();
  const w3Token = $('#input-w3-token')?.value?.trim();
  const w4Token = $('#input-w4-token')?.value?.trim();
  const errorEl = $('#connect-error');

  // Validate
  if (!appSlug) {
    if (errorEl) { errorEl.textContent = 'App Slug is required'; errorEl.classList.remove('hidden'); }
    return;
  }
  if (!orchToken || !w1Token || !w2Token || !w3Token || !w4Token) {
    if (errorEl) { errorEl.textContent = 'All 5 tokens are required'; errorEl.classList.remove('hidden'); }
    return;
  }

  APP_NAME = appSlug;
  ROOM_NAME = roomSlug;

  if (errorEl) errorEl.classList.add('hidden');
  connecting = true;
  renderApp();

  try {
    log('action', 'Connecting all agents to NoLag...');

    // Connect all agents in parallel
    const [orchRoom, w1Room, w2Room, w3Room, w4Room] = await Promise.all([
      connectAgent('orchestrator', orchToken),
      connectAgent('worker-1', w1Token),
      connectAgent('worker-2', w2Token),
      connectAgent('worker-3', w3Token),
      connectAgent('worker-4', w4Token),
    ]);

    log('success', `Connected 5 agents to app "${APP_NAME}" / room "${ROOM_NAME}"`);

    // -- Handoff --
    orchestratorHandoff = new Handoff(orchRoom);
    const workerRooms = [
      { worker: WORKERS[0], room: w1Room },
      { worker: WORKERS[1], room: w2Room },
      { worker: WORKERS[2], room: w3Room },
      { worker: WORKERS[3], room: w4Room },
    ];
    workerRooms.forEach(({ worker: w, room }) => {
      const handoff = new Handoff(room);
      handoff.onTask((task, respond) => {
        if (task.capability !== w.capability) return;
        const isShared = WORKERS.filter(x => x.capability === w.capability).length > 1;
        if (isShared) {
          if (claimedTasks.has(task.taskId)) return;
          claimedTasks.add(task.taskId);
        }
        log('event', `[Handoff] ${w.name} received: ${task.capability}`);
        const flowEntry = taskFlow.find(f => f.id === task.taskId);
        if (flowEntry) { flowEntry.status = 'processing'; flowEntry.worker = w.name; renderPatternContent(); }
        const delay = task.priority === 'critical' ? 300 : task.priority === 'high' ? 500 : 800;
        setTimeout(() => {
          respond('success', { output: `Result from ${w.name}: processed "${task.payload.description}"`, quality: 0.95 });
          log('success', `[Handoff] ${w.name} completed: ${task.capability}`);
        }, delay);
      });
      workerHandoffs.push({ worker: w, handoff });
    });
    log('action', `[Handoff] Registered ${WORKERS.length} workers`);

    // -- Blackboard (orchestrator + worker-1 share the room) --
    blackboardA = new Blackboard(orchRoom, 'agent-alpha');
    blackboardB = new Blackboard(w1Room, 'agent-beta');
    blackboardA.onChange('status', (env) => {
      log('event', `[Blackboard] agent-alpha saw status change: ${JSON.stringify(env.value)}`);
    });
    blackboardB.onChange('status', (env) => {
      log('event', `[Blackboard] agent-beta saw status change: ${JSON.stringify(env.value)}`);
    });
    log('action', '[Blackboard] Initialized agent-alpha (orchestrator) and agent-beta (worker-1)');

    // -- Observe (worker-2 emits, worker-3 listens) --
    observerEmitter = new Observe(w2Room, 'worker-agent');
    observerListener = new Observe(w3Room, 'dashboard');
    observerListener.on((env) => {
      observeEvents.unshift(env);
      if (observeEvents.length > 30) observeEvents.pop();
      log('event', `[Observe] ${env.severity}: ${env.category} — ${JSON.stringify(env.payload)}`);
      renderPatternContent();
    });
    log('action', '[Observe] Initialized emitter (worker-2) and listener (worker-3)');

    // -- Inbox (orchestrator = agent-1, worker-1 = agent-2) --
    inboxAgent1 = new Inbox(orchRoom, 'agent-1');
    inboxAgent2 = new Inbox(w1Room, 'agent-2');
    inboxAgent1.onMessage((msg) => {
      inboxMessages.unshift({ ...msg, direction: 'received-by-1' });
      if (inboxMessages.length > 30) inboxMessages.pop();
      log('event', `[Inbox] agent-1 received from ${msg.from}: ${JSON.stringify(msg.payload)}`);
      renderPatternContent();
    });
    inboxAgent2.onMessage((msg) => {
      inboxMessages.unshift({ ...msg, direction: 'received-by-2' });
      if (inboxMessages.length > 30) inboxMessages.pop();
      log('event', `[Inbox] agent-2 received from ${msg.from}: ${JSON.stringify(msg.payload)}`);
      renderPatternContent();
    });
    log('action', '[Inbox] Initialized agent-1 (orchestrator) and agent-2 (worker-1)');

    // -- Approve (orchestrator requests, worker-4 reviews) --
    approveRequester = new Approve(orchRoom, 'ai-agent');
    approveResponder = new Approve(w4Room, 'human-reviewer');
    approveResponder.onRequest((req, respond) => {
      const entry = { ...req, status: 'pending', response: null };
      approvalFlow.unshift(entry);
      if (approvalFlow.length > 20) approvalFlow.pop();
      log('event', `[Approve] Request: "${req.action}" (urgency: ${req.urgency})`);
      renderPatternContent();
      entry._respond = respond;
    });
    log('action', '[Approve] Initialized ai-agent (orchestrator) and human-reviewer (worker-4)');

    // -- Tools (orchestrator calls, worker-3 provides) --
    toolsCaller = new Tools(orchRoom, 'orchestrator');
    toolsProvider = new Tools(w3Room, 'tool-server');
    toolsProvider.register('search', async (args) => {
      await new Promise(r => setTimeout(r, 400));
      return { results: [`Result for "${args.query}"`, 'Related doc 1', 'Related doc 2'], count: 3 };
    });
    toolsProvider.register('calculate', async (args) => {
      await new Promise(r => setTimeout(r, 200));
      const expr = String(args.expression);
      try { return { result: Function('"use strict"; return (' + expr + ')')() }; }
      catch { return { error: 'Invalid expression' }; }
    });
    toolsProvider.register('summarize', async (args) => {
      await new Promise(r => setTimeout(r, 600));
      const text = String(args.text || '');
      return { summary: text.slice(0, 80) + (text.length > 80 ? '...' : ''), wordCount: text.split(/\s+/).length };
    });
    log('action', '[Tools] Registered tools: search, calculate, summarize');

    connected = true;
    connecting = false;
    renderApp();
  } catch (err) {
    connecting = false;
    log('error', `Connection failed: ${err.message}`);
    renderApp();
  }
}

function disconnect() {
  Object.values(connections).forEach(c => c.disconnect());
  Object.keys(connections).forEach(k => delete connections[k]);
  orchestratorHandoff = null;
  workerHandoffs = [];
  claimedTasks.clear();
  blackboardA = null;
  blackboardB = null;
  observerEmitter = null;
  observerListener = null;
  inboxAgent1 = null;
  inboxAgent2 = null;
  approveRequester = null;
  approveResponder = null;
  toolsCaller = null;
  toolsProvider = null;
  connected = false;
  log('action', 'Disconnected all agents');
  renderApp();
}

// ============================================================
// Pattern Actions
// ============================================================

// Handoff
async function dispatchHandoffTask(capability, description, priority) {
  if (!orchestratorHandoff) return;
  const taskId = crypto.randomUUID();
  const entry = { id: taskId, capability, priority, status: 'dispatched', payload: description, worker: null, result: null, error: null, dispatchedAt: Date.now(), completedAt: null };
  taskFlow.unshift(entry);
  if (taskFlow.length > 20) taskFlow.pop();
  renderPatternContent();
  log('action', `[Handoff] Dispatch: ${capability} (${priority})`);
  try {
    const result = await orchestratorHandoff.dispatch(capability, { description }, { priority, timeout: 5000, waitForResult: true });
    const recent = taskFlow.find(f => f.status === 'dispatched' || f.status === 'processing');
    if (recent) { recent.status = result.status; recent.result = result.payload; recent.completedAt = result.completedAt; }
    renderPatternContent();
  } catch (err) {
    entry.status = 'error'; entry.error = err.message; entry.completedAt = Date.now();
    log('error', `[Handoff] Failed: ${err.message}`);
    renderPatternContent();
  }
}

// Blackboard
function setBlackboardState(agent, key, value) {
  const bb = agent === 'alpha' ? blackboardA : blackboardB;
  if (!bb) return;
  bb.set(key, value);
  stateEntries.unshift({ key, value, agent: `agent-${agent}`, time: Date.now() });
  if (stateEntries.length > 20) stateEntries.pop();
  log('action', `[Blackboard] agent-${agent} set "${key}" = ${JSON.stringify(value)}`);
  renderPatternContent();
}

// Observe
function emitObserveEvent(category, severity, payload) {
  if (!observerEmitter) return;
  observerEmitter.emit(category, payload, severity);
  log('action', `[Observe] Emitted: ${severity} ${category}`);
}

// Inbox
function sendInboxMessage(from, to, payload) {
  const sender = from === 'agent-1' ? inboxAgent1 : inboxAgent2;
  if (!sender) return;
  sender.send(to, payload);
  log('action', `[Inbox] ${from} -> ${to}: ${JSON.stringify(payload)}`);
}

// Approve
async function requestApproval(action, context, urgency) {
  if (!approveRequester) return;
  log('action', `[Approve] Requesting: "${action}" (${urgency})`);
  try {
    const response = await approveRequester.request(action, context, { urgency, timeout: 30000 });
    log('success', `[Approve] Decision: ${response.decision} -- ${response.reason || 'no reason'}`);
    const entry = approvalFlow.find(f => f.correlationId === response.correlationId);
    if (entry) { entry.status = response.decision; entry.response = response; }
    renderPatternContent();
  } catch (err) {
    log('error', `[Approve] Timeout: ${err.message}`);
  }
}

function respondToApproval(index, decision, reason) {
  const entry = approvalFlow[index];
  if (!entry || !entry._respond) return;
  entry._respond(decision, reason);
  entry.status = decision;
  log('action', `[Approve] Responded: ${decision} -- ${reason}`);
  renderPatternContent();
}

// Tools
async function invokeTool(toolName, args) {
  if (!toolsCaller) return;
  const entry = { toolName, args, status: 'calling', result: null, error: null, startedAt: Date.now(), completedAt: null };
  toolFlow.unshift(entry);
  if (toolFlow.length > 20) toolFlow.pop();
  renderPatternContent();
  log('action', `[Tools] Invoking: ${toolName}(${JSON.stringify(args)})`);
  try {
    const response = await toolsCaller.invoke(toolName, args, { timeout: 5000 });
    entry.status = response.status;
    entry.result = response.result;
    entry.completedAt = response.respondedAt;
    log('success', `[Tools] ${toolName} -> ${response.status}`);
    renderPatternContent();
  } catch (err) {
    entry.status = 'error'; entry.error = err.message; entry.completedAt = Date.now();
    log('error', `[Tools] ${toolName} failed: ${err.message}`);
    renderPatternContent();
  }
}

// ============================================================
// Render
// ============================================================
function renderApp() {
  const app = $('#app');
  app.innerHTML = `
    <div class="h-screen flex flex-col bg-base-200">
      <!-- Navbar -->
      <div class="navbar bg-base-100 shadow-lg px-4 flex-shrink-0">
        <div class="flex-1 gap-2">
          <span class="text-xl font-bold">@nolag/agents -- Pattern Tester</span>
          <div class="badge ${connected ? 'badge-success' : connecting ? 'badge-warning' : 'badge-error'} badge-sm">
            ${connected ? 'Connected' : connecting ? 'Connecting...' : 'Disconnected'}
          </div>
        </div>
        <div class="flex-none gap-1">
          ${connected ? `<button id="btn-disconnect" class="btn btn-ghost btn-xs text-error">Disconnect</button>` : ''}
          ${WORKERS.map(w => `<div class="badge ${w.color} badge-xs">${esc(w.name)}</div>`).join('')}
        </div>
      </div>

      ${!connected && !connecting ? renderConnectPanel() : connecting ? renderConnectingPanel() : renderMainLayout()}
    </div>
  `;

  if (!connected && !connecting) {
    attachConnectListeners();
  } else if (connected) {
    renderPatternContent();
    renderEventLog();
    attachTabListeners();
    $('#btn-disconnect')?.addEventListener('click', disconnect);
  }
}

function renderConnectingPanel() {
  return `
    <div class="flex-1 flex items-center justify-center">
      <div class="card bg-base-100 shadow-xl w-[32rem]">
        <div class="card-body items-center text-center">
          <span class="loading loading-spinner loading-lg text-primary"></span>
          <h2 class="card-title text-xl mt-4">Connecting to NoLag...</h2>
          <p class="text-base-content/60 text-sm">Establishing 5 agent connections</p>
        </div>
      </div>
    </div>
  `;
}

function renderConnectPanel() {
  return `
    <div class="flex-1 flex items-center justify-center overflow-y-auto py-8">
      <div class="card bg-base-100 shadow-xl w-[36rem]">
        <div class="card-body">
          <h2 class="card-title justify-center text-2xl">@nolag/agents -- Pattern Tester</h2>
          <p class="text-center text-base-content/60 text-sm">
            Test all 6 agent coordination patterns (Handoff, Blackboard, Observe, Inbox, Approve, Tools) with real NoLag connections
          </p>

          <div class="divider text-xs">SETUP INSTRUCTIONS</div>
          <div class="bg-base-200 rounded-lg p-3 text-sm space-y-1">
            <p class="font-semibold text-base-content/80">Create these actors in the NoLag Portal:</p>
            <ul class="list-disc list-inside text-base-content/60 text-xs space-y-0.5 ml-2">
              <li>1 Orchestrator (actor type: orchestrator)</li>
              <li>4 Workers (actor type: agent)</li>
            </ul>
          </div>

          <div class="divider text-xs">CONNECTION</div>

          <div class="form-control">
            <label class="label"><span class="label-text">App Slug</span></label>
            <input id="input-app-slug" type="text" placeholder="your-app-slug"
                   class="input input-bordered input-sm" />
          </div>

          <div class="form-control">
            <label class="label"><span class="label-text">Room Slug</span></label>
            <input id="input-room-slug" type="text" placeholder="default-workflow"
                   class="input input-bordered input-sm" value="default-workflow" />
          </div>

          <div class="form-control">
            <label class="label"><span class="label-text">Orchestrator Token</span></label>
            <input id="input-orch-token" type="text" placeholder="Paste orchestrator access token"
                   class="input input-bordered input-sm" />
          </div>

          <div class="form-control">
            <label class="label">
              <span class="label-text">Worker 1 Token</span>
              <span class="label-text-alt text-info text-xs">Capability: research</span>
            </label>
            <input id="input-w1-token" type="text" placeholder="Paste worker 1 access token"
                   class="input input-bordered input-sm" />
          </div>

          <div class="form-control">
            <label class="label">
              <span class="label-text">Worker 2 Token</span>
              <span class="label-text-alt text-warning text-xs">Capability: summarize</span>
            </label>
            <input id="input-w2-token" type="text" placeholder="Paste worker 2 access token"
                   class="input input-bordered input-sm" />
          </div>

          <div class="form-control">
            <label class="label">
              <span class="label-text">Worker 3 Token</span>
              <span class="label-text-alt text-error text-xs">Capability: review</span>
            </label>
            <input id="input-w3-token" type="text" placeholder="Paste worker 3 access token"
                   class="input input-bordered input-sm" />
          </div>

          <div class="form-control">
            <label class="label">
              <span class="label-text">Worker 4 Token</span>
              <span class="label-text-alt text-success text-xs">Capability: research (load-balanced)</span>
            </label>
            <input id="input-w4-token" type="text" placeholder="Paste worker 4 access token"
                   class="input input-bordered input-sm" />
          </div>

          <div id="connect-error" class="alert alert-error text-sm hidden mt-2"></div>

          <div class="card-actions justify-center mt-4">
            <button id="btn-connect" class="btn btn-primary btn-wide">Connect</button>
          </div>

          <div class="divider text-xs">SDK FEATURES</div>
          <ul class="text-xs text-base-content/60 space-y-1">
            <li><code class="badge badge-xs badge-ghost">Handoff</code> -- dispatch tasks to capability-matched workers</li>
            <li><code class="badge badge-xs badge-ghost">Blackboard</code> -- shared key-value state across agents</li>
            <li><code class="badge badge-xs badge-ghost">Observe</code> -- observability event stream with severity/category</li>
            <li><code class="badge badge-xs badge-ghost">Inbox</code> -- per-agent direct messaging</li>
            <li><code class="badge badge-xs badge-ghost">Approve</code> -- human-in-the-loop approval gates</li>
            <li><code class="badge badge-xs badge-ghost">Tools</code> -- typed RPC tool invocations over pub/sub</li>
          </ul>
        </div>
      </div>
    </div>
  `;
}

function renderMainLayout() {
  const tabs = [
    { id: 'handoff', label: 'Handoff', icon: '&#10132;' },
    { id: 'blackboard', label: 'Blackboard', icon: '&#9638;' },
    { id: 'observe', label: 'Observe', icon: '&#9673;' },
    { id: 'inbox', label: 'Inbox', icon: '&#9993;' },
    { id: 'approve', label: 'Approve', icon: '&#10003;' },
    { id: 'tools', label: 'Tools', icon: '&#9881;' },
  ];

  return `
    <div class="flex-1 flex overflow-hidden min-h-0">
      <!-- Left: Tabs + Pattern Panel -->
      <div class="flex-1 flex flex-col min-w-0">
        <div class="flex bg-base-100 border-b border-base-300 flex-shrink-0">
          ${tabs.map(t => `
            <button class="tab-btn px-4 py-2 text-sm font-semibold cursor-pointer border-b-2 border-transparent hover:bg-base-200 ${activeTab === t.id ? 'tab-active text-primary' : 'text-base-content/60'}" data-tab="${t.id}">
              <span class="mr-1">${t.icon}</span> ${t.label}
            </button>
          `).join('')}
        </div>
        <div id="pattern-content" class="flex-1 overflow-y-auto p-4"></div>
      </div>

      <!-- Right: Event log -->
      <div class="w-72 bg-base-100 border-l border-base-300 flex flex-col flex-shrink-0">
        <div class="p-3 border-b border-base-300 flex items-center justify-between">
          <h3 class="font-semibold text-sm">Event Log</h3>
          <button id="btn-clear-log" class="btn btn-ghost btn-xs">Clear</button>
        </div>
        <div id="event-log" class="flex-1 overflow-y-auto p-2 text-xs bg-base-200/50"></div>
      </div>
    </div>
  `;
}

// ============================================================
// Pattern Content Renderers
// ============================================================
function renderPatternContent() {
  const el = $('#pattern-content');
  if (!el) return;

  switch (activeTab) {
    case 'handoff': el.innerHTML = renderHandoffTab(); attachHandoffListeners(); break;
    case 'blackboard': el.innerHTML = renderBlackboardTab(); attachBlackboardListeners(); break;
    case 'observe': el.innerHTML = renderObserveTab(); attachObserveListeners(); break;
    case 'inbox': el.innerHTML = renderInboxTab(); attachInboxListeners(); break;
    case 'approve': el.innerHTML = renderApproveTab(); attachApproveListeners(); break;
    case 'tools': el.innerHTML = renderToolsTab(); attachToolsListeners(); break;
  }
}

// --- Handoff Tab ---
function renderHandoffTab() {
  return `
    <div class="flex gap-4">
      <div class="w-72 flex-shrink-0 space-y-3">
        <h3 class="font-semibold">Dispatch Task</h3>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Capability</span></label>
          <select id="h-cap" class="select select-bordered select-sm">
            <option value="research">research</option>
            <option value="summarize">summarize</option>
            <option value="review">review</option>
            <option value="unknown">unknown (no match)</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Description</span></label>
          <input id="h-desc" type="text" class="input input-bordered input-sm" value="Analyze market trends" />
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Priority</span></label>
          <div class="flex gap-2">
            ${['low', 'medium', 'high', 'critical'].map(p => `
              <label class="label cursor-pointer gap-1">
                <input type="radio" name="h-pri" value="${p}" class="radio radio-xs" ${p === 'medium' ? 'checked' : ''} />
                <span class="text-xs">${p}</span>
              </label>
            `).join('')}
          </div>
        </div>
        <button id="btn-h-dispatch" class="btn btn-primary btn-sm w-full">Dispatch</button>

        <div class="divider text-xs">QUICK</div>
        <button class="btn btn-ghost btn-xs w-full justify-start h-quick" data-cap="research" data-desc="AI ethics survey" data-pri="high">Research: AI ethics (high)</button>
        <button class="btn btn-ghost btn-xs w-full justify-start h-quick" data-cap="summarize" data-desc="Q4 earnings report" data-pri="medium">Summarize: Q4 earnings (medium)</button>
        <button class="btn btn-ghost btn-xs w-full justify-start h-quick" data-cap="review" data-desc="Pull request #42" data-pri="critical">Review: PR #42 (critical)</button>
        <button class="btn btn-ghost btn-xs w-full justify-start text-error/70 h-quick" data-cap="unknown" data-desc="No handler" data-pri="medium">Unknown: timeout test</button>
      </div>
      <div class="flex-1 space-y-2">
        <div class="flex items-center justify-between">
          <h3 class="font-semibold">Task Flow</h3>
          <button id="btn-h-clear" class="btn btn-ghost btn-xs">Clear</button>
        </div>
        ${taskFlow.length === 0 ? '<p class="text-base-content/40 text-sm">No tasks dispatched yet</p>' :
          taskFlow.map(f => {
            const badge = { dispatched: 'badge-info', processing: 'badge-warning', success: 'badge-success', error: 'badge-error' }[f.status] || 'badge-ghost';
            const priBadge = { critical: 'badge-error', high: 'badge-warning', medium: 'badge-info', low: 'badge-ghost' }[f.priority];
            return `
              <div class="card bg-base-100 shadow-sm border border-base-300">
                <div class="card-body p-3">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-sm">${esc(f.capability)}</span>
                    <span class="badge ${badge} badge-xs">${f.status}</span>
                    <span class="badge ${priBadge} badge-xs">${f.priority}</span>
                    ${f.completedAt ? `<span class="text-xs text-base-content/50">${f.completedAt - f.dispatchedAt}ms</span>` : ''}
                  </div>
                  <p class="text-xs text-base-content/60">"${esc(f.payload)}"</p>
                  ${f.worker ? `<p class="text-xs text-base-content/60">Worker: <span class="text-primary">${esc(f.worker)}</span></p>` : ''}
                  ${f.result ? `<pre class="bg-base-200 rounded p-2 text-xs mt-1">${esc(JSON.stringify(f.result, null, 2))}</pre>` : ''}
                  ${f.error ? `<p class="text-xs text-error mt-1">${esc(f.error)}</p>` : ''}
                </div>
              </div>`;
          }).join('')
        }
      </div>
    </div>`;
}

// --- Blackboard Tab ---
function renderBlackboardTab() {
  const allState = blackboardA ? [...blackboardA.getAll().entries()] : [];
  return `
    <div class="flex gap-4">
      <div class="w-72 flex-shrink-0 space-y-3">
        <h3 class="font-semibold">Set State</h3>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Agent</span></label>
          <select id="bb-agent" class="select select-bordered select-sm">
            <option value="alpha">agent-alpha</option>
            <option value="beta">agent-beta</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Key</span></label>
          <input id="bb-key" type="text" class="input input-bordered input-sm" value="status" />
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Value (JSON)</span></label>
          <input id="bb-val" type="text" class="input input-bordered input-sm" value='"ready"' />
        </div>
        <button id="btn-bb-set" class="btn btn-primary btn-sm w-full">Set State</button>

        <div class="divider text-xs">QUICK</div>
        <button class="btn btn-ghost btn-xs w-full justify-start bb-quick" data-agent="alpha" data-key="status" data-val='"processing"'>alpha: status = "processing"</button>
        <button class="btn btn-ghost btn-xs w-full justify-start bb-quick" data-agent="beta" data-key="status" data-val='"idle"'>beta: status = "idle"</button>
        <button class="btn btn-ghost btn-xs w-full justify-start bb-quick" data-agent="alpha" data-key="progress" data-val="75">alpha: progress = 75</button>
        <button class="btn btn-ghost btn-xs w-full justify-start bb-quick" data-agent="beta" data-key="config" data-val='{"model":"gpt-4","temp":0.7}'>beta: config = {model, temp}</button>
      </div>
      <div class="flex-1 space-y-3">
        <h3 class="font-semibold">Current State</h3>
        ${allState.length === 0 ? '<p class="text-base-content/40 text-sm">No state entries yet</p>' :
          `<div class="overflow-x-auto"><table class="table table-xs">
            <thead><tr><th>Key</th><th>Value</th><th>Version</th><th>Updated By</th></tr></thead>
            <tbody>${allState.map(([key, env]) => `
              <tr><td class="font-mono">${esc(key)}</td><td><pre class="text-xs">${esc(JSON.stringify(env.value))}</pre></td><td>${env.version}</td><td>${esc(env.updatedBy)}</td></tr>
            `).join('')}</tbody>
          </table></div>`
        }
        <h3 class="font-semibold mt-4">State Change History</h3>
        ${stateEntries.length === 0 ? '<p class="text-base-content/40 text-sm">No changes yet</p>' :
          stateEntries.map(e => `
            <div class="bg-base-100 border border-base-300 rounded p-2 text-xs">
              <span class="text-primary">${esc(e.agent)}</span> set <span class="font-mono">${esc(e.key)}</span> = <span class="font-mono">${esc(JSON.stringify(e.value))}</span>
              <span class="text-base-content/40 ml-2">${time(e.time)}</span>
            </div>
          `).join('')
        }
      </div>
    </div>`;
}

// --- Observe Tab ---
function renderObserveTab() {
  return `
    <div class="flex gap-4">
      <div class="w-72 flex-shrink-0 space-y-3">
        <h3 class="font-semibold">Emit Event</h3>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Category</span></label>
          <input id="ob-cat" type="text" class="input input-bordered input-sm" value="decision" />
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Severity</span></label>
          <select id="ob-sev" class="select select-bordered select-sm">
            <option value="debug">debug</option>
            <option value="info" selected>info</option>
            <option value="warning">warning</option>
            <option value="error">error</option>
            <option value="critical">critical</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Payload (JSON)</span></label>
          <input id="ob-payload" type="text" class="input input-bordered input-sm" value='{"action":"chose model A"}' />
        </div>
        <button id="btn-ob-emit" class="btn btn-primary btn-sm w-full">Emit Event</button>

        <div class="divider text-xs">QUICK</div>
        <button class="btn btn-ghost btn-xs w-full justify-start ob-quick" data-cat="tool_call" data-sev="info" data-pay='{"tool":"search","query":"nolag docs"}'>info: tool_call (search)</button>
        <button class="btn btn-ghost btn-xs w-full justify-start ob-quick" data-cat="decision" data-sev="warning" data-pay='{"confidence":0.45,"fallback":true}'>warning: low confidence decision</button>
        <button class="btn btn-ghost btn-xs w-full justify-start ob-quick" data-cat="state_change" data-sev="debug" data-pay='{"from":"idle","to":"processing"}'>debug: state_change</button>
        <button class="btn btn-ghost btn-xs w-full justify-start ob-quick" data-cat="error" data-sev="error" data-pay='{"message":"API rate limited","retryIn":30}'>error: API rate limited</button>
      </div>
      <div class="flex-1 space-y-2">
        <h3 class="font-semibold">Event Stream</h3>
        ${observeEvents.length === 0 ? '<p class="text-base-content/40 text-sm">No events yet</p>' :
          observeEvents.map(e => {
            const sevColor = { debug: 'badge-ghost', info: 'badge-info', warning: 'badge-warning', error: 'badge-error', critical: 'badge-error' }[e.severity];
            return `
              <div class="card bg-base-100 shadow-sm border border-base-300">
                <div class="card-body p-3">
                  <div class="flex items-center gap-2">
                    <span class="badge ${sevColor} badge-xs">${e.severity}</span>
                    <span class="font-semibold text-sm">${esc(e.category)}</span>
                    <span class="text-xs text-base-content/40 ml-auto">${esc(e.emittedBy)}</span>
                  </div>
                  <pre class="text-xs bg-base-200 rounded p-2 mt-1">${esc(JSON.stringify(e.payload, null, 2))}</pre>
                </div>
              </div>`;
          }).join('')
        }
      </div>
    </div>`;
}

// --- Inbox Tab ---
function renderInboxTab() {
  return `
    <div class="flex gap-4">
      <div class="w-72 flex-shrink-0 space-y-3">
        <h3 class="font-semibold">Send Message</h3>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">From</span></label>
          <select id="ib-from" class="select select-bordered select-sm">
            <option value="agent-1">agent-1</option>
            <option value="agent-2">agent-2</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">To</span></label>
          <select id="ib-to" class="select select-bordered select-sm">
            <option value="agent-2">agent-2</option>
            <option value="agent-1">agent-1</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Payload (JSON)</span></label>
          <input id="ib-payload" type="text" class="input input-bordered input-sm" value='{"text":"Hey, task done!"}' />
        </div>
        <button id="btn-ib-send" class="btn btn-primary btn-sm w-full">Send Message</button>

        <div class="divider text-xs">QUICK</div>
        <button class="btn btn-ghost btn-xs w-full justify-start ib-quick" data-from="agent-1" data-to="agent-2" data-pay='{"text":"Research complete, here are the results","items":3}'>agent-1 -> agent-2: Research done</button>
        <button class="btn btn-ghost btn-xs w-full justify-start ib-quick" data-from="agent-2" data-to="agent-1" data-pay='{"text":"Please review section 3","urgent":true}'>agent-2 -> agent-1: Review request</button>
      </div>
      <div class="flex-1 space-y-2">
        <h3 class="font-semibold">Message Log</h3>
        ${inboxMessages.length === 0 ? '<p class="text-base-content/40 text-sm">No messages yet</p>' :
          inboxMessages.map(m => `
            <div class="card bg-base-100 shadow-sm border border-base-300">
              <div class="card-body p-3">
                <div class="flex items-center gap-2">
                  <span class="badge badge-info badge-xs">${esc(m.from)}</span>
                  <span>&#10132;</span>
                  <span class="badge badge-accent badge-xs">${esc(m.to)}</span>
                  <span class="text-xs text-base-content/40 ml-auto">${time(m.createdAt)}</span>
                </div>
                <pre class="text-xs bg-base-200 rounded p-2 mt-1">${esc(JSON.stringify(m.payload, null, 2))}</pre>
              </div>
            </div>
          `).join('')
        }
      </div>
    </div>`;
}

// --- Approve Tab ---
function renderApproveTab() {
  return `
    <div class="flex gap-4">
      <div class="w-72 flex-shrink-0 space-y-3">
        <h3 class="font-semibold">Request Approval</h3>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Action</span></label>
          <input id="ap-action" type="text" class="input input-bordered input-sm" value="Deploy to production" />
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Context (JSON)</span></label>
          <input id="ap-context" type="text" class="input input-bordered input-sm" value='{"env":"prod","version":"2.1.0"}' />
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Urgency</span></label>
          <select id="ap-urgency" class="select select-bordered select-sm">
            <option value="low">low</option>
            <option value="medium" selected>medium</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </select>
        </div>
        <button id="btn-ap-request" class="btn btn-primary btn-sm w-full">Request Approval</button>

        <div class="divider text-xs">QUICK</div>
        <button class="btn btn-ghost btn-xs w-full justify-start ap-quick" data-action="Send email to 10k users" data-ctx='{"campaign":"summer-sale"}' data-urg="high">Send mass email (high)</button>
        <button class="btn btn-ghost btn-xs w-full justify-start ap-quick" data-action="Delete old records" data-ctx='{"table":"logs","olderThan":"90d"}' data-urg="critical">Delete old records (critical)</button>
      </div>
      <div class="flex-1 space-y-2">
        <h3 class="font-semibold">Approval Queue</h3>
        ${approvalFlow.length === 0 ? '<p class="text-base-content/40 text-sm">No approval requests yet</p>' :
          approvalFlow.map((a, i) => {
            const urgBadge = { low: 'badge-ghost', medium: 'badge-info', high: 'badge-warning', critical: 'badge-error' }[a.urgency];
            const statusBadge = a.status === 'pending' ? 'badge-warning' : a.status === 'approved' ? 'badge-success' : 'badge-error';
            return `
              <div class="card bg-base-100 shadow-sm border border-base-300">
                <div class="card-body p-3">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-sm">${esc(a.action)}</span>
                    <span class="badge ${statusBadge} badge-xs">${a.status}</span>
                    <span class="badge ${urgBadge} badge-xs">${a.urgency}</span>
                  </div>
                  <pre class="text-xs bg-base-200 rounded p-2 mt-1">${esc(JSON.stringify(a.context, null, 2))}</pre>
                  ${a.status === 'pending' ? `
                    <div class="flex gap-2 mt-2">
                      <button class="btn btn-success btn-xs ap-respond" data-idx="${i}" data-decision="approved" data-reason="Looks good">Approve</button>
                      <button class="btn btn-error btn-xs ap-respond" data-idx="${i}" data-decision="rejected" data-reason="Not yet ready">Reject</button>
                    </div>
                  ` : ''}
                  ${a.response ? `<p class="text-xs mt-1">Responded by: ${esc(a.response.respondedBy)} -- "${esc(a.response.reason || '')}"</p>` : ''}
                </div>
              </div>`;
          }).join('')
        }
      </div>
    </div>`;
}

// --- Tools Tab ---
function renderToolsTab() {
  return `
    <div class="flex gap-4">
      <div class="w-72 flex-shrink-0 space-y-3">
        <h3 class="font-semibold">Invoke Tool</h3>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Tool</span></label>
          <select id="tl-tool" class="select select-bordered select-sm">
            <option value="search">search</option>
            <option value="calculate">calculate</option>
            <option value="summarize">summarize</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Arguments (JSON)</span></label>
          <input id="tl-args" type="text" class="input input-bordered input-sm" value='{"query":"NoLag real-time SDK"}' />
        </div>
        <button id="btn-tl-invoke" class="btn btn-primary btn-sm w-full">Invoke Tool</button>

        <div class="divider text-xs">QUICK</div>
        <button class="btn btn-ghost btn-xs w-full justify-start tl-quick" data-tool="search" data-args='{"query":"agent orchestration patterns"}'>search: orchestration patterns</button>
        <button class="btn btn-ghost btn-xs w-full justify-start tl-quick" data-tool="calculate" data-args='{"expression":"(42 * 3) + 17"}'>calculate: (42 * 3) + 17</button>
        <button class="btn btn-ghost btn-xs w-full justify-start tl-quick" data-tool="summarize" data-args='{"text":"NoLag is a real-time messaging platform that enables developers to build multi-agent coordination systems with patterns like handoff, blackboard, inbox, approval gates, and tool invocations."}'>summarize: NoLag description</button>

        <div class="divider text-xs">REGISTERED TOOLS</div>
        <div class="space-y-1">
          <div class="bg-base-200 rounded p-2 text-xs"><span class="font-mono text-primary">search</span>(query) -- search documents</div>
          <div class="bg-base-200 rounded p-2 text-xs"><span class="font-mono text-primary">calculate</span>(expression) -- evaluate math</div>
          <div class="bg-base-200 rounded p-2 text-xs"><span class="font-mono text-primary">summarize</span>(text) -- summarize text</div>
        </div>
      </div>
      <div class="flex-1 space-y-2">
        <h3 class="font-semibold">Tool Invocations</h3>
        ${toolFlow.length === 0 ? '<p class="text-base-content/40 text-sm">No tools invoked yet</p>' :
          toolFlow.map(t => {
            const badge = t.status === 'calling' ? 'badge-warning' : t.status === 'success' ? 'badge-success' : 'badge-error';
            return `
              <div class="card bg-base-100 shadow-sm border border-base-300">
                <div class="card-body p-3">
                  <div class="flex items-center gap-2">
                    <span class="font-mono font-semibold text-sm">${esc(t.toolName)}</span>
                    <span class="badge ${badge} badge-xs">${t.status}</span>
                    ${t.completedAt ? `<span class="text-xs text-base-content/50">${t.completedAt - t.startedAt}ms</span>` : ''}
                  </div>
                  <pre class="text-xs bg-base-200 rounded p-2 mt-1">args: ${esc(JSON.stringify(t.args, null, 2))}</pre>
                  ${t.result ? `<pre class="text-xs bg-base-200 rounded p-2 mt-1 text-success">result: ${esc(JSON.stringify(t.result, null, 2))}</pre>` : ''}
                  ${t.error ? `<p class="text-xs text-error mt-1">${esc(t.error)}</p>` : ''}
                </div>
              </div>`;
          }).join('')
        }
      </div>
    </div>`;
}

// ============================================================
// Event Log
// ============================================================
function renderEventLog() {
  const el = $('#event-log');
  if (!el) return;
  el.innerHTML = eventLog.slice(-80).map(e => `
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
  const btn = $('#btn-connect');
  const inputs = [
    '#input-app-slug', '#input-room-slug', '#input-orch-token',
    '#input-w1-token', '#input-w2-token', '#input-w3-token', '#input-w4-token',
  ];

  btn?.addEventListener('click', async () => {
    btn.textContent = 'Connecting...';
    btn.disabled = true;
    const errorEl = $('#connect-error');
    if (errorEl) errorEl.classList.add('hidden');

    try {
      await startConnection();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Connection failed';
        errorEl.classList.remove('hidden');
      }
      btn.textContent = 'Connect';
      btn.disabled = false;
    }
  });

  // Enter key on any input
  inputs.forEach(sel => {
    $(sel)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn?.click();
    });
  });
}

function attachTabListeners() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('tab-active', b.dataset.tab === activeTab);
        b.classList.toggle('text-primary', b.dataset.tab === activeTab);
        b.classList.toggle('text-base-content/60', b.dataset.tab !== activeTab);
      });
      renderPatternContent();
    });
  });
  $('#btn-clear-log')?.addEventListener('click', () => { eventLog.length = 0; renderEventLog(); });
}

function attachHandoffListeners() {
  $('#btn-h-dispatch')?.addEventListener('click', () => {
    dispatchHandoffTask($('#h-cap').value, $('#h-desc').value || 'Unnamed', document.querySelector('input[name="h-pri"]:checked')?.value || 'medium');
  });
  document.querySelectorAll('.h-quick').forEach(btn => {
    btn.addEventListener('click', () => dispatchHandoffTask(btn.dataset.cap, btn.dataset.desc, btn.dataset.pri));
  });
  $('#btn-h-clear')?.addEventListener('click', () => { taskFlow.length = 0; renderPatternContent(); });
}

function attachBlackboardListeners() {
  $('#btn-bb-set')?.addEventListener('click', () => {
    try {
      const val = JSON.parse($('#bb-val').value);
      setBlackboardState($('#bb-agent').value, $('#bb-key').value, val);
    } catch { log('error', '[Blackboard] Invalid JSON value'); }
  });
  document.querySelectorAll('.bb-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      try { setBlackboardState(btn.dataset.agent, btn.dataset.key, JSON.parse(btn.dataset.val)); }
      catch { /* ignore */ }
    });
  });
}

function attachObserveListeners() {
  $('#btn-ob-emit')?.addEventListener('click', () => {
    try {
      emitObserveEvent($('#ob-cat').value, $('#ob-sev').value, JSON.parse($('#ob-payload').value));
    } catch { log('error', '[Observe] Invalid JSON payload'); }
  });
  document.querySelectorAll('.ob-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      try { emitObserveEvent(btn.dataset.cat, btn.dataset.sev, JSON.parse(btn.dataset.pay)); }
      catch { /* ignore */ }
    });
  });
}

function attachInboxListeners() {
  $('#btn-ib-send')?.addEventListener('click', () => {
    try {
      sendInboxMessage($('#ib-from').value, $('#ib-to').value, JSON.parse($('#ib-payload').value));
    } catch { log('error', '[Inbox] Invalid JSON payload'); }
  });
  document.querySelectorAll('.ib-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      try { sendInboxMessage(btn.dataset.from, btn.dataset.to, JSON.parse(btn.dataset.pay)); }
      catch { /* ignore */ }
    });
  });
}

function attachApproveListeners() {
  $('#btn-ap-request')?.addEventListener('click', () => {
    try {
      requestApproval($('#ap-action').value, JSON.parse($('#ap-context').value), $('#ap-urgency').value);
    } catch { log('error', '[Approve] Invalid JSON context'); }
  });
  document.querySelectorAll('.ap-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      try { requestApproval(btn.dataset.action, JSON.parse(btn.dataset.ctx), btn.dataset.urg); }
      catch { /* ignore */ }
    });
  });
  document.querySelectorAll('.ap-respond').forEach(btn => {
    btn.addEventListener('click', () => {
      respondToApproval(Number(btn.dataset.idx), btn.dataset.decision, btn.dataset.reason);
    });
  });
}

function attachToolsListeners() {
  const toolSelect = $('#tl-tool');
  const argsInput = $('#tl-args');

  toolSelect?.addEventListener('change', () => {
    const defaults = {
      search: '{"query":"NoLag real-time SDK"}',
      calculate: '{"expression":"(42 * 3) + 17"}',
      summarize: '{"text":"NoLag is a real-time messaging platform."}',
    };
    if (argsInput) argsInput.value = defaults[toolSelect.value] || '{}';
  });

  $('#btn-tl-invoke')?.addEventListener('click', () => {
    try {
      invokeTool($('#tl-tool').value, JSON.parse($('#tl-args').value));
    } catch { log('error', '[Tools] Invalid JSON arguments'); }
  });
  document.querySelectorAll('.tl-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      try { invokeTool(btn.dataset.tool, JSON.parse(btn.dataset.args)); }
      catch { /* ignore */ }
    });
  });
}

// ============================================================
// Boot
// ============================================================
renderApp();
