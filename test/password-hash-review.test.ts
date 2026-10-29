// パスワードの照合のレビューの指摘（Issue #256、done-check）。保存した値の形で、照合の所要時間と結果に差を出さない。
//   - 形の壊れた保存値でも、無いメールアドレス（verifyDummyPassword）と同じだけ回してから false
//   - 今の回数より多い回数の保存値は、形の壊れた値として扱う。本番の Workers は 100,000 を超える回数を断り、
//     照合が例外の 500 になると、無いメールアドレスの 401 と見分けられるため
import { afterEach, describe, expect, test, vi } from 'vitest';
import { hashPassword, PASSWORD_HASH_ITERATIONS, verifyPassword } from '../src/server/auth/password-hash.ts';
import { spyPbkdf2 } from './auth/pbkdf2-spy.ts';

// 架空の値
const PASSWORD = 'kawasemi-kumo-2026';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('保存値の形で所要時間を変えない', () => {
  test.each([
    ['区切りが多い', 'pbkdf2-sha256$100000$AAAA$AAAA$AAAA'],
    ['塩が base64url でない', 'pbkdf2-sha256$100000$!!!!$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['回数が10桁', 'pbkdf2-sha256$1000000000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ])('形の壊れた保存値（%s）でも、今の回数を回して false', async (_name, stored) => {
    const spy = spyPbkdf2();
    expect(await verifyPassword(PASSWORD, stored)).toBe(false);
    expect(spy.iterations().reduce((sum, count) => sum + count, 0)).toBe(PASSWORD_HASH_ITERATIONS);
  });

  test('今の回数より多い回数の保存値は、その回数で回さず、今の回数だけ回して false', async () => {
    const stored = await hashPassword(PASSWORD, PASSWORD_HASH_ITERATIONS + 1);
    const spy = spyPbkdf2();
    expect(await verifyPassword(PASSWORD, stored)).toBe(false);
    expect(spy.iterations()).toEqual([PASSWORD_HASH_ITERATIONS]);
  });
});
