import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Empty, Result, Select, Space, Spin, Tabs, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { apiUrl, getJSON, postJSON } from '../api/client';
import type {
  Agent,
  OpsResponse,
  StateResponse,
  TasksResponse,
  Team,
  TeamsResponse,
} from '../api/types';
import { useRoomQuery } from '../hooks/useRoomQuery';
import { models } from '../lib/format';
import { AgentSidebar } from '../features/agents/AgentSidebar';
import { MemberAvatar, roleLabel } from '../components/MemberAvatar';
import { StatusTag } from '../components/StatusTag';
import { ChatPanel } from '../features/chat/ChatPanel';
import type { Detail } from '../features/tasks/DetailDrawer';

const TaskPanel = lazy(() =>
  import('../features/tasks/TaskPanel').then((module) => ({ default: module.TaskPanel })),
);
const CreateTaskModal = lazy(() =>
  import('../features/tasks/CreateTaskModal').then((module) => ({
    default: module.CreateTaskModal,
  })),
);
const DetailDrawer = lazy(() =>
  import('../features/tasks/DetailDrawer').then((module) => ({ default: module.DetailDrawer })),
);
const MemberPropsDrawer = lazy(() =>
  import('../features/agents/MemberPropsDrawer').then((module) => ({
    default: module.MemberPropsDrawer,
  })),
);
const OpsModal = lazy(() =>
  import('../features/ops/OpsModal').then((module) => ({ default: module.OpsModal })),
);

function storedTeam() {
  try {
    return localStorage.getItem('room.team') || '';
  } catch {
    return '';
  }
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Result
        status="error"
        title="页面遇到错误"
        extra={<Button onClick={() => window.location.reload()}>重新加载</Button>}
      />
    ) : (
      this.props.children
    );
  }
}

export function RoomApp() {
  const [choice, setChoice] = useState(storedTeam);
  const teams = useQuery({
    queryKey: ['/api/teams'],
    queryFn: ({ signal }) => getJSON<TeamsResponse>('/api/teams', signal),
    refetchInterval: 30000,
  });
  const company =
    teams.data?.teams.find((team) => team.id === choice)?.id || teams.data?.default || '';
  const team = teams.data?.teams.find((item) => item.id === company);
  useEffect(() => {
    document.title = team ? `${team.name} · Paperclip Room` : 'Paperclip Room';
  }, [team]);
  if (teams.isPending)
    return (
      <div className="app-loading">
        <Spin size="large" tip="连接团队…" />
      </div>
    );
  if (!team)
    return (
      <Result
        status="error"
        title="无法读取团队"
        subTitle={teams.error?.message}
        extra={<Button onClick={() => void teams.refetch()}>重试连接</Button>}
      />
    );
  return (
    <ErrorBoundary>
      <TeamWorkspace
        key={company}
        team={team}
        teams={teams.data!.teams}
        onTeam={(id) => {
          setChoice(id);
          try {
            localStorage.setItem('room.team', id);
          } catch {
            /* storage may be disabled */
          }
        }}
      />
    </ErrorBoundary>
  );
}

function TeamWorkspace({
  team,
  teams,
  onTeam,
}: {
  team: Team;
  teams: Team[];
  onTeam: (id: string) => void;
}) {
  const [selection, setSelection] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [opsOpen, setOpsOpen] = useState(false);
  const client = useQueryClient();
  const state = useRoomQuery<StateResponse>('/api/state', team.id, undefined, 5000);
  const ops = useRoomQuery<OpsResponse>('/api/ops', team.id, undefined, 30000);
  const agents = state.data?.agents || [];
  const agent =
    agents.find((agent) => agent.id === selection) ||
    agents.find((agent) => agent.name === 'PL') ||
    agents[0];
  return (
    <div className="room-app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">{team.name.slice(0, 1).toUpperCase()}</span>
          <Select
            aria-label="选择团队"
            className="team-select"
            value={team.id}
            onChange={onTeam}
            variant="borderless"
            options={teams.map((team) => ({ value: team.id, label: team.name }))}
          />
          <span className="workspace-name">团队工作室</span>
        </div>
        <div className="header-spacer" />
        <button
          className="sync-label"
          aria-label="刷新"
          onClick={() =>
            void client.invalidateQueries({ predicate: (query) => query.queryKey[1] === team.id })
          }
        >
          {state.data
            ? `已同步 ${state.data.serverTime || new Date(state.dataUpdatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : '正在同步'}
        </button>
        <Button
          className={`ops-chip ${ops.data?.alerts.length ? 'warn' : ''}`}
          onClick={() => setOpsOpen(true)}
        >
          <span className="pulse" />
          {ops.data?.alerts.length ? `巡检 ${ops.data.alerts.length} 项` : '巡检正常'}
        </Button>
        <span className="team-live">
          <span className={`pulse ${state.data?.liveRunning ? 'running' : ''}`} />
          {state.data?.liveRunning
            ? `${state.data.liveTaskRunning} 个任务运行 · ${state.data.liveBackgroundRunning} 个后台运行`
            : state.data?.liveQueued
              ? `${state.data.liveQueued} 个排队`
              : '团队待命'}
        </span>
      </header>
      {state.isError && (
        <Alert
          className="connection-error"
          type="error"
          title="团队状态读取失败，保留最近成功数据"
          action={<Button onClick={() => void state.refetch()}>重试</Button>}
        />
      )}
      <div className="workspace">
        <AgentSidebar agents={agents} selected={agent?.id || ''} onSelect={setSelection} />
        <main className="main-panel">
          {state.isPending ? (
            <div className="loading">
              <Spin />
            </div>
          ) : agent ? (
            <AgentWorkspace
              key={agent.id}
              company={team.id}
              agent={agent}
              draft={drafts[agent.id] || ''}
              onDraft={(value) => setDrafts((previous) => ({ ...previous, [agent.id]: value }))}
            />
          ) : (
            <Empty
              className="empty-team"
              description="团队暂无可用成员，请在 Paperclip 中添加成员"
            />
          )}
        </main>
      </div>
      {opsOpen && (
        <Suspense fallback={null}>
          <OpsModal company={team.id} open onClose={() => setOpsOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

function AgentWorkspace({
  company,
  agent,
  draft,
  onDraft,
}: {
  company: string;
  agent: Agent;
  draft: string;
  onDraft: (value: string) => void;
}) {
  const [view, setView] = useState('chat');
  const [tasksVisited, setTasksVisited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [propsOpen, setPropsOpen] = useState(false);
  const tasks = useRoomQuery<TasksResponse>(
    '/api/tasks',
    company,
    agent.id,
    8000,
    view === 'tasks' || detail !== null,
  );
  const client = useQueryClient();
  const { message } = App.useApp();
  const modelBusy = useIsMutating({ mutationKey: ['model', company, agent.id] }) > 0;
  const model = useMutation({
    mutationKey: ['model', company, agent.id],
    mutationFn: (value: string) =>
      postJSON(apiUrl('/api/model', company), { agentId: agent.id, model: value }),
    onSuccess: () => {
      void message.success('模型已更新');
      void client.invalidateQueries({ queryKey: ['/api/state', company] });
    },
    onError: (error: Error) => {
      void message.error(error.message);
    },
  });
  const runningText = agent.live.taskRunning
    ? `${agent.live.taskRunning} 个任务运行`
    : agent.live.backgroundRunning
      ? `${agent.live.backgroundRunning} 个后台运行`
      : agent.live.queued
        ? `${agent.live.queued} 个排队`
        : '待命中';
  const modelPicker = (
    <Select
      className="model-select"
      prefix={<span className="model-label">模型</span>}
      aria-label="成员模型"
      showSearch
      value={agent.model}
      loading={modelBusy}
      disabled={modelBusy}
      options={[...new Set([...models, ...(agent.model ? [agent.model] : [])])].map((value) => ({
        value,
        label: value.replace(/^volcengine\//, ''),
      }))}
      onChange={(value) => model.mutate(value)}
    />
  );
  return (
    <>
      <div className="member-header">
        <MemberAvatar name={agent.name} size={36} />
        <div className="member-copy">
          <Typography.Title level={4}>{agent.name}</Typography.Title>
          <Typography.Text type="secondary">
            {roleLabel(agent.name, agent.title)} · 名下 {agent.openCount || 0} 个未结任务 ·{' '}
            {runningText === '待命中' ? '待命' : runningText}
          </Typography.Text>
        </div>
        <Button
          className="panel-toggle"
          aria-expanded={detail !== null}
          aria-label="打开任务详情"
          onClick={() => {
            setPropsOpen(false);
            setDetail(detail ? null : { kind: 'overview' });
          }}
        >
          详情
        </Button>
        <Button
          className="panel-toggle"
          aria-expanded={propsOpen}
          aria-label="打开成员属性"
          onClick={() => {
            setDetail(null);
            setPropsOpen((open) => !open);
          }}
        >
          属性
        </Button>
        <span
          className={`member-status ${agent.live.taskRunning ? 'running' : agent.live.backgroundRunning ? 'background' : ''}`}
        >
          {runningText}
        </span>
      </div>
      {agent.lastRunError && agent.lastRunAgeMin != null && agent.lastRunAgeMin < 60 && (
        <Alert
          className="member-error"
          type="warning"
          title={`最近运行异常（${agent.lastRunAgeMin} 分钟前）`}
          description={agent.lastRunError}
        />
      )}
      {agent.current && (
        <div className="task-context" title="这是当前名下未结任务；任务状态不代表成员正在执行。">
          <span className="task-caption">当前名下任务</span>
          <strong>{agent.current.identifier}</strong>
          <span className="task-context-title">{agent.current.title}</span>
          <StatusTag status={agent.current.status} prefix="任务：" />
        </div>
      )}
      <div className={`room-body ${detail || propsOpen ? 'detail-open' : ''}`}>
        <div className="conversation-body">
          <div className="view-toolbar">
            <Tabs
              activeKey={view}
              onChange={(value) => {
                setView(value);
                if (value === 'tasks') setTasksVisited(true);
                setDetail(null);
                setPropsOpen(false);
              }}
              items={[
                { key: 'chat', label: '对话' },
                { key: 'tasks', label: '任务' },
              ]}
            />
            <span className="view-note">
              {view === 'chat' ? '直接对话，不进入任务列表' : '任务与运行记录（只读）'}
            </span>
            <Space>
              <Button icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                新建任务
              </Button>
            </Space>
          </div>
          <div className="view-body">
            <Suspense
              fallback={
                <div className="loading">
                  <Spin />
                </div>
              }
            >
              <div className="view-slot" hidden={view !== 'chat'}>
                <ChatPanel
                  company={company}
                  agent={agent}
                  draft={draft}
                  onDraft={onDraft}
                  active={view === 'chat'}
                  modelControl={modelPicker}
                />
              </div>
              {(tasksVisited || view === 'tasks') && (
                <div className="view-slot" hidden={view !== 'tasks'}>
                  <TaskPanel
                    company={company}
                    agent={agent}
                    data={tasks.data}
                    pending={tasks.isPending}
                    error={tasks.isError}
                    onRetry={() => void tasks.refetch()}
                    onDetail={(next) => {
                      setPropsOpen(false);
                      setDetail(next);
                    }}
                    selectedDetail={detail}
                    active={view === 'tasks'}
                  />
                </div>
              )}
            </Suspense>
          </div>
          {view === 'tasks' && (
            <footer className="task-footer">
              任务时间线只读；可从顶部新建任务。
              <Button type="link" onClick={() => setView('chat')}>
                去对话
              </Button>
            </footer>
          )}
        </div>
        <Suspense fallback={null}>
          {creating && (
            <CreateTaskModal
              company={company}
              agentId={agent.id}
              agentName={agent.name}
              onClose={() => setCreating(false)}
              onCreated={() => {
                setTasksVisited(true);
                setView('tasks');
              }}
            />
          )}
          {detail && (
            <div className="detail-slot">
              <DetailDrawer
                company={company}
                agentId={agent.id}
                agentName={agent.name}
                tasks={tasks.data?.tasks || []}
                detail={detail}
                onChange={(next) => {
                  setPropsOpen(false);
                  setDetail(next);
                }}
                onClose={() => setDetail(null)}
              />
            </div>
          )}
          {propsOpen && (
            <div className="detail-slot">
              <MemberPropsDrawer
                company={company}
                agent={agent}
                open={propsOpen}
                onClose={() => setPropsOpen(false)}
              />
            </div>
          )}
        </Suspense>
      </div>
    </>
  );
}
