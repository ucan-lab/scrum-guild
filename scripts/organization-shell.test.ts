// 組織の選択と組織の枠の、画面に依らない決まり（ログインの直後の行き先、ログインへの戻し方、メニューの出し分け）
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { landingFor } from '../src/lib/landing.ts';
import { isUnauthenticated, loginUrl } from '../src/lib/login-redirect.ts';
import { navSections, visibleNav } from '../src/lib/nav.ts';

const org = (slug: string) => ({ slug, name: slug });

describe('ログインの直後の行き先', () => {
  test('入れる組織が1つで招待が無ければ、その組織へ', () => {
    assert.deepEqual(landingFor({ organizations: [org('aoba')], invitations: [], operator: false }), {
      to: 'organization',
      slug: 'aoba',
    });
  });

  test('入れる組織が1つの運用者も、その組織へ', () => {
    assert.deepEqual(landingFor({ organizations: [org('aoba')], invitations: [], operator: true }), {
      to: 'organization',
      slug: 'aoba',
    });
  });

  test('入れる組織が2つ以上なら、組織の選択の画面', () => {
    assert.deepEqual(landingFor({ organizations: [org('aoba'), org('hibari')], invitations: [], operator: false }), {
      to: 'select',
    });
  });

  test('届いた招待があれば、入れる組織が1つでも組織の選択の画面', () => {
    assert.deepEqual(
      landingFor({ organizations: [org('aoba')], invitations: [{ organization_name: '青葉' }], operator: false }),
      { to: 'select' },
    );
  });

  test('入れる組織が無い運用者は運用の画面へ。招待が届いていれば選択の画面', () => {
    assert.deepEqual(landingFor({ organizations: [], invitations: [], operator: true }), { to: 'operator' });
    assert.deepEqual(landingFor({ organizations: [], invitations: [{ organization_name: '青葉' }], operator: true }), {
      to: 'select',
    });
  });

  test('入れる組織も運用者の印も無ければ、組織の選択の画面（空の状態）', () => {
    assert.deepEqual(landingFor({ organizations: [], invitations: [], operator: false }), { to: 'select' });
  });
});

describe('ログインへの戻し方', () => {
  test('今のパスとクエリを encodeURIComponent して return_to に入れる', () => {
    assert.equal(loginUrl({ pathname: '/aoba', search: '' }), '/login?return_to=%2Faoba');
    assert.equal(
      loginUrl({ pathname: '/aoba/w/019a', search: '?tab=a&b=日本語' }),
      `/login?return_to=${encodeURIComponent('/aoba/w/019a?tab=a&b=日本語')}`,
    );
  });

  test('401 の unauthenticated だけを未ログインとして扱う', () => {
    assert.equal(isUnauthenticated({ ok: false, error: { code: 'unauthenticated' } }), true);
    assert.equal(isUnauthenticated({ ok: false, error: { code: 'not_found' } }), false);
    assert.equal(isUnauthenticated({ ok: false, error: null }), false);
    assert.equal(isUnauthenticated({ ok: true }), false);
  });
});

describe('メニュー', () => {
  test('所属するワークスペースが無い人には、ワークスペースの中の見出しを出さない', () => {
    const withAll = navSections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item, href: '/[slug]' as const })),
    }));
    const headings = (hasWorkspace: boolean) => visibleNav(withAll, { hasWorkspace }).map((section) => section.heading);
    assert.deepEqual(headings(false), [undefined]);
    assert.deepEqual(headings(true), [undefined, 'workspace', 'groupRecords', 'groupManage']);
  });

  test('今ある項目は自分の今日だけ', () => {
    assert.deepEqual(
      visibleNav().flatMap((section) => section.items.map((item) => item.label)),
      ['pageToday'],
    );
  });
});
