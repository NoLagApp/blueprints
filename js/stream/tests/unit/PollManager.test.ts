import { describe, it, expect, vi } from 'vitest';
import { PollManager } from '../../src/PollManager';

describe('PollManager', () => {
  it('should create a poll', () => {
    const mgr = new PollManager();
    const handler = vi.fn();
    mgr.onPollCreated(handler);
    const poll = mgr.createPoll({ question: 'Favorite?', options: ['A', 'B'] }, 'host1');
    expect(poll.question).toBe('Favorite?');
    expect(poll.options.length).toBe(2);
    expect(poll.closed).toBe(false);
    expect(handler).toHaveBeenCalledWith(poll);
  });

  it('should vote on a poll', () => {
    const mgr = new PollManager();
    const handler = vi.fn();
    mgr.onPollUpdated(handler);
    const poll = mgr.createPoll({ question: 'Q?', options: ['A', 'B'] }, 'host1');
    mgr.votePoll(poll.id, 0, 'voter1');
    expect(handler).toHaveBeenCalled();
    expect(mgr.getPoll(poll.id)?.options[0].votes).toBe(1);
    expect(mgr.getPoll(poll.id)?.totalVotes).toBe(1);
  });

  it('should close a poll', () => {
    const mgr = new PollManager();
    const handler = vi.fn();
    mgr.onPollClosed(handler);
    const poll = mgr.createPoll({ question: 'Q?', options: ['A'] }, 'host1');
    mgr.closePoll(poll.id);
    expect(handler).toHaveBeenCalled();
    expect(mgr.getActivePoll()).toBeUndefined();
  });

  it('should not vote on closed poll', () => {
    const mgr = new PollManager();
    const poll = mgr.createPoll({ question: 'Q?', options: ['A'] }, 'host1');
    mgr.closePoll(poll.id);
    expect(mgr.votePoll(poll.id, 0, 'v1')).toBeNull();
  });
});
