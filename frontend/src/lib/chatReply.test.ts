import { describe, expect, it } from 'vitest';
import type { Agent, LiveRun, Message } from '../api/types';
import { chatRun, replyLabel, replyState } from './chatReply';

const now = Date.parse('2026-10-25T02:10:00Z');

function message(author: Message['author'], ts: string, id = author): Message {
  return { id, author, authorName: author === 'user' ? '我' : 'PL', ts, text: '…' };
}

function run(overrides: Partial<LiveRun> = {}): LiveRun {
  return {
    id: 'run-1',
    status: 'running',
    startedAt: '2026-10-25T02:08:00Z',
    createdAt: '2026-10-25T02:08:00Z',
    issueId: 'chat-1',
    linked: false,
    ...overrides,
  };
}

function agent(runs: LiveRun[]): Agent {
  return {
    id: 'pl',
    name: 'PL',
    status: 'running',
    openCount: 0,
    live: { running: 1, queued: 0, taskRunning: 0, backgroundRunning: 1, runs },
  };
}

describe('conversation reply state', () => {
  it('stays silent when the last message is the agent reply', () => {
    const messages = [
      message('user', '2026-10-25T02:00:00Z'),
      message('agent', '2026-10-25T02:01:00Z'),
    ];
    expect(replyState({ messages, now })).toBeNull();
    expect(replyState({ messages: [], now })).toBeNull();
  });

  it('ignores system messages when deciding who spoke last', () => {
    const messages = [
      message('user', '2026-10-25T02:09:30Z'),
      message('system', '2026-10-25T02:09:40Z'),
    ];
    expect(replyState({ messages, now })?.phase).toBe('waiting');
  });

  it('shows waiting immediately, then admits the stall instead of pretending forever', () => {
    const messages = [message('user', '2026-10-25T02:09:30Z')];
    expect(replyState({ messages, now })).toMatchObject({ phase: 'waiting', elapsed: 30_000 });
    const later = Date.parse('2026-10-25T02:11:00Z');
    expect(replyState({ messages, now: later })).toMatchObject({
      phase: 'stalled',
      elapsed: 90_000,
    });
  });

  it('reports the live run so a long turn is visibly still working', () => {
    const state = replyState({
      messages: [message('user', '2026-10-25T02:09:30Z')],
      run: run({ lastOutputAt: '2026-10-25T02:09:50Z' }),
      now,
    });
    expect(state).toMatchObject({ phase: 'running', elapsed: 120_000, sinceOutput: 10_000 });
    expect(replyLabel(state!, 'PL')).toBe('PL 正在处理…（已 2分0秒，10秒前有输出）');
  });

  it('separates a queued wake from an unacknowledged message', () => {
    const messages = [message('user', '2026-10-25T02:09:30Z')];
    const queued = replyState({ messages, run: run({ status: 'queued' }), now });
    expect(queued).toMatchObject({ phase: 'queued' });
    expect(replyLabel(queued!, 'PL')).toBe('PL 已在队列中…（已等待 30秒）');
  });

  it('matches only the run belonging to this conversation', () => {
    const other = run({ id: 'run-2', issueId: 'chat-2' });
    expect(chatRun(agent([other]), 'chat-1')).toBeUndefined();
    expect(chatRun(agent([other, run()]), 'chat-1')?.id).toBe('run-1');
    expect(chatRun(agent([run()]), undefined)).toBeUndefined();
  });

  it('writes honest copy once the agent has gone quiet', () => {
    const state = replyState({ messages: [message('user', '2026-10-25T02:05:00Z')], now });
    expect(replyLabel(state!, 'PL')).toBe('已等待 5分0秒，PL 还没有回复（可能排在其它运行之后）');
  });

  it('treats day-old unanswered messages as history, but keeps a live run visible', () => {
    const stale = [message('user', '2026-10-24T02:00:00Z')];
    expect(replyState({ messages: stale, now })).toBeNull();
    expect(replyState({ messages: stale, run: run(), now })?.phase).toBe('running');
  });
});
