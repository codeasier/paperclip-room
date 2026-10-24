import type { MemberConfigWriteResponse, WriteResponse } from './types';

export function apiUrl(
  path: string,
  company?: string,
  params: Record<string, string | number | undefined> = {},
) {
  const query = new URLSearchParams();
  if (company) query.set('company', company);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return `${path}${query.size ? `?${query}` : ''}`;
}

export async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
  return response.json();
}

// Writes are never automatically retried: a timeout can mean the action was accepted upstream.
export async function postJSON(url: string, body: object): Promise<WriteResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('未确认操作结果，请核对实际结果后再试；输入内容已保留。');
  }
  let result: WriteResponse;
  try {
    result = await response.json();
  } catch {
    throw new Error('未确认操作结果，请核对实际结果后再试。');
  }
  if (!response.ok || !result.ok)
    throw new Error(result.error || `操作失败（HTTP ${response.status}）`);
  return result;
}

/** Member-config write that preserves HTTP status / applied for 409 and partial success. */
export async function postMemberConfig(
  url: string,
  body: object,
): Promise<{ status: number; body: MemberConfigWriteResponse }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('未确认操作结果，请核对实际结果后再试；输入内容已保留。');
  }
  let result: MemberConfigWriteResponse;
  try {
    result = await response.json();
  } catch {
    throw new Error('未确认操作结果，请核对实际结果后再试。');
  }
  return { status: response.status, body: result };
}
