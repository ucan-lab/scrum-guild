// API トークンのテストが使う道具。api_tokens の行は、実装の関数（issueApiToken、hashApiToken）を通さずにここで作る。
// 読む側のテストが、発行の関数の不具合で落ちないようにするため。D1 の binding は、Kysely の型に表が入る前から使えるよう直に使う
/* eslint-disable db-entry/guard -- api_tokens は Kysely の表の型に入る前でも、行を直に作って確かめるため。型に入ったら commonDb に替える */
import { env } from 'cloudflare:workers';
import { sha256Hex } from '../../src/server/auth/tokens.ts';
import type { Person } from './world.ts';

export type TokenScope = 'read' | 'write';

export type TokenRow = {
  token_hash: string;
  account_id: string;
  name: string;
  scope: TokenScope;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// 本物と同じ形の `sgp_` + base64url の43文字
export function rawApiToken(): string {
  const body = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `sgp_${body}`;
}

export type InsertOptions = {
  scope?: TokenScope;
  name?: string;
  // 省略は、今から30日後
  expiresAt?: string;
  revokedAt?: string | null;
  createdAt?: string;
  lastUsedAt?: string | null;
  // 形の違う値の行も作れるよう、生の値を渡せる
  raw?: string;
};

// 行を作り、生の値とハッシュを返す
export async function insertApiToken(
  accountId: string,
  options: InsertOptions = {},
): Promise<{ raw: string; hash: string }> {
  const raw = options.raw ?? rawApiToken();
  const hash = await sha256Hex(raw);
  const createdAt = options.createdAt ?? '2026-10-20T00:00:00.000Z';
  await env.DB.prepare(
    'insert into api_tokens (token_hash, account_id, name, scope, created_at, last_used_at, expires_at, revoked_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      hash,
      accountId,
      options.name ?? 'テスト用',
      options.scope ?? 'write',
      createdAt,
      options.lastUsedAt === undefined ? createdAt : options.lastUsedAt,
      options.expiresAt ?? new Date(Date.now() + 30 * DAY_MS).toISOString(),
      options.revokedAt ?? null,
    )
    .run();
  return { raw, hash };
}

export async function tokenRow(hash: string): Promise<TokenRow | undefined> {
  const row = await env.DB.prepare('select * from api_tokens where token_hash = ?').bind(hash).first<TokenRow>();
  return row ?? undefined;
}

export async function tokenRowsOf(accountId: string): Promise<TokenRow[]> {
  const result = await env.DB.prepare('select * from api_tokens where account_id = ?').bind(accountId).all<TokenRow>();
  return result.results;
}

export async function countTokensIn(hashes: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const hash of hashes) if ((await tokenRow(hash)) !== undefined) found.push(hash);
  return found.sort();
}

// 人ごとに1つ作って使い回す（registry の検査が、同じ人で何度も呼ぶため）。範囲は scope ごとに別
const cache = new Map<string, string>();

export async function bearerFor(person: Pick<Person, 'accountId'>, scope: TokenScope = 'write'): Promise<string> {
  const key = `${scope}:${person.accountId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const { raw } = await insertApiToken(person.accountId, { scope });
  cache.set(key, raw);
  return raw;
}
