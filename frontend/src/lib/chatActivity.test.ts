import { describe, expect, it } from 'vitest';
import type { ActivityStep, Message } from '../api/types';
import { activityHint, chatTimeline, oneLine, type ActivitySource } from './chatActivity';

const iso = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 5, 0, seconds)).toISOString();
function step(id: string, kind: ActivityStep['kind'], seconds: number, text = id): ActivityStep {
  return { id, kind, ts: iso(seconds), text };
}
function source(
  steps: ActivityStep[],
  overrides: Partial<ActivitySource['run']> = {},
): ActivitySource {
  return {
    run: { id: 'run-1', status: 'running', startedAt: iso(0), ...overrides },
    data: { state: 'available', steps },
  };
}
function message(id: string, author: Message['author'], seconds: number, text = id): Message {
  return { id, author, authorName: author === 'user' ? '我' : 'PL', ts: iso(seconds), text };
}

describe('chat event stream', () => {
  it('interleaves thinking, assistant prose, tools and published comments chronologically', () => {
    const events = chatTimeline(
      [message('ask', 'user', 0), message('reply', 'agent', 10)],
      [
        source([
          step('think', 'thinking', 1),
          step('prose', 'assistant', 2, '**先检查**，再继续。'),
          step('call', 'tool_call', 3),
          step('think-2', 'thinking', 4),
          step('prose-2', 'assistant', 5),
        ]),
      ],
      'PL',
    );
    expect(events.map((event) => event.kind)).toEqual([
      'message',
      'thinking',
      'message',
      'tool',
      'thinking',
      'message',
      'message',
    ]);
    expect(events[2]).toMatchObject({ message: { text: '**先检查**，再继续。', author: 'agent' } });
  });

  it('preserves source order when reasoning, prose and calls share a timestamp', () => {
    const events = chatTimeline(
      [message('ask', 'user', 0)],
      [source([step('r', 'thinking', 1), step('m', 'assistant', 1), step('t', 'tool_call', 1)])],
      'PL',
    );
    expect(events.map((event) => event.kind)).toEqual(['message', 'thinking', 'message', 'tool']);
  });

  it('keeps full multiline text for expanded thinking, commands and outputs', () => {
    const text = `first line\n${'long content '.repeat(100)}\nlast line`;
    const events = chatTimeline([], [source([step('r', 'thinking', 1, text)])], 'PL');
    expect(events[0]).toMatchObject({ step: { text } });
    expect(oneLine(text, 30)).not.toContain('\n');
    expect(oneLine(text, 30)).toHaveLength(30);
  });

  it('pairs parallel same-name tools by call ID even when results finish in reverse order', () => {
    const events = chatTimeline(
      [],
      [
        source([
          { ...step('a', 'tool_call', 1), toolCallId: 'call-a', name: 'terminal' },
          { ...step('b', 'tool_call', 2), toolCallId: 'call-b', name: 'terminal' },
          { ...step('br', 'tool_result', 3, 'B output'), toolCallId: 'call-b' },
          { ...step('ar', 'tool_result', 4, 'A error'), toolCallId: 'call-a', isError: true },
        ]),
      ],
      'PL',
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      call: { id: 'a' },
      result: { text: 'A error', isError: true },
    });
    expect(events[1]).toMatchObject({ call: { id: 'b' }, result: { text: 'B output' } });
  });

  it('sorts timestamped events before pairing results from an unsorted response', () => {
    const events = chatTimeline(
      [],
      [
        source([
          { ...step('result', 'tool_result', 3), toolCallId: 'call' },
          step('prose', 'assistant', 1),
          { ...step('tool', 'tool_call', 2), toolCallId: 'call' },
        ]),
      ],
      'PL',
    );
    expect(events.map((event) => event.kind)).toEqual(['message', 'tool']);
    expect(events[1]).toMatchObject({ result: { id: 'result' } });
  });

  it('does not pair unknown or missing result IDs with an unrelated tool', () => {
    const events = chatTimeline(
      [],
      [
        source([
          { ...step('a', 'tool_call', 1), toolCallId: 'a' },
          { ...step('r', 'tool_result', 2), toolCallId: 'b' },
          step('legacy', 'tool_result', 3),
        ]),
      ],
      'PL',
    );
    expect(events).toHaveLength(3);
    expect(events[0]).not.toHaveProperty('result');
    expect(events[1]).toMatchObject({ result: { id: 'r' } });
  });

  it('namespaces events and tool IDs by run so separate turns cannot overwrite each other', () => {
    const a = source([{ ...step('tool', 'tool_call', 1), toolCallId: 'same' }]);
    const b = source([{ ...step('output', 'tool_result', 8), toolCallId: 'same' }], {
      id: 'run-2',
      startedAt: iso(7),
    });
    const events = chatTimeline([], [b, a], 'PL');
    expect(events.map((event) => event.id)).toEqual(['run-1:tool', 'run-2:output']);
    expect(events[0]).not.toHaveProperty('result');
  });

  it('keeps completed run events and stops calling unfinished tools running', () => {
    const events = chatTimeline(
      [],
      [
        source([step('tool', 'tool_call', 1)], {
          status: 'succeeded',
          finishedAt: iso(5),
        }),
      ],
      'PL',
    );
    expect(events[0]).toMatchObject({ kind: 'tool', running: false });
  });

  it('shows explicit history and content truncation flags instead of hiding the boundary', () => {
    const input = source([{ ...step('r', 'thinking', 2), truncated: true }]);
    input.data!.hasEarlierSteps = true;
    const events = chatTimeline([], [input], 'PL');
    expect(events[0]).toMatchObject({ kind: 'notice', text: expect.stringContaining('400') });
    expect(events[1]).toMatchObject({ step: { truncated: true } });
  });

  it('deduplicates a published reply only inside its own run and keeps its stable comment ID', () => {
    const events = chatTimeline(
      [
        message('old', 'agent', -20, '完成了'),
        message('ask', 'user', 0),
        message('final', 'agent', 6, '完成了'),
      ],
      [
        source([step('done', 'assistant', 5, '完成了')], {
          status: 'succeeded',
          finishedAt: iso(7),
        }),
      ],
      'PL',
    );
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ id: 'message:final', at: Date.parse(iso(5)) });
    expect(events[0]).toMatchObject({ id: 'message:old' });
  });

  it('does not deduplicate another agent, next turn or truncated text', () => {
    const reply = message('final', 'agent', 3, 'same');
    for (const changed of [
      { ...reply, authorName: 'QA' },
      { ...reply, truncated: true },
    ]) {
      expect(
        chatTimeline([changed], [source([step('text', 'assistant', 2, 'same')])], 'PL'),
      ).toHaveLength(2);
    }
    const events = chatTimeline(
      [message('next-reply', 'agent', 10, 'same')],
      [
        source([step('text', 'assistant', 2, 'same')], { finishedAt: iso(3) }),
        source([], { id: 'run-2', startedAt: iso(8) }),
      ],
      'PL',
    );
    expect(events).toHaveLength(2);
  });

  it('consumes a published reply at most once when a transcript repeats the same sentence', () => {
    const events = chatTimeline(
      [message('final', 'agent', 5, 'same')],
      [source([step('m1', 'assistant', 1, 'same'), step('m2', 'assistant', 2, 'same')])],
      'PL',
    );
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });

  it('keeps normal chat usable when run discovery or activity reads are unavailable', () => {
    const comments = [message('ask', 'user', 0), message('reply', 'agent', 4)];
    expect(chatTimeline(comments, [], 'PL').map((event) => event.id)).toEqual([
      'message:ask',
      'message:reply',
    ]);
    expect(chatTimeline(comments, [{ run: { id: 'r', status: 'running' } }], 'PL')).toHaveLength(2);
  });

  it('uses run start plus source order when legacy events have no timestamps', () => {
    const events = chatTimeline(
      [message('ask', 'user', 0)],
      [
        source([
          { id: 'r', kind: 'thinking', text: 'first' },
          { id: 'm', kind: 'assistant', text: 'second' },
        ]),
      ],
      'PL',
    );
    expect(events.map((event) => event.kind)).toEqual(['message', 'thinking', 'message']);
    expect(events[1].at).toBeLessThan(events[2].at);
  });
});

describe('chat activity hint and summary', () => {
  it('explains empty/pending/unavailable reads without inventing an event', () => {
    expect(activityHint({ failed: false, state: 'pending' })).toContain('等待模型的第一个输出');
    expect(activityHint({ failed: true, state: 'available' })).toContain('读取失败');
    expect(activityHint({ failed: false, state: 'unavailable', note: '会话库不可读' })).toBe(
      '会话库不可读',
    );
    expect(activityHint({ failed: false, state: 'unavailable' })).toContain('暂时读不到');
    expect(activityHint({ failed: false })).toBe('正在连接会话…');
  });

  it('shortens only the single-line summary', () => {
    expect(oneLine('line one\n  line two')).toBe('line one line two');
    expect(oneLine('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
  });
});
