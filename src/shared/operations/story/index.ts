// ストーリーの読み取り、作成、変更の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { storyCreate } from './story-create.ts';
import { storyGet } from './story-get.ts';
import { storyUpdate } from './story-update.ts';

export { storyCreate, storyGet, storyUpdate };
export { storyDetailSchema, type StoryDetail } from './story.ts';

export const storyOperations: readonly AnyOperationDefinition[] = [storyCreate, storyGet, storyUpdate];
