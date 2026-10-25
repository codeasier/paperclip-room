import type { Agent, LiveRun, Message } from '../api/types';
import { duration } from './format';

/**
 * 对话回合的可见状态：最后一条是用户消息、成员还没回时，界面上必须说清楚
 * 「已送达 / 正在处理 / 排队中」，而不是一片空白。
 */
export type ReplyPhase = 'running' | 'queued' | 'waiting' | 'stalled';

export interface ReplyState {
  phase: ReplyPhase;
  /** 运行已持续或已等待的毫秒数 */
  elapsed: number;
  /** 运行最后一次输出的时间距今毫秒数；没有输出记录时为 undefined */
  sinceOutput?: number;
}

/** 超过这个时长还没有运行接管，就不再假装「马上回复」。 */
export const REPLY_STALL_MS = 90_000;

/** 更早的未回复消息按历史处理，不再常驻提示；正在跑/排队的运行不受此限。 */
export const REPLY_HORIZON_MS = 24 * 60 * 60 * 1000;

function ageMs(now: number, value?: string) {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, now - at) : 0;
}

/** 当前成员身上、属于这条会话的运行（对话会话在侧栏被算作后台运行）。 */
export function chatRun(agent: Agent | undefined, chatId: string | undefined): LiveRun | undefined {
  if (!agent || !chatId) return undefined;
  return (agent.live?.runs || []).find((run) => run.issueId === chatId);
}

export function replyState(input: {
  messages: Message[];
  run?: LiveRun;
  now: number;
}): ReplyState | null {
  const last = [...input.messages].reverse().find((message) => message.author !== 'system');
  if (!last || last.author !== 'user') return null;
  const waited = ageMs(input.now, last.ts);
  const run = input.run;
  if (run?.status === 'running') {
    return {
      phase: 'running',
      elapsed: ageMs(input.now, run.startedAt || run.createdAt) || waited,
      sinceOutput: run.lastOutputAt ? ageMs(input.now, run.lastOutputAt) : undefined,
    };
  }
  if (run?.status === 'queued') return { phase: 'queued', elapsed: waited };
  if (waited > REPLY_HORIZON_MS) return null;
  return { phase: waited >= REPLY_STALL_MS ? 'stalled' : 'waiting', elapsed: waited };
}

export function replyLabel(state: ReplyState, name: string) {
  switch (state.phase) {
    case 'running':
      return `${name} 正在处理…（已 ${duration(state.elapsed)}${
        state.sinceOutput === undefined ? '' : `，${duration(state.sinceOutput)}前有输出`
      }）`;
    case 'queued':
      return `${name} 已在队列中…（已等待 ${duration(state.elapsed)}）`;
    case 'waiting':
      return `已送达，等待 ${name} 处理…（已等待 ${duration(state.elapsed)}）`;
    case 'stalled':
      return `已等待 ${duration(state.elapsed)}，${name} 还没有回复（可能排在其它运行之后）`;
  }
}
