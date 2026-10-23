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
  if (ms < 1000) return '<1 秒';
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} 分钟`;
  return `${(ms / 3600000).toFixed(1)} 小时`;
}
export const models = [
  'volcengine/deepseek-v4.1-flash',
  'glm-5.3',
  'MiniMax-M3.1-Flash',
  'minimax-m3.1-flash-free',
  'muse-spark-1.3',
];
