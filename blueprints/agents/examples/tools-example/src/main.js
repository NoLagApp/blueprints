import { Tools, createToolRequest } from '@nolag/agents';

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
const room = createMockRoom('tools-room');
const provider = new Tools(room, 'tool-provider');
const invoker = new Tools(room, 'tool-invoker');

const toolDefs = [
  { name: 'calculate', description: 'Arithmetic operations (add, multiply, divide)', invocations: 0 },
  { name: 'lookup', description: 'Key-value lookup from a mock store', invocations: 0 },
  { name: 'slow-task', description: 'Simulated slow task (takes delay ms)', invocations: 0 },
];

const results = []; // { requestId, tool, status, result, error, duration }

let providerOnline = true;

// Mock key-value store for lookup tool
const kvStore = {
  'user:1': { name: 'Alice', role: 'admin' },
  'user:2': { name: 'Bob', role: 'editor' },
  'config:theme': { value: 'dark' },
};

// ---------------------------------------------------------------------------
// Register tool handlers on the provider
// ---------------------------------------------------------------------------
function registerTools() {
  provider.register('calculate', (args) => {
    const { operation, a, b } = args;
    toolDefs[0].invocations++;
    renderProviderPanel();

    switch (operation) {
      case 'add': return { result: a + b };
      case 'multiply': return { result: a * b };
      case 'divide':
        if (b === 0) throw new Error('Division by zero');
        return { result: a / b };
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  });

  provider.register('lookup', (args) => {
    const { key } = args;
    toolDefs[1].invocations++;
    renderProviderPanel();

    const value = kvStore[key];
    return { value: value || null, found: !!value };
  });

  provider.register('slow-task', (args) => {
    const { delay } = args;
    toolDefs[2].invocations++;
    renderProviderPanel();

    return new Promise((resolve) => {
      setTimeout(() => resolve({ completed: true }), delay);
    });
  });
}
registerTools();

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
// Render helpers
// ---------------------------------------------------------------------------
const toolForms = {
  calculate: `
    <div class="flex flex-col gap-2">
      <select id="arg-operation" class="select select-xs select-bordered">
        <option value="add">add</option>
        <option value="multiply">multiply</option>
        <option value="divide">divide</option>
      </select>
      <div class="flex gap-2">
        <input id="arg-a" type="number" value="10" class="input input-xs input-bordered w-20" placeholder="a" />
        <input id="arg-b" type="number" value="5" class="input input-xs input-bordered w-20" placeholder="b" />
      </div>
    </div>
  `,
  lookup: `
    <div class="flex flex-col gap-2">
      <select id="arg-key" class="select select-xs select-bordered">
        <option value="user:1">user:1</option>
        <option value="user:2">user:2</option>
        <option value="config:theme">config:theme</option>
        <option value="missing:key">missing:key</option>
      </select>
    </div>
  `,
  'slow-task': `
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <label class="text-xs text-base-content/60">Delay (ms):</label>
        <input id="arg-delay" type="number" value="2000" class="input input-xs input-bordered w-24" />
      </div>
    </div>
  `,
};

function getArgsForTool(toolName) {
  switch (toolName) {
    case 'calculate':
      return {
        operation: document.getElementById('arg-operation')?.value || 'add',
        a: parseFloat(document.getElementById('arg-a')?.value || '0'),
        b: parseFloat(document.getElementById('arg-b')?.value || '0'),
      };
    case 'lookup':
      return { key: document.getElementById('arg-key')?.value || '' };
    case 'slow-task':
      return { delay: parseInt(document.getElementById('arg-delay')?.value || '2000', 10) };
    default:
      return {};
  }
}

function renderProviderPanel() {
  const el = document.getElementById('provider-tools');
  if (!el) return;
  el.innerHTML = toolDefs.map((t) => `
    <div class="card bg-base-200 shadow-md ${!providerOnline ? 'opacity-50' : ''}">
      <div class="card-body p-4 gap-1">
        <div class="flex items-center justify-between">
          <h3 class="card-title text-sm font-semibold font-mono">${t.name}</h3>
          <span class="badge ${providerOnline ? 'badge-ghost' : 'badge-error'} badge-sm">${providerOnline ? `${t.invocations} calls` : 'unavailable'}</span>
        </div>
        <p class="text-xs text-base-content/60">${t.description}</p>
      </div>
    </div>
  `).join('');
}

function updateProviderHeader() {
  const header = document.getElementById('provider-header');
  if (!header) return;
  header.innerHTML = `
    <div class="w-2 h-2 rounded-full ${providerOnline ? 'bg-success animate-pulse' : 'bg-error'}"></div>
    <h2 class="font-semibold text-sm">Tool Provider</h2>
    <span class="badge ${providerOnline ? 'badge-success' : 'badge-error'} badge-xs">${providerOnline ? 'Online' : 'Offline'}</span>
    <button id="toggle-provider" class="btn btn-xs ${providerOnline ? 'btn-error' : 'btn-success'} ml-auto">
      ${providerOnline ? 'Go Offline' : 'Go Online'}
    </button>
  `;
  document.getElementById('toggle-provider')?.addEventListener('click', toggleProvider);
}

function toggleProvider() {
  providerOnline = !providerOnline;
  if (providerOnline) {
    registerTools();
    log('Provider is back ONLINE — tools re-registered', 'action');
  } else {
    provider.dispose();
    log('Provider is OFFLINE — tools unavailable', 'error');
  }
  updateProviderHeader();
  renderProviderPanel();
}

function renderResultsTable() {
  const el = document.getElementById('results-body');
  if (!el) return;
  if (results.length === 0) {
    el.innerHTML = '<tr><td colspan="5" class="text-center text-base-content/40 text-xs py-4">No invocations yet</td></tr>';
    return;
  }
  el.innerHTML = results.map((r) => {
    const statusClass = r.status === 'success' ? 'text-success' : 'text-error';
    const output = r.status === 'success' ? JSON.stringify(r.result) : (r.error || 'Unknown error');
    return `
      <tr class="text-xs">
        <td class="font-mono text-base-content/50">${r.requestId.slice(0, 8)}...</td>
        <td class="font-mono">${r.tool}</td>
        <td class="${statusClass} font-semibold">${r.status}</td>
        <td class="font-mono max-w-48 truncate">${output}</td>
        <td class="text-base-content/50">${r.duration}ms</td>
      </tr>
    `;
  }).join('');
}

let selectedTool = 'calculate';

function renderInvokerForm() {
  const formEl = document.getElementById('tool-form');
  if (!formEl) return;
  formEl.innerHTML = toolForms[selectedTool] || '';
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="flex flex-col h-full">
      <!-- Header -->
      <div class="bg-base-200 border-b border-base-300 px-6 py-3 flex items-center gap-3">
        <h1 class="text-lg font-bold text-primary">@nolag/agents</h1>
        <span class="text-base-content/50 text-sm">Tools Pattern Demo</span>
      </div>

      <!-- Main panels -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Left: Tool Provider -->
        <div class="w-1/2 border-r border-base-300 flex flex-col">
          <div id="provider-header" class="px-4 py-3 border-b border-base-300 flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-success animate-pulse"></div>
            <h2 class="font-semibold text-sm">Tool Provider</h2>
            <span class="badge badge-success badge-xs">Online</span>
            <button id="toggle-provider" class="btn btn-xs btn-error ml-auto">Go Offline</button>
          </div>
          <div id="provider-tools" class="flex-1 overflow-y-auto p-4 flex flex-col gap-3"></div>
        </div>

        <!-- Right: Tool Invoker -->
        <div class="w-1/2 flex flex-col">
          <div class="px-4 py-3 border-b border-base-300 flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-success"></div>
            <h2 class="font-semibold text-sm">Tool Invoker</h2>
            <span class="text-xs text-base-content/40 ml-auto">tool-invoker</span>
          </div>
          <div class="p-4 flex flex-col gap-3 border-b border-base-300">
            <!-- Tool selector -->
            <div class="flex items-center gap-2">
              <label class="text-xs text-base-content/60">Tool:</label>
              <select id="tool-select" class="select select-xs select-bordered flex-1">
                <option value="calculate">calculate</option>
                <option value="lookup">lookup</option>
                <option value="slow-task">slow-task</option>
              </select>
            </div>

            <!-- Dynamic arguments form -->
            <div id="tool-form"></div>

            <!-- Timeout + invoke -->
            <div class="flex items-center gap-2">
              <label class="text-xs text-base-content/60">Timeout (ms):</label>
              <input id="timeout" type="number" value="5000" class="input input-xs input-bordered w-24" />
              <button id="invoke-btn" class="btn btn-primary btn-xs ml-auto">Invoke</button>
            </div>
          </div>

          <!-- Results table -->
          <div class="flex-1 overflow-y-auto">
            <table class="table table-xs w-full">
              <thead>
                <tr class="text-xs text-base-content/50">
                  <th>Request ID</th>
                  <th>Tool</th>
                  <th>Status</th>
                  <th>Result / Error</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody id="results-body"></tbody>
            </table>
          </div>
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

  // Wire events
  document.getElementById('toggle-provider')?.addEventListener('click', toggleProvider);

  document.getElementById('clear-log').addEventListener('click', () => {
    document.getElementById('log').innerHTML = '';
  });

  document.getElementById('tool-select').addEventListener('change', (e) => {
    selectedTool = e.target.value;
    renderInvokerForm();
  });

  document.getElementById('invoke-btn').addEventListener('click', invokeTool);

  renderProviderPanel();
  renderInvokerForm();
  renderResultsTable();
}

// ---------------------------------------------------------------------------
// Invoke tool
// ---------------------------------------------------------------------------
async function invokeTool() {
  const toolName = selectedTool;
  const args = getArgsForTool(toolName);
  const timeout = parseInt(document.getElementById('timeout')?.value || '5000', 10);

  const btn = document.getElementById('invoke-btn');
  btn.disabled = true;
  btn.textContent = 'Invoking...';

  log(`Invoking "${toolName}" with args: ${JSON.stringify(args)} (timeout: ${timeout}ms)`, 'action');

  const startTime = Date.now();

  try {
    const response = await invoker.invoke(toolName, args, { timeout });
    const duration = Date.now() - startTime;

    results.unshift({
      requestId: response.requestId,
      tool: toolName,
      status: response.status,
      result: response.result,
      error: response.error ? response.error.message : null,
      duration,
    });

    if (response.status === 'success') {
      log(`Tool "${toolName}" succeeded in ${duration}ms: ${JSON.stringify(response.result)}`, 'event');
    } else {
      log(`Tool "${toolName}" returned error: ${response.error?.message}`, 'error');
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    results.unshift({
      requestId: '(timeout)',
      tool: toolName,
      status: 'error',
      result: null,
      error: err.message,
      duration,
    });
    log(`Tool "${toolName}" failed: ${err.message}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Invoke';
  renderResultsTable();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
render();
log('Tools pattern demo initialized. Select a tool and click "Invoke" to begin.', 'event');
