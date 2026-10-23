import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Avatar,
  Badge,
  Button,
  Empty,
  Result,
  Select,
  Space,
  Spin,
  Tabs,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
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
          <span className="brand-mark">
            P<span>·</span>
          </span>
          <div>
            <strong>Paperclip Room</strong>
            <small>TEAM WORKSPACE</small>
          </div>
        </div>
        <Select
          aria-label="选择团队"
          className="team-select"
          value={team.id}
          onChange={onTeam}
          suffixIcon={<TeamOutlined />}
          options={teams.map((team) => ({ value: team.id, label: team.name }))}
        />
        <div className="header-summary">
          任务运行 {state.data?.liveTaskRunning || 0}{' '}
          <span>
            后台 {state.data?.liveBackgroundRunning || 0} · 排队 {state.data?.liveQueued || 0}
          </span>
        </div>
        <Badge count={ops.data?.alerts.length || 0} size="small">
          <Button icon={<SafetyCertificateOutlined />} onClick={() => setOpsOpen(true)}>
            巡检
          </Button>
        </Badge>
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
  return (
    <>
      <div className="member-header">
        <Avatar shape="square" size={48} style={{ background: '#edf0ff', color: '#5264dc' }}>
          {agent.name.slice(0, 2)}
        </Avatar>
        <div className="member-copy">
          <Typography.Title level={4}>{agent.name}</Typography.Title>
          <Typography.Text type="secondary">{agent.title || '团队成员'}</Typography.Text>
        </div>
        <Badge
          status={agent.live.running ? 'processing' : 'default'}
          text={
            agent.live.taskRunning
              ? `任务运行 ${agent.live.taskRunning}`
              : agent.live.backgroundRunning
                ? `后台运行 ${agent.live.backgroundRunning}`
                : agent.live.queued
                  ? `排队中 ${agent.live.queued}`
                  : '待命中'
          }
        />
      </div>
      {agent.lastRunError && agent.lastRunAgeMin != null && agent.lastRunAgeMin < 60 && (
        <Alert
          className="member-error"
          type="warning"
          title={`最近运行异常（${agent.lastRunAgeMin} 分钟前）`}
          description={agent.lastRunError}
        />
      )}
      <div className="view-toolbar">
        <Tabs
          activeKey={view}
          onChange={(value) => {
            setView(value);
            if (value === 'tasks') setTasksVisited(true);
            setDetail(null);
          }}
          items={[
            { key: 'chat', label: '对话' },
            { key: 'tasks', label: '任务' },
          ]}
        />
        <Space>
          <Button
            aria-label="刷新"
            icon={<ReloadOutlined />}
            onClick={() =>
              void client.invalidateQueries({ predicate: (query) => query.queryKey[1] === company })
            }
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
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
                onDetail={setDetail}
                active={view === 'tasks'}
              />
            </div>
          )}
        </Suspense>
      </div>
      <footer className="member-footer">
        <Typography.Text type="secondary">成员模型</Typography.Text>
        <Select
          aria-label="成员模型"
          showSearch
          value={agent.model}
          loading={modelBusy}
          disabled={modelBusy}
          options={[...new Set([...models, ...(agent.model ? [agent.model] : [])])].map(
            (value) => ({ value, label: value }),
          )}
          onChange={(value) => model.mutate(value)}
        />
        <Typography.Text className="poll-hint" type="secondary">
          定时同步 · 公开执行记录
        </Typography.Text>
      </footer>
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
          <DetailDrawer
            company={company}
            agentId={agent.id}
            tasks={tasks.data?.tasks || []}
            detail={detail}
            onChange={setDetail}
            onClose={() => setDetail(null)}
          />
        )}
      </Suspense>
    </>
  );
}
