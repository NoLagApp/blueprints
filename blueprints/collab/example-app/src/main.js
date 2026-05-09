import { NoLagCollab } from '@nolag/collab';

// ── State ────────────────────────────────────────────────────────────────────
let collab = null;
let activeDoc = null;
let prevText = '';
let isApplyingRemote = false;
let cursorMap = {};   // userId → { username, color, line, column, status }
let idleTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function addLog(msg, type = 'event') {
  const log = document.getElementById('event-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = `log-entry ${type} fade-in`;
  el.textContent = `${ts()} ${msg}`;
  log.prepend(el);
  if (log.children.length > 80) log.lastChild.remove();
}

function setConnected(connected) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  if (dot) dot.className = `w-2.5 h-2.5 rounded-full ${connected ? 'bg-success' : 'bg-error'}`;
  if (label) label.textContent = connected ? 'Connected' : 'Disconnected';

  document.getElementById('btn-connect').classList.toggle('hidden', connected);
  document.getElementById('btn-disconnect').classList.toggle('hidden', !connected);
  document.getElementById('editor').disabled = !connected;
  ['inp-token', 'inp-username', 'inp-color', 'inp-appname'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = connected;
  });
}

// ── Diff: compute insert/delete ops from a text change ───────────────────────
function computeOps(oldText, newText) {
  let prefix = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > prefix && newEnd > prefix && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const deletedLen = oldEnd - prefix;
  const insertedText = newText.slice(prefix, newEnd);
  const ops = [];

  if (deletedLen > 0 && insertedText.length > 0) {
    ops.push({ type: 'replace', position: prefix, length: deletedLen, content: insertedText });
  } else if (deletedLen > 0) {
    ops.push({ type: 'delete', position: prefix, length: deletedLen });
  } else if (insertedText.length > 0) {
    ops.push({ type: 'insert', position: prefix, content: insertedText });
  }

  return ops;
}

// ── Apply a remote operation to the local editor ─────────────────────────────
function applyRemoteOp(op) {
  const editor = document.getElementById('editor');
  if (!editor) return;

  isApplyingRemote = true;
  const cursor = editor.selectionStart;
  const selEnd = editor.selectionEnd;
  let text = editor.value;
  let newStart = cursor;
  let newSelEnd = selEnd;

  if (op.type === 'insert') {
    text = text.slice(0, op.position) + op.content + text.slice(op.position);
    if (op.position <= cursor) {
      newStart += op.content.length;
      newSelEnd += op.content.length;
    }
  } else if (op.type === 'delete') {
    text = text.slice(0, op.position) + text.slice(op.position + op.length);
    if (op.position < cursor) {
      const shift = Math.min(op.length, cursor - op.position);
      newStart -= shift;
      newSelEnd -= shift;
    }
  } else if (op.type === 'replace') {
    text = text.slice(0, op.position) + op.content + text.slice(op.position + op.length);
    if (op.position < cursor) {
      const shift = op.content.length - op.length;
      newStart += shift;
      newSelEnd += shift;
    }
  }

  editor.value = text;
  editor.selectionStart = Math.max(0, newStart);
  editor.selectionEnd = Math.max(0, newSelEnd);
  prevText = text;
  isApplyingRemote = false;
}

// ── Cursor helpers ───────────────────────────────────────────────────────────
function getCursorLineCol(textarea) {
  const pos = textarea.selectionStart;
  const lines = textarea.value.slice(0, pos).split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function sendCursorUpdate() {
  const editor = document.getElementById('editor');
  if (!editor || !activeDoc) return;
  const { line, column } = getCursorLineCol(editor);
  activeDoc.updateCursor({ line, column });
}

// ── Editor event handlers ────────────────────────────────────────────────────
function onEditorInput() {
  if (isApplyingRemote) return;
  const editor = document.getElementById('editor');
  const newText = editor.value;
  const ops = computeOps(prevText, newText);

  for (const op of ops) {
    if (activeDoc) {
      activeDoc.sendOperation(op.type, op);
    }
  }

  prevText = newText;
  sendCursorUpdate();
  resetIdleTimer();
}

function onCursorMove() {
  sendCursorUpdate();
}

// ── Idle detection ───────────────────────────────────────────────────────────
function resetIdleTimer() {
  if (!activeDoc) return;
  activeDoc.setStatus('active');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeDoc) activeDoc.setStatus('idle');
  }, 10000);
}

// ── Render: collaborators panel ──────────────────────────────────────────────
function renderCollaborators() {
  const el = document.getElementById('collaborators');
  if (!el) return;
  const cursors = Object.values(cursorMap);
  if (cursors.length === 0) {
    el.innerHTML = '<p class="text-xs text-base-content/30 px-3 py-6 text-center">No other collaborators yet.<br>Open this page in another tab to collaborate.</p>';
    return;
  }
  el.innerHTML = cursors.map(c => {
    const statusCls = c.status === 'active' ? 'badge-success' : c.status === 'idle' ? 'badge-warning' : 'badge-ghost';
    return `
      <div class="flex items-center gap-2.5 px-3 py-2.5 border-b border-base-300/50">
        <span class="w-3 h-3 rounded-full shrink-0" style="background:${c.color ?? '#888'}"></span>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold truncate">${c.username ?? 'anonymous'}</div>
          <div class="text-xs text-base-content/40 font-mono">Ln ${c.line ?? '?'}, Col ${c.column ?? '?'}</div>
        </div>
        <span class="badge badge-xs ${statusCls}">${c.status ?? 'active'}</span>
      </div>`;
  }).join('');
}

function renderOnlineCount() {
  const el = document.getElementById('online-count');
  if (!el || !collab) return;
  const users = collab.getOnlineUsers();
  el.textContent = `${users.length} online`;
}

// ── Connect / Disconnect ─────────────────────────────────────────────────────
async function handleConnect() {
  const token = document.getElementById('inp-token').value.trim();
  const username = document.getElementById('inp-username').value.trim() || 'user-' + Math.floor(Math.random() * 1000);
  const color = document.getElementById('inp-color').value || '#FF8A00';
  const appName = document.getElementById('inp-appname').value.trim() || 'collab-demo';

  if (!token) { addLog('Token is required', 'error'); return; }

  addLog(`Connecting as "${username}"…`, 'action');

  collab = new NoLagCollab(token, {
    username,
    color,
    appName,
    debug: false,
    url: 'wss://broker.dev.nolag.app/ws',
    documents: ['my-doc'],
  });

  collab.on('connected', async () => {
    setConnected(true);
    addLog('Connected', 'event');
    renderOnlineCount();
    await joinDocument('my-doc');
  });

  collab.on('disconnected', reason => {
    setConnected(false);
    addLog(`Disconnected: ${reason ?? ''}`, 'error');
    activeDoc = null;
    cursorMap = {};
    renderCollaborators();
  });

  collab.on('reconnected', () => {
    setConnected(true);
    addLog('Reconnected', 'event');
  });

  collab.on('error', err => {
    addLog(`Error: ${err?.message ?? err}`, 'error');
  });

  collab.on('userOnline', user => {
    addLog(`${user.username} came online`, 'event');
    renderOnlineCount();
  });

  collab.on('userOffline', user => {
    addLog(`${user.username} went offline`, 'event');
    renderOnlineCount();
  });

  await collab.connect();
}

async function handleDisconnect() {
  if (!collab) return;
  clearTimeout(idleTimer);
  await collab.disconnect();
  collab = null;
  activeDoc = null;
  cursorMap = {};
  prevText = '';
  document.getElementById('editor').value = '';
  setConnected(false);
  addLog('Disconnected', 'action');
  renderCollaborators();
  renderOnlineCount();
}

// ── Document ─────────────────────────────────────────────────────────────────
async function joinDocument(name) {
  if (!collab) return;
  try {
    const doc = await collab.joinDocument(name);
    activeDoc = doc;
    addLog(`Joined document "${name}"`, 'event');

    const label = document.getElementById('doc-label');
    if (label) label.textContent = name;

    doc.on('operation', op => {
      applyRemoteOp(op);
      const preview = op.content ? `"${op.content.slice(0, 30)}${op.content.length > 30 ? '…' : ''}"` : '';
      addLog(`${op.username ?? 'peer'}: ${op.type} @${op.position ?? 0} ${preview}`, 'event');
    });

    doc.on('cursorMoved', cursor => {
      cursorMap[cursor.userId] = { ...cursorMap[cursor.userId], ...cursor };
      renderCollaborators();
    });

    doc.on('userJoined', user => {
      addLog(`${user.username} joined`, 'event');
      cursorMap[user.userId] = { ...user, line: 1, column: 1, status: 'active' };
      renderCollaborators();
      renderOnlineCount();
    });

    doc.on('userLeft', user => {
      addLog(`${user.username} left`, 'event');
      delete cursorMap[user.userId];
      renderCollaborators();
      renderOnlineCount();
    });

    doc.on('awarenessChanged', ({ userId, status }) => {
      if (cursorMap[userId]) {
        cursorMap[userId].status = status;
        renderCollaborators();
      }
    });

    doc.on('replayStart', ({ count }) => addLog(`Replaying ${count} operations…`, 'action'));
    doc.on('replayEnd', ({ replayed }) => addLog(`Replayed ${replayed} operations`, 'event'));

    // Populate initial collaborators
    const users = doc.getUsers();
    users.forEach(u => {
      cursorMap[u.userId] = { ...u, line: 1, column: 1, status: u.status ?? 'active' };
    });
    renderCollaborators();

    // Focus editor
    const editor = document.getElementById('editor');
    editor.disabled = false;
    editor.focus();
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
      <span class="text-xl font-bold text-primary">@nolag/collab</span>
      <span class="text-base-content/40 text-sm">Collaborative Editor</span>
      <div class="ml-auto flex items-center gap-4">
        <span id="online-count" class="text-xs text-base-content/50"></span>
        <div class="flex items-center gap-1.5">
          <span id="status-dot" class="w-2.5 h-2.5 rounded-full bg-error"></span>
          <span id="status-label" class="text-xs text-base-content/60">Disconnected</span>
        </div>
      </div>
    </header>

    <!-- Connect panel -->
    <div class="flex flex-wrap items-end gap-3 px-5 py-3 bg-base-200/50 border-b border-base-300 shrink-0">
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Token</span></label>
        <input id="inp-token" type="text" placeholder="NoLag token" class="input input-sm input-bordered w-52" />
      </div>
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Username</span></label>
        <input id="inp-username" type="text" placeholder="alice" class="input input-sm input-bordered w-32" />
      </div>
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Color</span></label>
        <input id="inp-color" type="color" value="#FF8A00" class="input input-sm input-bordered w-12 p-0.5 cursor-pointer" />
      </div>
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">App Slug</span></label>
        <input id="inp-appname" type="text" placeholder="collab-demo" class="input input-sm input-bordered w-32" />
      </div>
      <button id="btn-connect" class="btn btn-sm btn-primary">Connect</button>
      <button id="btn-disconnect" class="btn btn-sm btn-ghost hidden">Disconnect</button>
    </div>

    <!-- Main layout -->
    <div class="flex flex-1 min-h-0">

      <!-- Editor -->
      <main class="flex-1 flex flex-col min-w-0">
        <div class="px-5 py-2 bg-base-200/30 border-b border-base-300 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span id="doc-label" class="text-sm font-semibold text-base-content/70">my-doc</span>
        </div>
        <textarea
          id="editor"
          class="flex-1 w-full bg-base-100 text-base-content p-5 resize-none outline-none font-mono text-sm leading-relaxed"
          placeholder="Start typing to collaborate in real-time…"
          disabled
          spellcheck="false"
        ></textarea>
      </main>

      <!-- Right sidebar -->
      <aside class="w-64 shrink-0 flex flex-col bg-base-200 border-l border-base-300">

        <!-- Collaborators -->
        <div class="border-b border-base-300">
          <div class="px-3 py-2 border-b border-base-300">
            <span class="text-xs font-bold uppercase tracking-widest text-base-content/40">Collaborators</span>
          </div>
          <div id="collaborators" class="max-h-52 overflow-y-auto">
            <p class="text-xs text-base-content/30 px-3 py-6 text-center">No other collaborators yet.<br>Open this page in another tab to collaborate.</p>
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

  // Bind connect/disconnect
  document.getElementById('btn-connect').addEventListener('click', handleConnect);
  document.getElementById('btn-disconnect').addEventListener('click', handleDisconnect);
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    document.getElementById('event-log').innerHTML = '';
  });
  document.getElementById('inp-token').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleConnect();
  });

  // Bind editor events
  const editor = document.getElementById('editor');
  editor.addEventListener('input', onEditorInput);
  editor.addEventListener('click', onCursorMove);
  editor.addEventListener('keyup', onCursorMove);
  editor.addEventListener('keydown', resetIdleTimer);
  editor.addEventListener('mousedown', resetIdleTimer);

  addLog('Ready — enter a token and connect to start collaborating', 'action');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
render();
