import { z } from 'zod';
import { defineOperation } from '../define.ts';

// 「最初にやること」の手順の名前。ロールごとに並びが決まっている（画面の文言は言葉の辞書にある）。
// 先頭の「…になる」「…に入る」は、そのロールで画面を開いた時点で済んでいる手順で、いつも済みで返す
export const firstStepKeys = [
  'joined_workspace',
  'prepare_task',
  'mark_today',
  'became_leader',
  'invite_members',
  'first_backlog_task',
  'start_sprint',
  'became_admin',
  'create_workspace',
  'invite_by_admin',
  'register_holiday',
] as const;
export type FirstStepKey = (typeof firstStepKeys)[number];

export const firstStepRoles = ['member', 'leader', 'admin'] as const;
export type FirstStepRole = (typeof firstStepRoles)[number];

const firstStepSchema = z.object({
  key: z.enum(firstStepKeys),
  done: z.boolean(),
  // 任意の手順。済んでいなくても、最初にやることが消える判定に使わない
  optional: z.boolean(),
  // 手順が指すワークスペース（次にやる画面の行き先）。組織の手順（管理者）は null
  workspace: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type FirstStep = z.output<typeof firstStepSchema>;

// 今日やること（today）とは別に、画面が2回呼ぶ。済んだかは今のデータから決めるので、閉じた印は持たない。
// 必須の手順がすべて済んだ人と、出す手順が無い人（ワークスペースがある管理者で所属が無い人など）には、role を null、steps を空で返す
export const firstSteps = defineOperation({
  name: 'first-steps',
  description: '初めて使う人の「最初にやること」を、ロールに合う手順とそれぞれの済みで返す。必須が済んでいれば空を返す',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({
    role: z.enum(firstStepRoles).nullable(),
    steps: z.array(firstStepSchema),
  }),
});
