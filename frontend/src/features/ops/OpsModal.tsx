import { Alert, Button, Card, Modal, Spin } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import type { OpsIssue, OpsResponse } from '../../api/types';
import { useRoomQuery } from '../../hooks/useRoomQuery';

export function OpsModal({
  company,
  open,
  onClose,
  onSelectIssue,
  onSelectPreflight,
}: {
  company: string;
  open: boolean;
  onClose: () => void;
  onSelectIssue?: (item: OpsIssue) => void;
  onSelectPreflight?: (agentName: string) => void;
}) {
  const query = useRoomQuery<OpsResponse>('/api/ops', company, undefined, 30000);
  const data = query.data;
  const empty = <div className="ops-empty">无</div>;
  function issues(title: string, items: OpsIssue[]) {
    return (
      <section className="ops-section">
        <h4>
          {title}（{items.length}）
        </h4>
        <div className="ops-list">
          {items.length
            ? items.map((item, index) => (
                <button
                  type="button"
                  className="ops-row ops-row-button"
                  key={item.id || `${item.identifier}:${index}`}
                  onClick={() => onSelectIssue?.(item)}
                >
                  <div className="ops-row-title">
                    <code>{item.identifier}</code>
                    <strong>{item.title}</strong>
                    {item.owner && <span className="ops-row-owner">{item.owner}</span>}
                    <RightOutlined className="ops-row-chevron" />
                  </div>
                  <div className="ops-row-meta">
                    {item.action || item.prompt || item.waitingOn || item.owner || '未写明解除条件'}
                    {item.ageHours != null ? ` · 阻塞 ${item.ageHours}h` : ''}
                    {item.silentHours != null ? ` · 静默 ${item.silentHours}h` : ''}
                    {item.idleMinutes != null ? ` · 静默 ${Math.round(item.idleMinutes)} 分钟` : ''}
                  </div>
                </button>
              ))
            : empty}
        </div>
      </section>
    );
  }
  return (
    <Modal
      title="团队巡检"
      className="ops-modal"
      centered
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      transitionName=""
      maskTransitionName=""
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
        <div className="ops-body">
          <div className="ops-stats">
            {[
              { label: '任务总数', value: data.tasks.total },
              { label: `阻塞 · 超 24h ${data.blocked.over24h}`, value: data.blocked.count },
              { label: '陈旧 in_progress', value: data.tasks.stale.length },
              {
                label: `近 24h 异常 · 超时 ${data.runs.recent.timedOut} · 失败 ${data.runs.recent.failed}`,
                value: data.runs.recent.failed + data.runs.recent.timedOut,
              },
            ].map((stat) => (
              <Card size="small" key={stat.label}>
                <b>{stat.value}</b>
                <span>{stat.label}</span>
              </Card>
            ))}
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
          <section className="ops-section">
            <h4>配置预检（{data.preflight.length}）</h4>
            <div className="ops-list">
              {data.preflight.length
                ? data.preflight.map((item, index) => (
                    <button
                      type="button"
                      className="ops-row ops-row-button"
                      key={index}
                      onClick={() => onSelectPreflight?.(item.agent)}
                    >
                      <div className="ops-row-title">
                        <strong>{item.agent}</strong>
                        <span className="ops-row-owner">检查成员配置</span>
                        <RightOutlined className="ops-row-chevron" />
                      </div>
                      <div className="ops-row-meta">{item.detail}</div>
                    </button>
                  ))
                : empty}
            </div>
          </section>
          <section className="ops-section">
            <h4>告警</h4>
            <div className="ops-list">
              {data.alerts.length
                ? data.alerts.map((item) => (
                    <div className="ops-row" key={item.code}>
                      <div className="ops-row-meta">{item.message}</div>
                    </div>
                  ))
                : empty}
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
