<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Terminal from './components/Terminal.vue'

// Connection config (from URL params or form)
const token = ref('')
const device = ref('')
const brokerUrl = ref('')
const isConfigured = ref(false)

// Parse URL params on mount
onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  token.value = params.get('token') || ''
  device.value = params.get('device') || ''
  brokerUrl.value = params.get('broker') || ''

  // Auto-start if both token and device are provided
  if (token.value && device.value) {
    isConfigured.value = true
  }
})

// Start terminal with config
function connect() {
  if (token.value && device.value) {
    isConfigured.value = true
  }
}
</script>

<template>
  <div class="h-screen w-screen bg-terminal-bg">
    <!-- Config form (shown when not configured) -->
    <div
      v-if="!isConfigured"
      class="flex items-center justify-center h-full"
    >
      <div class="w-full max-w-md p-6 bg-terminal-surface rounded-lg border border-terminal-border">
        <h1 class="text-xl font-bold text-terminal-text mb-6">Remote Terminal</h1>

        <form @submit.prevent="connect" class="space-y-4">
          <!-- Token input -->
          <div>
            <label class="block text-sm text-terminal-dim mb-1">Access Token</label>
            <input
              v-model="token"
              type="text"
              placeholder="at_..."
              class="w-full px-3 py-2 bg-terminal-bg border border-terminal-border rounded text-terminal-text font-mono text-sm focus:border-terminal-prompt focus:outline-none"
              required
            />
          </div>

          <!-- Device input -->
          <div>
            <label class="block text-sm text-terminal-dim mb-1">Device ID</label>
            <input
              v-model="device"
              type="text"
              placeholder="my-pc"
              class="w-full px-3 py-2 bg-terminal-bg border border-terminal-border rounded text-terminal-text font-mono text-sm focus:border-terminal-prompt focus:outline-none"
              required
            />
          </div>

          <!-- Broker URL (optional) -->
          <div>
            <label class="block text-sm text-terminal-dim mb-1">
              Broker URL <span class="text-terminal-dim">(optional)</span>
            </label>
            <input
              v-model="brokerUrl"
              type="text"
              placeholder="wss://broker.nolag.app/ws"
              class="w-full px-3 py-2 bg-terminal-bg border border-terminal-border rounded text-terminal-text font-mono text-sm focus:border-terminal-prompt focus:outline-none"
            />
          </div>

          <!-- Connect button -->
          <button
            type="submit"
            class="w-full py-2 bg-terminal-prompt text-white font-medium rounded hover:opacity-90 transition-opacity"
          >
            Connect
          </button>
        </form>

        <!-- URL hint -->
        <p class="mt-4 text-xs text-terminal-dim">
          Tip: You can also pass config via URL:
          <code class="text-terminal-text">?token=XXX&device=YYY</code>
        </p>
      </div>
    </div>

    <!-- Terminal (shown when configured) -->
    <Terminal
      v-else
      :token="token"
      :device="device"
      :broker-url="brokerUrl || undefined"
    />
  </div>
</template>
