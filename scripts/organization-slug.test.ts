import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { reservedSlugs, slugProblem } from '../src/shared/organization-slug.ts';

describe('組織の slug', () => {
  test('画面の最上段のルート（src/routes/ の直下の固定のディレクトリ）は、すべて予約した名前に入っている', () => {
    const routes = readdirSync(new URL('../src/routes', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      // [slug] のような動的なルートは組織の URL そのもの
      .filter((entry) => !entry.name.startsWith('['))
      .map((entry) => entry.name);
    assert.ok(routes.length > 0, 'src/routes を読めなかった');
    for (const route of routes) {
      assert.ok(reservedSlugs.includes(route), `${route} は画面の最上段のルートなので、reservedSlugs に足す`);
      assert.equal(slugProblem(route), 'reserved', route);
    }
  });

  test('API の最上段（api）も予約した名前に入っている', () => {
    assert.equal(slugProblem('api'), 'reserved');
  });

  test('Cloudflare が Worker より先に受け取るパス（cdn-cgi）も予約した名前に入っている', () => {
    assert.equal(slugProblem('cdn-cgi'), 'reserved');
  });

  test('形は organizations.slug の CHECK と同じ（英小文字と数字で始まり、英小文字、数字、ハイフンで 2〜40 字）', () => {
    for (const ok of ['sakura-dev', 'a1', '9lives', 'a'.repeat(40), 'a-b-c'])
      assert.equal(slugProblem(ok), undefined, ok);
    for (const ng of ['', 'a', 'A1', 'sa_kura', '-sakura', 'a'.repeat(41), 'さくら', 'a b'])
      assert.equal(slugProblem(ng), 'format', ng);
  });
});
