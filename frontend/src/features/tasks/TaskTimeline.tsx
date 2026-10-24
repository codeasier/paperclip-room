import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Select, Tooltip, Typography } from 'antd';
import { LeftOutlined, MinusOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import type { Task } from '../../api/types';
import { dateLabel, duration, runStatuses } from '../../lib/format';
import { placeIntervals, taskIntervals, timeWindow } from '../../lib/timeline';
import { StatusTag, statuses } from '../../components/StatusTag';

interface Props {
  tasks: Task[];
  agentId: string;
  agentName: string;
  onTask: (task: Task) => void;
  onRun: (id: string, task?: Task) => void;
}
export function TaskTimeline({ tasks, agentId, agentName, onTask, onRun }: Props) {
  const [hours, setHours] = useState<number | 'all'>(1);
  const [offset, setOffset] = useState(0);
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(500);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setCanvasWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const intervals = taskIntervals(tasks, agentId);
  const window = timeWindow(intervals, hours, offset);
  const span = window.end - window.start;
  const visible = placeIntervals(
    intervals.filter((interval) => interval.end >= window.start && interval.start <= window.end),
    (span * 16) / Math.max(100, canvasWidth - 170),
  );
  const measuredIds = new Set(intervals.map((interval) => interval.task.id));
  const unmeasured = tasks.filter((task) => !measuredIds.has(task.id));
  const drawnTasks = tasks.filter((task) =>
    visible.some((interval) => interval.task.id === task.id),
  );
  function executionNote(task: Task) {
    const own = task.attempts.filter((run) => run.agentId === agentId);
    if (own.length)
      return `已记录 ${agentName} 的 ${own.length} 次运行，但缺少可用时间，无法绘制时间条。`;
    const latest = [...task.attempts].sort((a, b) =>
      (b.finishedAt || b.startedAt || b.createdAt || '').localeCompare(
        a.finishedAt || a.startedAt || a.createdAt || '',
      ),
    )[0];
    return `当前查询范围暂无 ${agentName} 的运行记录。${latest ? `最近运行记录：${latest.agentName} · ${runStatuses[latest.status] || latest.status}。` : ''}`;
  }
  return (
    <div className="task-timeline">
      <div className="trace-toolbar">
        <span>{agentName} · 执行时间线</span>
        <>
          <Select
            aria-label="时间范围"
            value={hours}
            onChange={(value) => {
              setHours(value);
              setOffset(0);
            }}
            options={[
              { value: 1, label: '最近活动 1 小时' },
              { value: 6, label: '6 小时' },
              { value: 24, label: '24 小时' },
              { value: 'all', label: '全部记录' },
            ]}
          />
          <Button
            aria-label="上一时间窗口"
            icon={<LeftOutlined />}
            disabled={hours === 'all'}
            onClick={() => setOffset(offset - 1)}
          />
          <Button
            aria-label="下一时间窗口"
            icon={<RightOutlined />}
            disabled={hours === 'all' || offset === 0}
            onClick={() => setOffset(Math.min(0, offset + 1))}
          />
          <Button
            aria-label="缩小"
            icon={<MinusOutlined />}
            disabled={zoom === 1}
            onClick={() => setZoom(Math.max(1, zoom / 2))}
          />
          <Typography.Text type="secondary">{zoom}×</Typography.Text>
          <Button
            aria-label="放大"
            icon={<PlusOutlined />}
            disabled={zoom === 64}
            onClick={() => setZoom(Math.min(64, zoom * 2))}
          />
          <Button
            onClick={() => {
              setZoom(1);
              setOffset(0);
            }}
          >
            适应
          </Button>
        </>
      </div>
      <Typography.Paragraph type="secondary">
        {dateLabel(window.start)} — {dateLabel(window.end)} · {visible.length}/{intervals.length}{' '}
        次运行{offset === 0 ? ' · 以最近运行定位' : ''}
      </Typography.Paragraph>
      <div className="trace-scroll">
        <div ref={canvas} className="trace-canvas" style={{ width: `${zoom * 100}%` }}>
          <div className="trace-axis">
            <span>任务 / {agentName}</span>
            <div>
              {Array.from({ length: 5 }, (_, index) => (
                <time key={index} style={{ left: `${10 + index * 20}%` }}>
                  {new Date(window.start + span * (0.1 + index * 0.2)).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                </time>
              ))}
            </div>
          </div>
          {drawnTasks.map((task) => {
            const items = visible.filter((interval) => interval.task.id === task.id);
            const lanes = Math.max(...items.map((interval) => interval.lane)) + 1;
            return (
              <div
                key={task.id}
                className="trace-row"
                style={{ minHeight: Math.max(56, lanes * 30 + 12) }}
              >
                <button className="trace-label" onClick={() => onTask(task)}>
                  <strong>{task.identifier}</strong>
                  <span>{task.title}</span>
                </button>
                <div className="trace-track">
                  {items.map((interval) => {
                    const left = Math.max(0, ((interval.start - window.start) / span) * 100);
                    const width = Math.max(
                      0,
                      ((Math.min(interval.end, window.end) -
                        Math.max(interval.start, window.start)) /
                        span) *
                        100,
                    );
                    return (
                      <Tooltip
                        key={interval.run.id}
                        title={`${interval.run.agentName} · ${interval.run.status} · ${dateLabel(interval.start)}${interval.measured ? ` · ${duration(interval.end - interval.start)}` : ' · 时间点'}`}
                      >
                        <button
                          aria-label={`${task.identifier} 运行 ${interval.run.id}`}
                          data-testid="trace-run"
                          className={`trace-bar ${interval.run.status} ${interval.measured ? '' : 'point'}`}
                          style={{
                            left: `calc(${left}% - ${interval.measured ? 0 : 6}px)`,
                            width: interval.measured ? `max(12px, ${width}%)` : 12,
                            top: 6 + interval.lane * 30,
                          }}
                          onClick={() => onRun(interval.run.id, task)}
                        >
                          {interval.measured && width >= 14
                            ? `${interval.run.status === 'succeeded' ? '运行成功' : statuses[interval.run.status] || interval.run.status} · ${duration(interval.end - interval.start)}`
                            : interval.measured && width >= 6
                              ? duration(interval.end - interval.start)
                              : ''}
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!drawnTasks.length && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="当前时间窗口内暂无可绘制运行"
            />
          )}
        </div>
      </div>
      {unmeasured.length > 0 && (
        <section className="unmeasured-section">
          <Typography.Title level={5}>
            关联任务 · 无可绘制的 {agentName} 执行时间（{unmeasured.length}）
          </Typography.Title>
          {unmeasured.map((task) => (
            <button key={task.id} className="unmeasured-task" onClick={() => onTask(task)}>
              <span className="unmeasured-info">
                <span className="unmeasured-title">
                  <strong>{task.identifier}</strong> {task.title}
                </span>
                <small>{executionNote(task)}</small>
              </span>
              <StatusTag status={task.status} prefix="任务：" />
            </button>
          ))}
        </section>
      )}
      <div className="trace-legend">
        <span className="running">执行中（至当前）</span>
        <span className="succeeded">成功</span>
        <span className="failed">失败 / 超时</span>
        <span className="queued">排队 / 未知区间为时间点</span>
      </div>
      <p className="trace-scope">
        时间条仅表示 {agentName}{' '}
        的实际运行；任务状态不代表正在执行。“全部状态”仍按当前成员和所选时间范围展示运行。全部记录仍受后端查询窗口限制。
      </p>
    </div>
  );
}
