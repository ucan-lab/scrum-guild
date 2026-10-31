import { describe, expect, test } from 'vitest';
import type { ErrorBody } from '../shared/errors.ts';
import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from './login-redirect.ts';

const current = { pathname: '/aoba', search: '' };

// 401 の応答。reason が無ければ details を持たない
const unauthenticated = (details?: unknown) => ({
  ok: false as const,
  error: { code: 'unauthenticated', message: 'x', ...(details === undefined ? {} : { details }) } as ErrorBody['error'],
});
// 前の版が返していた、停止を理由に持つ 401（#639 で、ログインの画面へ理由を付ける場面は無くなった）
const suspended = unauthenticated({ reason: 'suspended' });

// 前の版は、応答を渡すと理由（error=suspended）を足した。今の版が応答を受け取らなくても型で落ちないよう、緩く呼ぶ
const loginUrlWith = loginUrl as unknown as (
  current: { pathname: string; search: string },
  ...failures: unknown[]
) => string;

describe('loginUrl', () => {
  const plain = '/login?return_to=%2Faoba';

  test('return_to だけを付ける', () => {
    expect(loginUrl(current)).toBe(plain);
  });

  test('停止を理由に持つ 401 を渡しても、error=suspended を足さない（#639）', () => {
    expect(loginUrlWith(current, suspended)).toBe(plain);
    expect(loginUrlWith(current, unauthenticated(), suspended)).toBe(plain);
    expect(loginUrlWith(current, suspended, unauthenticated())).toBe(plain);
    expect(loginUrlWith(current, { ok: true }, suspended)).toBe(plain);
  });

  test('理由の無い 401 でも足さない', () => {
    expect(loginUrlWith(current, unauthenticated())).toBe(plain);
  });

  test('今のパスとクエリを return_to に入れ、自分のサイトのパスでなければ / に落とす', () => {
    expect(loginUrlWith({ pathname: '/aoba/w/1', search: '?tab=2' }, suspended)).toBe(
      '/login?return_to=%2Faoba%2Fw%2F1%3Ftab%3D2',
    );
    expect(loginUrl({ pathname: '//evil.example', search: '' })).toBe('/login?return_to=%2F');
  });
});

describe('isTermsRequired', () => {
  test('失敗した 403 の terms_required だけ真', () => {
    expect(isTermsRequired({ ok: false, error: { code: 'terms_required' } })).toBe(true);
  });

  test('ほかの 403（forbidden）、401、ほかのエラー、成功は偽', () => {
    expect(isTermsRequired({ ok: false, error: { code: 'forbidden' } })).toBe(false);
    expect(isTermsRequired(unauthenticated())).toBe(false);
    expect(isTermsRequired({ ok: false, error: { code: 'not_found' } })).toBe(false);
    expect(isTermsRequired({ ok: true, error: { code: 'terms_required' } })).toBe(false);
    expect(isTermsRequired({ ok: true })).toBe(false);
    expect(isTermsRequired({ ok: false, error: null })).toBe(false);
    expect(isTermsRequired({ ok: false })).toBe(false);
  });
});

describe('consentUrl', () => {
  test('今のパスとクエリを return_to に入れる', () => {
    expect(consentUrl(current)).toBe('/consent?return_to=%2Faoba');
    expect(consentUrl({ pathname: '/aoba/w/1', search: '?tab=2' })).toBe(
      '/consent?return_to=%2Faoba%2Fw%2F1%3Ftab%3D2',
    );
  });

  test('? と & を含む search は return_to の中で encode される', () => {
    expect(consentUrl({ pathname: '/aoba', search: '?a=1&b=2' })).toBe('/consent?return_to=%2Faoba%3Fa%3D1%26b%3D2');
  });

  test('ルートは / になる', () => {
    expect(consentUrl({ pathname: '/', search: '' })).toBe('/consent?return_to=%2F');
  });

  test('受け付けない値（別のサイト、API、ログインの画面）は / に落とす', () => {
    expect(consentUrl({ pathname: '//evil.example', search: '' })).toBe('/consent?return_to=%2F');
    expect(consentUrl({ pathname: '/api/me', search: '' })).toBe('/consent?return_to=%2F');
    expect(consentUrl({ pathname: '/login', search: '' })).toBe('/consent?return_to=%2F');
  });
});

describe('isUnauthenticated', () => {
  test('失敗した unauthenticated だけ真', () => {
    expect(isUnauthenticated(unauthenticated())).toBe(true);
    expect(isUnauthenticated({ ok: true, error: { code: 'unauthenticated' } })).toBe(false);
    expect(isUnauthenticated({ ok: false, error: { code: 'forbidden' } })).toBe(false);
    expect(isUnauthenticated({ ok: false, error: null })).toBe(false);
  });
});
