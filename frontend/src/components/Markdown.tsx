import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MarkdownProps = {
  text: string;
  /** Reserved for #4 CodeFenceCard; when provided, overrides default block/inline code rendering. */
  components?: Partial<Components>;
};

export function Markdown({ text, components }: MarkdownProps) {
  const merged: Partial<Components> = {
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
    ...components,
  };

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={merged}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
