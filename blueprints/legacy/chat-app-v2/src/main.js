import { NoLagChat } from '@nolag/chat';
import './style.css';

const rooms = ['general', 'random', 'help'];

// --- State ---
let chat = null;
let currentRoom = null;
let connected = false;

// --- Room switching ---
function switchRoom(name) {
  if (currentRoom) {
    currentRoom.removeAllListeners();
    chat.leaveRoom(currentRoom.name);
  }

  currentRoom = chat.joinRoom(name);

  currentRoom.on('message', () => renderMessages());
  currentRoom.on('messageSent', () => renderMessages());
  currentRoom.on('userJoined', () => renderRoomUsers());
  currentRoom.on('userLeft', () => renderRoomUsers());
  currentRoom.on('typing', ({ users }) => renderTypingIndicator(users));
  currentRoom.on('replayEnd', () => renderMessages());

  renderRoomList();
  renderRoomUsers();
  renderMessages();
}

// --- Helpers ---
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --- Render: App shell ---
function renderApp() {
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="h-screen flex flex-col bg-base-200">
      <!-- Header -->
      <div class="navbar bg-base-100 shadow-lg flex-shrink-0">
        <div class="flex-1">
          <span class="text-xl font-bold px-4">NoLag Chat</span>
        </div>
        <div class="flex-none gap-2">
          <div class="badge ${connected ? 'badge-success' : 'badge-error'}">
            ${connected ? 'Connected' : 'Disconnected'}
          </div>
          ${connected ? `
            <div class="badge badge-info gap-1">
              ${chat.getOnlineUsers().length + 1} online
            </div>
          ` : ''}
        </div>
      </div>

      ${!connected ? `
        <div class="flex-1 flex items-center justify-center">
          <div class="card bg-base-100 shadow-xl w-96">
            <div class="card-body">
              <h2 class="card-title justify-center text-2xl">NoLag Chat</h2>
              <p class="text-center text-base-content/60 text-sm">
                Real-time chat with presence, typing indicators &amp; multi-room
              </p>
              <div class="divider text-xs">CONNECT</div>
              <div class="form-control">
                <label class="label"><span class="label-text">Access Token</span></label>
                <input id="nolag-token" type="text" placeholder="Paste your NoLag access token"
                       class="input input-bordered input-sm" />
              </div>
              <div class="form-control">
                <label class="label"><span class="label-text">Username</span></label>
                <input id="username-input" type="text" placeholder="Pick a display name"
                       class="input input-bordered input-sm"
                       value="User_${Math.random().toString(36).slice(2, 6)}" />
              </div>
              <div class="form-control">
                <label class="label"><span class="label-text">App Name</span></label>
                <input id="appname-input" type="text" placeholder="NoLag app name"
                       class="input input-bordered input-sm" value="chat-app" />
              </div>
              <div id="connect-error" class="alert alert-error text-sm hidden mt-2"></div>
              <div class="card-actions justify-center mt-4">
                <button id="btn-connect" class="btn btn-primary btn-wide">Connect</button>
              </div>
            </div>
          </div>
        </div>
      ` : `
        <div class="flex-1 flex overflow-hidden min-h-0">
          <!-- Room List Sidebar -->
          <div class="w-48 bg-base-100 border-r border-base-300 flex flex-col flex-shrink-0">
            <div class="p-3 border-b border-base-300">
              <h3 class="font-semibold text-sm">Rooms</h3>
            </div>
            <ul id="room-list" class="menu menu-sm flex-1"></ul>

            <div class="p-3 border-t border-base-300">
              <h3 class="font-semibold text-sm">Online</h3>
            </div>
            <ul id="online-users" class="menu menu-sm flex-1 overflow-y-auto"></ul>
          </div>

          <!-- Chat Area -->
          <div class="flex-1 flex flex-col min-w-0">
            <div id="messages-container" class="flex-1 overflow-y-auto p-4 space-y-2"></div>
            <div id="typing-indicator" class="px-4 h-6 text-xs text-base-content/50"></div>

            <!-- Message Input -->
            <div class="p-4 bg-base-100 border-t border-base-300 flex-shrink-0">
              <div class="flex gap-2">
                <input
                  type="text"
                  id="message-input"
                  placeholder="Type a message..."
                  class="input input-bordered flex-1"
                />
                <button id="send-btn" class="btn btn-primary">Send</button>
              </div>
            </div>
          </div>

          <!-- Room Users Sidebar -->
          <div class="w-48 bg-base-100 border-l border-base-300 flex-shrink-0 overflow-y-auto">
            <div class="p-3 border-b border-base-300">
              <h3 class="font-semibold text-sm" id="room-title">Room Users</h3>
            </div>
            <ul id="room-users" class="menu menu-sm"></ul>
          </div>
        </div>
      `}
    </div>
  `;

  if (!connected) {
    attachConnectListeners();
  } else {
    renderRoomList();
    renderOnlineUsers();
    renderRoomUsers();
    renderMessages();
    attachChatListeners();
  }
}

// --- Render: Room list ---
function renderRoomList() {
  const el = document.getElementById('room-list');
  if (!el) return;

  el.innerHTML = rooms.map(name => `
    <li>
      <a class="room-link ${currentRoom?.name === name ? 'active' : ''}" data-room="${name}">
        # ${escapeHtml(name)}
      </a>
    </li>
  `).join('');

  el.querySelectorAll('.room-link').forEach(link => {
    link.addEventListener('click', () => {
      switchRoom(link.dataset.room);
    });
  });
}

// --- Render: Online users (global) ---
function renderOnlineUsers() {
  const el = document.getElementById('online-users');
  if (!el) return;

  const users = chat.getOnlineUsers();
  const local = chat.localUser;

  el.innerHTML = [
    local ? `
      <li>
        <a class="flex items-center gap-2 bg-primary/10">
          <div class="avatar placeholder">
            <div class="bg-neutral text-neutral-content rounded-full w-6">
              <span class="text-xs">${escapeHtml(local.username.charAt(0).toUpperCase())}</span>
            </div>
          </div>
          <span class="truncate text-xs">${escapeHtml(local.username)}</span>
          <span class="badge badge-xs badge-primary">you</span>
        </a>
      </li>
    ` : '',
    ...users.map(user => `
      <li>
        <a class="flex items-center gap-2">
          <div class="avatar placeholder">
            <div class="bg-neutral text-neutral-content rounded-full w-6">
              <span class="text-xs">${escapeHtml(user.username.charAt(0).toUpperCase())}</span>
            </div>
          </div>
          <span class="truncate text-xs">${escapeHtml(user.username)}</span>
          <span class="w-2 h-2 rounded-full bg-success"></span>
        </a>
      </li>
    `),
  ].join('');
}

// --- Render: Room users ---
function renderRoomUsers() {
  const el = document.getElementById('room-users');
  const titleEl = document.getElementById('room-title');
  if (!el || !currentRoom) return;

  if (titleEl) titleEl.textContent = `# ${currentRoom.name}`;

  const users = currentRoom.getUsers();
  el.innerHTML = users.length === 0
    ? '<li class="px-3 py-2 text-xs text-base-content/50">No other users</li>'
    : users.map(user => `
      <li>
        <a class="flex items-center gap-2">
          <div class="avatar placeholder">
            <div class="bg-neutral text-neutral-content rounded-full w-6">
              <span class="text-xs">${escapeHtml(user.username.charAt(0).toUpperCase())}</span>
            </div>
          </div>
          <span class="truncate text-xs">${escapeHtml(user.username)}</span>
        </a>
      </li>
    `).join('');
}

// --- Render: Messages ---
function renderMessages() {
  const el = document.getElementById('messages-container');
  if (!el || !currentRoom) return;

  const messages = currentRoom.getMessages();
  const localUserId = chat.localUser?.userId;

  if (messages.length === 0) {
    el.innerHTML = `
      <div class="text-center text-base-content/50 py-8">
        No messages yet. Say hello!
      </div>
    `;
    return;
  }

  el.innerHTML = messages.map(msg => {
    const isOwn = msg.userId === localUserId;
    return `
      <div class="chat ${isOwn ? 'chat-end' : 'chat-start'}">
        <div class="chat-header">
          ${escapeHtml(msg.username)}
          <time class="text-xs opacity-50 ml-1">${formatTime(msg.timestamp)}</time>
          ${msg.isReplay ? '<span class="badge badge-xs badge-ghost">history</span>' : ''}
        </div>
        <div class="chat-bubble ${isOwn ? 'chat-bubble-primary' : 'chat-bubble-secondary'}">
          ${escapeHtml(msg.text)}
        </div>
      </div>
    `;
  }).join('');

  el.scrollTop = el.scrollHeight;
}

// --- Render: Typing indicator ---
function renderTypingIndicator(users) {
  const el = document.getElementById('typing-indicator');
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
    <span>${escapeHtml(text)}</span>
    <span class="inline-flex gap-0.5 ml-1">
      <span class="typing-dot w-1 h-1 rounded-full bg-base-content/50 inline-block"></span>
      <span class="typing-dot w-1 h-1 rounded-full bg-base-content/50 inline-block"></span>
      <span class="typing-dot w-1 h-1 rounded-full bg-base-content/50 inline-block"></span>
    </span>
  `;
}

// --- Chat event listeners ---
function attachChatListeners() {
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  sendBtn?.addEventListener('click', () => sendMessage());

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input?.addEventListener('input', () => {
    currentRoom?.startTyping();
  });

  input?.focus();
}

function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input?.value?.trim();
  if (!text || !currentRoom) return;

  currentRoom.sendMessage(text);
  input.value = '';
  renderMessages();
}

// --- Connect Panel Listeners ---
function attachConnectListeners() {
  const btn = document.getElementById('btn-connect');
  const tokenInput = document.getElementById('nolag-token');
  const usernameInput = document.getElementById('username-input');
  const appNameInput = document.getElementById('appname-input');

  btn?.addEventListener('click', async () => {
    const token = tokenInput?.value?.trim();
    const username = usernameInput?.value?.trim() || `User_${Math.random().toString(36).slice(2, 6)}`;
    const appName = appNameInput?.value?.trim() || 'chat-app';
    const errorEl = document.getElementById('connect-error');

    if (!token) {
      if (errorEl) { errorEl.textContent = 'Token is required'; errorEl.classList.remove('hidden'); }
      return;
    }
    if (errorEl) errorEl.classList.add('hidden');

    btn.textContent = 'Connecting...';
    btn.disabled = true;

    try {
      chat = new NoLagChat(token, { username, appName });

      chat.on('userOnline', () => renderOnlineUsers());
      chat.on('userOffline', () => renderOnlineUsers());
      chat.on('userUpdated', () => renderOnlineUsers());
      chat.on('connected', () => {
        connected = true;
        renderApp();
        switchRoom('general');
      });
      chat.on('disconnected', () => {
        connected = false;
        renderApp();
      });
      chat.on('reconnected', () => {
        connected = true;
        renderApp();
      });

      await chat.connect();
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

// --- Boot ---
renderApp();
