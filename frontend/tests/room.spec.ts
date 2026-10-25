import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { ActivityStep, ChatActivityRun, Message } from '../src/api/types';

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
      '/api/issue-gate': {
        state: 'available',
        issue: {
          id: 'one',
          identifier: 'HER-1',
          title: task.title,
          status: task.status,
          owner: 'PL',
        },
        blocked: null,
        interactions: [],
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

test('ops issues open an actionable gate panel for answering and unblocking', async ({ page }) => {
  const writes = await fixture(page);
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
              title: '并行任务',
              owner: 'PL',
              idleMinutes: 30,
              prompt: '走哪条发布通道？',
            },
          ],
        },
        blocked: {
          count: 1,
          onBoard: 1,
          over24h: 0,
          items: [
            {
              id: 'one',
              identifier: 'HER-1',
              title: '并行任务',
              owner: 'PL',
              waitingOn: '用户',
              action: '授权合入 PR #1',
              ageHours: 2,
              silentHours: 1,
              onBoard: true,
            },
          ],
        },
        runs: { recent: { hours: 24, failed: 0, timedOut: 0 } },
        alerts: [
          { code: 'board_gate', level: 'warn', message: '1 个任务在等你授权或拍板，最长静默 1.0h' },
          { code: 'awaiting_answer', level: 'warn', message: '1 个任务在等你回答问题' },
        ],
        preflight: [],
      },
    }),
  );
  await page.route('**/api/issue-gate?**', async (route) => {
    // Writes must fall through to the fixture's recorder handler.
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        state: 'available',
        issue: {
          id: 'one',
          identifier: 'HER-1',
          title: '并行任务',
          status: 'blocked',
          owner: 'PL',
        },
        blocked: {
          waitingOn: '用户',
          action: '授权合入 PR #1',
          ageHours: 2.5,
          silentHours: 1.2,
          onBoard: true,
        },
        interactions: [
          {
            id: 'i-questions',
            kind: 'ask_user_questions',
            status: 'pending',
            title: '上线方式',
            summary: '需要你选择发布通道',
            createdAt: iso(-600000),
            submitLabel: '提交选择',
            questions: [
              {
                id: 'channel',
                prompt: '走哪条发布通道？',
                helpText: '灰度会先放 10% 流量',
                selectionMode: 'single',
                required: true,
                options: [
                  { id: 'canary', label: '灰度发布', description: '10% 流量' },
                  { id: 'full', label: '全量发布' },
                  { id: 'custom', label: '我来描述', freeText: true },
                ],
              },
              {
                id: 'notify',
                prompt: '要通知谁？',
                selectionMode: 'multi',
                options: [{ id: 'qa', label: 'QA' }],
              },
            ],
          },
        ],
      },
    });
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();

  await page.getByRole('button', { name: '巡检 2 项' }).click();
  await expect(page.getByRole('dialog', { name: '团队巡检' })).toBeVisible();
  await expect(page.getByText('在详情顶部填写回复即可继续')).toBeVisible();
  await expect(page.getByText('在详情顶部选择答案并提交')).toBeVisible();

  // Clicking the issue row opens the task detail with the actionable gate panel on top
  await page.locator('.ops-row-button', { hasText: 'HER-1' }).first().click();
  await expect(page.getByRole('dialog', { name: '团队巡检' })).toHaveCount(0);
  await expect(page.locator('.detail-title')).toContainText('HER-1');
  await expect(page.locator('.gate-panel')).toBeVisible();
  await expect(page.locator('.gate-chip.warn', { hasText: '等你处理' })).toBeVisible();
  await expect(page.locator('.gate-chip.warn', { hasText: '等你回答' })).toBeVisible();
  await expect(page.getByText('需要你：授权合入 PR #1')).toBeVisible();
  await expect(page.getByText('灰度会先放 10% 流量')).toBeVisible();

  // Required question blocks submission until an option is chosen
  await expect(page.getByRole('button', { name: '提交选择' })).toBeDisabled();
  await page.getByRole('button', { name: /灰度发布/ }).click();
  await expect(page.getByRole('button', { name: '提交选择' })).toBeEnabled();
  await page.getByRole('button', { name: '提交选择' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    path: '/api/issue-gate',
    company: 'c1',
    body: {
      issueId: 'one',
      action: 'respond',
      interactionId: 'i-questions',
      answers: [
        { questionId: 'channel', optionIds: ['canary'] },
        { questionId: 'notify', optionIds: [] },
      ],
    },
  });

  // The blocked card replies into the task thread and asks Paperclip to reopen it
  await page.getByRole('textbox', { name: '任务回复' }).fill('已授权，继续合入');
  await page.getByRole('button', { name: '回复并恢复任务' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    path: '/api/issue-gate',
    company: 'c1',
    body: { issueId: 'one', action: 'reply', text: '已授权，继续合入', reopen: true },
  });
});

const turnStart = Date.now() - 45_000;
const turnIso = (offset: number) => new Date(turnStart + offset).toISOString();
const thinkingSummary = 'summary[aria-label="思考过程"]';
const toolSummary = (name: string) => `summary[aria-label="工具调用 ${name}"]`;

// Mutable responses model polling and reloads without sending anything to a live backend.
async function timelineFixture(page: Page, steps: ActivityStep[] = []) {
  const model = {
    messages: [
      {
        id: 'ask',
        author: 'user',
        authorName: '我',
        ts: turnIso(0),
        text: '还有哪些任务要人工介入？',
      },
    ] as Message[],
    runs: [{ id: 'chat-run', status: 'running', startedAt: turnIso(0) }] as ChatActivityRun[],
    steps: { 'chat-run': steps } as Record<string, ActivityStep[]>,
    activityRequests: [] as string[],
    activityResponseDelayMs: 0,
    chatRequests: 0,
    writes: [] as string[],
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      model.writes.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === '/api/chat-activity') {
      const id = url.searchParams.get('run') || '';
      model.activityRequests.push(id);
      const steps = [...(model.steps[id] || [])];
      // Intentional server latency is outside the browser clock; notifications must still reach React.
      if (model.activityResponseDelayMs)
        await new Promise((resolve) => setTimeout(resolve, model.activityResponseDelayMs));
      await route.fulfill({ json: { state: steps.length ? 'available' : 'pending', steps } });
      return;
    }
    if (url.pathname === '/api/chat') model.chatRequests += 1;
    const activeRuns = model.runs.filter((run) => ['running', 'queued'].includes(run.status));
    const live = {
      running: activeRuns.filter((run) => run.status === 'running').length,
      queued: activeRuns.filter((run) => run.status === 'queued').length,
      taskRunning: 0,
      backgroundRunning: activeRuns.filter((run) => run.status === 'running').length,
      runs: activeRuns.map((run) => ({
        ...run,
        issueId: 'chat-pl',
        lastOutputAt: turnIso(37_000),
        linked: false,
      })),
    };
    const isPl = url.searchParams.get('agent') !== 'qa';
    const payload: Record<string, unknown> = {
      '/api/teams': { default: 'c1', teams: [{ id: 'c1', name: 'Hermes Lab' }] },
      '/api/state': {
        companyId: 'c1',
        agents: [{ ...agent('pl', 'PL'), live }, agent('qa', 'QA')],
        liveRunning: live.running,
        liveQueued: live.queued,
        liveTaskRunning: 0,
        liveBackgroundRunning: live.backgroundRunning,
      },
      '/api/chat': {
        state: 'available',
        chat: { id: isPl ? 'chat-pl' : 'chat-qa' },
        messages: isPl ? model.messages : model.messages.slice(0, 1),
        activityRuns: isPl ? model.runs : [],
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
  return model;
}

const bottomGap = (page: Page) =>
  page
    .locator('.chat-stream')
    .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);

test('shows chat turn state instead of a silent gap while the member works', async ({ page }) => {
  const model = await timelineFixture(page, [
    { id: 's1', kind: 'thinking', ts: turnIso(1000), text: '先核对看板上的未闭环任务' },
    {
      id: 's2',
      kind: 'tool_call',
      ts: turnIso(2000),
      toolCallId: 'list-issues',
      name: 'terminal',
      text: 'gh issue list --state open',
    },
    {
      id: 's3',
      kind: 'tool_result',
      ts: turnIso(3000),
      toolCallId: 'list-issues',
      name: 'terminal',
      text: '25 条未闭环',
    },
  ]);
  await page.goto('/');
  const status = page.locator('.chat-inner').getByRole('status');
  await expect(status).toContainText('PL 正在处理…');
  await expect(status).toContainText('前有输出');
  const thinking = page.locator('details.chat-event.thinking');
  const tool = page.locator('details.chat-event.tool');
  await expect(thinking.locator(thinkingSummary)).toBeVisible();
  await expect(tool.locator(toolSummary('terminal'))).toBeVisible();
  await expect(
    thinking.locator('.chat-event-detail').getByText('先核对看板上的未闭环任务', { exact: true }),
  ).not.toBeVisible();
  await thinking.locator(thinkingSummary).click();
  await tool.locator(toolSummary('terminal')).click();
  await expect(thinking).toHaveJSProperty('open', true);
  await expect(tool).toHaveJSProperty('open', true);
  await expect(
    thinking.locator('.chat-event-detail').getByText('先核对看板上的未闭环任务', { exact: true }),
  ).toBeVisible();
  await expect(tool).toContainText('gh issue list --state open');
  await expect(tool.getByText('25 条未闭环', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-flow')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开过程' })).toHaveCount(0);
  expect(
    await status.evaluate((element) => element === element.parentElement?.lastElementChild),
  ).toBe(true);

  // 没有运行接管时要如实说“已送达，等待”，而不是重复“正在处理”。
  await page.getByRole('button', { name: /^QA ·/ }).click();
  await expect(status).toContainText('已送达，等待 QA 处理…');
  await expect(page.locator('details.chat-event')).toHaveCount(0);
  expect(model.writes).toEqual([]);
});

test('interleaves thinking, assistant messages and exactly paired parallel tools by timestamp', async ({
  page,
}) => {
  const firstReply = '**先说明进展**\n\n- 正在检查两个并行命令';
  const finalReply = '**检查结束**，接下来请人工验收。';
  const model = await timelineFixture(page, [
    // Intentionally unordered: neither response order nor tool name identifies a call/result pair.
    { id: 'reply-final', kind: 'assistant', ts: turnIso(9000), text: finalReply },
    {
      id: 'result-b',
      kind: 'tool_result',
      toolCallId: 'call-b',
      name: 'terminal',
      ts: turnIso(6500),
      text: 'B 独有结果\n第二行 B',
    },
    { id: 'thought', kind: 'thinking', ts: turnIso(1000), text: '先检查上下文\n再并行执行' },
    {
      id: 'call-a',
      kind: 'tool_call',
      toolCallId: 'call-a',
      name: 'terminal',
      ts: turnIso(3000),
      text: 'printf "command-A"',
    },
    {
      id: 'orphan',
      kind: 'tool_result',
      toolCallId: 'missing-call',
      name: 'terminal',
      ts: turnIso(8000),
      text: '没有调用记录的独立结果',
    },
    { id: 'reply-first', kind: 'assistant', ts: turnIso(2000), text: firstReply },
    {
      id: 'call-b',
      kind: 'tool_call',
      toolCallId: 'call-b',
      name: 'terminal',
      ts: turnIso(4000),
      text: 'printf "command-B"',
    },
    {
      id: 'search',
      kind: 'tool_call',
      toolCallId: 'search-call',
      name: 'web_search',
      ts: turnIso(5000),
      text: '查询最新验收说明',
    },
    {
      id: 'search-result',
      kind: 'tool_result',
      toolCallId: 'search-call',
      name: 'web_search',
      ts: turnIso(5500),
      text: '搜索命中：验收清单',
    },
    {
      id: 'result-a',
      kind: 'tool_result',
      toolCallId: 'call-a',
      name: 'terminal',
      ts: turnIso(7000),
      text: 'A 独有结果\n第二行 A',
    },
  ]);
  model.messages.push({
    id: 'persisted-middle',
    author: 'agent',
    authorName: 'PL',
    ts: turnIso(2500),
    text: '已持久化的中途回复',
  });
  await page.goto('/');
  const timeline = page.locator('.chat-inner');
  const items = timeline.locator(':scope > .chat-message, :scope > .chat-event');
  await expect(items).toHaveCount(9);
  await expect(items.nth(0)).toContainText('还有哪些任务要人工介入？');
  await expect(items.nth(1)).toHaveClass(/chat-event thinking/);
  await expect(items.nth(2)).toHaveClass(/chat-message agent/);
  await expect(items.nth(2).locator('.message-bubble strong')).toHaveText('先说明进展');
  await expect(items.nth(2).locator('.message-bubble li')).toHaveText('正在检查两个并行命令');
  await expect(items.nth(3)).toContainText('已持久化的中途回复');
  await expect(items.nth(4)).toContainText('command-A');
  await expect(items.nth(5)).toContainText('command-B');
  await expect(items.nth(6).locator(toolSummary('web_search'))).toBeVisible();
  await expect(items.nth(7)).toHaveClass(/chat-event tool/);
  await expect(items.nth(8).locator('.message-bubble strong')).toHaveText('检查结束');
  await expect(timeline.locator('details article.chat-message.agent')).toHaveCount(0);
  await expect(timeline.locator('article.chat-message.agent')).toHaveCount(3);
  const callA = items.nth(4);
  const callB = items.nth(5);
  await callA.locator(toolSummary('terminal')).click();
  await callB.locator(toolSummary('terminal')).click();
  await expect(callA.getByText('A 独有结果\n第二行 A', { exact: true })).toBeVisible();
  await expect(callA).not.toContainText('B 独有结果');
  await expect(callB.getByText('B 独有结果\n第二行 B', { exact: true })).toBeVisible();
  await expect(callB).not.toContainText('A 独有结果');
  await items.nth(6).locator(toolSummary('web_search')).click();
  await expect(items.nth(6).getByText('搜索命中：验收清单', { exact: true })).toBeVisible();
  await items.nth(7).locator(toolSummary('terminal')).click();
  await expect(items.nth(7).getByText('没有调用记录的独立结果', { exact: true })).toBeVisible();
});

test('independently expands full multiline thinking and tools and preserves open events through polling', async ({
  page,
}) => {
  const thoughtText = '第一行：核对任务\n第二行：保留完整推理\n\n第四行：独立展开';
  const command = 'python - <<\'PY\'\nprint("first")\nprint("second")\nPY';
  const traceback =
    'Traceback (most recent call last):\n  File "check.py", line 2\nRuntimeError: 完整失败详情';
  const model = await timelineFixture(page, [
    { id: 'shared-thought', kind: 'thinking', ts: turnIso(1000), text: thoughtText },
    {
      id: 'shared-call',
      kind: 'tool_call',
      toolCallId: 'shared-call',
      name: 'terminal',
      ts: turnIso(2000),
      text: command,
    },
    {
      id: 'shared-result',
      kind: 'tool_result',
      toolCallId: 'shared-call',
      name: 'terminal',
      ts: turnIso(3000),
      text: 'first\nsecond\n',
    },
    {
      id: 'failed-call',
      kind: 'tool_call',
      toolCallId: 'failed-call',
      name: 'web_search',
      ts: turnIso(4000),
      text: '查询失败案例',
    },
    {
      id: 'failed-result',
      kind: 'tool_result',
      toolCallId: 'failed-call',
      name: 'web_search',
      ts: turnIso(5000),
      text: traceback,
      isError: true,
    },
  ]);
  // IDs deliberately collide across runs; expansion must be scoped to the run, not the raw step ID.
  model.runs.unshift({
    id: 'older-run',
    status: 'succeeded',
    createdAt: turnIso(-10_000),
    finishedAt: turnIso(-1000),
  });
  model.steps['older-run'] = [
    {
      id: 'shared-thought',
      kind: 'thinking',
      ts: turnIso(-9000),
      text: '上一回合的思考\n保持折叠',
    },
    {
      id: 'shared-call',
      kind: 'tool_call',
      toolCallId: 'shared-call',
      name: 'terminal',
      ts: turnIso(-8000),
      text: 'echo previous-turn',
    },
    {
      id: 'shared-result',
      kind: 'tool_result',
      toolCallId: 'shared-call',
      name: 'terminal',
      ts: turnIso(-7000),
      text: '上一回合独有结果',
    },
  ];
  await page.goto('/');
  const thoughts = page.locator('details.chat-event.thinking');
  const tools = page.locator('details.chat-event.tool');
  await expect(thoughts).toHaveCount(2);
  await expect(tools).toHaveCount(3);
  const thought = thoughts.nth(1);
  const tool = tools.nth(1);
  const failure = tools.nth(2);
  const eventIds = await page
    .locator('details.chat-event')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-event-id')));
  expect(eventIds.every(Boolean)).toBe(true);
  expect(new Set(eventIds).size).toBe(eventIds.length);
  const thoughtId = await thought.getAttribute('data-event-id');
  const toolId = await tool.getAttribute('data-event-id');
  expect(thoughtId).toContain('chat-run');
  expect(toolId).toContain('chat-run');
  await expect(failure.locator(toolSummary('web_search'))).toContainText('执行失败');
  await expect(failure.locator('summary')).not.toContainText('Traceback');
  await expect(failure.getByText(traceback, { exact: true })).not.toBeVisible();
  await thought.locator(thinkingSummary).click();
  const thinkingParagraphs = thought.locator('.chat-event-detail p');
  await expect(thinkingParagraphs).toHaveText(thoughtText.split('\n\n'));
  await expect(thinkingParagraphs.first()).toBeVisible();
  expect(await thinkingParagraphs.first().textContent()).toBe(thoughtText.split('\n\n')[0]);
  await expect(tool).toHaveJSProperty('open', false);
  await tool.locator(toolSummary('terminal')).click();
  await expect(
    tool.locator('.chat-event-detail').getByText(command, { exact: true }),
  ).toBeVisible();
  expect(
    await tool.locator('.chat-event-detail').getByText(command, { exact: true }).textContent(),
  ).toBe(command);
  expect(await tool.getByText('first\nsecond\n', { exact: true }).textContent()).toBe(
    'first\nsecond\n',
  );
  await expect(thought).toHaveJSProperty('open', true);
  await expect(thoughts.nth(0)).toHaveJSProperty('open', false);
  await expect(tools.nth(0)).toHaveJSProperty('open', false);
  await expect(tool).not.toContainText('上一回合独有结果');

  model.activityResponseDelayMs = 250;
  const activeRequests = model.activityRequests.filter((id) => id === 'chat-run').length;
  expect(activeRequests).toBeGreaterThanOrEqual(1);
  expect(model.activityRequests.filter((id) => id === 'older-run')).toHaveLength(1);
  model.steps['chat-run'].push({
    id: 'next-thought',
    kind: 'thinking',
    ts: turnIso(6000),
    text: '轮询新到的思考',
  });
  // Keep real timers running: fetch/json completion can schedule React Query's setTimeout(0)
  // notification after any fixed virtual-time slice has ended.
  await expect(thoughts).toHaveCount(3, { timeout: 10_000 });
  await expect(thought).toHaveAttribute('data-event-id', thoughtId!);
  await expect(tool).toHaveAttribute('data-event-id', toolId!);
  expect(model.activityRequests.filter((id) => id === 'chat-run').length).toBeGreaterThan(
    activeRequests,
  );
  expect(model.activityRequests.filter((id) => id === 'older-run')).toHaveLength(1);
  await expect(thought).toHaveJSProperty('open', true);
  await expect(tool).toHaveJSProperty('open', true);
  await expect(thoughts.nth(0)).toHaveJSProperty('open', false);
  await expect(thoughts.nth(2)).toHaveJSProperty('open', false);
  await expect(failure).toHaveJSProperty('open', false);
  await failure.locator(toolSummary('web_search')).click();
  await expect(failure.getByText(traceback, { exact: true })).toBeVisible();
  expect(await failure.getByText(traceback, { exact: true }).textContent()).toBe(traceback);
  await thought.locator(thinkingSummary).click();
  await expect(thought).toHaveJSProperty('open', false);
  await expect(tool).toHaveJSProperty('open', true);
  await expect(failure).toHaveJSProperty('open', true);
});

test('retains completed activity after reload without duplicating the posted final comment', async ({
  page,
}) => {
  const finalText = '**最终答复**\n\n检查完成，请人工验收。';
  const model = await timelineFixture(page, [
    {
      id: 'completed-thought',
      kind: 'thinking',
      ts: turnIso(1000),
      text: '完成前的完整思考\n下一行仍保留',
    },
    {
      id: 'completed-call',
      kind: 'tool_call',
      toolCallId: 'completed-call',
      name: 'terminal',
      ts: turnIso(2000),
      text: 'echo verified',
    },
    {
      id: 'completed-result',
      kind: 'tool_result',
      toolCallId: 'completed-call',
      name: 'terminal',
      ts: turnIso(3000),
      text: 'verified',
    },
    { id: 'completed-reply', kind: 'assistant', ts: turnIso(4000), text: finalText },
  ]);
  // Identical prose from an earlier turn is legitimate history, not a global-text duplicate.
  model.messages.unshift({
    id: 'old-final',
    author: 'agent',
    authorName: 'PL',
    ts: turnIso(-60_000),
    text: finalText,
  });
  await page.goto('/');
  const finalBubbles = page
    .locator('article.chat-message.agent .message-bubble')
    .filter({ hasText: '最终答复' });
  await expect(finalBubbles).toHaveCount(2);
  await expect(page.locator('details.chat-event')).toHaveCount(2);
  model.runs[0] = { ...model.runs[0], status: 'succeeded', finishedAt: turnIso(5000) };
  model.messages.push({
    id: 'posted-final',
    author: 'agent',
    authorName: 'PL',
    ts: turnIso(6000),
    text: finalText,
  });
  await expect(page.locator('.chat-inner').getByRole('status')).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(finalBubbles).toHaveCount(2);
  await expect(page.locator('details.chat-event')).toHaveCount(2);

  model.activityRequests.length = 0;
  await page.reload();
  await expect(finalBubbles).toHaveCount(2);
  await expect(page.locator('details.chat-event')).toHaveCount(2);
  expect(model.activityRequests).toEqual(['chat-run']);
  await page.locator('details.chat-event.thinking').locator(thinkingSummary).click();
  await expect(
    page.locator('.thinking-detail').getByText('完成前的完整思考\n下一行仍保留', { exact: true }),
  ).toBeVisible();
  await page.locator('details.chat-event.tool').locator(toolSummary('terminal')).click();
  await expect(
    page.locator('details.chat-event.tool').getByText('verified', { exact: true }),
  ).toBeVisible();
  // Observe two subsequent real chat polls with timers still running.
  // Completed activity must stay at its one reload read throughout this observation window.
  const chatRequests = model.chatRequests;
  await expect
    .poll(() => model.chatRequests, { timeout: 12_000 })
    .toBeGreaterThanOrEqual(chatRequests + 2);
  expect(model.activityRequests).toEqual(['chat-run']);
  await expect(finalBubbles).toHaveCount(2);
  expect(model.writes).toEqual([]);
});

test('shows the initial empty activity hint only inside the bottom status', async ({ page }) => {
  const model = await timelineFixture(page);
  await page.goto('/');
  const status = page.locator('.chat-inner').getByRole('status');
  await expect(status).toContainText('PL 正在处理…');
  await expect(status).toContainText('等待模型的第一个输出');
  await expect(page.getByText('等待模型的第一个输出', { exact: true })).toHaveCount(1);
  await expect(page.locator('details.chat-event, .chat-flow')).toHaveCount(0);
  expect(
    await status.evaluate((element) => element === element.parentElement?.lastElementChild),
  ).toBe(true);
  expect(model.writes).toEqual([]);
});

test('activity polling follows the bottom only while the reader remains sticky', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  const model = await timelineFixture(page, [
    { id: 'scroll-thought', kind: 'thinking', ts: turnIso(1000), text: '准备继续输出' },
  ]);
  model.messages.unshift(
    ...Array.from({ length: 30 }, (_, index): Message => ({
      id: `history-${index}`,
      author: 'agent',
      authorName: 'PL',
      ts: turnIso(-60_000 + index * 1000),
      text: `历史消息 ${index}\n\n${'这是供读者回看的一段旧对话。'.repeat(12)}`,
    })),
  );
  await page.goto('/');
  const stream = page.locator('.chat-stream');
  await expect(page.locator('details.chat-event.thinking')).toHaveCount(1);
  await expect.poll(() => bottomGap(page)).toBeLessThan(4);
  model.activityResponseDelayMs = 250;
  const initialHeight = await stream.evaluate((element) => element.scrollHeight);
  model.steps['chat-run'].push({
    id: 'sticky-reply',
    kind: 'assistant',
    ts: turnIso(2000),
    text: `贴底时新增回复\n\n${'新输出应自动跟随。\n\n'.repeat(12)}`,
  });
  const stickyRequests = model.activityRequests.length;
  await expect(
    page.locator('article.chat-message.agent').filter({ hasText: '贴底时新增回复' }),
  ).toHaveCount(1, { timeout: 10_000 });
  expect(model.activityRequests.length).toBeGreaterThan(stickyRequests);
  expect(await stream.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    initialHeight + 100,
  );
  await expect.poll(() => bottomGap(page)).toBeLessThan(4);

  await stream.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible();
  const readingTop = await stream.evaluate((element) => element.scrollTop);
  model.steps['chat-run'].push({
    id: 'nonsticky-reply',
    kind: 'assistant',
    ts: turnIso(3000),
    text: `回看时新增回复\n\n${'不要把读者强制拉回底部。\n\n'.repeat(12)}`,
  });
  const nonstickyRequests = model.activityRequests.length;
  const newReply = page.locator('article.chat-message.agent').filter({ hasText: '回看时新增回复' });
  await expect(newReply).toHaveCount(1, { timeout: 10_000 });
  expect(model.activityRequests.length).toBeGreaterThan(nonstickyRequests);
  await expect(newReply).not.toBeInViewport();
  expect(await stream.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible();
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await expect.poll(() => bottomGap(page)).toBeLessThan(4);
  expect(model.writes).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`long expanded activity has no horizontal overflow at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const longToken = 'very_long_unbroken_command_argument_'.repeat(100);
    const thoughtText = `第一行完整思考\n${longToken}\n最后一行完整思考`;
    const command = `terminal --payload=${longToken}\n  --second-line=保留多行`;
    const result = `完整输出第一行\n${longToken}\n完整输出最后一行`;
    const model = await timelineFixture(page, [
      { id: 'long-thought', kind: 'thinking', ts: turnIso(1000), text: thoughtText },
      {
        id: 'long-call',
        kind: 'tool_call',
        toolCallId: 'long-call',
        name: 'terminal',
        ts: turnIso(2000),
        text: command,
      },
      {
        id: 'long-result',
        kind: 'tool_result',
        toolCallId: 'long-call',
        name: 'terminal',
        ts: turnIso(3000),
        text: result,
      },
    ]);
    await page.goto('/');
    const assertNoOverflow = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const detail of await page.locator('details.chat-event').all()) {
        const bounds = await detail.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      }
    };
    await expect(page.locator('details.chat-event')).toHaveCount(2);
    await assertNoOverflow();
    const thinking = page.locator('details.chat-event.thinking');
    const tool = page.locator('details.chat-event.tool');
    await thinking.locator(thinkingSummary).click();
    await tool.locator(toolSummary('terminal')).click();
    await expect(
      thinking.locator('.chat-event-detail').getByText(thoughtText, { exact: true }),
    ).toBeVisible();
    await expect(
      tool.locator('.chat-event-detail').getByText(command, { exact: true }),
    ).toBeVisible();
    await expect(tool.getByText(result, { exact: true })).toBeVisible();
    expect(
      await tool.locator('.chat-event-detail').getByText(command, { exact: true }).textContent(),
    ).toBe(command);
    expect(await tool.getByText(result, { exact: true }).textContent()).toBe(result);
    await assertNoOverflow();
    const screenshot = testInfo.outputPath(`activity-expanded-${width}.png`);
    await page.screenshot({ path: screenshot, animations: 'disabled' });
    await testInfo.attach(`activity-expanded-${width}`, {
      path: screenshot,
      contentType: 'image/png',
    });
    expect(model.writes).toEqual([]);
  });
}
