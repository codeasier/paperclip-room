import { Children, isValidElement, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeFenceCard } from './CodeFenceCard';
import { isEmptyFence, parseInfoString } from '../lib/codeFence';
import { isHtmlOnly } from '../lib/markdown';

export type MarkdownVariant = 'agent' | 'user';

type MarkdownProps = {
  text: string;
  /** Default `agent` keeps CodeFenceCard; `user` disables the card. */
  variant?: MarkdownVariant;
  /** Optional overrides; merge order: defaults(variant) ← components */
  components?: Partial<Components>;
};

function extractFence(children: ReactNode): { info: string; code: string } | null {
  const list = Children.toArray(children);
  const codeEl = list.find((child) => isValidElement(child));
  if (!isValidElement(codeEl)) return null;
  const props = codeEl.props as { className?: string; children?: ReactNode };
  const className = props.className || '';
  const match = /(?:^|\s)language-([^\s]+)/.exec(className);
  const info = parseInfoString(match?.[1] ?? '');
  const code = String(props.children ?? '').replace(/\n$/, '');
  return { info, code };
}

function defaultComponents(variant: MarkdownVariant): Partial<Components> {
  return {
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    ),
    pre: ({ children }) => {
      const fence = extractFence(children);
      if (!fence) return <pre>{children}</pre>;
      if (isEmptyFence(fence.code)) return null;
      if (variant === 'user') {
        const className = fence.info ? `language-${fence.info}` : undefined;
        return (
          <pre>
            <code className={className}>{fence.code}</code>
          </pre>
        );
      }
      return <CodeFenceCard infoString={fence.info} code={fence.code} />;
    },
    code: ({ className, children, ...rest }) => (
      <code className={className} {...rest}>
        {children}
      </code>
    ),
  };
}

export function Markdown({ text, variant = 'agent', components }: MarkdownProps) {
  const merged: Partial<Components> = { ...defaultComponents(variant), ...components };
  const className = variant === 'user' ? 'markdown markdown--user' : 'markdown';

  return (
    <div className={className}>
      {isHtmlOnly(text) ? (
        // skipHtml would erase the whole message and leave a zero-height bubble.
        <p>{text}</p>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={merged}>
          {text}
        </ReactMarkdown>
      )}
    </div>
  );
}
