import { describe, expect, it } from 'vitest';
import type { ActivityStep } from '../api/types';
import { activityHint, activityRows, activitySummary, oneLine } from './chatActivity';

function step(overrides: Partial<ActivityStep>): ActivityStep {
  return { id: 's1', kind: 'thinking', text: '思考内容', ...overrides };
}

describe('chat activity rows', () => {
  it('labels each step kind and keeps tool names', () => {
    const rows = activityRows([
      step({ id: 'a', kind: 'thinking', text: '先看工作区' }),
      step({ id: 'b', kind: 'tool_call', text: 'git status', name: 'terminal' }),
      step({ id: 'c', kind: 'tool_result', text: 'clean', name: 'terminal' }),
      step({ id: 'd', kind: 'assistant', text: '完成了' }),
    ]);
    expect(rows.map((row) => row.label)).toEqual(['思考', '工具', '输出', '回复']);
    expect(rows[1]).toMatchObject({ tone: 'tool', name: 'terminal', text: 'git status' });
    expect(rows[3].name).toBeUndefined();
  });

  it('flattens newlines and marks errors', () => {
    const rows = activityRows([
      step({ kind: 'tool_result', text: 'line1\nline2', name: 'terminal', isError: true }),
    ]);
    expect(rows[0].text).toBe('line1 line2');
    expect(rows[0].error).toBe(true);
  });

  it('keeps only the latest row of each kind when collapsed', () => {
    const rows = activitySummary([
      step({ id: 't1', kind: 'thinking', text: '旧思考' }),
      step({ id: 't2', kind: 'thinking', text: '新思考' }),
      step({ id: 'c1', kind: 'tool_call', text: 'old', name: 'terminal' }),
      step({ id: 'c2', kind: 'tool_call', text: 'new', name: 'terminal' }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['t2', 'c2']);
  });

  it('marks empty tool output instead of showing a blank row', () => {
    expect(activityRows([step({ kind: 'tool_result', text: '  ' })])[0].text).toBe('（无输出）');
  });

  it('says what it is waiting for instead of a generic loading line', () => {
    expect(activityHint({ failed: false, state: 'pending' })).toContain('等待模型的第一个输出');
    expect(activityHint({ failed: true, state: 'available' })).toContain('读取失败');
    expect(activityHint({ failed: false, state: 'unavailable', note: '会话库不可读' })).toBe(
      '会话库不可读',
    );
    expect(activityHint({ failed: false })).toBe('正在连接会话…');
  });

  it('truncates long single-line text with an ellipsis', () => {
    expect(oneLine('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
  });
});
