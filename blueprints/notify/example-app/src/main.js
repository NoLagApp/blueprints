import { NoLagNotify } from '@nolag/notify';

// --- State ---
let notify = null;
let channels = {}; // { channelName: channelInstance }
let notifications = []; // flat list of all notifications across channels
let eventLog = [];
const CHANNEL_NAMES = ['alerts', 'updates'];

// --- Utilities ---
function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function addLog(type, msg) {
  eventLog.unshift({ type, msg, time: ts() });
  if (eventLog.length > 100) eventLog.length = 100;
  renderLog();
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// --- Render helpers ---
function renderLog() {
  const el = document.getElementById('event-log');
  if (!el) return;
  el.innerHTML = eventLog
    .map(e => `<div class="log-entry ${e.type}"><span class="opacity-40">${e.time}</span> ${e.msg}</div>`)
    .join('');
}

function renderChannelList() {
  const el = document.getElementById('channel-list');
  if (!el) return;
  const counts = notify ? notify.getBadgeCounts() : {};
  el.innerHTML = CHANNEL_NAMES.map(name => {
    const unread = counts[name] ?? 0;
    const active = channels[name] ? 'border-primary bg-base-200' : 'border-base-300';
    return `
      <div class="flex items-center justify-between px-3 py-2 rounded border ${active} cursor-pointer hover:bg-base-200 transition-colors"
           onclick="window._selectChannel('${name}')">
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold capitalize">${name}</span>
          ${channels[name] ? '<span class="badge badge-xs badge-success">subbed</span>' : '<span class="badge badge-xs badge-ghost">idle</span>'}
        </div>
        ${unread > 0 ? `<span class="badge badge-sm badge-primary">${unread}</span>` : ''}
      </div>`;
  }).join('');
}

function renderNotifications() {
  const el = document.getElementById('notification-list');
  if (!el) return;
  const sorted = [...notifications].sort((a, b) => b.timestamp - a.timestamp);
  if (sorted.length === 0) {
    el.innerHTML = '<div class="text-base-content/40 text-sm text-center py-12">No notifications yet.<br>Subscribe to a channel and send a test.</div>';
    return;
  }
  el.innerHTML = sorted.map(n => {
    const unreadStyle = n.read ? 'opacity-60' : 'border-primary/40 bg-base-200';
    return `
      <div class="p-3 rounded border ${unreadStyle} cursor-pointer hover:bg-base-200 transition-colors fade-in"
           onclick="window._markRead('${n.channel}', '${n.id}')">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              ${!n.read ? '<span class="w-2 h-2 rounded-full bg-primary flex-shrink-0"></span>' : '<span class="w-2 h-2 rounded-full bg-base-300 flex-shrink-0"></span>'}
              <span class="font-semibold text-sm truncate">${escHtml(n.title)}</span>
              <span class="badge badge-xs badge-ghost flex-shrink-0">${escHtml(n.channel)}</span>
            </div>
            ${n.body ? `<div class="text-xs text-base-content/60 mt-1 ml-4">${escHtml(n.body)}</div>` : ''}
          </div>
          <span class="text-xs text-base-content/40 flex-shrink-0">${new Date(n.timestamp).toLocaleTimeString()}</span>
        </div>
      </div>`;
  }).join('');
}

function renderTotalUnread() {
  const el = document.getElementById('total-unread');
  if (!el) return;
  const total = notifications.filter(n => !n.read).length;
  el.textContent = total > 0 ? `${total} unread` : 'All read';
  el.className = total > 0 ? 'badge badge-primary' : 'badge badge-ghost';
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setConnected(connected) {
  const connectBtn = document.getElementById('btn-connect');
  const disconnectBtn = document.getElementById('btn-disconnect');
  const statusBadge = document.getElementById('status-badge');
  const tokenInput = document.getElementById('input-token');
  const appInput = document.getElementById('input-appname');
  if (connectBtn) connectBtn.disabled = connected;
  if (disconnectBtn) disconnectBtn.disabled = !connected;
  if (tokenInput) tokenInput.disabled = connected;
  if (appInput) appInput.disabled = connected;
  if (statusBadge) {
    statusBadge.textContent = connected ? 'Connected' : 'Disconnected';
    statusBadge.className = connected ? 'badge badge-success' : 'badge badge-ghost';
  }
  if (connected) renderChannelButtons(true);
  else renderChannelButtons(false);
}

function renderChannelButtons(enabled) {
  document.querySelectorAll('.btn-subscribe').forEach(b => b.disabled = !enabled);
  document.getElementById('btn-mark-all-read')?.setAttribute('disabled', !enabled ? 'true' : 'false');
  if (!enabled) document.getElementById('btn-mark-all-read')?.setAttribute('disabled', 'true');
  else document.getElementById('btn-mark-all-read')?.removeAttribute('disabled');
  document.getElementById('btn-send-test')?.setAttribute('disabled', !enabled ? 'true' : 'false');
  if (!enabled) document.getElementById('btn-send-test')?.setAttribute('disabled', 'true');
  else document.getElementById('btn-send-test')?.removeAttribute('disabled');
}

// --- SDK wiring ---
function wireMainEvents(instance) {
  instance.on('connected', () => {
    addLog('event', 'connected');
    setConnected(true);
    renderChannelList();
  });

  instance.on('disconnected', (reason) => {
    addLog('event', `disconnected — ${reason ?? 'unknown reason'}`);
    setConnected(false);
    channels = {};
    renderChannelList();
  });

  instance.on('reconnected', () => {
    addLog('event', 'reconnected');
    setConnected(true);
    renderChannelList();
  });

  instance.on('error', (err) => {
    addLog('error', `error — ${err?.message ?? err}`);
  });

  instance.on('notification', (notif) => {
    addLog('event', `notification (global) — ${escHtml(notif.title)} [${notif.channel ?? '?'}]`);
    upsertNotification(notif, false);
  });

  instance.on('badgeUpdated', (counts) => {
    addLog('event', `badgeUpdated — ${JSON.stringify(counts)}`);
    renderChannelList();
    renderTotalUnread();
  });
}

function wireChannelEvents(ch, name) {
  ch.on('notification', (notif) => {
    addLog('event', `[${name}] notification — ${escHtml(notif.title)}`);
    upsertNotification({ ...notif, channel: name }, false);
    renderChannelList();
    renderTotalUnread();
  });

  ch.on('read', (id) => {
    addLog('action', `[${name}] read — id:${id}`);
    markLocalRead(name, id);
    renderNotifications();
    renderTotalUnread();
    renderChannelList();
  });

  ch.on('readAll', () => {
    addLog('action', `[${name}] readAll`);
    notifications.forEach(n => { if (n.channel === name) n.read = true; });
    renderNotifications();
    renderTotalUnread();
    renderChannelList();
  });

  ch.on('replayStart', ({ count }) => {
    addLog('event', `[${name}] replayStart — ${count} messages incoming`);
  });

  ch.on('replayEnd', ({ replayed }) => {
    addLog('event', `[${name}] replayEnd — ${replayed} replayed`);
    renderNotifications();
    renderTotalUnread();
    renderChannelList();
  });
}

function upsertNotification(notif, read) {
  const idx = notifications.findIndex(n => n.id === notif.id && n.channel === notif.channel);
  if (idx >= 0) {
    notifications[idx] = { ...notifications[idx], ...notif, read: read ?? notifications[idx].read };
  } else {
    notifications.push({ ...notif, read: read ?? false, timestamp: notif.timestamp ?? Date.now() });
  }
  renderNotifications();
}

function markLocalRead(channel, id) {
  const n = notifications.find(n => n.id === id && n.channel === channel);
  if (n) n.read = true;
}

// --- Global handlers ---
window._connect = async function () {
  const token = document.getElementById('input-token')?.value?.trim();
  const appName = document.getElementById('input-appname')?.value?.trim() || 'notify-demo';
  if (!token) { addLog('error', 'Token is required'); return; }
  addLog('action', `connecting as "${appName}"...`);
  try {
    notify = new NoLagNotify(token, {
      appName,
      debug: true,
      channels: CHANNEL_NAMES
    });
    wireMainEvents(notify);
    await notify.connect();
  } catch (e) {
    addLog('error', `connect failed — ${e?.message ?? e}`);
  }
};

window._disconnect = async function () {
  if (!notify) return;
  addLog('action', 'disconnecting...');
  try {
    await notify.disconnect();
  } catch (e) {
    addLog('error', `disconnect failed — ${e?.message ?? e}`);
  }
  notify = null;
  channels = {};
  setConnected(false);
  renderChannelList();
};

window._toggleSubscribe = async function (name) {
  if (!notify) return;
  if (channels[name]) {
    addLog('action', `unsubscribing from ${name}...`);
    try {
      await notify.unsubscribe(name);
      delete channels[name];
      addLog('event', `unsubscribed from ${name}`);
    } catch (e) {
      addLog('error', `unsubscribe(${name}) failed — ${e?.message ?? e}`);
    }
  } else {
    addLog('action', `subscribing to ${name}...`);
    try {
      const ch = await notify.subscribe(name);
      channels[name] = ch;
      wireChannelEvents(ch, name);
      addLog('event', `subscribed to ${name} — ${ch.notifications?.length ?? 0} cached notifs, ${ch.unreadCount ?? 0} unread`);
      // Hydrate existing notifications from channel
      (ch.getNotifications?.() ?? ch.notifications ?? []).forEach(n => {
        upsertNotification({ ...n, channel: name }, false);
      });
    } catch (e) {
      addLog('error', `subscribe(${name}) failed — ${e?.message ?? e}`);
    }
  }
  renderChannelList();
  renderNotifications();
  renderTotalUnread();
};

window._selectChannel = function (name) {
  window._toggleSubscribe(name);
};

window._markRead = async function (channelName, id) {
  const ch = channels[channelName];
  if (!ch) { addLog('error', `not subscribed to ${channelName}`); return; }
  addLog('action', `markRead(${id}) on ${channelName}`);
  try {
    await ch.markRead(id);
  } catch (e) {
    addLog('error', `markRead failed — ${e?.message ?? e}`);
    // Optimistically mark anyway for demo
    markLocalRead(channelName, id);
    renderNotifications();
    renderTotalUnread();
    renderChannelList();
  }
};

window._markAllRead = async function () {
  if (!notify) return;
  addLog('action', 'markAllRead (global)');
  try {
    await notify.markAllRead();
    notifications.forEach(n => n.read = true);
    renderNotifications();
    renderTotalUnread();
    renderChannelList();
  } catch (e) {
    addLog('error', `markAllRead failed — ${e?.message ?? e}`);
    // Also try per-channel
    for (const [name, ch] of Object.entries(channels)) {
      try { await ch.markAllRead(); } catch (_) {}
    }
    notifications.forEach(n => n.read = true);
    renderNotifications();
    renderTotalUnread();
    renderChannelList();
  }
};

window._sendTest = async function () {
  const channelNames = Object.keys(channels);
  if (channelNames.length === 0) { addLog('error', 'Subscribe to a channel first'); return; }
  const targetName = channelNames[Math.floor(Math.random() * channelNames.length)];
  const ch = channels[targetName];
  const icons = ['bell', 'star', 'info', 'warning', 'check'];
  const titles = ['System alert', 'Deployment complete', 'New message', 'Scheduled maintenance', 'Action required'];
  const bodies = ['Please review the latest changes.', 'Version 2.1.0 is now live.', 'You have a new message.', 'Downtime scheduled for 02:00 UTC.', 'Review and approve the pending request.'];
  const idx = Math.floor(Math.random() * titles.length);
  const priorities = ['low', 'normal', 'high'];
  addLog('action', `send test notification to ${targetName}`);
  try {
    await ch.send(titles[idx], {
      body: bodies[idx],
      icon: icons[idx % icons.length],
      priority: priorities[idx % priorities.length]
    });
    addLog('event', `sent "${titles[idx]}" to ${targetName}`);
  } catch (e) {
    addLog('error', `send failed — ${e?.message ?? e}`);
    // For demo purposes add a local mock notification so UI remains useful
    const mockNotif = {
      id: genId(),
      channel: targetName,
      title: titles[idx],
      body: bodies[idx],
      icon: icons[idx % icons.length],
      priority: priorities[idx % priorities.length],
      timestamp: Date.now(),
      read: false
    };
    upsertNotification(mockNotif, false);
    renderChannelList();
    renderTotalUnread();
  }
};

// --- App shell ---
function renderApp() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="flex flex-col h-screen bg-base-100 text-base-content">
      <!-- Header -->
      <header class="flex items-center justify-between px-6 py-3 border-b border-base-300 bg-base-200">
        <div class="flex items-center gap-3">
          <span class="text-xl font-bold tracking-tight">@nolag/notify</span>
          <span class="badge badge-ghost text-xs">SDK Demo</span>
        </div>
        <span id="status-badge" class="badge badge-ghost">Disconnected</span>
      </header>

      <!-- Connect panel -->
      <div class="flex items-center gap-3 px-6 py-3 border-b border-base-300 bg-base-200/50">
        <input id="input-token" type="text" placeholder="Token" class="input input-sm input-bordered w-52 font-mono" />
        <input id="input-appname" type="text" placeholder="App name" value="notify-demo" class="input input-sm input-bordered w-36" />
        <button id="btn-connect" class="btn btn-sm btn-primary" onclick="window._connect()">Connect</button>
        <button id="btn-disconnect" class="btn btn-sm btn-ghost" onclick="window._disconnect()" disabled>Disconnect</button>
      </div>

      <!-- Main layout -->
      <div class="flex flex-1 min-h-0">
        <!-- Left sidebar: channels -->
        <aside class="w-52 flex-shrink-0 border-r border-base-300 bg-base-200/30 flex flex-col">
          <div class="px-4 py-3 border-b border-base-300">
            <span class="text-xs font-bold uppercase tracking-widest text-base-content/50">Channels</span>
          </div>
          <div id="channel-list" class="flex flex-col gap-2 p-3 overflow-y-auto flex-1">
            ${CHANNEL_NAMES.map(name => `
              <div class="flex items-center justify-between px-3 py-2 rounded border border-base-300 cursor-pointer hover:bg-base-200 transition-colors"
                   onclick="window._selectChannel('${name}')">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold capitalize">${name}</span>
                  <span class="badge badge-xs badge-ghost">idle</span>
                </div>
              </div>`).join('')}
          </div>
          <div class="p-3 border-t border-base-300">
            ${CHANNEL_NAMES.map(name => `
              <button class="btn btn-xs btn-subscribe w-full mb-1" disabled
                      onclick="window._toggleSubscribe('${name}')">
                Subscribe ${name}
              </button>`).join('')}
          </div>
        </aside>

        <!-- Center: notification inbox -->
        <main class="flex-1 flex flex-col min-w-0">
          <div class="flex items-center justify-between px-5 py-3 border-b border-base-300">
            <div class="flex items-center gap-3">
              <span class="font-semibold">Inbox</span>
              <span id="total-unread" class="badge badge-ghost">All read</span>
            </div>
            <div class="flex gap-2">
              <button id="btn-send-test" class="btn btn-xs btn-outline" onclick="window._sendTest()" disabled>Send Test</button>
              <button id="btn-mark-all-read" class="btn btn-xs btn-primary" onclick="window._markAllRead()" disabled>Mark All Read</button>
            </div>
          </div>
          <div id="notification-list" class="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            <div class="text-base-content/40 text-sm text-center py-12">No notifications yet.<br>Subscribe to a channel and send a test.</div>
          </div>
        </main>

        <!-- Right sidebar: event log -->
        <aside class="w-64 flex-shrink-0 border-l border-base-300 bg-base-200/30 flex flex-col">
          <div class="px-4 py-3 border-b border-base-300 flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-widest text-base-content/50">Event Log</span>
            <button class="btn btn-xs btn-ghost" onclick="window._clearLog()">Clear</button>
          </div>
          <div id="event-log" class="flex-1 overflow-y-auto py-2"></div>
        </aside>
      </div>
    </div>`;
}

window._clearLog = function () {
  eventLog = [];
  renderLog();
};

// Boot
renderApp();
addLog('action', 'Demo ready — enter a token and connect');
