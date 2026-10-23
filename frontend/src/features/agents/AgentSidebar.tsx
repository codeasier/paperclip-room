import { Avatar, Badge, Empty, Typography } from 'antd';
import type { Agent } from '../../api/types';

export function AgentSidebar({
  agents,
  selected,
  onSelect,
}: {
  agents: Agent[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="agent-sidebar" aria-label="团队成员">
      <div className="sidebar-heading">
        <Typography.Text type="secondary">团队成员</Typography.Text>
        <span>{agents.length}</span>
      </div>
      <nav className="agent-list">
        {!agents.length && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="团队暂无成员" />
        )}
        {agents.map((agent) => (
          <button
            key={agent.id}
            className={`agent-item ${selected === agent.id ? 'selected' : ''}`}
            onClick={() => onSelect(agent.id)}
            aria-pressed={selected === agent.id}
          >
            <Badge
              dot
              status={
                agent.live.running ? 'processing' : agent.status === 'error' ? 'error' : 'default'
              }
            >
              <Avatar
                shape="square"
                size={40}
                style={{
                  background: selected === agent.id ? '#5264dc' : '#e9edf5',
                  color: selected === agent.id ? '#fff' : '#526175',
                }}
              >
                {agent.name.slice(0, 2)}
              </Avatar>
            </Badge>
            <span className="agent-copy">
              <strong>{agent.name}</strong>
              <span>{agent.title || '团队成员'}</span>
              <small>
                {agent.live.taskRunning
                  ? `任务运行 ${agent.live.taskRunning}`
                  : agent.live.backgroundRunning
                    ? `后台运行 ${agent.live.backgroundRunning}`
                    : agent.live.queued
                      ? `排队 ${agent.live.queued}`
                      : '待命中'}
              </small>
            </span>
            <span className="agent-count">{agent.openCount}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        Paperclip Room
        <br />
        <small>团队协作 · 执行可见</small>
      </div>
    </aside>
  );
}
