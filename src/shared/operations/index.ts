// 本番の操作の定義の一覧。組織の分離のテストと権限のテストはこの一覧を回す（test/operation-registry.test.ts）。
// 仮の操作はテストの中で定義し、ここに入れない
import { columnOperations } from './column/index.ts';
import type { AnyOperationDefinition } from './define.ts';
import { definitionOperations } from './definition/index.ts';
import { epicOperations } from './epic/index.ts';
import { experienceOperations } from './experience/index.ts';
import { operatorOperations } from './operator/index.ts';
import { organizationOperations } from './organization/index.ts';
import { sessionOperations } from './session/index.ts';
import { sprintOperations } from './sprint/index.ts';
import { storyOperations } from './story/index.ts';
import { taskOperations } from './task/index.ts';
import { workspaceOperations } from './workspace/index.ts';

export const operations: readonly AnyOperationDefinition[] = [
  ...operatorOperations,
  ...organizationOperations,
  ...epicOperations,
  ...experienceOperations,
  ...sessionOperations,
  ...sprintOperations,
  ...storyOperations,
  ...taskOperations,
  ...workspaceOperations,
  ...definitionOperations,
  ...columnOperations,
];
