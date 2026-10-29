// パスワードのハッシュ（Issue #256、docs/data-model.md の `password_credentials`）。PBKDF2-HMAC-SHA256、16 バイトの塩、32 バイトの鍵。
// 文字列は `pbkdf2-sha256$<反復回数>$<塩の base64url>$<鍵の base64url>`（自己記述。回数を上げても古い値を照合できる）。
// 反復回数は 100,000。本番の Workers の Web Crypto は 100,000 を超える回数を断る（手元の workerd は通すので、手元で確かめられない）。
// 照合は crypto.subtle.timingSafeEqual で比べる。形の壊れた保存値は例外を投げずに false にする。
// 無いメールアドレスでも verifyDummyPassword で同じだけ回し、所要時間で有無を見分けさせない。
// パスワード、ハッシュ、塩、鍵はログにも例外の message にも入れない。
// 人が差分を読む領域（docs/development.md の「マージの判定」）

export const PASSWORD_HASH_ITERATIONS = 100_000;

const SCHEME = 'pbkdf2-sha256';
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// 保存値に書かれた回数の上限。今の回数を超える値は書かないので、壊れた値として扱う（本番の Workers は 100,000 を
// 超える回数を断り、照合が例外の 500 になると、無いメールアドレスの 401 と見分けられるため）
const MAX_STORED_ITERATIONS = PASSWORD_HASH_ITERATIONS;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  try {
    return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

type ParsedHash = { iterations: number; salt: Uint8Array<ArrayBuffer>; key: Uint8Array<ArrayBuffer> };

function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 4) return undefined;
  const [scheme, iterationsText, saltText, keyText] = parts as [string, string, string, string];
  if (scheme !== SCHEME || !/^[1-9][0-9]{0,8}$/.test(iterationsText)) return undefined;
  const iterations = Number(iterationsText);
  if (iterations > MAX_STORED_ITERATIONS) return undefined;
  const salt = decodeBase64url(saltText);
  const key = decodeBase64url(keyText);
  if (salt === undefined || key === undefined || salt.byteLength === 0 || key.byteLength === 0) return undefined;
  return { iterations, salt, key };
}

// そろえた（normalizePassword を通した）パスワードを渡す
export async function hashPassword(password: string, iterations: number = PASSWORD_HASH_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(password, salt, iterations);
  return `${SCHEME}$${iterations}$${base64url(salt)}$${base64url(key)}`;
}

// 保存値の回数で1回回し、鍵を timingSafeEqual で比べる。形の壊れた保存値は、無いメールアドレスと同じだけ回して false。
// 保存値の回数が今の回数より少ない（成功時に書き直す前の）人は、足りない分を捨てる値で回し、合計を今の回数にそろえる。
// 違うパスワードの応答が、無いメールアドレス（verifyDummyPassword）より速く返って、有無が分からないようにするため
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === undefined) return verifyDummyPassword(password);
  if (parsed.iterations < PASSWORD_HASH_ITERATIONS) {
    await deriveKey(password, DUMMY_SALT, PASSWORD_HASH_ITERATIONS - parsed.iterations);
  }
  const derived = await deriveKey(password, parsed.salt, parsed.iterations);
  // 長さが違えば timingSafeEqual は投げる。鍵の長さは秘密ではないので、比べずに false
  if (derived.byteLength !== parsed.key.byteLength) return false;
  return crypto.subtle.timingSafeEqual(derived, parsed.key);
}

// 照合する相手の無いとき（無いメールアドレス、そろえ方に合わない入力）に、ある人の照合と同じだけ回す。結果は必ず false。
// 塩と比べる鍵は決まった値（どのパスワードにも当たらないよう、比べた結果を使わない）
const DUMMY_SALT = new Uint8Array(SALT_BYTES);
const DUMMY_KEY = new Uint8Array(KEY_BYTES);

export async function verifyDummyPassword(password: string): Promise<false> {
  const derived = await deriveKey(password, DUMMY_SALT, PASSWORD_HASH_ITERATIONS);
  crypto.subtle.timingSafeEqual(derived, DUMMY_KEY);
  return false;
}

// 保存値の回数が今の回数より少なければ true（ログインの成功時に書き直す）。形の壊れた値は書き直さない（照合が通らない）
export function passwordHashNeedsUpgrade(stored: string): boolean {
  const parsed = parseHash(stored);
  return parsed !== undefined && parsed.iterations < PASSWORD_HASH_ITERATIONS;
}
