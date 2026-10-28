import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';

// 添付ファイルの上限の単位。1 GB = 1024³ バイト（organizations.attachment_quota_bytes の既定 32212254720 が 30 GB）
export const QUOTA_GIB = 1024 ** 3;
// 人数の上限と添付ファイルの上限に入れられる値の範囲。どちらも 1 以上の整数
export const MEMBER_LIMIT_MAX = 10_000;
export const ATTACHMENT_QUOTA_MAX_BYTES = 100 * 1024 ** 4; // 100 TB

// 値段の段階（docs/business.md の「値段の考え方」）。画面の選択肢だけが使い、サーバーは段階を知らずに値を受ける
// （51人以上の組織のために、段階に無い値も入れられるため）
export const quotaTiers = [
  { id: 'small', member_limit: 15, attachment_quota_bytes: 30 * QUOTA_GIB },
  { id: 'standard', member_limit: 50, attachment_quota_bytes: 100 * QUOTA_GIB },
] as const;
export type QuotaTier = (typeof quotaTiers)[number];

// 組織の人数の上限と添付ファイルの合計の上限を変える。停止中の組織も変えられる。人数を今の人数より小さくしてもよい
// （今いる人は残り、招待だけが止まる）。今と同じ値なら何も書かず、今の値を返す。
// 読んだ値のままであることを条件に書き、外れたら 409 の conflict、無い slug は 404。添付ファイルの上限を上げたら
// attachment_quota_warned_at を空に戻す。履歴は action が update で、changes_json は変わった列だけの前後の値。
// 履歴を書けなくても変更は成功として返す
export const organizationQuotaUpdate = defineOperation({
  name: 'organization-quota-update',
  description: '組織の人数の上限と添付ファイルの合計の上限（バイト）を変える',
  mode: 'write',
  permission: 'operator',
  input: z.object({
    slug: z.string().max(SLUG_MAX_LENGTH * 2),
    member_limit: z.number().int().min(1).max(MEMBER_LIMIT_MAX),
    attachment_quota_bytes: z.number().int().min(1).max(ATTACHMENT_QUOTA_MAX_BYTES),
  }),
  output: z.object({
    slug: z.string(),
    member_limit: z.number().int(),
    attachment_quota_bytes: z.number().int(),
  }),
});
