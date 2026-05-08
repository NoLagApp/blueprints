/**
 * useChat - React Hook for ChatService
 *
 * This hook demonstrates how to integrate the framework-agnostic
 * ChatService with React's state management patterns.
 *
 * Usage:
 *   const { state, joinChat, sendMessage, disconnect } = useChat();
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChatService } from '../services/ChatService'
import type { ChatState, ChatUser, ChatMessage } from '../types/chat'

// Singleton instance
const chatService = new ChatService()

export function useChat() {
  const [state, setState] = useState<ChatState>({
    connected: false,
    currentUser: null,
    users: new Map(),
    messages: [],
  })
  const [error, setError] = useState<string | null>(null)
  const [isJoining, setIsJoining] = useState(false)

  // Subscribe to ChatService events
  useEffect(() => {
    const unsubscribeState = chatService.on('state:change', (newState: unknown) => {
      setState(newState as ChatState)
    })

    const unsubscribeError = chatService.on('error', (err: unknown) => {
      setError(err instanceof Error ? err.message : 'An error occurred')
    })

    return () => {
      unsubscribeState()
      unsubscribeError()
    }
  }, [])

  // Join chat
  const joinChat = useCallback(async (username: string) => {
    setIsJoining(true)
    setError(null)

    try {
      await chatService.connect(username)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
      throw err
    } finally {
      setIsJoining(false)
    }
  }, [])

  // Send message
  const sendMessage = useCallback((content: string) => {
    return chatService.sendMessage(content)
  }, [])

  // Disconnect
  const disconnect = useCallback(() => {
    chatService.disconnect()
  }, [])

  // Derived values
  const isConnected = state.connected
  const currentUser = state.currentUser
  const messages = state.messages
  const users = useMemo(() => Array.from(state.users.values()), [state.users])

  return {
    // State
    state,
    isConnected,
    currentUser,
    messages,
    users,
    error,
    isJoining,

    // Actions
    joinChat,
    sendMessage,
    disconnect,
    clearError: () => setError(null),
  }
}
