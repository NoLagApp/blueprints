import { NoLagStream } from '@nolag/stream';

// ── State ────────────────────────────────────────────────────────────────────
let sdk = null;
let activeRoom = null;
let currentRole = 'viewer';

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

// ── Floating reactions ───────────────────────────────────────────────────────
function spawnFloatingReaction(emoji) {
  const container = document.getElementById('reaction-float-area');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.style.left = (20 + Math.random() * 60) + '%';
  el.style.animationDuration = (2 + Math.random() * 1.5) + 's';
  container.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ── Render: comment feed ─────────────────────────────────────────────────────
function appendComment(comment, isSelf) {
  const feed = document.getElementById('comment-feed');
  if (!feed) return;
  const el = document.createElement('div');
  el.className = 'flex items-start gap-2 fade-in mb-1.5';
  el.innerHTML = `
    <span class="font-semibold text-xs ${isSelf ? 'text-primary' : 'text-base-content/70'}">${escHtml(comment.username || 'anon')}</span>
    <span class="text-sm text-base-content/90">${escHtml(comment.text)}</span>
  `;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

// ── Render: poll ─────────────────────────────────────────────────────────────
function renderActivePoll(poll) {
  const container = document.getElementById('active-poll');
  if (!container) return;
  if (!poll) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  const total = poll.options.reduce((s, o) => s + (o.votes ?? 0), 0);
  const isHost = currentRole === 'host';
  container.innerHTML = `
    <div class="bg-base-300/80 backdrop-blur rounded-lg p-3">
      <div class="flex items-center justify-between mb-2">
        <p class="font-semibold text-sm">${escHtml(poll.question)}</p>
        ${isHost ? `<button class="btn-close-poll btn btn-error btn-xs" data-id="${poll.id}">Close</button>` : ''}
      </div>
      <div class="flex flex-col gap-1.5">
        ${poll.options.map((opt, i) => {
          const votes = opt.votes ?? 0;
          const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
          return `
            <button class="btn-vote w-full text-left px-3 py-1.5 rounded bg-base-200 hover:bg-base-100 transition-colors" data-poll="${poll.id}" data-idx="${i}">
              <div class="flex justify-between text-xs mb-1">
                <span>${escHtml(opt.text)}</span>
                <span class="text-primary font-semibold">${pct}%</span>
              </div>
              <div class="w-full bg-base-100 rounded-full h-1">
                <div class="bg-primary h-1 rounded-full transition-all" style="width:${pct}%"></div>
              </div>
            </button>`;
        }).join('')}
      </div>
    </div>`;
  container.querySelectorAll('.btn-vote').forEach(btn => {
    btn.addEventListener('click', () => handleVotePoll(btn.dataset.poll, parseInt(btn.dataset.idx, 10)));
  });
  const closeBtn = container.querySelector('.btn-close-poll');
  if (closeBtn) closeBtn.addEventListener('click', () => handleClosePoll(closeBtn.dataset.id));
}

function renderPollUI() {
  const showCreateBtn = document.getElementById('btn-show-create-poll');
  if (showCreateBtn) {
    showCreateBtn.classList.toggle('hidden', currentRole !== 'host');
  }
  if (activeRoom?.activePoll) renderActivePoll(activeRoom.activePoll);
}

// ── Render: viewer sidebar ───────────────────────────────────────────────────
function renderViewers(viewers) {
  const el = document.getElementById('viewer-list');
  if (!el) return;
  if (!viewers || viewers.length === 0) {
    el.innerHTML = '<span class="text-xs text-base-content/30">No viewers</span>';
    return;
  }
  el.innerHTML = viewers.map(v => `
    <div class="flex items-center gap-2 py-1">
      <div class="w-5 h-5 rounded-full bg-secondary flex items-center justify-center text-secondary-content text-xs font-bold shrink-0">
        ${(v.username || '?')[0].toUpperCase()}
      </div>
      <span class="text-xs truncate">${escHtml(v.username || v.id)}</span>
    </div>`).join('');
}

function updateViewerCount(count) {
  const el = document.getElementById('viewer-count');
  if (el) el.textContent = count ?? '0';
}

function setConnected(connected) {
  const badge = document.getElementById('status-badge');
  if (badge) {
    badge.textContent = connected ? 'Connected' : 'Disconnected';
    badge.className = `badge badge-sm ${connected ? 'badge-success' : 'badge-error'}`;
  }
  document.getElementById('btn-connect').classList.toggle('hidden', connected);
  document.getElementById('btn-disconnect').classList.toggle('hidden', !connected);
}

// ── Connect ──────────────────────────────────────────────────────────────────
async function handleConnect() {
  const token = document.getElementById('inp-token').value.trim();
  const username = document.getElementById('inp-username').value.trim() || 'viewer-' + Math.floor(Math.random() * 1000);
  const role = document.getElementById('inp-role').value;
  const appName = document.getElementById('inp-appname').value.trim() || 'stream-demo';
  const streamName = document.getElementById('inp-stream').value.trim() || 'live-stream';

  if (!token) { addLog('Token is required', 'error'); return; }

  currentRole = role;
  addLog(`Connecting as ${role} "${username}"...`, 'action');

  sdk = new NoLagStream(token, { username, role, appName, debug: false });

  sdk.on('connected', async () => {
    addLog('Connected', 'event');
    setConnected(true);
    await joinStream(streamName);
  });

  sdk.on('disconnected', reason => {
    addLog(`Disconnected: ${reason ?? ''}`, 'error');
    setConnected(false);
    activeRoom = null;
  });

  sdk.on('reconnected', () => { addLog('Reconnected', 'event'); setConnected(true); });
  sdk.on('error', err => { addLog(`Error: ${err?.message ?? err}`, 'error'); });

  sdk.on('viewerOnline', v => { addLog(`${v.username} joined`, 'event'); refreshViewers(); });
  sdk.on('viewerOffline', v => { addLog(`${v.username} left`, 'event'); refreshViewers(); });
  sdk.on('viewerCountChanged', count => { updateViewerCount(count); });

  await sdk.connect();
}

async function handleDisconnect() {
  if (!sdk) return;
  await sdk.disconnect();
  sdk = null;
  activeRoom = null;
  setConnected(false);
  addLog('Disconnected', 'action');
}

async function refreshViewers() {
  if (!sdk?.connected) return;
  try {
    const viewers = await sdk.getOnlineViewers();
    renderViewers(viewers);
    updateViewerCount(viewers.length);
  } catch (e) {}
}

// ── Stream ───────────────────────────────────────────────────────────────────
async function joinStream(name) {
  addLog(`Joining stream: ${name}`, 'action');
  const room = await sdk.joinStream(name);
  activeRoom = room;

  document.getElementById('stream-name').textContent = name;
  document.getElementById('stream-area').classList.remove('hidden');
  document.getElementById('join-section').classList.add('hidden');

  room.on('comment', c => { appendComment(c, false); });
  room.on('commentSent', c => { appendComment(c, true); });

  room.on('reaction', burst => {
    for (let i = 0; i < Math.min(burst.count, 5); i++) {
      setTimeout(() => spawnFloatingReaction(burst.emoji), i * 100);
    }
  });

  room.on('pollCreated', poll => { addLog(`Poll: "${poll.question}"`, 'event'); renderActivePoll(poll); });
  room.on('pollUpdated', poll => { renderActivePoll(poll); });
  room.on('pollClosed', () => { renderActivePoll(null); });

  room.on('viewerJoined', v => { addLog(`${v.username} viewing`, 'event'); updateRoomViewerCount(); });
  room.on('viewerLeft', v => { addLog(`${v.username} left stream`, 'event'); updateRoomViewerCount(); });
  room.on('viewerCountChanged', count => { updateViewerCount(count); });

  room.on('replayStart', ({ count }) => addLog(`Replaying ${count} messages...`, 'action'));
  room.on('replayEnd', ({ replayed }) => addLog(`Replayed ${replayed} messages`, 'event'));

  // Load comment history
  try {
    const comments = await room.getComments();
    if (comments?.length) comments.forEach(c => appendComment(c, false));
  } catch (e) {}

  refreshViewers();
  updateRoomViewerCount();
  renderPollUI();
}

function updateRoomViewerCount() {
  if (activeRoom?.viewerCount != null) updateViewerCount(activeRoom.viewerCount);
}

async function handleLeave() {
  if (!sdk || !activeRoom) return;
  await sdk.leaveStream(activeRoom.name);
  activeRoom = null;
  document.getElementById('stream-area').classList.add('hidden');
  document.getElementById('join-section').classList.remove('hidden');
  addLog('Left stream', 'action');
}

// ── Actions ──────────────────────────────────────────────────────────────────
async function handleSendComment() {
  if (!activeRoom) return;
  const inp = document.getElementById('inp-comment');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  await activeRoom.sendComment(text);
}

async function handleReaction(emoji) {
  if (!activeRoom) return;
  spawnFloatingReaction(emoji);
  await activeRoom.sendReaction(emoji);
}

async function handleCreatePoll() {
  if (!activeRoom) return;
  const question = document.getElementById('inp-poll-question').value.trim();
  const options = Array.from(document.querySelectorAll('.poll-opt'))
    .map(el => el.value.trim()).filter(Boolean);
  if (!question || options.length < 2) return;
  await activeRoom.createPoll({ question, options });
  document.getElementById('inp-poll-question').value = '';
  document.getElementById('create-poll-form').classList.add('hidden');
  document.getElementById('btn-show-create-poll').classList.remove('hidden');
}

async function handleVotePoll(pollId, idx) {
  if (!activeRoom) return;
  await activeRoom.votePoll(pollId, idx);
}

async function handleClosePoll(pollId) {
  if (!activeRoom) return;
  await activeRoom.closePoll(pollId);
}

// ── Render app ───────────────────────────────────────────────────────────────
function render() {
  document.getElementById('app').innerHTML = `
  <div class="flex flex-col h-screen bg-base-100 text-base-content">

    <!-- Header -->
    <header class="flex items-center gap-3 px-5 py-3 bg-base-200 border-b border-base-300 shrink-0">
      <span class="text-xl font-bold text-primary">@nolag/stream</span>
      <span class="text-base-content/40 text-sm">Live Stream Demo</span>
      <div class="ml-auto flex items-center gap-3">
        <span id="status-badge" class="badge badge-sm badge-error">Disconnected</span>
      </div>
    </header>

    <!-- Join section -->
    <div id="join-section" class="flex-1 flex items-center justify-center p-6">
      <div class="card bg-base-200 border border-base-300 w-full max-w-md">
        <div class="card-body gap-4">
          <h2 class="card-title text-xl">Join a Live Stream</h2>
          <p class="text-sm text-base-content/50">Real-time engagement: comments, reactions, polls, and viewer tracking.</p>
          <div class="form-control">
            <label class="label py-0.5"><span class="label-text text-xs">Token</span></label>
            <input id="inp-token" type="password" placeholder="NoLag token" class="input input-bordered w-full" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control">
              <label class="label py-0.5"><span class="label-text text-xs">Username</span></label>
              <input id="inp-username" type="text" placeholder="viewer123" class="input input-bordered w-full" />
            </div>
            <div class="form-control">
              <label class="label py-0.5"><span class="label-text text-xs">Role</span></label>
              <select id="inp-role" class="select select-bordered w-full">
                <option value="viewer">Viewer</option>
                <option value="moderator">Moderator</option>
                <option value="host">Host</option>
              </select>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control">
              <label class="label py-0.5"><span class="label-text text-xs">Stream Name</span></label>
              <input id="inp-stream" type="text" placeholder="live-stream" value="live-stream" class="input input-bordered w-full" />
            </div>
            <div class="form-control">
              <label class="label py-0.5"><span class="label-text text-xs">App Name</span></label>
              <input id="inp-appname" type="text" placeholder="stream-demo" class="input input-bordered w-full" />
            </div>
          </div>
          <button id="btn-connect" class="btn btn-primary mt-2">Join Stream</button>
          <button id="btn-disconnect" class="btn btn-ghost hidden">Disconnect</button>
        </div>
      </div>
    </div>

    <!-- Stream area (hidden until joined) -->
    <div id="stream-area" class="flex-1 flex hidden min-h-0">

      <!-- Main: video + engagement -->
      <main class="flex-1 flex flex-col min-w-0">

        <!-- Video player placeholder -->
        <div class="relative bg-black flex-shrink-0" style="aspect-ratio: 16/7; max-height: 45vh;">
          <!-- Fake video area -->
          <div class="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-base-300 to-black">
            <div class="text-center">
              <div class="text-4xl font-bold text-base-content/10 mb-2">LIVE</div>
              <div class="text-sm text-base-content/20">Video stream would appear here</div>
            </div>
          </div>

          <!-- LIVE badge + viewer count overlay -->
          <div class="absolute top-3 left-3 flex items-center gap-2">
            <span class="badge badge-error badge-sm gap-1 font-bold">
              <span class="w-1.5 h-1.5 rounded-full bg-error-content animate-pulse"></span>
              LIVE
            </span>
            <span class="badge badge-sm bg-black/60 border-0 text-white gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
              <span id="viewer-count">0</span>
            </span>
            <span class="text-xs text-white/50" id="stream-name"></span>
          </div>

          <!-- Floating reactions area -->
          <div id="reaction-float-area" class="absolute bottom-0 right-4 w-24 h-full pointer-events-none overflow-hidden"></div>

          <!-- Poll overlay (bottom-left of video) -->
          <div id="active-poll" class="absolute bottom-3 left-3 w-72 hidden"></div>

          <!-- Leave button -->
          <button id="btn-leave" class="absolute top-3 right-3 btn btn-xs btn-ghost text-white/60 hover:text-white">Leave</button>
        </div>

        <!-- Engagement area below video -->
        <div class="flex-1 flex flex-col min-h-0">

          <!-- Comment feed -->
          <div id="comment-feed" class="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-0.5"></div>

          <!-- Reaction bar -->
          <div class="px-4 py-2 bg-base-200 border-t border-base-300 shrink-0 flex items-center gap-1">
            <button class="reaction-btn btn btn-ghost btn-sm text-lg" data-emoji="\uD83D\uDC4D">\uD83D\uDC4D</button>
            <button class="reaction-btn btn btn-ghost btn-sm text-lg" data-emoji="\u2764\uFE0F">\u2764\uFE0F</button>
            <button class="reaction-btn btn btn-ghost btn-sm text-lg" data-emoji="\uD83D\uDE02">\uD83D\uDE02</button>
            <button class="reaction-btn btn btn-ghost btn-sm text-lg" data-emoji="\uD83D\uDE32">\uD83D\uDE32</button>
            <button class="reaction-btn btn btn-ghost btn-sm text-lg" data-emoji="\uD83D\uDD25">\uD83D\uDD25</button>
            <div class="flex-1"></div>
            <button id="btn-show-create-poll" class="btn btn-ghost btn-xs hidden">+ Poll</button>
          </div>

          <!-- Comment input -->
          <div class="px-4 py-2 bg-base-200 border-t border-base-300 shrink-0 flex gap-2">
            <input id="inp-comment" type="text" placeholder="Say something..." class="input input-bordered input-sm flex-1" />
            <button id="btn-send-comment" class="btn btn-primary btn-sm">Send</button>
          </div>

          <!-- Create poll form (hidden) -->
          <div id="create-poll-form" class="px-4 py-3 bg-base-200 border-t border-base-300 shrink-0 hidden">
            <input id="inp-poll-question" type="text" placeholder="Poll question..." class="input input-bordered input-sm w-full mb-2" />
            <div id="poll-options-inputs">
              <input type="text" placeholder="Option 1" class="poll-opt input input-bordered input-xs mb-1 w-full" />
              <input type="text" placeholder="Option 2" class="poll-opt input input-bordered input-xs mb-1 w-full" />
            </div>
            <div class="flex gap-2 mt-1">
              <button id="btn-add-option" class="btn btn-ghost btn-xs">+ Option</button>
              <button id="btn-create-poll" class="btn btn-primary btn-xs">Create Poll</button>
            </div>
          </div>
        </div>
      </main>

      <!-- Right sidebar: viewers + log -->
      <aside class="w-56 shrink-0 flex flex-col bg-base-200 border-l border-base-300">
        <div class="px-3 py-2 border-b border-base-300">
          <span class="text-xs font-bold uppercase tracking-widest text-base-content/40">Viewers</span>
        </div>
        <div id="viewer-list" class="p-3 overflow-y-auto max-h-48 border-b border-base-300">
          <span class="text-xs text-base-content/30">No viewers</span>
        </div>
        <div class="px-3 py-2 border-b border-base-300 flex items-center justify-between">
          <span class="text-xs font-bold uppercase tracking-widest text-base-content/40">Event Log</span>
          <button id="btn-clear-log" class="btn btn-xs btn-ghost">Clear</button>
        </div>
        <div id="event-log" class="flex-1 overflow-y-auto py-1"></div>
      </aside>
    </div>
  </div>
  `;

  // Bind events
  document.getElementById('btn-connect').addEventListener('click', handleConnect);
  document.getElementById('btn-disconnect').addEventListener('click', handleDisconnect);
  document.getElementById('btn-leave').addEventListener('click', handleLeave);
  document.getElementById('btn-send-comment').addEventListener('click', handleSendComment);
  document.getElementById('inp-comment').addEventListener('keydown', e => { if (e.key === 'Enter') handleSendComment(); });
  document.getElementById('inp-token').addEventListener('keydown', e => { if (e.key === 'Enter') handleConnect(); });
  document.getElementById('btn-clear-log').addEventListener('click', () => { document.getElementById('event-log').innerHTML = ''; });

  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => handleReaction(btn.dataset.emoji));
  });

  document.getElementById('btn-show-create-poll').addEventListener('click', () => {
    document.getElementById('create-poll-form').classList.remove('hidden');
    document.getElementById('btn-show-create-poll').classList.add('hidden');
  });
  document.getElementById('btn-add-option').addEventListener('click', () => {
    const count = document.querySelectorAll('.poll-opt').length + 1;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = `Option ${count}`;
    inp.className = 'poll-opt input input-bordered input-xs mb-1 w-full';
    document.getElementById('poll-options-inputs').appendChild(inp);
  });
  document.getElementById('btn-create-poll').addEventListener('click', handleCreatePoll);

  addLog('Ready — enter a token to join a live stream', 'action');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
render();
