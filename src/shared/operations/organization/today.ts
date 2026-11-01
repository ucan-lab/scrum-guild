import { z } from 'zod';
import { taskPointsSchema } from '../../task.ts';
import { sprintRefSchema } from '../sprint/sprint.ts';
import { defineOperation } from '../define.ts';

const todayTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  points: taskPointsSchema.nullable(),
  due_on: z.string().nullable(),
  today_on: z.string().nullable(),
  completed_at: z.string().nullable(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  today: z.string(),
  week_start: z.number().int().min(0).max(6),
  position: z.string(),
  carry_days: z.number().int(),
  sprint_active: z.boolean(),
  is_today_completed: z.boolean(),
  reopenable: z.boolean(),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  repository: z.object({ id: z.string(), name: z.string() }).nullable(),
  sprint: sprintRefSchema.nullable(),
});
export type TodayTask = z.output<typeof todayTaskSchema>;

export const today = defineOperation({
  name: 'today',
  description: '所属する閉じていないワークスペースの、自分が担当するバックログの今日やることを返す',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({
    tasks: z.array(todayTaskSchema),
    sprint_goals: z.array(z.object({ workspace_id: z.string(), workspace_name: z.string(), goal: z.string() })),
  }),
});
