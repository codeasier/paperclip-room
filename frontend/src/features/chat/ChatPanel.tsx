import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Input, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { apiUrl, postJSON } from '../../api/client';
import type { Agent, ChatResponse } from '../../api/types';
import { useRoomQuery } from '../../hooks/useRoomQuery';
import { Markdown } from '../../components/Markdown';
import { MemberAvatar } from '../../components/MemberAvatar';
import { clockLabel, dayLabel } from '../../lib/format';
import { chatRun, replyLabel, replyState } from '../../lib/chatReply';
import { ChatActivity } from './ChatActivity';

interface Props {
  company: string;
  agent: Agent;
  draft: string;
  onDraft: (value: string) => void;
  active?: boolean;
  modelControl: ReactNode;
}
export function ChatPanel({ company, agent, draft, onDraft, active = true, modelControl }: Props) {
  const { message } = App.useApp();
  const client = useQueryClient();
  const query = useRoomQuery<ChatResponse>('/api/chat', company, agent.id, 4000, active);
  const mutationKey = ['send', company, agent.id];
  const sending = useIsMutating({ mutationKey }) > 0;
  const [showLatest, setShowLatest] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const stream = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composing = useRef(false);
  const compositionEnd = useRef(0);
  const enabled = query.data?.state === 'new' || query.data?.state === 'available';
  const messages = query.data?.messages || [];
  const run = chatRun(agent, query.data?.chat?.id);
  const reply = replyState({ messages, run, now });
  const pending = reply !== null;
  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mutation = useMutation({
    mutationKey,
    mutationFn: (text: string) =>
      postJSON(apiUrl('/api/chat', company), { agentId: agent.id, text }),
    onSuccess: (_data, text) => {
      // Do not wipe text typed while this send was in flight.
      if (draftRef.current.trim() === text) onDraft('');
      stickToBottom.current = true;
      void client.invalidateQueries({ queryKey: ['/api/chat', company, agent.id] });
      void client.invalidateQueries({ queryKey: ['/api/state', company] });
    },
    onError: (error: Error) => {
      void message.error(error.message);
      void query.refetch();
    },
  });
  const lock = useRef(false);
  async function send() {
    if (!enabled || sending || lock.current || !draft.trim()) return;
    lock.current = true;
    try {
      await mutation.mutateAsync(draft.trim());
    } catch {
      /* surfaced by onError */
    } finally {
      lock.current = false;
    }
  }
  useLayoutEffect(() => {
    if (stickToBottom.current && stream.current)
      stream.current.scrollTop = stream.current.scrollHeight;
  }, [messages, pending]);
  return (
    <section className="chat-panel">
      <div className="chat-stream-wrap">
        <div
          className="chat-stream"
          ref={stream}
          onScroll={() => {
            const element = stream.current;
            if (element) {
              stickToBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 80;
              setShowLatest(!stickToBottom.current);
            }
          }}
        >
          <div className="chat-inner">
            {query.isPending && (
              <div className="chat-welcome">
                <span className="welcome-mark">···</span>
                <Typography.Title level={3}>正在加载对话</Typography.Title>
                <Typography.Paragraph type="secondary">获取与成员的直接消息…</Typography.Paragraph>
              </div>
            )}
            {query.isError && (
              <Alert
                type="error"
                title="对话读取失败"
                description={<Button onClick={() => void query.refetch()}>重试</Button>}
              />
            )}
            {query.data?.state === 'disabled' && (
              <Alert
                type="info"
                showIcon
                title="Agent Chat 尚未启用"
                description={query.data.note}
              />
            )}
            {query.data?.state === 'unavailable' && (
              <Alert type="warning" title={query.data.note || '对话暂不可用'} />
            )}
            {enabled && !messages.length && (
              <div className="chat-welcome">
                <span className="welcome-mark">↗</span>
                <Typography.Title level={3}>与 {agent.name} 开始对话</Typography.Title>
                <Typography.Paragraph type="secondary">
                  直接沟通想法、询问进展；需要正式派活时，使用「新建任务」。
                </Typography.Paragraph>
              </div>
            )}
            {messages.map((item, index) => (
              <Fragment key={item.id}>
                {item.ts && item.ts.slice(0, 10) !== messages[index - 1]?.ts?.slice(0, 10) && (
                  <div className="day-separator">
                    <span>{dayLabel(item.ts)}</span>
                  </div>
                )}
                <article className={`chat-message ${item.author}`}>
                  {item.author !== 'user' && <MemberAvatar name={item.authorName} size={30} />}
                  <div className="message-body">
                    <div className="message-meta">
                      <strong>{item.authorName}</strong>
                      <time>{clockLabel(item.ts)}</time>
                    </div>
                    <div className="message-bubble">
                      {item.author === 'user' ? (
                        <Markdown text={item.text} variant="user" />
                      ) : (
                        <Markdown text={item.text} />
                      )}
                      {item.truncated && (
                        <Typography.Text type="warning">内容已截断</Typography.Text>
                      )}
                    </div>
                  </div>
                </article>
              </Fragment>
            ))}
            {reply && (
              <div className={`chat-reply ${reply.phase}`} role="status" aria-live="polite">
                <span className="chat-reply-dot" aria-hidden="true" />
                <span>{replyLabel(reply, agent.name)}</span>
              </div>
            )}
            {run?.status === 'running' && (
              <ChatActivity company={company} agentId={agent.id} runId={run.id} />
            )}
          </div>
        </div>
        {showLatest && (
          <Button
            className="latest-messages"
            type="default"
            shape="circle"
            aria-label="回到最新消息"
            title="回到最新消息"
            icon={<ArrowDownOutlined />}
            onClick={() => {
              if (stream.current) stream.current.scrollTop = stream.current.scrollHeight;
              stickToBottom.current = true;
              setShowLatest(false);
            }}
          />
        )}
      </div>
      <div className="composer">
        <div className="composer-inner">
          <div className="composer-label">
            <span>与 {agent.name} 对话</span>
            <span>{sending ? '正在发送…' : draft ? '草稿 · 切换成员会保留' : ''}</span>
          </div>
          <div className="composer-box">
            <Input.TextArea
              aria-label="消息"
              placeholder={enabled ? `给 ${agent.name} 发消息，直接开始对话…` : '对话暂不可用'}
              autoSize={{ minRows: 1, maxRows: 5 }}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              disabled={!enabled || sending}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
                compositionEnd.current = performance.now();
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !composing.current &&
                  performance.now() - compositionEnd.current > 80
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-footer">
              {/* #6 收窄：底栏左空；无 /、附件、语音、自动模式、第二选人 */}
              <div className="composer-tools" data-testid="composer-tools" />
              <span className="composer-spacer" />
              <div className="composer-footer-right">
                {modelControl}
                <span className="composer-counter" aria-label="字数">
                  {draft.length}
                </span>
                <Button
                  aria-label="发送"
                  type="primary"
                  loading={sending}
                  disabled={!enabled || !draft.trim()}
                  onClick={() => void send()}
                >
                  <span className="send-label">发送</span>
                  <ArrowUpOutlined />
                </Button>
              </div>
            </div>
          </div>
          <div className="composer-hint">
            <span>直接对话会唤醒成员；任务时间线在「任务」标签查看。</span>
            <span>Enter 发送 · Shift+Enter 换行</span>
          </div>
        </div>
      </div>
    </section>
  );
}
