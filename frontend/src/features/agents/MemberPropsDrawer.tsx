import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tabs,
  Typography,
} from 'antd';
import { apiUrl, getJSON, postMemberConfig } from '../../api/client';
import type { Agent, MemberConfig, MemberConfigWritableKey } from '../../api/types';
import { MemberAvatar, roleLabel } from '../../components/MemberAvatar';
import { models } from '../../lib/format';
import {
  CONCURRENT_MIN,
  CONCURRENT_ZERO_DETAIL,
  CONCURRENT_ZERO_DIFF_NOTE,
  CONCURRENT_ZERO_HELP,
  TIMEOUT_MIN_SEC,
  buildWriteBody,
  dirtyKeys,
  fieldLabel,
  formatDiffValue,
  snapshotFromConfig,
  validateDirty,
  type DraftFields,
  type FieldErrors,
} from '../../lib/memberConfig';

interface Props {
  company: string;
  agent: Agent;
  open: boolean;
  onClose: () => void;
}

type TabKey = 'runtime' | 'identity' | 'memory';

function freshnessLabel(asOf?: string | null, fetchedAt?: string) {
  const stamp = asOf || fetchedAt;
  if (!stamp) return '未知';
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) return stamp;
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function sessionReuseLabel(state: string) {
  if (state === 'reused') return '复用会话';
  if (state === 'fresh') return '未复用';
  return '暂无数据';
}

export function MemberPropsDrawer({ company, agent, open, onClose }: Props) {
  const { message, modal } = App.useApp();
  const client = useQueryClient();
  const titleRef = useRef<HTMLSpanElement>(null);
  const [tab, setTab] = useState<TabKey>('runtime');
  const [draft, setDraft] = useState<DraftFields | null>(null);
  const [snapshot, setSnapshot] = useState<DraftFields | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const configQuery = useQuery({
    queryKey: ['/api/member-config', company, agent.id],
    queryFn: ({ signal }) =>
      getJSON<MemberConfig>(apiUrl('/api/member-config', company, { agent: agent.id }), signal),
    enabled: open && Boolean(company && agent.id),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !diffOpen) requestClose();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
    // requestClose closes over latest draft/snapshot; rebind when those change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, diffOpen, draft, snapshot]);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => titleRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
  }, [open, agent.id]);

  useEffect(() => {
    if (configQuery.data) {
      const next = snapshotFromConfig(configQuery.data);
      setSnapshot(next);
      setDraft(next);
    }
  }, [configQuery.data]);

  const instructionsWritable = configQuery.data?.identity.instructions.mode === 'writable';
  const instructionsMode = configQuery.data?.identity.instructions.mode;
  const runtimeWarning = configQuery.data?.runtime.warning;

  const dirty = useMemo(() => {
    if (!draft || !snapshot) return [] as MemberConfigWritableKey[];
    return dirtyKeys(draft, snapshot, { instructionsWritable });
  }, [draft, snapshot, instructionsWritable]);

  const errors: FieldErrors = useMemo(() => {
    if (!draft) return {};
    return validateDirty(draft, dirty, { instructionsWritable });
  }, [draft, dirty, instructionsWritable]);

  const hasErrors = Object.keys(errors).length > 0;
  const canSave = dirty.length > 0 && !hasErrors && !configQuery.isError;

  const patchDraft = (patch: Partial<DraftFields>) => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));
  };

  const discard = () => {
    if (snapshot) setDraft({ ...snapshot });
  };

  const requestClose = () => {
    if (dirty.length > 0) {
      modal.confirm({
        title: '有未保存的修改，确定关闭？',
        okText: '丢弃并关闭',
        cancelText: '继续编辑',
        onOk: () => {
          discard();
          onClose();
        },
      });
      return;
    }
    onClose();
  };

  const saveMutation = useMutation({
    mutationFn: async (body: ReturnType<typeof buildWriteBody>) =>
      postMemberConfig(apiUrl('/api/member-config', company), body),
  });

  const openDiff = () => {
    if (!draft || !snapshot) return;
    if (dirty.length === 0) {
      void message.info('没有需要保存的更改');
      return;
    }
    if (hasErrors) {
      void message.error('请先修正标红字段');
      return;
    }
    setDiffOpen(true);
  };

  const confirmSave = async () => {
    if (!draft || !snapshot) return;
    const body = buildWriteBody(agent.id, draft, dirty);
    setSaving(true);
    try {
      const { status, body: result } = await saveMutation.mutateAsync(body);
      if (status === 409 || result.field === 'instructions') {
        void message.error(result.error || '当前 instructions 不可写');
        setDiffOpen(false);
        await configQuery.refetch();
        return;
      }
      if (result.ok) {
        void message.success('已保存');
        setDiffOpen(false);
        await Promise.all([
          client.invalidateQueries({ queryKey: ['/api/state', company] }),
          client.invalidateQueries({ queryKey: ['/api/ops', company] }),
          configQuery.refetch(),
        ]);
        return;
      }
      if (result.applied && result.applied.length > 0) {
        void message.warning(result.error || '部分已保存');
        setDiffOpen(false);
        await Promise.all([
          client.invalidateQueries({ queryKey: ['/api/state', company] }),
          client.invalidateQueries({ queryKey: ['/api/ops', company] }),
          configQuery.refetch(),
        ]);
        return;
      }
      void message.error(result.error || `保存失败（HTTP ${status}）`);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const runningText = agent.live.taskRunning
    ? `${agent.live.taskRunning} 个任务运行`
    : agent.live.backgroundRunning
      ? `${agent.live.backgroundRunning} 个后台运行`
      : agent.live.queued
        ? `${agent.live.queued} 个排队`
        : '待命中';

  const modelOptions = [
    ...new Set([
      ...models,
      ...(agent.model ? [agent.model] : []),
      ...(draft?.model ? [draft.model] : []),
    ]),
  ].map((value) => ({
    value,
    label: value.replace(/^volcengine\//, ''),
  }));

  const instructionsChanged = dirty.includes('instructions');
  const showFooter = dirty.length > 0;

  const footer =
    showFooter || tab === 'memory' ? (
      <div className="member-props-footer">
        {tab === 'memory' && dirty.length > 0 && (
          <Typography.Text type="secondary" className="member-props-footer-hint">
            其它页签有未保存修改
          </Typography.Text>
        )}
        {tab !== 'memory' && dirty.length > 0 && (
          <span className="member-props-dirty">已改 {dirty.length} 项</span>
        )}
        {tab === 'memory' && dirty.length === 0 ? null : (
          <Space>
            <Button onClick={discard} disabled={dirty.length === 0 || saving}>
              放弃
            </Button>
            <Button type="primary" onClick={openDiff} disabled={!canSave || saving}>
              保存…
            </Button>
          </Space>
        )}
      </div>
    ) : null;

  return (
    <>
      <Drawer
        title={
          <span ref={titleRef} tabIndex={-1} className="member-props-title">
            成员属性 · {agent.name}
          </span>
        }
        open={open}
        onClose={requestClose}
        size="100%"
        getContainer={false}
        rootStyle={{ position: 'absolute' }}
        mask={false}
        push={false}
        focusable={{ trap: false }}
        closable={{ placement: 'end' }}
        styles={{ wrapper: { boxShadow: 'none' } }}
        className="detail-drawer member-props-drawer"
        destroyOnHidden
        footer={footer}
      >
        <div className="member-props-hero">
          <MemberAvatar name={agent.name} size={36} />
          <div className="member-props-hero-copy">
            <strong>{draft?.name || agent.name}</strong>
            <Typography.Text type="secondary">
              {roleLabel(draft?.name || agent.name, draft?.title ?? agent.title)} · {runningText}
            </Typography.Text>
          </div>
          <Tag className="status-chip">{runningText === '待命中' ? '待命' : runningText}</Tag>
        </div>

        {configQuery.isPending && (
          <div className="member-props-loading">
            <Spin tip="读取成员配置…" />
          </div>
        )}

        {configQuery.isError && (
          <Alert
            type="error"
            showIcon
            title="读取成员配置失败"
            description={configQuery.error.message}
            action={
              <Button size="small" onClick={() => void configQuery.refetch()}>
                重试
              </Button>
            }
          />
        )}

        {configQuery.data && draft && (
          <Tabs
            className="member-props-tabs"
            activeKey={tab}
            onChange={(key) => setTab(key as TabKey)}
            items={[
              {
                key: 'runtime',
                label: '运行配置',
                children: (
                  <Form layout="vertical" className="member-props-form" requiredMark={false}>
                    {runtimeWarning && (
                      <Alert
                        className="member-props-alert"
                        type="warning"
                        showIcon
                        title={runtimeWarning}
                      />
                    )}
                    <Form.Item
                      label="模型"
                      validateStatus={errors.model ? 'error' : undefined}
                      help={errors.model}
                    >
                      <Select
                        aria-label="属性模型"
                        showSearch
                        value={draft.model || undefined}
                        options={modelOptions}
                        onChange={(value) => patchDraft({ model: value })}
                        placeholder="请选择或填写模型"
                      />
                    </Form.Item>
                    <Form.Item
                      label="超时 timeoutSec（秒）"
                      validateStatus={errors.timeoutSec ? 'error' : undefined}
                      help={
                        errors.timeoutSec || `须 ≥ ${TIMEOUT_MIN_SEC}，低于会触发巡检 timeout_low`
                      }
                    >
                      <InputNumber
                        aria-label="超时秒数"
                        className="member-props-number"
                        min={0}
                        step={60}
                        value={draft.timeoutSec ?? undefined}
                        onChange={(value) =>
                          patchDraft({ timeoutSec: typeof value === 'number' ? value : null })
                        }
                      />
                    </Form.Item>
                    <Form.Item
                      label="并发 maxConcurrentRuns"
                      validateStatus={errors.maxConcurrentRuns ? 'error' : undefined}
                      help={errors.maxConcurrentRuns || CONCURRENT_ZERO_HELP}
                    >
                      <InputNumber
                        aria-label="最大并发"
                        className="member-props-number"
                        min={CONCURRENT_MIN}
                        step={1}
                        value={draft.maxConcurrentRuns ?? undefined}
                        onChange={(value) =>
                          patchDraft({
                            maxConcurrentRuns: typeof value === 'number' ? value : null,
                          })
                        }
                      />
                    </Form.Item>
                    {draft.maxConcurrentRuns === 0 && (
                      <Alert
                        className="member-props-alert"
                        type="info"
                        showIcon
                        title="不领取新 run"
                        description={CONCURRENT_ZERO_DETAIL}
                      />
                    )}
                  </Form>
                ),
              },
              {
                key: 'identity',
                label: '身份',
                children: (
                  <Form layout="vertical" className="member-props-form" requiredMark={false}>
                    <Form.Item
                      label="名称 name"
                      validateStatus={errors.name ? 'error' : undefined}
                      help={errors.name}
                    >
                      <Input
                        aria-label="成员名称"
                        value={draft.name}
                        onChange={(event) => patchDraft({ name: event.target.value })}
                      />
                    </Form.Item>
                    <Form.Item label="标题 title">
                      <Input
                        aria-label="成员标题"
                        value={draft.title}
                        onChange={(event) => patchDraft({ title: event.target.value })}
                      />
                    </Form.Item>
                    <div className="member-props-preview">
                      <span className="member-props-section-label">职责预览</span>
                      <Typography.Text>
                        {roleLabel(draft.name || agent.name, draft.title)}
                      </Typography.Text>
                    </div>
                    <div className="member-props-instructions">
                      <div className="member-props-section-label">
                        instructions
                        {instructionsMode && instructionsMode !== 'writable' && (
                          <Tag className="member-props-readonly-tag">只读</Tag>
                        )}
                      </div>
                      {instructionsMode === 'writable' ? (
                        <Form.Item
                          validateStatus={errors.instructions ? 'error' : undefined}
                          help={
                            errors.instructions ||
                            `来源：${configQuery.data.identity.instructions.source || '未知'}${
                              configQuery.data.identity.instructions.path
                                ? ` · ${configQuery.data.identity.instructions.path}`
                                : ''
                            } · ${new TextEncoder().encode(draft.instructions).length} 字节`
                          }
                        >
                          <Input.TextArea
                            aria-label="成员 instructions"
                            className="member-props-instructions-input"
                            autoSize={{ minRows: 6, maxRows: 18 }}
                            value={draft.instructions}
                            onChange={(event) => patchDraft({ instructions: event.target.value })}
                          />
                        </Form.Item>
                      ) : (
                        <>
                          <Typography.Paragraph type="secondary" className="member-props-help">
                            {instructionsMode === 'unavailable'
                              ? configQuery.data.identity.instructions.probeNote ||
                                '当前部署不支持在此修改 instructions'
                              : '当前部署不支持在此修改 instructions'}
                          </Typography.Paragraph>
                          <pre className="member-props-readonly-block">
                            {draft.instructions || '（无内容）'}
                          </pre>
                        </>
                      )}
                    </div>
                  </Form>
                ),
              },
              {
                key: 'memory',
                label: (
                  <span>
                    记忆 <Tag className="member-props-readonly-tag">只读</Tag>
                  </span>
                ),
                children: (
                  <div className="member-props-memory">
                    <MemoryBlock
                      title="会话复用"
                      source={configQuery.data.memory.sessionReuse.source}
                      asOf={configQuery.data.memory.sessionReuse.asOf}
                      fetchedAt={configQuery.data.fetchedAt}
                    >
                      <div>
                        最近运行：{sessionReuseLabel(configQuery.data.memory.sessionReuse.state)}
                      </div>
                      {configQuery.data.memory.sessionReuse.detail && (
                        <Typography.Text type="secondary">
                          {configQuery.data.memory.sessionReuse.detail}
                        </Typography.Text>
                      )}
                    </MemoryBlock>
                    <MemoryBlock
                      title="Handoff"
                      source={configQuery.data.memory.handoff.source}
                      asOf={configQuery.data.memory.handoff.asOf}
                      fetchedAt={configQuery.data.fetchedAt}
                    >
                      {configQuery.data.memory.handoff.state === 'available' &&
                      (configQuery.data.memory.handoff.files || []).length ? (
                        <ul className="member-props-handoff-list">
                          {(configQuery.data.memory.handoff.files || []).map((file) => (
                            <li key={file.path}>
                              <code>{file.path}</code>
                              <span>{file.mtime ? freshnessLabel(file.mtime) : ''}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Typography.Text type="secondary">
                          {configQuery.data.memory.handoff.state === 'unavailable'
                            ? 'handoff 不可用'
                            : '暂无 handoff 文件'}
                        </Typography.Text>
                      )}
                    </MemoryBlock>
                    <MemoryBlock
                      title="上下文体积"
                      source={configQuery.data.memory.contextSize.source}
                      asOf={configQuery.data.memory.contextSize.asOf}
                      fetchedAt={configQuery.data.fetchedAt}
                    >
                      {configQuery.data.memory.contextSize.state === 'available' ? (
                        <div>
                          最近上下文：约 {configQuery.data.memory.contextSize.approxChars ?? 0}{' '}
                          {configQuery.data.memory.contextSize.unit || 'chars'}
                        </div>
                      ) : (
                        <Typography.Text type="secondary">暂无统计</Typography.Text>
                      )}
                    </MemoryBlock>
                    <Typography.Paragraph type="secondary" className="member-props-help">
                      记忆相关数据只读展示，不能在此修改。
                    </Typography.Paragraph>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Drawer>

      <Modal
        title="保存前确认"
        open={diffOpen}
        onCancel={() => setDiffOpen(false)}
        onOk={() => void confirmSave()}
        okText={instructionsChanged ? '确认修改 instructions' : '确认保存'}
        okButtonProps={{ loading: saving, danger: instructionsChanged }}
        cancelText="取消"
        className="member-props-diff-modal"
        width={560}
        destroyOnHidden
      >
        <div className="member-props-diff">
          <div className="member-props-section-label">变更预览（仅将写入的键）</div>
          {dirty.map((key) => (
            <div className="member-props-diff-row" key={key}>
              <strong>{fieldLabel(key)}</strong>
              <pre>
                {formatDiffValue(key, snapshot?.[key])}
                {'  →  '}
                {formatDiffValue(key, draft?.[key])}
              </pre>
              {key === 'maxConcurrentRuns' && draft?.maxConcurrentRuns === 0 && (
                <Typography.Text type="secondary">{CONCURRENT_ZERO_DIFF_NOTE}</Typography.Text>
              )}
            </div>
          ))}
          {instructionsChanged && (
            <Alert
              className="member-props-alert"
              type="warning"
              showIcon
              title="修改 instructions 会影响该成员后续全部任务与对话的行为。请确认已审阅变更。"
            />
          )}
        </div>
      </Modal>
    </>
  );
}

function MemoryBlock({
  title,
  source,
  asOf,
  fetchedAt,
  children,
}: {
  title: string;
  source?: string | null;
  asOf?: string | null;
  fetchedAt?: string;
  children: ReactNode;
}) {
  return (
    <section className="member-props-memory-block">
      <div className="member-props-section-label">{title}</div>
      <Descriptions size="small" column={1} className="member-props-descriptions">
        <Descriptions.Item label="内容">{children}</Descriptions.Item>
        {(source || asOf || fetchedAt) && (
          <Descriptions.Item label="来源 / 新鲜度">
            {[source, freshnessLabel(asOf, fetchedAt)].filter(Boolean).join(' · ')}
          </Descriptions.Item>
        )}
      </Descriptions>
    </section>
  );
}
