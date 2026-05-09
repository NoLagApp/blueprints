/**
 * @nolag/chat SDK — Interactive Demo
 *
 * This test app showcases every feature of the @nolag/chat SDK:
 *   - NoLagChat: connect, disconnect, global presence, profile updates
 *   - ChatRoom: join/leave, sendMessage, typing, users, message replay
 *   - Events: connected, disconnected, reconnected, error,
 *             userOnline, userOffline, userUpdated,
 *             message, messageSent, userJoined, userLeft, typing,
 *             replayStart, replayEnd
 *
 * Uses inline DaisyUI v5 + Tailwind v4 (CDN) — no build pipeline for CSS.
 */

import { NoLagChat } from '@nolag/chat';

// ============================================================
// State
// ============================================================
let chat = null;
let currentRoom = null;
let connected = false;
const availableRooms = ['general', 'random', 'help', 'dev'];
const eventLog = []; // { time, type, text }

// ============================================================
// Helpers
// ============================================================
function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
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
// Render: Full App Shell
// ============================================================
function renderApp() {
  const app = $('#app');

  app.innerHTML = `
    <div class="h-screen flex flex-col bg-base-200">
      <!-- Navbar -->
      <div class="navbar bg-base-100 shadow-lg px-4 flex-shrink-0">
        <div class="flex-1 gap-2">
          <span class="text-xl font-bold">@nolag/chat Demo</span>
          <div class="badge ${connected ? 'badge-success' : 'badge-error'} badge-sm">
            ${connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <div class="flex-none gap-2">
          ${connected ? `
            <div class="badge badge-info badge-sm">${(chat?.getOnlineUsers().length ?? 0) + 1} online</div>
            <div class="dropdown dropdown-end">
              <div tabindex="0" role="button" class="btn btn-ghost btn-sm">
                ${esc(chat?.localUser?.username ?? '')}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
                </svg>
              </div>
              <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box z-10 w-52 p-2 shadow-lg">
                <li><a id="btn-status-online">Status: Online</a></li>
                <li><a id="btn-status-away">Status: Away</a></li>
                <li><a id="btn-status-busy">Status: Busy</a></li>
                <li class="border-t border-base-300 mt-1 pt-1"><a id="btn-disconnect" class="text-error">Disconnect</a></li>
              </ul>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Main content -->
      <div class="flex-1 flex overflow-hidden min-h-0">
        ${!connected ? renderConnectPanel() : renderChatLayout()}
      </div>
    </div>
  `;

  if (!connected) {
    attachConnectListeners();
  } else {
    renderRoomList();
    renderOnlineUsers();
    renderRoomUsers();
    renderMessages();
    renderEventLog();
    attachChatListeners();
    attachStatusListeners();
  }
}

// ============================================================
// Render: Connect Panel
// ============================================================
function renderConnectPanel() {
  return `
    <div class="flex-1 flex items-center justify-center">
      <div class="card bg-base-100 shadow-xl w-96">
        <div class="card-body">
          <h2 class="card-title justify-center text-2xl">@nolag/chat</h2>
          <p class="text-center text-base-content/60 text-sm">
            High-level chat SDK with presence, typing, replay &amp; multi-room
          </p>

          <div class="divider text-xs">CONNECT</div>

          <div class="form-control">
            <label class="label"><span class="label-text">Access Token</span></label>
            <input id="token-input" type="text" placeholder="Paste your NoLag access token"
                   class="input input-bordered input-sm" />
          </div>

          <div class="form-control">
            <label class="label"><span class="label-text">Username</span></label>
            <input id="username-input" type="text" placeholder="Pick a display name"
                   class="input input-bordered input-sm"
                   value="User_${Math.random().toString(36).slice(2, 6)}" />
          </div>

          <div class="form-control">
            <label class="label"><span class="label-text">App Slug</span></label>
            <input id="appname-input" type="text" placeholder="NoLag app slug"
                   class="input input-bordered input-sm" value="chat-app" />
          </div>

          <div id="connect-error" class="alert alert-error text-sm hidden mt-2"></div>

          <div class="card-actions justify-center mt-4">
            <button id="btn-connect" class="btn btn-primary btn-wide">Connect</button>
          </div>

          <div class="divider text-xs">SDK FEATURES</div>
          <ul class="text-xs text-base-content/60 space-y-1">
            <li>Multi-room with <code class="badge badge-xs badge-ghost">joinRoom()</code> / <code class="badge badge-xs badge-ghost">leaveRoom()</code></li>
            <li>Global presence via <code class="badge badge-xs badge-ghost">getOnlineUsers()</code></li>
            <li>Typing indicators: <code class="badge badge-xs badge-ghost">startTyping()</code></li>
            <li>Message replay on reconnect with <code class="badge badge-xs badge-ghost">isReplay</code> flag</li>
            <li>Status: <code class="badge badge-xs badge-ghost">setStatus('away')</code></li>
            <li>Profile: <code class="badge badge-xs badge-ghost">updateProfile({ username })</code></li>
          </ul>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// Render: Chat Layout (connected)
// ============================================================
function renderChatLayout() {
  return `
    <!-- Left sidebar: rooms + online users -->
    <div class="w-56 bg-base-100 border-r border-base-300 flex flex-col flex-shrink-0">
      <div class="p-3 border-b border-base-300 flex items-center justify-between">
        <h3 class="font-semibold text-sm">Rooms</h3>
      </div>
      <ul id="room-list" class="menu menu-sm"></ul>

      <div class="p-3 border-t border-base-300">
        <h3 class="font-semibold text-sm">Online Users</h3>
      </div>
      <ul id="online-users" class="menu menu-sm flex-1 overflow-y-auto"></ul>
    </div>

    <!-- Center: messages -->
    <div class="flex-1 flex flex-col min-w-0">
      <div class="px-4 py-2 bg-base-100 border-b border-base-300 flex items-center gap-2 flex-shrink-0">
        <span class="font-bold" id="room-title"># general</span>
        <span class="text-xs text-base-content/50" id="room-user-count"></span>
      </div>

      <div id="messages-container" class="flex-1 overflow-y-auto p-4 space-y-2"></div>

      <div id="typing-indicator" class="px-4 h-6 text-xs text-base-content/50"></div>

      <div class="p-3 bg-base-100 border-t border-base-300 flex-shrink-0">
        <div class="flex gap-2">
          <input id="message-input" type="text" placeholder="Type a message..."
                 class="input input-bordered input-sm flex-1" />
          <button id="btn-send" class="btn btn-primary btn-sm">Send</button>
        </div>
      </div>
    </div>

    <!-- Right sidebar: room users + event log -->
    <div class="w-72 bg-base-100 border-l border-base-300 flex flex-col flex-shrink-0">
      <div class="p-3 border-b border-base-300">
        <h3 class="font-semibold text-sm">Room Members</h3>
      </div>
      <ul id="room-users" class="menu menu-sm max-h-40 overflow-y-auto"></ul>

      <div class="p-3 border-t border-base-300 flex items-center justify-between">
        <h3 class="font-semibold text-sm">Event Log</h3>
        <button id="btn-clear-log" class="btn btn-ghost btn-xs">Clear</button>
      </div>
      <div id="event-log" class="flex-1 overflow-y-auto p-2 text-xs bg-base-200/50"></div>
    </div>
  `;
}

// ============================================================
// Render: Sub-sections
// ============================================================
function renderRoomList() {
  const el = $('#room-list');
  if (!el) return;

  el.innerHTML = availableRooms.map(name => {
    const room = chat?.rooms.get(name);
    const unread = room?.unreadCount ?? 0;
    return `
      <li>
        <a class="room-link flex items-center gap-2 ${currentRoom?.name === name ? 'active' : ''}" data-room="${name}">
          <span class="text-base-content/40">#</span>
          <span class="flex-1">${esc(name)}</span>
          ${unread > 0 ? `<span class="badge badge-sm badge-primary">${unread}</span>` : ''}
        </a>
      </li>
    `;
  }).join('');

  el.querySelectorAll('.room-link').forEach(link => {
    link.addEventListener('click', () => switchRoom(link.dataset.room));
  });
}

function renderOnlineUsers() {
  const el = $('#online-users');
  if (!el || !chat) return;

  const local = chat.localUser;
  const users = chat.getOnlineUsers();

  el.innerHTML = [
    local ? renderUserItem(local, true) : '',
    ...users.map(u => renderUserItem(u, false)),
  ].join('');
}

function renderUserItem(user, isLocal) {
  const statusColor = {
    online: 'bg-success',
    away: 'bg-warning',
    busy: 'bg-error',
    offline: 'bg-base-300',
  }[user.status] || 'bg-base-300';

  return `
    <li>
      <a class="flex items-center gap-2 ${isLocal ? 'bg-primary/10' : ''}">
        <div class="avatar placeholder">
          <div class="bg-neutral text-neutral-content rounded-full w-6">
            <span class="text-xs">${esc(user.username.charAt(0).toUpperCase())}</span>
          </div>
        </div>
        <span class="truncate text-xs flex-1">${esc(user.username)}</span>
        ${isLocal ? '<span class="badge badge-xs badge-primary">you</span>' : ''}
        <span class="w-2 h-2 rounded-full ${statusColor} flex-shrink-0"></span>
      </a>
    </li>
  `;
}

function renderRoomUsers() {
  const el = $('#room-users');
  const countEl = $('#room-user-count');
  if (!el || !currentRoom) return;

  const users = currentRoom.getUsers();
  if (countEl) countEl.textContent = `${users.length + 1} member${users.length !== 0 ? 's' : ''}`;

  el.innerHTML = users.length === 0
    ? '<li class="px-3 py-2 text-xs text-base-content/50">Only you here</li>'
    : users.map(u => renderUserItem(u, false)).join('');
}

function renderMessages() {
  const el = $('#messages-container');
  if (!el || !currentRoom) return;

  const messages = currentRoom.getMessages();
  const localUserId = chat?.localUser?.userId;

  if (messages.length === 0) {
    el.innerHTML = `
      <div class="text-center text-base-content/40 py-12">
        <p class="text-lg">No messages yet</p>
        <p class="text-sm mt-1">Send a message to get started</p>
      </div>
    `;
    return;
  }

  el.innerHTML = messages.map(msg => {
    const isOwn = msg.userId === localUserId;
    return `
      <div class="chat ${isOwn ? 'chat-end' : 'chat-start'} fade-in">
        <div class="chat-header">
          ${esc(msg.username)}
          <time class="text-xs opacity-50 ml-1">${time(msg.timestamp)}</time>
          ${msg.isReplay ? '<span class="badge badge-xs badge-ghost ml-1">replay</span>' : ''}
          ${msg.status === 'sending' ? '<span class="badge badge-xs badge-warning ml-1">sending</span>' : ''}
        </div>
        <div class="chat-bubble ${isOwn ? 'chat-bubble-primary' : ''}">
          ${esc(msg.text)}
        </div>
      </div>
    `;
  }).join('');

  el.scrollTop = el.scrollHeight;
}

function renderTypingIndicator(users) {
  const el = $('#typing-indicator');
  if (!el) return;

  if (!users || users.length === 0) {
    el.innerHTML = '';
    return;
  }

  const names = users.map(u => u.username);
  const text = names.length === 1
    ? `${names[0]} is typing`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing`
      : `${names[0]} and ${names.length - 1} others are typing`;

  el.innerHTML = `
    <span>${esc(text)}</span>
    <span class="inline-flex gap-0.5 ml-1">
      <span class="typing-dot w-1.5 h-1.5 rounded-full bg-base-content/50 inline-block"></span>
      <span class="typing-dot w-1.5 h-1.5 rounded-full bg-base-content/50 inline-block"></span>
      <span class="typing-dot w-1.5 h-1.5 rounded-full bg-base-content/50 inline-block"></span>
    </span>
  `;
}

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
// Room Switching
// ============================================================
function wireRoomEvents(name, room) {
  room.on('message', (msg) => {
    log('event', `message: ${msg.username}: "${msg.text}"${msg.isReplay ? ' [replay]' : ''} in #${name}`);
    if (currentRoom?.name === name) renderMessages();
  });

  room.on('messageSent', (msg) => {
    log('event', `messageSent: "${msg.text}" (id: ${msg.id.slice(0, 8)}...)`);
  });

  room.on('userJoined', (user) => {
    log('event', `userJoined: ${user.username} in #${name}`);
    if (currentRoom?.name === name) renderRoomUsers();
  });

  room.on('userLeft', (user) => {
    log('event', `userLeft: ${user.username} from #${name}`);
    if (currentRoom?.name === name) renderRoomUsers();
  });

  room.on('typing', ({ users }) => {
    if (users.length > 0) {
      log('event', `typing: ${users.map(u => u.username).join(', ')} in #${name}`);
    }
    if (currentRoom?.name === name) renderTypingIndicator(users);
  });

  room.on('replayStart', ({ count }) => {
    log('event', `replayStart: ${count} messages to replay in #${name}`);
  });

  room.on('replayEnd', ({ replayed }) => {
    log('event', `replayEnd: ${replayed} messages replayed in #${name}`);
    if (currentRoom?.name === name) renderMessages();
  });

  room.on('unreadChanged', () => {
    renderRoomList();
  });
}

function switchRoom(name) {
  if (currentRoom?.name === name) return;

  log('action', `joinRoom('${name}')`);
  currentRoom = chat.joinRoom(name);

  const titleEl = $('#room-title');
  if (titleEl) titleEl.textContent = `# ${name}`;

  renderRoomList();
  renderRoomUsers();
  renderMessages();
}

// ============================================================
// Connect / Disconnect
// ============================================================
async function doConnect(token, username, appName) {
  log('action', `new NoLagChat(token, { username: '${username}', appName: '${appName}' })`);

  chat = new NoLagChat(token, {
    username,
    appName,
    debug: true,
    url: 'wss://broker.dev.nolag.app/ws',
    rooms: availableRooms,
  });

  // Global events
  chat.on('connected', () => {
    connected = true;
    log('event', 'connected');
    renderApp();

    // Wire event listeners on all pre-subscribed rooms (once)
    for (const [name, room] of chat.rooms) {
      wireRoomEvents(name, room);
    }

    switchRoom('general');
  });

  chat.on('disconnected', (reason) => {
    connected = false;
    log('event', `disconnected: ${reason}`);
    renderApp();
  });

  chat.on('reconnected', () => {
    connected = true;
    log('event', 'reconnected — rooms auto-restored');
    renderApp();
  });

  chat.on('error', (err) => {
    log('error', `error: ${err.message}`);
  });

  chat.on('userOnline', (user) => {
    log('event', `userOnline: ${user.username} (${user.status})`);
    renderOnlineUsers();
  });

  chat.on('userOffline', (user) => {
    log('event', `userOffline: ${user.username}`);
    renderOnlineUsers();
  });

  chat.on('userUpdated', (user) => {
    log('event', `userUpdated: ${user.username} → ${user.status}`);
    renderOnlineUsers();
  });

  log('action', 'chat.connect()');
  await chat.connect();
}

function doDisconnect() {
  log('action', 'chat.disconnect()');
  chat?.disconnect();
  chat = null;
  currentRoom = null;
  connected = false;
  renderApp();
}

// ============================================================
// Event Listeners
// ============================================================
function attachConnectListeners() {
  const btn = $('#btn-connect');
  const tokenInput = $('#token-input');
  const usernameInput = $('#username-input');
  const appNameInput = $('#appname-input');

  btn?.addEventListener('click', async () => {
    const token = tokenInput?.value?.trim();
    const username = usernameInput?.value?.trim();
    const appName = appNameInput?.value?.trim() || 'chat-app';
    const errorEl = $('#connect-error');

    if (!token) {
      if (errorEl) { errorEl.textContent = 'Token is required'; errorEl.classList.remove('hidden'); }
      return;
    }
    if (!username) {
      if (errorEl) { errorEl.textContent = 'Username is required'; errorEl.classList.remove('hidden'); }
      return;
    }

    btn.textContent = 'Connecting...';
    btn.disabled = true;
    if (errorEl) errorEl.classList.add('hidden');

    try {
      await doConnect(token, username, appName);
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
  [tokenInput, usernameInput, appNameInput].forEach(input => {
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn?.click();
    });
  });
}

function attachChatListeners() {
  const input = $('#message-input');
  const sendBtn = $('#btn-send');
  const clearLogBtn = $('#btn-clear-log');

  sendBtn?.addEventListener('click', () => {
    const text = input?.value?.trim();
    if (!text || !currentRoom) return;
    log('action', `room.sendMessage('${text}')`);
    currentRoom.sendMessage(text);
    input.value = '';
    renderMessages();
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn?.click();
    }
  });

  input?.addEventListener('input', () => {
    if (currentRoom) {
      currentRoom.startTyping();
    }
  });

  clearLogBtn?.addEventListener('click', () => {
    eventLog.length = 0;
    renderEventLog();
  });

  input?.focus();
}

function attachStatusListeners() {
  $('#btn-status-online')?.addEventListener('click', () => {
    log('action', "chat.setStatus('online')");
    chat?.setStatus('online');
    renderOnlineUsers();
  });

  $('#btn-status-away')?.addEventListener('click', () => {
    log('action', "chat.setStatus('away')");
    chat?.setStatus('away');
    renderOnlineUsers();
  });

  $('#btn-status-busy')?.addEventListener('click', () => {
    log('action', "chat.setStatus('busy')");
    chat?.setStatus('busy');
    renderOnlineUsers();
  });

  $('#btn-disconnect')?.addEventListener('click', doDisconnect);
}

// ============================================================
// Boot
// ============================================================
renderApp();
