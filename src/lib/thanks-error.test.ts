import { expect, test } from 'vitest';
import { thanksErrorKey } from './thanks-error.ts';

test('感謝の失敗を理由ごとの辞書の文にする', () => {
  expect(thanksErrorKey(409, 'conflict', { reason: 'self' })).toBe('thanksSelf');
  expect(thanksErrorKey(409, 'conflict', { reason: 'duplicate' })).toBe('thanksDuplicate');
  expect(thanksErrorKey(409, 'conflict', { reason: 'completed' })).toBe('thanksCompleted');
  expect(thanksErrorKey(409, 'workspace_closed')).toBe('workspaceClosedReadOnly');
  expect(thanksErrorKey(403, 'forbidden')).toBe('thanksForbidden');
  expect(thanksErrorKey(404, 'not_found')).toBe('thanksNotFound');
  expect(thanksErrorKey(409, 'conflict', { reason: 'unknown' })).toBe('thanksFailed');
  expect(thanksErrorKey(0)).toBe('thanksFailed');
  expect(thanksErrorKey(500, 'internal')).toBe('thanksFailed');
});
