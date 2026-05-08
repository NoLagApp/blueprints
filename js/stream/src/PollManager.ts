import type { Poll, PollVote, CreatePollOptions } from './types';
import { generateId } from './utils';

/**
 * Manages poll state for a stream room.
 *
 * Handles local poll creation, remote poll sync, vote recording,
 * and poll lifecycle (open → closed).
 */
export class PollManager {
  private _polls = new Map<string, Poll>();
  private _activePollId: string | null = null;

  private _onPollCreated: ((poll: Poll) => void) | null = null;
  private _onPollUpdated: ((poll: Poll) => void) | null = null;
  private _onPollClosed: ((poll: Poll) => void) | null = null;

  onPollCreated(cb: (poll: Poll) => void): void {
    this._onPollCreated = cb;
  }

  onPollUpdated(cb: (poll: Poll) => void): void {
    this._onPollUpdated = cb;
  }

  onPollClosed(cb: (poll: Poll) => void): void {
    this._onPollClosed = cb;
  }

  /**
   * Create a new poll (initiated locally — e.g. by host/moderator).
   * Returns the Poll object. Caller is responsible for publishing it.
   */
  createPoll(opts: CreatePollOptions, createdBy: string): Poll {
    const poll: Poll = {
      id: generateId(),
      question: opts.question,
      options: opts.options.map((text) => ({ text, votes: 0 })),
      createdBy,
      closed: false,
      totalVotes: 0,
      timestamp: Date.now(),
    };

    this._polls.set(poll.id, poll);
    this._activePollId = poll.id;
    this._onPollCreated?.(poll);

    return poll;
  }

  /**
   * Handle a poll received from a remote source (create or update).
   * The data shape mirrors the Poll interface.
   */
  handleRemotePoll(data: unknown): void {
    const raw = data as Record<string, unknown>;
    const pollId = raw.id as string;
    if (!pollId) return;

    const existing = this._polls.get(pollId);

    const poll: Poll = {
      id: pollId,
      question: raw.question as string,
      options: (raw.options as Array<{ text: string; votes: number }>).map((o) => ({
        text: o.text,
        votes: o.votes ?? 0,
      })),
      createdBy: raw.createdBy as string,
      closed: (raw.closed as boolean) ?? false,
      totalVotes: raw.totalVotes as number ?? 0,
      timestamp: raw.timestamp as number ?? Date.now(),
    };

    this._polls.set(poll.id, poll);

    if (!poll.closed) {
      this._activePollId = poll.id;
    } else if (this._activePollId === poll.id) {
      this._activePollId = null;
    }

    if (!existing) {
      this._onPollCreated?.(poll);
    } else if (poll.closed && !existing.closed) {
      this._onPollClosed?.(poll);
    } else {
      this._onPollUpdated?.(poll);
    }
  }

  /**
   * Record a vote locally (optimistic) and return the updated poll.
   * Does not publish — caller handles publishing.
   */
  votePoll(pollId: string, optionIndex: number, viewerId: string): Poll | null {
    const poll = this._polls.get(pollId);
    if (!poll || poll.closed) return null;
    if (optionIndex < 0 || optionIndex >= poll.options.length) return null;

    poll.options[optionIndex].votes += 1;
    poll.totalVotes += 1;

    this._onPollUpdated?.(poll);
    return poll;
  }

  /**
   * Handle a remote vote.
   */
  handleRemoteVote(vote: PollVote): void {
    const poll = this._polls.get(vote.pollId);
    if (!poll || poll.closed) return;
    if (vote.optionIndex < 0 || vote.optionIndex >= poll.options.length) return;

    poll.options[vote.optionIndex].votes += 1;
    poll.totalVotes += 1;

    this._onPollUpdated?.(poll);
  }

  /**
   * Close a poll (locally initiated — e.g. by host/moderator).
   * Returns the closed poll or null if not found.
   */
  closePoll(pollId: string): Poll | null {
    const poll = this._polls.get(pollId);
    if (!poll) return null;

    poll.closed = true;
    if (this._activePollId === pollId) {
      this._activePollId = null;
    }

    this._onPollClosed?.(poll);
    return poll;
  }

  /**
   * Get the currently active (open) poll, if any.
   */
  getActivePoll(): Poll | undefined {
    if (!this._activePollId) return undefined;
    return this._polls.get(this._activePollId);
  }

  /**
   * Get a poll by ID.
   */
  getPoll(id: string): Poll | undefined {
    return this._polls.get(id);
  }

  /**
   * Clean up state.
   */
  dispose(): void {
    this._polls.clear();
    this._activePollId = null;
    this._onPollCreated = null;
    this._onPollUpdated = null;
    this._onPollClosed = null;
  }
}
