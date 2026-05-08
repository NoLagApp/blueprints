<script setup lang="ts">
import type { ConnectionStatus } from '../composables/useNoLag'

defineProps<{
  status: ConnectionStatus
  device: string
  workDir?: string
  interactive?: boolean
}>()

const statusConfig = {
  connected: { color: 'bg-terminal-success', text: 'Connected' },
  connecting: { color: 'bg-terminal-warning', text: 'Connecting...' },
  reconnecting: { color: 'bg-terminal-warning', text: 'Reconnecting...' },
  disconnected: { color: 'bg-terminal-error', text: 'Disconnected' },
}
</script>

<template>
  <div class="flex items-center gap-3 px-4 py-2 bg-terminal-surface border-b border-terminal-border">
    <!-- Status indicator -->
    <div class="flex items-center gap-2">
      <span
        class="w-2 h-2 rounded-full"
        :class="statusConfig[status].color"
      ></span>
      <span class="text-sm text-terminal-dim">{{ statusConfig[status].text }}</span>
    </div>

    <!-- Device info -->
    <div v-if="device" class="flex items-center gap-2 text-sm">
      <span class="text-terminal-dim">|</span>
      <span class="text-terminal-prompt font-medium">{{ device }}</span>
      <span v-if="workDir" class="text-terminal-dim">{{ workDir }}</span>
    </div>

    <!-- Interactive mode indicator -->
    <div v-if="interactive" class="flex items-center gap-2">
      <span class="text-terminal-dim">|</span>
      <span class="px-2 py-0.5 text-xs font-medium bg-terminal-accent text-white rounded">PTY</span>
    </div>

    <!-- Spacer -->
    <div class="flex-1"></div>

    <!-- Title -->
    <span class="text-sm text-terminal-dim">Remote Terminal</span>
  </div>
</template>
