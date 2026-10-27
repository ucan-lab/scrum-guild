// 画面の route.id の一覧（src/shared/route-ids.ts）が、src/routes の +page.svelte の置き場所と一致する（Issue #376）。
// src/shared の下は Worker の型（node の型なし）でも検査するので、ファイルを読むこのテストは src/lib に置く
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ROUTE_IDS } from '../shared/route-ids.ts';

const routesDir = fileURLToPath(new URL('../routes', import.meta.url));

// SvelteKit の route.id は、src/routes からのディレクトリの並び（先頭は /、根は '/'）
function pageRouteIds(dir: string): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) ids.push(...pageRouteIds(path));
    else if (entry.name === '+page.svelte') {
      const rel = relative(routesDir, dir).split(sep).join('/');
      ids.push(rel === '' ? '/' : `/${rel}`);
    }
  }
  return ids;
}

describe('ROUTE_IDS', () => {
  test('src/routes の +page.svelte の置き場所から作る route.id と、過不足なく一致する', () => {
    const actual = pageRouteIds(routesDir).sort();
    expect([...ROUTE_IDS].sort()).toEqual(actual);
  });

  test('今ある画面の route.id を含む', () => {
    for (const id of ['/', '/login', '/invite', '/[slug]', '/[slug]/w/[id]/plan', '/operator']) {
      expect(ROUTE_IDS).toContain(id);
    }
  });

  test('重複が無い', () => {
    expect(new Set(ROUTE_IDS).size).toBe(ROUTE_IDS.length);
  });
});
