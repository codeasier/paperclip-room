import { useQuery } from '@tanstack/react-query';
import { apiUrl, getJSON } from '../api/client';

export function useRoomQuery<T>(
  path: string,
  company: string,
  agent: string | undefined,
  interval: number,
  enabled = true,
) {
  return useQuery({
    queryKey: [path, company, agent],
    queryFn: ({ signal }) => getJSON<T>(apiUrl(path, company, { agent }), signal),
    enabled: Boolean(company) && enabled,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
}
