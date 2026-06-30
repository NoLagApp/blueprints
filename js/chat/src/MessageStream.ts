import type { ChatMessage, MessageStream as IMessageStream } from './types';

/**
 * Wire payload for the ephemeral `_stream` control topic.
 *
 * Only the live preview travels here (start + coalesced deltas + abort); the
 * authoritative, persisted final message is published on the `messages` topic
 * by `complete()`, which is what finalizes receivers and shows in replay.
 */
export type StreamWirePayload =
  | {
      type: 'start';
      id: string;
      userId: string;
      username: string;
      avatar?: string;
      timestamp: number;
    }
  | { type: 'delta'; id: string; text: string }
  | { type: 'abort'; id: string; error?: string };

/** Callbacks the room wires into the controller. */
export interface MessageStreamHooks {
  /** Publish a control payload on the ephemeral `_stream` topic. */
  publishStream: (payload: StreamWirePayload) => void;
  /** Publish the final, full message on the persisted `messages` topic. */
  publishFinal: (message: ChatMessage) => void;
  emitStart: (message: ChatMessage) => void;
  emitChunk: (message: ChatMessage, delta: string) => void;
  emitEnd: (message: ChatMessage) => void;
  emitAbort: (message: ChatMessage, error?: string) => void;
}

/**
 * Producer-side controller for an outgoing streamed message.
 *
 * `append()` updates the local message immediately and buffers the token; a
 * timer flushes buffered tokens as a single network delta at most every
 * `flushIntervalMs`, so a token-per-character source doesn't flood the broker.
 */
export class MessageStreamController implements IMessageStream {
  readonly message: ChatMessage;

  private _buffer = '';
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _closed = false;

  constructor(
    message: ChatMessage,
    private readonly _flushIntervalMs: number,
    private readonly _hooks: MessageStreamHooks,
  ) {
    this.message = message;

    // Announce the stream so receivers can render a live placeholder at once.
    this._hooks.publishStream({
      type: 'start',
      id: message.id,
      userId: message.userId,
      username: message.username,
      avatar: message.avatar,
      timestamp: message.timestamp,
    });
    this._hooks.emitStart(message);
  }

  append(text: string): void {
    if (this._closed || !text) return;
    this.message.text += text;
    this._buffer += text;
    this._hooks.emitChunk(this.message, text);
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flush(), this._flushIntervalMs);
    }
  }

  complete(): ChatMessage {
    if (this._closed) return this.message;
    this._flush(); // send any buffered tokens
    this._closed = true;
    this._clearTimer();
    this.message.status = 'sent';
    this._hooks.publishFinal(this.message); // persisted final → finalizes receivers
    this._hooks.emitEnd(this.message);
    return this.message;
  }

  abort(error?: string): void {
    if (this._closed) return;
    this._closed = true;
    this._clearTimer();
    this._buffer = '';
    this.message.status = 'aborted';
    this._hooks.publishStream({ type: 'abort', id: this.message.id, error });
    this._hooks.emitAbort(this.message, error);
  }

  private _flush(): void {
    this._clearTimer();
    if (this._buffer) {
      this._hooks.publishStream({
        type: 'delta',
        id: this.message.id,
        text: this._buffer,
      });
      this._buffer = '';
    }
  }

  private _clearTimer(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }
}
