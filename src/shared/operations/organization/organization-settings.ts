import { z } from 'zod';
import { themes } from '../../theme.ts';
import { defineOperation } from '../define.ts';

const vocabulary = z.enum(['game', 'scrum']);
const theme = z.enum(themes);
const vocabularyChange = z.object({ from: vocabulary, to: vocabulary });
const themeChange = z.object({ from: theme, to: theme });

// 組織の言葉づかいと既定のテーマ（docs/data-model.md の「書き込みの単位」の組織の設定の変更）。管理者だけ。
// どちらか1つ以上を、画面が見ていた前の値（from）と書く値（to）の組で渡す。from が今の値と違えば（ほかの管理者が先に変えた）
// 409 の conflict。入ってから書くまでに組織が停止されたら 403 の organization_suspended。
// from と to が同じ項目は書かず、書く項目が無ければ何も書かずに今の値を返す
export const organizationSettingsUpdate = defineOperation({
  name: 'organization-settings-update',
  description:
    '組織の言葉づかいと既定のテーマを、見ていた前の値と書く値の組で変える（どちらか1つ以上）。前の値が今の値と違えば 409、書くまでに組織が停止されたら 403。書いた後の値を返す。変更の履歴（change_logs）に残す',
  mode: 'write',
  permission: 'admin',
  input: z
    .object({ vocabulary: vocabularyChange.optional(), theme: themeChange.optional() })
    .refine((value) => value.vocabulary !== undefined || value.theme !== undefined, {
      message: '言葉づかいか既定のテーマのどちらかを渡す',
    }),
  output: z.object({ vocabulary, theme }),
});
