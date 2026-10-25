import type { ActivityStep, ChatActivityResponse, ChatActivityRun, Message } from '../api/types';

export interface ActivitySource {
  run: ChatActivityRun;
  data?: ChatActivityResponse;
}

interface TimelineBase {
  id: string;
  ts?: string;
  at: number;
}
export type ChatTimelineItem = TimelineBase &
  (
    | { kind: 'message'; message: Message }
    | { kind: 'thinking'; step: ActivityStep }
    | { kind: 'tool'; call?: ActivityStep; result?: ActivityStep; running: boolean }
    | { kind: 'notice'; text: string }
  );

/** Only the closed summary is shortened. Expanded content always keeps its original newlines. */
export function oneLine(text: string, limit = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function timestamp(value?: string) {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

function sameText(a: string, b: string) {
  return a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');
}

/**
 * Merge platform comments and Hermes events, without inventing progress or flattening assistant text.
 * A result belongs to its exact toolCallId, not the nearest tool (parallel calls can finish out of order).
 * Identical published replies replace their transcript counterpart only inside that run's time window.
 */
export function chatTimeline(
  messages: Message[],
  sources: ActivitySource[],
  agentName: string,
): ChatTimelineItem[] {
  const consumed = new Set<string>();
  const events: ChatTimelineItem[] = [];
  const ordered = [...sources].sort(
    (a, b) =>
      (timestamp(a.run.startedAt || a.run.createdAt) || 0) -
      (timestamp(b.run.startedAt || b.run.createdAt) || 0),
  );
  for (const [sourceIndex, { run, data }] of ordered.entries()) {
    const start = timestamp(run.startedAt || run.createdAt);
    const steps = [...(data?.steps || [])].sort(
      (a, b) => (timestamp(a.ts) ?? start ?? 0) - (timestamp(b.ts) ?? start ?? 0),
    );
    const end = timestamp(run.finishedAt);
    const nextStart = timestamp(ordered[sourceIndex + 1]?.run.startedAt);
    const fallback = start ?? timestamp(messages.at(-1)?.ts) ?? 0;
    const tools = new Map<string, Extract<ChatTimelineItem, { kind: 'tool' }>>();
    if (data?.hasEarlierSteps && steps.length) {
      events.push({
        kind: 'notice',
        id: `${run.id}:earlier`,
        ts: steps[0].ts || run.startedAt,
        at: timestamp(steps[0].ts) ?? fallback,
        text: '本次运行较长，仅展示最近 400 条过程事件。',
      });
    }
    for (const [index, step] of steps.entries()) {
      const ts = step.ts || run.startedAt || run.createdAt;
      const base = {
        id: `${run.id}:${step.id}`,
        ts,
        at: timestamp(step.ts) ?? fallback + index / 1000,
      };
      if (step.kind === 'thinking') {
        events.push({ ...base, kind: 'thinking', step });
      } else if (step.kind === 'assistant') {
        const published = !step.truncated
          ? messages.find((message) => {
              const at = timestamp(message.ts);
              return (
                message.author === 'agent' &&
                message.authorName === agentName &&
                !message.truncated &&
                !consumed.has(message.id) &&
                at !== undefined &&
                start !== undefined &&
                at >= start - 2000 &&
                at < Math.min(nextStart ?? Infinity, end === undefined ? Infinity : end + 30_000) &&
                sameText(message.text, step.text)
              );
            })
          : undefined;
        if (published) consumed.add(published.id);
        events.push({
          ...base,
          id: published ? `message:${published.id}` : base.id,
          kind: 'message',
          message: published || {
            id: base.id,
            author: 'agent',
            authorName: agentName,
            ts,
            text: step.text,
            truncated: step.truncated,
          },
        });
      } else if (step.kind === 'tool_call') {
        const event: Extract<ChatTimelineItem, { kind: 'tool' }> = {
          ...base,
          kind: 'tool',
          call: step,
          running: run.status === 'running',
        };
        if (step.toolCallId) tools.set(step.toolCallId, event);
        events.push(event);
      } else {
        const call = step.toolCallId ? tools.get(step.toolCallId) : undefined;
        if (call && !call.result) {
          call.result = step;
        } else {
          // Bounded tails and legacy records may contain a result without its call. Never hide it.
          events.push({ ...base, kind: 'tool', result: step, running: false });
        }
      }
    }
  }
  const comments: ChatTimelineItem[] = messages
    .filter((message) => !consumed.has(message.id))
    .map((message, index) => ({
      id: `message:${message.id}`,
      kind: 'message',
      message,
      ts: message.ts,
      at: timestamp(message.ts) ?? index,
    }));
  // Stable sort preserves source order for reasoning / text / calls sharing a single timestamp.
  return [...comments, ...events].sort((a, b) => a.at - b.at);
}

/** A small inline status hint, never another empty activity card. */
export function activityHint(input: { failed: boolean; state?: string; note?: string }) {
  if (input.failed) return '过程读取失败，稍后自动重试';
  if (input.state === 'unavailable') return input.note || '暂时读不到这次运行的会话记录';
  if (input.state === 'pending') return '等待模型的第一个输出';
  return '正在连接会话…';
}
