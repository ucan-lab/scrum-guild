import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  collectScreens,
  COMMENT_MARKER,
  commentBody,
  compareScreens,
  EXCLUDED_SCREENS,
  fetchManifest,
  imageObjectKey,
  isScreenKey,
  loadBaseManifest,
  localFiles,
  mainUploads,
  manifestObjectKey,
  missingSettings,
  NAME_LIMIT,
  parseManifest,
  prUploads,
  MAX_IMAGE_BYTES,
  readScreenFiles,
  screenKey,
  screenTitle,
  shouldPost,
  shownScreens,
  unusedExclusions,
  UPLOAD_KEY,
  uploadLines,
  withoutExcluded,
  type Comparison,
  type Fetcher,
} from './evidence.ts';

const h = (c: string) => c.repeat(64);
const sha = (c: string) => c.repeat(40);
const k = (dir: string, n = 1) => `${dir}/evidence-${n}.png`;

describe('missingSettings', () => {
  const pr = {
    EVIDENCE_PR_R2_ACCESS_KEY_ID: 'true',
    EVIDENCE_PR_R2_SECRET_ACCESS_KEY: 'true',
    EVIDENCE_R2_ENDPOINT: 'https://0123.r2.cloudflarestorage.com',
    EVIDENCE_PR_BUCKET: 'scrum-guild-evidence-pr',
    EVIDENCE_PR_PUBLIC_URL: 'https://pub-pr.r2.dev',
    EVIDENCE_MAIN_PUBLIC_URL: 'https://pub-main.r2.dev',
  };
  const main = {
    EVIDENCE_MAIN_R2_ACCESS_KEY_ID: 'true',
    EVIDENCE_MAIN_R2_SECRET_ACCESS_KEY: 'true',
    EVIDENCE_R2_ENDPOINT: 'https://0123.r2.cloudflarestorage.com',
    EVIDENCE_MAIN_BUCKET: 'scrum-guild-evidence',
    EVIDENCE_MAIN_PUBLIC_URL: 'https://pub-main.r2.dev',
  };

  test('PR は PR 用の鍵と変数に、変更前の画像を読む main の公開の URL を足して見る', () => {
    assert.deepEqual(missingSettings(pr, 'pr'), []);
    assert.deepEqual(missingSettings({ ...pr, EVIDENCE_MAIN_PUBLIC_URL: '' }, 'pr'), ['EVIDENCE_MAIN_PUBLIC_URL']);
  });

  test('main は main 用の鍵と変数だけを見る。PR 用の鍵では足りない', () => {
    assert.deepEqual(missingSettings(main, 'main'), []);
    assert.deepEqual(missingSettings(pr, 'main'), [
      'EVIDENCE_MAIN_R2_ACCESS_KEY_ID',
      'EVIDENCE_MAIN_R2_SECRET_ACCESS_KEY',
      'EVIDENCE_MAIN_BUCKET',
    ]);
  });

  test('シークレットの有無が false か、変数が空白だけか無ければ、その名前を返す', () => {
    assert.deepEqual(
      missingSettings(
        { ...pr, EVIDENCE_PR_R2_ACCESS_KEY_ID: 'false', EVIDENCE_PR_BUCKET: ' ', EVIDENCE_PR_PUBLIC_URL: undefined },
        'pr',
      ),
      ['EVIDENCE_PR_R2_ACCESS_KEY_ID', 'EVIDENCE_PR_BUCKET', 'EVIDENCE_PR_PUBLIC_URL'],
    );
    assert.equal(missingSettings({}, 'pr').length, 6);
    assert.equal(missingSettings({}, 'main').length, 5);
  });
});

describe('screenKey', () => {
  test('テストのディレクトリと evidence の画像を画面の名前にする', () => {
    assert.deepEqual(screenKey(k('members-一覧-chromium')), { key: k('members-一覧-chromium'), attempt: 0 });
  });

  test('再試行の -retry<n> を外し、回数を返す', () => {
    assert.deepEqual(screenKey('members-一覧-chromium-retry2/evidence-1.png'), {
      key: k('members-一覧-chromium'),
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

  test('ディレクトリの名前に制御文字（改行、タブ）を含むものは画面に数えない', () => {
    assert.equal(screenKey('a\nb-chromium/evidence-1.png'), undefined);
    assert.equal(screenKey('a\tb-chromium/evidence-1.png'), undefined);
    assert.equal(screenKey('a\u0000b/evidence-1.png'), undefined);
  });

  test('isScreenKey は再試行を外した形だけを受け付ける', () => {
    assert.equal(isScreenKey(k('a-chromium')), true);
    assert.equal(isScreenKey('a-chromium-retry1/evidence-1.png'), false);
    assert.equal(isScreenKey('__proto__'), false);
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
    assert.deepEqual(screens, { [k('a-chromium')]: h('3'), [k('b-chromium')]: h('2') });
    assert.deepEqual(Object.keys(screens), [k('a-chromium'), k('b-chromium')]);
  });
});

describe('compareScreens', () => {
  test('変わった画面、新しい画面、無くなった画面に分け、同じ画面は出さない', () => {
    const result = compareScreens(
      { [k('same')]: h('1'), [k('changed')]: h('2'), [k('gone')]: h('3') },
      { [k('same')]: h('1'), [k('changed')]: h('4'), [k('new')]: h('5') },
      [],
    );
    assert.deepEqual(result, {
      changed: [{ key: k('changed'), before: h('2'), after: h('4') }],
      added: [{ key: k('new'), after: h('5') }],
      removed: [k('gone')],
      excluded: [],
    });
  });

  test('一覧の外から来た名前を、オブジェクトの持つ名前（constructor など）と取り違えない', () => {
    const result = compareScreens({}, { constructor: h('1'), toString: h('2') }, []);
    assert.deepEqual(
      result.added.map(({ key }) => key),
      ['constructor', 'toString'],
    );
    assert.deepEqual(result.changed, []);
  });

  test('外す一覧に当たる画面は、変わっていても比べずに理由を添えて分ける', () => {
    const result = compareScreens({ [k('shell-版-chromium')]: h('1') }, { [k('shell-版-chromium')]: h('2') }, [
      { pattern: /^shell-版-/, reason: '版の文字列が出る' },
    ]);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.excluded, [{ key: k('shell-版-chromium'), reason: '版の文字列が出る' }]);
  });

  test('外す一覧を渡さなければ EXCLUDED_SCREENS を使う', () => {
    const key = k(
      'workspace-close-管理者（あおば開発のミナト）-390px-の幅でも、操作の列は右端に固定されて見える-chromium',
    );
    const result = compareScreens({ [key]: h('1') }, { [key]: h('2') });
    assert.deepEqual(result.changed, []);
    assert.equal(result.excluded.length, 1);
    assert.equal(compareScreens({ [k('shell-x')]: h('1') }, { [k('shell-x')]: h('2') }).changed.length, 1);
  });

  test('外す一覧はディレクトリの名前だけに当て、画像のファイル名には当てない', () => {
    const result = compareScreens({ [k('a')]: h('1') }, { [k('a')]: h('2') }, [{ pattern: /evidence/, reason: 'x' }]);
    assert.equal(result.changed.length, 1);
  });
});

describe('EXCLUDED_SCREENS', () => {
  test('どの除外も1つのテストのディレクトリの名前の全体に当てる（describe の単位で外さない）', () => {
    for (const { pattern, reason } of EXCLUDED_SCREENS) {
      assert.match(pattern.source, /^\^.*chromium\$$/, pattern.source);
      assert.ok(reason.length > 0);
    }
    // 同じ describe のほかのテストには当たらない
    const sibling =
      'workspace-close-管理者（あおば開発のミナト）-確認のダイアログを経て終了し、帯と読み取り専用を確かめ、再開すると元に戻る-chromium';
    assert.equal(
      EXCLUDED_SCREENS.some(({ pattern }) => pattern.test(sibling)),
      false,
    );
  });

  test('withoutExcluded は外す画面を一覧から除く（main の一覧と上げる画像に入れない）', () => {
    const exclusions = [{ pattern: /^skip-chromium$/, reason: 'r' }];
    assert.deepEqual(withoutExcluded({ [k('skip-chromium')]: h('1'), [k('keep-chromium')]: h('2') }, exclusions), {
      [k('keep-chromium')]: h('2'),
    });
  });

  test('unusedExclusions はどの画面にも当たらない除外を返す', () => {
    const used = { pattern: /^a-chromium$/, reason: 'r' };
    const stale = { pattern: /^gone-chromium$/, reason: 'r' };
    assert.deepEqual(unusedExclusions([k('a-chromium'), k('b-chromium')], [used, stale]), [stale]);
  });
});

describe('上げる先の名前', () => {
  test('画像は中身のハッシュを名前にし、main 用は main/img/、PR 用は img/ に置く', () => {
    assert.equal(imageObjectKey('main', h('a')), `main/img/${h('a')}.png`);
    assert.equal(imageObjectKey('pr', h('b')), `img/${h('b')}.png`);
    assert.match(imageObjectKey('main', h('a')), UPLOAD_KEY);
    assert.match(imageObjectKey('pr', h('b')), UPLOAD_KEY);
  });

  test('ワークフローの送る段が使う形は、ほかの名前を通さない', () => {
    for (const bad of ['main/latest.json', `../img/${h('a')}.png`, `img/${h('a')}.png\nx`, `pr/img/${h('a')}.png`]) {
      assert.doesNotMatch(bad, UPLOAD_KEY);
    }
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
    const manifest = { sha: sha('a'), images: { [k('a-chromium')]: h('1') } };
    assert.deepEqual(parseManifest(manifest), manifest);
  });

  test('形が違えば undefined', () => {
    assert.equal(parseManifest(null), undefined);
    assert.equal(parseManifest([]), undefined);
    assert.equal(parseManifest({ sha: sha('a') }), undefined);
    assert.equal(parseManifest({ sha: sha('a'), images: [] }), undefined);
    assert.equal(parseManifest({ sha: sha('a'), images: { [k('a')]: 'x' } }), undefined);
  });

  test('SHA が 40 桁の16進でなければ一覧ごと無いものとして扱う', () => {
    assert.equal(parseManifest({ sha: 'latest', images: {} }), undefined);
    assert.equal(parseManifest({ sha: `${sha('a')}\n`, images: {} }), undefined);
  });

  test('画面の名前が screenKey の形でなければ一覧ごと無いものとして扱う', () => {
    for (const key of [
      '../x/evidence-1.png',
      'a\nb/evidence-1.png',
      'a/test-finished-1.png',
      'a-retry1/evidence-1.png',
    ]) {
      assert.equal(parseManifest({ sha: sha('a'), images: { [key]: h('1') } }), undefined, key);
    }
  });
});

describe('fetchManifest と loadBaseManifest', () => {
  const response = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  test('公開の URL の後ろに名前を付けて読み、時間切れの signal を渡す（末尾の / は1つにまとめる）', async () => {
    const calls: { url: string; signal: AbortSignal }[] = [];
    const manifest = { sha: sha('a'), images: {} };
    const result = await fetchManifest('https://evidence.example.test/', 'main/latest.json', async (url, init) => {
      calls.push({ url, signal: init.signal });
      return response(200, manifest);
    });
    assert.deepEqual(
      calls.map(({ url }) => url),
      ['https://evidence.example.test/main/latest.json'],
    );
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.deepEqual(result, manifest);
  });

  test('答えないと時間切れで投げる', async () => {
    const hang: Fetcher = (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    await assert.rejects(fetchManifest('https://x.test', 'main/latest.json', hang, 20));
  });

  test('404 なら undefined、ほかの失敗は投げる', async () => {
    assert.equal(await fetchManifest('https://x.test', 'main/latest.json', async () => response(404, null)), undefined);
    await assert.rejects(fetchManifest('https://x.test', 'main/latest.json', async () => response(500, null)));
  });

  test('ベースの一覧が無ければ main の最新を読む', async () => {
    const latest = { sha: sha('c'), images: {} };
    const urls: string[] = [];
    const result = await loadBaseManifest('https://m.test', sha('a'), async (url) => {
      urls.push(url);
      return url.endsWith('latest.json') ? response(200, latest) : response(404, null);
    });
    assert.deepEqual(result, { manifest: latest });
    assert.deepEqual(urls, [`https://m.test/main/${sha('a')}.json`, 'https://m.test/main/latest.json']);
  });

  test('404 のほかの失敗は投げずに理由を返す（ジョブを赤くしない）', async () => {
    const result = await loadBaseManifest('https://m.test', sha('a'), async () => response(503, null));
    assert.equal(result.manifest, undefined);
    assert.match(result.problem ?? '', /503/);
    const failed = await loadBaseManifest('https://m.test', sha('a'), async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    assert.match(failed.problem ?? '', /ENOTFOUND/);
  });

  test('どちらも無ければ一覧も理由も無い', async () => {
    assert.deepEqual(await loadBaseManifest('https://m.test', sha('a'), async () => response(404, null)), {});
  });
});

describe('上げる画像', () => {
  test('PR は、コメントに出す変更後の画像のうち、ベースの一覧に無いものだけを重ねずに上げる', () => {
    const base = { [k('a')]: h('1') };
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
    assert.equal(uploadLines([h('1')], 'pr', locals), `/r/a/evidence-1.png\timg/${h('1')}.png\n`);
    assert.equal(uploadLines([h('1')], 'main', locals), `/r/a/evidence-1.png\tmain/img/${h('1')}.png\n`);
    assert.throws(() => uploadLines([h('9')], 'pr', locals));
  });

  test('手元のパスに制御文字があれば、行が崩れるので投げる', () => {
    assert.throws(() => uploadLines([h('1')], 'pr', new Map([[h('1'), '/r/a\tb/evidence-1.png']])));
  });
});

describe('shownScreens と shouldPost', () => {
  const comparison = (part: Partial<Comparison>): Comparison => ({
    changed: [],
    added: [],
    removed: [],
    excluded: [],
    ...part,
  });

  test('変わった画面を先に、新しい画面を後に並べ、上限で切って残りを名前で返す', () => {
    const { shown, rest } = shownScreens(
      comparison({
        changed: [{ key: 'c1', before: h('1'), after: h('2') }],
        added: [
          { key: 'n1', after: h('3') },
          { key: 'n2', after: h('4') },
        ],
      }),
      2,
    );
    assert.deepEqual(
      shown.map(({ key }) => key),
      ['c1', 'n1'],
    );
    assert.deepEqual(rest, ['n2']);
  });

  test('変わった画面、新しい画面、無くなった画面のどれかがあれば付け、外した画面だけなら付けない', () => {
    assert.equal(shouldPost(comparison({}), true), false);
    assert.equal(shouldPost(comparison({ excluded: [{ key: 'x', reason: 'r' }] }), true), false);
    assert.equal(shouldPost(comparison({ removed: ['gone'] }), true), true);
    assert.equal(shouldPost(comparison({ added: [{ key: 'n', after: h('1') }] }), true), true);
    assert.equal(shouldPost(comparison({ changed: [{ key: 'c', before: h('1'), after: h('2') }] }), true), true);
  });

  test('比べられなかったときは、そのことを知らせるために付ける', () => {
    assert.equal(shouldPost(comparison({}), false), true);
  });
});

describe('screenTitle', () => {
  test('ディレクトリの名前をコードで出し、2枚目からは何枚目かを添える', () => {
    assert.equal(screenTitle(k('members-一覧-chromium')), '`members-一覧-chromium`');
    assert.equal(screenTitle(k('epic-狭い幅-chromium', 2)), '`epic-狭い幅-chromium`（2枚目）');
  });

  test('バッククォート、改行、制御文字を落とす（Markdown を崩さない）', () => {
    assert.equal(screenTitle(k('a`b\nc\r\td\u0007e')), '`abcde`');
  });
});

describe('commentBody', () => {
  const mainUrl = 'https://main.example.test';
  const prUrl = 'https://pr.example.test';
  const base = { [k('changed')]: h('1'), [k('gone')]: h('3') };
  const comparison = compareScreens(base, { [k('changed')]: h('2'), [k('new')]: h('1') }, []);
  const input = { base, mainUrl, prUrl, headSha: sha('b'), baseSha: sha('a'), comparedSha: sha('a') };

  test('目印で始め、変わった画面は変更前と変更後の2列、新しい画面は変更後だけで並べる', () => {
    const body = commentBody({ ...input, comparison, mainUrl: `${mainUrl}/`, prUrl: `${prUrl}//` });
    assert.ok(body.startsWith(`${COMMENT_MARKER}\n`));
    assert.match(body, /変わった画面 1、新しい画面 1、無くなった画面 1/);
    assert.ok(body.includes('### `changed`\n\n| 変更前 | 変更後 |'));
    // 変更前は main 用のバケット、ベースに無い変更後は PR 用のバケット、ベースにある画像と同じものは main 用を指す
    assert.ok(
      body.includes(
        `| <img src="${mainUrl}/main/img/${h('1')}.png" width="400"> | <img src="${prUrl}/img/${h('2')}.png" width="400"> |`,
      ),
    );
    assert.ok(
      body.includes(`### \`new\`（新しい画面）\n\n| 変更後 |\n| --- |\n| <img src="${mainUrl}/main/img/${h('1')}.png"`),
    );
    assert.match(body, /<summary>無くなった画面（1）<\/summary>\n\n- `gone`/);
    assert.doesNotMatch(body, /画像がまだ無い/);
  });

  test('e2e が撮るのは head をベースにマージした状態だと書く', () => {
    assert.match(
      commentBody({ ...input, comparison }),
      /bbbbbbb をベース（aaaaaaa）にマージした状態の e2e のスクリーンショット/,
    );
  });

  test('ベースの一覧が無く main の最新と比べたときは、そのことを書く', () => {
    const body = commentBody({ ...input, comparison, comparedSha: sha('c') });
    assert.match(body, /ベース（aaaaaaa）の画像がまだ無いので、main の最新（ccccccc）と比べた/);
  });

  test('変わった画面と新しい画面が無ければ、そのことを書く。無くなった画面だけでも一覧を出す', () => {
    const onlyRemoved = compareScreens(base, { [k('changed')]: h('1') }, []);
    const body = commentBody({ ...input, comparison: onlyRemoved });
    assert.match(body, /変わった画面と新しい画面は無い。/);
    assert.match(body, /<summary>無くなった画面（1）<\/summary>/);
    assert.doesNotMatch(body, /<img/);
  });

  test('上限を超えた画面は画像を出さずに名前だけを並べる', () => {
    const many = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [k(`s${i}`), createHash('sha256').update(`${i}`).digest('hex')]),
    );
    const body = commentBody({ ...input, comparison: compareScreens({}, many, []), base: {}, limit: 2 });
    assert.equal(body.match(/<img/g)?.length, 2);
    assert.match(body, /<summary>2 画面を超えて画像を出さなかった画面（1）<\/summary>\n\n- `s2`/);
  });

  test('名前だけの一覧は上限で切り、残りの数を書く（コメントの字数の上限を超えないため）', () => {
    const gone = Object.fromEntries(Array.from({ length: NAME_LIMIT + 2 }, (_, i) => [k(`g${i}`), h('1')]));
    const body = commentBody({ ...input, comparison: compareScreens(gone, {}, []), base: gone });
    assert.match(body, new RegExp(`<summary>無くなった画面（${NAME_LIMIT + 2}）</summary>`));
    assert.equal(body.match(/^- `g\d+`$/gm)?.length, NAME_LIMIT);
    assert.match(body, /^- ほか 2 画面$/m);
  });

  test('外した画面は理由を添えて並べ、名前の一覧の上限で切る', () => {
    const screens = Object.fromEntries(Array.from({ length: NAME_LIMIT + 3 }, (_, i) => [k(`x${i}`), h('1')]));
    const body = commentBody({
      ...input,
      comparison: compareScreens(screens, screens, [{ pattern: /^x\d+$/, reason: '版の文字列が出る' }]),
      base: screens,
    });
    assert.match(
      body,
      new RegExp(`<summary>比べる対象から外した画面（${NAME_LIMIT + 3}）</summary>\\n\\n- \`x0\`: 版の文字列が出る`),
    );
    assert.equal(body.match(/^- `x\d+`: /gm)?.length, NAME_LIMIT);
    assert.match(body, /^- ほか 3 画面$/m);
  });

  test('当たらない除外があれば、その正規表現を並べる', () => {
    const body = commentBody({ ...input, comparison, unused: [{ pattern: /^gone-chromium$/, reason: 'r' }] });
    assert.match(body, /どの画面にも当たらない除外が 1 件ある/);
    assert.match(body, /<summary>当たらない除外（1）<\/summary>\n\n- `\^gone-chromium\$`/);
  });

  test('比べる一覧がどれも無ければ、比べていないことと、main への push で用意されることを書く', () => {
    const body = commentBody({ ...input, comparison, base: {}, comparedSha: undefined });
    assert.match(body, /どちらの画像の一覧も無いので、bbbbbbb をベース（aaaaaaa）にマージした状態/);
    assert.doesNotMatch(body, /<img/);
  });

  test('一覧を読めなかったときは、その理由を書いて比べない', () => {
    const body = commentBody({
      ...input,
      comparison,
      base: {},
      comparedSha: undefined,
      problem: 'main/latest.json を読めない（503）',
    });
    assert.match(body, /変更前の画像の一覧を読めなかった（main\/latest.json を読めない（503））/);
    assert.doesNotMatch(body, /<img/);
  });
});

describe('目印', () => {
  test('ci.yml と pr-create の evidence.md は scripts/evidence.ts と同じ目印で探す', () => {
    for (const path of ['.github/workflows/ci.yml', '.claude/skills/pr-create/evidence.md']) {
      assert.ok(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').includes(COMMENT_MARKER), path);
    }
  });
});

// PNG のシグネチャで始まる中身（readScreenFiles は PNG でないファイルを読まない）
const png = (rest: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(rest)]);

describe('上げる先の名前の形', () => {
  test('ci.yml と evidence-main.yml の送る前の検査は、UPLOAD_KEY と同じ形を求める', () => {
    for (const [path, bucket, pattern] of [
      ['.github/workflows/ci.yml', 'pr', String.raw`^img/[0-9a-f]{64}\.png$`],
      ['.github/workflows/evidence-main.yml', 'main', String.raw`^main/img/[0-9a-f]{64}\.png$`],
    ] as const) {
      assert.ok(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').includes(pattern), path);
      const key = imageObjectKey(bucket, 'a'.repeat(64));
      assert.match(key, new RegExp(pattern));
      assert.match(key, UPLOAD_KEY);
    }
  });
});

describe('readScreenFiles', () => {
  test('PNG でないファイルと、上限より大きいファイルは読まない（公開のバケットに任意のファイルを上げさせない）', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-'));
    try {
      const files: [string, Buffer][] = [
        ['ok-chromium', png('ok')],
        ['html-chromium', Buffer.from('<html><script>alert(1)</script></html>')],
        ['big-chromium', Buffer.concat([png(''), Buffer.alloc(MAX_IMAGE_BYTES)])],
      ];
      for (const [dir, content] of files) {
        mkdirSync(join(root, 'e2e-1', 'test-results', dir), { recursive: true });
        writeFileSync(join(root, 'e2e-1', 'test-results', dir, 'evidence-1.png'), content);
      }
      assert.deepEqual(
        readScreenFiles(root).map(({ path }) => path),
        ['ok-chromium/evidence-1.png'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('成果物ごとの test-results/ の下の evidence の画像を読み、中身の SHA-256 を付ける', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-'));
    try {
      for (const [shard, dir, content] of [
        ['e2e-1', 'a-chromium', png('A')],
        ['e2e-2', 'b-chromium', png('B')],
      ] as const) {
        mkdirSync(join(root, shard, 'test-results', dir), { recursive: true });
        writeFileSync(join(root, shard, 'test-results', dir, 'evidence-1.png'), content);
        writeFileSync(join(root, shard, 'test-results', dir, 'test-failed-1.png'), 'F');
      }
      // playwright-report の画像は数えない
      mkdirSync(join(root, 'e2e-1', 'playwright-report', 'data'), { recursive: true });
      writeFileSync(join(root, 'e2e-1', 'playwright-report', 'data', 'x.png'), 'X');

      const files = readScreenFiles(root).sort((x, y) => (x.path < y.path ? -1 : 1));
      assert.deepEqual(
        files.map(({ path, hash }) => ({ path, hash })),
        [
          { path: 'a-chromium/evidence-1.png', hash: createHash('sha256').update(png('A')).digest('hex') },
          { path: 'b-chromium/evidence-1.png', hash: createHash('sha256').update(png('B')).digest('hex') },
        ],
      );
      assert.equal(files[0].local, join(root, 'e2e-1', 'test-results', 'a-chromium', 'evidence-1.png'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('名前に制御文字を含むテストのディレクトリは読まない', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-'));
    try {
      for (const dir of ['ok-chromium', 'bad\nname-chromium', 'tab\tname-chromium']) {
        mkdirSync(join(root, 'e2e-1', 'test-results', dir), { recursive: true });
        writeFileSync(join(root, 'e2e-1', 'test-results', dir, 'evidence-1.png'), png(dir));
      }
      assert.deepEqual(
        readScreenFiles(root).map(({ path }) => path),
        ['ok-chromium/evidence-1.png'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
