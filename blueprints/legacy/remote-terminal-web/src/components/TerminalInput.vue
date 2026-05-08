<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  prompt: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  submit: [command: string]
  historyUp: []
  historyDown: []
  clear: []
}>()

const input = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

// External control of input value (for history navigation)
function setValue(value: string) {
  input.value = value
}

// Focus input
function focus() {
  inputRef.value?.focus()
}

// Handle keydown
function handleKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'Enter':
      if (input.value.trim()) {
        emit('submit', input.value)
        input.value = ''
      }
      break
    case 'ArrowUp':
      event.preventDefault()
      emit('historyUp')
      break
    case 'ArrowDown':
      event.preventDefault()
      emit('historyDown')
      break
    case 'l':
      if (event.ctrlKey) {
        event.preventDefault()
        emit('clear')
      }
      break
  }
}

// Expose methods for parent
defineExpose({ setValue, focus })
</script>

<template>
  <div
    class="flex items-center gap-2 px-4 py-3 bg-terminal-surface border-t border-terminal-border"
  >
    <!-- Prompt -->
    <span class="text-terminal-prompt font-medium shrink-0">{{ prompt }}&gt;</span>

    <!-- Input -->
    <input
      ref="inputRef"
      v-model="input"
      type="text"
      :disabled="disabled"
      class="flex-1 bg-transparent text-terminal-text font-mono text-sm terminal-input"
      :class="{ 'opacity-50': disabled }"
      placeholder="Enter command..."
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      @keydown="handleKeydown"
    />

    <!-- Executing indicator -->
    <span v-if="disabled" class="text-terminal-warning text-sm">Running...</span>
  </div>
</template>
