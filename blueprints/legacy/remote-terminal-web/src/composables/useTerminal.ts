import { ref, computed } from 'vue'
import { useNoLag } from './useNoLag'
import type { Response } from '../types/protocol'

export interface OutputLine {
  type: 'command' | 'output' | 'error' | 'info' | 'success'
  text: string
  timestamp: Date
}

export type TerminalMode = 'command' | 'interactive'

export function useTerminal() {
  const nolag = useNoLag()

  // Terminal state
  const output = ref<OutputLine[]>([])
  const history = ref<string[]>([])
  const historyIndex = ref(-1)
  const isExecuting = ref(false)

  // Interactive session state
  const mode = ref<TerminalMode>('command')

  // Add line to output
  function addLine(type: OutputLine['type'], text: string) {
    output.value.push({
      type,
      text,
      timestamp: new Date(),
    })
  }

  // Clear output
  function clear() {
    output.value = []
    addLine('info', 'Terminal cleared')
  }

  // ANSI color codes
  const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    brightGreen: '\x1b[92m',
    brightRed: '\x1b[91m',
    brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m',
  }

  // Get output as text for xterm (with ANSI colors)
  const outputText = computed(() => {
    return output.value
      .map((line) => {
        const { prefix, color } = getStyle(line.type)
        return `${color}${prefix}${line.text}${ANSI.reset}`
      })
      .join('\r\n')
  })

  function getStyle(type: OutputLine['type']): { prefix: string; color: string } {
    switch (type) {
      case 'command':
        return { prefix: '$ ', color: ANSI.brightGreen + ANSI.bold }
      case 'error':
        return { prefix: '', color: ANSI.brightRed }
      case 'info':
        return { prefix: '', color: ANSI.dim }
      case 'success':
        return { prefix: '', color: ANSI.brightGreen }
      default:
        return { prefix: '', color: '' }
    }
  }

  // Execute command
  async function execute(input: string) {
    const trimmed = input.trim()
    if (!trimmed) return

    // Add to history
    if (history.value[history.value.length - 1] !== trimmed) {
      history.value.push(trimmed)
    }
    historyIndex.value = history.value.length

    // Show command in output
    addLine('command', trimmed)

    // Handle local commands
    if (trimmed.startsWith('!')) {
      await handleLocalCommand(trimmed)
      return
    }

    // Send to remote
    if (!nolag.isConnected.value) {
      addLine('error', 'Not connected to device')
      return
    }

    isExecuting.value = true
    try {
      const response = await nolag.sendCommand('shell', trimmed)
      handleResponse(response)
    } catch (err) {
      addLine('error', err instanceof Error ? err.message : 'Command failed')
    } finally {
      isExecuting.value = false
    }
  }

  // Handle local commands
  async function handleLocalCommand(input: string) {
    const cmd = input.toLowerCase()

    switch (cmd) {
      case '!help':
        showHelp()
        break

      case '!clear':
        clear()
        break

      case '!ping':
        if (!nolag.isConnected.value) {
          addLine('error', 'Not connected')
          return
        }
        isExecuting.value = true
        try {
          const resp = await nolag.sendCommand('ping')
          addLine('success', resp.output || 'pong')
        } catch (err) {
          addLine('error', err instanceof Error ? err.message : 'Ping failed')
        } finally {
          isExecuting.value = false
        }
        break

      case '!info':
        if (!nolag.isConnected.value) {
          addLine('error', 'Not connected')
          return
        }
        isExecuting.value = true
        try {
          const resp = await nolag.sendCommand('info')
          handleResponse(resp)
        } catch (err) {
          addLine('error', err instanceof Error ? err.message : 'Info failed')
        } finally {
          isExecuting.value = false
        }
        break

      case '!shell':
        // This is handled by Terminal.vue to start interactive session
        // Just add the command to output, Terminal.vue will intercept
        break

      default:
        addLine('error', `Unknown command: ${input}`)
        addLine('info', 'Type !help for available commands')
    }
  }

  // Handle response from agent
  function handleResponse(response: Response) {
    if (response.status === 'error') {
      if (response.error) {
        addLine('error', response.error)
      }
      if (response.output) {
        addLine('output', response.output)
      }
      if (response.exitCode !== 0) {
        addLine('error', `[exit ${response.exitCode}]`)
      }
    } else {
      if (response.output) {
        addLine('output', response.output)
      }
    }
  }

  // Show help
  function showHelp() {
    addLine('info', '')
    addLine('info', '=== Remote Terminal Help ===')
    addLine('info', '')
    addLine('info', 'Local Commands:')
    addLine('info', '  !help     Show this help')
    addLine('info', '  !clear    Clear terminal output')
    addLine('info', '  !ping     Ping remote device')
    addLine('info', '  !info     Show system info')
    addLine('info', '  !shell    Start interactive shell (PTY)')
    addLine('info', '')
    addLine('info', 'Remote Commands:')
    addLine('info', '  <command> Execute shell command on device')
    addLine('info', '')
    addLine('info', 'Keyboard:')
    addLine('info', '  Up/Down   Navigate command history')
    addLine('info', '  Ctrl+L    Clear screen')
    addLine('info', '')
  }

  // Start interactive shell session
  async function startInteractiveSession(
    cols: number,
    rows: number,
    outputHandler: (data: string) => void,
    closeHandler: () => void
  ) {
    if (!nolag.isConnected.value) {
      addLine('error', 'Not connected to device')
      return
    }

    if (mode.value === 'interactive') {
      addLine('error', 'Already in interactive mode')
      return
    }

    addLine('info', 'Starting interactive shell...')

    const handleClose = () => {
      mode.value = 'command'
      addLine('info', 'Interactive session ended')
      closeHandler()
    }

    try {
      await nolag.startSession(cols, rows, outputHandler, handleClose)
      mode.value = 'interactive'
      addLine('success', 'Interactive shell started. Press Ctrl+D to exit.')
    } catch (err) {
      addLine('error', err instanceof Error ? err.message : 'Failed to start session')
      mode.value = 'command'
    }
  }

  // Send input to interactive session
  function sendInteractiveInput(data: string) {
    if (mode.value !== 'interactive') return
    nolag.sendSessionInput(data)
  }

  // Resize interactive session
  function resizeInteractiveSession(cols: number, rows: number) {
    if (mode.value !== 'interactive') return
    nolag.resizeSession(cols, rows)
  }

  // End interactive session
  function endInteractiveSession() {
    if (mode.value !== 'interactive') return
    nolag.endSession()
    mode.value = 'command'
    addLine('info', 'Interactive session ended')
  }

  // History navigation
  function historyUp(): string | null {
    if (history.value.length === 0) return null
    if (historyIndex.value > 0) {
      historyIndex.value--
    }
    return history.value[historyIndex.value] || null
  }

  function historyDown(): string | null {
    if (historyIndex.value < history.value.length - 1) {
      historyIndex.value++
      return history.value[historyIndex.value]
    }
    historyIndex.value = history.value.length
    return ''
  }

  // Initialize with welcome message
  function init() {
    addLine('info', '=== Remote Terminal ===')
    addLine('info', 'Type !help for commands')
    addLine('info', '')
  }

  return {
    // NoLag state
    ...nolag,

    // Terminal state
    output,
    outputText,
    history,
    isExecuting,
    mode,

    // Actions
    execute,
    clear,
    historyUp,
    historyDown,
    init,

    // Interactive session actions
    startInteractiveSession,
    sendInteractiveInput,
    resizeInteractiveSession,
    endInteractiveSession,
  }
}
