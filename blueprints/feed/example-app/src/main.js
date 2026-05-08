import { NoLagFeed } from '@nolag/feed';

// ─── State ────────────────────────────────────────────────────────────────────
let sdk = null;
let activeChannel = null;
// postId -> { post, comments: [], showComments: bool }
const postsMap = new Map();

// ─── Render shell ─────────────────────────────────────────────────────────────
function render() {
  document.getElementById('app').innerHTML = `
    <div class="flex flex-col h-screen bg-base-100 text-base-content">

      <!-- Header -->
      <header class="flex items-center gap-3 px-5 py-3 bg-base-200 border-b border-base-300 shrink-0">
        <span class="text-xl font-bold text-primary">NoLag</span>
        <span class="text-base-content/40">/</span>
        <span class="font-semibold">feed SDK Demo</span>
        <div id="conn-badge" class="ml-auto badge badge-error badge-sm">disconnected</div>
      </header>

      <!-- Connect Panel -->
      <div id="connect-panel" class="p-4 bg-base-200 border-b border-base-300 shrink-0">
        <div class="flex flex-wrap gap-2 items-end">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Token</span></label>
            <input id="inp-token" type="password" placeholder="NoLag token" class="input input-bordered input-sm w-52" />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Username</span></label>
            <input id="inp-username" type="text" placeholder="username" class="input input-bordered input-sm w-36" />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">App Name</span></label>
            <input id="inp-appname" type="text" placeholder="my-feed-app" class="input input-bordered input-sm w-40" />
          </div>
          <button id="btn-connect" class="btn btn-primary btn-sm">Connect</button>
          <button id="btn-disconnect" class="btn btn-ghost btn-sm hidden">Disconnect</button>
        </div>
      </div>

      <!-- Main layout -->
      <div class="flex flex-1 overflow-hidden">

        <!-- Left Sidebar: channels + online users -->
        <aside class="w-56 flex flex-col bg-base-200 border-r border-base-300 shrink-0 overflow-y-auto">
          <div class="p-3 border-b border-base-300">
            <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-2">Channels</p>
            <div id="channel-list" class="flex flex-col gap-1">
              <span class="text-xs text-base-content/30">Not connected</span>
            </div>
          </div>
          <div class="p-3 flex-1">
            <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-2">Online Users</p>
            <div id="online-users-list" class="flex flex-col gap-1">
              <span class="text-xs text-base-content/30">None</span>
            </div>
          </div>
        </aside>

        <!-- Center: feed -->
        <main class="flex flex-col flex-1 overflow-hidden">

          <!-- Channel header -->
          <div class="px-4 py-2 bg-base-200 border-b border-base-300 shrink-0 flex items-center gap-2">
            <span id="channel-label" class="font-semibold text-base-content/50">No channel joined</span>
            <span id="unread-badge" class="badge badge-primary badge-sm hidden"></span>
            <button id="btn-mark-read" class="btn btn-ghost btn-xs ml-auto hidden">Mark read</button>
          </div>

          <!-- New post form -->
          <div id="new-post-form" class="px-4 py-3 bg-base-200 border-b border-base-300 shrink-0 hidden">
            <textarea id="inp-post-content" rows="2" placeholder="What's on your mind?" class="textarea textarea-bordered w-full text-sm mb-2"></textarea>
            <button id="btn-create-post" class="btn btn-primary btn-sm">Post</button>
          </div>

          <!-- Posts feed -->
          <div id="posts-feed" class="flex-1 overflow-y-auto p-4 flex flex-col gap-4"></div>

        </main>

        <!-- Right Sidebar: event log -->
        <aside class="w-64 flex flex-col bg-base-200 border-l border-base-300 shrink-0">
          <div class="px-3 py-2 border-b border-base-300 flex items-center justify-between">
            <span class="text-xs font-semibold text-base-content/50 uppercase tracking-wider">Event Log</span>
            <button id="btn-clear-log" class="btn btn-ghost btn-xs text-xs">Clear</button>
          </div>
          <div id="event-log" class="flex-1 overflow-y-auto py-1"></div>
        </aside>

      </div>
    </div>
  `;
  bindConnectPanel();
}

// ─── Log ──────────────────────────────────────────────────────────────────────
function log(msg, type = 'event') {
  const el = document.getElementById('event-log');
  if (!el) return;
  const now = new Date().toLocaleTimeString('en', { hour12: false });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type} fade-in`;
  entry.textContent = `${now} ${msg}`;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

function setConnected(yes) {
  const badge = document.getElementById('conn-badge');
  if (!badge) return;
  badge.className = `ml-auto badge badge-sm ${yes ? 'badge-success' : 'badge-error'}`;
  badge.textContent = yes ? 'connected' : 'disconnected';
}

// ─── Bindings ─────────────────────────────────────────────────────────────────
function bindConnectPanel() {
  document.getElementById('btn-connect').addEventListener('click', handleConnect);
  document.getElementById('btn-disconnect').addEventListener('click', handleDisconnect);
  document.getElementById('btn-clear-log').addEventListener('click', () => { document.getElementById('event-log').innerHTML = ''; });
  document.getElementById('btn-create-post').addEventListener('click', handleCreatePost);
  document.getElementById('btn-mark-read').addEventListener('click', handleMarkRead);
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function handleConnect() {
  const token = document.getElementById('inp-token').value.trim();
  const username = document.getElementById('inp-username').value.trim() || 'anonymous';
  const appName = document.getElementById('inp-appname').value.trim() || 'feed-demo';

  sdk = new NoLagFeed(token, { username, appName, debug: true, channels: ['main-feed'] });

  sdk.on('connected', async () => {
    log('connected', 'event');
    setConnected(true);
    document.getElementById('btn-connect').classList.add('hidden');
    document.getElementById('btn-disconnect').classList.remove('hidden');
    renderChannelList();
    refreshOnlineUsers();
  });

  sdk.on('disconnected', reason => {
    log(`disconnected: ${reason ?? ''}`, 'event');
    setConnected(false);
    document.getElementById('btn-connect').classList.remove('hidden');
    document.getElementById('btn-disconnect').classList.add('hidden');
  });

  sdk.on('reconnected', () => { log('reconnected', 'event'); setConnected(true); });

  sdk.on('error', err => { log(`error: ${err?.message ?? err}`, 'error'); });

  sdk.on('userOnline', user => {
    log(`userOnline: ${user.username}`, 'event');
    refreshOnlineUsers();
  });

  sdk.on('userOffline', user => {
    log(`userOffline: ${user.username}`, 'event');
    refreshOnlineUsers();
  });

  log('connecting...', 'action');
  await sdk.connect();
}

async function handleDisconnect() {
  if (!sdk) return;
  log('disconnecting...', 'action');
  await sdk.disconnect();
  sdk = null;
  activeChannel = null;
  postsMap.clear();
  render();
}

// ─── Online users ─────────────────────────────────────────────────────────────
async function refreshOnlineUsers() {
  if (!sdk || !sdk.connected) return;
  try {
    const users = await sdk.getOnlineUsers();
    renderOnlineUsers(users);
  } catch (e) { /* ignore */ }
}

function renderOnlineUsers(users) {
  const el = document.getElementById('online-users-list');
  if (!el) return;
  if (!users || users.length === 0) {
    el.innerHTML = '<span class="text-xs text-base-content/30">None</span>';
    return;
  }
  el.innerHTML = users.map(u => `
    <div class="flex items-center gap-2 py-0.5">
      <div class="w-5 h-5 rounded-full bg-secondary flex items-center justify-center text-secondary-content text-xs font-bold">
        ${(u.username || '?')[0].toUpperCase()}
      </div>
      <span class="text-xs truncate">${u.username || u.id}</span>
    </div>
  `).join('');
}

// ─── Channels ─────────────────────────────────────────────────────────────────
function renderChannelList() {
  const el = document.getElementById('channel-list');
  if (!el || !sdk) return;
  const channels = sdk.channels || [];
  if (!channels.length) {
    el.innerHTML = '<span class="text-xs text-base-content/30">None</span>';
    return;
  }
  el.innerHTML = channels.map(ch => {
    const unread = ch.unreadCount || 0;
    const isActive = activeChannel && activeChannel.name === ch.name;
    return `
      <button class="ch-btn flex items-center justify-between w-full px-2 py-1.5 rounded text-sm text-left
        ${isActive ? 'bg-primary text-primary-content' : 'hover:bg-base-300'}"
        data-channel="${ch.name}">
        <span class="truncate">${ch.name}</span>
        ${unread > 0 ? `<span class="badge badge-primary badge-xs">${unread}</span>` : ''}
      </button>
    `;
  }).join('');
  el.querySelectorAll('.ch-btn').forEach(btn => {
    btn.addEventListener('click', () => handleJoinChannel(btn.dataset.channel));
  });
}

async function handleJoinChannel(name) {
  if (!sdk) return;
  if (activeChannel && activeChannel.name === name) return;

  // Leave previous
  if (activeChannel) {
    log(`leaveChannel: ${activeChannel.name}`, 'action');
    await sdk.leaveChannel(activeChannel.name);
  }

  log(`joinChannel: ${name}`, 'action');
  const channel = await sdk.joinChannel(name);
  activeChannel = channel;
  postsMap.clear();

  // Channel events
  channel.on('postCreated', post => {
    log(`postCreated: ${post.id}`, 'event');
    upsertPost(post);
    renderPostsFeed();
  });

  channel.on('postSent', post => {
    log(`postSent: ${post.id}`, 'event');
    upsertPost(post);
    renderPostsFeed();
  });

  channel.on('postLiked', ({ postId, userId, likeCount }) => {
    log(`postLiked: ${postId} by ${userId} (${likeCount})`, 'event');
    const entry = postsMap.get(postId);
    if (entry) { entry.post.likeCount = likeCount; renderPostsFeed(); }
  });

  channel.on('postUnliked', ({ postId, userId, likeCount }) => {
    log(`postUnliked: ${postId} by ${userId} (${likeCount})`, 'event');
    const entry = postsMap.get(postId);
    if (entry) { entry.post.likeCount = likeCount; renderPostsFeed(); }
  });

  channel.on('commentAdded', comment => {
    log(`commentAdded: ${comment.postId}`, 'event');
    const entry = postsMap.get(comment.postId);
    if (entry) {
      entry.comments.push(comment);
      renderPostsFeed();
    }
  });

  channel.on('commentSent', comment => {
    log(`commentSent: ${comment.postId}`, 'event');
    const entry = postsMap.get(comment.postId);
    if (entry) {
      entry.comments.push(comment);
      renderPostsFeed();
    }
  });

  channel.on('subscriberJoined', user => {
    log(`subscriberJoined: ${user.username}`, 'event');
    refreshOnlineUsers();
  });

  channel.on('subscriberLeft', user => {
    log(`subscriberLeft: ${user.username}`, 'event');
    refreshOnlineUsers();
  });

  channel.on('replayStart', ({ count }) => { log(`replayStart: ${count} messages incoming`, 'event'); });
  channel.on('replayEnd', ({ replayed }) => { log(`replayEnd: ${replayed} messages replayed`, 'event'); });

  channel.on('unreadChanged', ({ channel: ch, count }) => {
    log(`unreadChanged: ${ch} = ${count}`, 'event');
    updateUnreadBadge(count);
    renderChannelList();
  });

  // Load existing posts
  try {
    const posts = await channel.getPosts();
    if (posts && posts.length) {
      for (const post of posts) {
        postsMap.set(post.id, { post, comments: [], showComments: false });
        // Try to load comments per post
        try {
          const comments = await channel.getComments(post.id);
          if (comments) postsMap.get(post.id).comments = comments;
        } catch (e) { /* no comments */ }
      }
    }
  } catch (e) { /* no posts */ }

  updateChannelHeader(name);
  renderChannelList();
  renderPostsFeed();
  document.getElementById('new-post-form').classList.remove('hidden');
  document.getElementById('btn-mark-read').classList.remove('hidden');
  updateUnreadBadge(channel.unreadCount || 0);
}

function updateChannelHeader(name) {
  const el = document.getElementById('channel-label');
  if (el) el.textContent = `# ${name}`;
}

function updateUnreadBadge(count) {
  const badge = document.getElementById('unread-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = `${count} unread`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─── Posts ────────────────────────────────────────────────────────────────────
function upsertPost(post) {
  if (!postsMap.has(post.id)) {
    postsMap.set(post.id, { post, comments: [], showComments: false });
  } else {
    postsMap.get(post.id).post = post;
  }
}

function renderPostsFeed() {
  const feed = document.getElementById('posts-feed');
  if (!feed) return;
  const entries = Array.from(postsMap.values()).reverse();
  if (entries.length === 0) {
    feed.innerHTML = '<p class="text-center text-base-content/30 text-sm mt-8">No posts yet. Be the first to post!</p>';
    return;
  }
  feed.innerHTML = entries.map(({ post, comments, showComments }) => {
    const initial = (post.username || '?')[0].toUpperCase();
    const ts = post.createdAt ? new Date(post.createdAt).toLocaleString() : '';
    const likes = post.likeCount ?? 0;
    return `
      <div class="card bg-base-200 border border-base-300 fade-in" data-post-id="${post.id}">
        <div class="card-body p-4">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-secondary-content font-bold text-sm shrink-0">${initial}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline gap-2 mb-1">
                <span class="font-semibold text-sm">${escHtml(post.username || 'anonymous')}</span>
                <span class="text-xs text-base-content/40">${ts}</span>
              </div>
              <p class="text-sm text-base-content/90 whitespace-pre-wrap">${escHtml(post.content || '')}</p>
              <div class="flex items-center gap-3 mt-3">
                <button class="btn-like btn btn-ghost btn-xs gap-1" data-post="${post.id}">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" /></svg>
                  <span>${likes}</span>
                </button>
                <button class="btn-toggle-comments btn btn-ghost btn-xs gap-1" data-post="${post.id}">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                  <span>${comments.length}</span>
                </button>
              </div>
              ${showComments ? renderCommentsSection(post.id, comments) : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Bind post interactions
  feed.querySelectorAll('.btn-like').forEach(btn => {
    btn.addEventListener('click', () => handleLikePost(btn.dataset.post));
  });
  feed.querySelectorAll('.btn-toggle-comments').forEach(btn => {
    btn.addEventListener('click', () => toggleComments(btn.dataset.post));
  });
  feed.querySelectorAll('.btn-add-comment').forEach(btn => {
    btn.addEventListener('click', () => handleAddComment(btn.dataset.post));
  });
  feed.querySelectorAll('.inp-comment-text').forEach(inp => {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAddComment(inp.dataset.post);
      }
    });
  });
}

function renderCommentsSection(postId, comments) {
  return `
    <div class="mt-3 border-t border-base-300 pt-3 flex flex-col gap-2">
      ${comments.map(c => `
        <div class="flex items-start gap-2">
          <div class="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-secondary-content text-xs font-bold shrink-0">
            ${(c.username || '?')[0].toUpperCase()}
          </div>
          <div>
            <span class="font-semibold text-xs">${escHtml(c.username || 'anonymous')}</span>
            <p class="text-xs text-base-content/80">${escHtml(c.text || c.content || '')}</p>
          </div>
        </div>
      `).join('')}
      <div class="flex gap-2 mt-1">
        <input type="text" placeholder="Add a comment..." class="inp-comment-text input input-bordered input-xs flex-1" data-post="${postId}" />
        <button class="btn-add-comment btn btn-primary btn-xs" data-post="${postId}">Reply</button>
      </div>
    </div>
  `;
}

function toggleComments(postId) {
  const entry = postsMap.get(postId);
  if (!entry) return;
  entry.showComments = !entry.showComments;
  renderPostsFeed();
}

async function handleCreatePost() {
  if (!activeChannel) return;
  const inp = document.getElementById('inp-post-content');
  const content = inp.value.trim();
  if (!content) return;
  inp.value = '';
  log(`createPost: ${content.slice(0, 40)}`, 'action');
  await activeChannel.createPost({ content });
}

async function handleLikePost(postId) {
  if (!activeChannel) return;
  const entry = postsMap.get(postId);
  if (!entry) return;
  // Toggle: like if not liked, unlike if liked
  const localUser = sdk?.localUser;
  const liked = entry.post.likedBy && localUser && entry.post.likedBy.includes(localUser.id);
  if (liked) {
    log(`unlikePost: ${postId}`, 'action');
    await activeChannel.unlikePost(postId);
  } else {
    log(`likePost: ${postId}`, 'action');
    await activeChannel.likePost(postId);
  }
}

async function handleAddComment(postId) {
  if (!activeChannel) return;
  const inp = document.querySelector(`.inp-comment-text[data-post="${postId}"]`);
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  log(`addComment: ${postId} - ${text.slice(0, 40)}`, 'action');
  await activeChannel.addComment(postId, text);
}

async function handleMarkRead() {
  if (!activeChannel) return;
  log('markRead', 'action');
  await activeChannel.markRead();
  updateUnreadBadge(0);
  renderChannelList();
}

// ─── Util ─────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
render();
