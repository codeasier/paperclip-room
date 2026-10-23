import { useInfiniteQuery } from '@tanstack/react-query';
import { Alert, Button, Collapse, Empty, Space, Spin, Typography } from 'antd';
import { apiUrl, getJSON } from '../../api/client';
import type { ExecutionRun, TranscriptEntry } from '../../api/types';
import { Markdown } from '../../components/Markdown';
import { StatusTag } from '../../components/StatusTag';
import { dateLabel } from '../../lib/format';

export function ExecutionProcess({
  company,
  agentId,
  runId,
}: {
  company: string;
  agentId: string;
  runId: string;
}) {
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
  if (query.isPending)
    return (
      <div className="loading">
        <Spin />
      </div>
    );
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
  const toolBody = (entry: TranscriptEntry) => (
    <>
      <pre>{entry.text}</pre>
      {entry.truncated && <Typography.Text type="warning">内容已截断</Typography.Text>}
    </>
  );
  return (
    <section className="execution-process">
      <Typography.Title level={5}>运行过程</Typography.Title>
      <Space wrap>
        <StatusTag status={run.status} />
        <Typography.Text type="secondary">{dateLabel(run.ts)}</Typography.Text>
      </Space>
      <Typography.Paragraph type="secondary" className="run-id">
        运行：{runId}
      </Typography.Paragraph>
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
          className="section-gap"
          block
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
        const result = entry.kind === 'tool_call' ? results.get(entry.toolCallId) : entry;
        return (
          <Collapse
            key={entry.id}
            className="tool-step"
            size="small"
            items={[
              {
                key: entry.id,
                label: (
                  <Space wrap>
                    <strong>{entry.name || '工具'}</strong>
                    <Typography.Text type={result?.isError ? 'danger' : 'secondary'}>
                      {result ? (result.isError ? '返回错误' : '已返回') : '等待返回'}
                    </Typography.Text>
                  </Space>
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
      {!entries.length &&
        (run.summary?.text ? (
          <article className="assistant-output">
            <Typography.Text type="secondary">平台最终结果</Typography.Text>
            <Markdown text={run.summary.text} />
            {run.summary.truncated && <Typography.Text type="warning">内容已截断</Typography.Text>}
          </article>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开过程记录" />
        ))}
      <Typography.Paragraph type="secondary" className="section-gap">
        {run.note} 工具有返回记录不代表业务验收通过。
      </Typography.Paragraph>
    </section>
  );
}
