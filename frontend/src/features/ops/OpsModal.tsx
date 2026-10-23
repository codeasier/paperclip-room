import { Alert, Button, Card, Empty, Modal, Space, Spin, Statistic, Typography } from 'antd';
import type { OpsIssue, OpsResponse } from '../../api/types';
import { useRoomQuery } from '../../hooks/useRoomQuery';

export function OpsModal({
  company,
  open,
  onClose,
}: {
  company: string;
  open: boolean;
  onClose: () => void;
}) {
  const query = useRoomQuery<OpsResponse>('/api/ops', company, undefined, 30000);
  const data = query.data;
  function issues(title: string, items: OpsIssue[]) {
    return (
      <section className="section-gap">
        <Typography.Title level={5}>
          {title}（{items.length}）
        </Typography.Title>
        {items.length ? (
          items.map((item, index) => (
            <div className="ops-row" key={item.id || `${item.identifier}:${index}`}>
              <strong>
                {item.identifier} · {item.title}
              </strong>
              <Typography.Paragraph type="secondary">
                {item.action || item.prompt || item.waitingOn || item.owner || '未写明解除条件'}
                {item.ageHours != null ? ` · 阻塞 ${item.ageHours}h` : ''}
                {item.silentHours != null ? ` · 静默 ${item.silentHours}h` : ''}
                {item.idleMinutes != null ? ` · 静默 ${Math.round(item.idleMinutes)} 分钟` : ''}
              </Typography.Paragraph>
            </div>
          ))
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无" />
        )}
      </section>
    );
  }
  return (
    <Modal
      title="团队巡检"
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={800}
    >
      {query.isPending && <Spin />}
      {query.isError && (
        <Alert
          type="warning"
          title="巡检刷新失败"
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      {data && (
        <>
          <div className="ops-stats">
            <Card size="small">
              <Statistic title="任务总数" value={data.tasks.total} />
            </Card>
            <Card size="small">
              <Statistic title="阻塞" value={data.blocked.count} />
            </Card>
            <Card size="small">
              <Statistic title="陈旧状态" value={data.tasks.stale.length} />
            </Card>
            <Card size="small">
              <Statistic
                title="近 24h 异常"
                value={data.runs.recent.failed + data.runs.recent.timedOut}
              />
            </Card>
          </div>
          {issues(
            '等你处理',
            data.blocked.items.filter((item) => item.onBoard),
          )}
          {issues('等你回答', data.tasks.awaiting)}
          {issues(
            '其他阻塞',
            data.blocked.items.filter((item) => !item.onBoard),
          )}
          {issues('陈旧 in_progress', data.tasks.stale)}
          <Typography.Title level={5}>配置预检</Typography.Title>
          {data.preflight.map((item, index) => (
            <Alert
              key={index}
              className="section-gap"
              type="warning"
              title={item.agent}
              description={item.detail}
            />
          ))}
          <Space orientation="vertical" className="full-width section-gap">
            {data.alerts.map((item) => (
              <Alert key={item.code} type="warning" title={item.message} />
            ))}
          </Space>
          <Typography.Paragraph type="secondary" className="section-gap">
            只读巡检；有界查询不代表全历史审计，不会修改任务或运行状态。
          </Typography.Paragraph>
        </>
      )}
    </Modal>
  );
}
