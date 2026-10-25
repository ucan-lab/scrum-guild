// ストーリーの作成と変更の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { storyCreate } from './story-create.ts';
import { storyUpdate } from './story-update.ts';

export { storyCreate, storyUpdate };
export { storyDetailSchema, type StoryDetail } from './story.ts';

export const storyOperations: readonly AnyOperationDefinition[] = [storyCreate, storyUpdate];
