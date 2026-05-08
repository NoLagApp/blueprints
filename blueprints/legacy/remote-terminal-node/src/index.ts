import { NoLag, type RoomContext, type MessageMeta } from '@nolag/js-sdk'
import { program } from 'commander'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { execSync, spawn } from 'child_process'
import {
  APP_NAME,
  TOPIC_COMMANDS,
  TOPIC_RESPONSES,
  TOPIC_STATUS,
  CMD_TYPE_SHELL,
  CMD_TYPE_INFO,
  CMD_TYPE_PING,
  CMD_TYPE_COMPLETE,
  CMD_TYPE_LISTDIR,
  CMD_TYPE_DOWNLOAD,
  CMD_TYPE_UPLOAD,
  CMD_TYPE_SESSION_START,
  CMD_TYPE_SESSION_INPUT,
  CMD_TYPE_SESSION_RESIZE,
  CMD_TYPE_SESSION_END,
  type Command,
  type Response,
  type DeviceStatus,
  type SessionStartPayload,
  type SessionInputPayload,
  type SessionResizePayload,
  type SessionEndPayload,
} from './protocol.js'
import { SessionManager } from './session.js'

// Parse CLI arguments
program
  .requiredOption('-t, --token <token>', 'NoLag actor token')
  .requiredOption('-k, --apikey <apikey>', 'NoLag API key')
  .requiredOption('-a, --appid <appid>', 'NoLag App ID')
  .option('-d, --device <device>', 'Device ID', os.hostname())
  .option('-b, --broker <url>', 'NoLag broker URL', 'wss://broker.nolag.app/ws')
  .option('--api <url>', 'NoLag API URL', 'https://api.nolag.app/v1')
  .option('--debug', 'Enable debug logging', false)
  .parse()

const opts = program.opts()

// State
let workDir = process.cwd()
let sessionManager: SessionManager | null = null
let room: RoomContext | null = null

// Main
async function main() {
  console.log('Starting remote-terminal agent (Node.js)...')
  console.log(`Device ID: ${opts.device}`)
  console.log(`Working directory: ${workDir}`)

  // Create room via API (optional - room might already exist)
  try {
    const response = await fetch(`${opts.api}/apps/${opts.appid}/rooms`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.apikey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Device: ${opts.device}`,
        slug: opts.device,
      }),
    })
    if (response.ok) {
      console.log(`Room '${opts.device}' created successfully`)
    } else {
      console.log(`Room creation: ${response.status} (may already exist)`)
    }
  } catch (err) {
    console.log(`Room creation failed: ${err}`)
  }

  // Connect to NoLag
  const client = NoLag(opts.token, {
    url: opts.broker,
    reconnect: true,
    reconnectInterval: 5000,
    debug: opts.debug,
  })

  client.on('connect', () => {
    console.log('Connected to NoLag broker')
    setupRoom(client)
  })

  client.on('disconnect', (reason: string) => {
    console.log('Disconnected from NoLag broker:', reason)
  })

  client.on('reconnect', () => {
    console.log('Reconnecting...')
  })

  client.on('error', (err: Error) => {
    console.error('Error:', err.message)
  })

  await client.connect()

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down...')
    sessionManager?.closeAll()
    client.disconnect()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log('Shutting down...')
    sessionManager?.closeAll()
    client.disconnect()
    process.exit(0)
  })
}

function setupRoom(client: ReturnType<typeof NoLag>) {
  const r = client.setApp(APP_NAME).setRoom(opts.device) as RoomContext
  room = r

  // Initialize session manager
  sessionManager = new SessionManager(r, workDir)

  // Subscribe to commands
  r.subscribe(TOPIC_COMMANDS)
  r.on(TOPIC_COMMANDS, handleCommand)

  console.log('Subscribed to commands topic')

  // Start status broadcaster
  broadcastStatus()
  setInterval(broadcastStatus, 30000)
}

function handleCommand(data: unknown, _meta: MessageMeta) {
  const cmd = data as Command
  console.log(`Received command [${cmd.id}]: ${cmd.type} - ${cmd.payload}`)

  let response: Response = {
    commandId: cmd.id,
    status: 'success',
    output: '',
    exitCode: 0,
  }

  switch (cmd.type) {
    case CMD_TYPE_SHELL:
      handleShell(cmd, response)
      break

    case CMD_TYPE_PING:
      response.output = 'pong'
      break

    case CMD_TYPE_INFO:
      response.output = getSystemInfo()
      break

    case CMD_TYPE_COMPLETE:
      response.completions = getCompletions(cmd.payload)
      break

    case CMD_TYPE_LISTDIR:
      handleListDir(cmd.payload || workDir, response)
      break

    case CMD_TYPE_DOWNLOAD:
      handleDownload(cmd.payload, response)
      break

    case CMD_TYPE_UPLOAD:
      handleUpload(cmd.payload, cmd.data, response)
      break

    case CMD_TYPE_SESSION_START:
      handleSessionStart(cmd)
      return // Response handled separately

    case CMD_TYPE_SESSION_INPUT:
      handleSessionInput(cmd)
      return // No response needed

    case CMD_TYPE_SESSION_RESIZE:
      handleSessionResize(cmd)
      return // No response needed

    case CMD_TYPE_SESSION_END:
      handleSessionEnd(cmd)
      return // No response needed

    default:
      response.status = 'error'
      response.error = `Unknown command type: ${cmd.type}`
  }

  // Send response
  room?.emit(TOPIC_RESPONSES, response)
}

function handleShell(cmd: Command, response: Response) {
  const command = cmd.payload

  // Handle cd command specially
  if (command.startsWith('cd ')) {
    let newDir = command.slice(3).trim()

    // Expand ~ to home directory
    if (newDir.startsWith('~')) {
      newDir = newDir.replace('~', os.homedir())
    }

    // Make absolute if relative
    if (!path.isAbsolute(newDir)) {
      newDir = path.join(workDir, newDir)
    }

    // Clean the path
    newDir = path.resolve(newDir)

    // Check if directory exists
    try {
      const stats = fs.statSync(newDir)
      if (!stats.isDirectory()) {
        response.status = 'error'
        response.error = `cd: ${newDir}: Not a directory`
        response.exitCode = 1
        return
      }
      workDir = newDir
      sessionManager?.updateWorkDir(workDir)
      response.output = `Changed directory to ${workDir}`
    } catch {
      response.status = 'error'
      response.error = `cd: ${newDir}: No such file or directory`
      response.exitCode = 1
    }
    return
  }

  // Execute command
  try {
    const shell = process.platform === 'win32' ? 'cmd' : 'sh'
    const shellArg = process.platform === 'win32' ? '/C' : '-c'

    const output = execSync(command, {
      cwd: workDir,
      encoding: 'utf-8',
      shell: shell === 'cmd' ? undefined : shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    response.output = output
  } catch (err: any) {
    response.status = 'error'
    response.output = err.stdout?.toString() || ''
    response.error = err.stderr?.toString() || err.message
    response.exitCode = err.status || 1
  }
}

function getSystemInfo(): string {
  return `Hostname: ${os.hostname()}
OS: ${process.platform}
Architecture: ${os.arch()}
CPUs: ${os.cpus().length}
Working Directory: ${workDir}
Node Version: ${process.version}`
}

function getCompletions(partial: string): string[] {
  if (!partial) return []

  let dir = path.dirname(partial)
  let prefix = path.basename(partial)

  // Handle relative paths
  if (!path.isAbsolute(dir)) {
    dir = path.join(workDir, dir)
  }

  // If partial ends with separator, list that directory
  if (partial.endsWith(path.sep) || partial.endsWith('/')) {
    dir = partial
    if (!path.isAbsolute(dir)) {
      dir = path.join(workDir, dir)
    }
    prefix = ''
  }

  try {
    const entries = fs.readdirSync(dir)
    const completions: string[] = []

    for (const entry of entries) {
      if (prefix === '' || entry.toLowerCase().startsWith(prefix.toLowerCase())) {
        const fullPath = path.join(dir, entry)
        const stats = fs.statSync(fullPath)
        completions.push(stats.isDirectory() ? entry + path.sep : entry)
      }
    }

    return completions.slice(0, 20)
  } catch {
    return []
  }
}

function handleListDir(dirPath: string, response: Response) {
  if (!path.isAbsolute(dirPath)) {
    dirPath = path.join(workDir, dirPath)
  }

  try {
    const entries = fs.readdirSync(dirPath)
    const lines: string[] = []

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry)
      try {
        const stats = fs.statSync(fullPath)
        const perm = stats.isDirectory() ? 'd' : '-'
        const size = stats.size.toString().padStart(10)
        const mtime = stats.mtime.toLocaleDateString('en-US', {
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
        const name = stats.isDirectory() ? entry + '/' : entry
        lines.push(`${perm} ${size} ${mtime} ${name}`)
      } catch {
        // Skip entries we can't stat
      }
    }

    response.output = lines.join('\n')
  } catch (err: any) {
    response.status = 'error'
    response.error = err.message
  }
}

function handleDownload(filePath: string, response: Response) {
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workDir, filePath)
  }

  try {
    const stats = fs.statSync(filePath)
    if (stats.size > 10 * 1024 * 1024) {
      response.status = 'error'
      response.error = 'File too large (max 10MB)'
      return
    }

    const data = fs.readFileSync(filePath)
    const base64 = data.toString('base64')
    response.data = Array.from(Buffer.from(base64))
    response.output = `Downloaded ${data.length} bytes`
  } catch (err: any) {
    response.status = 'error'
    response.error = err.message
  }
}

function handleUpload(filePath: string, data: number[] | undefined, response: Response) {
  if (!data) {
    response.status = 'error'
    response.error = 'No data provided'
    return
  }

  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workDir, filePath)
  }

  try {
    const decoded = Buffer.from(Buffer.from(data).toString(), 'base64')
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, decoded)
    response.output = `Uploaded ${decoded.length} bytes to ${filePath}`
  } catch (err: any) {
    response.status = 'error'
    response.error = err.message
  }
}

function handleSessionStart(cmd: Command) {
  let payload: SessionStartPayload
  try {
    payload = JSON.parse(cmd.payload)
  } catch {
    const response: Response = {
      commandId: cmd.id,
      status: 'error',
      output: '',
      error: 'Invalid session_start payload',
      exitCode: 1,
    }
    room?.emit(TOPIC_RESPONSES, response)
    return
  }

  const cols = payload.cols || 80
  const rows = payload.rows || 24
  const sessionId = cmd.id

  try {
    sessionManager?.startSession(sessionId, cols, rows)

    const response: Response = {
      commandId: cmd.id,
      status: 'success',
      output: sessionId,
      exitCode: 0,
    }
    room?.emit(TOPIC_RESPONSES, response)
  } catch (err: any) {
    const response: Response = {
      commandId: cmd.id,
      status: 'error',
      output: '',
      error: `Failed to start session: ${err.message}`,
      exitCode: 1,
    }
    room?.emit(TOPIC_RESPONSES, response)
  }
}

function handleSessionInput(cmd: Command) {
  let payload: SessionInputPayload
  try {
    payload = JSON.parse(cmd.payload)
  } catch {
    console.error('Invalid session_input payload')
    return
  }

  const data = Buffer.from(payload.data, 'base64')
  sessionManager?.sendInput(payload.sessionId, data)
}

function handleSessionResize(cmd: Command) {
  let payload: SessionResizePayload
  try {
    payload = JSON.parse(cmd.payload)
  } catch {
    console.error('Invalid session_resize payload')
    return
  }

  sessionManager?.resize(payload.sessionId, payload.cols, payload.rows)
}

function handleSessionEnd(cmd: Command) {
  let payload: SessionEndPayload
  try {
    payload = JSON.parse(cmd.payload)
  } catch {
    console.error('Invalid session_end payload')
    return
  }

  sessionManager?.endSession(payload.sessionId)
}

function broadcastStatus() {
  if (!room) return

  const status: DeviceStatus = {
    deviceId: opts.device,
    hostname: os.hostname(),
    os: process.platform,
    arch: os.arch(),
    online: true,
    timestamp: Math.floor(Date.now() / 1000),
    workDir,
  }

  room.emit(TOPIC_STATUS, status)
}

// Run
main().catch(console.error)
