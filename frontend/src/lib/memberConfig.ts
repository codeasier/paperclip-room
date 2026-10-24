import type { MemberConfig, MemberConfigWritableKey, MemberConfigWriteBody } from '../api/types';

export const INSTRUCTIONS_MAX_BYTES = 256 * 1024;
export const TIMEOUT_MIN_SEC = 1200;
export const CONCURRENT_MIN = 0;
export const CONCURRENT_MAX = 8;
export const DIFF_HEAD_TAIL_LINES = 20;

export const CONCURRENT_ZERO_HELP = '0 = 不领取新 run（不是暂停成员）。建议 2–3；控制台硬顶 8。';

export const CONCURRENT_ZERO_DIFF_NOTE = '0 表示不领取新 run，不是暂停成员生命周期。';

export const CONCURRENT_ZERO_DETAIL =
  '不领取新 run：调度并发帽为 0，成员不会再领新任务 run。这与「暂停成员（pause）」不同；暂停请用 Paperclip 生命周期能力（本期控制台不做）。';

export type DraftFields = {
  model: string;
  timeoutSec: number | null;
  maxConcurrentRuns: number | null;
  name: string;
  title: string;
  instructions: string;
};

export type FieldErrors = Partial<Record<MemberConfigWritableKey, string>>;

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function snapshotFromConfig(config: MemberConfig): DraftFields {
  const runtime = config.runtime;
  const identity = config.identity;
  return {
    model: runtime.model ?? '',
    timeoutSec: runtime.timeoutSec ?? null,
    maxConcurrentRuns: runtime.maxConcurrentRuns ?? null,
    name: identity.name ?? '',
    title: identity.title ?? '',
    instructions: identity.instructions.content ?? '',
  };
}

export function validateField(
  key: MemberConfigWritableKey,
  draft: DraftFields,
  options: { instructionsWritable: boolean },
): string | undefined {
  switch (key) {
    case 'model': {
      if (!draft.model.trim()) return '请选择或填写模型';
      if (draft.model.trim().length > 128) return '模型名称过长';
      return undefined;
    }
    case 'timeoutSec': {
      if (draft.timeoutSec == null || !Number.isInteger(draft.timeoutSec))
        return '超时须 ≥ 1200 秒（与巡检一致）';
      if (draft.timeoutSec < TIMEOUT_MIN_SEC) return '超时须 ≥ 1200 秒（与巡检一致）';
      return undefined;
    }
    case 'maxConcurrentRuns': {
      if (
        draft.maxConcurrentRuns == null ||
        !Number.isInteger(draft.maxConcurrentRuns) ||
        draft.maxConcurrentRuns < CONCURRENT_MIN ||
        draft.maxConcurrentRuns > CONCURRENT_MAX
      ) {
        return '并发须为 0–8 的整数';
      }
      return undefined;
    }
    case 'name': {
      if (!draft.name.trim()) return '名称不能为空';
      if (draft.name.trim().length > 64) return '名称过长';
      return undefined;
    }
    case 'title': {
      if ((draft.title || '').length > 128) return 'title 过长';
      return undefined;
    }
    case 'instructions': {
      if (!options.instructionsWritable) return '当前不可写';
      if (utf8ByteLength(draft.instructions) > INSTRUCTIONS_MAX_BYTES)
        return 'instructions 过长（上限 256KiB）';
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Keys that differ from snapshot and are eligible to send (respect >8 concurrent rule). */
export function dirtyKeys(
  draft: DraftFields,
  snapshot: DraftFields,
  options: { instructionsWritable: boolean },
): MemberConfigWritableKey[] {
  const keys: MemberConfigWritableKey[] = [];
  const push = (key: MemberConfigWritableKey, changed: boolean) => {
    if (changed) keys.push(key);
  };
  push('model', draft.model.trim() !== snapshot.model.trim());
  push('timeoutSec', draft.timeoutSec !== snapshot.timeoutSec && draft.timeoutSec != null);
  // Only treat concurrent as dirty when the draft value is within 0–8 (or was already valid).
  const concurrentChanged = draft.maxConcurrentRuns !== snapshot.maxConcurrentRuns;
  if (concurrentChanged) {
    const value = draft.maxConcurrentRuns;
    if (
      value != null &&
      Number.isInteger(value) &&
      value >= CONCURRENT_MIN &&
      value <= CONCURRENT_MAX
    ) {
      keys.push('maxConcurrentRuns');
    } else if (
      snapshot.maxConcurrentRuns != null &&
      snapshot.maxConcurrentRuns >= CONCURRENT_MIN &&
      snapshot.maxConcurrentRuns <= CONCURRENT_MAX
    ) {
      // user cleared or set invalid — still mark dirty so validation can block save
      keys.push('maxConcurrentRuns');
    }
  }
  push('name', draft.name.trim() !== snapshot.name.trim());
  push('title', (draft.title || '') !== (snapshot.title || ''));
  if (options.instructionsWritable) {
    push('instructions', draft.instructions !== snapshot.instructions);
  }
  return keys;
}

export function validateDirty(
  draft: DraftFields,
  dirty: MemberConfigWritableKey[],
  options: { instructionsWritable: boolean },
): FieldErrors {
  const errors: FieldErrors = {};
  for (const key of dirty) {
    const message = validateField(key, draft, options);
    if (message) errors[key] = message;
  }
  return errors;
}

export function buildWriteBody(
  agentId: string,
  draft: DraftFields,
  dirty: MemberConfigWritableKey[],
): MemberConfigWriteBody {
  const body: MemberConfigWriteBody = { agentId };
  for (const key of dirty) {
    switch (key) {
      case 'model':
        body.model = draft.model.trim();
        break;
      case 'timeoutSec':
        if (draft.timeoutSec != null) body.timeoutSec = draft.timeoutSec;
        break;
      case 'maxConcurrentRuns':
        if (draft.maxConcurrentRuns != null) body.maxConcurrentRuns = draft.maxConcurrentRuns;
        break;
      case 'name':
        body.name = draft.name.trim();
        break;
      case 'title':
        body.title = draft.title;
        break;
      case 'instructions':
        body.instructions = draft.instructions;
        break;
    }
  }
  return body;
}

export function formatDiffValue(key: MemberConfigWritableKey, value: unknown): string {
  if (value == null || value === '') return '（空）';
  if (key !== 'instructions') return String(value);
  const text = String(value);
  const lines = text.split('\n');
  if (lines.length <= DIFF_HEAD_TAIL_LINES * 2 + 1) return text;
  const head = lines.slice(0, DIFF_HEAD_TAIL_LINES).join('\n');
  const tail = lines.slice(-DIFF_HEAD_TAIL_LINES).join('\n');
  const omitted = lines.length - DIFF_HEAD_TAIL_LINES * 2;
  return `${head}\n…（省略 ${omitted} 行，共 ${lines.length} 行）…\n${tail}`;
}

export function fieldLabel(key: MemberConfigWritableKey): string {
  switch (key) {
    case 'model':
      return 'model';
    case 'timeoutSec':
      return 'timeoutSec';
    case 'maxConcurrentRuns':
      return 'maxConcurrentRuns';
    case 'name':
      return 'name';
    case 'title':
      return 'title';
    case 'instructions':
      return 'instructions';
  }
}
