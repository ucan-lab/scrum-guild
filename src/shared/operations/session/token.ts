// API トークンの発行・一覧・取消（docs/development.md の「API トークン」）。画面のセッション（Cookie）だけが使える。
// トークンで呼ばせると、盗まれたトークンが自分の後継を増やせるため
import { z } from 'zod';
import { API_TOKEN_MAX_ACTIVE, API_TOKEN_MAX_LIFETIME_DAYS } from '../../api-token.ts';
import { defineOperation } from '../define.ts';

export const API_TOKEN_NAME_MAX_LENGTH = 100;

const scope = z.enum(['read', 'write']);

export const tokenCreate = defineOperation({
  name: 'token-create',
  description: `API トークンを発行する。名前（前後の空白を除いて1〜${API_TOKEN_NAME_MAX_LENGTH}文字）、範囲（read か write）、有効日数（1〜${API_TOKEN_MAX_LIFETIME_DAYS}の整数。省略は${API_TOKEN_MAX_LIFETIME_DAYS}日）を選ぶ。有効な（取り消していない、期限前の）トークンは1アカウントに${API_TOKEN_MAX_ACTIVE}件までで、超えたら 409 の conflict（details.reason は limit）。生の値はこの応答で1回だけ返る`,
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: z.object({
    // 対のないサロゲートは D1 が U+FFFD に変えて保存するので、応答の name と一覧の name が食い違う。入力で断る
    name: z
      .string()
      .trim()
      .min(1)
      .max(API_TOKEN_NAME_MAX_LENGTH)
      .refine((value) => value.isWellFormed())
      // SQLite の length() は NUL で数えるのをやめるので、DB の CHECK に落ちて 500 になる。入力で断る
      .refine((value) => !value.includes('\u0000')),
    scope,
    lifetime_days: z.number().int().min(1).max(API_TOKEN_MAX_LIFETIME_DAYS).optional(),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    scope,
    expires_at: z.string(),
    token: z.string(),
  }),
});

export const tokenList = defineOperation({
  name: 'token-list',
  description:
    '自分の API トークンを、新しい順に返す。取り消したものと期限が来たものは含めない。トークンの値は返さない',
  mode: 'read',
  permission: 'login',
  cookieOnly: true,
  input: z.object({}),
  output: z.object({
    tokens: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        scope,
        created_at: z.string(),
        last_used_at: z.string().nullable(),
        expires_at: z.string(),
      }),
    ),
  }),
});

export const tokenRevoke = defineOperation({
  name: 'token-revoke',
  description:
    '自分の API トークンを取り消す。取り消したトークンは使えなくなる。すでに取り消したものは成功し、他人のものと存在しないものは 404',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }),
  output: z.object({}),
});
