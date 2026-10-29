import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { taskPointsSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';

const cursorSchema = z.object({ completed_at: z.iso.datetime({ precision: 3 }), id: idSchema });
export const completedBacklogTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  points: taskPointsSchema.nullable(),
  completed_at: z.string(),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export const backlogCompletedTasks = defineOperation({
  name: 'backlog-completed-tasks',
  description: '完了したバックログのタスクを新しい順に読み、続きの印を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    story_id: idSchema.nullable(),
    before: cursorSchema.optional(),
    limit: z.number().int().min(1).max(200).default(20),
  }),
  output: z.object({ tasks: z.array(completedBacklogTaskSchema), next: cursorSchema.nullable() }),
});
export type CompletedBacklogTask = z.output<typeof completedBacklogTaskSchema>;
export type CompletedBacklogCursor = z.output<typeof cursorSchema>;
