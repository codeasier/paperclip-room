import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Segmented, Select, Typography } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import type {
  Agent,
  ExecutionResponse,
  ExecutionRun,
  RoomEvent,
  Task,
  TasksResponse,
} from '../../api/types';
import { useRoomQuery } from '../../hooks/useRoomQuery';
import { StatusTag } from '../../components/StatusTag';
import { RecordIcon } from '../../components/RecordIcon';
import { MemberAvatar } from '../../components/MemberAvatar';
import { clockLabel, dayLabel, runStatuses } from '../../lib/format';
import { activeStates, filterTasks } from '../../lib/timeline';
import { TaskTimeline } from './TaskTimeline';
import type { Detail } from './DetailDrawer';

interface Row {
  key: string;
  kind: 'task' | 'message' | 'execution';
  task?: Task;
  event?: RoomEvent;
  run?: ExecutionRun;
  ts?: string;
}
interface Props {
  company: string;
  agent: Agent;
  data?: TasksResponse;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
  onDetail: (detail: Detail | null) => void;
  active: boolean;
  selectedDetail: Detail | null;
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
  selectedDetail,
}: Props) {
  const [layout, setLayout] = useState('list');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const stream = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, number>>({ list: 0, trace: 0 });
  const followLatest = useRef(true);
  const room = useRoomQuery<{ events: RoomEvent[] }>('/api/room', company, agent.id, 8000, active);
  const execution = useRoomQuery<ExecutionResponse>(
    '/api/execution',
    company,
    agent.id,
    8000,
    active,
  );
  const tasks = filterTasks(data?.tasks || [], agent.id, search, status);
  const byId = new Map((data?.tasks || []).map((task) => [task.id, task]));
  const byIdentifier = new Map((data?.tasks || []).map((task) => [task.identifier, task]));
  const records: Row[] = [
    ...(room.data?.events || []).map((event) => ({
      key: `${event.kind}:${event.id || event.issueId}`,
      kind: event.kind === 'comment' ? ('message' as const) : ('task' as const),
      event,
      task: byId.get(event.issueId),
      ts: event.ts,
    })),
    ...(execution.data?.runs || []).map((run) => ({
      key: `run:${run.id}`,
      kind: 'execution' as const,
      run,
      task: byIdentifier.get(run.issue || ''),
      ts: run.ts,
    })),
  ];
  const rows = records
    .filter((row) => {
      const title = `${row.task?.identifier || row.event?.issue || row.run?.issue || ''} ${row.task?.title || row.event?.issueTitle || row.event?.title || row.run?.issueTitle || ''}`;
      const taskStatus = row.event?.kind === 'issue' ? row.event.status : row.task?.status;
      const running = row.run
        ? activeStates.has(row.run.status)
        : row.task?.attempts.some(
            (run) => run.agentId === agent.id && activeStates.has(run.status),
          );
      return (
        (!search.trim() || title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) &&
        (status === 'all' ||
          (status === 'active'
            ? running
            : status === 'open'
              ? taskStatus && !['done', 'cancelled'].includes(taskStatus)
              : status === 'done'
                ? ['done', 'cancelled'].includes(taskStatus || '')
                : taskStatus === status))
      );
    })
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const represented = new Set(
    tasks.flatMap((task) =>
      task.attempts.filter((run) => run.agentId === agent.id).map((run) => run.id),
    ),
  );
  const otherRuns = agent.live.runs.filter((run) => !represented.has(run.id));
  useLayoutEffect(() => {
    if (stream.current) stream.current.scrollTop = scrollPositions.current[layout];
  }, [layout]);
  useLayoutEffect(() => {
    if (layout === 'list' && rows.length && followLatest.current && stream.current)
      stream.current.scrollTop = stream.current.scrollHeight;
  }, [layout, rows]);
  function openRow(row: Row) {
    const next: Detail =
      row.kind === 'message'
        ? { kind: 'message', event: row.event! }
        : row.kind === 'execution'
          ? { kind: 'run', runId: row.run!.id }
          : { kind: 'task', taskId: row.task?.id || row.event!.issueId };
    const same =
      selectedDetail?.kind === next.kind &&
      (next.kind === 'message' && selectedDetail.kind === 'message'
        ? next.event.id === selectedDetail.event.id
        : next.kind === 'run' && selectedDetail.kind === 'run'
          ? next.runId === selectedDetail.runId
          : next.kind === 'task' && selectedDetail.kind === 'task'
            ? next.taskId === selectedDetail.taskId
            : false);
    onDetail(same ? null : next);
  }
  return (
    <section className="task-panel">
      <div className="task-controls">
        <Segmented
          aria-label="任务布局"
          value={layout}
          onChange={(next) => {
            if (stream.current) scrollPositions.current[layout] = stream.current.scrollTop;
            setLayout(next);
          }}
          options={[
            { value: 'list', label: '列表' },
            { value: 'trace', label: '时间线' },
          ]}
        />
        <Select
          aria-label="任务状态"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'active', label: '成员执行中' },
            { value: 'open', label: '未完成' },
            { value: 'blocked', label: '受阻' },
            { value: 'done', label: '已完成' },
          ]}
        />
        <Input
          allowClear
          aria-label="搜索任务"
          placeholder="搜索任务编号或标题…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div
        className="task-content"
        ref={stream}
        onScroll={() => {
          const element = stream.current;
          if (!element) return;
          scrollPositions.current[layout] = element.scrollTop;
          if (layout === 'list')
            followLatest.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 90;
        }}
      >
        {pending && !rows.length && <div className="task-skeleton">正在读取任务进展…</div>}
        {error && (
          <Alert
            type="error"
            title="任务读取失败"
            action={<Button onClick={onRetry}>重试</Button>}
          />
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
                  {run.linked ? '任务运行' : '后台运行'} ·{' '}
                  {run.issue || run.taskKey || '心跳 / 对话'}
                </span>
                <StatusTag status={run.status} />
                <Button size="small" onClick={() => onDetail({ kind: 'run', runId: run.id })}>
                  查看运行
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="task-records" hidden={layout !== 'list'}>
          <div className="records-inner">
            <div className="timeline-note">消息与任务默认收起 · 点击在右侧查看详情</div>
            {execution.data && (
              <div className="execution-note">最近 4 次运行 · 工具调用与助手消息在右侧展示</div>
            )}
            {!pending && !room.isPending && !rows.length && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={search || status !== 'all' ? '没有匹配的任务记录' : '暂无任务记录'}
              />
            )}
            {rows.map((row, index) => {
              const issue = row.task?.identifier || row.event?.issue || row.run?.issue || '任务';
              const title =
                row.kind === 'task'
                  ? row.event?.title || row.task?.title || ''
                  : row.kind === 'execution'
                    ? row.run?.issueTitle || ''
                    : row.event?.issueTitle ||
                      row.event?.text?.split('\n').find((line) => line.trim()) ||
                      '';
              const day = dayLabel(row.ts);
              const previousDay = dayLabel(rows[index - 1]?.ts);
              const recipients = row.event?.recipients?.length
                ? row.event.recipients
                : [{ name: `${issue} 讨论区` }];
              const from = row.event?.sender?.name || '成员';
              const to = recipients.map((item) => item.name).join('、');
              const receipt = row.event?.receipt;
              const latest = receipt?.runs[0];
              const receiptText = latest
                ? `${latest.agentName} ${runStatuses[latest.status] || latest.status}`
                : receipt?.state === 'unavailable'
                  ? '回执暂不可用'
                  : '暂无接收记录';
              const selected =
                selectedDetail?.kind === 'message' && row.kind === 'message'
                  ? selectedDetail.event.id === row.event?.id
                  : selectedDetail?.kind === 'run' && row.kind === 'execution'
                    ? selectedDetail.runId === row.run?.id
                    : selectedDetail?.kind === 'task' &&
                      row.kind === 'task' &&
                      (selectedDetail.taskId === (row.task?.id || row.event?.issueId) ||
                        selectedDetail.taskId === (row.task?.identifier || row.event?.issue) ||
                        Boolean(
                          selectedDetail.identifier &&
                          selectedDetail.identifier === (row.task?.identifier || row.event?.issue),
                        ));
              return (
                <Fragment key={row.key}>
                  {day && day !== previousDay && (
                    <div className="day-separator">
                      <span>{day}</span>
                    </div>
                  )}
                  <button
                    className={`record-button ${row.kind} ${selected ? 'active' : ''}`}
                    aria-label={
                      row.kind === 'message'
                        ? `${from} → ${to}：${issue} · ${title || row.event?.text?.split('\n')[0]}`
                        : `${issue} · ${title}`
                    }
                    aria-expanded={selected}
                    onClick={() => openRow(row)}
                  >
                    <RecordIcon kind={row.kind} />
                    {row.kind === 'task' ? (
                      <>
                        <span
                          className={`task-state-bar ${row.event?.status || row.task?.status}`}
                        />
                        <strong>{issue}</strong>
                        <span className="record-title">{title}</span>
                        <StatusTag status={row.event?.status || row.task?.status} />
                      </>
                    ) : (
                      <>
                        {row.kind === 'message' ? (
                          <span className="record-route">
                            <MemberAvatar name={from} size={30} />
                            <span>→</span>
                            {recipients.slice(0, 2).map((recipient, i) =>
                              /讨论区$/.test(recipient.name) ? (
                                <span className="discussion-avatar" key={i}>
                                  #
                                </span>
                              ) : (
                                <MemberAvatar key={i} name={recipient.name} size={30} />
                              ),
                            )}
                          </span>
                        ) : (
                          <MemberAvatar name={agent.name} size={30} />
                        )}
                        <span className="record-title">
                          {issue} · {title || row.event?.text?.split('\n')[0]}
                        </span>
                        {row.kind === 'execution' && (
                          <time>
                            {dayLabel(row.ts)} {clockLabel(row.ts)}
                          </time>
                        )}
                        <span
                          className={`record-receipt ${row.run?.status || latest?.status || ''}`}
                        >
                          {row.kind === 'message'
                            ? receiptText
                            : runStatuses[row.run!.status] || row.run!.status}
                        </span>
                        <RightOutlined className="record-chevron" />
                      </>
                    )}
                  </button>
                </Fragment>
              );
            })}
          </div>
        </div>
        <div className="timeline-container" hidden={layout !== 'trace' || pending}>
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
      </div>
    </section>
  );
}
