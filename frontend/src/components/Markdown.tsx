import { Children, isValidElement, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeFenceCard } from './CodeFenceCard';
import { isEmptyFence, parseInfoString } from '../lib/codeFence';

type MarkdownProps = {
  text: string;
  /** Optional overrides; `pre`/`code` defaults implement #4 CodeFenceCard. */
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

const defaultComponents: Partial<Components> = {
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
    return <CodeFenceCard infoString={fence.info} code={fence.code} />;
  },
  code: ({ className, children, ...rest }) => (
    <code className={className} {...rest}>
      {children}
    </code>
  ),
};

export function Markdown({ text, components }: MarkdownProps) {
  const merged: Partial<Components> = { ...defaultComponents, ...components };

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={merged}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
