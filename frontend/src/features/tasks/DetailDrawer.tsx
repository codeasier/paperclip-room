import { useEffect, useState } from 'react';
import { Button, Drawer } from 'antd';
import type { RoomEvent, Task } from '../../api/types';
import { Markdown } from '../../components/Markdown';
import { MemberAvatar } from '../../components/MemberAvatar';
import { StatusTag } from '../../components/StatusTag';
import { clockLabel, dateLabel, dayLabel, duration, runStatuses } from '../../lib/format';
import { taskIntervals } from '../../lib/timeline';
import { ExecutionProcess } from '../execution/ExecutionProcess';

export type Detail =
  | { kind: 'overview' }
  | {
      kind: 'task';
      taskId: string;
      runId?: string;
      identifier?: string;
      fallbackTitle?: string;
    }
  | { kind: 'run'; runId: string }
  | { kind: 'message'; event: RoomEvent };
interface Props {
  company: string;
  agentId: string;
  agentName: string;
  tasks: Task[];
  detail: Detail;
  onChange: (detail: Detail) => void;
  onClose: () => void;
}
export function DetailDrawer({
  company,
  agentId,
  agentName,
  tasks,
  detail,
  onChange,
  onClose,
}: Props) {
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  const task =
    detail.kind === 'task'
      ? tasks.find(
          (task) =>
            task.id === detail.taskId ||
            task.identifier === detail.taskId ||
            (detail.identifier && task.identifier === detail.identifier),
        )
      : detail.kind === 'run'
        ? tasks.find((task) => task.attempts.some((run) => run.id === detail.runId))
        : undefined;
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
  const elapsed = task
    ? [...new Set(task.attempts.map((run) => run.agentId))]
        .flatMap((id) => taskIntervals([task], id))
        .reduce((sum, interval) => sum + (interval.measured ? interval.end - interval.start : 0), 0)
    : 0;
  return (
    <Drawer
      title="详情"
      open
      onClose={onClose}
      size="100%"
      getContainer={false}
      rootStyle={{ position: 'absolute' }}
      mask={false}
      push={false}
      focusable={{ trap: false }}
      closable={{ placement: 'end' }}
      styles={{ wrapper: { boxShadow: 'none' } }}
      className="detail-drawer"
      destroyOnHidden
    >
      {detail.kind === 'overview' && (
        <div className="detail-empty">
          <strong>详情</strong>
          <span>点击消息、任务或运行查看对应详情。</span>
        </div>
      )}
      {detail.kind === 'message' && (
        <>
          <div className="detail-label">消息详情</div>
          <div className="detail-route">
            <MemberAvatar name={detail.event.sender?.name || '成员'} size={30} />
            <span>→</span>
            {(detail.event.recipients || [{ name: '任务讨论区' }]).slice(0, 2).map((item, index) =>
              /讨论区$/.test(item.name) ? (
                <span className="discussion-avatar" key={index}>
                  #
                </span>
              ) : (
                <MemberAvatar key={index} name={item.name} size={30} />
              ),
            )}
          </div>
          <div className="detail-address">
            {detail.event.sender?.name || '成员'} →{' '}
            {detail.event.recipients?.map((item) => item.name).join('、') || '任务讨论区'}
          </div>
          <div className="detail-topic">
            来源：{detail.event.issue} ·{' '}
            {detail.event.issueTitle || detail.event.text?.split('\n')[0]}
          </div>
          <Button
            type="link"
            className="detail-source"
            onClick={() => onChange({ kind: 'task', taskId: detail.event.issueId })}
          >
            查看来源任务 {detail.event.issue}
          </Button>
          <div className="detail-time">
            {dayLabel(detail.event.ts)} {clockLabel(detail.event.ts)}
          </div>
          <div className="receipt-panel">
            {detail.event.receipt?.state === 'matched' ? (
              <>
                <strong>关联执行回执</strong>
                {detail.event.receipt.runs.map((run) => (
                  <div className="receipt-row" key={run.runId}>
                    <strong>
                      {run.agentName} · {runStatuses[run.status] || run.status}
                    </strong>
                    <small>
                      开始：{dateLabel(run.startedAt)} · 结束：{dateLabel(run.finishedAt)}
                    </small>
                    <small>运行：{run.runId}</small>
                    {run.agentId === agentId && (
                      <Button
                        size="small"
                        onClick={() => onChange({ kind: 'run', runId: run.runId })}
                      >
                        查看运行
                      </Button>
                    )}
                  </div>
                ))}
              </>
            ) : (
              <>
                <strong>
                  {detail.event.receipt?.state === 'unavailable' ? '回执暂不可用' : '暂无接收记录'}
                </strong>
                <div className="receipt-note">
                  {detail.event.receipt?.state === 'unavailable'
                    ? '运行记录获取失败，可等待自动刷新。'
                    : '当前有界窗口暂无精确接收记录；不能据此判断无人接收。'}
                </div>
              </>
            )}
            <div className="receipt-note">
              仅查询最近 200 条运行，非完整历史；运行状态不等于逐条已读或业务验收。
            </div>
          </div>
          <Markdown text={detail.event.text || ''} />
        </>
      )}
      {(detail.kind === 'task' || detail.kind === 'run') && (
        <>
          <div className="detail-label">
            {task ? (runId ? '运行与任务详情' : '任务详情') : '运行详情'}
          </div>
          <h3 className="detail-title">
            {task
              ? `${task.identifier} · ${task.title}`
              : detail.kind === 'task' && detail.identifier
                ? `${detail.identifier}${detail.fallbackTitle ? ` · ${detail.fallbackTitle}` : ''}`
                : '运行过程'}
          </h3>
          {task && (
            <div className="detail-task-meta-bar">
              <div className="detail-task-status">
                <span>任务：</span>
                <StatusTag status={task.status} />
              </div>
              <span className="detail-priority-badge">
                优先级{' '}
                {
                  (
                    { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' } as Record<
                      string,
                      string
                    >
                  )[task.priority || 'medium']
                }
              </span>
              {elapsed > 0 && (
                <span className="detail-elapsed-badge">累计 {duration(elapsed)}</span>
              )}
            </div>
          )}
          {runId ? (
            <ExecutionProcess
              key={`${agentId}:${runId}`}
              company={company}
              agentId={agentId}
              runId={runId}
              agentName={agentName}
            />
          ) : (
            <div className="detail-no-run">
              {task
                ? `当前查询范围暂无 ${agentName} 的运行记录。${task.attempts.length ? `最近运行记录：${task.attempts[0].agentName} · ${runStatuses[task.attempts[0].status] || task.attempts[0].status}。` : ''}`
                : '该任务不在当前详情查询范围内。'}
            </div>
          )}
          {task && (
            <div className="task-detail-facts">
              <div className="task-facts">
                优先级{' '}
                {
                  (
                    { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' } as Record<
                      string,
                      string
                    >
                  )[task.priority || 'medium']
                }
                {elapsed > 0 && (
                  <>
                    <br />
                    窗口内累计执行 {duration(elapsed)}（并行运行分别计时）
                  </>
                )}
                {task.relation === 'executed' && (
                  <>
                    <br />
                    你曾执行过该任务（当前查询窗口内）
                  </>
                )}
                {task.relation === 'authored' && (
                  <>
                    <br />
                    你在该任务中发过言
                  </>
                )}
                {task.relation === 'addressed' && (
                  <>
                    <br />
                    该任务的消息点名了你
                  </>
                )}
                {task.parent && (
                  <>
                    <br />
                    父任务 {task.parent.identifier}
                  </>
                )}
                {!!task.children.total && (
                  <>
                    <br />
                    子任务 {task.children.done}/{task.children.total} 完成
                  </>
                )}
              </div>
              {task.checklist && (
                <>
                  <div className="task-sub">
                    检查项 {task.checklist.done}/{task.checklist.total}
                    {task.checklist.partial ? ' · 描述已截断' : ''}
                  </div>
                  <div className="task-checks">
                    {task.checklist.items.map((item, index) => (
                      <div className={`task-check ${item.done ? 'done' : ''}`} key={index}>
                        <span aria-hidden="true">{item.done ? '✓' : '○'}</span>
                        <span>{item.text}</span>
                      </div>
                    ))}
                  </div>
                  {task.checklist.more > 0 && (
                    <div className="task-facts">另有 {task.checklist.more} 项检查项未展示。</div>
                  )}
                </>
              )}
              {!!task.comments.latest.length && (
                <>
                  <div className="task-sub">最近讨论</div>
                  {[...task.comments.latest].reverse().map((comment) => {
                    const isLong = comment.text.length > 180 || comment.text.split('\n').length > 4;
                    const isExpanded = Boolean(expandedComments[comment.id]);
                    return (
                      <article className="task-comment" key={comment.id}>
                        <div className="who">
                          <strong>{comment.author}</strong>
                          <span>
                            {dayLabel(comment.ts)} {clockLabel(comment.ts)}
                          </span>
                          {isLong && (
                            <button
                              type="button"
                              className="comment-expand-btn"
                              onClick={() =>
                                setExpandedComments((prev) => ({
                                  ...prev,
                                  [comment.id]: !prev[comment.id],
                                }))
                              }
                            >
                              {isExpanded ? '收起' : '展开'}
                            </button>
                          )}
                        </div>
                        <div className={`task-comment-text ${isExpanded ? 'expanded' : ''}`}>
                          <Markdown text={comment.text} />
                        </div>
                        {comment.truncated && <div className="task-facts">内容过长，已截断。</div>}
                      </article>
                    );
                  })}
                </>
              )}
              {!!task.runs.total && (
                <>
                  <div className="task-sub">运行（任务内所有成员）</div>
                  <div className="task-facts">
                    最近 {runStatuses[task.runs.lastStatus || ''] || '状态未知'} · 共{' '}
                    {task.runs.total} 次{task.runs.failed ? `，失败 ${task.runs.failed} 次` : ''}
                  </div>
                  {task.runs.lastError && <div className="task-error">{task.runs.lastError}</div>}
                </>
              )}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
