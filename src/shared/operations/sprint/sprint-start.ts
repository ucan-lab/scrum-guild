import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { sprintGoalSchema } from '../../sprint.ts';
import { defineOperation } from '../define.ts';
import { sprintSummarySchema } from './sprint.ts';

// 先のスプリント（planned）を始めて、進行中（active）にする。ゴール（任意。空は null）を書き、started_at と started_by を残す。
// 進行中は同時に1つで、既にあれば 409 の conflict（details.reason は active_exists）。始まっているか終了したスプリントは
// 409 の conflict（started）、スプリントが無いか別の組織なら 404。進行中が無いことは書く文の条件で見るので、
// 2つの画面から同時に始めても片方だけが通る（もう片方は active_exists。一意の索引 sprints_active も守る）。
// 最終日がワークスペースのタイムゾーンでの今日より前のスプリントは、409 の conflict（ended）で始められない（書く文の条件にも入れる）。
// 開始日は見ない（開始日より前に始めてよい）。変更の履歴（entity_type = 'sprint'、update。{"status": [前, 後], "goal": [前, 後]}）も
// 同時に書く
export const sprintStart = defineOperation({
  name: 'sprint-start',
  description: '先のスプリントを始めて進行中にする。ゴールは任意。進行中のスプリントが既にあれば断る',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    sprint_id: idSchema,
    goal: sprintGoalSchema.default(null),
  }),
  output: z.object({ sprint: sprintSummarySchema }),
});
