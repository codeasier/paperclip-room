export interface Team {
  id: string;
  name: string;
  isDefault?: boolean;
  description?: string;
}
export interface TeamsResponse {
  teams: Team[];
  default: string;
}
export interface LiveRun {
  id: string;
  status: string;
  startedAt?: string;
  createdAt?: string;
  lastOutputAt?: string;
  issueId?: string;
  issue?: string;
  issueTitle?: string;
  taskKey?: string;
  linked: boolean;
}
export interface Agent {
  id: string;
  name: string;
  title?: string;
  status: string;
  model?: string;
  openCount: number;
  lastRunStatus?: string;
  lastRunError?: string;
  lastRunAgeMin?: number;
  current?: { identifier: string; title: string; status: string };
  live: {
    running: number;
    queued: number;
    taskRunning: number;
    backgroundRunning: number;
    runs: LiveRun[];
  };
}
export interface StateResponse {
  agents: Agent[];
  companyId: string;
  serverTime: string;
  liveRunning: number;
  liveQueued: number;
  liveTaskRunning: number;
  liveBackgroundRunning: number;
}
export interface Message {
  id: string;
  author: 'agent' | 'user' | 'system';
  authorName: string;
  ts?: string;
  text: string;
  truncated?: boolean;
}
export interface ChatResponse {
  state: 'available' | 'new' | 'disabled' | 'unavailable';
  messages: Message[];
  note?: string;
  chat?: { id: string; conversationState?: string; status?: string };
}
export interface Attempt {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface Task {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority?: string;
  relation: string;
  createdAt?: string;
  lastActivityAt?: string;
  parent?: { identifier: string; title: string; status: string };
  children: { total: number; done: number };
  checklist?: {
    done: number;
    total: number;
    items: { done: boolean; text: string }[];
    more: number;
    partial: boolean;
  };
  runs: { total: number; active: number; failed: number; lastStatus?: string; lastError?: string };
  attempts: Attempt[];
  comments: {
    total: number;
    latest: { id: string; author: string; ts?: string; text: string; truncated?: boolean }[];
  };
}
export interface TasksResponse {
  state: string;
  tasks: Task[];
  note?: string;
}
export interface TranscriptEntry {
  id: string;
  kind: 'assistant' | 'tool_call' | 'tool_result';
  ts?: string;
  text: string;
  name?: string;
  toolCallId?: string;
  isError?: boolean;
  truncated?: boolean;
}
export interface ExecutionRun {
  id: string;
  agentId: string;
  status: string;
  ts?: string;
  finishedAt?: string;
  issue?: string;
  issueTitle?: string;
  error?: string;
  summary?: { text: string; truncated?: boolean };
  state: string;
  entries: TranscriptEntry[];
  nextCursor?: number | null;
  note?: string;
}
export interface ExecutionResponse {
  runs: ExecutionRun[];
  note?: string;
  state: string;
}
export interface RoomEvent {
  id?: string;
  kind: 'issue' | 'comment';
  ts?: string;
  issueId: string;
  issue?: string;
  issueTitle?: string;
  title?: string;
  status?: string;
  text?: string;
  sender?: { name: string };
  recipients?: { name: string }[];
  receipt?: { state: string; runs: (Attempt & { runId: string })[] };
}
export interface OpsIssue {
  id?: string;
  identifier: string;
  title: string;
  onBoard?: boolean;
  action?: string;
  ageHours?: number;
  silentHours?: number;
  waitingOn?: string;
  owner?: string;
  idleMinutes?: number;
  prompt?: string;
}
export interface OpsResponse {
  tasks: { total: number; stale: OpsIssue[]; awaiting: OpsIssue[] };
  blocked: { count: number; onBoard: number; over24h: number; items: OpsIssue[] };
  runs: { recent: { hours: number; failed: number; timedOut: number } };
  preflight: { agent: string; detail: string }[];
  alerts: { code: string; level: string; message: string }[];
}
export interface WriteResponse {
  ok: boolean;
  error?: string;
  issue?: string;
  commentId?: string;
}

export type InstructionsMode = 'writable' | 'readonly' | 'unavailable';

export interface MemberInstructions {
  mode: InstructionsMode;
  source?: string | null;
  path?: string | null;
  content?: string | null;
  probeNote?: string | null;
}

export interface MemberRuntime {
  model?: string | null;
  timeoutSec?: number | null;
  maxConcurrentRuns?: number | null;
  maxConcurrentRunsPlatformDefault?: number | null;
  maxConcurrentRunsCapped?: boolean;
  warning?: string | null;
}

export interface MemberIdentity {
  name: string;
  title?: string | null;
  instructions: MemberInstructions;
}

export interface MemorySessionReuse {
  state: 'reused' | 'fresh' | 'unknown' | 'unavailable';
  detail?: string | null;
  source?: string | null;
  asOf?: string | null;
}

export interface MemoryHandoffFile {
  path: string;
  mtime?: string | null;
}

export interface MemoryHandoff {
  state: 'available' | 'empty' | 'unavailable';
  files?: MemoryHandoffFile[];
  source?: string | null;
  asOf?: string | null;
  detail?: string | null;
}

export interface MemoryContextSize {
  state: 'available' | 'empty' | 'unavailable';
  approxChars?: number | null;
  unit?: string | null;
  source?: string | null;
  asOf?: string | null;
  detail?: string | null;
}

export interface MemberMemory {
  sessionReuse: MemorySessionReuse;
  handoff: MemoryHandoff;
  contextSize: MemoryContextSize;
}

export interface MemberConfig {
  agentId: string;
  companyId: string;
  fetchedAt: string;
  runtime: MemberRuntime;
  identity: MemberIdentity;
  memory: MemberMemory;
}

export type MemberConfigWritableKey =
  'model' | 'timeoutSec' | 'maxConcurrentRuns' | 'name' | 'title' | 'instructions';

export interface MemberConfigWriteBody {
  agentId: string;
  model?: string;
  timeoutSec?: number;
  maxConcurrentRuns?: number;
  name?: string;
  title?: string;
  instructions?: string;
}

export interface MemberConfigWriteResponse {
  ok: boolean;
  applied?: MemberConfigWritableKey[];
  error?: string;
  field?: string;
  runtime?: Partial<MemberRuntime>;
  identity?: Partial<Pick<MemberIdentity, 'name' | 'title'>>;
}
