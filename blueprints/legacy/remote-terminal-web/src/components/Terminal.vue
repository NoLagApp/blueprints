<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useTerminal } from '../composables/useTerminal'
import ConnectionStatus from './ConnectionStatus.vue'
import TerminalOutput from './TerminalOutput.vue'
import TerminalInput from './TerminalInput.vue'

const props = defineProps<{
  token: string
  device: string
  brokerUrl?: string
}>()

const terminal = useTerminal()
const inputRef = ref<InstanceType<typeof TerminalInput> | null>(null)
const outputRef = ref<InstanceType<typeof TerminalOutput> | null>(null)

// Create computed properties to properly track reactivity
const connectionStatus = computed(() => terminal.status.value)
const deviceId = computed(() => terminal.deviceId.value)
const outputText = computed(() => terminal.outputText.value)
const isExecuting = computed(() => terminal.isExecuting.value)
const isInteractive = computed(() => terminal.mode.value === 'interactive')

// Computed prompt
const prompt = computed(() => {
  return terminal.deviceId.value || 'local'
})

// Computed workDir from device status
const workDir = computed(() => {
  return terminal.deviceStatus.value?.workDir
})

// Initialize and connect
onMounted(async () => {
  terminal.init()

  if (props.token && props.device) {
    try {
      await terminal.connect(props.token, props.device, props.brokerUrl)
    } catch (err) {
      // Error already shown in terminal
    }
  }

  // Focus input
  inputRef.value?.focus()
})

// Handle command submission
async function handleSubmit(command: string) {
  const trimmed = command.trim().toLowerCase()

  // Intercept !shell to start interactive mode
  if (trimmed === '!shell') {
    await startInteractiveMode()
    return
  }

  await terminal.execute(command)
  // Keep focus on input after command execution
  inputRef.value?.focus()
}

// Start interactive mode
async function startInteractiveMode() {
  const dims = outputRef.value?.getDimensions()
  const cols = dims?.cols || 80
  const rows = dims?.rows || 24

  await terminal.startInteractiveSession(
    cols,
    rows,
    (data: string) => {
      // Write output to xterm
      outputRef.value?.writeRaw(data)
    },
    () => {
      // Session closed
      inputRef.value?.focus()
    }
  )

  // Focus the terminal for interactive input
  outputRef.value?.focus()
}

// Handle interactive input from xterm
function handleInteractiveInput(data: string) {
  terminal.sendInteractiveInput(data)
}

// Handle terminal resize
function handleResize(cols: number, rows: number) {
  if (isInteractive.value) {
    terminal.resizeInteractiveSession(cols, rows)
  }
}

// Handle history navigation
function handleHistoryUp() {
  const cmd = terminal.historyUp()
  if (cmd !== null) {
    inputRef.value?.setValue(cmd)
  }
}

function handleHistoryDown() {
  const cmd = terminal.historyDown()
  if (cmd !== null) {
    inputRef.value?.setValue(cmd)
  }
}

// Handle clear
function handleClear() {
  terminal.clear()
}

// Watch for mode changes to focus appropriately
watch(isInteractive, (interactive) => {
  if (interactive) {
    outputRef.value?.focus()
  } else {
    inputRef.value?.focus()
  }
})
</script>

<template>
  <div class="flex flex-col h-full bg-terminal-bg">
    <!-- Status bar -->
    <ConnectionStatus
      :status="connectionStatus"
      :device="deviceId"
      :work-dir="workDir"
      :interactive="isInteractive"
    />

    <!-- Output area -->
    <TerminalOutput
      ref="outputRef"
      :content="outputText"
      :interactive="isInteractive"
      @input="handleInteractiveInput"
      @resize="handleResize"
    />

    <!-- Input area (hidden in interactive mode) -->
    <TerminalInput
      v-show="!isInteractive"
      ref="inputRef"
      :prompt="prompt"
      :disabled="isExecuting"
      @submit="handleSubmit"
      @history-up="handleHistoryUp"
      @history-down="handleHistoryDown"
      @clear="handleClear"
    />
  </div>
</template>
