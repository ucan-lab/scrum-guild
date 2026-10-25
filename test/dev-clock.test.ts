// 開発用の時計（DEV_NOW）。値の解釈と、now() が止まること、本番の設定で全リクエストが 500 になること
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { now, parseDevNow, setFixedNow } from '../src/shared/clock.ts';
import { createApp } from '../src/server/app.ts';

afterEach(() => {
  setFixedNow(undefined);
  vi.restoreAllMocks();
});

describe('parseDevNow', () => {
  test.each([
    ['2026-10-26T10:00:00+09:00', '2026-10-26T01:00:00.000Z'],
    ['2026-10-26T10:00:00Z', '2026-10-26T10:00:00.000Z'],
    ['2026-10-26T10:00:00.5-05:30', '2026-10-26T15:30:00.500Z'],
    ['2028-02-29T23:59:59+00:00', '2028-02-29T23:59:59.000Z'],
  ])('%s は解釈できる', (raw, iso) => {
    const parsed = parseDevNow(raw);
    expect(parsed.ok && parsed.at.toISOString()).toBe(iso);
  });

  test.each([
    '',
    '2026-10-26',
    // 時差が無い
    '2026-10-26T10:00:00',
    '2026-10-26 10:00:00+09:00',
    // 存在しない日時
    '2026-02-30T00:00:00Z',
    '2027-02-29T00:00:00Z',
    '2026-10-26T24:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-10-26T10:60:00Z',
    '2026-10-26T10:00:00+25:00',
    'あした',
    null,
    42,
  ])('%s は解釈できない', (raw) => {
    expect(parseDevNow(raw).ok).toBe(false);
  });
});

describe('now()', () => {
  test('値を渡すと、その時刻を返し続ける。undefined で本物の時計に戻る', async () => {
    const parsed = parseDevNow('2026-10-26T10:00:00+09:00');
    if (!parsed.ok) throw new Error('解釈できるはず');
    setFixedNow(parsed.at);
    const first = now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(now().toISOString()).toBe('2026-10-26T01:00:00.000Z');
    expect(now().getTime()).toBe(first.getTime());
    // 返した Date を書き換えても、止めた時刻は動かない
    first.setUTCFullYear(1999);
    expect(now().toISOString()).toBe('2026-10-26T01:00:00.000Z');

    setFixedNow(undefined);
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });
});

describe('DEV_NOW の守り', () => {
  const request = (vars: Record<string, unknown>) =>
    createApp().request('/api/health', {}, Object.assign({}, env, vars) as unknown as Env);

  test('ループバックへの http の公開 URL なら通り、now() が止まる', async () => {
    const res = await request({ PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: '2026-10-26T10:00:00+09:00' });
    expect(res.status).toBe(200);
    expect(now().toISOString()).toBe('2026-10-26T01:00:00.000Z');
  });

  test('DEV_NOW の無いリクエストは、前のリクエストが止めた時計を戻す', async () => {
    await request({ PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: '2026-10-26T10:00:00+09:00' });
    const res = await request({});
    expect(res.status).toBe(200);
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });

  test.each([
    'https://scrum-guild.ucan-lab.workers.dev',
    'https://localhost:8787',
    'http://localhost.evil.example',
    'http://192.168.0.10:8787',
  ])('本番の設定（%s）に DEV_NOW があると、すべてのリクエストを 500 にし、値は出さない', async (origin) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request({ PUBLIC_ORIGIN: origin, DEV_NOW: '2026-10-26T10:00:00+09:00' });
    // https の公開 URL は PUBLIC_ORIGIN の検査を通り、DEV_NOW の守りで止まる。それ以外は PUBLIC_ORIGIN の検査で止まる
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
    expect(error.mock.calls.flat().join('\n')).not.toContain('2026-10-26');
    // 止めた時計は残らない
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });

  test('https の公開 URL では、DEV_NOW の守りが理由として記録される', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request({
      PUBLIC_ORIGIN: 'https://scrum-guild.ucan-lab.workers.dev',
      DEV_NOW: '2026-10-26T10:00:00+09:00',
    });
    expect(res.status).toBe(500);
    expect(error.mock.calls.flat().join('\n')).toContain('DEV_NOW');
  });

  test.each(['', '2026-10-26T10:00:00', '2026-02-30T00:00:00Z', 'あした', 42])(
    '解釈できない値（%s）は、手元の設定でも 500 にする',
    async (value) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request({ PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: value });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
      expect(error.mock.calls.flat().join('\n')).toContain('DEV_NOW');
    },
  );
});
