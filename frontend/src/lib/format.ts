export function dateLabel(value?: string | number) {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '时间无效';
}
export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
}
export const models = [
  'volcengine/deepseek-v4.1-flash',
  'glm-5.3',
  'MiniMax-M3.1-Flash',
  'minimax-m3.1-flash-free',
  'muse-spark-1.3',
];

export function dayLabel(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function clockLabel(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export const runStatuses: Record<string, string> = {
  queued: '排队中',
  running: '已开始',
  succeeded: '运行成功',
  failed: '运行失败',
  timed_out: '运行超时',
  cancelled: '已取消',
  cancelling: '取消中',
};
