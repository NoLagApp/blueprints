import { randomBytes } from 'crypto'

// Command types
export const CMD_TYPE_SHELL = 'shell'
export const CMD_TYPE_INFO = 'info'
export const CMD_TYPE_PING = 'ping'
export const CMD_TYPE_KILL = 'kill'
export const CMD_TYPE_COMPLETE = 'complete'
export const CMD_TYPE_UPLOAD = 'upload'
export const CMD_TYPE_DOWNLOAD = 'download'
export const CMD_TYPE_LISTDIR = 'listdir'
export const CMD_TYPE_SESSION_START = 'session_start'
export const CMD_TYPE_SESSION_INPUT = 'session_input'
export const CMD_TYPE_SESSION_RESIZE = 'session_resize'
export const CMD_TYPE_SESSION_END = 'session_end'

// Topics
export const APP_NAME = 'remote-terminal'
export const TOPIC_COMMANDS = 'commands'
export const TOPIC_RESPONSES = 'responses'
export const TOPIC_STATUS = 'status'
export const TOPIC_DISCOVERY = 'discovery'
export const TOPIC_SESSION_OUTPUT = 'session_output'

// Command from client to agent
export interface Command {
  id: string
  type: string
  payload: string
  data?: number[]
  timestamp: number
}

// Response from agent to client
export interface Response {
  commandId: string
  status: 'success' | 'error' | 'running'
  output: string
  error?: string
  exitCode: number
  data?: number[]
  completions?: string[]
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

// Session payloads
export interface SessionStartPayload {
  cols: number
  rows: number
}

export interface SessionInputPayload {
  sessionId: string
  data: string // Base64 encoded
}

export interface SessionResizePayload {
  sessionId: string
  cols: number
  rows: number
}

export interface SessionEndPayload {
  sessionId: string
}

export interface SessionOutput {
  sessionId: string
  data: string // Base64 encoded
  closed?: boolean
}

// Generate unique ID
export function generateId(): string {
  return randomBytes(8).toString('hex')
}
