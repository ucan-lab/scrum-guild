import { env, exports } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono/validator';
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
    // rollback の実地の試し（#20 の手順6）で版をずらしている。revert の PR で戻す
    expect(await res.json()).toEqual({ status: 'ok', version: 'dev-rollback-test' });
    expectApiHeaders(res);
  });

  test('存在しない /api/* は JSON の 404', async () => {
    const res = await exports.default.fetch('http://example.com/api/x');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(isErrorBody(body) && body.error.code).toBe('not_found');
    expectApiHeaders(res);
  });

  test('末尾にスラッシュの無い /api も JSON の 404', async () => {
    const res = await exports.default.fetch('http://example.com/api');
    expect(res.status).toBe(404);
    expect(isErrorBody(await res.json())).toBe(true);
    expectApiHeaders(res);
  });

  test('想定外の例外は 500 の internal で、中身を応答にもログにも出さない', async () => {
    const app = createApp();
    app.get('/boom/:token', () => {
      throw new Error('秘密の中身');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request('/api/boom/secret-token', {}, env);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('秘密の中身');
      expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'internal error' } });
      expectApiHeaders(res);

      const logged = error.mock.calls.flat().join('\n');
      expect(logged).toContain('/api/boom/:token');
      expect(logged).not.toContain('秘密の中身');
      expect(logged).not.toContain('secret-token');
    } finally {
      error.mockRestore();
    }
  });

  test.each([
    [400, 'invalid_input'],
    [403, 'forbidden'],
    [409, 'conflict'],
  ] as const)('HTTPException の %i は決まった code で返し、message は出さない', async (status, code) => {
    const app = createApp();
    app.get('/http', () => {
      throw new HTTPException(status, { message: '入力の中身' });
    });
    const res = await app.request('/api/http', {}, env);
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(text).not.toContain('入力の中身');
    expect(JSON.parse(text).error.code).toBe(code);
    expectApiHeaders(res);
  });

  test('バリデーターに渡した壊れた JSON の本文は 400 の invalid_input', async () => {
    const app = createApp();
    app.post(
      '/json',
      validator('json', (value) => value),
      (c) => c.json(c.req.valid('json')),
    );
    const res = await app.request(
      '/api/json',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{token=secret' },
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(isErrorBody(body) && body.error.code).toBe('invalid_input');
  });

  test('ヘッダーを書き換えられない応答にも API のヘッダーを付ける', async () => {
    const app = createApp();
    app.get('/immutable', () => Response.redirect('http://example.com/', 302));
    const res = await app.request('/api/immutable', {}, env);
    expect(res.status).toBe(302);
    expectApiHeaders(res);
  });
});
