import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Alert, Button, Collapse, Empty, Typography } from 'antd';
import { apiUrl, getJSON } from '../../api/client';
import type { ExecutionRun, TranscriptEntry } from '../../api/types';
import { Markdown } from '../../components/Markdown';
import { dateLabel, runStatuses } from '../../lib/format';

export function ExecutionProcess({
  company,
  agentId,
  runId,
  agentName,
}: {
  company: string;
  agentId: string;
  runId: string;
  agentName: string;
}) {
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const [hideTools, setHideTools] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ['/api/run', company, agentId, runId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      getJSON<ExecutionRun>(
        apiUrl('/api/run', company, { agent: agentId, run: runId, before: pageParam || undefined }),
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) =>
      ['running', 'queued', 'cancelling'].includes(query.state.data?.pages[0]?.status || '')
        ? 8000
        : false,
  });
  if (query.isPending) return <div className="task-note">正在读取工具调用与助手消息…</div>;
  if (!query.data)
    return (
      <Alert
        type="error"
        title="运行过程读取失败"
        description={<Button onClick={() => void query.refetch()}>重试</Button>}
      />
    );
  const run = query.data.pages[0];
  const entries = [
    ...new Map(
      [...query.data.pages]
        .reverse()
        .flatMap((page) => page.entries)
        .map((entry) => [entry.id, entry]),
    ).values(),
  ];
  const results = new Map(
    entries
      .filter((entry) => entry.kind === 'tool_result' && entry.toolCallId)
      .map((entry) => [entry.toolCallId, entry]),
  );
  const calls = new Set(
    entries.filter((entry) => entry.kind === 'tool_call').map((entry) => entry.toolCallId),
  );
  const toolEntryIds = entries
    .filter(
      (entry) =>
        entry.kind === 'tool_call' ||
        (entry.kind === 'tool_result' && !calls.has(entry.toolCallId)),
    )
    .map((entry) => entry.id);
  const allExpanded = toolEntryIds.length > 0 && toolEntryIds.every((id) => openKeys.includes(id));
  const toolBody = (entry: TranscriptEntry) => (
    <>
      <pre>{entry.text}</pre>
      {entry.truncated && <Typography.Text type="warning">内容已截断</Typography.Text>}
    </>
  );
  return (
    <section className="execution-process">
      <div className="run-meta">
        <strong>
          {agentName} · {runStatuses[run.status] || run.status}
        </strong>
        <div className="task-facts">
          开始：{dateLabel(run.ts)}
          <br />
          结束：
          {run.finishedAt
            ? dateLabel(run.finishedAt)
            : ['running', 'cancelling'].includes(run.status)
              ? '执行中'
              : '未记录'}
          <br />
          运行：{runId}
        </div>
      </div>
      <div className="execution-heading-row">
        <Typography.Title level={5}>工具调用与助手消息</Typography.Title>
        {toolEntryIds.length >= 2 && (
          <div className="execution-tools-actions">
            <button
              type="button"
              className="execution-action-link"
              onClick={() => {
                setHideTools(false);
                setOpenKeys(allExpanded ? [] : toolEntryIds);
              }}
            >
              {allExpanded ? '收起全部参数' : `展开全部 (${toolEntryIds.length})`}
            </button>
            {toolEntryIds.length >= 4 && (
              <button
                type="button"
                className="execution-action-link"
                onClick={() => setHideTools((prev) => !prev)}
              >
                {hideTools ? `显示 ${toolEntryIds.length} 条工具调用` : '仅看助手结论'}
              </button>
            )}
          </div>
        )}
      </div>
      {run.state !== 'available' && (
        <div className="execution-warning">
          {run.note || '会话详情不可用，仅展示已记录的运行结果。'}
        </div>
      )}
      {run.error && <Alert type="error" title={run.error} />}
      {query.isError && (
        <Alert
          type="warning"
          title="过程刷新或分页失败，保留已读取内容"
          action={
            <Button
              onClick={() => void (query.hasNextPage ? query.fetchNextPage() : query.refetch())}
            >
              重试
            </Button>
          }
        />
      )}
      {query.hasNextPage && (
        <Button
          className="execution-more"
          aria-label="加载本次运行更早的过程"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载本次运行更早的过程
        </Button>
      )}
      {entries.map((entry) => {
        if (entry.kind === 'assistant')
          return (
            <article className="assistant-output" key={entry.id}>
              <Typography.Text type="secondary">助手 · {dateLabel(entry.ts)}</Typography.Text>
              <Markdown text={entry.text} />
              {entry.truncated && <Typography.Text type="warning">内容已截断</Typography.Text>}
            </article>
          );
        if (entry.kind === 'tool_result' && calls.has(entry.toolCallId)) return null;
        if (hideTools) return null;
        const result = entry.kind === 'tool_call' ? results.get(entry.toolCallId) : entry;
        const terminal = !['running', 'queued', 'cancelling'].includes(run.status);
        let preview = entry.text;
        try {
          const args = JSON.parse(entry.text);
          preview = args.command || args.path || args.query || preview;
        } catch {
          /* plain tool arguments */
        }
        const isOpen = openKeys.includes(entry.id);
        return (
          <Collapse
            key={entry.id}
            className="tool-step"
            size="small"
            activeKey={isOpen ? [entry.id] : []}
            onChange={() =>
              setOpenKeys((prev) =>
                prev.includes(entry.id) ? prev.filter((k) => k !== entry.id) : [...prev, entry.id],
              )
            }
            expandIcon={() => (
              <span className="tool-result-icon">
                {result ? (result.isError ? '!' : '✓') : '›'}
              </span>
            )}
            items={[
              {
                key: entry.id,
                label: (
                  <span className="tool-label">
                    <strong>{entry.name || '工具'}</strong>
                    <span className="tool-preview">{preview}</span>
                    <Typography.Text type={result?.isError ? 'danger' : 'secondary'}>
                      {result
                        ? result.isError
                          ? '执行报错'
                          : '已返回'
                        : terminal
                          ? '未记录结果'
                          : '执行中'}
                    </Typography.Text>
                    <span className="tool-chevron" aria-hidden="true">
                      {isOpen ? '▾' : '▸'}
                    </span>
                  </span>
                ),
                children: (
                  <>
                    {entry.kind === 'tool_call' && (
                      <>
                        <Typography.Text strong>参数</Typography.Text>
                        {toolBody(entry)}
                      </>
                    )}
                    {result && (
                      <>
                        <Typography.Text strong>返回结果</Typography.Text>
                        {toolBody(result)}
                      </>
                    )}
                  </>
                ),
              },
            ]}
          />
        );
      })}
      {run.summary?.text &&
      !entries.some(
        (entry) => entry.kind === 'assistant' && entry.text.trim() === run.summary!.text.trim(),
      ) ? (
        <article className="assistant-output">
          <Typography.Text type="secondary">平台最终结果</Typography.Text>
          <Markdown text={run.summary.text} />
          {run.summary.truncated && <Typography.Text type="warning">内容已截断</Typography.Text>}
        </article>
      ) : !entries.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开过程记录" />
      ) : null}
    </section>
  );
}
