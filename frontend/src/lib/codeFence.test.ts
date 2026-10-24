import { describe, expect, it } from 'vitest';
import {
  downloadFileName,
  fenceMeta,
  isEmptyFence,
  parseInfoString,
  sanitizeDownloadName,
} from './codeFence';

describe('parseInfoString', () => {
  it('takes first token and strips language- prefix', () => {
    expect(parseInfoString('  ts meta=1 ')).toBe('ts');
    expect(parseInfoString('language-bash')).toBe('bash');
    expect(parseInfoString('')).toBe('');
    expect(parseInfoString(null)).toBe('');
  });
});

describe('fenceMeta', () => {
  it('maps text aliases and empty infostring to TEXT / txt', () => {
    for (const info of ['', 'text', 'plaintext', 'txt', 'TEXT', ' PlainText ']) {
      expect(fenceMeta(info)).toMatchObject({ label: 'TEXT', extension: 'txt' });
    }
  });

  it('maps common languages to short labels and extensions', () => {
    expect(fenceMeta('ts')).toMatchObject({ label: 'ts', extension: 'ts' });
    expect(fenceMeta('typescript')).toMatchObject({ label: 'ts', extension: 'ts' });
    expect(fenceMeta('bash')).toMatchObject({ label: 'bash', extension: 'sh' });
    expect(fenceMeta('json')).toMatchObject({ label: 'json', extension: 'json' });
    expect(fenceMeta('python')).toMatchObject({ label: 'py', extension: 'py' });
  });

  it('keeps unknown infostring as label (truncated) with .txt', () => {
    expect(fenceMeta('weirdlang')).toMatchObject({ label: 'weirdlang', extension: 'txt' });
    const long = 'x'.repeat(40);
    expect(fenceMeta(long).label.endsWith('…')).toBe(true);
    expect(fenceMeta(long).label.length).toBeLessThanOrEqual(25);
    expect(fenceMeta(long).extension).toBe('txt');
  });
});

describe('isEmptyFence', () => {
  it('treats whitespace-only as empty', () => {
    expect(isEmptyFence('')).toBe(true);
    expect(isEmptyFence('  \n\t\n  ')).toBe(true);
    expect(isEmptyFence('a')).toBe(false);
    expect(isEmptyFence(' \n x \n ')).toBe(false);
  });
});

describe('sanitizeDownloadName', () => {
  it('allows only safe characters and caps length', () => {
    expect(sanitizeDownloadName('snippet', 'ts')).toBe('snippet.ts');
    expect(sanitizeDownloadName('../evil name!!', 'txt')).toBe('evil-name.txt');
    expect(sanitizeDownloadName('', 'ts')).toBe('snippet.ts');
    expect(sanitizeDownloadName('a'.repeat(100), 'ts').length).toBeLessThanOrEqual(64);
  });

  it('falls back to snippet.txt when nothing safe remains', () => {
    expect(sanitizeDownloadName('@@@', '!!!')).toBe('snippet.txt');
  });
});

describe('downloadFileName', () => {
  it('uses snippet.txt for TEXT and language-tagged names otherwise', () => {
    expect(downloadFileName('')).toBe('snippet.txt');
    expect(downloadFileName('text')).toBe('snippet.txt');
    expect(downloadFileName('ts')).toMatch(/^snippet-ts\.ts$/);
    expect(downloadFileName('bash')).toMatch(/^snippet-bash\.sh$/);
  });
});
