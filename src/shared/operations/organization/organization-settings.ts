import { z } from 'zod';
import { themes } from '../../theme.ts';
import { defineOperation } from '../define.ts';

const vocabulary = z.enum(['game', 'scrum']);
const theme = z.enum(themes);

// 組織の言葉づかいと既定のテーマ（docs/data-model.md の「書き込みの単位」の組織の設定の変更）。管理者だけ。
// どちらか1つ以上を渡す。今と同じ値の項目は書かず、書く項目が無ければ何も書かずに今の値を返す。
// 入ってから書くまでに同じ項目を別の要求が変えていたら 409 の conflict
export const organizationSettingsUpdate = defineOperation({
  name: 'organization-settings-update',
  description:
    '組織の言葉づかいと既定のテーマを変える（どちらか1つ以上）。今と同じ値の項目は書かない。書いた後の値を返す。変更の履歴（change_logs）に残す',
  mode: 'write',
  permission: 'admin',
  input: z
    .object({ vocabulary: vocabulary.optional(), theme: theme.optional() })
    .refine((value) => value.vocabulary !== undefined || value.theme !== undefined, {
      message: '言葉づかいか既定のテーマのどちらかを渡す',
    }),
  output: z.object({ vocabulary, theme }),
});
