import { useLayoutEffect, useRef, useState } from 'react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Avatar, Button, Empty, Input, Space, Spin, Typography } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { apiUrl, postJSON } from '../../api/client';
import type { Agent, ChatResponse } from '../../api/types';
import { useRoomQuery } from '../../hooks/useRoomQuery';
import { Markdown } from '../../components/Markdown';
import { dateLabel } from '../../lib/format';

interface Props {
  company: string;
  agent: Agent;
  draft: string;
  onDraft: (value: string) => void;
  active?: boolean;
}
export function ChatPanel({ company, agent, draft, onDraft, active = true }: Props) {
  const { message } = App.useApp();
  const client = useQueryClient();
  const query = useRoomQuery<ChatResponse>('/api/chat', company, agent.id, 4000, active);
  const mutationKey = ['send', company, agent.id];
  const sending = useIsMutating({ mutationKey }) > 0;
  const [awaitingAfter, setAwaitingAfter] = useState<string | null>(null);
  const stream = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composing = useRef(false);
  const compositionEnd = useRef(0);
  const enabled = query.data?.state === 'new' || query.data?.state === 'available';
  const messages = query.data?.messages || [];
  const lastMessage = messages.at(-1);
  const mutation = useMutation({
    mutationKey,
    mutationFn: (text: string) =>
      postJSON(apiUrl('/api/chat', company), { agentId: agent.id, text }),
    onSuccess: () => {
      onDraft('');
      setAwaitingAfter(lastMessage?.id || '');
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
  }, [messages]);
  const replying =
    (awaitingAfter !== null &&
      (lastMessage?.id === awaitingAfter || lastMessage?.author !== 'agent')) ||
    query.data?.chat?.conversationState === 'awaiting_agent';
  return (
    <section className="chat-panel">
      <div
        className="chat-stream"
        ref={stream}
        onScroll={() => {
          const element = stream.current;
          if (element)
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {query.isPending && (
          <div className="loading">
            <Spin />
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
          <Alert type="info" showIcon title="Agent Chat 尚未启用" description={query.data.note} />
        )}
        {query.data?.state === 'unavailable' && (
          <Alert type="warning" title={query.data.note || '对话暂不可用'} />
        )}
        {enabled && !messages.length && (
          <div className="chat-welcome">
            <Avatar size={64} style={{ background: '#edf0ff', color: '#5264dc' }}>
              {agent.name.slice(0, 2)}
            </Avatar>
            <Typography.Title level={3}>与 {agent.name} 开始对话</Typography.Title>
            <Typography.Paragraph type="secondary">
              直接沟通想法、询问进展；需要正式派活时，使用「新建任务」。
            </Typography.Paragraph>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" />
          </div>
        )}
        {messages.map((item) => (
          <article key={item.id} className={`chat-message ${item.author}`}>
            <Avatar size={32}>{item.author === 'user' ? '我' : item.authorName.slice(0, 2)}</Avatar>
            <div className="message-body">
              <div className="message-meta">
                <strong>{item.authorName}</strong>
                <time>{dateLabel(item.ts)}</time>
              </div>
              <div className="message-bubble">
                <Markdown text={item.text} />
                {item.truncated && <Typography.Text type="warning">内容已截断</Typography.Text>}
              </div>
            </div>
          </article>
        ))}
        {replying && <Typography.Text type="secondary">{agent.name} 正在回复…</Typography.Text>}
      </div>
      <div className="composer">
        <Input.TextArea
          aria-label="消息"
          placeholder={enabled ? `发送给 ${agent.name}…` : '对话暂不可用'}
          autoSize={{ minRows: 3, maxRows: 8 }}
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
          <Typography.Text type="secondary">Enter 发送 · Shift+Enter 换行</Typography.Text>
          <Space>
            <Button
              aria-label="发送"
              type="primary"
              icon={<SendOutlined />}
              loading={sending}
              disabled={!enabled || !draft.trim()}
              onClick={() => void send()}
            >
              发送
            </Button>
          </Space>
        </div>
      </div>
    </section>
  );
}
