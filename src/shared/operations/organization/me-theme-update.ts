import { z } from 'zod';
import { themes } from '../../theme.ts';
import { defineOperation } from '../define.ts';

const theme = z.enum(themes);

// 自分の設定の画面の「テーマ」の節（docs/data-model.md の「書き込みの単位」の自分のテーマの変更）。
// 呼んだ人の users.theme だけを書く。null は「組織の既定に従う」。選んだ瞬間に送るので、見ていた前の値は取らず、最後に書いた値が残る。
// 自分の設定なので、変更の履歴（change_logs）には残さない
export const meThemeUpdate = defineOperation({
  name: 'me-theme-update',
  description:
    '自分のテーマ（users.theme）を変える。null は組織の既定に従う。呼んだ人の行だけを書く。変更の履歴（change_logs）には残さない。書いた後の値を返す',
  mode: 'write',
  permission: 'organization',
  input: z.object({ theme: theme.nullable() }),
  output: z.object({ theme: theme.nullable() }),
});
