import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  collectScreens,
  COMMENT_MARKER,
  commentBody,
  compareScreens,
  fetchManifest,
  imageObjectKey,
  localFiles,
  mainUploads,
  manifestObjectKey,
  missingSettings,
  parseManifest,
  prUploads,
  readScreenFiles,
  screenKey,
  screenTitle,
  shownScreens,
  uploadLines,
  type Comparison,
} from './evidence.ts';

const h = (c: string) => c.repeat(64);
const sha = (c: string) => c.repeat(40);

describe('missingSettings', () => {
  const all = {
    EVIDENCE_R2_ACCESS_KEY_ID: 'true',
    EVIDENCE_R2_SECRET_ACCESS_KEY: 'true',
    EVIDENCE_R2_ENDPOINT: 'true',
    EVIDENCE_R2_BUCKET: 'scrum-guild-evidence',
    EVIDENCE_PUBLIC_URL: 'https://evidence.example.test',
  };

  test('すべてあれば空', () => {
    assert.deepEqual(missingSettings(all), []);
  });

  test('シークレットの有無が false か、変数が空か無ければ、その名前を返す', () => {
    assert.deepEqual(
      missingSettings({
        ...all,
        EVIDENCE_R2_ENDPOINT: 'false',
        EVIDENCE_R2_BUCKET: ' ',
        EVIDENCE_PUBLIC_URL: undefined,
      }),
      ['EVIDENCE_R2_ENDPOINT', 'EVIDENCE_R2_BUCKET', 'EVIDENCE_PUBLIC_URL'],
    );
    assert.equal(missingSettings({}).length, 5);
  });
});

describe('screenKey', () => {
  test('テストのディレクトリと evidence の画像を画面の名前にする', () => {
    assert.deepEqual(screenKey('members-一覧-chromium/evidence-1.png'), {
      key: 'members-一覧-chromium/evidence-1.png',
      attempt: 0,
    });
  });

  test('再試行の -retry<n> を外し、回数を返す', () => {
    assert.deepEqual(screenKey('members-一覧-chromium-retry2/evidence-1.png'), {
      key: 'members-一覧-chromium/evidence-1.png',
      attempt: 2,
    });
  });

  test('evidence 以外の画像（Playwright の失敗と終わりの画像）と、深さの違うものは画面に数えない', () => {
    assert.equal(screenKey('members-一覧-chromium/test-failed-1.png'), undefined);
    assert.equal(screenKey('members-一覧-chromium/test-finished-1.png'), undefined);
    assert.equal(screenKey('members-一覧-chromium/trace.zip'), undefined);
    assert.equal(screenKey('evidence-1.png'), undefined);
    assert.equal(screenKey('a/b/evidence-1.png'), undefined);
  });
});

describe('collectScreens', () => {
  test('再試行があれば最後の試行の画像を使い、名前の順に並べる', () => {
    const screens = collectScreens([
      { path: 'b-chromium-retry1/evidence-1.png', hash: h('2') },
      { path: 'b-chromium/evidence-1.png', hash: h('1') },
      { path: 'a-chromium/evidence-1.png', hash: h('3') },
      { path: 'a-chromium/test-failed-1.png', hash: h('4') },
    ]);
    assert.deepEqual(screens, {
      'a-chromium/evidence-1.png': h('3'),
      'b-chromium/evidence-1.png': h('2'),
    });
    assert.deepEqual(Object.keys(screens), ['a-chromium/evidence-1.png', 'b-chromium/evidence-1.png']);
  });
});

describe('compareScreens', () => {
  test('変わった画面、新しい画面、無くなった画面に分け、同じ画面は出さない', () => {
    const result = compareScreens(
      { 'same/evidence-1.png': h('1'), 'changed/evidence-1.png': h('2'), 'gone/evidence-1.png': h('3') },
      { 'same/evidence-1.png': h('1'), 'changed/evidence-1.png': h('4'), 'new/evidence-1.png': h('5') },
      [],
    );
    assert.deepEqual(result, {
      changed: [{ key: 'changed/evidence-1.png', before: h('2'), after: h('4') }],
      added: [{ key: 'new/evidence-1.png', after: h('5') }],
      removed: ['gone/evidence-1.png'],
      excluded: [],
    });
  });

  test('外す一覧に当たる画面は、変わっていても比べずに理由を添えて分ける', () => {
    const result = compareScreens(
      { 'shell-版-chromium/evidence-1.png': h('1') },
      { 'shell-版-chromium/evidence-1.png': h('2') },
      [{ pattern: /^shell-版-/, reason: '版の文字列が出る' }],
    );
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.excluded, [{ key: 'shell-版-chromium/evidence-1.png', reason: '版の文字列が出る' }]);
  });

  test('外す一覧を渡さなければ EXCLUDED_SCREENS を使う', () => {
    const key = 'workspace-close-管理者（あおば開発のミナト）-390px-の幅でも-chromium/evidence-1.png';
    const result = compareScreens({ [key]: h('1') }, { [key]: h('2') });
    assert.deepEqual(result.changed, []);
    assert.equal(result.excluded.length, 1);
    assert.equal(
      compareScreens({ 'shell-x/evidence-1.png': h('1') }, { 'shell-x/evidence-1.png': h('2') }).changed.length,
      1,
    );
  });

  test('外す一覧はディレクトリの名前だけに当て、画像のファイル名には当てない', () => {
    const result = compareScreens({ 'a/evidence-1.png': h('1') }, { 'a/evidence-1.png': h('2') }, [
      { pattern: /finished/, reason: 'x' },
    ]);
    assert.equal(result.changed.length, 1);
  });
});

describe('上げる先の名前', () => {
  test('画像は中身のハッシュを名前にし、main と pr で前置きを分ける', () => {
    assert.equal(imageObjectKey('main', h('a')), `main/img/${h('a')}.png`);
    assert.equal(imageObjectKey('pr', h('b')), `pr/img/${h('b')}.png`);
  });

  test('ハッシュの形が違えば投げる（パスを含む名前で別の場所に上げないため）', () => {
    assert.throws(() => imageObjectKey('pr', '../main/latest'));
    assert.throws(() => imageObjectKey('pr', h('A')));
  });

  test('一覧はコミットの SHA を名前にする', () => {
    assert.equal(manifestObjectKey(sha('c')), `main/${sha('c')}.json`);
    assert.throws(() => manifestObjectKey('latest'));
  });
});

describe('parseManifest', () => {
  test('形の合う一覧を返す', () => {
    const manifest = { sha: sha('a'), images: { 'a/evidence-1.png': h('1') } };
    assert.deepEqual(parseManifest(manifest), manifest);
  });

  test('形が違えば undefined', () => {
    assert.equal(parseManifest(null), undefined);
    assert.equal(parseManifest({ sha: sha('a') }), undefined);
    assert.equal(parseManifest({ sha: sha('a'), images: { a: 'x' } }), undefined);
  });
});

describe('fetchManifest', () => {
  const response = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  test('公開の URL の後ろに名前を付けて読む（末尾の / は1つにまとめる）', async () => {
    const urls: string[] = [];
    const manifest = { sha: sha('a'), images: {} };
    const result = await fetchManifest('https://evidence.example.test/', 'main/latest.json', async (url) => {
      urls.push(url);
      return response(200, manifest);
    });
    assert.deepEqual(urls, ['https://evidence.example.test/main/latest.json']);
    assert.deepEqual(result, manifest);
  });

  test('404 なら undefined、ほかの失敗は投げる', async () => {
    assert.equal(await fetchManifest('https://x.test', 'main/latest.json', async () => response(404, null)), undefined);
    await assert.rejects(fetchManifest('https://x.test', 'main/latest.json', async () => response(500, null)));
  });
});

describe('上げる画像', () => {
  test('PR は、コメントに出す変更後の画像のうち、ベースの一覧に無いものだけを重ねずに上げる', () => {
    const base = { 'a/evidence-1.png': h('1') };
    const shown = [{ after: h('1') }, { after: h('2') }, { after: h('2') }];
    assert.deepEqual(prUploads(shown, base), [h('2')]);
  });

  test('main は、前の main の一覧に無いハッシュだけを上げる。前が無ければすべて', () => {
    const head = { a: h('1'), b: h('2'), c: h('2') };
    assert.deepEqual(mainUploads(head, { x: h('1') }), [h('2')]);
    assert.deepEqual(mainUploads(head, undefined), [h('1'), h('2')]);
  });

  test('上げる一覧を、手元のパスと上げる先の名前のタブ区切りの行にする', () => {
    const locals = localFiles([
      { local: '/r/a/evidence-1.png', hash: h('1') },
      { local: '/r/b/evidence-1.png', hash: h('1') },
    ]);
    assert.equal(uploadLines([h('1')], 'pr', locals), `/r/a/evidence-1.png\tpr/img/${h('1')}.png\n`);
    assert.throws(() => uploadLines([h('9')], 'pr', locals));
  });
});

describe('shownScreens', () => {
  test('変わった画面を先に、新しい画面を後に並べ、上限で切って残りを名前で返す', () => {
    const comparison: Comparison = {
      changed: [{ key: 'c1', before: h('1'), after: h('2') }],
      added: [
        { key: 'n1', after: h('3') },
        { key: 'n2', after: h('4') },
      ],
      removed: [],
      excluded: [],
    };
    const { shown, rest } = shownScreens(comparison, 2);
    assert.deepEqual(
      shown.map(({ key }) => key),
      ['c1', 'n1'],
    );
    assert.deepEqual(rest, ['n2']);
  });
});

describe('screenTitle', () => {
  test('ディレクトリの名前をコードで出し、2枚目からは何枚目かを添える', () => {
    assert.equal(screenTitle('members-一覧-chromium/evidence-1.png'), '`members-一覧-chromium`');
    assert.equal(screenTitle('epic-狭い幅-chromium/evidence-2.png'), '`epic-狭い幅-chromium`（2枚目）');
  });
});

describe('commentBody', () => {
  const url = 'https://evidence.example.test';
  const base = { 'changed/evidence-1.png': h('1'), 'gone/evidence-1.png': h('3') };
  const comparison = compareScreens(base, { 'changed/evidence-1.png': h('2'), 'new/evidence-1.png': h('1') }, []);

  test('目印で始め、変わった画面は変更前と変更後の2列、新しい画面は変更後だけで並べる', () => {
    const body = commentBody({
      comparison,
      base,
      publicUrl: `${url}/`,
      headSha: sha('b'),
      baseSha: sha('a'),
      comparedSha: sha('a'),
    });
    assert.ok(body.startsWith(`${COMMENT_MARKER}\n`));
    assert.match(body, /変わった画面 1、新しい画面 1、無くなった画面 1/);
    assert.ok(body.includes('### `changed`\n\n| 変更前 | 変更後 |'));
    // 変更前は main、ベースに無い変更後は pr、ベースにある画像と同じものは main を指す
    assert.ok(
      body.includes(
        `| <img src="${url}/main/img/${h('1')}.png" width="400"> | <img src="${url}/pr/img/${h('2')}.png" width="400"> |`,
      ),
    );
    assert.ok(
      body.includes(`### \`new\`（新しい画面）\n\n| 変更後 |\n| --- |\n| <img src="${url}/main/img/${h('1')}.png"`),
    );
    assert.match(body, /<summary>無くなった画面（1）<\/summary>\n\n- `gone`/);
    assert.doesNotMatch(body, /ベース（aaaaaaa）の画像がまだ無い/);
  });

  test('ベースの一覧が無く main の最新と比べたときは、そのことを書く', () => {
    const body = commentBody({
      comparison,
      base,
      publicUrl: url,
      headSha: sha('b'),
      baseSha: sha('a'),
      comparedSha: sha('c'),
    });
    assert.match(body, /ベース（aaaaaaa）の画像がまだ無いので、main の最新（ccccccc）と比べた/);
  });

  test('変わった画面が無ければ、そのことだけを書く', () => {
    const body = commentBody({
      comparison: compareScreens(base, base, []),
      base,
      publicUrl: url,
      headSha: sha('b'),
      baseSha: sha('a'),
      comparedSha: sha('a'),
    });
    assert.match(body, /変わった画面は無い。/);
    assert.doesNotMatch(body, /<img/);
  });

  test('上限を超えた画面は画像を出さずに名前だけを並べる', () => {
    const many = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`s${i}/evidence-1.png`, createHash('sha256').update(`${i}`).digest('hex')]),
    );
    const body = commentBody({
      comparison: compareScreens({}, many, []),
      base: {},
      publicUrl: url,
      headSha: sha('b'),
      baseSha: sha('a'),
      comparedSha: sha('a'),
      limit: 2,
    });
    assert.equal(body.match(/<img/g)?.length, 2);
    assert.match(body, /<summary>2 画面を超えて画像を出さなかった画面（1）<\/summary>\n\n- `s2`/);
  });

  test('名前だけの一覧は上限で切り、残りの数を書く（コメントの字数の上限を超えないため）', () => {
    const gone = Object.fromEntries(Array.from({ length: 102 }, (_, i) => [`g${i}/evidence-1.png`, h('1')]));
    const body = commentBody({
      comparison: compareScreens(gone, {}, []),
      base: gone,
      publicUrl: url,
      headSha: sha('b'),
      baseSha: sha('a'),
      comparedSha: sha('a'),
    });
    assert.match(body, /<summary>無くなった画面（102）<\/summary>/);
    assert.equal(body.match(/^- `g\d+`$/gm)?.length, 100);
    assert.match(body, /^- ほか 2 画面$/m);
  });

  test('外した画面は理由を添えて並べる', () => {
    const body = commentBody({
      comparison: compareScreens(base, { ...base, 'changed/evidence-1.png': h('2') }, [
        { pattern: /^changed$/, reason: '版の文字列が出る' },
      ]),
      base,
      publicUrl: url,
      headSha: sha('b'),
      baseSha: sha('a'),
      comparedSha: sha('a'),
    });
    assert.match(body, /<summary>比べる対象から外した画面（1）<\/summary>\n\n- `changed`: 版の文字列が出る/);
    assert.match(body, /変わった画面は無い。/);
  });

  test('比べる一覧がどれも無ければ、比べていないことと、main への push で用意されることを書く', () => {
    const body = commentBody({
      comparison,
      base: {},
      publicUrl: url,
      headSha: sha('b'),
      baseSha: sha('a'),
      comparedSha: undefined,
    });
    assert.match(body, /どちらの画像の一覧も無いので、bbbbbbb の画面を比べていない/);
    assert.doesNotMatch(body, /<img/);
  });
});

describe('readScreenFiles', () => {
  test('成果物ごとの test-results/ の下の PNG を読み、中身の SHA-256 を付ける', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-'));
    try {
      for (const [shard, dir, content] of [
        ['e2e-1', 'a-chromium', 'A'],
        ['e2e-2', 'b-chromium', 'B'],
      ]) {
        mkdirSync(join(root, shard, 'test-results', dir), { recursive: true });
        writeFileSync(join(root, shard, 'test-results', dir, 'evidence-1.png'), content);
      }
      // playwright-report の画像は数えない
      mkdirSync(join(root, 'e2e-1', 'playwright-report', 'data'), { recursive: true });
      writeFileSync(join(root, 'e2e-1', 'playwright-report', 'data', 'x.png'), 'X');

      const files = readScreenFiles(root).sort((x, y) => (x.path < y.path ? -1 : 1));
      assert.deepEqual(
        files.map(({ path, hash }) => ({ path, hash })),
        [
          { path: 'a-chromium/evidence-1.png', hash: createHash('sha256').update('A').digest('hex') },
          { path: 'b-chromium/evidence-1.png', hash: createHash('sha256').update('B').digest('hex') },
        ],
      );
      assert.equal(files[0].local, join(root, 'e2e-1', 'test-results', 'a-chromium', 'evidence-1.png'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
