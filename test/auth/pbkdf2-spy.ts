// PBKDF2 を何回、何回の反復で回したかを数える。crypto.subtle の deriveBits と deriveKey をスパイし、中身は本物を通す。
// 無いメールアドレスと違うパスワードで、同じだけハッシュを回すこと（所要時間で見分けられないこと）を確かめるのに使う
import { vi } from 'vitest';

function pbkdf2IterationsOf(algorithm: unknown): number | undefined {
  if (typeof algorithm !== 'object' || algorithm === null) return undefined;
  const { name, iterations } = algorithm as { name?: unknown; iterations?: unknown };
  if (typeof name !== 'string' || name.toUpperCase() !== 'PBKDF2') return undefined;
  return Number(iterations);
}

export function spyPbkdf2(): { iterations: () => number[]; restore: () => void } {
  const bits = vi.spyOn(crypto.subtle, 'deriveBits');
  const key = vi.spyOn(crypto.subtle, 'deriveKey');
  return {
    restore: () => {
      bits.mockRestore();
      key.mockRestore();
    },
    // 呼ばれた順ではなく、deriveBits の後に deriveKey を並べる。数と回数を比べるのに使う
    iterations: () =>
      [...bits.mock.calls, ...key.mock.calls].flatMap((call) => {
        const count = pbkdf2IterationsOf(call[0]);
        return count === undefined ? [] : [count];
      }),
  };
}
