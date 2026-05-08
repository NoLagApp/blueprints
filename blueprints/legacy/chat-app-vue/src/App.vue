<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { ChatService } from './services/ChatService'
import type { ChatMessage, ChatState } from './types/chat'

// Create chat service instance
const chatService = new ChatService()

// Reactive state
const username = ref('')
const messageInput = ref('')
const chatState = ref<ChatState>({
  connected: false,
  currentUser: null,
  users: new Map(),
  messages: [],
})
const isJoining = ref(false)
const error = ref<string | null>(null)
const messagesContainer = ref<HTMLElement | null>(null)

// Computed
const isConnected = computed(() => chatState.value.connected)
const currentUser = computed(() => chatState.value.currentUser)
const messages = computed(() => chatState.value.messages)
const onlineUsers = computed(() => Array.from(chatState.value.users.values()))
const hasToken = computed(() => !!window.NOLAG_PREVIEW_TOKEN)

// Join chat
async function joinChat() {
  if (!username.value.trim()) return

  isJoining.value = true
  error.value = null

  try {
    await chatService.connect(username.value.trim())
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to connect'
  } finally {
    isJoining.value = false
  }
}

// Send message
function sendMessage() {
  if (!messageInput.value.trim()) return
  chatService.sendMessage(messageInput.value)
  messageInput.value = ''
}

// Handle Enter key
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
}

// Scroll to bottom
function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// Format time
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Check if message is from current user
function isOwnMessage(message: ChatMessage): boolean {
  return message.userId === currentUser.value?.id
}

// Lifecycle
onMounted(() => {
  // Subscribe to state changes
  chatService.on('state:change', (state: unknown) => {
    chatState.value = state as ChatState
    scrollToBottom()
  })

  chatService.on('error', (err: unknown) => {
    error.value = err instanceof Error ? err.message : 'An error occurred'
  })
})

onUnmounted(() => {
  chatService.disconnect()
})
</script>

<template>
  <div class="h-full flex flex-col bg-base-200">
    <!-- Header -->
    <div class="navbar bg-base-100 shadow-lg">
      <div class="flex-1">
        <span class="text-xl font-bold px-4">NoLag Chat</span>
      </div>
      <div class="flex-none gap-2">
        <!-- Connection Status -->
        <div class="badge" :class="isConnected ? 'badge-success' : 'badge-error'">
          {{ isConnected ? 'Connected' : 'Disconnected' }}
        </div>
        <!-- Online Users Count -->
        <div v-if="isConnected" class="badge badge-info gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
            <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
          </svg>
          {{ onlineUsers.length }} online
        </div>
      </div>
    </div>

    <!-- No Token Warning -->
    <div v-if="!hasToken" class="alert alert-warning m-4">
      <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <span>No NoLag token found. This demo requires a preview token to be injected.</span>
    </div>

    <!-- Main Content -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Chat Area -->
      <div class="flex-1 flex flex-col">
        <!-- Join Form (when not connected) -->
        <div v-if="!isConnected" class="flex-1 flex items-center justify-center p-4">
          <div class="card w-96 bg-base-100 shadow-xl">
            <div class="card-body">
              <h2 class="card-title justify-center">Join Chat</h2>

              <div v-if="error" class="alert alert-error text-sm">
                {{ error }}
              </div>

              <div class="form-control">
                <label class="label">
                  <span class="label-text">Your Name</span>
                </label>
                <input
                  v-model="username"
                  type="text"
                  placeholder="Enter your name"
                  class="input input-bordered"
                  :disabled="isJoining || !hasToken"
                  @keydown.enter="joinChat"
                />
              </div>

              <div class="card-actions justify-center mt-4">
                <button
                  class="btn btn-primary"
                  :class="{ loading: isJoining }"
                  :disabled="!username.trim() || isJoining || !hasToken"
                  @click="joinChat"
                >
                  {{ isJoining ? 'Joining...' : 'Join Chat' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Chat Messages (when connected) -->
        <template v-else>
          <!-- Messages List -->
          <div ref="messagesContainer" class="flex-1 overflow-y-auto p-4 space-y-2">
            <div v-if="messages.length === 0" class="text-center text-base-content/50 py-8">
              No messages yet. Say hello!
            </div>

            <div
              v-for="message in messages"
              :key="message.id"
              class="chat"
              :class="isOwnMessage(message) ? 'chat-end' : 'chat-start'"
            >
              <div class="chat-header">
                {{ message.username }}
                <time class="text-xs opacity-50 ml-1">{{ formatTime(message.timestamp) }}</time>
              </div>
              <div
                class="chat-bubble"
                :class="isOwnMessage(message) ? 'chat-bubble-primary' : 'chat-bubble-secondary'"
              >
                {{ message.content }}
              </div>
            </div>
          </div>

          <!-- Message Input -->
          <div class="p-4 bg-base-100 border-t border-base-300">
            <div class="flex gap-2">
              <input
                v-model="messageInput"
                type="text"
                placeholder="Type a message..."
                class="input input-bordered flex-1"
                @keydown="handleKeydown"
              />
              <button
                class="btn btn-primary"
                :disabled="!messageInput.trim()"
                @click="sendMessage"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- Users Sidebar (when connected) -->
      <div v-if="isConnected" class="w-48 bg-base-100 border-l border-base-300 overflow-y-auto">
        <div class="p-3 border-b border-base-300">
          <h3 class="font-semibold text-sm">Online Users</h3>
        </div>
        <ul class="menu menu-sm">
          <li v-for="user in onlineUsers" :key="user.id">
            <a class="flex items-center gap-2" :class="{ 'bg-primary/10': user.id === currentUser?.id }">
              <div class="avatar placeholder">
                <div class="bg-neutral text-neutral-content rounded-full w-6">
                  <span class="text-xs">{{ user.username.charAt(0).toUpperCase() }}</span>
                </div>
              </div>
              <span class="truncate">{{ user.username }}</span>
              <span v-if="user.id === currentUser?.id" class="badge badge-xs badge-primary">you</span>
              <span class="w-2 h-2 rounded-full" :class="{
                'bg-success': user.status === 'online',
                'bg-warning': user.status === 'away',
                'bg-base-300': user.status === 'offline'
              }"></span>
            </a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
