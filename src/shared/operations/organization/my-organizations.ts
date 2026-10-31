import { z } from 'zod';
import { defineOperation } from '../define.ts';

// ログインの直後と組織の切り替えが使う。入れる組織は管理者か、いずれかのワークスペースに今所属する組織。
// 承諾待ちの招待だけの組織と、停止した組織は、組織の名前と slug だけを返す（その組織の中を読ませない。slug は承諾と辞退を呼ぶ先）
export const myOrganizations = defineOperation({
  name: 'my-organizations',
  description: '入れる組織と、届いた招待の組織と、停止した組織の名前と slug を返す',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({
    organizations: z.array(z.object({ slug: z.string(), name: z.string() })),
    invitations: z.array(z.object({ organization_name: z.string(), slug: z.string() })),
    // 停止していなければ入れた組織のうち、停止したもの（名前順）。伝えるだけで、中へは入れない。
    // 入れる組織が無く招待も無い人にも、アカウントがあれば返る
    suspended: z.array(z.object({ slug: z.string(), name: z.string() })),
    // 運用者のログインか。入れる組織が無い運用者を運用の画面へ振り分けるのに使う
    operator: z.boolean(),
  }),
});
