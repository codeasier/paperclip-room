import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CaretRightOutlined,
  CodeOutlined,
  EnterOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { apiUrl, getJSON } from '../../api/client';
import type { ChatActivityResponse } from '../../api/types';
import { activityHint, activityRows, type ActivityRow } from '../../lib/chatActivity';

function TraceRow({ row }: { row: ActivityRow }) {
  if (row.tone === 'tool')
    return (
      <div className="chat-flow-row tool">
        <CodeOutlined />
        <span className="chat-flow-label">已执行</span>
        <span className="chat-flow-text" title={row.text}>
          {row.text}
        </span>
      </div>
    );
  if (row.tone === 'result')
    return (
      <div className={`chat-flow-row result${row.error ? ' error' : ''}`}>
        <EnterOutlined />
        <span className="chat-flow-text" title={row.text}>
          {row.text}
        </span>
      </div>
    );
  if (row.tone === 'reply')
    return (
      <div className="chat-flow-row reply">
        <InfoCircleOutlined />
        <span className="chat-flow-label">回复</span>
        <span className="chat-flow-text" title={row.text}>
          {row.text}
        </span>
      </div>
    );
  return (
    <div className="chat-flow-row thinking">
      <InfoCircleOutlined />
      <span className="chat-flow-label">思考过程</span>
      <span className="chat-flow-text" title={row.text}>
        {row.text}
      </span>
    </div>
  );
}

/**
 * 回合进行中的灰色过程块：折叠时一行摘要 + 最新命令，展开后是思考、命令与输出。
 * 只在该会话确实有运行在跑时挂载，运行结束由上层卸载。
 */
export function ChatActivity({
  company,
  agentId,
  runId,
}: {
  company: string;
  agentId: string;
  runId: string;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['/api/chat-activity', company, agentId, runId],
    queryFn: ({ signal }) =>
      getJSON<ChatActivityResponse>(
        apiUrl('/api/chat-activity', company, { agent: agentId, run: runId }),
        signal,
      ),
    refetchInterval: 3000,
    retry: false,
  });
  const rows = activityRows(query.data?.steps || []);
  const thinking = rows.filter((row) => row.tone === 'thinking').length;
  const tools = rows.filter((row) => row.tone === 'tool').length;
  const summary = [thinking ? `思考 ${thinking} 次` : '', tools ? `执行 ${tools} 条命令` : '']
    .filter(Boolean)
    .join(' · ');
  const latestTool = [...rows].reverse().find((row) => row.tone === 'tool');
  const hint = activityHint({
    failed: query.isError,
    state: query.data?.state,
    note: query.data?.note,
  });
  return (
    <div className="chat-flow" role="group" aria-label="对话过程">
      {rows.length === 0 ? (
        <div className="chat-flow-empty">
          <InfoCircleOutlined />
          <span>{hint}</span>
        </div>
      ) : (
        <button
          type="button"
          className="chat-flow-head"
          aria-expanded={open}
          aria-label={open ? '收起过程' : '展开过程'}
          onClick={() => setOpen((value) => !value)}
        >
          <InfoCircleOutlined />
          <span className="chat-flow-count">{summary}</span>
          {!open && latestTool && <span className="chat-flow-latest">{latestTool.text}</span>}
          <CaretRightOutlined className={`chat-flow-caret${open ? ' open' : ''}`} />
        </button>
      )}
      {open && (
        <div className="chat-flow-steps">
          {rows.map((row) => (
            <TraceRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
