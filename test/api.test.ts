import { env, exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { isErrorBody } from '../src/shared/errors.ts';

const apiHeaders = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cache-control': 'no-store',
};

function expectApiHeaders(res: Response) {
  for (const [name, value] of Object.entries(apiHeaders)) {
    expect(res.headers.get(name), name).toBe(value);
  }
}

describe('API', () => {
  test('/api/health は 200 で版を返す', async () => {
    const res = await exports.default.fetch('http://example.com/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'dev' });
    expectApiHeaders(res);
  });

  test('存在しない /api/* は JSON の 404', async () => {
    const res = await exports.default.fetch('http://example.com/api/x');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(isErrorBody(body) && body.error.code).toBe('not_found');
    expectApiHeaders(res);
  });

  test('想定外の例外は 500 の internal で、中身を応答に出さない', async () => {
    const app = createApp();
    app.get('/boom', () => {
      throw new Error('秘密の中身');
    });
    const res = await app.request('/api/boom', {}, env);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('秘密の中身');
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'internal error' } });
    expectApiHeaders(res);
  });
});
