import type { ActivityStep } from '../api/types';

/** 步骤在界面上的分类；只做展示，不改变后端语义。 */
export type ActivityTone = 'thinking' | 'reply' | 'tool' | 'result';

export interface ActivityRow {
  id: string;
  tone: ActivityTone;
  /** 固定分类标签：思考 / 回复 / 工具 / 输出 */
  label: string;
  /** 工具名，仅工具行有 */
  name?: string;
  text: string;
  error?: boolean;
}

const TONES: Record<ActivityStep['kind'], { tone: ActivityTone; label: string }> = {
  thinking: { tone: 'thinking', label: '思考' },
  assistant: { tone: 'reply', label: '回复' },
  tool_call: { tone: 'tool', label: '工具' },
  tool_result: { tone: 'result', label: '输出' },
};

/** 单行化：换行折成空格，避免卡片里出现整段代码。 */
export function oneLine(text: string, limit = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function activityRows(steps: ActivityStep[]): ActivityRow[] {
  return steps.map((step) => {
    const meta = TONES[step.kind];
    const empty = step.kind === 'tool_result' ? '（无输出）' : '（空）';
    return {
      id: step.id,
      tone: meta.tone,
      label: meta.label,
      name: step.kind === 'tool_call' || step.kind === 'tool_result' ? step.name : undefined,
      text: oneLine(step.text) || empty,
      error: step.isError || undefined,
    };
  });
}

/** 折叠态：只留每一类最近的一步，够看清"在想什么、在跑什么命令"。 */
export function activitySummary(steps: ActivityStep[]): ActivityRow[] {
  const rows = activityRows(steps);
  const latest = (tone: ActivityTone) => [...rows].reverse().find((row) => row.tone === tone);
  return [latest('thinking'), latest('tool'), latest('result')].filter((row): row is ActivityRow =>
    Boolean(row),
  );
}

/** 还没有步骤时该说什么：不同原因不能都显示成同一句"加载中"。 */
export function activityHint(input: { failed: boolean; state?: string; note?: string }) {
  if (input.failed) return '过程读取失败，稍后自动重试';
  if (input.state === 'unavailable') return input.note || '暂时读不到这次运行的会话记录';
  if (input.state === 'pending') return '等待模型的第一个输出；写入会话后自动出现';
  return '正在连接会话…';
}
