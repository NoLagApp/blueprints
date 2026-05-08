import './style.css'
import NoLag, { type MessageMeta } from '@nolag/js-sdk'

const TOKEN = 'YOUR_ACCESS_TOKEN'
const APP_NAME = 'light-switch'
const ROOM_NAME = 'main'
const TOPIC = 'button-state'
// Broker URL — change to wss://broker.dev.nolag.app/ws for development
const BROKER_URL = 'wss://broker.nolag.app/ws'

interface ButtonState {
  isOn: boolean
}

let client: ReturnType<typeof NoLag> | null = null
let isOn = false
let isWorkerMode = false
let messageCount = 0
let ackCount = 0

function updateUI() {
  const button = document.querySelector<HTMLButtonElement>('#light-button')
  const status = document.querySelector<HTMLSpanElement>('#connection-status')
  const indicator = document.querySelector<HTMLDivElement>('#light-indicator')
  const workerModeToggle = document.querySelector<HTMLInputElement>('#worker-mode-toggle')
  const msgCountEl = document.querySelector<HTMLSpanElement>('#msg-count')
  const workerSection = document.querySelector<HTMLDivElement>('#worker-section')
  const modeLabel = document.querySelector<HTMLSpanElement>('#mode-label')

  if (button) {
    button.textContent = isOn ? 'Turn Off' : 'Turn On'
    button.className = `btn btn-lg ${isOn ? 'btn-warning' : 'btn-primary'}`
  }

  if (indicator) {
    indicator.className = `w-32 h-32 rounded-full transition-all duration-300 ${
      isOn
        ? 'bg-yellow-300 shadow-[0_0_60px_20px_rgba(253,224,71,0.8)]'
        : 'bg-gray-700'
    }`
  }

  if (status && client) {
    status.textContent = client.connected ? 'Connected' : 'Disconnected'
    status.className = `badge ${client.connected ? 'badge-success' : 'badge-error'}`
  }

  if (workerModeToggle) {
    workerModeToggle.checked = isWorkerMode
  }

  if (msgCountEl) {
    msgCountEl.textContent = messageCount.toString()
  }

  const ackCountEl = document.querySelector<HTMLSpanElement>('#ack-count')
  if (ackCountEl) {
    ackCountEl.textContent = ackCount.toString()
  }

  if (modeLabel) {
    modeLabel.textContent = isWorkerMode ? 'Load Balanced (round-robin)' : 'Broadcast (all tabs)'
    modeLabel.className = `badge ${isWorkerMode ? 'badge-warning' : 'badge-info'}`
  }

  if (workerSection) {
    workerSection.style.display = client?.connected ? 'block' : 'none'
  }
}

async function toggleLight() {
  console.log('[LightSwitch] toggleLight() called, connected:', client?.connected)

  if (!client?.connected) {
    console.error('[LightSwitch] Not connected, cannot toggle')
    return
  }

  isOn = !isOn
  console.log('[LightSwitch] New state:', isOn)
  updateUI()

  const room = client.setApp(APP_NAME).setRoom(ROOM_NAME)
  const state: ButtonState = { isOn }

  // Emit with echo: false so we don't receive our own message back
  console.log('[LightSwitch] Emitting state:', state, 'to topic:', `${APP_NAME}/${ROOM_NAME}/${TOPIC}`)
  room.emit(TOPIC, state, { echo: false })
  console.log('[LightSwitch] State emitted')
}

async function init() {
  console.log('[LightSwitch] init() called')
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <div class="flex flex-col items-center gap-8">
      <h1 class="text-4xl font-bold">Light Switch</h1>

      <div class="flex items-center gap-2">
        <span class="text-sm">Status:</span>
        <span id="connection-status" class="badge badge-error">Disconnected</span>
      </div>

      <div id="light-indicator" class="w-32 h-32 rounded-full bg-gray-700 transition-all duration-300"></div>

      <button id="light-button" class="btn btn-lg btn-primary" onclick="window.toggleLight()">
        Turn On
      </button>

      <p class="text-sm text-gray-500 mt-4">
        Open this page in multiple tabs to see realtime sync!
      </p>

      <div class="form-control w-full max-w-xs">
        <label class="label">
          <span class="label-text">Access Token</span>
        </label>
        <input
          type="text"
          id="token-input"
          placeholder="Enter your NoLag token"
          class="input input-bordered w-full max-w-xs"
          value="${TOKEN !== 'YOUR_ACCESS_TOKEN' ? TOKEN : ''}"
        />
        <label class="label mt-2">
          <span class="label-text">Project ID (for debug logging)</span>
        </label>
        <input
          type="text"
          id="project-id-input"
          placeholder="Enter project ID for event logging"
          class="input input-bordered w-full max-w-xs"
        />
        <button id="connect-btn" class="btn btn-success mt-2">Connect</button>
      </div>

      <!-- Load Balancing Demo -->
      <div id="worker-section" class="card bg-base-200 w-full max-w-md mt-4" style="display: none;">
        <div class="card-body">
          <h2 class="card-title text-lg">Load Balancing Demo</h2>

          <div class="flex items-center gap-2 mb-2">
            <span class="text-sm">Mode:</span>
            <span id="mode-label" class="badge badge-info">Broadcast (all tabs)</span>
          </div>

          <p class="text-sm text-gray-500">
            <strong>Broadcast:</strong> All tabs receive every light toggle.<br/>
            <strong>Load Balanced:</strong> Only ONE tab receives each toggle (round-robin).
          </p>

          <div class="form-control">
            <label class="label cursor-pointer">
              <span class="label-text">Enable Load Balancing</span>
              <input type="checkbox" id="worker-mode-toggle" class="toggle toggle-warning" />
            </label>
          </div>

          <div class="text-sm mt-2">
            Messages received: <span id="msg-count" class="font-bold">0</span>
            <span class="mx-2">|</span>
            ACKs sent: <span id="ack-count" class="font-bold text-success">0</span>
          </div>

          <div id="work-log" class="mt-2 text-xs font-mono bg-base-300 rounded p-2 h-24 overflow-y-auto"></div>
        </div>
      </div>
    </div>
  `

  // Expose toggle function globally for onclick
  ;(window as any).toggleLight = toggleLight

  const connectBtn = document.querySelector<HTMLButtonElement>('#connect-btn')
  console.log('[LightSwitch] Connect button found:', connectBtn)

  connectBtn?.addEventListener('click', () => {
    console.log('[LightSwitch] Connect button clicked')
    connect()
  })

  document.querySelector<HTMLInputElement>('#token-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      console.log('[LightSwitch] Enter pressed in token input')
      connect()
    }
  })

  console.log('[LightSwitch] Event listeners attached')
}

function logMessage(message: string) {
  const log = document.querySelector<HTMLDivElement>('#work-log')
  if (log) {
    const time = new Date().toLocaleTimeString()
    log.innerHTML = `<div>[${time}] ${message}</div>` + log.innerHTML
  }
}

function toggleWorkerMode() {
  if (!client?.connected) return

  isWorkerMode = !isWorkerMode
  const room = client.setApp(APP_NAME).setRoom(ROOM_NAME)

  // Just send subscribe with desired mode - Kraken handles the switch internally
  if (isWorkerMode) {
    // Subscribe with load balancing - only ONE tab receives each message
    room.subscribe(TOPIC, { loadBalance: true, loadBalanceGroup: 'light-workers' })
    logMessage('Switched to LOAD BALANCED mode')
    console.log('[LightSwitch] Switched to load balancing')
  } else {
    // Subscribe normally - all tabs receive all messages
    room.subscribe(TOPIC)
    logMessage('Switched to BROADCAST mode')
    console.log('[LightSwitch] Switched to broadcast')
  }

  updateUI()
}

async function connect() {
  console.log('[LightSwitch] connect() called')

  const tokenInput = document.querySelector<HTMLInputElement>('#token-input')
  const token = tokenInput?.value?.trim()
  console.log('[LightSwitch] Token value:', token ? `${token.substring(0, 10)}...` : 'empty')

  if (!token) {
    alert('Please enter your NoLag access token')
    return
  }

  // Get optional projectId for debug logging
  const projectIdInput = document.querySelector<HTMLInputElement>('#project-id-input')
  const projectId = projectIdInput?.value?.trim() || undefined
  console.log('[LightSwitch] Project ID for debug logging:', projectId || '(not set)')

  if (client) {
    console.log('[LightSwitch] Disconnecting existing client')
    client.disconnect()
  }

  // Reset state
  isWorkerMode = false
  messageCount = 0
  ackCount = 0

  console.log('[LightSwitch] Creating NoLag client with URL:', BROKER_URL)
  client = NoLag(token, { debug: true, url: BROKER_URL, projectId })
  console.log('[LightSwitch] NoLag client created:', client)

  client.on('connect', () => {
    console.log('[LightSwitch] Connected to NoLag!')
    updateUI()

    const room = client!.setApp(APP_NAME).setRoom(ROOM_NAME)

    // Subscribe with the current mode (preserves load balance if previously enabled)
    console.log('[LightSwitch] Subscribing to topic:', `${APP_NAME}/${ROOM_NAME}/${TOPIC}`, 'isWorkerMode:', isWorkerMode)
    if (isWorkerMode) {
      room.subscribe(TOPIC, { loadBalance: true, loadBalanceGroup: 'light-workers' })
    } else {
      room.subscribe(TOPIC)
    }

    room.on(TOPIC, (data: unknown, meta: MessageMeta) => {
      const state = data as ButtonState
      console.log('[LightSwitch] Received state:', state, 'meta:', meta)
      isOn = state.isOn
      messageCount++

      // Track ACKs - SDK auto-ACKs messages with msgId
      if (meta.msgId) {
        ackCount++
        logMessage(`Light ${state.isOn ? 'ON' : 'OFF'} (ACK: ${meta.msgId.substring(0, 8)}...)`)
        console.log('[LightSwitch] Auto-ACK sent for msgId:', meta.msgId)
      } else {
        logMessage(`Light ${state.isOn ? 'ON' : 'OFF'}`)
      }

      updateUI()
    })

    // Set up worker mode toggle
    const workerToggle = document.querySelector<HTMLInputElement>('#worker-mode-toggle')
    workerToggle?.addEventListener('change', toggleWorkerMode)

    logMessage(`Connected - ${isWorkerMode ? 'Load Balanced' : 'Broadcast'} mode`)
  })

  client.on('disconnect', (reason: string) => {
    console.log('[LightSwitch] Disconnected:', reason)
    updateUI()
  })

  client.on('error', (error: Error) => {
    console.error('[LightSwitch] Error:', error)
    logMessage(`Error: ${error.message}`)
  })

  client.on('reconnect', () => {
    console.log('[LightSwitch] Reconnecting...')
  })

  try {
    console.log('[LightSwitch] Calling client.connect()...')
    await client.connect()
    console.log('[LightSwitch] client.connect() resolved successfully')
  } catch (error) {
    console.error('[LightSwitch] Failed to connect:', error)
    alert('Failed to connect. Check your token.')
  }
}

init()
