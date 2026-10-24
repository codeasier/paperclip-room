import { expect, test, type Page, type Route } from '@playwright/test';

const now = Date.now() - 120000;
const iso = (offset = 0) => new Date(now + offset).toISOString();

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

type MemberFixtureOptions = {
  instructionsMode?: 'writable' | 'readonly' | 'unavailable';
  maxConcurrentRuns?: number;
  warning?: string | null;
};

function memberConfig(options: MemberFixtureOptions = {}) {
  const mode = options.instructionsMode ?? 'readonly';
  return {
    agentId: 'pl',
    companyId: 'c1',
    fetchedAt: iso(),
    runtime: {
      model: 'glm-5.3',
      timeoutSec: 3600,
      maxConcurrentRuns: options.maxConcurrentRuns ?? 2,
      maxConcurrentRunsPlatformDefault: 20,
      maxConcurrentRunsCapped: false,
      warning: options.warning ?? null,
    },
    identity: {
      name: 'PL',
      title: '团队成员',
      instructions: {
        mode,
        source: mode === 'unavailable' ? null : mode === 'writable' ? 'bundle' : 'bundle',
        path: mode === 'unavailable' ? null : 'AGENTS.md',
        content: mode === 'unavailable' ? '' : 'You are PL.\nLine2\nLine3',
        probeNote: mode === 'unavailable' ? '无 bundle / promptTemplate' : null,
      },
    },
    memory: {
      sessionReuse: {
        state: 'reused',
        detail: '最近 run 复用了 session',
        source: 'runs.sessionIdAfter',
        asOf: iso(-60000),
      },
      handoff: {
        state: 'available',
        files: [{ path: '.handoff/HER-1.md', mtime: iso(-30000) }],
        source: 'workdir/.handoff',
        asOf: iso(),
      },
      contextSize: {
        state: 'available',
        approxChars: 12345,
        unit: 'chars',
        source: 'HERMES_DB',
        asOf: iso(),
      },
    },
  };
}

async function fixture(page: Page, options: MemberFixtureOptions = {}) {
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let config = memberConfig(options);

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'POST' && url.pathname === '/api/member-config') {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path: url.pathname, method, body });
      if (typeof body.timeoutSec === 'number' && body.timeoutSec < 1200) {
        await route.fulfill({
          status: 400,
          json: { ok: false, error: '超时须 ≥ 1200 秒（与巡检一致）', field: 'timeoutSec' },
        });
        return;
      }
      if (
        typeof body.maxConcurrentRuns === 'number' &&
        (body.maxConcurrentRuns < 0 || body.maxConcurrentRuns > 8)
      ) {
        await route.fulfill({
          status: 400,
          json: { ok: false, error: '并发须为 0–8 的整数', field: 'maxConcurrentRuns' },
        });
        return;
      }
      if ('instructions' in body && config.identity.instructions.mode !== 'writable') {
        await route.fulfill({
          status: 409,
          json: { ok: false, error: '当前不可写 instructions', field: 'instructions' },
        });
        return;
      }
      const applied = Object.keys(body).filter((key) => key !== 'agentId');
      if (typeof body.model === 'string')
        config = { ...config, runtime: { ...config.runtime, model: body.model } };
      if (typeof body.timeoutSec === 'number')
        config = { ...config, runtime: { ...config.runtime, timeoutSec: body.timeoutSec } };
      if (typeof body.maxConcurrentRuns === 'number')
        config = {
          ...config,
          runtime: { ...config.runtime, maxConcurrentRuns: body.maxConcurrentRuns, warning: null },
        };
      if (typeof body.name === 'string')
        config = { ...config, identity: { ...config.identity, name: body.name } };
      if (typeof body.title === 'string')
        config = { ...config, identity: { ...config.identity, title: body.title } };
      if (typeof body.instructions === 'string')
        config = {
          ...config,
          identity: {
            ...config.identity,
            instructions: { ...config.identity.instructions, content: body.instructions },
          },
        };
      await route.fulfill({
        json: {
          ok: true,
          applied,
          runtime: config.runtime,
          identity: { name: config.identity.name, title: config.identity.title },
        },
      });
      return;
    }

    if (method === 'POST') {
      writes.push({
        path: url.pathname,
        method,
        body: (request.postDataJSON() as Record<string, unknown>) || {},
      });
      await route.fulfill({ json: { ok: true, issue: 'HER-2' } });
      return;
    }

    if (url.pathname === '/api/member-config') {
      await route.fulfill({ json: config });
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
            authorName: 'PL',
            text: '你好，准备开始。',
          },
        ],
      },
      '/api/tasks': { state: 'available', tasks: [], note: '有界查询，非完整历史。' },
      '/api/ops': {
        tasks: { total: 0, stale: [], awaiting: [] },
        blocked: { count: 0, onBoard: 0, over24h: 0, items: [] },
        runs: { recent: { hours: 24, failed: 0, timedOut: 0 } },
        alerts: [],
        preflight: [],
      },
      '/api/room': { events: [] },
      '/api/execution': { state: 'available', runs: [] },
    };
    await route.fulfill({ json: response[url.pathname] || {} });
  });

  await page.goto('/');
  await expect(page.getByText('你好，准备开始。')).toBeVisible();
  return { writes, getConfig: () => config };
}

async function openProps(page: Page) {
  await page.getByRole('button', { name: '打开成员属性' }).click();
  await expect(page.getByText('成员属性 · PL')).toBeVisible();
  await expect(page.getByText('读取成员配置…').or(page.getByText('运行配置'))).toBeVisible();
  await expect(page.getByRole('tab', { name: '运行配置' })).toBeVisible();
}

test('T12 Diff 强制：未确认不发 POST', async ({ page }) => {
  const { writes } = await fixture(page);
  await openProps(page);
  await page.getByLabel('超时秒数').fill('4800');
  await page.getByRole('button', { name: '保存…' }).click();
  await expect(page.getByText('保存前确认')).toBeVisible();
  expect(writes.filter((item) => item.path === '/api/member-config')).toHaveLength(0);
  await page.getByRole('button', { name: '确认保存' }).click();
  await expect
    .poll(() => writes.filter((item) => item.path === '/api/member-config').length)
    .toBe(1);
  expect(writes.find((item) => item.path === '/api/member-config')?.body.timeoutSec).toBe(4800);
});

test('T13 非法值 UI 拦：timeout < 1200 禁用保存', async ({ page }) => {
  const { writes } = await fixture(page);
  await openProps(page);
  const timeout = page.getByLabel('超时秒数');
  await timeout.click();
  await timeout.fill('1199');
  await timeout.blur();
  await expect(page.getByText('超时须 ≥ 1200 秒（与巡检一致）')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存…' })).toBeDisabled();
  expect(writes.filter((item) => item.path === '/api/member-config')).toHaveLength(0);
});

test('T14 并发 0 文案可见且区分 pause', async ({ page }) => {
  await fixture(page);
  await openProps(page);
  await page.getByLabel('最大并发').fill('0');
  await expect(page.getByText('不领取新 run', { exact: true })).toBeVisible();
  await expect(page.locator('.ant-alert-description')).toContainText('暂停成员（pause）');
});

test('T15 instructions 只读：Tag + 可只存 name/title', async ({ page }) => {
  const { writes } = await fixture(page, { instructionsMode: 'readonly' });
  await openProps(page);
  await page.getByRole('tab', { name: '身份' }).click();
  await expect(page.getByText('只读').first()).toBeVisible();
  await expect(page.getByLabel('成员 instructions')).toHaveCount(0);
  await page.getByLabel('成员名称').fill('PL-Leader');
  await page.getByRole('button', { name: '保存…' }).click();
  await expect(page.getByText('保存前确认')).toBeVisible();
  await expect(
    page.locator('.member-props-diff .member-props-diff-row strong', { hasText: 'instructions' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '确认保存' }).click();
  await expect
    .poll(() => writes.filter((item) => item.path === '/api/member-config').length)
    .toBe(1);
  const body = writes.find((item) => item.path === '/api/member-config')!.body;
  expect(body.name).toBe('PL-Leader');
  expect(body).not.toHaveProperty('instructions');
});

test('T16 instructions 可写：Diff + 确认修改 instructions', async ({ page }) => {
  const { writes } = await fixture(page, { instructionsMode: 'writable' });
  await openProps(page);
  await page.getByRole('tab', { name: '身份' }).click();
  await page.getByLabel('成员 instructions').fill('Updated instructions for all future tasks.');
  await page.getByRole('button', { name: '保存…' }).click();
  await expect(page.getByText('保存前确认')).toBeVisible();
  await expect(
    page.getByText('修改 instructions 会影响该成员后续全部任务与对话的行为'),
  ).toBeVisible();
  await page.getByRole('button', { name: '确认修改 instructions' }).click();
  await expect
    .poll(() => writes.filter((item) => item.path === '/api/member-config').length)
    .toBe(1);
  expect(writes.at(-1)?.body.instructions).toContain('Updated instructions');
});

test('T17 记忆 Tab 无编辑控件', async ({ page }) => {
  await fixture(page);
  await openProps(page);
  await page.getByRole('tab', { name: /记忆/ }).click();
  await expect(page.getByText('复用会话')).toBeVisible();
  await expect(
    page.locator('.member-props-memory input, .member-props-memory textarea'),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存…' })).toHaveCount(0);
  await expect(page.getByText('不能在此修改')).toBeVisible();
});

test('T18 ≤760 烟测：抽屉全宽、底栏可点', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await fixture(page);
  await openProps(page);
  const slot = page.locator('.detail-slot');
  await expect(slot).toBeVisible();
  const box = await slot.boundingBox();
  expect(box?.width).toBeGreaterThan(700);
  await page.getByLabel('最大并发').fill('1');
  await expect(page.getByRole('button', { name: '保存…' })).toBeEnabled();
});

test('T19 与详情互斥', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: '打开任务详情' }).click();
  await expect(page.getByText('点击消息、任务或运行查看对应详情。')).toBeVisible();
  await page.getByRole('button', { name: '打开成员属性' }).click();
  await expect(page.getByText('成员属性 · PL')).toBeVisible();
  await expect(page.getByText('点击消息、任务或运行查看对应详情。')).toHaveCount(0);
  await page.getByRole('button', { name: '打开任务详情' }).click();
  await expect(page.getByText('点击消息、任务或运行查看对应详情。')).toBeVisible();
  await expect(page.getByText('成员属性 · PL')).toHaveCount(0);
});

test('T20 Composer 模型快捷仍在', async ({ page }) => {
  const { writes } = await fixture(page);
  await expect(page.getByRole('combobox', { name: '成员模型' })).toBeVisible();
  await openProps(page);
  // Desktop keeps the composer beside the props drawer.
  await expect(page.getByRole('combobox', { name: '成员模型' })).toBeVisible();
  // Close props, then exercise Composer POST /api/model (not member-config).
  await page.getByRole('button', { name: '打开成员属性' }).click();
  await expect(page.getByText('成员属性 · PL')).toHaveCount(0);
  await page.getByRole('combobox', { name: '成员模型' }).click();
  await page.getByTitle('MiniMax-M3.1-Flash', { exact: true }).click();
  await expect.poll(() => writes.some((item) => item.path === '/api/model')).toBe(true);
  expect(writes.find((item) => item.path === '/api/model')?.body).toMatchObject({
    agentId: 'pl',
    model: 'MiniMax-M3.1-Flash',
  });
  expect(writes.some((item) => item.path === '/api/member-config')).toBe(false);
});

test('无变更点保存 toast', async ({ page }) => {
  await fixture(page);
  await openProps(page);
  // Force dirty then discard, then try save with no dirty — button hidden when clean
  await page.getByLabel('最大并发').fill('3');
  await page.getByRole('button', { name: '放弃' }).click();
  await expect(page.getByRole('button', { name: '保存…' })).toHaveCount(0);
});
