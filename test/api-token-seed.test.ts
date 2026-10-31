// seed の API トークン（seed/api-tokens.ts の生の値と、seed/data.sql のハッシュ）が合い、API で読めること
import { describe, expect, test } from 'vitest';
import dataSql from '../seed/data.sql?raw';
import { SEED_API_TOKENS } from '../seed/api-tokens.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { API_TOKEN_PATTERN } from '../src/shared/api-token.ts';
import { hashApiToken } from '../src/server/auth/api-token.ts';

const tokens = Object.values(SEED_API_TOKENS);
const seedAccountIds = new Set(Object.values(SEED_SESSIONS).map((session) => session.accountId));

describe('seed の API トークン', () => {
  test('生の値は発行と同じ形で、重ならない', () => {
    for (const { token } of tokens) expect(token).toMatch(API_TOKEN_PATTERN);
    expect(new Set(tokens.map(({ token }) => token)).size).toBe(tokens.length);
  });

  test('アカウントは seed のセッションの人のもの', () => {
    for (const { accountId } of tokens) expect(seedAccountIds.has(accountId)).toBe(true);
  });

  test('data.sql の行が、生の値のハッシュ、アカウント、範囲と合う', async () => {
    for (const { token, accountId, scope } of tokens) {
      const hash = await hashApiToken(token);
      const rows = [...dataSql.matchAll(new RegExp(`^\\s*\\('${hash}', '([^']+)', '[^']*', '(read|write)'`, 'gm'))];
      expect(rows, token).toHaveLength(1);
      expect(rows[0]![1]).toBe(accountId);
      expect(rows[0]![2]).toBe(scope);
    }
  });

  test('data.sql の API トークンの行は、seed の生の値のものだけ', async () => {
    const hashes = await Promise.all(tokens.map(({ token }) => hashApiToken(token)));
    const insert = /INSERT INTO api_tokens[^;]*;/.exec(dataSql)?.[0] ?? '';
    const found = [...insert.matchAll(/^\s*\('([0-9a-f]{64})'/gm)].map((match) => match[1]);
    expect(found.sort()).toEqual(hashes.sort());
  });
});
