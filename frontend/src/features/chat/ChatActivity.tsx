import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiUrl, getJSON } from '../../api/client';
import type { ChatActivityResponse } from '../../api/types';
import { activityHint, activityRows, activitySummary } from '../../lib/chatActivity';

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
  const rows = activityRows(steps);
  const visible = open ? rows : activitySummary(steps);
  // 模型回答前会话里还没有任何记录，这时也要有一张卡片说明"在等什么"，不能整块消失。
  const hint = activityHint({
    failed: query.isError,
    state: query.data?.state,
    note: query.data?.note,
  });
  return (
    <div className="chat-activity" role="group" aria-label="对话过程">
      <div className="activity-head">
        <span className="activity-title">过程</span>
        {rows.length > 0 && (
          <button
            type="button"
            className="activity-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '收起' : `展开 ${rows.length} 步`}
          </button>
        )}
      </div>
      {rows.length === 0 && <div className="activity-hint">{hint}</div>}
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
