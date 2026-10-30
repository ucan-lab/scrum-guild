import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { sprintEndOnSchema } from '../../sprint.ts';
import { defineOperation } from '../define.ts';
import { sprintRefSchema, sprintSummarySchema } from './sprint.ts';

// end_on は画面が読んだ今の最終日。進行中の最終日がそれと違えば（別の人が延ばした）、足さずに 409 の changed で断る
export const sprintExtend = defineOperation({
  name: 'sprint-extend',
  description: '進行中のスプリントを日単位で延長し、重なる後ろのスプリントを重なる分だけ押し出す',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    sprint_id: idSchema,
    days: z.number().int().min(1).max(27),
    end_on: sprintEndOnSchema,
  }),
  output: z.object({ sprint: sprintSummarySchema, shifted: z.array(sprintRefSchema) }),
});
