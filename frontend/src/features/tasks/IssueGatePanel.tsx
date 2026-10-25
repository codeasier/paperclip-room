import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Input } from 'antd';
import { apiUrl, getJSON, postJSON } from '../../api/client';
import type {
  GateBlocked,
  GateConfirmation,
  GateInteraction,
  GateQuestion,
  GateResponse,
} from '../../api/types';
import { Markdown } from '../../components/Markdown';
import { dayLabel, clockLabel } from '../../lib/format';

/** 与 Paperclip 问题卡的「其他」选项保持同一保留 ID，不与真实选项冲突。 */
const OTHER_OPTION_ID = '__other__';

type GateWriteBody = {
  issueId: string;
  action: 'respond' | 'resolve' | 'reply';
  interactionId?: string;
  answers?: { questionId: string; optionIds: string[]; otherText?: string }[];
  decision?: 'accept' | 'reject';
  reason?: string;
  selectedOptionIds?: string[];
  text?: string;
  reopen?: boolean;
};

function useGateWrite(company: string) {
  const client = useQueryClient();
  const { message } = App.useApp();
  return useMutation({
    mutationFn: (body: GateWriteBody) => postJSON(apiUrl('/api/issue-gate', company), body),
    onSuccess: () => {
      // 回答/回复会改变任务状态、巡检结论和交互列表，整组按团队失效。
      void client.invalidateQueries({ predicate: (query) => query.queryKey[1] === company });
    },
    onError: (error: Error) => {
      void message.error(error.message);
    },
  });
}

function whenLabel(value?: string | null) {
  return value ? `${dayLabel(value)} ${clockLabel(value)}` : '';
}

/**
 * 巡检「等你处理 / 等你回答」的操作面板：阻塞任务给回复入口，
 * pending 交互给答题 / 确认入口。没有可处理内容时整体不渲染。
 */
export function IssueGatePanel({ company, issueRef }: { company: string; issueRef?: string }) {
  const query = useQuery({
    queryKey: ['/api/issue-gate', company, issueRef],
    queryFn: ({ signal }) =>
      getJSON<GateResponse>(apiUrl('/api/issue-gate', company, { issue: issueRef }), signal),
    enabled: Boolean(company && issueRef),
    refetchInterval: 8000,
    refetchIntervalInBackground: false,
  });
  const data = query.data;
  if (!issueRef || !data || data.state !== 'available' || !data.issue) return null;
  if (!data.blocked && !data.interactions.length) return null;
  const issueId = data.issue.id;
  return (
    <div className="gate-panel">
      {data.blocked && (
        <BlockedCard key="blocked" company={company} issueId={issueId} blocked={data.blocked} />
      )}
      {data.interactions.map((interaction) =>
        interaction.kind === 'ask_user_questions' ? (
          <QuestionsCard
            key={interaction.id}
            company={company}
            issueId={issueId}
            interaction={interaction}
          />
        ) : interaction.kind === 'request_confirmation' ||
          interaction.kind === 'request_checkbox_confirmation' ? (
          <ConfirmationCard
            key={interaction.id}
            company={company}
            issueId={issueId}
            interaction={interaction}
          />
        ) : (
          <UnsupportedCard key={interaction.id} interaction={interaction} />
        ),
      )}
    </div>
  );
}

function BlockedCard({
  company,
  issueId,
  blocked,
}: {
  company: string;
  issueId: string;
  blocked: GateBlocked;
}) {
  const [text, setText] = useState('');
  const write = useGateWrite(company);
  const { message } = App.useApp();
  const ready = Boolean(text.trim());
  function send(reopen: boolean) {
    if (!ready || write.isPending) return;
    write.mutate(
      { issueId, action: 'reply', text, reopen },
      {
        onSuccess: () => {
          void message.success(reopen ? '已回复；任务会按阻塞原因恢复并唤醒成员' : '已追加评论');
          setText('');
        },
      },
    );
  }
  return (
    <section className="gate-card gate-card-blocked">
      <div className="gate-head">
        <span className={`gate-chip ${blocked.onBoard ? 'warn' : ''}`}>
          {blocked.onBoard ? '等你处理' : '任务阻塞'}
        </span>
        <span className="gate-meta">
          等待 {blocked.waitingOn || '未登记'}
          {blocked.ageHours != null ? ` · 已阻塞 ${blocked.ageHours}h` : ''}
          {blocked.silentHours != null ? ` · 静默 ${blocked.silentHours}h` : ''}
        </span>
      </div>
      {blocked.action ? <div className="gate-action">需要你：{blocked.action}</div> : null}
      <Input.TextArea
        aria-label="任务回复"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="写下要补充的信息或你的决定；成员收到后会继续处理"
        autoSize={{ minRows: 2, maxRows: 6 }}
        maxLength={20000}
      />
      <div className="gate-actions">
        <Button
          type="primary"
          loading={write.isPending}
          disabled={!ready}
          onClick={() => send(true)}
        >
          回复并恢复任务
        </Button>
        <Button disabled={!ready || write.isPending} onClick={() => send(false)}>
          仅评论
        </Button>
      </div>
      <div className="gate-note">
        回复写入任务讨论区并唤醒成员；是否恢复为 todo 由 Paperclip 按阻塞原因判定。
      </div>
    </section>
  );
}

interface AnswerDraft {
  optionIds: string[];
  otherText: string;
  otherActive: boolean;
}

const EMPTY_DRAFT: AnswerDraft = { optionIds: [], otherText: '', otherActive: false };

function QuestionsCard({
  company,
  issueId,
  interaction,
}: {
  company: string;
  issueId: string;
  interaction: GateInteraction;
}) {
  const questions = interaction.questions || [];
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const write = useGateWrite(company);
  const { message } = App.useApp();
  function draftOf(question: GateQuestion): AnswerDraft {
    return drafts[question.id] || EMPTY_DRAFT;
  }
  function toggleOption(question: GateQuestion, optionId: string, freeText: boolean) {
    setDrafts((previous) => {
      const current = previous[question.id] || EMPTY_DRAFT;
      // 自由填写选项：切换输入框，选中的真实选项保留在 optionIds 里提交。
      if (freeText || optionId === OTHER_OPTION_ID) {
        return {
          ...previous,
          [question.id]: {
            ...current,
            otherActive: !current.otherActive,
            optionIds: question.selectionMode === 'single' ? [] : current.optionIds,
          },
        };
      }
      if (question.selectionMode === 'single') {
        return {
          ...previous,
          [question.id]: { ...current, optionIds: [optionId], otherActive: false },
        };
      }
      const optionIds = current.optionIds.includes(optionId)
        ? current.optionIds.filter((value) => value !== optionId)
        : [...current.optionIds, optionId];
      return { ...previous, [question.id]: { ...current, optionIds } };
    });
  }
  function updateOther(questionId: string, value: string) {
    setDrafts((previous) => ({
      ...previous,
      [questionId]: { ...(previous[questionId] || EMPTY_DRAFT), otherText: value },
    }));
  }
  const missingRequired = questions.filter((question) => {
    if (!question.required) return false;
    const draft = draftOf(question);
    return draft.optionIds.length === 0 && !(draft.otherActive && draft.otherText.trim());
  });
  const canSubmit = questions.length > 0 && missingRequired.length === 0;
  function submit() {
    if (!canSubmit || write.isPending) return;
    write.mutate(
      {
        issueId,
        action: 'respond',
        interactionId: interaction.id,
        answers: questions.map((question) => {
          const draft = draftOf(question);
          const otherText = draft.otherActive ? draft.otherText.trim() : '';
          return {
            questionId: question.id,
            optionIds: draft.optionIds,
            ...(otherText ? { otherText } : {}),
          };
        }),
      },
      { onSuccess: () => void message.success('回答已提交，成员会被唤醒') },
    );
  }
  return (
    <section className="gate-card">
      <div className="gate-head">
        <span className="gate-chip warn">等你回答</span>
        <span className="gate-meta">
          {interaction.title || '成员提出了问题'}
          {questions.length ? ` · ${questions.length} 个问题` : ''}
          {interaction.createdAt ? ` · ${whenLabel(interaction.createdAt)}` : ''}
        </span>
      </div>
      {interaction.summary ? <div className="gate-summary">{interaction.summary}</div> : null}
      {questions.map((question, index) => {
        const draft = draftOf(question);
        return (
          <div className="gate-question" key={question.id}>
            <div className="gate-question-prompt">
              <span className="gate-question-index">{index + 1}</span>
              {question.prompt}
              {question.required ? <em className="gate-required">必答</em> : null}
              <span className="gate-question-mode">
                {question.selectionMode === 'multi' ? '可多选' : '单选'}
              </span>
            </div>
            {question.helpText ? <div className="gate-help">{question.helpText}</div> : null}
            <div className={`gate-options ${question.selectionMode === 'multi' ? 'multi' : ''}`}>
              {question.options.map((option) => {
                const freeText = Boolean(option.freeText);
                const selected = freeText ? draft.otherActive : draft.optionIds.includes(option.id);
                return (
                  <button
                    type="button"
                    key={option.id}
                    aria-pressed={selected}
                    className={`gate-option ${selected ? 'selected' : ''}`}
                    onClick={() => toggleOption(question, option.id, freeText)}
                  >
                    <span className="gate-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="gate-option-desc">{option.description}</span>
                    ) : null}
                  </button>
                );
              })}
              {question.allowOther ? (
                <button
                  type="button"
                  aria-pressed={draft.otherActive}
                  className={`gate-option ${draft.otherActive ? 'selected' : ''}`}
                  onClick={() => toggleOption(question, OTHER_OPTION_ID, false)}
                >
                  <span className="gate-option-label">其他（自行填写）</span>
                </button>
              ) : null}
            </div>
            {draft.otherActive ? (
              <Input.TextArea
                aria-label="自由填写"
                value={draft.otherText}
                onChange={(event) => updateOther(question.id, event.target.value)}
                placeholder="请输入你的答案"
                autoSize={{ minRows: 1, maxRows: 4 }}
                maxLength={100000}
              />
            ) : null}
          </div>
        );
      })}
      <div className="gate-actions">
        <Button type="primary" loading={write.isPending} disabled={!canSubmit} onClick={submit}>
          {interaction.submitLabel ? String(interaction.submitLabel) : '提交回答'}
        </Button>
        {missingRequired.length ? (
          <span className="gate-error">还有 {missingRequired.length} 个必答问题未选择</span>
        ) : null}
      </div>
    </section>
  );
}

function ConfirmationCard({
  company,
  issueId,
  interaction,
}: {
  company: string;
  issueId: string;
  interaction: GateInteraction;
}) {
  const confirmation: GateConfirmation = interaction.confirmation || { options: [] };
  const isCheckbox = interaction.kind === 'request_checkbox_confirmation';
  const [selected, setSelected] = useState<string[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const write = useGateWrite(company);
  const { message } = App.useApp();
  function toggle(optionId: string) {
    setSelected((previous) =>
      previous.includes(optionId)
        ? previous.filter((value) => value !== optionId)
        : [...previous, optionId],
    );
  }
  function accept() {
    if (write.isPending) return;
    write.mutate(
      {
        issueId,
        action: 'resolve',
        interactionId: interaction.id,
        decision: 'accept',
        ...(isCheckbox && selected.length ? { selectedOptionIds: selected } : {}),
      },
      { onSuccess: () => void message.success('已同意') },
    );
  }
  function reject() {
    if (confirmation.rejectRequiresReason && !reason.trim()) return;
    if (write.isPending) return;
    write.mutate(
      {
        issueId,
        action: 'resolve',
        interactionId: interaction.id,
        decision: 'reject',
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      { onSuccess: () => void message.success('已拒绝') },
    );
  }
  return (
    <section className="gate-card">
      <div className="gate-head">
        <span className="gate-chip warn">等你确认</span>
        <span className="gate-meta">
          {interaction.title || '成员请求确认'}
          {interaction.createdAt ? ` · ${whenLabel(interaction.createdAt)}` : ''}
        </span>
      </div>
      {confirmation.prompt ? <div className="gate-action">{confirmation.prompt}</div> : null}
      {confirmation.detailsMarkdown ? (
        <div className="gate-details">
          <Markdown text={confirmation.detailsMarkdown} />
        </div>
      ) : null}
      {isCheckbox && confirmation.options.length ? (
        <div className="gate-options multi">
          {confirmation.options.map((option) => (
            <button
              type="button"
              key={option.id}
              aria-pressed={selected.includes(option.id)}
              className={`gate-option ${selected.includes(option.id) ? 'selected' : ''}`}
              onClick={() => toggle(option.id)}
            >
              <span className="gate-option-label">{option.label}</span>
              {option.description ? (
                <span className="gate-option-desc">{option.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {rejecting ? (
        <div className="gate-reject">
          <Input.TextArea
            aria-label="拒绝原因"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              confirmation.rejectRequiresReason ? '请说明拒绝原因（必填）' : '拒绝原因（可选）'
            }
            autoSize={{ minRows: 2, maxRows: 5 }}
            maxLength={4000}
          />
          <div className="gate-actions">
            <Button
              danger
              loading={write.isPending}
              disabled={Boolean(confirmation.rejectRequiresReason) && !reason.trim()}
              onClick={reject}
            >
              确认拒绝
            </Button>
            <Button disabled={write.isPending} onClick={() => setRejecting(false)}>
              返回
            </Button>
          </div>
        </div>
      ) : (
        <div className="gate-actions">
          <Button type="primary" loading={write.isPending} onClick={accept}>
            {confirmation.acceptLabel || '同意'}
          </Button>
          <Button danger disabled={write.isPending} onClick={() => setRejecting(true)}>
            {confirmation.rejectLabel || '拒绝'}
          </Button>
        </div>
      )}
    </section>
  );
}

function UnsupportedCard({ interaction }: { interaction: GateInteraction }) {
  return (
    <section className="gate-card">
      <div className="gate-head">
        <span className="gate-chip">等你处理</span>
        <span className="gate-meta">{interaction.title || interaction.kind}</span>
      </div>
      <div className="gate-note">
        该交互类型（{interaction.kind}）暂不支持在控制台处理，请到 Paperclip 任务页操作。
      </div>
    </section>
  );
}
