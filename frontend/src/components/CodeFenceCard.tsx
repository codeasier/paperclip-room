import { useId, useState } from 'react';
import { App, Button, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { downloadFileName, fenceMeta } from '../lib/codeFence';

type Props = {
  infoString?: string;
  code: string;
};

export function CodeFenceCard({ infoString, code }: Props) {
  const { message } = App.useApp();
  const [copied, setCopied] = useState(false);
  const labelId = useId();
  const { label } = fenceMeta(infoString);

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(code);
      setCopied(true);
      void message.success('已复制');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      void message.error('复制失败，请手动选择文本');
    }
  }

  function download() {
    try {
      const name = downloadFileName(infoString);
      const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      void message.error('下载失败');
    }
  }

  return (
    <div className="code-card" role="group" aria-labelledby={labelId}>
      <div className="code-card-bar">
        <Typography.Text id={labelId} className="code-card-label">
          {label}
        </Typography.Text>
        <div className="code-card-actions">
          <Button
            type="text"
            size="small"
            className="code-card-btn"
            aria-label="下载代码"
            title="下载代码"
            icon={<DownloadOutlined />}
            onClick={download}
          />
          <Button
            type="text"
            size="small"
            className="code-card-btn"
            aria-label="复制代码"
            title={copied ? '已复制' : '复制代码'}
            icon={<CopyOutlined />}
            onClick={() => void copy()}
          />
        </div>
      </div>
      <pre className="code-card-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}
