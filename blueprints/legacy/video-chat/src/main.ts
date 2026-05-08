import './style.css'
import NoLag, { WebRTCManager } from '@nolag/js-sdk'

// Broker URL — change to wss://broker.dev.nolag.app/ws for development
const BROKER_URL = 'wss://broker.nolag.app/ws'

// Configuration
const TOKEN = 'YOUR_ACCESS_TOKEN'
const APP_NAME = 'video-chat'
const ROOM_NAME = 'meeting'

// State
let client: ReturnType<typeof NoLag> | null = null
let webrtc: WebRTCManager | null = null
let localStream: MediaStream | null = null
let isVideoEnabled = true
let isAudioEnabled = true
let isInCall = false

// Remote peer streams
const peerStreams = new Map<string, MediaStream>()

// SVG Icons
const icons = {
  video: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>`,
  videoOff: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`,
  mic: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
  micOff: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
  phone: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  phoneOff: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/></svg>`,
}

function log(message: string) {
  console.log(`[VideoChat] ${message}`)
  const logEl = document.querySelector<HTMLDivElement>('#log')
  if (logEl) {
    const time = new Date().toLocaleTimeString()
    logEl.innerHTML = `<div>[${time}] ${message}</div>` + logEl.innerHTML
  }
}

function updateUI() {
  const status = document.querySelector<HTMLSpanElement>('#connection-status')
  const joinSection = document.querySelector<HTMLDivElement>('#join-section')
  const callSection = document.querySelector<HTMLDivElement>('#call-section')
  const controlBar = document.querySelector<HTMLDivElement>('#control-bar')

  if (status && client) {
    status.textContent = client.connected ? 'Connected' : 'Disconnected'
    status.className = `badge ${client.connected ? 'badge-success' : 'badge-error'}`
  }

  if (joinSection && callSection && controlBar) {
    if (isInCall) {
      joinSection.style.display = 'none'
      callSection.style.display = 'block'
      controlBar.style.display = 'flex'
    } else {
      joinSection.style.display = 'block'
      callSection.style.display = 'none'
      controlBar.style.display = 'none'
    }
  }

  // Update control buttons
  const videoBtn = document.querySelector<HTMLButtonElement>('#video-btn')
  const audioBtn = document.querySelector<HTMLButtonElement>('#audio-btn')

  if (videoBtn) {
    videoBtn.innerHTML = isVideoEnabled ? icons.video : icons.videoOff
    videoBtn.className = `control-btn ${isVideoEnabled ? 'active' : 'inactive'}`
  }

  if (audioBtn) {
    audioBtn.innerHTML = isAudioEnabled ? icons.mic : icons.micOff
    audioBtn.className = `control-btn ${isAudioEnabled ? 'active' : 'inactive'}`
  }

  // Update peer count
  const peerCount = document.querySelector<HTMLSpanElement>('#peer-count')
  if (peerCount) {
    peerCount.textContent = peerStreams.size.toString()
  }
}

function renderVideoGrid() {
  const grid = document.querySelector<HTMLDivElement>('#video-grid')
  if (!grid) return

  // Clear existing remote videos (keep structure for empty state)
  grid.innerHTML = ''

  if (peerStreams.size === 0) {
    grid.innerHTML = `
      <div class="video-container flex items-center justify-center">
        <div class="text-center text-gray-400">
          <p class="text-lg">Waiting for others to join...</p>
          <p class="text-sm mt-2">Share this room with others to start a video call</p>
        </div>
      </div>
    `
    return
  }

  // Add remote video elements
  for (const [actorId, stream] of peerStreams) {
    const container = document.createElement('div')
    container.className = 'video-container'
    container.id = `video-${actorId}`

    const video = document.createElement('video')
    video.autoplay = true
    video.playsInline = true
    video.srcObject = stream

    const label = document.createElement('div')
    label.className = 'video-label'
    label.textContent = `Peer ${actorId.substring(0, 8)}...`

    container.appendChild(video)
    container.appendChild(label)
    grid.appendChild(container)
  }
}

function updateLocalVideo() {
  const localVideo = document.querySelector<HTMLVideoElement>('#local-video')
  if (localVideo && localStream) {
    localVideo.srcObject = localStream
  }
}

async function getMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    })
    log('Got local media stream')
    updateLocalVideo()
    return true
  } catch (err) {
    log(`Failed to get media: ${err}`)
    alert('Could not access camera/microphone. Please grant permissions.')
    return false
  }
}

function toggleVideo() {
  if (!localStream) return

  isVideoEnabled = !isVideoEnabled
  localStream.getVideoTracks().forEach((track) => {
    track.enabled = isVideoEnabled
  })
  log(`Video ${isVideoEnabled ? 'enabled' : 'disabled'}`)
  updateUI()
}

function toggleAudio() {
  if (!localStream) return

  isAudioEnabled = !isAudioEnabled
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = isAudioEnabled
  })
  log(`Audio ${isAudioEnabled ? 'enabled' : 'disabled'}`)
  updateUI()
}

async function joinCall() {
  log('joinCall() called')

  const tokenInput = document.querySelector<HTMLInputElement>('#token-input')
  const roomInput = document.querySelector<HTMLInputElement>('#room-input')
  const token = tokenInput?.value?.trim()
  const roomName = roomInput?.value?.trim() || ROOM_NAME

  if (!token) {
    alert('Please enter your NoLag access token')
    return
  }

  // Get media first
  const hasMedia = await getMedia()
  if (!hasMedia) return

  // Connect to NoLag
  log('Creating NoLag client...')
  client = NoLag(token, { debug: true, url: BROKER_URL })

  client.on('connect', async () => {
    log('Connected to NoLag!')
    updateUI()

    // Initialize WebRTC manager
    log('Initializing WebRTC...')
    webrtc = new WebRTCManager(client!, {
      app: APP_NAME,
      room: roomName,
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    })

    // Set local stream
    if (localStream) {
      webrtc.setLocalStream(localStream)
    }

    // Handle peer events
    webrtc.on('peerConnected', (actorId: string, stream: MediaStream) => {
      log(`Peer connected: ${actorId}`)
      peerStreams.set(actorId, stream)
      renderVideoGrid()
      updateUI()
    })

    webrtc.on('peerDisconnected', (actorId: string) => {
      log(`Peer disconnected: ${actorId}`)
      peerStreams.delete(actorId)
      renderVideoGrid()
      updateUI()
    })

    webrtc.on('error', (error: Error) => {
      log(`WebRTC error: ${error.message}`)
    })

    // Start WebRTC
    try {
      await webrtc.start()
      log('WebRTC started, waiting for peers...')
      isInCall = true
      updateUI()
      renderVideoGrid()
    } catch (err) {
      log(`Failed to start WebRTC: ${err}`)
    }
  })

  client.on('disconnect', (reason: string) => {
    log(`Disconnected: ${reason}`)
    updateUI()
  })

  client.on('error', (error: Error) => {
    log(`Connection error: ${error.message}`)
  })

  try {
    await client.connect()
    log('client.connect() resolved')
  } catch (error) {
    log(`Failed to connect: ${error}`)
    alert('Failed to connect. Check your token.')
  }
}

function leaveCall() {
  log('Leaving call...')

  // Stop WebRTC
  if (webrtc) {
    webrtc.stop()
    webrtc = null
  }

  // Clear peer streams
  peerStreams.clear()

  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop())
    localStream = null
  }

  // Disconnect from NoLag
  if (client) {
    client.disconnect()
    client = null
  }

  isInCall = false
  isVideoEnabled = true
  isAudioEnabled = true

  updateUI()
  renderVideoGrid()
  log('Left call')
}

function init() {
  log('init() called')

  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <div class="min-h-screen">
      <!-- Header -->
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-bold text-white">Video Chat</h1>
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-400">Status:</span>
          <span id="connection-status" class="badge badge-error">Disconnected</span>
        </div>
      </div>

      <!-- Join Section -->
      <div id="join-section" class="flex flex-col items-center justify-center min-h-[60vh]">
        <div class="card bg-base-200 w-full max-w-md">
          <div class="card-body">
            <h2 class="card-title text-xl mb-4">Join a Video Call</h2>

            <div class="form-control w-full">
              <label class="label">
                <span class="label-text">Access Token</span>
              </label>
              <input
                type="text"
                id="token-input"
                placeholder="Enter your NoLag token"
                class="input input-bordered w-full"
                value="${TOKEN !== 'YOUR_ACCESS_TOKEN' ? TOKEN : ''}"
              />
            </div>

            <div class="form-control w-full mt-2">
              <label class="label">
                <span class="label-text">Room Name</span>
              </label>
              <input
                type="text"
                id="room-input"
                placeholder="Enter room name"
                class="input input-bordered w-full"
                value="${ROOM_NAME}"
              />
            </div>

            <button id="join-btn" class="btn btn-primary mt-4">
              ${icons.phone}
              <span class="ml-2">Join Call</span>
            </button>

            <p class="text-sm text-gray-500 mt-4 text-center">
              Open this page in multiple browsers/tabs to test video calling
            </p>
          </div>
        </div>
      </div>

      <!-- Call Section (hidden initially) -->
      <div id="call-section" style="display: none;">
        <!-- Room Info -->
        <div class="flex items-center gap-4 mb-4">
          <span class="text-gray-400">Room: <span class="text-white font-semibold" id="room-name">${ROOM_NAME}</span></span>
          <span class="text-gray-400">Peers: <span class="text-white font-semibold" id="peer-count">0</span></span>
        </div>

        <!-- Video Grid -->
        <div id="video-grid" class="video-grid">
          <div class="video-container flex items-center justify-center">
            <div class="text-center text-gray-400">
              <p class="text-lg">Waiting for others to join...</p>
              <p class="text-sm mt-2">Share this room with others to start a video call</p>
            </div>
          </div>
        </div>

        <!-- Local Video PIP -->
        <div class="local-video-pip">
          <video id="local-video" autoplay playsinline muted></video>
          <div class="video-label">You</div>
        </div>
      </div>

      <!-- Control Bar (hidden initially) -->
      <div id="control-bar" class="control-bar" style="display: none;">
        <button id="video-btn" class="control-btn active" title="Toggle Video">
          ${icons.video}
        </button>
        <button id="audio-btn" class="control-btn active" title="Toggle Audio">
          ${icons.mic}
        </button>
        <button id="leave-btn" class="control-btn end-call" title="Leave Call">
          ${icons.phoneOff}
        </button>
      </div>

      <!-- Log Section -->
      <div class="fixed bottom-20 left-4 w-80">
        <div class="collapse collapse-arrow bg-base-200">
          <input type="checkbox" />
          <div class="collapse-title text-sm font-medium">
            Debug Log
          </div>
          <div class="collapse-content">
            <div id="log" class="text-xs font-mono bg-base-300 rounded p-2 h-32 overflow-y-auto"></div>
          </div>
        </div>
      </div>
    </div>
  `

  // Expose functions globally
  ;(window as Window & typeof globalThis & { toggleVideo: typeof toggleVideo; toggleAudio: typeof toggleAudio; leaveCall: typeof leaveCall }).toggleVideo = toggleVideo
  ;(window as Window & typeof globalThis & { toggleVideo: typeof toggleVideo; toggleAudio: typeof toggleAudio; leaveCall: typeof leaveCall }).toggleAudio = toggleAudio
  ;(window as Window & typeof globalThis & { toggleVideo: typeof toggleVideo; toggleAudio: typeof toggleAudio; leaveCall: typeof leaveCall }).leaveCall = leaveCall

  // Event listeners
  document.querySelector<HTMLButtonElement>('#join-btn')?.addEventListener('click', joinCall)
  document.querySelector<HTMLButtonElement>('#video-btn')?.addEventListener('click', toggleVideo)
  document.querySelector<HTMLButtonElement>('#audio-btn')?.addEventListener('click', toggleAudio)
  document.querySelector<HTMLButtonElement>('#leave-btn')?.addEventListener('click', leaveCall)

  // Enter key in inputs
  document.querySelector<HTMLInputElement>('#token-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinCall()
  })
  document.querySelector<HTMLInputElement>('#room-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinCall()
  })

  log('Video chat initialized')
}

init()
