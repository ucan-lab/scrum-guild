// 自分の設定の「API トークン」の節（ApiTokensSetting.svelte）を svelte/server で HTML にして、初期の描画だけを確かめる。
// 入力の解釈（problem()）と発行・取消の流れはコンポーネントの中の状態で、純粋な関数に切れていないので、ここでは扱わない（e2e/api-tokens.test.ts）
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import { formatLocalDate } from '../format.ts';
import { dictionary } from '../../shared/vocabulary.ts';
import ApiTokensSetting from './ApiTokensSetting.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/aoba/me') } }));

const HASH = 'a'.repeat(63) + 'b';
const token = {
  id: HASH,
  name: '手元の端末',
  scope: 'write' as const,
  created_at: '2026-10-01T00:00:00.000Z',
  last_used_at: null as string | null,
  expires_at: '2026-12-31T12:00:00.000Z',
};

const renderWith = (initial: (typeof token)[] | null) => render(ApiTokensSetting, { props: { initial } }).body;

test('apiToken の辞書のキーは、スクラムの言葉の文言を持つ', () => {
  const keys = Object.keys(dictionary).filter((key) => key.startsWith('apiToken'));
  expect(keys.length).toBeGreaterThan(20);
  for (const key of keys) {
    const entry = (dictionary as Record<string, { scrum: string }>)[key]!;
    expect(entry.scrum.length, key).toBeGreaterThan(0);
  }
});

// 行のセル（td[data-label=…]）の文字だけを取り出す。範囲の選択肢の文字（発行の欄の「書き込み」）と取り違えないため
function cellText(body: string, label: string): string {
  const cell = new RegExp(`<td[^>]*data-label="${label}"[^>]*>(.*?)</td>`, 's').exec(body);
  expect(cell, `${label} のセル`).not.toBeNull();
  return cell![1]!
    .replace(/<!--.*?-->/gs, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

test('一覧の行の範囲のセルは、write なら書き込み、read なら読み取りを出す', () => {
  expect(cellText(renderWith([token]), '範囲')).toBe('書き込み');
  expect(cellText(renderWith([{ ...token, scope: 'read' as never }]), '範囲')).toBe('読み取り');
});

test('一覧の行は名前、範囲、期限、未使用を出し、ハッシュ（id）と生の値の接頭辞は HTML のどこにも出ない', () => {
  const body = renderWith([token]);
  expect(body).toContain('手元の端末');
  expect(cellText(body, '範囲')).toBe('書き込み');
  expect(cellText(body, '期限')).toBe(formatLocalDate(token.expires_at));
  expect(cellText(body, '最後に使った日')).toBe('未使用');
  expect(body).toContain(formatLocalDate(token.expires_at));
  expect(body).toContain('未使用');
  expect(body).toContain('aria-label="API トークン「手元の端末」を取り消す"');
  expect(body).not.toContain(HASH);
  expect(body).not.toContain('sgp_');
});

test('最後に使った日があれば未使用を出さず、日付を出す', () => {
  const body = renderWith([{ ...token, last_used_at: '2026-10-15T03:00:00.000Z' }]);
  expect(body).not.toContain('未使用');
  expect(body).toContain(formatLocalDate('2026-10-15T03:00:00.000Z'));
});

test('名前の HTML は文字として出し、タグとして解釈させない', () => {
  const body = renderWith([{ ...token, name: '<img src=x onerror=alert(1)>' }]);
  expect(body).not.toContain('<img src=x');
  expect(body).toContain('&lt;img src=x onerror=alert(1)>');
  // 属性（aria-label）の中でも引用符を破れない
  const quoted = renderWith([{ ...token, name: '" onfocus="alert(1)' }]);
  expect(quoted).not.toContain('" onfocus="alert(1)"');
});

test('一覧が空なら空の知らせ、読めなかった（null）なら失敗と再試行を出し、表は出さない', () => {
  const empty = renderWith([]);
  expect(empty).toContain('発行済みの API トークンはありません');
  expect(empty).not.toContain('<table');
  const failed = renderWith(null);
  expect(failed).toContain('API トークンを読み込めませんでした');
  expect(failed).toContain('もう一度試す');
  expect(failed).not.toContain('<table');
  expect(failed).not.toContain('発行済みの API トークンはありません');
});

test('発行の欄の初期値は、範囲が読み取り、有効日数が90で、発行直後のダイアログの中身（値）を持たない', () => {
  const body = renderWith([]);
  expect(body).toMatch(/<input[^>]*type="radio"[^>]*value="read"[^>]*checked|<input[^>]*checked[^>]*value="read"/);
  expect(body).toMatch(/type="number"[^>]*value="90"|value="90"[^>]*type="number"/);
  expect(body).toContain('max="90"');
  expect(body).not.toContain('二度と見られません');
  expect(body).not.toContain('sgp_');
});
