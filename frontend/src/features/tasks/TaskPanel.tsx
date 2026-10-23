import { useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import { CommentOutlined, PlayCircleOutlined, ProfileOutlined } from '@ant-design/icons';
import type {
  Agent,
  ExecutionResponse,
  ExecutionRun,
  RoomEvent,
  Task,
  TasksResponse,
} from '../../api/types';
import { useRoomQuery } from '../../hooks/useRoomQuery';
import { StatusTag, statuses } from '../../components/StatusTag';
import { dateLabel } from '../../lib/format';
import { filterTasks } from '../../lib/timeline';
import { TaskTimeline } from './TaskTimeline';
import type { Detail } from './DetailDrawer';

interface Row {
  key: string;
  task?: Task;
  event?: RoomEvent;
  run?: ExecutionRun;
  ts?: string;
}
export function TaskPanel({
  company,
  agent,
  data,
  pending,
  error,
  onRetry,
  onDetail,
  active,
}: {
  company: string;
  agent: Agent;
  data?: TasksResponse;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
  onDetail: (detail: Detail) => void;
  active: boolean;
}) {
  const [layout, setLayout] = useState('list');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const room = useRoomQuery<{ events: RoomEvent[] }>('/api/room', company, agent.id, 8000, active);
  const execution = useRoomQuery<ExecutionResponse>(
    '/api/execution',
    company,
    agent.id,
    8000,
    active,
  );
  const tasks = filterTasks(data?.tasks || [], agent.id, search, status);
  const taskIds = new Set(tasks.map((task) => task.id));
  const identifiers = new Set(tasks.map((task) => task.identifier));
  const allIds = new Set((data?.tasks || []).map((task) => task.id));
  const rows: Row[] = [
    ...tasks.map((task) => ({ key: `task:${task.id}`, task, ts: task.lastActivityAt })),
    ...(room.data?.events || [])
      .filter(
        (event) =>
          event.kind === 'comment' &&
          (taskIds.has(event.issueId) ||
            (!allIds.has(event.issueId) &&
              status === 'all' &&
              (!search ||
                `${event.issue} ${event.issueTitle}`
                  .toLowerCase()
                  .includes(search.toLowerCase())))),
      )
      .map((event) => ({ key: `comment:${event.id}`, event, ts: event.ts })),
    ...(execution.data?.runs || [])
      .filter((run) => identifiers.has(run.issue || ''))
      .map((run) => ({ key: `run:${run.id}`, run, ts: run.ts })),
  ].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const represented = new Set(
    tasks.flatMap((task) =>
      task.attempts.filter((run) => run.agentId === agent.id).map((run) => run.id),
    ),
  );
  const otherRuns = agent.live.runs.filter((run) => !represented.has(run.id));
  return (
    <section className="task-panel">
      {agent.current && (
        <Alert
          type="info"
          title={
            <span>
              当前名下任务：{agent.current.identifier} · {agent.current.title}{' '}
              <StatusTag status={agent.current.status} />
            </span>
          }
          description="任务状态与成员此刻是否执行独立。"
        />
      )}
      <div className="task-controls">
        <Segmented
          aria-label="任务布局"
          value={layout}
          onChange={setLayout}
          options={[
            { value: 'list', label: '列表' },
            { value: 'trace', label: '时间线' },
          ]}
        />
        <Input.Search
          allowClear
          aria-label="搜索任务"
          placeholder="搜索编号或标题"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          aria-label="任务状态"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'active', label: '成员执行中' },
            ...['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled', 'backlog'].map(
              (value) => ({ value, label: statuses[value] }),
            ),
          ]}
        />
      </div>
      {pending && (
        <div className="loading">
          <Spin />
        </div>
      )}
      {error && (
        <Alert type="error" title="任务读取失败" action={<Button onClick={onRetry}>重试</Button>} />
      )}
      {data?.state === 'unavailable' && (
        <Alert type="warning" title={data.note || '任务暂不可用'} />
      )}
      {(room.isError || execution.isError) && (
        <Alert
          type="warning"
          title="部分讨论或执行摘要读取失败，已保留可用任务"
          action={
            <Button
              onClick={() => {
                void room.refetch();
                void execution.refetch();
              }}
            >
              重试
            </Button>
          }
        />
      )}
      {otherRuns.length > 0 && (
        <div className="live-notice">
          <Typography.Text strong>当前视图外的运行</Typography.Text>
          {otherRuns.map((run) => (
            <div className="receipt-row" key={run.id}>
              <span>
                {run.linked ? '任务运行' : '后台运行'} · {run.issue || run.taskKey || '心跳 / 对话'}
              </span>
              <StatusTag status={run.status} />
              <Button size="small" onClick={() => onDetail({ kind: 'run', runId: run.id })}>
                查看运行
              </Button>
            </div>
          ))}
        </div>
      )}
      {!pending && layout === 'list' && (
        <Table<Row>
          rowKey="key"
          dataSource={rows}
          pagination={false}
          size="small"
          locale={{ emptyText: <Empty description="当前查询范围暂无记录" /> }}
          columns={[
            {
              title: '任务 / 消息 / 执行',
              key: 'summary',
              render: (_, row) => (
                <button
                  className="record-button"
                  onClick={() =>
                    row.task
                      ? onDetail({ kind: 'task', taskId: row.task.id })
                      : row.event
                        ? onDetail({ kind: 'message', event: row.event })
                        : row.run && onDetail({ kind: 'run', runId: row.run.id })
                  }
                >
                  {row.task ? (
                    <ProfileOutlined />
                  ) : row.event ? (
                    <CommentOutlined />
                  ) : (
                    <PlayCircleOutlined />
                  )}
                  <span>
                    <strong>{row.task?.identifier || row.event?.issue || row.run?.issue}</strong>{' '}
                    {row.task?.title ||
                      (row.event
                        ? `${row.event.sender?.name || '成员'} → ${row.event.recipients?.map((item) => item.name).join('、') || '任务讨论区'}：${row.event.text?.split('\n')[0] || '消息'}`
                        : row.run?.issueTitle)}
                    {row.run && <small>执行记录 · {row.run.id.slice(0, 8)}</small>}
                  </span>
                </button>
              ),
            },
            {
              title: '状态',
              key: 'status',
              width: 100,
              responsive: ['sm'],
              render: (_, row) =>
                row.event ? (
                  <Typography.Text type="secondary">消息</Typography.Text>
                ) : (
                  <StatusTag status={row.task?.status || row.run?.status} />
                ),
            },
            {
              title: '时间',
              key: 'time',
              width: 165,
              responsive: ['lg'],
              render: (_, row) => (
                <Typography.Text type="secondary">{dateLabel(row.ts)}</Typography.Text>
              ),
            },
          ]}
        />
      )}
      <div hidden={layout !== 'trace' || pending}>
        <TaskTimeline
          tasks={tasks}
          agentId={agent.id}
          agentName={agent.name}
          onTask={(task) => onDetail({ kind: 'task', taskId: task.id })}
          onRun={(runId, task) =>
            onDetail(task ? { kind: 'task', taskId: task.id, runId } : { kind: 'run', runId })
          }
        />
      </div>
      <Space className="scope-note">
        <Typography.Text type="secondary">{data?.note}</Typography.Text>
      </Space>
    </section>
  );
}
