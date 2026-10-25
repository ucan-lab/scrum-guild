// Google の ID トークンの検査（src/server/auth/google.ts の checkGoogleIdToken）の単体テスト。
// 署名は検証しない設計なので、確かめるのは iss、aud（配列なら azp）、exp、nonce の4つの断りと、email_verified、sub、名前、アバター
import { describe, expect, test } from 'vitest';
import { checkGoogleIdToken, type GoogleIdTokenExpectation } from '../src/server/auth/google.ts';
import { LoginMethodError } from '../src/server/auth/login-method.ts';
import { FAKE_GOOGLE_CLIENT_ID, unsignedJwt, type IdTokenClaims } from './auth/fake-google.ts';

const NOW = new Date('2026-10-26T01:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const NONCE = 'n'.repeat(43);
const expected: GoogleIdTokenExpectation = { clientId: FAKE_GOOGLE_CLIENT_ID, nonce: NONCE, now: NOW };

function claims(overrides: IdTokenClaims = {}): IdTokenClaims {
  const base: IdTokenClaims = {
    iss: 'https://accounts.google.com',
    aud: FAKE_GOOGLE_CLIENT_ID,
    azp: FAKE_GOOGLE_CLIENT_ID,
    exp: NOW_SECONDS + 3600,
    nonce: NONCE,
    sub: '118234567890123456789',
    email: 'someone@example.test',
    email_verified: true,
    name: '星野 澪',
    picture: 'https://lh3.googleusercontent.com/a/fake',
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) delete base[key];
  }
  return base;
}

function check(overrides: IdTokenClaims = {}, options: Partial<GoogleIdTokenExpectation> = {}) {
  return checkGoogleIdToken(unsignedJwt(claims(overrides)), { ...expected, ...options });
}

function failureOf(run: () => unknown): LoginMethodError {
  try {
    run();
  } catch (err) {
    if (err instanceof LoginMethodError) return err;
    throw err;
  }
  throw new Error('断られなかった');
}

describe('通るトークン', () => {
  test('sub、名前、アバター、確かめたメールを返す', () => {
    expect(check()).toEqual({
      profile: {
        subject: '118234567890123456789',
        loginName: '星野 澪',
        displayName: '星野 澪',
        avatarUrl: 'https://lh3.googleusercontent.com/a/fake',
      },
      email: 'someone@example.test',
    });
  });

  test.each(['https://accounts.google.com', 'accounts.google.com'])('iss が %s なら通る', (iss) => {
    expect(check({ iss }).profile.subject).toBe('118234567890123456789');
  });

  test('aud が文字列で azp が無ければ通る', () => {
    expect(check({ aud: FAKE_GOOGLE_CLIENT_ID, azp: undefined }).profile.subject).toBe('118234567890123456789');
  });

  test('aud が配列で、クライアント ID を含み azp も一致すれば通る', () => {
    expect(check({ aud: ['other-client', FAKE_GOOGLE_CLIENT_ID], azp: FAKE_GOOGLE_CLIENT_ID }).profile.subject).toBe(
      '118234567890123456789',
    );
  });
});

describe('断るトークン', () => {
  test.each([
    ['iss が別のホスト', { iss: 'https://evil.example' }],
    ['iss が前方一致するだけ', { iss: 'https://accounts.google.com.evil.example' }],
    ['iss が末尾にスラッシュ付き', { iss: 'https://accounts.google.com/' }],
    ['iss が無い', { iss: undefined }],
  ])('%s', (_label, overrides) => {
    expect(failureOf(() => check(overrides)).message).toContain('iss');
  });

  test.each([
    ['aud が別のクライアント', { aud: 'other-client' }],
    ['aud が前方一致するだけ', { aud: `${FAKE_GOOGLE_CLIENT_ID}.evil` }],
    ['aud が無い', { aud: undefined }],
    ['aud が配列でクライアント ID を含まない', { aud: ['other-client'], azp: FAKE_GOOGLE_CLIENT_ID }],
    ['aud が配列で azp が別', { aud: [FAKE_GOOGLE_CLIENT_ID, 'other-client'], azp: 'other-client' }],
    ['aud が配列で azp が無い', { aud: [FAKE_GOOGLE_CLIENT_ID, 'other-client'], azp: undefined }],
    ['aud が文字列で azp が別', { aud: FAKE_GOOGLE_CLIENT_ID, azp: 'other-client' }],
  ])('%s', (_label, overrides) => {
    expect(failureOf(() => check(overrides)).message).toContain('aud');
  });

  test('期限切れ。猶予は設けず、exp ちょうどでも断る', () => {
    expect(failureOf(() => check({ exp: NOW_SECONDS - 1 })).message).toContain('期限');
    expect(failureOf(() => check({ exp: NOW_SECONDS })).message).toContain('期限');
    expect(check({ exp: NOW_SECONDS + 1 }).profile.subject).toBe('118234567890123456789');
  });

  test.each([
    ['exp が文字列', { exp: String(NOW_SECONDS + 3600) }],
    ['exp が無い', { exp: undefined }],
  ])('%s', (_label, overrides) => {
    expect(failureOf(() => check(overrides)).message).toContain('期限');
  });

  test.each([
    ['nonce が違う', { nonce: 'x'.repeat(43) }],
    ['nonce が無い', { nonce: undefined }],
    ['nonce が数値', { nonce: 1 }],
  ])('%s', (_label, overrides) => {
    expect(failureOf(() => check(overrides)).message).toContain('nonce');
  });

  test('期待する nonce が空なら、nonce の無いトークンでも断る', () => {
    expect(failureOf(() => check({ nonce: '' }, { nonce: '' })).message).toContain('nonce');
  });

  test.each([
    ['sub が無い', { sub: undefined }],
    ['sub が空', { sub: '' }],
    ['sub が数値', { sub: 424242 }],
    ['sub が長すぎる', { sub: '1'.repeat(256) }],
  ])('%s', (_label, overrides) => {
    expect(failureOf(() => check(overrides)).failure).toBe('unavailable');
  });

  test.each([
    ['JWT の形でない', 'not-a-jwt'],
    ['本文が base64url でない', 'a.%%%.c'],
    ['本文が JSON でない', `a.${btoa('plain').replaceAll('=', '')}.c`],
    ['本文が配列', `a.${btoa('[1]').replaceAll('=', '')}.c`],
  ])('%s', (_label, token) => {
    expect(failureOf(() => checkGoogleIdToken(token, expected)).failure).toBe('unavailable');
  });

  test('失敗の message に ID トークンの中身、メールアドレス、nonce を入れない', () => {
    const token = unsignedJwt(claims({ iss: 'https://evil.example' }));
    const error = failureOf(() => checkGoogleIdToken(token, expected));
    for (const secret of [token, 'someone@example.test', NONCE, '118234567890123456789']) {
      expect(error.message).not.toContain(secret);
    }
  });
});

describe('email_verified', () => {
  test('真偽値の true のときだけ、メールアドレスを返す', () => {
    expect(check({ email_verified: true }).email).toBe('someone@example.test');
  });

  test.each([
    ['文字列の "true"', 'true'],
    ['false', false],
    ['数値の 1', 1],
    ['null', null],
    ['欠けている', undefined],
  ])('%s のときは、メールアドレスを null にし、ログインは断らない', (_label, emailVerified) => {
    const result = check({ email_verified: emailVerified });
    expect(result.email).toBeNull();
    expect(result.profile.subject).toBe('118234567890123456789');
  });

  test('メールアドレスが欠けていれば null', () => {
    expect(check({ email: undefined }).email).toBeNull();
  });
});

describe('sub', () => {
  test('長い sub は数値に直さず、文字列のまま返す', () => {
    // 118234567890123456789 を数値にすると 118234567890123460000 に丸まる
    expect(Number('118234567890123456789').toString()).not.toBe('118234567890123456789');
    expect(check({ sub: '118234567890123456789' }).profile.subject).toBe('118234567890123456789');
  });
});

describe('名前とアバター', () => {
  test('名前が無ければ login_name は「Google ユーザー」で、display_name は null', () => {
    expect(check({ name: undefined }).profile).toMatchObject({ loginName: 'Google ユーザー', displayName: null });
  });

  test('見えない文字だけの名前も同じ扱い。見えない文字は取り除く', () => {
    expect(check({ name: '‮​' }).profile).toMatchObject({ loginName: 'Google ユーザー', displayName: null });
    expect(check({ name: '星野‮ 澪' }).profile).toMatchObject({ loginName: '星野 澪', displayName: '星野 澪' });
  });

  test('名前は200文字のコードポイントで切る', () => {
    expect([...check({ name: '👩‍💻'.repeat(300) }).profile.displayName!].length).toBe(200);
  });

  test.each([
    ['lh3 でない googleusercontent', 'https://lh4.googleusercontent.com/a/x'],
    ['ほかのサービスのファイルを配るサブドメイン', 'https://doc-0g-1o-docs.googleusercontent.com/x'],
    ['親ドメインの別名', 'https://lh3.googleusercontent.com.evil.example/a'],
    ['http', 'http://lh3.googleusercontent.com/a/x'],
    ['別のホスト', 'https://avatars.githubusercontent.com/u/1'],
    ['URL でない', 'not a url'],
    ['長すぎる', `https://lh3.googleusercontent.com/${'a'.repeat(500)}`],
  ])('アバターが%sなら null', (_label, picture) => {
    expect(check({ picture }).profile.avatarUrl).toBeNull();
  });

  test('アバターが無ければ null', () => {
    expect(check({ picture: undefined }).profile.avatarUrl).toBeNull();
  });
});
