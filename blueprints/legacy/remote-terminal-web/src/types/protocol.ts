// Command types matching Go agent
export type CommandType =
  | 'shell'
  | 'ping'
  | 'info'
  | 'complete'
  | 'listdir'
  | 'upload'
  | 'download'
  | 'session_start'
  | 'session_input'
  | 'session_resize'
  | 'session_end'

// Command sent from client to agent
export interface Command {
  id: string
  type: CommandType
  payload: string
  data?: number[] // For file uploads (base64 encoded as byte array)
  timestamp: number
}

// Response from agent to client
export interface Response {
  commandId: string
  status: 'success' | 'error' | 'running'
  output: string
  error?: string
  exitCode: number
  data?: number[] // For file downloads
  completions?: string[] // For tab completion
}

// Device status broadcast by agent
export interface DeviceStatus {
  deviceId: string
  hostname: string
  os: string
  arch: string
  online: boolean
  timestamp: number
  workDir?: string
}

// Session output from agent
export interface SessionOutput {
  sessionId: string
  data: string // Base64 encoded output
  closed?: boolean
}

// App and topic constants
export const APP_NAME = 'remote-terminal'
export const TOPIC_COMMANDS = 'commands'
export const TOPIC_RESPONSES = 'responses'
export const TOPIC_STATUS = 'status'
export const TOPIC_SESSION_OUTPUT = 'session_output'

// Generate unique command ID (16 hex chars)
export function generateId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
