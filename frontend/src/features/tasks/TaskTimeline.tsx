import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Select, Space, Tooltip, Typography } from 'antd';
import { LeftOutlined, MinusOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import type { Task } from '../../api/types';
import { dateLabel, duration } from '../../lib/format';
import { placeIntervals, taskIntervals, timeWindow } from '../../lib/timeline';
import { StatusTag } from '../../components/StatusTag';

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
  return (
    <div className="task-timeline">
      <div className="trace-toolbar">
        <Space wrap>
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
            disabled={hours === 'all'}
            onClick={() => setOffset(offset + 1)}
          />
          <Button
            aria-label="缩小"
            icon={<MinusOutlined />}
            disabled={zoom === 1}
            onClick={() => setZoom(Math.max(1, zoom / 2))}
          />
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
          <Typography.Text type="secondary">{zoom}×</Typography.Text>
        </Space>
      </div>
      <Typography.Paragraph type="secondary">
        {dateLabel(window.start)} — {dateLabel(window.end)} · 当前成员已知执行累计{' '}
        {duration(
          visible.reduce(
            (sum, interval) =>
              sum +
              (interval.measured
                ? Math.max(
                    0,
                    Math.min(interval.end, window.end) - Math.max(interval.start, window.start),
                  )
                : 0),
            0,
          ),
        )}
      </Typography.Paragraph>
      <div className="trace-scroll">
        <div ref={canvas} className="trace-canvas" style={{ width: `${zoom * 100}%` }}>
          <div className="trace-axis">
            <span>任务 / 真实运行</span>
            <div>
              {Array.from({ length: 5 }, (_, index) => (
                <time key={index} style={{ left: `${index * 25}%` }}>
                  {new Date(window.start + (span * index) / 4).toLocaleTimeString('zh-CN', {
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
                style={{ minHeight: Math.max(64, lanes * 34 + 16) }}
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
                            top: 8 + interval.lane * 34,
                          }}
                          onClick={() => onRun(interval.run.id, task)}
                        >
                          {interval.measured ? '运行' : ''}
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
        <section className="section-gap">
          <Typography.Title level={5}>暂无可绘制时间的关联任务</Typography.Title>
          {unmeasured.map((task) => (
            <button key={task.id} className="unmeasured-task" onClick={() => onTask(task)}>
              <span>
                <strong>{task.identifier}</strong> {task.title}
              </span>
              <StatusTag status={task.status} />
              <small>
                {task.attempts.some((run) => run.agentId === agentId)
                  ? `已记录 ${agentName} 的运行，但缺少可用时间`
                  : `暂无 ${agentName} 的运行记录`}
                {task.attempts.some((run) => run.agentId !== agentId)
                  ? `；其他成员：${[...new Set(task.attempts.filter((run) => run.agentId !== agentId).map((run) => run.agentName))].join('、')}`
                  : ''}
              </small>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
