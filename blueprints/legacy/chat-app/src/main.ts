import './style.css'
import { ChatService, type ChatMessage, type ChatUser, type ChatState } from './ChatService'

const chatService = new ChatService()

let currentState: ChatState = {
  connected: false,
  currentUser: null,
  users: new Map(),
  messages: [],
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function renderApp() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  const isConnected = currentState.connected
  const hasToken = !!window.NOLAG_PREVIEW_TOKEN

  app.innerHTML = `
    <div class="h-screen flex flex-col bg-base-200">
      <!-- Header -->
      <div class="navbar bg-base-100 shadow-lg flex-shrink-0">
        <div class="flex-1">
          <span class="text-xl font-bold px-4">NoLag Chat</span>
        </div>
        <div class="flex-none gap-2">
          <div class="badge ${isConnected ? 'badge-success' : 'badge-error'}">
            ${isConnected ? 'Connected' : 'Disconnected'}
          </div>
          ${isConnected ? `
            <div class="badge badge-info gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
              </svg>
              ${Array.from(currentState.users.values()).length} online
            </div>
          ` : ''}
        </div>
      </div>

      ${!hasToken ? `
        <div class="alert alert-warning m-4 flex-shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>No NoLag token found. This demo requires a preview token to be injected.</span>
        </div>
      ` : ''}

      <!-- Main Content -->
      <div class="flex-1 flex overflow-hidden min-h-0">
        <!-- Chat Area -->
        <div class="flex-1 flex flex-col min-w-0">
          ${!isConnected ? renderJoinForm(hasToken) : renderChatArea()}
        </div>

        ${isConnected ? renderUsersSidebar() : ''}
      </div>
    </div>
  `

  attachEventListeners()

  // Scroll messages to bottom
  if (isConnected) {
    const messagesContainer = document.querySelector<HTMLDivElement>('#messages-container')
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  }
}

function renderJoinForm(hasToken: boolean): string {
  return `
    <div class="flex-1 flex items-center justify-center p-4">
      <div class="card w-96 bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title justify-center">Join Chat</h2>

          <div id="join-error" class="alert alert-error text-sm hidden"></div>

          <div class="form-control">
            <label class="label">
              <span class="label-text">Your Name</span>
            </label>
            <input
              type="text"
              id="username-input"
              placeholder="Enter your name"
              class="input input-bordered"
              ${!hasToken ? 'disabled' : ''}
            />
          </div>

          <div class="card-actions justify-center mt-4">
            <button
              id="join-btn"
              class="btn btn-primary"
              ${!hasToken ? 'disabled' : ''}
            >
              Join Chat
            </button>
          </div>
        </div>
      </div>
    </div>
  `
}

function renderChatArea(): string {
  const messages = currentState.messages
  const currentUser = currentState.currentUser

  return `
    <!-- Messages List -->
    <div id="messages-container" class="flex-1 overflow-y-auto p-4 space-y-2">
      ${messages.length === 0 ? `
        <div class="text-center text-base-content/50 py-8">
          No messages yet. Say hello!
        </div>
      ` : messages.map((msg) => {
        const isOwn = msg.userId === currentUser?.id
        return `
          <div class="chat ${isOwn ? 'chat-end' : 'chat-start'}">
            <div class="chat-header">
              ${escapeHtml(msg.username)}
              <time class="text-xs opacity-50 ml-1">${formatTime(msg.timestamp)}</time>
            </div>
            <div class="chat-bubble ${isOwn ? 'chat-bubble-primary' : 'chat-bubble-secondary'}">
              ${escapeHtml(msg.content)}
            </div>
          </div>
        `
      }).join('')}
    </div>

    <!-- Message Input -->
    <div class="p-4 bg-base-100 border-t border-base-300 flex-shrink-0">
      <div class="flex gap-2">
        <input
          type="text"
          id="message-input"
          placeholder="Type a message..."
          class="input input-bordered flex-1"
        />
        <button id="send-btn" class="btn btn-primary">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
          </svg>
        </button>
      </div>
    </div>
  `
}

function renderUsersSidebar(): string {
  const users = Array.from(currentState.users.values())
  const currentUser = currentState.currentUser

  return `
    <div class="w-48 bg-base-100 border-l border-base-300 overflow-y-auto flex-shrink-0">
      <div class="p-3 border-b border-base-300">
        <h3 class="font-semibold text-sm">Online Users</h3>
      </div>
      <ul class="menu menu-sm">
        ${users.map((user) => `
          <li>
            <a class="flex items-center gap-2 ${user.id === currentUser?.id ? 'bg-primary/10' : ''}">
              <div class="avatar placeholder">
                <div class="bg-neutral text-neutral-content rounded-full w-6">
                  <span class="text-xs">${escapeHtml(user.username.charAt(0).toUpperCase())}</span>
                </div>
              </div>
              <span class="truncate">${escapeHtml(user.username)}</span>
              ${user.id === currentUser?.id ? '<span class="badge badge-xs badge-primary">you</span>' : ''}
              <span class="w-2 h-2 rounded-full ${
                user.status === 'online'
                  ? 'bg-success'
                  : user.status === 'away'
                  ? 'bg-warning'
                  : 'bg-base-300'
              }"></span>
            </a>
          </li>
        `).join('')}
      </ul>
    </div>
  `
}

function attachEventListeners() {
  // Join form
  const joinBtn = document.querySelector<HTMLButtonElement>('#join-btn')
  const usernameInput = document.querySelector<HTMLInputElement>('#username-input')

  joinBtn?.addEventListener('click', () => joinChat())
  usernameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinChat()
  })

  // Chat input
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn')
  const messageInput = document.querySelector<HTMLInputElement>('#message-input')

  sendBtn?.addEventListener('click', () => sendMessage())
  messageInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })

  // Focus message input if connected
  if (currentState.connected) {
    messageInput?.focus()
  }
}

async function joinChat() {
  const usernameInput = document.querySelector<HTMLInputElement>('#username-input')
  const joinBtn = document.querySelector<HTMLButtonElement>('#join-btn')
  const errorEl = document.querySelector<HTMLDivElement>('#join-error')
  const username = usernameInput?.value?.trim()

  if (!username) return

  if (joinBtn) {
    joinBtn.textContent = 'Joining...'
    joinBtn.disabled = true
  }
  if (errorEl) errorEl.classList.add('hidden')

  try {
    await chatService.connect(username)
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err instanceof Error ? err.message : 'Failed to connect'
      errorEl.classList.remove('hidden')
    }
    if (joinBtn) {
      joinBtn.textContent = 'Join Chat'
      joinBtn.disabled = false
    }
  }
}

function sendMessage() {
  const messageInput = document.querySelector<HTMLInputElement>('#message-input')
  const content = messageInput?.value?.trim()

  if (!content) return

  chatService.sendMessage(content)
  if (messageInput) messageInput.value = ''
}

// Subscribe to state changes and re-render
chatService.on('state:change', (state: unknown) => {
  currentState = state as ChatState
  renderApp()
})

chatService.on('error', (err: unknown) => {
  console.error('[Chat] Error:', err)
})

// Initial render
renderApp()
