import type { Attempt, Task } from '../api/types';

export interface Interval {
  task: Task;
  run: Attempt;
  start: number;
  end: number;
  measured: boolean;
  lane: number;
}
export const activeStates = new Set(['running', 'queued', 'cancelling']);
function timestamp(value?: string) {
  return value ? Date.parse(value) : NaN;
}

export function placeIntervals(intervals: Interval[], minimumDuration = 1): Interval[] {
  const endsByTask = new Map<string, number[]>();
  return [...intervals]
    .sort((a, b) => a.start - b.start || a.end - b.end || a.run.id.localeCompare(b.run.id))
    .map((interval) => {
      const ends = endsByTask.get(interval.task.id) || [];
      let lane = ends.findIndex((end) => end <= interval.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = Math.max(interval.end, interval.start + minimumDuration);
      endsByTask.set(interval.task.id, ends);
      return { ...interval, lane };
    });
}

export function taskIntervals(tasks: Task[], agentId: string, now = Date.now()): Interval[] {
  return tasks.flatMap((task) => {
    const intervals: Interval[] = [];
    for (const run of task.attempts.filter((run) => run.agentId === agentId)) {
      const start = timestamp(run.startedAt);
      const finish = timestamp(run.finishedAt);
      const end = Number.isFinite(finish)
        ? finish
        : ['running', 'cancelling'].includes(run.status)
          ? now
          : NaN;
      const measured = Number.isFinite(start) && Number.isFinite(end) && end >= start;
      const point = Number.isFinite(start) ? start : timestamp(run.createdAt);
      if (!Number.isFinite(point)) continue;
      intervals.push({ task, run, start: point, end: measured ? end : point, measured, lane: 0 });
    }
    return placeIntervals(intervals);
  });
}

export function timeWindow(
  intervals: Interval[],
  hours: number | 'all',
  offset = 0,
  now = Date.now(),
) {
  if (!intervals.length) return { start: now - 3600000, end: now };
  const latest = Math.max(...intervals.map((interval) => interval.end));
  if (hours === 'all') {
    const start = Math.min(...intervals.map((interval) => interval.start));
    const span = Math.max(60000, latest - start);
    return { start: start - span * 0.025, end: start + span * 1.025 };
  }
  const span = hours * 3600000;
  const end = latest + span * 0.025 + offset * span;
  return { start: end - span, end };
}

export function filterTasks(tasks: Task[], agentId: string, search: string, status: string) {
  const query = search.trim().toLocaleLowerCase();
  return tasks.filter(
    (task) =>
      (!query || `${task.identifier} ${task.title}`.toLocaleLowerCase().includes(query)) &&
      (status === 'all' ||
        (status === 'active'
          ? task.attempts.some((run) => run.agentId === agentId && activeStates.has(run.status))
          : status === 'open'
            ? !['done', 'cancelled'].includes(task.status)
            : status === 'done'
              ? ['done', 'cancelled'].includes(task.status)
              : task.status === status)),
  );
}
