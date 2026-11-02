// 閉じているメニューも HTML に残すので、svelte/server で項目と招待表示を確かめる。
// 開閉とキーボードの操作は e2e/account-menu.test.ts が確かめる。
import { render } from 'svelte/server';
import { beforeEach, expect, test, vi } from 'vitest';
import AccountMenu from './AccountMenu.svelte';

const { page } = vi.hoisted(() => ({ page: { url: new URL('http://localhost/aoba') } }));
vi.mock('$app/state', () => ({ page }));
vi.mock('$app/paths', () => ({
  resolve: (route: string, { slug }: { slug: string }) => route.replace('[slug]', slug),
}));

const props = { userId: 'user-1', name: 'ミナト', isAdmin: true, level: 3, slug: 'aoba', invitationCount: 0 };
const renderWith = (overrides: Partial<typeof props> = {}) =>
  render(AccountMenu, { props: { ...props, ...overrides } }).body;
const list = (html: string) => /<ul\b[^>]*>(.*?)<\/ul>/s.exec(html)![1]!;

beforeEach(() => {
  page.url = new URL('http://localhost/aoba');
});

test('管理者の項目はマイプロフィール、組織の管理、ログアウトの順で、現在の組織へのリンクになる', () => {
  const html = list(renderWith({ slug: 'sumire' }));
  expect(html).toMatch(/href="\/sumire\/me"/);
  expect(html).toMatch(/href="\/sumire\/admin"/);
  expect(html.indexOf('マイプロフィール')).toBeLessThan(html.indexOf('組織の管理'));
  expect(html.indexOf('組織の管理')).toBeLessThan(html.indexOf('ログアウト'));
  expect(html.match(/<li>/g)).toHaveLength(3);
});

test('一般のユーザーには組織の管理を描かない', () => {
  const html = list(renderWith({ isAdmin: false }));
  expect(html).toContain('マイプロフィール');
  expect(html).toContain('ログアウト');
  expect(html).not.toContain('組織の管理');
  expect(html).not.toContain('/aoba/admin');
  expect(html.match(/<li>/g)).toHaveLength(2);
});

test.each(['me', 'admin'])('%s を開いているときは、そのリンクだけに aria-current を付ける', (route) => {
  page.url = new URL(`http://localhost/aoba/${route}`);
  const html = list(renderWith());
  expect(html).toMatch(new RegExp(`<a href="/aoba/${route}" aria-current="page"`));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
});

test('ほかの画面では aria-current を付けない', () => {
  expect(list(renderWith())).not.toContain('aria-current');
});

test('招待があれば読み上げから外した点と件数を出し、項目に読み上げの文を添える。ボタンの名前は変えない', () => {
  const html = renderWith({ invitationCount: 2 });
  expect(html).toContain('class="account-menu-invite" aria-hidden="true"');
  expect(html).toContain('class="account-menu-badge" aria-hidden="true">招待 2');
  expect(html).toContain('class="visually-hidden">、届いた招待 2件');
  const buttonName = (body: string) => /<button\b[^>]*aria-label="([^"]*)"/.exec(body)![1];
  expect(buttonName(html)).toBe('ミナト（管理者）。アカウントのメニュー');
  expect(buttonName(html)).toBe(buttonName(renderWith()));
});

test('招待が0件なら点、件数、読み上げの文を描かない', () => {
  const html = renderWith();
  expect(html).not.toContain('account-menu-invite');
  expect(html).not.toContain('account-menu-badge');
  expect(html).not.toContain('届いた招待');
});
