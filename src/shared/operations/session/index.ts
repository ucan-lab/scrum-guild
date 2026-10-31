// ログインしている人自身の操作（permission: 'login'）。ログインの開始と戻り先は GET のリダイレクトなので、
// 操作の定義の外に直に書く例外（src/server/auth/login-routes.ts。docs/development.md の「操作の定義」）
import { z } from 'zod';
import { defineOperation } from '../define.ts';
import type { AnyOperationDefinition } from '../define.ts';
import { tokenCreate, tokenList, tokenRevoke } from './token.ts';

export const me = defineOperation({
  name: 'me',
  description: 'ログインしている自分のアカウントと、ログインの手段の表示用の名前とアバターを返す',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({
    account_id: z.string(),
    login_provider: z.string(),
    login_name: z.string(),
    display_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
  }),
});

export const logout = defineOperation({
  name: 'logout',
  description: '今のセッションを消し、セッションの Cookie も消す',
  mode: 'write',
  permission: 'login',
  // 入れる組織を失った人にも使わせる。ここで確かめると、セッションの行を消す仕事が、確かめの失敗の 401 に先を越される
  skipsLoginAccess: true,
  // 消すのは sessions の行と Cookie だけで、API トークンの行は指せない。トークンからは断る
  cookieOnly: true,
  input: z.object({}),
  output: z.object({}),
});

export { tokenCreate, tokenList, tokenRevoke } from './token.ts';

export const sessionOperations: readonly AnyOperationDefinition[] = [me, logout, tokenCreate, tokenList, tokenRevoke];
