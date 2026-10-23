import { expect, test, type Page } from '@playwright/test';

const now = Date.now() - 300000;
const iso = (offset: number) => new Date(now + offset).toISOString();
const runId = '11111111-1111-4111-8111-111111111111';
const task = {
  id: 'one',
  identifier: 'HER-1',
  title: '并行任务 <script>unsafe</script>',
  status: 'in_progress',
  priority: 'medium',
  relation: 'assigned',
  lastActivityAt: iso(0),
  children: { total: 2, done: 1 },
  checklist: {
    done: 1,
    total: 2,
    items: [
      { done: true, text: '已完成' },
      { done: false, text: '等待验收' },
    ],
    more: 0,
    partial: false,
  },
  runs: { total: 3, active: 0, failed: 0 },
  comments: { total: 0, latest: [] },
  attempts: [
    {
      id: runId,
      agentId: 'pl',
      agentName: 'PL',
      status: 'succeeded',
      startedAt: iso(0),
      finishedAt: iso(240000),
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      agentId: 'pl',
      agentName: 'PL',
      status: 'succeeded',
      startedAt: iso(60000),
      finishedAt: iso(180000),
    },
    { id: 'qa-run', agentId: 'qa', agentName: 'QA', status: 'running', startedAt: iso(60000) },
  ],
};
const agent = (id: string, name: string) => ({
  id,
  name,
  title: '团队成员',
  status: 'idle',
  model: 'glm-5.3',
  openCount: 1,
  live: { running: 0, queued: 0, taskRunning: 0, backgroundRunning: 0, runs: [] },
  current: { identifier: 'HER-1', title: '并行任务', status: 'in_progress' },
});
const transcript = {
  id: runId,
  agentId: 'pl',
  status: 'succeeded',
  state: 'available',
  ts: iso(0),
  entries: [
    {
      id: 'tool',
      kind: 'tool_call',
      toolCallId: 'call',
      name: 'terminal',
      text: '{"command":"true"}',
    },
    {
      id: 'result',
      kind: 'tool_result',
      toolCallId: 'call',
      name: 'terminal',
      text: 'tool-result',
    },
    { id: 'm-20', kind: 'assistant', text: '当前助手消息' },
  ],
  nextCursor: 20,
};

async function fixture(page: Page) {
  const writes: { path: string; company: string | null; body: Record<string, unknown> }[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      writes.push({
        path: url.pathname,
        company: url.searchParams.get('company'),
        body: request.postDataJSON(),
      });
      await route.fulfill({ json: { ok: true, issue: 'HER-2' } });
      return;
    }
    const response: Record<string, unknown> = {
      '/api/teams': {
        default: 'c1',
        teams: [
          { id: 'c1', name: 'Hermes Lab' },
          { id: 'c2', name: '第二团队' },
        ],
      },
      '/api/state': {
        companyId: url.searchParams.get('company'),
        agents: [agent('pl', 'PL'), agent('qa', 'QA')],
        liveRunning: 0,
        liveQueued: 0,
        liveTaskRunning: 0,
        liveBackgroundRunning: 0,
      },
      '/api/chat': {
        state: 'available',
        messages: [
          {
            id: 'welcome',
            author: 'agent',
            authorName: url.searchParams.get('agent') === 'qa' ? 'QA' : 'PL',
            text: '你好，准备开始。',
          },
        ],
      },
      '/api/tasks': {
        state: 'available',
        tasks: [
          task,
          {
            ...task,
            id: 'assigned-only',
            identifier: 'HER-110',
            title: '等待接手',
            attempts: [task.attempts[2]],
          },
        ],
        note: '有界查询，非完整历史。',
      },
      '/api/room': {
        events: [
          {
            id: 'comment',
            kind: 'comment',
            issueId: 'one',
            issue: 'HER-1',
            text: '给 QA\n请验收',
            sender: { name: 'PL' },
            recipients: [{ name: 'QA' }],
            receipt: { state: 'not_found', runs: [] },
            ts: iso(100000),
          },
        ],
      },
      '/api/execution': {
        state: 'available',
        runs: [{ ...transcript, issue: 'HER-1', issueTitle: '并行任务' }],
      },
      '/api/run': url.searchParams.has('before')
        ? {
            ...transcript,
            nextCursor: null,
            entries: [{ id: 'm-1', kind: 'assistant', text: '更早的助手消息' }],
          }
        : { ...transcript, id: url.searchParams.get('run') },
      '/api/ops': {
        tasks: { total: 2, stale: [], awaiting: [] },
        blocked: { count: 0, onBoard: 0, over24h: 0, items: [] },
        runs: { recent: { hours: 24, failed: 0, timedOut: 0 } },
        alerts: [],
        preflight: [],
      },
    };
    await route.fulfill({ json: response[url.pathname] || {} });
  });
  await page.goto('/');
  await expect(page.getByText('你好，准备开始。')).toBeVisible();
  return writes;
}

test('draft isolation, IME guard, chat send and explicit task creation', async ({ page }) => {
  const writes = await fixture(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('PL 草稿');
  await page.getByRole('button', { name: /QA 团队成员/ }).click();
  await expect(input).toHaveValue('');
  await input.fill('QA 草稿');
  await page.getByRole('button', { name: /PL 团队成员/ }).click();
  await expect(input).toHaveValue('PL 草稿');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  expect(writes).toHaveLength(0);
  await input.dispatchEvent('compositionend');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(writes[0]).toMatchObject({
    path: '/api/chat',
    company: 'c1',
    body: { agentId: 'pl', text: 'PL 草稿' },
  });
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByLabel('任务标题').fill('明确派活');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('tab', { name: '任务' })).toHaveAttribute('aria-selected', 'true');
  expect(writes[1]).toMatchObject({
    path: '/api/tasks',
    body: { agentId: 'pl', title: '明确派活', priority: 'medium' },
  });
});

test('task timeline, details, tool pairing, pagination and current-member filtering', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixture(page);
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByText('PL → QA：给 QA', { exact: false }).click();
  await expect(page.getByText('当前有界窗口暂无精确接收记录')).toBeVisible();
  await page.getByRole('button', { name: '查看来源任务 HER-1' }).click();
  await expect(page.getByText('当前助手消息', { exact: true })).toBeVisible();
  await page.getByText('terminal', { exact: true }).click();
  await expect(page.getByText('tool-result', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加载本次运行更早的过程' }).click();
  await expect(page.getByText('更早的助手消息', { exact: true })).toBeVisible();
  await expect(page.getByText('当前助手消息', { exact: true })).toHaveCount(1);
  await expect(page.getByText('tool-result', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByText('时间线', { exact: true }).click();
  await expect(page.getByTestId('trace-run')).toHaveCount(2);
  await expect(page.getByText('暂无 PL 的运行记录', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: '任务状态' }).click();
  await page.getByTitle('成员执行中', { exact: true }).click();
  await expect(page.getByTestId('trace-run')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('team switch clears drafts and persists the selected team', async ({ page }) => {
  const writes = await fixture(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('不跨团队保留');
  await page.getByRole('combobox', { name: '选择团队' }).click();
  await page.getByTitle('第二团队', { exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page).toHaveTitle('第二团队 · Paperclip Room');
  await input.fill('新团队消息');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].company).toBe('c2');
  await page.reload();
  await expect(page).toHaveTitle('第二团队 · Paperclip Room');
});

test('late member response cannot replace the currently selected member', async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/chat?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('agent') !== 'qa') {
      await route.fallback();
      return;
    }
    started();
    await gate;
    await route
      .fulfill({
        json: {
          state: 'available',
          messages: [{ id: 'late', author: 'agent', authorName: 'QA', text: '延迟的 QA 回复' }],
        },
      })
      .catch(() => {});
  });
  await page.getByRole('button', { name: /QA 团队成员/ }).click();
  await requested;
  await page.getByRole('button', { name: /PL 团队成员/ }).click();
  release();
  await expect(page.getByText('你好，准备开始。')).toBeVisible();
  await expect(page.getByText('延迟的 QA 回复')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'PL', exact: true })).toBeVisible();
});

test('disabled chat, model change and read-only ops remain separate actions', async ({ page }) => {
  const writes = await fixture(page);
  await page.route('**/api/chat?**', (route) =>
    route.fulfill({ json: { state: 'disabled', note: '请开启 Agent Chat', messages: [] } }),
  );
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: '成员模型' }).click();
  await page.getByTitle('MiniMax-M3.1-Flash', { exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    path: '/api/model',
    company: 'c1',
    body: { agentId: 'pl', model: 'MiniMax-M3.1-Flash' },
  });
  await page.getByRole('button', { name: /巡检/ }).click();
  await expect(page.getByText('任务总数', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
});

test('unconfirmed write preserves draft and is never retried automatically', async ({ page }) => {
  await fixture(page);
  let attempts = 0;
  await page.route('**/api/chat?**', async (route) => {
    if (route.request().method() === 'POST') {
      attempts++;
      await route.abort();
    } else await route.fallback();
  });
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('保留原文');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText(/未确认操作结果/)).toBeVisible();
  await expect(input).toHaveValue('保留原文');
  expect(attempts).toBe(1);
});

for (const width of [1440, 1024, 390, 320]) {
  test(`responsive workspace and detail drawer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await page.getByText('时间线', { exact: true }).click();
    await expect(page.getByTestId('trace-run')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByTestId('trace-run').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('当前助手消息', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
