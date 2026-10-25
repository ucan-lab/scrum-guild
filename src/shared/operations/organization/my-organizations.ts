import { z } from 'zod';
import { defineOperation } from '../define.ts';

// ログインの直後と組織の切り替えが使う。入れる組織は管理者か、いずれかのワークスペースに今所属する組織。
// 承諾待ちの招待だけの組織は、組織の名前だけを返す（その組織の中を読ませない）
export const myOrganizations = defineOperation({
  name: 'my-organizations',
  description: '入れる組織と、届いた招待の組織の名前を返す',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({
    organizations: z.array(z.object({ slug: z.string(), name: z.string() })),
    invitations: z.array(z.object({ organization_name: z.string() })),
    // 運用者のログインか。入れる組織が無い運用者を運用の画面へ振り分けるのに使う
    operator: z.boolean(),
  }),
});
