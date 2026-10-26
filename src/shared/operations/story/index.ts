// ストーリーの読み取り、作成、変更、移動、完了と取り消しの操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { storyComplete } from './story-complete.ts';
import { storyCreate } from './story-create.ts';
import { storyGet } from './story-get.ts';
import { storyMove } from './story-move.ts';
import { storyReopen } from './story-reopen.ts';
import { storyUpdate } from './story-update.ts';

export { storyComplete, storyCreate, storyGet, storyMove, storyReopen, storyUpdate };
export { storyDetailSchema, type StoryDetail } from './story.ts';

export const storyOperations: readonly AnyOperationDefinition[] = [
  storyCreate,
  storyGet,
  storyUpdate,
  storyMove,
  storyComplete,
  storyReopen,
];
