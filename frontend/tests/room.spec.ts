import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

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
            kind: 'issue',
            issueId: 'one',
            issue: 'HER-1',
            title: task.title,
            status: task.status,
            ts: iso(0),
          },
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

// The pre-migration HTML is an immutable design reference. Both pages receive the same API
// fixtures, so layout and screenshots can be compared without changing live tasks or messages.
for (const width of [1440, 390]) {
  test(`legacy appearance comparison across every workspace page at ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    const html = execFileSync('git', ['show', 'c0abfcf:index.html'], { encoding: 'utf8' });
    const legacy = await context.newPage();
    await legacy.route('http://127.0.0.1:4173/', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    legacy.on('pageerror', (error) => errors.push(`legacy: ${error.message}`));
    for (const current of [legacy, page]) await current.setViewportSize({ width, height: 1000 });
    await fixture(legacy);
    await fixture(page);
    const capture = async (name: string) => {
      for (const [version, current] of [
        ['legacy', legacy],
        ['react', page],
      ] as const) {
        const path = testInfo.outputPath(`${name}-${version}-${width}.png`);
        await current.screenshot({ path, animations: 'disabled' });
        await testInfo.attach(`${name}-${version}`, { path, contentType: 'image/png' });
        expect(
          await current.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
      }
    };
    const originalHeader = await legacy.locator('header').boundingBox();
    const currentHeader = await page.locator('.app-header').boundingBox();
    expect(currentHeader!.height).toBe(originalHeader!.height);
    if (width > 760) {
      expect((await page.locator('.agent-sidebar').boundingBox())!.width).toBe(
        (await legacy.locator('aside').boundingBox())!.width,
      );
      expect(
        await page
          .locator('.main-panel')
          .evaluate((element) => getComputedStyle(element).borderRadius),
      ).toBe('0px');
    }
    expect(
      await page
        .locator('.brand-mark')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe(
      await legacy
        .locator('.mark')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    );
    await capture('chat');
    await legacy.locator('#view-tasks').click();
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    await expect(legacy.locator('#stream .comm')).toBeVisible();
    await expect(page.locator('.record-button.message')).toBeVisible();
    await capture('task-list');
    expect(await page.locator('.task-panel table').count()).toBe(0);
    await expect(page.locator('.record-route .member-avatar')).toHaveCount(2);
    const before = await page.locator('.conversation-body').boundingBox();
    await legacy
      .locator('#stream .comm-summary')
      .filter({ has: legacy.locator('.comm-route') })
      .click();
    await page.getByRole('button', { name: /^PL → QA：/ }).click();
    await expect(page.locator('.detail-slot')).toBeVisible();
    if (width > 760) {
      const after = await page.locator('.conversation-body').boundingBox();
      const panel = await page.locator('.detail-slot').boundingBox();
      expect(Math.abs(after!.width + panel!.width - before!.width)).toBeLessThan(2);
      expect(after!.width).toBeLessThan(before!.width - 280);
      const originalPanel = await legacy.locator('#sidepanel').boundingBox();
      expect(Math.abs(panel!.width - originalPanel!.width)).toBeLessThan(2);
    } else await expect(page.locator('.conversation-body')).toBeHidden();
    await capture('message-detail');
    await legacy.locator('#closepanel').click();
    await page.keyboard.press('Escape');
    await legacy.locator('#tasks-trace-view').click();
    await page.getByText('时间线', { exact: true }).click();
    await expect(page.getByTestId('trace-run')).toHaveCount(2);
    await capture('task-timeline');
    await legacy.locator('[data-trace-run]').first().click();
    await page.getByTestId('trace-run').first().click();
    await expect(page.getByText('当前助手消息', { exact: true })).toBeVisible();
    await capture('execution-detail');
    await legacy.locator('#closepanel').click();
    await page.keyboard.press('Escape');
    await legacy.locator('#newtask').click();
    await page.getByRole('button', { name: '新建任务' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture('create-task');
    expect(await page.locator('.ant-modal').evaluate((element) => element.clientWidth)).toBe(
      await legacy.locator('#taskmodal .modal').evaluate((element) => element.clientWidth),
    );
    await legacy.locator('#taskcancel').click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await legacy.locator('#opschip').click();
    await page.getByRole('button', { name: /巡检/ }).click();
    await expect(page.getByText('任务总数', { exact: true })).toBeVisible();
    await capture('ops');
    expect(await page.locator('.ant-modal').evaluate((element) => element.clientWidth)).toBe(
      await legacy.locator('#opsmodal .modal').evaluate((element) => element.clientWidth),
    );
    expect(errors).toEqual([]);
    await legacy.close();
  });
}

test('draft isolation, IME guard, chat send and explicit task creation', async ({ page }) => {
  const writes = await fixture(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('PL 草稿');
  await page.getByRole('button', { name: /^QA ·/ }).click();
  await expect(input).toHaveValue('');
  await input.fill('QA 草稿');
  await page.getByRole('button', { name: /^PL ·/ }).click();
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
  await page.getByRole('button', { name: /^PL → QA：/ }).click();
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
  await page.getByRole('button', { name: /^QA ·/ }).click();
  await requested;
  await page.getByRole('button', { name: /^PL ·/ }).click();
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

test('scroll-to-latest is a compact icon button when not stuck to bottom', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 640 });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const long = Array.from({ length: 40 }, (_, i) => ({
      id: `m-${i}`,
      author: i % 2 ? 'user' : 'agent',
      authorName: i % 2 ? '你' : 'PL',
      text: `消息行 ${i} — ${'内容 '.repeat(8)}`,
      ts: new Date(Date.now() - (40 - i) * 60000).toISOString(),
    }));
    const payload: Record<string, unknown> = {
      '/api/teams': { default: 'c1', teams: [{ id: 'c1', name: 'Hermes Lab' }] },
      '/api/state': {
        companyId: 'c1',
        agents: [
          {
            id: 'pl',
            name: 'PL',
            title: '团队成员',
            status: 'idle',
            model: 'glm-5.3',
            openCount: 0,
            live: { running: 0, queued: 0, taskRunning: 0, backgroundRunning: 0, runs: [] },
            current: null,
          },
        ],
        liveRunning: 0,
        liveQueued: 0,
        liveTaskRunning: 0,
        liveBackgroundRunning: 0,
      },
      '/api/chat': { state: 'available', messages: long },
      '/api/tasks': { state: 'available', tasks: [], note: '' },
      '/api/ops': {
        tasks: { total: 0, stale: [], awaiting: [] },
        blocked: { count: 0, onBoard: 0, over24h: 0, items: [] },
        runs: { recent: { hours: 24, failed: 0, timedOut: 0 } },
        alerts: [],
        preflight: [],
      },
    };
    await route.fulfill({ json: payload[url.pathname] || {} });
  });
  await page.goto('/');
  await expect(page.getByText('消息行 0', { exact: false }).first()).toBeVisible();
  const stream = page.locator('.chat-stream');
  await stream.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  const btn = page.getByRole('button', { name: '回到最新消息', exact: true });
  await expect(btn).toBeVisible();
  await expect(btn).not.toContainText('回到最新消息');
  const box = await btn.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeGreaterThanOrEqual(32);
  expect(box!.width).toBeLessThanOrEqual(40);
  expect(box!.height).toBeGreaterThanOrEqual(32);
  expect(box!.height).toBeLessThanOrEqual(40);
  await btn.click();
  await expect(btn).toHaveCount(0);
  const nearBottom = await stream.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80,
  );
  expect(nearBottom).toBe(true);
});

test('code fence card: label, copy failure, download body, empty fence skipped', async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const fenceBody = 'line-one\nline-two\nconst x = 1;\n';
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const md = [
      '## 标题',
      '',
      '正文 `inline`。',
      '',
      '```ts',
      fenceBody.trimEnd(),
      '```',
      '',
      '```',
      '   ',
      '```',
      '',
      '```text',
      'plain body',
      '```',
    ].join('\n');
    const payload: Record<string, unknown> = {
      '/api/teams': { default: 'c1', teams: [{ id: 'c1', name: 'Hermes Lab' }] },
      '/api/state': {
        companyId: 'c1',
        agents: [
          {
            id: 'pl',
            name: 'PL',
            title: '团队成员',
            status: 'idle',
            model: 'glm-5.3',
            openCount: 0,
            live: { running: 0, queued: 0, taskRunning: 0, backgroundRunning: 0, runs: [] },
            current: null,
          },
        ],
        liveRunning: 0,
        liveQueued: 0,
        liveTaskRunning: 0,
        liveBackgroundRunning: 0,
      },
      '/api/chat': {
        state: 'available',
        messages: [
          {
            id: 'agent-md',
            author: 'agent',
            authorName: 'PL',
            text: md,
            ts: new Date().toISOString(),
          },
        ],
      },
      '/api/tasks': { state: 'available', tasks: [], note: '' },
      '/api/ops': {
        tasks: { total: 0, stale: [], awaiting: [] },
        blocked: { count: 0, onBoard: 0, over24h: 0, items: [] },
        runs: { recent: { hours: 24, failed: 0, timedOut: 0 } },
        alerts: [],
        preflight: [],
      },
    };
    await route.fulfill({ json: payload[url.pathname] || {} });
  });

  await page.goto('/');
  const cards = page.locator('.code-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('.code-card-label')).toHaveText('ts');
  await expect(cards.nth(1).locator('.code-card-label')).toHaveText('TEXT');

  // Copy failure must be perceptible
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error('denied')),
      },
    });
  });
  await cards.nth(0).getByRole('button', { name: '复制代码', exact: true }).click();
  await expect(page.getByText('复制失败', { exact: false })).toBeVisible();

  // Download content equals fence body (with trailing newline normalized by renderer)
  const downloadPromise = page.waitForEvent('download');
  await cards.nth(0).getByRole('button', { name: '下载代码', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const fs = await import('node:fs');
  const saved = fs.readFileSync(path!, 'utf8');
  expect(saved).toBe(fenceBody.trimEnd());
  expect(download.suggestedFilename()).toMatch(/\.ts$/);

  // Narrow: buttons still clickable, no horizontal page overflow
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const copyBox = await cards.nth(0).getByRole('button', { name: '复制代码' }).boundingBox();
  expect(copyBox!.width).toBeGreaterThanOrEqual(32);
  expect(copyBox!.height).toBeGreaterThanOrEqual(32);
});

test('composer honest bar: empty left tools, model on right, no fake slash/attachments', async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await fixture(page);
  const footer = page.locator('.composer-footer');
  const tools = footer.locator('[data-testid="composer-tools"]');
  await expect(tools).toHaveCount(1);
  await expect(tools).toBeEmpty();
  // No fake capability affordances
  await expect(page.getByRole('button', { name: /附件|语音|自动模式|快捷/ })).toHaveCount(0);
  await expect(page.locator('.composer')).not.toContainText('/');
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(input).toHaveAttribute('placeholder', /给 PL 发消息/);
  await expect(input).not.toHaveAttribute('placeholder', /\//);
  // Right cluster: model → counter → send
  const right = footer.locator('.composer-footer-right');
  await expect(right.getByRole('combobox', { name: '成员模型' })).toBeVisible();
  await input.fill('你好');
  await expect(right.getByLabel('字数')).toHaveText('2');
  await expect(right.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  // No second agent picker in composer
  await expect(page.locator('.composer .member-avatar, .composer [data-agent-pill]')).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('user markdown: strong/list/code, skipHtml, no code-card, agent fence regression, ≤760', async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const userSample = ['请按下列做：', '- 先改 **Composer**', '- 再跑 `npm test`'].join('\n');
  const xssSample = '<img src=x onerror=alert(1)>';
  const userFence = ['说明：', '```ts', 'const a = 1;', '```'].join('\n');
  const agentFence = ['Agent 回复', '', '```js', 'console.log(1)', '```'].join('\n');

  let posted: string[] = [];
  const messages: {
    id: string;
    author: string;
    authorName: string;
    text: string;
    ts: string;
    truncated?: boolean;
  }[] = [
    {
      id: 'agent-fence',
      author: 'agent',
      authorName: 'PL',
      text: agentFence,
      ts: new Date().toISOString(),
    },
  ];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/api/chat') {
      const body = request.postDataJSON() as { text: string };
      posted.push(body.text);
      messages.push({
        id: `user-${posted.length}`,
        author: 'user',
        authorName: '我',
        text: body.text,
        ts: new Date().toISOString(),
      });
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (request.method() === 'POST') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const payload: Record<string, unknown> = {
      '/api/teams': { default: 'c1', teams: [{ id: 'c1', name: 'Hermes Lab' }] },
      '/api/state': {
        companyId: 'c1',
        agents: [
          {
            id: 'pl',
            name: 'PL',
            title: '团队成员',
            status: 'idle',
            model: 'glm-5.3',
            openCount: 0,
            live: { running: 0, queued: 0, taskRunning: 0, backgroundRunning: 0, runs: [] },
            current: null,
          },
        ],
        liveRunning: 0,
        liveQueued: 0,
        liveTaskRunning: 0,
        liveBackgroundRunning: 0,
      },
      '/api/chat': { state: 'available', messages },
      '/api/tasks': { state: 'available', tasks: [], note: '' },
      '/api/ops': {
        tasks: { total: 0, stale: [], awaiting: [] },
        blocked: { count: 0, onBoard: 0, over24h: 0, items: [] },
        runs: { recent: { hours: 24, failed: 0, timedOut: 0 } },
        alerts: [],
        preflight: [],
      },
    };
    await route.fulfill({ json: payload[url.pathname] || {} });
  });

  // Catch XSS execution
  let alerted = false;
  page.on('dialog', async (dialog) => {
    alerted = true;
    await dialog.dismiss();
  });

  await page.goto('/');
  // Agent fence regression: CodeFenceCard still present
  await expect(page.locator('.chat-message.agent .code-card')).toHaveCount(1);
  await expect(
    page.locator('.chat-message.agent .code-card').getByRole('button', { name: '复制代码' }),
  ).toBeVisible();

  const input = page.getByRole('textbox', { name: '消息', exact: true });

  // Designer §8 sample
  await input.fill(userSample);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const userBubble = page.locator('.chat-message.user').last();
  await expect(userBubble.locator('.markdown--user')).toBeVisible();
  // Optimistic / first paint: never .user-text
  await expect(userBubble.locator('.user-text')).toHaveCount(0);
  await expect(userBubble.locator('.markdown--user strong')).toHaveText('Composer');
  await expect(userBubble.locator('.markdown--user li')).toHaveCount(2);
  await expect(userBubble.locator('.markdown--user code')).toHaveText('npm test');
  // Orange bubble unchanged
  await expect(userBubble.locator('.message-bubble')).toHaveCSS(
    'background-color',
    'rgb(255, 244, 236)',
  );

  // XSS string must not execute (skipHtml may strip HTML-only nodes entirely)
  await input.fill(xssSample);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const xssBubble = page.locator('.chat-message.user').last();
  await expect(xssBubble.locator('.markdown--user')).toBeVisible();
  await expect(xssBubble.locator('img[onerror]')).toHaveCount(0);
  await expect(xssBubble.locator('img')).toHaveCount(0);
  expect(alerted).toBe(false);
  // Mixed prose + HTML: surrounding text survives, img still not executed
  await input.fill(`看看 ${xssSample} 结尾`);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const mixed = page.locator('.chat-message.user').last();
  await expect(mixed.locator('.markdown--user')).toContainText('看看');
  await expect(mixed.locator('.markdown--user')).toContainText('结尾');
  await expect(mixed.locator('img')).toHaveCount(0);
  expect(alerted).toBe(false);

  // User fence → no CodeFenceCard
  await input.fill(userFence);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const fenceBubble = page.locator('.chat-message.user').last();
  await expect(fenceBubble.locator('.markdown--user')).toBeVisible();
  await expect(fenceBubble.locator('.code-card')).toHaveCount(0);
  await expect(fenceBubble.locator('.markdown--user pre code')).toContainText('const a = 1;');
  // Agent card still present (not wiped by variant mix-up)
  await expect(page.locator('.chat-message.agent .code-card')).toHaveCount(1);

  // Narrow: no horizontal page overflow
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('user markdown optimistic: sent bubble is markdown--user without user-text flash', async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const sample = '**立刻**可见';
  let chatMessages: {
    id: string;
    author: string;
    authorName: string;
    text: string;
    ts?: string;
  }[] = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/api/chat') {
      const body = request.postDataJSON() as { text: string };
      chatMessages = [
        ...chatMessages,
        {
          id: 'opt-user',
          author: 'user',
          authorName: '我',
          text: body.text,
          ts: new Date().toISOString(),
        },
      ];
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (request.method() === 'POST') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const payload: Record<string, unknown> = {
      '/api/teams': { default: 'c1', teams: [{ id: 'c1', name: 'Hermes Lab' }] },
      '/api/state': {
        companyId: 'c1',
        agents: [
          {
            id: 'pl',
            name: 'PL',
            title: '团队成员',
            status: 'idle',
            model: 'glm-5.3',
            openCount: 0,
            live: { running: 0, queued: 0, taskRunning: 0, backgroundRunning: 0, runs: [] },
            current: null,
          },
        ],
        liveRunning: 0,
        liveQueued: 0,
        liveTaskRunning: 0,
        liveBackgroundRunning: 0,
      },
      '/api/chat': { state: 'available', messages: chatMessages },
      '/api/tasks': { state: 'available', tasks: [], note: '' },
      '/api/ops': {
        tasks: { total: 0, stale: [], awaiting: [] },
        blocked: { count: 0, onBoard: 0, over24h: 0, items: [] },
        runs: { recent: { hours: 24, failed: 0, timedOut: 0 } },
        alerts: [],
        preflight: [],
      },
    };
    await route.fulfill({ json: payload[url.pathname] || {} });
  });

  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill(sample);
  await page.getByRole('button', { name: '发送', exact: true }).click();

  const bubble = page.locator('.chat-message.user').last();
  await expect(bubble.locator('.markdown--user strong')).toHaveText('立刻');
  await expect(bubble.locator('.user-text')).toHaveCount(0);
  // Throughout the wait, never introduce user-text
  await expect.poll(async () => page.locator('.chat-message.user .user-text').count()).toBe(0);
});

test('interactive task-context banner and ops modal navigation to task detail and member props', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/ops?**', (route) =>
    route.fulfill({
      json: {
        tasks: {
          total: 2,
          stale: [],
          awaiting: [
            {
              id: 'one',
              identifier: 'HER-1',
              title: '并行任务 <script>unsafe</script>',
              owner: 'PL',
              idleMinutes: 30,
            },
          ],
        },
        blocked: { count: 1, onBoard: 1, over24h: 0, items: [] },
        runs: { recent: { hours: 24, failed: 1, timedOut: 0 } },
        alerts: [{ code: 'awaiting', level: 'warn', message: '1 个任务在等你回答问题' }],
        preflight: [{ agent: 'QA', detail: 'Hermes exited with code 1' }],
      },
    }),
  );
  await page.getByRole('button', { name: '刷新', exact: true }).click();

  // Clicking the current task context banner opens its task detail drawer directly
  await page.locator('.task-context-button').click();
  await expect(page.locator('.detail-slot')).toBeVisible();
  await expect(page.locator('.detail-title')).toContainText('HER-1');
  await page.keyboard.press('Escape');
  await expect(page.locator('.detail-slot')).toHaveCount(0);

  // Clicking an issue inside OpsModal closes the modal, switches to Tasks tab, and opens DetailDrawer
  await page.getByRole('button', { name: /巡检/ }).click();
  await expect(page.getByRole('dialog', { name: '团队巡检' })).toBeVisible();
  await page.locator('.ops-row-button', { hasText: 'HER-1' }).click();
  await expect(page.getByRole('dialog', { name: '团队巡检' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '任务' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.detail-title')).toContainText('HER-1');

  // Clicking a preflight item inside OpsModal selects that member and opens MemberPropsDrawer
  await page.getByRole('button', { name: /巡检/ }).click();
  await page.locator('.ops-row-button', { hasText: 'QA' }).click();
  await expect(page.getByRole('heading', { name: 'QA', exact: true })).toBeVisible();
  await expect(page.getByText('成员属性 · QA')).toBeVisible();
});

test('shows chat turn state instead of a silent gap while the member works', async ({ page }) => {
  await fixture(page);
  const waitingSince = new Date(Date.now() - 45_000).toISOString();
  await page.route('**/api/state?**', (route) =>
    route.fulfill({
      json: {
        companyId: 'c1',
        agents: [
          {
            ...agent('pl', 'PL'),
            live: {
              running: 1,
              queued: 0,
              taskRunning: 0,
              backgroundRunning: 1,
              runs: [
                {
                  id: 'chat-run',
                  status: 'running',
                  issueId: 'chat-pl',
                  startedAt: waitingSince,
                  lastOutputAt: new Date(Date.now() - 8_000).toISOString(),
                  linked: false,
                },
              ],
            },
          },
          agent('qa', 'QA'),
        ],
        liveRunning: 1,
        liveQueued: 0,
        liveTaskRunning: 0,
        liveBackgroundRunning: 1,
      },
    }),
  );
  await page.route('**/api/chat?**', (route) => {
    const isPl = new URL(route.request().url()).searchParams.get('agent') === 'pl';
    return route.fulfill({
      json: {
        state: 'available',
        chat: { id: isPl ? 'chat-pl' : 'chat-qa' },
        messages: [
          {
            id: 'ask',
            author: 'user',
            authorName: '我',
            ts: waitingSince,
            text: '还有哪些任务要人工介入？',
          },
        ],
      },
    });
  });

  await page.route('**/api/chat-activity?**', (route) =>
    route.fulfill({
      json: {
        state: 'available',
        steps: [
          { id: 's1', kind: 'thinking', text: '先核对看板上的未闭环任务' },
          { id: 's2', kind: 'tool_call', name: 'terminal', text: 'gh issue list --state open' },
          { id: 's3', kind: 'tool_result', name: 'terminal', text: '25 条未闭环' },
        ],
      },
    }),
  );

  await page.goto('/');
  const status = page.getByRole('status');
  await expect(status).toContainText('PL 正在处理…');
  await expect(status).toContainText('前有输出');
  const activity = page.getByRole('group', { name: '对话过程' });
  await expect(activity).toContainText('先核对看板上的未闭环任务');
  await expect(activity).toContainText('gh issue list --state open');
  await page.getByRole('button', { name: '展开 3 步' }).click();
  await expect(activity).toContainText('25 条未闭环');

  // 没有运行接管时要如实说"已送达，等待"，而不是重复"正在处理"
  await page.getByRole('button', { name: /^QA ·/ }).click();
  await expect(status).toContainText('已送达，等待 QA 处理…');
  await expect(activity).toHaveCount(0);
});
