// パスワードのハッシュ（src/server/auth/password-hash.ts、Issue #256）。
// 形は `pbkdf2-sha256$<反復回数>$<塩の base64url>$<鍵の base64url>`、塩16バイト（毎回乱数）、鍵32バイト。
// 比べるのは crypto.subtle.timingSafeEqual。形の壊れた値は例外を投げずに false
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  hashPassword,
  PASSWORD_HASH_ITERATIONS,
  passwordHashNeedsUpgrade,
  verifyDummyPassword,
  verifyPassword,
} from '../src/server/auth/password-hash.ts';
import { normalizePassword } from '../src/shared/password.ts';
import { spyPbkdf2 } from './auth/pbkdf2-spy.ts';

// 架空の値
const PASSWORD = 'tsubame-hoshi-2026';
const OTHER = 'tsubame-hoshi-2027';
// 速く回すための少ない回数。形と照合は回数に依らない
const FEW = 1000;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeBase64url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('形', () => {
  test('今の回数で、方式、回数、塩16バイト、鍵32バイトを $ でつなぐ', async () => {
    expect(PASSWORD_HASH_ITERATIONS).toBe(100_000);
    const stored = await hashPassword(PASSWORD);
    const parts = stored.split('$');
    expect(parts).toHaveLength(4);
    const [scheme, iterations, salt, key] = parts as [string, string, string, string];
    expect(scheme).toBe('pbkdf2-sha256');
    expect(iterations).toBe(String(PASSWORD_HASH_ITERATIONS));
    expect(salt).toMatch(BASE64URL);
    expect(key).toMatch(BASE64URL);
    expect(decodeBase64url(salt)).toHaveLength(16);
    expect(decodeBase64url(key)).toHaveLength(32);
    // 平文を含まない
    expect(stored).not.toContain(PASSWORD);
  });

  test('回数を渡せば、その回数で作る', async () => {
    const stored = await hashPassword(PASSWORD, FEW);
    expect(stored.startsWith(`pbkdf2-sha256$${FEW}$`)).toBe(true);
  });

  test('PBKDF2 を、渡した回数で1回だけ回す', async () => {
    const spy = spyPbkdf2();
    await hashPassword(PASSWORD, FEW);
    expect(spy.iterations()).toEqual([FEW]);
  });

  test('同じパスワードでも、塩が毎回違うので値が違う', async () => {
    const first = await hashPassword(PASSWORD, FEW);
    const second = await hashPassword(PASSWORD, FEW);
    expect(first).not.toBe(second);
    expect(first.split('$')[2]).not.toBe(second.split('$')[2]);
    expect(first.split('$')[3]).not.toBe(second.split('$')[3]);
  });

  test('DB の CHECK（pbkdf2-sha256$[1-9]*$?*$?*）に合う形', async () => {
    const stored = await hashPassword(PASSWORD, FEW);
    expect(stored).toMatch(/^pbkdf2-sha256\$[1-9][0-9]*\$[^$]+\$[^$]+$/);
  });
});

describe('照合', () => {
  test('正しいパスワードは true', async () => {
    const stored = await hashPassword(PASSWORD, FEW);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
  });

  test('今の回数で作った値も照合できる', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(OTHER, stored)).toBe(false);
  });

  test('違うパスワードは false', async () => {
    const stored = await hashPassword(PASSWORD, FEW);
    expect(await verifyPassword(OTHER, stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword(`${PASSWORD} `, stored)).toBe(false);
  });

  test('照合は保存した回数で、PBKDF2 を1回回す', async () => {
    const stored = await hashPassword(PASSWORD, FEW);
    const spy = spyPbkdf2();
    await verifyPassword(OTHER, stored);
    expect(spy.iterations()).toEqual([FEW]);
  });

  test('比べるのは crypto.subtle.timingSafeEqual', async () => {
    const stored = await hashPassword(PASSWORD, FEW);
    const equal = vi.spyOn(crypto.subtle, 'timingSafeEqual');
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(OTHER, stored)).toBe(false);
    expect(equal).toHaveBeenCalledTimes(2);
  });

  test('NFC にそろえれば、合成済みの「が」と分解した「が」は同じパスワードとして通る', async () => {
    const composed = normalizePassword('が'.repeat(6) + 'kumo-2026');
    const decomposed = normalizePassword('が'.repeat(6) + 'kumo-2026');
    expect(composed).toBeDefined();
    expect(decomposed).toBeDefined();
    const stored = await hashPassword(composed!, FEW);
    expect(await verifyPassword(decomposed!, stored)).toBe(true);
  });
});

describe('形の壊れた値は、例外を投げずに false', () => {
  test.each([
    ['空', ''],
    ['区切りが足りない', 'pbkdf2-sha256$1000$c2FsdA'],
    ['区切りが多い', 'pbkdf2-sha256$1000$c2FsdA$a2V5$extra'],
    ['方式が違う', 'pbkdf2-sha1$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['回数が数でない', 'pbkdf2-sha256$abc$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['回数が 0', 'pbkdf2-sha256$0$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['回数が負', 'pbkdf2-sha256$-1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['回数が小数', 'pbkdf2-sha256$1.5$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['回数が空', 'pbkdf2-sha256$$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['塩が base64url でない', 'pbkdf2-sha256$1000$!!!!$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['鍵が base64url でない', 'pbkdf2-sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$****'],
    ['塩が空', 'pbkdf2-sha256$1000$$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['鍵が空', 'pbkdf2-sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$'],
    ['平文のパスワード', PASSWORD],
  ])('%s', async (_label, stored) => {
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
  });

  test('鍵の長さが32バイトでない（timingSafeEqual が長さの違いで投げる場合）も false', async () => {
    const stored = await hashPassword(PASSWORD, FEW);
    const [scheme, iterations, salt, key] = stored.split('$') as [string, string, string, string];
    // 鍵を1文字短くする（base64url の43文字 → 42文字で31バイト）
    const shorter = [scheme, iterations, salt, key.slice(0, 42)].join('$');
    await expect(verifyPassword(PASSWORD, shorter)).resolves.toBe(false);
    // 長い鍵（64バイト）
    const longer = [scheme, iterations, salt, key + key.slice(0, 43)].join('$');
    await expect(verifyPassword(PASSWORD, longer)).resolves.toBe(false);
  });
});

describe('回数の書き直し', () => {
  test('今の回数より少なければ書き直す', async () => {
    expect(passwordHashNeedsUpgrade(await hashPassword(PASSWORD, FEW))).toBe(true);
    expect(passwordHashNeedsUpgrade(await hashPassword(PASSWORD, PASSWORD_HASH_ITERATIONS - 1))).toBe(true);
  });

  test('今の回数なら書き直さない', async () => {
    expect(passwordHashNeedsUpgrade(await hashPassword(PASSWORD))).toBe(false);
  });
});

describe('無いメールアドレスのときのダミーの照合', () => {
  test('どのパスワードでも false', async () => {
    expect(await verifyDummyPassword(PASSWORD)).toBe(false);
    expect(await verifyDummyPassword('')).toBe(false);
  });

  test('今の回数で PBKDF2 を1回回す（ある人の照合と同じだけ時間を掛ける）', async () => {
    const spy = spyPbkdf2();
    await verifyDummyPassword(PASSWORD);
    expect(spy.iterations()).toEqual([PASSWORD_HASH_ITERATIONS]);
  });

  test('ある人の照合（今の回数）と、回す数と回数が同じ', async () => {
    const stored = await hashPassword(PASSWORD);
    const real = spyPbkdf2();
    await verifyPassword(OTHER, stored);
    const realIterations = real.iterations();
    real.restore();
    const dummy = spyPbkdf2();
    await verifyDummyPassword(OTHER);
    expect(dummy.iterations()).toEqual(realIterations);
  });
});
