import { describe, expect, it } from 'vitest';
import {
  CONCURRENT_MAX,
  CONCURRENT_MIN,
  TIMEOUT_MIN_SEC,
  buildWriteBody,
  dirtyKeys,
  formatDiffValue,
  snapshotFromConfig,
  utf8ByteLength,
  validateDirty,
  validateField,
  type DraftFields,
} from './memberConfig';
import type { MemberConfig } from '../api/types';

const baseDraft = (): DraftFields => ({
  model: 'glm-5.3',
  timeoutSec: 3600,
  maxConcurrentRuns: 2,
  name: 'Frontend',
  title: '前端',
  instructions: 'hello',
});

const sampleConfig = (): MemberConfig => ({
  agentId: 'a1',
  companyId: 'c1',
  fetchedAt: '2026-10-24T14:00:00+08:00',
  runtime: {
    model: 'glm-5.3',
    timeoutSec: 3600,
    maxConcurrentRuns: 2,
    maxConcurrentRunsPlatformDefault: 20,
    maxConcurrentRunsCapped: false,
    warning: null,
  },
  identity: {
    name: 'Frontend',
    title: '前端',
    instructions: {
      mode: 'writable',
      source: 'bundle',
      path: 'AGENTS.md',
      content: 'hello',
      probeNote: null,
    },
  },
  memory: {
    sessionReuse: { state: 'unknown' },
    handoff: { state: 'empty', files: [] },
    contextSize: { state: 'empty' },
  },
});

describe('memberConfig validation', () => {
  it('rejects timeoutSec 1199 and accepts 1200', () => {
    const draft = baseDraft();
    draft.timeoutSec = 1199;
    expect(validateField('timeoutSec', draft, { instructionsWritable: true })).toMatch(/1200/);
    draft.timeoutSec = TIMEOUT_MIN_SEC;
    expect(validateField('timeoutSec', draft, { instructionsWritable: true })).toBeUndefined();
  });

  it('rejects concurrent -1 and 9; accepts 0 and 8', () => {
    const draft = baseDraft();
    draft.maxConcurrentRuns = -1;
    expect(validateField('maxConcurrentRuns', draft, { instructionsWritable: true })).toMatch(
      /0–8/,
    );
    draft.maxConcurrentRuns = 9;
    expect(validateField('maxConcurrentRuns', draft, { instructionsWritable: true })).toMatch(
      /0–8/,
    );
    draft.maxConcurrentRuns = CONCURRENT_MIN;
    expect(
      validateField('maxConcurrentRuns', draft, { instructionsWritable: true }),
    ).toBeUndefined();
    draft.maxConcurrentRuns = CONCURRENT_MAX;
    expect(
      validateField('maxConcurrentRuns', draft, { instructionsWritable: true }),
    ).toBeUndefined();
  });

  it('rejects empty model', () => {
    const draft = baseDraft();
    draft.model = '  ';
    expect(validateField('model', draft, { instructionsWritable: true })).toMatch(/模型/);
  });

  it('rejects empty name', () => {
    const draft = baseDraft();
    draft.name = '';
    expect(validateField('name', draft, { instructionsWritable: true })).toMatch(/名称/);
  });

  it('rejects oversized instructions', () => {
    const draft = baseDraft();
    draft.instructions = 'x'.repeat(256 * 1024 + 1);
    expect(utf8ByteLength(draft.instructions)).toBeGreaterThan(256 * 1024);
    expect(validateField('instructions', draft, { instructionsWritable: true })).toMatch(/256KiB/);
  });
});

describe('memberConfig dirty / write body', () => {
  it('snapshots from config', () => {
    expect(snapshotFromConfig(sampleConfig()).model).toBe('glm-5.3');
  });

  it('does not mark >8 concurrent as dirty until changed into 0–8', () => {
    const snapshot = baseDraft();
    snapshot.maxConcurrentRuns = 20;
    const draft = { ...snapshot };
    expect(dirtyKeys(draft, snapshot, { instructionsWritable: true })).toEqual([]);
    draft.maxConcurrentRuns = 3;
    expect(dirtyKeys(draft, snapshot, { instructionsWritable: true })).toEqual([
      'maxConcurrentRuns',
    ]);
  });

  it('skips instructions when not writable', () => {
    const snapshot = baseDraft();
    const draft = { ...snapshot, instructions: 'changed' };
    expect(dirtyKeys(draft, snapshot, { instructionsWritable: false })).toEqual([]);
    expect(dirtyKeys(draft, snapshot, { instructionsWritable: true })).toEqual(['instructions']);
  });

  it('builds body with only dirty keys', () => {
    const draft = baseDraft();
    draft.model = 'gpt-x';
    draft.maxConcurrentRuns = 0;
    const body = buildWriteBody('a1', draft, ['model', 'maxConcurrentRuns']);
    expect(body).toEqual({ agentId: 'a1', model: 'gpt-x', maxConcurrentRuns: 0 });
  });

  it('validateDirty aggregates field errors', () => {
    const draft = baseDraft();
    draft.timeoutSec = 100;
    draft.maxConcurrentRuns = 9;
    const errors = validateDirty(draft, ['timeoutSec', 'maxConcurrentRuns'], {
      instructionsWritable: true,
    });
    expect(errors.timeoutSec).toBeTruthy();
    expect(errors.maxConcurrentRuns).toBeTruthy();
  });

  it('truncates long instructions in diff preview', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `L${i}`);
    const preview = formatDiffValue('instructions', lines.join('\n'));
    expect(preview).toContain('省略');
    expect(preview).toContain('共 50 行');
    expect(preview.startsWith('L0')).toBe(true);
    expect(preview.endsWith('L49')).toBe(true);
  });
});
