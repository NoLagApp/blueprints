<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  content: string
  interactive?: boolean
}>()

const emit = defineEmits<{
  (e: 'input', data: string): void
  (e: 'resize', cols: number, rows: number): void
}>()

const terminalRef = ref<HTMLDivElement | null>(null)
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let lastContent = ''
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!terminalRef.value) return

  // Create terminal with custom theme
  term = new Terminal({
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      cursorAccent: '#0d1117',
      selectionBackground: '#264f78',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    },
    fontFamily: 'JetBrains Mono, Consolas, Monaco, monospace',
    fontSize: 14,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: 'block',
    disableStdin: !props.interactive,
    convertEol: true,
    scrollback: 5000,
  })

  // Add fit addon for auto-resize
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  // Open terminal in container
  term.open(terminalRef.value)
  fitAddon.fit()

  // Handle resize
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon) {
      fitAddon.fit()
      if (term) {
        emit('resize', term.cols, term.rows)
      }
    }
  })
  resizeObserver.observe(terminalRef.value)

  // Handle input in interactive mode
  term.onData((data) => {
    if (props.interactive) {
      emit('input', data)
    }
  })

  // Write initial content
  if (props.content) {
    term.write(props.content)
    lastContent = props.content
  }
})

// Watch for content changes and write new content
watch(() => props.content, (newContent) => {
  if (!term || !newContent) return

  // In interactive mode, don't update from content prop
  if (props.interactive) return

  // Find what's new and write only that
  if (newContent.startsWith(lastContent)) {
    const newPart = newContent.slice(lastContent.length)
    if (newPart) {
      term.write(newPart)
    }
  } else {
    // Content changed completely, clear and rewrite
    term.clear()
    term.write(newContent)
  }
  lastContent = newContent
})

// Watch for interactive mode changes
watch(() => props.interactive, (interactive) => {
  if (!term) return

  // Clear screen when entering interactive mode
  if (interactive) {
    term.clear()
    term.reset()
    lastContent = ''
  }

  // Update stdin option
  term.options.disableStdin = !interactive
  term.options.cursorBlink = interactive
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  term?.dispose()
})

// Expose methods for parent component
function getDimensions() {
  return term ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 }
}

function writeRaw(data: string) {
  term?.write(data)
}

function focus() {
  term?.focus()
}

function clear() {
  term?.clear()
  lastContent = ''
}

defineExpose({
  getDimensions,
  writeRaw,
  focus,
  clear,
})
</script>

<template>
  <div class="flex-1 min-h-0 overflow-hidden bg-terminal-bg">
    <div ref="terminalRef" class="h-full w-full p-2"></div>
  </div>
</template>

<style>
.xterm {
  height: 100%;
  padding: 8px;
}
.xterm-viewport {
  overflow-y: auto !important;
}
</style>
