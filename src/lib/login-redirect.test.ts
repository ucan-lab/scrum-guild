import { describe, expect, test } from 'vitest';
import { isSuspendedUnauthenticated, type ErrorBody } from '../shared/errors.ts';
import { isUnauthenticated, loginUrl } from './login-redirect.ts';

const current = { pathname: '/aoba', search: '' };

// 401 の応答。reason が無ければ details を持たない
const unauthenticated = (details?: unknown) => ({
  ok: false as const,
  error: { code: 'unauthenticated', message: 'x', ...(details === undefined ? {} : { details }) } as ErrorBody['error'],
});
const suspended = unauthenticated({ reason: 'suspended' });

describe('isSuspendedUnauthenticated', () => {
  test('401 の unauthenticated で details.reason が suspended のときだけ真', () => {
    expect(isSuspendedUnauthenticated(suspended.error)).toBe(true);
  });

  test('details が無い、null、文字列、配列、reason が違う、reason が文字列でないときは偽', () => {
    for (const details of [undefined, null, 'suspended', ['suspended'], { reason: 'other' }, { reason: 1 }, {}]) {
      expect(isSuspendedUnauthenticated(unauthenticated(details).error), JSON.stringify(details)).toBe(false);
    }
  });

  test('code が unauthenticated でなければ、reason が suspended でも偽', () => {
    expect(isSuspendedUnauthenticated({ code: 'forbidden', message: 'x', details: { reason: 'suspended' } })).toBe(
      false,
    );
  });

  test('error が null か undefined のときは偽', () => {
    expect(isSuspendedUnauthenticated(null)).toBe(false);
    expect(isSuspendedUnauthenticated(undefined)).toBe(false);
  });
});

describe('loginUrl', () => {
  const plain = '/login?return_to=%2Faoba';

  test('応答を渡さなければ、return_to だけ', () => {
    expect(loginUrl(current)).toBe(plain);
  });

  test('理由を持つ 401 を渡すと error=suspended を足す', () => {
    expect(loginUrl(current, suspended)).toBe(`${plain}&error=suspended`);
  });

  test('理由の無い 401 だけでは足さない', () => {
    expect(loginUrl(current, unauthenticated())).toBe(plain);
  });

  test('複数の応答のうち、片方だけが理由を持つときは足す（どちらの順でも）', () => {
    expect(loginUrl(current, unauthenticated(), suspended)).toBe(`${plain}&error=suspended`);
    expect(loginUrl(current, suspended, unauthenticated())).toBe(`${plain}&error=suspended`);
  });

  test('成功の応答を混ぜても無視する。理由の形をしたものがあっても、成功の応答は数えない', () => {
    expect(loginUrl(current, { ok: true }, unauthenticated())).toBe(plain);
    expect(loginUrl(current, { ok: true, error: suspended.error }, unauthenticated())).toBe(plain);
    expect(loginUrl(current, { ok: true }, suspended)).toBe(`${plain}&error=suspended`);
  });

  test('error が null や details が文字列の応答は無視する', () => {
    expect(loginUrl(current, { ok: false, error: null }, unauthenticated('suspended'))).toBe(plain);
  });

  test('今のパスとクエリを return_to に入れ、自分のサイトのパスでなければ / に落とす', () => {
    expect(loginUrl({ pathname: '/aoba/w/1', search: '?tab=2' }, suspended)).toBe(
      '/login?return_to=%2Faoba%2Fw%2F1%3Ftab%3D2&error=suspended',
    );
    expect(loginUrl({ pathname: '//evil.example', search: '' })).toBe('/login?return_to=%2F');
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
