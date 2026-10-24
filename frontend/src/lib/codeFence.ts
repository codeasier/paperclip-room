/** Fence infostring → content-card label / download extension. Pure frontend; no backend payload. */

const TEXT_ALIASES = new Set(['', 'text', 'plaintext', 'txt']);

const LANG_EXT: Record<string, string> = {
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  py: 'py',
  python: 'py',
  rb: 'rb',
  ruby: 'rb',
  go: 'go',
  rs: 'rs',
  rust: 'rs',
  java: 'java',
  kt: 'kt',
  kotlin: 'kt',
  c: 'c',
  h: 'h',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  cs: 'cs',
  csharp: 'cs',
  php: 'php',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  shell: 'sh',
  json: 'json',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'md',
  markdown: 'md',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  ini: 'ini',
  conf: 'conf',
  env: 'env',
  diff: 'diff',
  patch: 'diff',
};

const LABEL_OVERRIDE: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  kotlin: 'kt',
  csharp: 'cs',
  shell: 'bash',
  zsh: 'bash',
  markdown: 'md',
  yaml: 'yml',
  plaintext: 'TEXT',
  text: 'TEXT',
  txt: 'TEXT',
};

export type FenceMeta = {
  label: string;
  extension: string;
  info: string;
};

/** Normalize raw infostring (may include meta after language). */
export function parseInfoString(raw: string | undefined | null): string {
  const first =
    String(raw ?? '')
      .trim()
      .split(/\s+/)[0] ?? '';
  return first.replace(/^language-/, '');
}

export function fenceMeta(rawInfo: string | undefined | null): FenceMeta {
  const info = parseInfoString(rawInfo);
  const key = info.toLowerCase();
  if (TEXT_ALIASES.has(key)) {
    return { label: 'TEXT', extension: 'txt', info };
  }
  const extension = LANG_EXT[key];
  if (extension) {
    const label = LABEL_OVERRIDE[key] ?? info;
    return {
      label: label.length > 24 ? `${label.slice(0, 24)}…` : label,
      extension,
      info,
    };
  }
  const truncated = info.length > 24 ? `${info.slice(0, 24)}…` : info || 'TEXT';
  return {
    label: truncated || 'TEXT',
    extension: 'txt',
    info,
  };
}

export function isEmptyFence(code: string): boolean {
  return code.replace(/\s/g, '') === '';
}

const SAFE_RE = /[^A-Za-z0-9._-]+/g;
const MAX_NAME = 64;

/** Sanitize download basename; always ends with a safe extension. Falls back to snippet.txt. */
export function sanitizeDownloadName(base: string, extension: string): string {
  const ext = (extension || 'txt').replace(SAFE_RE, '').replace(/^\.+/, '').slice(0, 16) || 'txt';
  let stem = (base || 'snippet')
    .replace(SAFE_RE, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!stem) stem = 'snippet';
  const maxStem = Math.max(8, MAX_NAME - ext.length - 1);
  stem = stem.slice(0, maxStem);
  const name = `${stem}.${ext}`;
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return 'snippet.txt';
  return name;
}

export function downloadFileName(info: string | undefined | null): string {
  const { extension, label } = fenceMeta(info);
  const stem =
    label === 'TEXT' || extension === 'txt'
      ? 'snippet'
      : `snippet-${label.toLowerCase().replace(SAFE_RE, '-')}`.replace(/-+/g, '-');
  return sanitizeDownloadName(stem, extension);
}
