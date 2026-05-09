import { NoLagSignal } from '@nolag/signal';

// ── State ────────────────────────────────────────────────────────────────────
let signal = null;
let room = null;
let localStream = null;
let isVideoEnabled = true;
let isAudioEnabled = true;
let isInCall = false;

// peerId → { peer, pc (RTCPeerConnection), stream (remote MediaStream) }
const peerConnections = new Map();

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ── Logging ──────────────────────────────────────────────────────────────────
function addLog(msg, type = 'event') {
  const log = document.getElementById('event-log');
  if (!log) return;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const el = document.createElement('div');
  el.className = `log-entry ${type} fade-in`;
  el.textContent = `${time} ${msg}`;
  log.prepend(el);
  if (log.children.length > 80) log.lastChild.remove();
}

// ── WebRTC helpers ───────────────────────────────────────────────────────────
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Send ICE candidates to remote peer
  pc.onicecandidate = (e) => {
    if (e.candidate && room) {
      room.sendIceCandidate(peerId, e.candidate.toJSON());
    }
  };

  pc.oniceconnectionstatechange = () => {
    addLog(`ICE state [${shortId(peerId)}]: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      removePeer(peerId);
    }
  };

  // Receive remote tracks
  pc.ontrack = (e) => {
    addLog(`Track received from ${shortId(peerId)}: ${e.track.kind}`);
    const entry = peerConnections.get(peerId);
    if (entry) {
      entry.stream = e.streams[0] || new MediaStream([e.track]);
      renderVideoGrid();
    }
  };

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  return pc;
}

async function handleOffer(fromPeerId, offer) {
  addLog(`Received offer from ${shortId(fromPeerId)}`, 'event');
  let entry = peerConnections.get(fromPeerId);

  if (entry && entry.pc.signalingState === 'have-local-offer') {
    // Glare: we both sent offers. Use peer ID comparison to decide who wins.
    // The peer with the "lower" ID accepts the other's offer (rolls back their own).
    const localId = signal.localPeer?.peerId || '';
    if (localId > fromPeerId) {
      // We win — ignore their offer, they should accept ours
      addLog(`Glare: ignoring offer from ${shortId(fromPeerId)} (we take priority)`, 'action');
      return;
    }
    // They win — rollback our offer and accept theirs
    addLog(`Glare: rolling back our offer, accepting ${shortId(fromPeerId)}'s`, 'action');
    await entry.pc.setLocalDescription({ type: 'rollback' });
  }

  if (!entry) {
    const pc = createPeerConnection(fromPeerId);
    entry = { pc, stream: null };
    peerConnections.set(fromPeerId, entry);
  }

  await entry.pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await entry.pc.createAnswer();
  await entry.pc.setLocalDescription(answer);
  room.sendAnswer(fromPeerId, answer);
  addLog(`Sent answer to ${shortId(fromPeerId)}`, 'action');
  updatePeerCount();
  renderVideoGrid();
}

async function handleAnswer(fromPeerId, answer) {
  addLog(`Received answer from ${shortId(fromPeerId)}`, 'event');
  const entry = peerConnections.get(fromPeerId);
  if (!entry) return;
  if (entry.pc.signalingState !== 'have-local-offer') {
    addLog(`Ignoring answer — not expecting one (state: ${entry.pc.signalingState})`, 'action');
    return;
  }
  await entry.pc.setRemoteDescription(new RTCSessionDescription(answer));
}

async function handleIceCandidate(fromPeerId, candidate) {
  const entry = peerConnections.get(fromPeerId);
  if (entry) {
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      addLog(`ICE candidate error: ${err.message}`, 'error');
    }
  }
}

function handleBye(fromPeerId) {
  addLog(`${shortId(fromPeerId)} hung up`, 'event');
  removePeer(fromPeerId);
}

async function callPeer(peerId) {
  // Don't create a duplicate connection or offer if we already have one
  // (the other peer may have sent us an offer first)
  const existing = peerConnections.get(peerId);
  if (existing) return;

  addLog(`Calling ${shortId(peerId)}...`, 'action');
  const pc = createPeerConnection(peerId);
  peerConnections.set(peerId, { pc, stream: null });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  room.sendOffer(peerId, offer);
  addLog(`Sent offer to ${shortId(peerId)}`, 'action');
  updatePeerCount();
}

function removePeer(peerId) {
  const entry = peerConnections.get(peerId);
  if (entry) {
    entry.pc.close();
    peerConnections.delete(peerId);
    renderVideoGrid();
    updatePeerCount();
  }
}

// ── Media controls ───────────────────────────────────────────────────────────
async function getMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    addLog('Media devices API not available — not a secure context (use localhost or HTTPS)', 'error');
    return false;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    addLog('Camera and microphone acquired', 'event');
    updateLocalVideo();
    return true;
  } catch (err) {
    addLog(`Media error: ${err.message}`, 'error');
    return false;
  }
}

function toggleVideo() {
  if (!localStream) return;
  isVideoEnabled = !isVideoEnabled;
  localStream.getVideoTracks().forEach((t) => (t.enabled = isVideoEnabled));
  addLog(`Video ${isVideoEnabled ? 'on' : 'off'}`, 'action');
  updateControlButtons();
}

function toggleAudio() {
  if (!localStream) return;
  isAudioEnabled = !isAudioEnabled;
  localStream.getAudioTracks().forEach((t) => (t.enabled = isAudioEnabled));
  addLog(`Mic ${isAudioEnabled ? 'on' : 'off'}`, 'action');
  updateControlButtons();
}

// ── Connect & join ───────────────────────────────────────────────────────────
async function joinCall() {
  const token = document.getElementById('inp-token').value.trim();
  const roomName = document.getElementById('inp-room').value.trim() || 'call-room';

  if (!token) { addLog('Token is required', 'error'); return; }

  const errEl = document.getElementById('join-error');
  const hasMedia = await getMedia();
  if (!hasMedia) {
    addLog('No camera/mic access — connecting without media (signaling only)', 'action');
    if (errEl) { errEl.textContent = 'No camera/mic — connecting in signaling-only mode. Use localhost or HTTPS for video.'; errEl.classList.remove('hidden'); }
  } else {
    if (errEl) errEl.classList.add('hidden');
  }

  addLog('Connecting to NoLag...', 'action');

  const appName = document.getElementById('inp-appname').value.trim() || 'signal-demo';

  signal = new NoLagSignal(token, {
    appName,
    debug: false,
    url: 'wss://broker.dev.nolag.app/ws',
  });

  signal.on('connected', async () => {
    addLog('Connected', 'event');
    updateConnectionStatus(true);

    // Join the call room
    room = await signal.joinRoom(roomName);
    document.getElementById('room-name').textContent = roomName;
    addLog(`Joined room "${roomName}"`, 'event');

    // Handle incoming signals
    room.on('signal', (message) => {
      switch (message.type) {
        case 'offer':
          handleOffer(message.fromPeerId, message.payload);
          break;
        case 'answer':
          handleAnswer(message.fromPeerId, message.payload);
          break;
        case 'ice-candidate':
          handleIceCandidate(message.fromPeerId, message.payload);
          break;
        case 'bye':
          handleBye(message.fromPeerId);
          break;
      }
    });

    // When a new peer joins, only the peer with the higher ID initiates
    // This prevents both peers from sending offers simultaneously (glare)
    room.on('peerJoined', (peer) => {
      addLog(`${shortId(peer.peerId)} joined the room`, 'event');
      updatePeerCount();
      const localId = signal.localPeer?.peerId || '';
      if (localId > peer.peerId) {
        callPeer(peer.peerId);
      }
    });

    room.on('peerLeft', (peer) => {
      addLog(`${shortId(peer.peerId)} left the room`, 'event');
      removePeer(peer.peerId);
    });

    // Call any peers already in the room (only if we have the higher ID)
    const existingPeers = room.getPeers();
    const localId = signal.localPeer?.peerId || '';
    for (const peer of existingPeers) {
      addLog(`Found existing peer: ${shortId(peer.peerId)}`, 'event');
      if (localId > peer.peerId) {
        callPeer(peer.peerId);
      }
    }

    isInCall = true;
    showCallUI();
    updatePeerCount();
  });

  signal.on('disconnected', (reason) => {
    addLog(`Disconnected: ${reason}`, 'error');
    updateConnectionStatus(false);
  });

  signal.on('reconnected', () => {
    addLog('Reconnected', 'event');
    updateConnectionStatus(true);
  });

  signal.on('error', (err) => {
    addLog(`Error: ${err?.message ?? err}`, 'error');
  });

  signal.on('peerOnline', (peer) => {
    addLog(`${shortId(peer.peerId)} is online`, 'event');
  });

  signal.on('peerOffline', (peer) => {
    addLog(`${shortId(peer.peerId)} went offline`, 'event');
  });

  await signal.connect();
}

function leaveCall() {
  addLog('Leaving call...', 'action');

  // Send bye to all peers and close connections
  for (const [peerId, entry] of peerConnections) {
    if (room) room.sendBye(peerId);
    entry.pc.close();
  }
  peerConnections.clear();

  // Stop local media
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  // Leave room and disconnect
  if (signal) {
    signal.disconnect();
    signal = null;
    room = null;
  }

  isInCall = false;
  isVideoEnabled = true;
  isAudioEnabled = true;

  showJoinUI();
  addLog('Left call', 'action');
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function shortId(id) {
  return id ? String(id).slice(0, 8) : '?';
}

function updateConnectionStatus(connected) {
  const badge = document.getElementById('status-badge');
  if (!badge) return;
  badge.textContent = connected ? 'Connected' : 'Disconnected';
  badge.className = `badge badge-sm ${connected ? 'badge-success' : 'badge-error'}`;
}

function updatePeerCount() {
  const el = document.getElementById('peer-count');
  if (el) el.textContent = peerConnections.size;
}

function updateLocalVideo() {
  const video = document.getElementById('local-video');
  if (video && localStream) {
    video.srcObject = localStream;
  }
}

function updateControlButtons() {
  const videoBtn = document.getElementById('btn-video');
  const audioBtn = document.getElementById('btn-audio');

  if (videoBtn) {
    videoBtn.className = `control-btn ${isVideoEnabled ? 'active' : 'inactive'}`;
    videoBtn.title = isVideoEnabled ? 'Turn off camera' : 'Turn on camera';
    videoBtn.innerHTML = isVideoEnabled ? ICONS.video : ICONS.videoOff;
  }
  if (audioBtn) {
    audioBtn.className = `control-btn ${isAudioEnabled ? 'active' : 'inactive'}`;
    audioBtn.title = isAudioEnabled ? 'Mute mic' : 'Unmute mic';
    audioBtn.innerHTML = isAudioEnabled ? ICONS.mic : ICONS.micOff;
  }
}

function renderVideoGrid() {
  const grid = document.getElementById('video-grid');
  if (!grid) return;

  grid.innerHTML = '';

  if (peerConnections.size === 0) {
    grid.innerHTML = `
      <div class="flex items-center justify-center h-full">
        <div class="text-center text-base-content/30">
          <p class="text-lg font-semibold">Waiting for others to join...</p>
          <p class="text-sm mt-2">Open this page in another tab with the same room name</p>
        </div>
      </div>`;
    return;
  }

  for (const [peerId, entry] of peerConnections) {
    const container = document.createElement('div');
    container.className = 'video-tile';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (entry.stream) {
      video.srcObject = entry.stream;
    }

    const label = document.createElement('div');
    label.className = 'video-tile-label';
    label.textContent = `Peer ${shortId(peerId)}`;

    container.appendChild(video);
    container.appendChild(label);
    grid.appendChild(container);
  }

  updatePeerCount();
}

function showCallUI() {
  document.getElementById('join-section').classList.add('hidden');
  document.getElementById('call-section').classList.remove('hidden');
  document.getElementById('control-bar').classList.remove('hidden');
  updateControlButtons();
}

function showJoinUI() {
  document.getElementById('join-section').classList.remove('hidden');
  document.getElementById('call-section').classList.add('hidden');
  document.getElementById('control-bar').classList.add('hidden');
  updateConnectionStatus(false);
}

// ── Icons ────────────────────────────────────────────────────────────────────
const ICONS = {
  video: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>',
  videoOff: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z"/><line x1="2" x2="22" y1="2" y2="22"/></svg>',
  mic: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  micOff: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  phoneOff: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/></svg>',
  phone: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
};

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('app').innerHTML = `
  <div class="flex flex-col h-screen bg-base-100 text-base-content">

    <!-- Header -->
    <header class="flex items-center gap-3 px-5 py-3 bg-base-200 border-b border-base-300 shrink-0">
      <span class="text-xl font-bold text-primary">@nolag/signal</span>
      <span class="text-base-content/40 text-sm">Video Call Demo</span>
      <div class="ml-auto flex items-center gap-3">
        <span id="status-badge" class="badge badge-sm badge-error">Disconnected</span>
      </div>
    </header>

    <!-- Join section -->
    <div id="join-section" class="flex-1 flex items-center justify-center p-6">
      <div class="card bg-base-200 border border-base-300 w-full max-w-md">
        <div class="card-body gap-4">
          <h2 class="card-title text-xl">Join a Video Call</h2>
          <p class="text-sm text-base-content/50">Uses @nolag/signal for WebRTC signaling — peer-to-peer video with NoLag as the relay.</p>

          <div class="form-control">
            <label class="label py-0.5"><span class="label-text text-xs">Token</span></label>
            <input id="inp-token" type="text" placeholder="Your NoLag token" class="input input-bordered w-full" />
          </div>
          <div class="form-control">
            <label class="label py-0.5"><span class="label-text text-xs">App Slug</span></label>
            <input id="inp-appname" type="text" placeholder="signal-demo" value="my-nolag-signal-sdk-demo" class="input input-bordered w-full" />
          </div>
          <div class="form-control">
            <label class="label py-0.5"><span class="label-text text-xs">Room Name</span></label>
            <input id="inp-room" type="text" placeholder="call-room" value="call-room" class="input input-bordered w-full" />
          </div>

          <div id="join-error" class="text-error text-sm hidden"></div>

          <button id="btn-join" class="btn btn-primary mt-2 gap-2">
            ${ICONS.phone} Join Call
          </button>

          <p class="text-xs text-base-content/30 text-center mt-2">
            Open this page in another tab to test a video call between two peers.
          </p>
        </div>
      </div>
    </div>

    <!-- Call section (hidden until in call) -->
    <div id="call-section" class="flex-1 flex flex-col hidden">

      <!-- Room info bar -->
      <div class="flex items-center gap-4 px-5 py-2 bg-base-200/50 border-b border-base-300 shrink-0">
        <span class="text-sm text-base-content/50">Room: <span id="room-name" class="text-base-content font-semibold">—</span></span>
        <span class="text-sm text-base-content/50">Peers: <span id="peer-count" class="text-base-content font-semibold">0</span></span>
        <button class="btn btn-xs btn-ghost ml-auto" onclick="document.getElementById('log-panel').classList.toggle('hidden')">Toggle Log</button>
      </div>

      <!-- Video area -->
      <div class="flex flex-1 min-h-0">

        <!-- Video grid -->
        <div id="video-grid" class="flex-1 grid grid-cols-1 gap-3 p-4 overflow-y-auto" style="grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));">
          <div class="flex items-center justify-center h-full">
            <div class="text-center text-base-content/30">
              <p class="text-lg font-semibold">Waiting for others to join...</p>
              <p class="text-sm mt-2">Open this page in another tab with the same room name</p>
            </div>
          </div>
        </div>

        <!-- Event log (collapsible) -->
        <aside id="log-panel" class="w-64 shrink-0 flex flex-col bg-base-200 border-l border-base-300 hidden">
          <div class="px-3 py-2 border-b border-base-300 flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-widest text-base-content/40">Event Log</span>
            <button class="btn btn-xs btn-ghost" onclick="document.getElementById('event-log').innerHTML=''">Clear</button>
          </div>
          <div id="event-log" class="flex-1 overflow-y-auto py-1"></div>
        </aside>
      </div>

      <!-- Local video PIP -->
      <div class="fixed bottom-24 right-4 w-48 rounded-lg overflow-hidden shadow-xl border border-base-300 z-50 bg-base-300">
        <video id="local-video" autoplay playsinline muted class="w-full aspect-video object-cover" style="transform: scaleX(-1);"></video>
        <div class="absolute bottom-1 left-2 text-xs text-white bg-black/50 rounded px-1.5 py-0.5">You</div>
      </div>
    </div>

    <!-- Control bar (hidden until in call) -->
    <div id="control-bar" class="hidden fixed bottom-4 left-1/2 -translate-x-1/2 flex gap-3 px-6 py-3 bg-black/70 rounded-full z-50">
      <button id="btn-video" class="control-btn active" title="Toggle camera">
        ${ICONS.video}
      </button>
      <button id="btn-audio" class="control-btn active" title="Toggle mic">
        ${ICONS.mic}
      </button>
      <button id="btn-leave" class="control-btn end-call" title="Leave call">
        ${ICONS.phoneOff}
      </button>
    </div>
  </div>
  `;

  // Bind events
  document.getElementById('btn-join').addEventListener('click', joinCall);
  document.getElementById('inp-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinCall();
  });
  document.getElementById('inp-room').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinCall();
  });
  document.getElementById('btn-video')?.addEventListener('click', toggleVideo);
  document.getElementById('btn-audio')?.addEventListener('click', toggleAudio);
  document.getElementById('btn-leave')?.addEventListener('click', leaveCall);

  addLog('Ready — enter a token and room name to start a call', 'action');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
render();
