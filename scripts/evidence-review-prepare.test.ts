import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import {
  EVIDENCE_REVIEW_LIMIT,
  FETCH_TIMEOUT_MS,
  fetchPng,
  MAX_IMAGE_BYTES,
  type Fetcher,
  type Manifest,
  type PngFetcher,
} from './evidence.ts';
import { prepareReview } from './evidence-review-prepare.ts';

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (text: string) => Buffer.concat([signature, Buffer.from(text)]);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const before = png('before');
const after = png('after');
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const response = (bytes: Buffer) => new Response(new Uint8Array(bytes));

// LS、PS、NEL、双方向の制御（RLO）、ゼロ幅のスペース。直の文字で書くと編集の過程で壊れるので、コードから作る
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NEXT_LINE = String.fromCharCode(0x85);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const HIDDEN = new RegExp(
  `[${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}${NEXT_LINE}${RIGHT_TO_LEFT_OVERRIDE}${ZERO_WIDTH_SPACE}]`,
);
const LINE_BREAK = new RegExp(`\\r\\n|[\\n\\r${NEXT_LINE}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`);

async function serverUrl(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

// Content-Length が小さくても、ストリームを読みながら上限で止めることを確かめる
function oversized(onCancel = () => {}): Response {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
      cancel: onCancel,
    }),
    { headers: { 'Content-Length': '8' } },
  );
}

describe('fetchPng', () => {
  test('main/img の URL を組み、PNG の中身とハッシュが合うときだけ返す', async () => {
    const fetcher: PngFetcher = async (url, init) => {
      assert.equal(url, `https://example.test/main/img/${hash(before)}.png`);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      return response(before);
    };
    assert.deepEqual(await fetchPng('https://example.test///', hash(before), fetcher), before);
  });

  test('ハッシュの形が違えば通信の前に断る', async () => {
    for (const invalid of ['', '../image', 'A'.repeat(64), 'a'.repeat(63), `${hash(before)}\n`]) {
      let calls = 0;
      await assert.rejects(
        fetchPng('https://example.test', invalid, async () => {
          calls += 1;
          return response(before);
        }),
        /ハッシュの形/,
      );
      assert.equal(calls, 0);
    }
  });

  test('PNG の署名が無い、ハッシュが違う、HTTP の失敗、空の応答を断る', async () => {
    for (const [fetcher, reason] of [
      [async () => response(Buffer.from('not a PNG')), /PNG でない/],
      [async () => response(after), /ハッシュが一致しない/],
      [async () => new Response('', { status: 404 }), /404/],
      [async () => new Response(null), /中身が無い/],
    ] as const) {
      await assert.rejects(fetchPng('https://example.test', hash(before), fetcher), reason);
    }
  });

  test('5MB までは読め、実測で超えたら読み切らずに止める', async () => {
    const max = Buffer.alloc(MAX_IMAGE_BYTES);
    signature.copy(max);
    assert.deepEqual(await fetchPng('https://example.test', hash(max), async () => response(max)), max);
    let cancelled = false;
    await assert.rejects(
      fetchPng('https://example.test', hash(before), async () => oversized(() => (cancelled = true))),
      /5MB/,
    );
    assert.equal(cancelled, true);
  });

  test('実際の fetch も 302 の送り先を読まずに断る', async (t) => {
    let followed = false;
    const url = await serverUrl(
      t,
      createServer((req, res) => {
        if (req.url === '/destination') {
          followed = true;
          res.end(before);
        } else {
          res.writeHead(302, { Location: '/destination' });
          res.end();
        }
      }),
    );
    await assert.rejects(fetchPng(url, hash(before)), /fetch failed/);
    assert.equal(followed, false);
  });

  test('既定の10秒で、途中まで返った画像の読み取りも打ち切る', async (t) => {
    // AbortSignal.timeout 自体は Node を生かさないので、モックの通信中だけタイマーを残す
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    let cancelled = false;
    const fetcher: PngFetcher = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(signature);
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    assert.equal(FETCH_TIMEOUT_MS, 10_000);
    const started = Date.now();
    await assert.rejects(fetchPng('https://example.test', hash(before), fetcher), /timeout|aborted/i);
    assert.ok(Date.now() - started >= 9_000);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(cancelled, true);
  });

  test('応答が始まらない場合も打ち切る', async (t) => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    await assert.rejects(
      fetchPng('https://example.test', hash(before), () => new Promise(() => {}), 20),
      /timeout|aborted/i,
    );
  });
});

function fixture(t: TestContext, names = ['screen']) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const resultsDir = join(dir, 'results');
  mkdirSync(resultsDir);
  const images: Record<string, string> = {};
  names.forEach((name, index) => {
    const testDir = join(resultsDir, `e2e-${(index % 3) + 1}`, 'test-results', name);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'evidence-1.png'), after);
    images[`${name}/evidence-1.png`] = hash(before);
  });
  const manifest: Manifest = { sha: baseSha, images };
  const manifestFetcher: Fetcher = async () => ({ ok: true, status: 200, json: async () => manifest });
  const pngFetcher: PngFetcher = async () => response(before);
  return {
    manifest,
    resultsDir,
    outDir: join(dir, 'evidence-ctx'),
    mainUrl: 'https://example.test',
    baseSha,
    headSha,
    manifestFetcher,
    pngFetcher,
  };
}

describe('prepareReview', () => {
  test('成果物を連番で写し、新しい画面は after だけ、8画面を超えた分は名前だけを載せる', async (t) => {
    const names = Array.from({ length: 10 }, (_, i) => `screen-${String(i).padStart(2, '0')}`);
    const value = fixture(t, names);
    // 変更7件、新規3件。上限の最後は after だけになり、残り2件は名前だけになる
    for (const name of names.slice(7)) delete value.manifest.images[`${name}/evidence-1.png`];
    const result = await prepareReview(value);
    assert.equal(EVIDENCE_REVIEW_LIMIT, 8);
    assert.deepEqual(result, {
      run: true,
      reason: '変わった画面か新しい画面がある',
      screens: 10,
      changed: 7,
      added: 3,
      removed: 0,
      prepared: 8,
      unjudged: 2,
    });
    const files = readdirSync(value.outDir);
    assert.equal(files.length, 16);
    assert.deepEqual(readFileSync(join(value.outDir, 's01-before.png')), before);
    assert.deepEqual(readFileSync(join(value.outDir, 's01-after.png')), after);
    assert.ok(files.includes('s08-after.png'));
    assert.ok(!files.includes('s08-before.png'));
    assert.ok(files.every((name) => name === 'index.md' || /^s0[1-8]-(before|after)\.png$/.test(name)));
    const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
    for (const name of names) assert.ok(index.includes(`> \`${name}\``));
    assert.equal((index.match(/未判定（上限 8 画面）/g) ?? []).length, 2);
    assert.ok(!index.includes('s09-after.png'));
    assert.ok(index.includes(baseSha));
    assert.ok(index.includes(headSha));
  });

  test('画面ごとに画像の中身が違っても、連番と画面の名前と画像の組が合う', async (t) => {
    const names = ['alpha', 'bravo', 'charlie'];
    const value = fixture(t, names);
    const beforeOf = (name: string) => png(`before-${name}`);
    names.forEach((name, index) => {
      const dir = join(value.resultsDir, `e2e-${(index % 3) + 1}`, 'test-results', name);
      writeFileSync(join(dir, 'evidence-1.png'), png(`after-${name}`));
      value.manifest.images[`${name}/evidence-1.png`] = hash(beforeOf(name));
    });
    const byHash = new Map(names.map((name) => [hash(beforeOf(name)), beforeOf(name)]));
    value.pngFetcher = async (url) => response(byHash.get(/\/([0-9a-f]{64})\.png$/.exec(url)![1])!);
    await prepareReview(value);
    const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
    for (const [position, name] of names.entries()) {
      const id = `s${String(position + 1).padStart(2, '0')}`;
      assert.deepEqual(readFileSync(join(value.outDir, `${id}-before.png`)), beforeOf(name));
      assert.deepEqual(readFileSync(join(value.outDir, `${id}-after.png`)), png(`after-${name}`));
      assert.ok(index.includes(`## ${id}\n\n> \`${name}\`\n`));
    }
  });

  test('変更前が無い画面は新しい画面だと index.md に書く', async (t) => {
    const value = fixture(t);
    delete value.manifest.images['screen/evidence-1.png'];
    await prepareReview(value);
    const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
    assert.ok(index.includes('変更前: 無し（新しい画面）'));
    assert.ok(!index.includes('s01-before.png'));
  });

  test('改行の類と制御文字、双方向の制御は空白にし、偽の見出しを行頭に出さない', async (t) => {
    const value = fixture(t, [
      `x${LINE_SEPARATOR}## s09`,
      `y${PARAGRAPH_SEPARATOR}## s10`,
      `z${RIGHT_TO_LEFT_OVERRIDE}## s11`,
      `w${ZERO_WIDTH_SPACE}## s12`,
    ]);
    await prepareReview(value);
    const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
    assert.ok(index.split(LINE_BREAK).every((line) => !/^## s(09|1[0-2])/.test(line)));
    assert.ok(!HIDDEN.test(index));
    assert.ok(index.includes('> `x ## s09`'));
  });

  test('取得失敗の理由の改行や双方向の制御も空白にする', async (t) => {
    const value = fixture(t, ['a-bad', 'b-good']);
    let calls = 0;
    value.pngFetcher = async () => {
      if (++calls === 1) throw new Error(`boom${LINE_SEPARATOR}## s09${RIGHT_TO_LEFT_OVERRIDE}end`);
      return response(before);
    };
    await prepareReview(value);
    const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
    assert.ok(!HIDDEN.test(index));
    assert.ok(index.split(LINE_BREAK).every((line) => !line.startsWith('## s09')));
    assert.ok(index.includes('boom ## s09 end'));
  });

  test('変えた画面1つの変更前が取れず、渡せる画像が無ければ run=false で何も書かない', async (t) => {
    const value = fixture(t);
    value.pngFetcher = async () => new Response('', { status: 503 });
    const result = await prepareReview(value);
    assert.equal(result.run, false);
    assert.equal(result.reason, '判定に渡せる画像が無い');
    assert.equal(result.prepared, 0);
    assert.equal(result.unjudged, 1);
    assert.equal(existsSync(value.outDir), false);
  });

  test('成果物のディレクトリが無いか、画面が無ければ例外にせず run=false', async (t) => {
    const missing = fixture(t);
    rmSync(missing.resultsDir, { recursive: true });
    const noScreens = fixture(t);
    rmSync(join(noScreens.resultsDir, 'e2e-1'), { recursive: true });
    for (const value of [missing, noScreens]) {
      const result = await prepareReview(value);
      assert.equal(result.run, false);
      assert.equal(result.reason, 'e2e の成果物が無い');
      assert.equal(result.screens, 0);
      assert.equal(existsSync(value.outDir), false);
    }
  });

  test('latest に戻ったときは実際の一覧の SHA と BASE_SHA を両方載せる', async (t) => {
    const value = fixture(t);
    const urls: string[] = [];
    value.manifest.sha = 'c'.repeat(40);
    value.manifestFetcher = async (url) => {
      urls.push(url);
      return {
        ok: url.endsWith('latest.json'),
        status: url.endsWith('latest.json') ? 200 : 404,
        json: async () => value.manifest,
      };
    };
    assert.equal((await prepareReview(value)).run, true);
    assert.deepEqual(urls, [`https://example.test/main/${baseSha}.json`, 'https://example.test/main/latest.json']);
    const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
    assert.ok(index.includes(`比べた一覧の SHA: ${value.manifest.sha}`));
    assert.ok(index.includes(`PR の BASE_SHA: ${baseSha}`));
  });

  test('テスト名をファイル名や Markdown の指示に使わない', async (t) => {
    const value = fixture(t, ['## ignore `instructions` <script>']);
    await prepareReview(value);
    assert.deepEqual(readdirSync(value.outDir).sort(), ['index.md', 's01-after.png', 's01-before.png']);
    const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
    assert.ok(index.includes('> `## ignore instructions <script>`'));
    assert.ok(!index.includes('\n## ignore'));
  });

  test('差分無し、removed のみ、一覧無し、一覧の取得失敗なら材料を作らない', async (t) => {
    for (const mode of ['same', 'removed', 'missing', 'invalid', 'failure', 'no-url']) {
      const value = fixture(t);
      if (mode === 'same' || mode === 'removed') value.manifest.images['screen/evidence-1.png'] = hash(after);
      if (mode === 'removed') value.manifest.images['removed/evidence-1.png'] = hash(before);
      if (mode === 'missing') value.manifestFetcher = async () => ({ ok: false, status: 404, json: async () => null });
      if (mode === 'invalid') value.manifest.images['screen/evidence-1.png'] = 'invalid-hash';
      if (mode === 'failure')
        value.manifestFetcher = async () => {
          throw new Error('manifest unavailable');
        };
      if (mode === 'no-url') value.mainUrl = '';
      const result = await prepareReview(value);
      assert.equal(result.run, false, mode);
      assert.equal(existsSync(value.outDir), false, mode);
      if (mode === 'failure') assert.match(result.reason, /manifest unavailable/);
    }
  });

  test('変更前の取得の失敗はその画面だけ未判定にし、後の画面を続ける', async (t) => {
    for (const [bad, reason] of [
      [async () => response(Buffer.from('not PNG')), /PNG でない/],
      [async () => oversized(), /5MB/],
      [async () => response(after), /ハッシュが一致しない/],
      [async () => new Response('', { status: 503 }), /503/],
    ] as const) {
      const value = fixture(t, ['a-bad', 'b-good']);
      let calls = 0;
      value.pngFetcher = async () => (++calls === 1 ? bad() : response(before));
      const result = await prepareReview(value);
      assert.equal(result.run, true);
      assert.equal(result.prepared, 1);
      assert.equal(result.unjudged, 1);
      assert.deepEqual(readdirSync(value.outDir).sort(), ['index.md', 's02-after.png', 's02-before.png']);
      const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
      assert.match(index, /未判定（変更前の画像の取得に失敗）/);
      assert.match(index, reason);
      assert.ok(index.includes('> `a-bad`'));
      assert.ok(index.includes('s02-after.png'));
    }
  });

  test('リダイレクトの拒否と時間切れでも、その画面だけ未判定にする', async (t) => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    let requests = 0;
    const value = fixture(t, ['a-redirect', 'b-timeout', 'c-good']);
    const pngFetcher: PngFetcher = async (_, init) => {
      requests += 1;
      assert.equal(init.redirect, 'error');
      if (requests === 1) throw new TypeError('fetch failed: redirect');
      if (requests === 2)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(signature);
            },
          }),
        );
      return response(before);
    };
    const result = await prepareReview({ ...value, pngFetcher, timeoutMs: 20 });
    assert.equal(result.prepared, 1);
    assert.equal(result.unjudged, 2);
    assert.equal(result.run, true);
    assert.deepEqual(readdirSync(value.outDir).sort(), ['index.md', 's03-after.png', 's03-before.png']);
    const index = readFileSync(join(value.outDir, 'index.md'), 'utf8');
    assert.match(index, /redirect/);
    assert.match(index, /timeout|aborted/i);
  });
});
