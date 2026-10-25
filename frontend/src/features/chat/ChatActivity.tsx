import { BulbOutlined, CaretRightOutlined, CodeOutlined } from '@ant-design/icons';
import { Markdown } from '../../components/Markdown';
import type { ChatTimelineItem } from '../../lib/chatActivity';
import { oneLine } from '../../lib/chatActivity';

/** One disclosure per event, inline with assistant messages. Native details retain independent open state. */
export function ChatActivity({
  item,
}: {
  item: Extract<ChatTimelineItem, { kind: 'thinking' | 'tool' }>;
}) {
  if (item.kind === 'thinking') {
    return (
      <details className="chat-event thinking" data-event-id={item.id}>
        <summary aria-label="思考过程">
          <BulbOutlined />
          <span className="chat-event-label">思考</span>
          <span className="chat-event-preview">{oneLine(item.step.text, 120)}</span>
          <CaretRightOutlined className="chat-event-caret" />
        </summary>
        <div className="chat-event-detail thinking-detail">
          <Markdown text={item.step.text} />
          {item.step.truncated && <span className="chat-event-note">思考内容过长，已截断</span>}
        </div>
      </details>
    );
  }
  const name = item.call?.name || item.result?.name || '工具';
  const failed = item.result?.isError;
  const state = item.result
    ? failed
      ? '执行失败'
      : '已返回'
    : item.running
      ? '执行中'
      : '未返回结果';
  return (
    <details className={`chat-event tool${failed ? ' failed' : ''}`} data-event-id={item.id}>
      <summary aria-label={`工具调用 ${name}`}>
        <CodeOutlined />
        <span className="chat-event-label">{name}</span>
        <span className="chat-event-preview command-preview">
          {item.call ? oneLine(item.call.text, 120) : '工具输出'}
        </span>
        <span className="chat-event-state">{state}</span>
        <CaretRightOutlined className="chat-event-caret" />
      </summary>
      <div className="chat-event-detail tool-detail">
        {item.call && (
          <div className="chat-event-section">
            <span className="chat-event-section-label">调用参数</span>
            <pre>{item.call.text || '（空参数）'}</pre>
            {item.call.truncated && <span className="chat-event-note">调用内容过长，已截断</span>}
          </div>
        )}
        <div className={`chat-event-section${failed ? ' error' : ''}`}>
          <span className="chat-event-section-label">{failed ? '错误输出' : '返回结果'}</span>
          {item.result ? (
            <pre>{item.result.text.trim() ? item.result.text : '（无输出）'}</pre>
          ) : (
            <p className="chat-event-note">
              {item.running ? '等待工具返回…' : '这次运行没有记录工具返回。'}
            </p>
          )}
          {item.result?.truncated && <span className="chat-event-note">输出过长，已截断</span>}
        </div>
      </div>
    </details>
  );
}
