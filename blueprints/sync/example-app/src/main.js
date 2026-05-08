import { NoLagSync } from '@nolag/sync';

// ── State ────────────────────────────────────────────────────────────────────
let sync = null;
let collection = null;
const COLLECTION_NAME = 'todos';

// ── Helpers ──────────────────────────────────────────────────────────────────
function addLog(msg, type = 'event') {
  const el = document.getElementById('event-log');
  if (!el) return;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type} fade-in`;
  entry.textContent = `${time} ${msg}`;
  el.prepend(entry);
  if (el.children.length > 80) el.lastChild.remove();
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function genId() {
  return 'todo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Todos ────────────────────────────────────────────────────────────────────
function getTodos() {
  if (!collection) return [];
  return collection.getAllDocuments()
    .map(doc => ({ id: doc.id, ...doc.data, version: doc.version, updatedBy: doc.updatedBy }))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

async function addTodo() {
  if (!collection) return;
  const inp = document.getElementById('inp-todo');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';

  const id = genId();
  addLog(`Adding: "${text}"`, 'action');
  await collection.createDocument(id, {
    text,
    completed: false,
    createdAt: Date.now(),
  });
}

async function toggleTodo(id) {
  if (!collection) return;
  const doc = collection.getDocument(id);
  if (!doc) return;
  const completed = !doc.data.completed;
  addLog(`${completed ? 'Completed' : 'Uncompleted'}: "${doc.data.text}"`, 'action');
  await collection.updateDocument(id, { completed });
}

async function deleteTodo(id) {
  if (!collection) return;
  const doc = collection.getDocument(id);
  addLog(`Deleted: "${doc?.data?.text ?? id}"`, 'action');
  await collection.deleteDocument(id);
}

async function editTodo(id) {
  if (!collection) return;
  const doc = collection.getDocument(id);
  if (!doc) return;
  const newText = prompt('Edit todo:', doc.data.text);
  if (newText === null || newText.trim() === '') return;
  addLog(`Edited: "${newText.trim()}"`, 'action');
  await collection.updateDocument(id, { text: newText.trim() });
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderTodos() {
  const list = document.getElementById('todo-list');
  if (!list) return;

  const todos = getTodos();
  const pending = todos.filter(t => !t.completed);
  const completed = todos.filter(t => t.completed);

  if (todos.length === 0) {
    list.innerHTML = `
      <div class="text-center text-base-content/30 py-12">
        <p class="text-lg font-semibold">No todos yet</p>
        <p class="text-sm mt-1">Add one above — changes sync in real-time across tabs.</p>
      </div>`;
    updateCounts(0, 0);
    return;
  }

  list.innerHTML = [
    ...pending.map(t => todoItem(t)),
    completed.length > 0 ? `<div class="text-xs text-base-content/30 uppercase tracking-widest mt-4 mb-2 px-1">Completed (${completed.length})</div>` : '',
    ...completed.map(t => todoItem(t)),
  ].join('');

  // Bind events
  list.querySelectorAll('[data-toggle]').forEach(el => {
    el.addEventListener('change', () => toggleTodo(el.dataset.toggle));
  });
  list.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('click', () => editTodo(el.dataset.edit));
  });
  list.querySelectorAll('[data-delete]').forEach(el => {
    el.addEventListener('click', () => deleteTodo(el.dataset.delete));
  });

  updateCounts(pending.length, completed.length);
}

function todoItem(todo) {
  return `
    <div class="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-base-300 ${todo.completed ? 'opacity-50 bg-base-200/30' : 'bg-base-200'} group hover:border-base-content/20 transition-colors fade-in">
      <input type="checkbox" class="checkbox checkbox-sm checkbox-primary" ${todo.completed ? 'checked' : ''} data-toggle="${todo.id}" />
      <span class="flex-1 text-sm ${todo.completed ? 'line-through text-base-content/40' : ''}">${escHtml(todo.text)}</span>
      ${todo.updatedBy ? `<span class="text-xs text-base-content/20 hidden group-hover:inline">${escHtml(todo.updatedBy)}</span>` : ''}
      <span class="badge badge-ghost badge-xs">v${todo.version ?? 0}</span>
      <button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-60" data-edit="${todo.id}">edit</button>
      <button class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-60" data-delete="${todo.id}">x</button>
    </div>`;
}

function updateCounts(pending, completed) {
  const el = document.getElementById('todo-counts');
  if (el) el.textContent = `${pending} pending, ${completed} done`;
}

function renderCollaborators() {
  const el = document.getElementById('collaborators');
  if (!el) return;
  const collabs = sync ? sync.getCollaborators() : [];
  if (collabs.length === 0) {
    el.innerHTML = '<p class="text-xs text-base-content/30 px-3 py-4 text-center">No collaborators online.<br>Open in another tab to sync.</p>';
    return;
  }
  el.innerHTML = collabs.map(c => `
    <div class="flex items-center gap-2 px-3 py-2 border-b border-base-300/50">
      <span class="w-2.5 h-2.5 rounded-full bg-success shrink-0"></span>
      <span class="text-sm truncate">${escHtml(c.username || c.id)}</span>
    </div>`).join('');
}

function setConnected(connected) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  if (dot) dot.className = `w-2.5 h-2.5 rounded-full ${connected ? 'bg-success' : 'bg-error'}`;
  if (label) label.textContent = connected ? 'Connected' : 'Disconnected';

  document.getElementById('btn-connect').classList.toggle('hidden', connected);
  document.getElementById('btn-disconnect').classList.toggle('hidden', !connected);
  document.getElementById('todo-input-area').classList.toggle('hidden', !connected);
  ['inp-token', 'inp-username', 'inp-appname'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = connected;
  });
}

// ── Connect ──────────────────────────────────────────────────────────────────
async function handleConnect() {
  const token = document.getElementById('inp-token').value.trim();
  const username = document.getElementById('inp-username').value.trim() || 'user-' + Math.floor(Math.random() * 1000);
  const appName = document.getElementById('inp-appname').value.trim() || 'sync-demo';

  if (!token) { addLog('Token is required', 'error'); return; }

  addLog(`Connecting as "${username}"...`, 'action');

  sync = new NoLagSync(token, {
    username,
    appName,
    debug: false,
    collections: [COLLECTION_NAME],
  });

  sync.on('connected', async () => {
    addLog('Connected', 'event');
    setConnected(true);
    renderCollaborators();
    await joinTodos();
  });

  sync.on('disconnected', reason => {
    addLog(`Disconnected: ${reason}`, 'error');
    setConnected(false);
    collection = null;
    renderTodos();
    renderCollaborators();
  });

  sync.on('reconnected', () => {
    addLog('Reconnected', 'event');
    setConnected(true);
  });

  sync.on('error', err => {
    addLog(`Error: ${err?.message ?? err}`, 'error');
  });

  sync.on('collaboratorOnline', c => {
    addLog(`${c.username || c.id} came online`, 'event');
    renderCollaborators();
  });

  sync.on('collaboratorOffline', c => {
    addLog(`${c.username || c.id} went offline`, 'event');
    renderCollaborators();
  });

  await sync.connect();
}

async function handleDisconnect() {
  if (!sync) return;
  await sync.disconnect();
  sync = null;
  collection = null;
  setConnected(false);
  renderTodos();
  renderCollaborators();
  addLog('Disconnected', 'action');
}

async function joinTodos() {
  try {
    collection = await sync.joinCollection(COLLECTION_NAME);
    addLog(`Joined "${COLLECTION_NAME}" collection`, 'event');

    collection.on('documentCreated', doc => {
      addLog(`New todo: "${doc.data?.text ?? doc.id}"`, 'event');
      renderTodos();
    });

    collection.on('documentUpdated', doc => {
      addLog(`Updated: "${doc.data?.text ?? doc.id}" v${doc.version}`, 'event');
      renderTodos();
    });

    collection.on('documentDeleted', doc => {
      addLog(`Deleted: ${doc.id}`, 'event');
      renderTodos();
    });

    collection.on('conflict', conflict => {
      addLog(`Conflict on ${conflict.id}: v${conflict.localVersion} vs v${conflict.remoteVersion}`, 'error');
    });

    collection.on('synced', doc => {
      addLog(`Synced: ${doc.id} v${doc.version}`, 'event');
      renderTodos();
    });

    collection.on('collaboratorJoined', c => {
      addLog(`${c.username || c.id} joined`, 'event');
      renderCollaborators();
    });

    collection.on('collaboratorLeft', c => {
      addLog(`${c.username || c.id} left`, 'event');
      renderCollaborators();
    });

    collection.on('replayStart', ({ count }) => addLog(`Replaying ${count} changes...`, 'action'));
    collection.on('replayEnd', ({ replayed }) => {
      addLog(`Replayed ${replayed} changes`, 'event');
      renderTodos();
    });

    renderTodos();
    document.getElementById('inp-todo')?.focus();
  } catch (err) {
    addLog(`Join error: ${err.message}`, 'error');
  }
}

// ── Render app ───────────────────────────────────────────────────────────────
function render() {
  document.getElementById('app').innerHTML = `
  <div class="flex flex-col h-screen bg-base-100 text-base-content">

    <!-- Header -->
    <header class="flex items-center gap-3 px-5 py-3 bg-base-200 border-b border-base-300 shrink-0">
      <span class="text-xl font-bold text-primary">@nolag/sync</span>
      <span class="text-base-content/40 text-sm">Shared Todo List</span>
      <div class="ml-auto flex items-center gap-1.5">
        <span id="status-dot" class="w-2.5 h-2.5 rounded-full bg-error"></span>
        <span id="status-label" class="text-xs text-base-content/60">Disconnected</span>
      </div>
    </header>

    <!-- Connect panel -->
    <div class="flex flex-wrap items-end gap-3 px-5 py-3 bg-base-200/50 border-b border-base-300 shrink-0">
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Token</span></label>
        <input id="inp-token" type="password" placeholder="NoLag token" class="input input-sm input-bordered w-52" />
      </div>
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Username</span></label>
        <input id="inp-username" type="text" placeholder="alice" class="input input-sm input-bordered w-32" />
      </div>
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">App Name</span></label>
        <input id="inp-appname" type="text" placeholder="sync-demo" class="input input-sm input-bordered w-32" />
      </div>
      <button id="btn-connect" class="btn btn-sm btn-primary">Connect</button>
      <button id="btn-disconnect" class="btn btn-sm btn-ghost hidden">Disconnect</button>
    </div>

    <!-- Main layout -->
    <div class="flex flex-1 min-h-0">

      <!-- Todo list -->
      <main class="flex-1 flex flex-col min-w-0">

        <!-- Add todo -->
        <div id="todo-input-area" class="px-5 py-3 bg-base-200/30 border-b border-base-300 shrink-0 hidden">
          <div class="flex gap-2 max-w-2xl">
            <input id="inp-todo" type="text" placeholder="What needs to be done?" class="input input-bordered input-sm flex-1" />
            <button id="btn-add" class="btn btn-sm btn-primary">Add</button>
          </div>
        </div>

        <!-- Counts -->
        <div class="px-5 py-2 border-b border-base-300 flex items-center justify-between shrink-0">
          <span class="text-xs text-base-content/40 font-semibold uppercase tracking-widest">Todos</span>
          <span id="todo-counts" class="text-xs text-base-content/40"></span>
        </div>

        <!-- List -->
        <div id="todo-list" class="flex-1 overflow-y-auto p-5 flex flex-col gap-2 max-w-2xl w-full mx-auto">
          <div class="text-center text-base-content/30 py-12">
            <p class="text-lg font-semibold">Connect to start</p>
            <p class="text-sm mt-1">Enter a token above to sync todos in real-time.</p>
          </div>
        </div>
      </main>

      <!-- Right sidebar -->
      <aside class="w-64 shrink-0 flex flex-col bg-base-200 border-l border-base-300">

        <!-- Collaborators -->
        <div class="border-b border-base-300">
          <div class="px-3 py-2 border-b border-base-300">
            <span class="text-xs font-bold uppercase tracking-widest text-base-content/40">Collaborators</span>
          </div>
          <div id="collaborators" class="max-h-48 overflow-y-auto">
            <p class="text-xs text-base-content/30 px-3 py-4 text-center">No collaborators online.<br>Open in another tab to sync.</p>
          </div>
        </div>

        <!-- Event log -->
        <div class="flex-1 flex flex-col min-h-0">
          <div class="px-3 py-2 border-b border-base-300 flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-widest text-base-content/40">Event Log</span>
            <button id="btn-clear-log" class="btn btn-xs btn-ghost">Clear</button>
          </div>
          <div id="event-log" class="flex-1 overflow-y-auto py-1"></div>
        </div>
      </aside>
    </div>
  </div>
  `;

  // Bind events
  document.getElementById('btn-connect').addEventListener('click', handleConnect);
  document.getElementById('btn-disconnect').addEventListener('click', handleDisconnect);
  document.getElementById('btn-add').addEventListener('click', addTodo);
  document.getElementById('inp-todo').addEventListener('keydown', e => {
    if (e.key === 'Enter') addTodo();
  });
  document.getElementById('inp-token').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleConnect();
  });
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    document.getElementById('event-log').innerHTML = '';
  });

  addLog('Ready — enter a token and connect to sync todos', 'action');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
render();
