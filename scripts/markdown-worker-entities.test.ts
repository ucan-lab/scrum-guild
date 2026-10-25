import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { markdownWorkerEntities } from './markdown-worker-entities.ts';

// プラグインの文脈の resolve を、Vite が解決した結果を返す偽物にする
type ResolveId = (
  this: { resolve: () => Promise<{ id: string } | null> },
  source: string,
  importer: string,
  options: object,
) => Promise<{ id: string } | null | undefined>;
const resolveId = markdownWorkerEntities().resolveId as unknown as ResolveId;
const resolveTo = (id: string | null) => ({ resolve: async () => (id === null ? null : { id }) });

describe('markdownWorkerEntities', () => {
  test('decode-named-character-reference の DOM 版を、DOM を使わない index.js にする', async () => {
    const dir =
      '/repo/node_modules/.pnpm/decode-named-character-reference@1.0.0/node_modules/decode-named-character-reference';
    const resolved = await resolveId.call(
      resolveTo(`${dir}/index.dom.js`),
      'decode-named-character-reference',
      '/x.js',
      {},
    );
    assert.equal(resolved?.id, `${dir}/index.js`);
  });

  test('すでに index.js に解決されていれば、そのまま返す', async () => {
    const resolved = await resolveId.call(resolveTo('/d/index.js'), 'decode-named-character-reference', '/x.js', {});
    assert.equal(resolved?.id, '/d/index.js');
  });

  test('ほかのパッケージには触らない', async () => {
    assert.equal(await resolveId.call(resolveTo('/d/index.dom.js'), 'micromark', '/x.js', {}), null);
  });
});
