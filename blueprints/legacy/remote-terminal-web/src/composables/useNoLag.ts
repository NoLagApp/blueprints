import { ref, shallowRef, computed, onUnmounted } from 'vue'
import { NoLag } from '@nolag/js-sdk'
import type { RoomContext, MessageMeta } from '@nolag/js-sdk'
import {
  APP_NAME,
  TOPIC_COMMANDS,
  TOPIC_RESPONSES,
  TOPIC_STATUS,
  TOPIC_SESSION_OUTPUT,
  generateId,
  type Command,
  type Response,
  type DeviceStatus,
  type CommandType,
  type SessionOutput,
} from '../types/protocol'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export function useNoLag() {
  // Connection state
  const status = ref<ConnectionStatus>('disconnected')
  const error = ref<string | null>(null)
  const deviceId = ref<string>('')
  const deviceStatus = ref<DeviceStatus | null>(null)

  // Session state
  const sessionId = ref<string | null>(null)
  const sessionActive = ref(false)

  // Callback for session output
  let onSessionOutput: ((data: string) => void) | null = null
  let onSessionClose: (() => void) | null = null

  // NoLag client and room
  const client = shallowRef<ReturnType<typeof NoLag> | null>(null)
  const room = shallowRef<RoomContext | null>(null)

  // Pending command responses
  const pendingCommands = new Map<string, {
    resolve: (response: Response) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()

  // Connect to NoLag broker
  async function connect(token: string, device: string, brokerUrl?: string) {
    if (client.value) {
      disconnect()
    }

    deviceId.value = device
    status.value = 'connecting'
    error.value = null

    try {
      const nolagClient = NoLag(token, {
        url: brokerUrl || 'wss://broker.nolag.app/ws',
        reconnect: true,
        reconnectInterval: 5000,
        debug: false,
      })

      // Set up event handlers
      nolagClient.on('connect', () => {
        status.value = 'connected'
        error.value = null
        setupSubscriptions()
      })

      nolagClient.on('disconnect', (reason: string) => {
        status.value = 'disconnected'
        error.value = reason
      })

      nolagClient.on('reconnect', () => {
        status.value = 'reconnecting'
      })

      nolagClient.on('error', (err: Error) => {
        error.value = err.message
      })

      client.value = nolagClient
      await nolagClient.connect()
    } catch (err) {
      status.value = 'disconnected'
      error.value = err instanceof Error ? err.message : 'Connection failed'
      throw err
    }
  }

  // Set up subscriptions to device topics
  function setupSubscriptions() {
    if (!client.value || !deviceId.value) return

    room.value = client.value.setApp(APP_NAME).setRoom(deviceId.value)

    // Subscribe to responses
    room.value.subscribe(TOPIC_RESPONSES)
    room.value.on(TOPIC_RESPONSES, handleResponse)

    // Subscribe to status updates
    room.value.subscribe(TOPIC_STATUS)
    room.value.on(TOPIC_STATUS, handleStatus)

    // Subscribe to session output
    room.value.subscribe(TOPIC_SESSION_OUTPUT)
    room.value.on(TOPIC_SESSION_OUTPUT, handleSessionOutput)
  }

  // Handle session output from agent
  function handleSessionOutput(data: unknown, _meta: MessageMeta) {
    const rawOutput = data as Record<string, unknown>

    // Normalize PascalCase to camelCase
    const output: SessionOutput = {
      sessionId: (rawOutput.SessionID || rawOutput.sessionId) as string,
      data: (rawOutput.Data || rawOutput.data || '') as string,
      closed: (rawOutput.Closed || rawOutput.closed) as boolean | undefined,
    }

    // Only process if this is our session
    if (output.sessionId !== sessionId.value) return

    if (output.closed) {
      sessionActive.value = false
      sessionId.value = null
      if (onSessionClose) {
        onSessionClose()
      }
    } else if (output.data && onSessionOutput) {
      // Decode base64 to UTF-8 string
      try {
        const binaryString = atob(output.data)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }
        const decoded = new TextDecoder('utf-8').decode(bytes)
        onSessionOutput(decoded)
      } catch (e) {
        console.error('Failed to decode session output:', e)
      }
    }
  }

  // Handle response from agent
  function handleResponse(data: unknown, _meta: MessageMeta) {
    const rawResponse = data as Record<string, unknown>

    // Go msgpack uses PascalCase field names, normalize to camelCase
    const response: Response = {
      commandId: (rawResponse.CommandID || rawResponse.commandId) as string,
      status: (rawResponse.Status || rawResponse.status) as 'success' | 'error' | 'running',
      output: (rawResponse.Output || rawResponse.output || '') as string,
      error: (rawResponse.Error || rawResponse.error) as string | undefined,
      exitCode: (rawResponse.ExitCode || rawResponse.exitCode || 0) as number,
      data: (rawResponse.Data || rawResponse.data) as number[] | undefined,
      completions: (rawResponse.Completions || rawResponse.completions) as string[] | undefined,
    }

    const pending = pendingCommands.get(response.commandId)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingCommands.delete(response.commandId)
      pending.resolve(response)
    }
  }

  // Handle status broadcast from agent
  function handleStatus(data: unknown, _meta: MessageMeta) {
    deviceStatus.value = data as DeviceStatus
  }

  // Send command to agent and wait for response
  async function sendCommand(
    type: CommandType,
    payload: string = '',
    timeoutMs: number = 30000
  ): Promise<Response> {
    if (!room.value) {
      throw new Error('Not connected to device')
    }

    const command: Command = {
      id: generateId(),
      type,
      payload,
      timestamp: Math.floor(Date.now() / 1000),
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(command.id)
        reject(new Error('Command timeout'))
      }, timeoutMs)

      pendingCommands.set(command.id, { resolve, reject, timeout })

      room.value!.emit(TOPIC_COMMANDS, command, (err) => {
        if (err) {
          clearTimeout(timeout)
          pendingCommands.delete(command.id)
          reject(err)
        }
      })
    })
  }

  // Start an interactive PTY session
  async function startSession(
    cols: number,
    rows: number,
    outputCallback: (data: string) => void,
    closeCallback: () => void
  ): Promise<string> {
    if (!room.value) {
      throw new Error('Not connected to device')
    }

    if (sessionActive.value) {
      throw new Error('Session already active')
    }

    // Set up callbacks
    onSessionOutput = outputCallback
    onSessionClose = closeCallback

    // Start session
    const payload = JSON.stringify({ cols, rows })
    const response = await sendCommand('session_start', payload)

    if (response.status === 'error') {
      throw new Error(response.error || 'Failed to start session')
    }

    // Session ID is returned in output
    sessionId.value = response.output
    sessionActive.value = true

    return sessionId.value
  }

  // Send input to the PTY session
  function sendSessionInput(data: string) {
    if (!room.value || !sessionId.value) return

    // Properly encode UTF-8 string to base64
    const encoder = new TextEncoder()
    const bytes = encoder.encode(data)
    const binaryString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
    const base64Data = btoa(binaryString)

    const payload = JSON.stringify({
      sessionId: sessionId.value,
      data: base64Data,
    })

    const command: Command = {
      id: generateId(),
      type: 'session_input',
      payload,
      timestamp: Math.floor(Date.now() / 1000),
    }

    room.value.emit(TOPIC_COMMANDS, command)
  }

  // Resize the PTY session
  function resizeSession(cols: number, rows: number) {
    if (!room.value || !sessionId.value) return

    const payload = JSON.stringify({
      sessionId: sessionId.value,
      cols,
      rows,
    })

    const command: Command = {
      id: generateId(),
      type: 'session_resize',
      payload,
      timestamp: Math.floor(Date.now() / 1000),
    }

    room.value.emit(TOPIC_COMMANDS, command)
  }

  // End the PTY session
  function endSession() {
    if (!room.value || !sessionId.value) return

    const payload = JSON.stringify({
      sessionId: sessionId.value,
    })

    const command: Command = {
      id: generateId(),
      type: 'session_end',
      payload,
      timestamp: Math.floor(Date.now() / 1000),
    }

    room.value.emit(TOPIC_COMMANDS, command)

    // Clean up local state
    sessionActive.value = false
    sessionId.value = null
    onSessionOutput = null
    onSessionClose = null
  }

  // Disconnect from broker
  function disconnect() {
    // End any active session
    if (sessionActive.value) {
      endSession()
    }

    // Clear pending commands
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Disconnected'))
      pendingCommands.delete(id)
    }

    if (client.value) {
      client.value.disconnect()
      client.value = null
    }

    room.value = null
    status.value = 'disconnected'
    deviceStatus.value = null
  }

  // Cleanup on unmount
  onUnmounted(() => {
    disconnect()
  })

  return {
    // State
    status,
    error,
    deviceId,
    deviceStatus,
    isConnected: computed(() => status.value === 'connected'),

    // Session state
    sessionId,
    sessionActive,

    // Actions
    connect,
    disconnect,
    sendCommand,

    // Session actions
    startSession,
    sendSessionInput,
    resizeSession,
    endSession,
  }
}
