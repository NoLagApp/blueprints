/**
 * @nolag/agents — Inbox Pattern Demo
 *
 * Demonstrates the per-agent inbox pattern:
 *   - 3 simulated agents (Agent A, B, C) each with their own Inbox
 *   - Messages addressed to a specific agent are filtered so only that agent sees them
 *   - All agents share the same room, but Inbox filters by agentId
 *
 * Uses a local mock pub/sub to simulate agent coordination without a broker.
 */

import {
  EventEmitter,
  Inbox,
} from '@nolag/agents';

// ============================================================
// State
// ============================================================
const eventLog = [];
let simulating = false;

const AGENTS = [
  { id: 'agent-a', name: 'Agent A', color: 'badge-info', messages: [], connected: true, offlineBuffer: [] },
  { id: 'agent-b', name: 'Agent B', color: 'badge-warning', messages: [], connected: true, offlineBuffer: [] },
  { id: 'agent-c', name: 'Agent C', color: 'badge-error', messages: [], connected: true, offlineBuffer: [] },
];

const inboxes = new Map(); // agentId -> Inbox instance

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

function generateId() {
  return crypto.randomUUID();
}

// ============================================================
// Mock AgentRoom — local EventEmitter-based pub/sub
// ============================================================
class MockAgentRoom extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
  }

  publishInbox(data) {
    log('event', `[room] publishInbox: from=${data.from} to=${data.to}`);
    // Simulate async network delivery — broadcast to all listeners
    setTimeout(() => this.emit('inbox', data), 50);
  }
}

// ============================================================
// Simulation
// ============================================================
let mockRoom = null;

function startSimulation() {
  if (simulating) return;
  simulating = true;

  // Create shared mock room
  mockRoom = new MockAgentRoom('inbox-workflow');
  log('action', 'Created mock room: inbox-workflow');

  // Create an Inbox instance for each agent
  AGENTS.forEach((agent) => {
    const inbox = new Inbox(mockRoom, agent.id);

    inbox.onMessage((msg) => {
      if (!agent.connected) {
        agent.offlineBuffer.push(msg);
        log('event', `${agent.name} is offline — message from ${msg.from} queued`);
        renderAgentPanels();
        return;
      }
      log('event', `${agent.name} received message from ${msg.from}: "${msg.payload.text}"`);
      agent.messages.push({
        messageId: msg.messageId,
        from: msg.from,
        fromName: AGENTS.find(a => a.id === msg.from)?.name || msg.from,
        text: msg.payload.text,
        createdAt: msg.createdAt,
        status: 'delivered',
      });
      renderAgentPanels();
    });

    inboxes.set(agent.id, inbox);
  });

  log('action', `Created ${AGENTS.length} Inbox instances: ${AGENTS.map(a => a.name).join(', ')}`);
  renderApp();
}

function sendMessage(fromId, toId, text) {
  const inbox = inboxes.get(fromId);
  if (!inbox) return;

  const fromAgent = AGENTS.find(a => a.id === fromId);
  const toAgent = AGENTS.find(a => a.id === toId);

  log('action', `${fromAgent?.name} sends to ${toAgent?.name}: "${text}"`);

  // Use the Inbox.send() method — it creates the InboxMessage and publishes
  inbox.send(toId, { text });
}

function toggleConnection(agentId) {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) return;
  agent.connected = !agent.connected;

  if (agent.connected && agent.offlineBuffer.length > 0) {
    log('action', `${agent.name} reconnected — replaying ${agent.offlineBuffer.length} queued messages`);
    for (const msg of agent.offlineBuffer) {
      agent.messages.push({
        messageId: msg.messageId,
        from: msg.from,
        fromName: AGENTS.find(a => a.id === msg.from)?.name || msg.from,
        text: msg.payload.text,
        createdAt: msg.createdAt,
        status: 'replayed',
      });
    }
    agent.offlineBuffer = [];
  }

  log('action', `${agent.name} ${agent.connected ? 'connected' : 'disconnected'}`);
  renderAgentPanels();
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
          <span class="text-xl font-bold">@nolag/agents — Inbox Pattern</span>
          <div class="badge ${simulating ? 'badge-success' : 'badge-error'} badge-sm">
            ${simulating ? 'Simulating' : 'Idle'}
          </div>
        </div>
        <div class="flex-none gap-2">
          ${AGENTS.map(a => `
            <div class="badge ${a.color} badge-sm gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-current opacity-60"></span>
              ${esc(a.name)}
              <span class="opacity-60">(${a.messages.length})</span>
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
    renderAgentPanels();
    renderEventLog();
    attachSendListeners();
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
          <h2 class="card-title justify-center text-2xl">Inbox Pattern</h2>
          <p class="text-center text-base-content/60 text-sm">
            Per-agent message queues with filtered delivery
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
            <li>Each agent creates an <code class="badge badge-xs badge-ghost">Inbox</code> with their agentId</li>
            <li>Send messages via <code class="badge badge-xs badge-ghost">inbox.send(toAgentId, payload)</code></li>
            <li>Receive with <code class="badge badge-xs badge-ghost">inbox.onMessage(handler)</code></li>
            <li>Messages are filtered — only the addressed agent sees them</li>
            <li>All agents share the same room topic</li>
          </ul>

          <div class="divider text-xs">AGENTS</div>
          <div class="flex flex-wrap gap-2 justify-center">
            ${AGENTS.map(a => `
              <div class="badge ${a.color} gap-1">
                <span class="text-xs font-semibold">${esc(a.name)}</span>
                <span class="opacity-60 text-xs">(${a.id})</span>
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
    <!-- Main area: agents + send form -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- Top: 3 agent panels side by side -->
      <div class="flex-1 flex overflow-hidden min-h-0">
        <div id="agent-panels" class="flex-1 grid grid-cols-3 gap-0"></div>
      </div>

      <!-- Bottom: Send form -->
      <div class="bg-base-100 border-t border-base-300 p-4 flex-shrink-0">
        <div class="flex gap-3 items-end max-w-3xl mx-auto">
          <div class="form-control flex-shrink-0">
            <label class="label py-0.5"><span class="label-text text-xs">From</span></label>
            <select id="from-select" class="select select-bordered select-sm">
              ${AGENTS.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
            </select>
          </div>

          <div class="form-control flex-shrink-0">
            <label class="label py-0.5"><span class="label-text text-xs">To</span></label>
            <select id="to-select" class="select select-bordered select-sm">
              ${AGENTS.map((a, i) => `<option value="${a.id}" ${i === 1 ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
            </select>
          </div>

          <div class="form-control flex-1">
            <label class="label py-0.5"><span class="label-text text-xs">Message</span></label>
            <input id="message-input" type="text" placeholder="Type a message..."
                   class="input input-bordered input-sm" value="Hello from the other side!" />
          </div>

          <button id="btn-send" class="btn btn-primary btn-sm flex-shrink-0">Send</button>
        </div>

        <div class="flex gap-2 mt-3 justify-center">
          <button class="btn btn-ghost btn-xs quick-send" data-from="agent-a" data-to="agent-b" data-text="Can you review the draft?">
            A -> B: Review request
          </button>
          <button class="btn btn-ghost btn-xs quick-send" data-from="agent-b" data-to="agent-c" data-text="Draft approved, please file it.">
            B -> C: File request
          </button>
          <button class="btn btn-ghost btn-xs quick-send" data-from="agent-c" data-to="agent-a" data-text="Filing complete. Case #2026-CV-4521.">
            C -> A: Filing complete
          </button>
          <button class="btn btn-ghost btn-xs quick-send" data-from="agent-a" data-to="agent-c" data-text="Priority update: deadline moved to Friday.">
            A -> C: Priority update
          </button>
        </div>
      </div>
    </div>

    <!-- Right sidebar: Event log -->
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
// Render: Agent Panels
// ============================================================
function renderAgentPanels() {
  const el = $('#agent-panels');
  if (!el) return;

  el.innerHTML = AGENTS.map((agent, index) => {
    const borderClass = index < AGENTS.length - 1 ? 'border-r border-base-300' : '';

    return `
      <div class="flex flex-col ${borderClass} bg-base-100">
        <!-- Agent header -->
        <div class="p-3 border-b border-base-300 flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full ${agent.connected ? 'bg-success' : 'bg-error'}"></span>
          <span class="font-semibold text-sm">${esc(agent.name)}</span>
          <span class="badge ${agent.color} badge-xs">${agent.id}</span>
          ${agent.offlineBuffer.length > 0 ? `<span class="badge badge-warning badge-xs">${agent.offlineBuffer.length} queued</span>` : ''}
          <div class="ml-auto flex items-center gap-2">
            <span class="text-xs text-base-content/50">${agent.messages.length} msg${agent.messages.length !== 1 ? 's' : ''}</span>
            <button class="btn btn-xs toggle-conn ${agent.connected ? 'btn-error' : 'btn-success'}" data-agent-id="${agent.id}">
              ${agent.connected ? 'Disconnect' : 'Reconnect'}
            </button>
          </div>
        </div>

        <!-- Messages -->
        <div class="flex-1 overflow-y-auto p-3 space-y-2" id="messages-${agent.id}">
          ${agent.messages.length === 0
            ? `<div class="text-center text-base-content/40 py-8">
                <p class="text-sm">No messages yet</p>
                <p class="text-xs mt-1">Send a message to ${agent.name}</p>
              </div>`
            : agent.messages.map(msg => `
              <div class="card bg-base-200 shadow-sm">
                <div class="card-body p-2.5">
                  <div class="flex items-center gap-1.5">
                    <span class="text-xs font-semibold text-primary">${esc(msg.fromName)}</span>
                    <span class="text-xs text-base-content/40">-></span>
                    <span class="text-xs font-semibold">${esc(agent.name)}</span>
                    <div class="ml-auto flex items-center gap-1">
                      ${msg.status === 'delivered' ? `<span class="badge badge-success badge-xs">delivered</span>` : ''}
                      ${msg.status === 'replayed' ? `<span class="badge badge-info badge-xs">replayed</span>` : ''}
                      <span class="text-xs text-base-content/40">${time(msg.createdAt)}</span>
                    </div>
                  </div>
                  <p class="text-sm mt-0.5">${esc(msg.text)}</p>
                </div>
              </div>
            `).join('')
          }
        </div>
      </div>
    `;
  }).join('');

  // Auto-scroll each agent's message list to bottom
  AGENTS.forEach(agent => {
    const msgEl = $(`#messages-${agent.id}`);
    if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
  });

  // Re-attach toggle-conn listeners (buttons are re-created on each render)
  document.querySelectorAll('.toggle-conn').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleConnection(btn.dataset.agentId);
    });
  });

  // Update navbar badges
  const navBadges = document.querySelectorAll('.navbar .badge');
  // Re-render navbar agent counts (handled in full renderApp, skip partial)
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

function attachSendListeners() {
  const fromSelect = $('#from-select');
  const toSelect = $('#to-select');
  const messageInput = $('#message-input');
  const sendBtn = $('#btn-send');
  const clearLogBtn = $('#btn-clear-log');

  sendBtn?.addEventListener('click', () => {
    const from = fromSelect?.value;
    const to = toSelect?.value;
    const text = messageInput?.value?.trim();

    if (!text) return;

    if (from === to) {
      log('error', 'Cannot send a message to yourself');
      return;
    }

    sendMessage(from, to, text);
    messageInput.value = '';
    messageInput.focus();
  });

  // Enter key on message input
  messageInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn?.click();
  });

  // Quick send buttons
  document.querySelectorAll('.quick-send').forEach(btn => {
    btn.addEventListener('click', () => {
      sendMessage(btn.dataset.from, btn.dataset.to, btn.dataset.text);
    });
  });

  clearLogBtn?.addEventListener('click', () => {
    eventLog.length = 0;
    renderEventLog();
  });

  // Connect/disconnect toggle buttons
  document.querySelectorAll('.toggle-conn').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleConnection(btn.dataset.agentId);
    });
  });

  messageInput?.focus();
}

// ============================================================
// Boot
// ============================================================
renderApp();
