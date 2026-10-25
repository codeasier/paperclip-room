import { useQueries, useQueryClient } from '@tanstack/react-query';
import { apiUrl, getJSON } from '../../api/client';
import type { ChatActivityResponse, ChatActivityRun, LiveRun } from '../../api/types';
import { activityHint, type ActivitySource } from '../../lib/chatActivity';

export function useChatActivity({
  company,
  agentId,
  runs = [],
  liveRun,
  active,
}: {
  company: string;
  agentId: string;
  runs?: ChatActivityRun[];
  liveRun?: LiveRun;
  active: boolean;
}) {
  const client = useQueryClient();
  const byId = new Map(runs.map((run) => [run.id, run]));
  if (liveRun?.status === 'running') byId.set(liveRun.id, liveRun);
  const activityRuns = [...byId.values()];
  const prefix = ['/api/chat-activity', company, agentId];
  const queries = useQueries({
    queries: activityRuns.map((run) => ({
      // The terminal key forces one final read, even if a live query was fetched just before completion.
      queryKey: [...prefix, run.id, run.status, run.finishedAt || ''],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getJSON<ChatActivityResponse>(
          apiUrl('/api/chat-activity', company, { agent: agentId, run: run.id }),
          signal,
        ),
      placeholderData: () =>
        client.getQueryData<ChatActivityResponse>([...prefix, run.id, 'running', '']),
      enabled: Boolean(company) && active,
      refetchInterval: active && run.status === 'running' ? 3000 : false,
      refetchIntervalInBackground: false,
      staleTime: run.status === 'running' ? 0 : 60_000,
      retry: 1,
    })),
  });
  const sources: ActivitySource[] = activityRuns.map((run, index) => ({
    run,
    data: queries[index]?.data,
  }));
  const liveIndex = activityRuns.findIndex((run) => run.id === liveRun?.id);
  const liveQuery = queries[liveIndex];
  const hint =
    liveRun?.status === 'running' && !liveQuery?.data?.steps.length
      ? activityHint({
          failed: liveQuery?.isError || false,
          state: liveQuery?.data?.state,
          note: liveQuery?.data?.note,
        })
      : liveQuery?.isError
        ? '过程读取失败，稍后自动重试'
        : undefined;
  return { sources, hint };
}
