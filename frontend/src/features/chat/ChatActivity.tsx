import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiUrl, getJSON } from '../../api/client';
import type { ChatActivityResponse } from '../../api/types';
import { activityRows, activitySummary } from '../../lib/chatActivity';

/**
 * 回合进行中的实时过程：思考、工具调用与输出。
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
  const steps = query.data?.steps || [];
  if (!steps.length) {
    if (query.data?.state !== 'unavailable') return null;
    return <p className="chat-activity-note">{query.data.note || '过程暂不可读'}</p>;
  }
  const rows = activityRows(steps);
  const visible = open ? rows : activitySummary(steps);
  return (
    <div className="chat-activity" role="group" aria-label="对话过程">
      <div className="activity-head">
        <span className="activity-title">过程</span>
        <button
          type="button"
          className="activity-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : `展开 ${rows.length} 步`}
        </button>
      </div>
      {visible.map((row) => (
        <div key={row.id} className={`activity-row ${row.tone}${row.error ? ' error' : ''}`}>
          <span className="activity-tag">{row.label}</span>
          {row.name && <span className="activity-name">{row.name}</span>}
          <span className="activity-text">{row.text}</span>
        </div>
      ))}
    </div>
  );
}
