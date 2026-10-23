import { Tag } from 'antd';

export const statuses: Record<string, string> = {
  todo: '待办',
  in_progress: '进行中',
  in_review: '待评审',
  blocked: '受阻',
  done: '已完成',
  cancelled: '已取消',
  backlog: '待排期',
  running: '运行中',
  queued: '排队中',
  cancelling: '取消中',
  succeeded: '成功',
  failed: '失败',
  timed_out: '超时',
  idle: '待命',
  error: '异常',
};
const colors: Record<string, string> = {
  in_progress: 'processing',
  running: 'processing',
  in_review: 'purple',
  blocked: 'warning',
  done: 'success',
  succeeded: 'success',
  failed: 'error',
  timed_out: 'error',
  error: 'error',
  queued: 'gold',
};
export function StatusTag({ status }: { status?: string }) {
  return <Tag color={colors[status || '']}>{statuses[status || ''] || status || '未知'}</Tag>;
}
