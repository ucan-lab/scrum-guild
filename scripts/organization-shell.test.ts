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
    // 実際の URL（url.pathname と url.search）は、ASCII 以外が符号化済みで渡る
    const url = new URL('https://scrum-guild.example/aoba/w/019a?tab=a&b=日本語');
    assert.equal(url.search, '?tab=a&b=%E6%97%A5%E6%9C%AC%E8%AA%9E');
    assert.equal(
      loginUrl(url),
      `/login?return_to=${encodeURIComponent('/aoba/w/019a?tab=a&b=%E6%97%A5%E6%9C%AC%E8%AA%9E')}`,
    );
    assert.equal(
      loginUrl(new URL('https://scrum-guild.example/%E3%81%82%E3%81%8A%E3%81%B0')),
      `/login?return_to=${encodeURIComponent('/%E3%81%82%E3%81%8A%E3%81%B0')}`,
    );
  });

  test('return_to の検査は、ログインの後に戻す側と同じ関数（src/shared/return-to.ts）で、作る側でも外へ向けた値を作らない', () => {
    // 符号化していない ASCII 以外は、DB の CHECK も通らないので / に落とす
    assert.equal(loginUrl({ pathname: '/あおば', search: '' }), '/login?return_to=%2F');
    assert.equal(loginUrl({ pathname: '/.//evil.example', search: '' }), '/login?return_to=%2F');
    assert.equal(loginUrl({ pathname: '/a/../b', search: '' }), '/login?return_to=%2F');
    // ログインの画面と API へは戻さない
    assert.equal(loginUrl({ pathname: '/login', search: '?return_to=%2Faoba' }), '/login?return_to=%2F');
    assert.equal(loginUrl({ pathname: '/%61pi/x', search: '' }), '/login?return_to=%2F');
  });

  test('別のオリジンへ向く形（// と /\\ で始まるパス）は、作る側でも / に落とす', () => {
    assert.equal(loginUrl({ pathname: '//evil.example', search: '' }), '/login?return_to=%2F');
    assert.equal(loginUrl({ pathname: '/\\evil.example', search: '' }), '/login?return_to=%2F');
    assert.equal(loginUrl({ pathname: '//evil.example/path', search: '?a=1' }), '/login?return_to=%2F');
    assert.equal(loginUrl({ pathname: 'aoba', search: '' }), '/login?return_to=%2F');
    // 普通のパスは変えない
    assert.equal(loginUrl({ pathname: '/aoba//x', search: '' }), `/login?return_to=${encodeURIComponent('/aoba//x')}`);
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

  test('行き先の無い（href が null の）項目と、項目の無い見出しは出さない', () => {
    const shown = visibleNav(undefined, { isAdmin: true });
    const withDestination = navSections.flatMap((section) => section.items).filter((item) => item.href !== null);
    assert.equal(shown.flatMap((section) => section.items).length, withDestination.length);
    for (const section of shown) {
      assert.ok(section.items.length > 0, `項目の無い見出し: ${section.heading}`);
      for (const item of section.items) assert.notEqual(item.href, null);
    }
  });

  test('組織の管理は管理者にだけ出し、一般のユーザーには出さない', () => {
    const labels = (isAdmin: boolean) =>
      visibleNav(undefined, { isAdmin }).flatMap((section) => section.items.map((item) => item.label));
    assert.ok(labels(true).includes('pageOrgAdmin'));
    assert.ok(!labels(false).includes('pageOrgAdmin'));
    const admin = navSections.flatMap((section) => section.items).find((item) => item.label === 'pageOrgAdmin');
    assert.equal(admin?.href, '/[slug]/admin');
  });

  test('ワークスペースの画面を開いている間は、所属が無くても、項目の無いワークスペースの節の見出しを出す', () => {
    const headings = (options: Parameters<typeof visibleNav>[1]) =>
      visibleNav(undefined, options).map((section) => section.heading);
    // 画面の無い項目だけの節は、ふだんは出ない
    assert.deepEqual(headings({ hasWorkspace: true, isAdmin: true }), [undefined]);
    assert.deepEqual(headings({ hasWorkspace: false, isAdmin: true }), [undefined]);
    // 所属の無い管理者がワークスペースの画面を開く。切り替えの置き場所を持つ節だけが、項目が無くても残る
    assert.deepEqual(headings({ hasWorkspace: false, isAdmin: true, inWorkspaceScreen: true }), [
      undefined,
      'workspace',
    ]);
    const workspaceSection = visibleNav(undefined, { hasWorkspace: false, inWorkspaceScreen: true }).find(
      (section) => section.slot === 'workspace',
    );
    assert.deepEqual(workspaceSection?.items, []);
  });
});
