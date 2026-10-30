import { thanksConflictReasonOf } from '../shared/operations/task/index.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

export function thanksErrorKey(status: number, code?: string, details?: unknown): DictionaryKey {
  if (code === 'workspace_closed') return 'workspaceClosedReadOnly';
  if (status === 403) return 'thanksForbidden';
  if (status === 404) return 'thanksNotFound';
  if (status === 409 && code === 'conflict') {
    switch (thanksConflictReasonOf(details)) {
      case 'self':
        return 'thanksSelf';
      case 'duplicate':
        return 'thanksDuplicate';
      case 'completed':
        return 'thanksCompleted';
    }
  }
  return 'thanksFailed';
}
