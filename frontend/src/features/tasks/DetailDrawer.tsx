import { useEffect } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Progress,
  Space,
  Typography,
} from 'antd';
import type { RoomEvent, Task } from '../../api/types';
import { Markdown } from '../../components/Markdown';
import { StatusTag } from '../../components/StatusTag';
import { dateLabel } from '../../lib/format';
import { ExecutionProcess } from '../execution/ExecutionProcess';

export type Detail =
  | { kind: 'task'; taskId: string; runId?: string }
  | { kind: 'run'; runId: string }
  | { kind: 'message'; event: RoomEvent };
interface Props {
  company: string;
  agentId: string;
  tasks: Task[];
  detail: Detail;
  onChange: (detail: Detail) => void;
  onClose: () => void;
}
export function DetailDrawer({ company, agentId, tasks, detail, onChange, onClose }: Props) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  const task = detail.kind === 'task' ? tasks.find((task) => task.id === detail.taskId) : undefined;
  const memberRuns =
    task?.attempts
      .filter((run) => run.agentId === agentId)
      .sort((a, b) =>
        (b.startedAt || b.createdAt || '').localeCompare(a.startedAt || a.createdAt || ''),
      ) || [];
  const runId =
    detail.kind === 'run'
      ? detail.runId
      : detail.kind === 'task'
        ? detail.runId || memberRuns[0]?.id
        : undefined;
  return (
    <Drawer
      title={
        detail.kind === 'message' ? '消息详情' : detail.kind === 'task' ? '任务详情' : '运行详情'
      }
      open
      onClose={onClose}
      size={560}
      className="detail-drawer"
      destroyOnHidden
    >
      {detail.kind === 'message' && (
        <>
          <Typography.Title level={4}>
            {detail.event.sender?.name || '成员'} →{' '}
            {detail.event.recipients?.map((item) => item.name).join('、') || '任务讨论区'}
          </Typography.Title>
          <Typography.Paragraph type="secondary">{dateLabel(detail.event.ts)}</Typography.Paragraph>
          <Markdown text={detail.event.text || ''} />
          <Button
            className="section-gap"
            onClick={() => onChange({ kind: 'task', taskId: detail.event.issueId })}
          >
            查看来源任务 {detail.event.issue}
          </Button>
          <Divider />
          <Typography.Title level={5}>精确运行回执</Typography.Title>
          {detail.event.receipt?.state === 'matched' ? (
            detail.event.receipt.runs.map((run) => (
              <div className="receipt-row" key={run.runId}>
                <strong>{run.agentName}</strong>
                <StatusTag status={run.status} />
                <span>{dateLabel(run.startedAt || run.createdAt)}</span>
                {run.agentId === agentId && (
                  <Button size="small" onClick={() => onChange({ kind: 'run', runId: run.runId })}>
                    查看运行
                  </Button>
                )}
              </div>
            ))
          ) : (
            <Alert
              type="info"
              title={
                detail.event.receipt?.state === 'unavailable'
                  ? '回执暂不可用'
                  : '当前有界窗口暂无精确接收记录'
              }
            />
          )}
          <Typography.Paragraph type="secondary" className="section-gap">
            回执按评论 ID + 任务 ID 匹配；运行成功不等于已读或业务验收完成。
          </Typography.Paragraph>
        </>
      )}
      {detail.kind === 'task' &&
        (task ? (
          <>
            <Typography.Text type="secondary">{task.identifier}</Typography.Text>
            <Typography.Title level={4}>{task.title}</Typography.Title>
            <Space wrap>
              <StatusTag status={task.status} />
              <Typography.Text>{task.priority}</Typography.Text>
            </Space>
            <Descriptions
              className="section-gap"
              column={1}
              size="small"
              items={[
                {
                  key: 'relation',
                  label: '关联方式',
                  children:
                    (
                      {
                        assigned: '当前名下',
                        authored: '参与讨论',
                        addressed: '被点名',
                        executed: '实际执行过',
                      } as Record<string, string>
                    )[task.relation] || task.relation,
                },
                { key: 'activity', label: '最近活动', children: dateLabel(task.lastActivityAt) },
                {
                  key: 'runs',
                  label: '已知运行',
                  children: `${task.runs.total} 次 · 活跃 ${task.runs.active} · 失败 ${task.runs.failed}`,
                },
                ...(task.parent
                  ? [
                      {
                        key: 'parent',
                        label: '父任务',
                        children: `${task.parent.identifier} ${task.parent.title}`,
                      },
                    ]
                  : []),
              ]}
            />
            {!!task.children.total && (
              <>
                <Typography.Text>
                  子任务 {task.children.done}/{task.children.total}
                </Typography.Text>
                <Progress percent={Math.round((task.children.done / task.children.total) * 100)} />
              </>
            )}
            {task.checklist && (
              <section className="section-gap">
                <Typography.Title level={5}>
                  检查项 {task.checklist.done}/{task.checklist.total}
                </Typography.Title>
                {task.checklist.items.map((item, index) => (
                  <div key={index}>
                    <Checkbox checked={item.done} disabled>
                      {item.text}
                    </Checkbox>
                  </div>
                ))}
                {(task.checklist.more > 0 || task.checklist.partial) && (
                  <Typography.Text type="secondary">仅展示部分检查项</Typography.Text>
                )}
              </section>
            )}
            <Divider />
            <Typography.Title level={5}>讨论（{task.comments.total}）</Typography.Title>
            {task.comments.latest.map((comment) => (
              <article className="task-comment" key={comment.id}>
                <Space>
                  <strong>{comment.author}</strong>
                  <Typography.Text type="secondary">{dateLabel(comment.ts)}</Typography.Text>
                </Space>
                <Markdown text={comment.text} />
                {comment.truncated && (
                  <Typography.Text type="secondary">评论预览已截断</Typography.Text>
                )}
              </article>
            ))}
            {!task.comments.latest.length && (
              <Typography.Text type="secondary">暂无讨论</Typography.Text>
            )}
            <Divider />
            <Typography.Title level={5}>当前成员运行</Typography.Title>
            <Space wrap>
              {memberRuns.map((run) => (
                <Button
                  key={run.id}
                  type={runId === run.id ? 'primary' : 'default'}
                  size="small"
                  onClick={() => onChange({ kind: 'task', taskId: task.id, runId: run.id })}
                >
                  {dateLabel(run.startedAt || run.createdAt)} · <StatusTag status={run.status} />
                </Button>
              ))}
            </Space>
            {!memberRuns.length && (
              <Alert
                type="info"
                title="当前查询范围暂无该成员的运行记录"
                description={
                  task.attempts.length
                    ? `其他执行成员：${[...new Set(task.attempts.map((run) => run.agentName))].join('、')}`
                    : '不根据任务创建时间推算执行区间。'
                }
              />
            )}
          </>
        ) : (
          <Empty description="该任务不在当前详情查询范围内" />
        ))}
      {runId && (
        <ExecutionProcess
          key={`${agentId}:${runId}`}
          company={company}
          agentId={agentId}
          runId={runId}
        />
      )}
    </Drawer>
  );
}
