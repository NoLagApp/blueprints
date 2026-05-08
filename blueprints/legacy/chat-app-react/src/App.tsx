import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ChatService } from './services/ChatService'
import type { ChatMessage, ChatUser, ChatState } from './types/chat'

// Create chat service instance (singleton)
const chatService = new ChatService()

function App() {
  // State
  const [username, setUsername] = useState('')
  const [messageInput, setMessageInput] = useState('')
  const [chatState, setChatState] = useState<ChatState>({
    connected: false,
    currentUser: null,
    users: new Map(),
    messages: [],
  })
  const [isJoining, setIsJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Derived state
  const isConnected = chatState.connected
  const currentUser = chatState.currentUser
  const messages = chatState.messages
  const onlineUsers = useMemo(() => Array.from(chatState.users.values()), [chatState.users])
  const hasToken = !!window.NOLAG_PREVIEW_TOKEN

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Subscribe to chat service events
  useEffect(() => {
    const unsubscribeState = chatService.on('state:change', (state: unknown) => {
      setChatState(state as ChatState)
    })

    const unsubscribeError = chatService.on('error', (err: unknown) => {
      setError(err instanceof Error ? err.message : 'An error occurred')
    })

    return () => {
      unsubscribeState()
      unsubscribeError()
      chatService.disconnect()
    }
  }, [])

  // Scroll on new messages
  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // Join chat
  const joinChat = async () => {
    if (!username.trim()) return

    setIsJoining(true)
    setError(null)

    try {
      await chatService.connect(username.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setIsJoining(false)
    }
  }

  // Send message
  const sendMessage = () => {
    if (!messageInput.trim()) return
    chatService.sendMessage(messageInput)
    setMessageInput('')
  }

  // Handle Enter key
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // Format time
  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // Check if message is from current user
  const isOwnMessage = (message: ChatMessage): boolean => {
    return message.userId === currentUser?.id
  }

  return (
    <div className="h-full flex flex-col bg-base-200">
      {/* Header */}
      <div className="navbar bg-base-100 shadow-lg">
        <div className="flex-1">
          <span className="text-xl font-bold px-4">NoLag Chat</span>
        </div>
        <div className="flex-none gap-2">
          {/* Connection Status */}
          <div className={`badge ${isConnected ? 'badge-success' : 'badge-error'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
          {/* Online Users Count */}
          {isConnected && (
            <div className="badge badge-info gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
              </svg>
              {onlineUsers.length} online
            </div>
          )}
        </div>
      </div>

      {/* No Token Warning */}
      {!hasToken && (
        <div className="alert alert-warning m-4">
          <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>No NoLag token found. This demo requires a preview token to be injected.</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat Area */}
        <div className="flex-1 flex flex-col">
          {/* Join Form (when not connected) */}
          {!isConnected ? (
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="card w-96 bg-base-100 shadow-xl">
                <div className="card-body">
                  <h2 className="card-title justify-center">Join Chat</h2>

                  {error && (
                    <div className="alert alert-error text-sm">
                      {error}
                    </div>
                  )}

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text">Your Name</span>
                    </label>
                    <input
                      type="text"
                      placeholder="Enter your name"
                      className="input input-bordered"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && joinChat()}
                      disabled={isJoining || !hasToken}
                    />
                  </div>

                  <div className="card-actions justify-center mt-4">
                    <button
                      className={`btn btn-primary ${isJoining ? 'loading' : ''}`}
                      disabled={!username.trim() || isJoining || !hasToken}
                      onClick={joinChat}
                    >
                      {isJoining ? 'Joining...' : 'Join Chat'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Messages List */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {messages.length === 0 ? (
                  <div className="text-center text-base-content/50 py-8">
                    No messages yet. Say hello!
                  </div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`chat ${isOwnMessage(message) ? 'chat-end' : 'chat-start'}`}
                    >
                      <div className="chat-header">
                        {message.username}
                        <time className="text-xs opacity-50 ml-1">
                          {formatTime(message.timestamp)}
                        </time>
                      </div>
                      <div
                        className={`chat-bubble ${
                          isOwnMessage(message) ? 'chat-bubble-primary' : 'chat-bubble-secondary'
                        }`}
                      >
                        {message.content}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Message Input */}
              <div className="p-4 bg-base-100 border-t border-base-300">
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Type a message..."
                    className="input input-bordered flex-1"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!messageInput.trim()}
                    onClick={sendMessage}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                    </svg>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Users Sidebar (when connected) */}
        {isConnected && (
          <div className="w-48 bg-base-100 border-l border-base-300 overflow-y-auto">
            <div className="p-3 border-b border-base-300">
              <h3 className="font-semibold text-sm">Online Users</h3>
            </div>
            <ul className="menu menu-sm">
              {onlineUsers.map((user) => (
                <li key={user.id}>
                  <a
                    className={`flex items-center gap-2 ${
                      user.id === currentUser?.id ? 'bg-primary/10' : ''
                    }`}
                  >
                    <div className="avatar placeholder">
                      <div className="bg-neutral text-neutral-content rounded-full w-6">
                        <span className="text-xs">{user.username.charAt(0).toUpperCase()}</span>
                      </div>
                    </div>
                    <span className="truncate">{user.username}</span>
                    {user.id === currentUser?.id && (
                      <span className="badge badge-xs badge-primary">you</span>
                    )}
                    <span
                      className={`w-2 h-2 rounded-full ${
                        user.status === 'online'
                          ? 'bg-success'
                          : user.status === 'away'
                          ? 'bg-warning'
                          : 'bg-base-300'
                      }`}
                    />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
