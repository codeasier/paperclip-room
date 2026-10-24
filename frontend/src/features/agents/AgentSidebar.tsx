import { Empty } from 'antd';
import type { Agent } from '../../api/types';
import { MemberAvatar, roleLabel } from '../../components/MemberAvatar';

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
        团队成员 <span>{agents.length}</span>
      </div>
      <nav className="agent-list" aria-label="选择智能体">
        {!agents.length && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="团队暂无成员" />
        )}
        {agents.map((agent) => {
          const state = agent.live.taskRunning
            ? 'running'
            : agent.live.backgroundRunning
              ? 'background'
              : agent.live.queued
                ? 'queued'
                : 'idle';
          const title = agent.current
            ? `${agent.current.identifier} · ${agent.current.title}`
            : '暂无在办任务';
          return (
            <button
              key={agent.id}
              className={`agent-item ${selected === agent.id ? 'selected' : ''}`}
              onClick={() => onSelect(agent.id)}
              aria-pressed={selected === agent.id}
              aria-label={`${agent.name} · ${roleLabel(agent.name, agent.title)}`}
              title={title}
            >
              <MemberAvatar name={agent.name} status={state} />
              <span className="agent-copy">
                <span className="agent-top">
                  <strong>{agent.name}</strong>
                  <span>{roleLabel(agent.name, agent.title)}</span>
                </span>
                <span className={`agent-task ${state}`}>
                  <span>{title}</span>
                  {state !== 'idle' && (
                    <small>
                      {agent.live.taskRunning
                        ? `${agent.live.taskRunning} 任务运行`
                        : agent.live.backgroundRunning
                          ? `${agent.live.backgroundRunning} 后台运行`
                          : `${agent.live.queued} 排队`}
                    </small>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">{agents.length} 个成员 · 当前团队</div>
    </aside>
  );
}
