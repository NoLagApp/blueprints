import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { type RoomContext } from '@nolag/js-sdk'
import { TOPIC_SESSION_OUTPUT, type SessionOutput } from './protocol.js'

interface PTYSession {
  id: string
  pty: IPty
  closed: boolean
}

export class SessionManager {
  private sessions: Map<string, PTYSession> = new Map()
  private room: RoomContext
  private workDir: string

  constructor(room: RoomContext, workDir: string) {
    this.room = room
    this.workDir = workDir
  }

  startSession(id: string, cols: number, rows: number): void {
    // Close existing session if any
    if (this.sessions.has(id)) {
      this.endSession(id)
    }

    // Determine shell to use
    const shell = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      : process.env.SHELL || '/bin/sh'

    const shellArgs = process.platform === 'win32'
      ? ['-NoLogo', '-NoExit']
      : []

    // Create PTY
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: this.workDir,
      env: process.env as { [key: string]: string },
    })

    const session: PTYSession = {
      id,
      pty: ptyProcess,
      closed: false,
    }

    this.sessions.set(id, session)

    // Handle output
    ptyProcess.onData((data: string) => {
      if (session.closed) return

      const output: SessionOutput = {
        sessionId: id,
        data: Buffer.from(data, 'utf-8').toString('base64'),
      }

      this.room.emit(TOPIC_SESSION_OUTPUT, output)
    })

    // Handle exit
    ptyProcess.onExit(() => {
      this.endSession(id)
    })

    console.log(`Session ${id} started with ${shell}`)
  }

  sendInput(id: string, data: Buffer): void {
    const session = this.sessions.get(id)
    if (!session || session.closed) return

    session.pty.write(data.toString('utf-8'))
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session || session.closed) return

    session.pty.resize(cols, rows)
  }

  endSession(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return

    if (!session.closed) {
      session.closed = true
      session.pty.kill()

      // Notify client that session is closed
      const output: SessionOutput = {
        sessionId: id,
        data: '',
        closed: true,
      }
      this.room.emit(TOPIC_SESSION_OUTPUT, output)

      console.log(`Session ${id} ended`)
    }

    this.sessions.delete(id)
  }

  closeAll(): void {
    for (const [id] of this.sessions) {
      this.endSession(id)
    }
  }

  updateWorkDir(workDir: string): void {
    this.workDir = workDir
  }
}
