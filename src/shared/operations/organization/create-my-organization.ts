import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';
import { hasHiddenCharacter, ORGANIZATION_NAME_MAX_LENGTH } from '../operator/create-organization.ts';

// 409 の conflict で断った理由。slug_taken は同じ slug の組織がある、trial_limit はお試し中の組織を既に持っている
export const createMyOrganizationConflictReasons = ['slug_taken', 'trial_limit'] as const;
export type CreateMyOrganizationConflictReason = (typeof createMyOrganizationConflictReasons)[number];

// 409 の応答の details から理由を取り出す。形が違えば undefined
export function createMyOrganizationConflictReasonOf(details: unknown): CreateMyOrganizationConflictReason | undefined {
  return conflictReasonOf(details, createMyOrganizationConflictReasons);
}

// ログインしている人が自分の組織を作り、その管理者になる。30日のお試しで、お試し中の組織は1アカウントにつき1つまで。
// slug の形と予約名は 400 の invalid_input（details の path が slug、code が slug_format か slug_reserved）
export const createMyOrganization = defineOperation({
  name: 'create-my-organization',
  description: '自分の組織を作り、その管理者になる。30日のお試しで始まる。slug は後から変えられない',
  mode: 'write',
  permission: 'login',
  rateLimit: { max: 30, windowSeconds: 600 },
  // お試しの枠は一度使うとアカウントでは戻せないので、本人が画面で操作したときだけ使う（API トークンでは呼べない）
  cookieOnly: true,
  input: z.object({
    slug: z.string().max(SLUG_MAX_LENGTH * 2),
    name: z
      .string()
      .trim()
      .min(1)
      .max(ORGANIZATION_NAME_MAX_LENGTH)
      .refine((value) => !hasHiddenCharacter(value), {
        message: '制御文字、区切り、向きを変える文字、見えない空白や演算子は使えない',
      }),
  }),
  output: z.object({ slug: z.string(), name: z.string() }),
});
