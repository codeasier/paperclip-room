import { describe, expect, it } from 'vitest';
import type { Attempt, Task } from '../api/types';
import { filterTasks, placeIntervals, taskIntervals, timeWindow } from './timeline';

function task(attempts: Attempt[], status = 'in_progress'): Task {
  return {
    id: 't1',
    identifier: 'HER-1',
    title: '并行任务',
    status,
    relation: 'assigned',
    attempts,
    children: { total: 0, done: 0 },
    runs: { total: attempts.length, active: 0, failed: 0 },
    comments: { total: 0, latest: [] },
  };
}
function run(
  id: string,
  start?: string,
  finish?: string,
  status = 'succeeded',
  agentId = 'pl',
): Attempt {
  return { id, agentId, agentName: agentId, status, startedAt: start, finishedAt: finish };
}
const start = '2026-10-22T08:00:00Z';
const end = '2026-10-22T08:05:00Z';

describe('member-specific execution intervals', () => {
  it('excludes other members and places overlapping runs in independent lanes', () => {
    const intervals = taskIntervals(
      [task([run('a', start, end), run('b', start, end), run('qa', start, end, 'running', 'qa')])],
      'pl',
    );
    expect(intervals.map((item) => item.run.id)).toEqual(['a', 'b']);
    expect(intervals.map((item) => item.lane)).toEqual([0, 1]);
  });
  it('extends only live execution to now, never failed runs without an end', () => {
    const intervals = taskIntervals(
      [task([run('live', start, undefined, 'running'), run('failed', start, undefined, 'failed')])],
      'pl',
      Date.parse(end),
    );
    expect(intervals.find((item) => item.run.id === 'live')?.end).toBe(Date.parse(end));
    expect(intervals.find((item) => item.run.id === 'failed')?.measured).toBe(false);
  });
  it('represents queued or reversed timestamps as points and excludes untimed runs', () => {
    const intervals = taskIntervals(
      [
        task([
          { ...run('queue', undefined, undefined, 'queued'), createdAt: start },
          run('bad', end, start),
          run('none'),
        ]),
      ],
      'pl',
    );
    expect(intervals).toHaveLength(2);
    expect(intervals.every((item) => !item.measured && item.end === item.start)).toBe(true);
  });
  it('keeps simultaneous point records in independent lanes', () => {
    expect(
      taskIntervals([task([run('a', start), run('b', start)])], 'pl').map((item) => item.lane),
    ).toEqual([0, 1]);
  });
  it('keeps visually dense but non-overlapping runs independently clickable', () => {
    const intervals = taskIntervals(
      [
        task([
          run('a', start, '2026-10-22T08:00:01Z'),
          run('b', '2026-10-22T08:00:02Z', '2026-10-22T08:00:03Z'),
        ]),
      ],
      'pl',
    );
    expect(intervals.map((item) => item.lane)).toEqual([0, 0]);
    expect(placeIntervals(intervals, 60000).map((item) => item.lane)).toEqual([0, 1]);
  });
  it('anchors recent windows to actual activity rather than idle time until now', () => {
    const intervals = taskIntervals([task([run('a', start, end)])], 'pl');
    const window = timeWindow(intervals, 1, 0, Date.parse('2026-12-01T00:00:00Z'));
    expect(window.end).toBeLessThan(Date.parse(end) + 120000);
    expect(window.end - window.start).toBe(3600000);
    expect(timeWindow(intervals, 1, -1).end).toBe(window.end - 3600000);
  });
  it('does not treat another member running as current member active', () => {
    const tasks = [task([run('qa', start, undefined, 'running', 'qa')])];
    expect(filterTasks(tasks, 'pl', '', 'active')).toEqual([]);
    expect(filterTasks(tasks, 'qa', 'her-1', 'active')).toHaveLength(1);
    expect(filterTasks(tasks, 'pl', 'not found', 'all')).toEqual([]);
  });
});
