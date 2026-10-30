import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

export const thanksConflictReasons = ['self', 'duplicate', 'completed'] as const;
export type ThanksConflictReason = (typeof thanksConflictReasons)[number];
export function thanksConflictReasonOf(details: unknown): ThanksConflictReason | undefined {
  return conflictReasonOf(details, thanksConflictReasons);
}

const personSchema = z.object({ id: z.string(), name: z.string() });
export const thanksSchema = z.object({
  id: z.string(),
  sender: personSchema,
  recipient: personSchema,
  created_at: z.string(),
  can_revoke: z.boolean(),
});

export const thanksSend = defineOperation({
  name: 'thanks-send',
  description: '未完了のタスクの担当（担当がいなければ作った人）が、今所属している相手へ感謝を送る',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema, recipient_user_id: idSchema }),
  output: z.object({ thanks_id: z.string() }),
});

export const thanksRevoke = defineOperation({
  name: 'thanks-revoke',
  description: '未完了のタスクの感謝を、送った本人が取り消す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, thanks_id: idSchema }),
  output: z.object({ thanks_id: z.string() }),
});
