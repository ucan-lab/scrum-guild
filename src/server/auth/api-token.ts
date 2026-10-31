// API トークンを発行し、読み、取り消し、掃除する（docs/data-model.md の `api_tokens`）。
// 空の入れ物。中身はテストが通るように実装する
/* eslint-disable @typescript-eslint/no-unused-vars -- 実装するまでの空の入れ物 */
import type { ApiTokenScope } from '../../shared/api-token.ts';
import type { CommonDb } from '../db/index.ts';

export type ApiToken = { accountId: string; tokenHash: string; scope: ApiTokenScope };

export async function hashApiToken(_token: string): Promise<string> {
  throw new Error('未実装');
}

export async function issueApiToken(
  _env: Env,
  _input: { accountId: string; name: string; scope: ApiTokenScope; now: Date; lifetimeDays?: number },
): Promise<string> {
  throw new Error('未実装');
}

export async function readApiToken(_env: Env, _token: string | undefined, _now: Date): Promise<ApiToken | undefined> {
  throw new Error('未実装');
}

export async function revokeApiTokensOf(_db: CommonDb, _accountId: string, _checkedAt: Date): Promise<void> {
  throw new Error('未実装');
}

export async function deleteExpiredApiTokens(_env: Env, _now: Date): Promise<number> {
  throw new Error('未実装');
}
