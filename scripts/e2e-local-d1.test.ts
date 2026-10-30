import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { devPorts } from './dev-ports.ts';

// e2e/local-d1.ts の失敗の分岐を、fetch を差し替えて確かめる（ネットワークには出ない）。
// binding DB の ID を持つモジュールの変数をテストごとに切るため、クエリを付けてテストごとに新しく読み込む
// （node の ESM はクエリ違いを別のモジュールとして扱う）。import() の引数は lint の決まりで文字列のリテラルにするので、
// テストの数だけ並べる。テストを足したら、ここも足す
type LocalD1 = typeof import('../e2e/local-d1.ts');

const loaders: (() => Promise<unknown>)[] = [
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=1'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=2'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=3'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=4'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=5'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=6'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=7'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=8'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=9'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=10'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=11'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=12'),
  // @ts-expect-error クエリ付きの指定は型を引けない
  () => import('../e2e/local-d1.ts?case=13'),
];

let loadCount = 0;
async function loadLocalD1(): Promise<LocalD1> {
  const load = loaders[loadCount++];
  if (load === undefined) throw new Error('loaders が足りない。テストを足したら、import() の行も足す');
  return (await load()) as LocalD1;
}

const LIST_URL = `http://localhost:${devPorts(process.env).api}/cdn-cgi/local/explorer/api/d1/database`;
const DATABASE_UUID = '00000000-0000-4000-8000-000000000001';
const rawUrl = (uuid: string) => `${LIST_URL}/${uuid}/raw`;

type Call = { url: string; method: string; contentType?: string; body?: string; signal?: AbortSignal };
// text は JSON でない本文、error は fetch 自体の失敗（つながらない）
type Reply = { status?: number; body?: unknown; text?: string; error?: Error };

const json = ({ status = 200, body }: Reply) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const listOk: Reply = { body: { success: true, result: [{ name: 'DB', uuid: DATABASE_UUID }] } };
const rawOk: Reply = { body: { success: true, result: [] } };

const originalFetch = globalThis.fetch;
let calls: Call[];
// signal と本文は別のテストで見る。ほかは url と method だけで比べる
const urlsAndMethods = () => calls.map(({ url, method }) => ({ url, method }));

// 呼ばれた順に replies を返す。足りなくなったら落とす
function stubFetch(replies: Reply[]): void {
  const queue = [...replies];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    // 一覧の GET は method を渡さない（method は raw の POST だけ見る）。signal は両方に付く
    calls.push({ url: String(input), method: init?.method ?? 'GET', signal: init?.signal ?? undefined });
    const call = calls[calls.length - 1];
    if (call !== undefined && init?.method === 'POST') {
      call.contentType = headers.get('content-type') ?? undefined;
      call.body = String(init.body);
    }
    const reply = queue.shift();
    assert.ok(reply, `想定より多く fetch が呼ばれた: ${String(input)}`);
    if (reply.error !== undefined) throw reply.error;
    if (reply.text !== undefined) return new Response(reply.text, { status: reply.status ?? 200 });
    return json(reply);
  }) as typeof fetch;
}

describe('e2e/local-d1.ts の失敗の分岐', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    mock.restoreAll();
    globalThis.fetch = originalFetch;
  });

  test('404 のときは、エクスプローラーの案内を添えて落ちる', async () => {
    stubFetch([{ status: 404, body: {} }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(
      resetPasswordLoginRateLimits(),
      (err: Error) =>
        err.message.includes('HTTP 404') &&
        err.message.includes('エクスプローラーが無効か口が変わった') &&
        err.message.includes('X_LOCAL_EXPLORER'),
    );
    assert.deepEqual(urlsAndMethods(), [{ url: LIST_URL, method: 'GET' }]);
  });

  test('HTTP 500 のときは、errors の message を添えて落ちる（404 の案内は付けない）', async () => {
    stubFetch([listOk, { status: 500, body: { success: false, errors: [{ message: 'no such table: nope' }] } }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(
      resetPasswordLoginRateLimits(),
      (err: Error) =>
        err.message.includes('HTTP 500') &&
        err.message.includes('手元の D1 に SQL を流せなかった') &&
        err.message.includes('DELETE FROM rate_limits') &&
        err.message.includes('no such table: nope') &&
        !err.message.includes('X_LOCAL_EXPLORER'),
    );
  });

  test('HTTP 200 でも success が false なら、errors の message を添えて落ちる', async () => {
    stubFetch([listOk, { body: { success: false, errors: [{ message: 'first' }, {}] } }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(
      resetPasswordLoginRateLimits(),
      (err: Error) =>
        err.message.includes('success が true でない') &&
        err.message.includes('first / (message なし)') &&
        !err.message.includes('HTTP'),
    );
  });

  test('success が無い応答でも落ちる（message は付かない）', async () => {
    stubFetch([{ body: { result: [{ name: 'DB', uuid: DATABASE_UUID }] } }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(
      resetPasswordLoginRateLimits(),
      (err: Error) => err.message === '手元の D1 の一覧を引けなかった: success が true でない',
    );
  });

  test('一覧に binding DB が無いときは落ちる', async () => {
    stubFetch([{ body: { success: true, result: [{ name: 'OTHER', uuid: DATABASE_UUID }] } }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(resetPasswordLoginRateLimits(), /手元の D1 の一覧に binding DB が無い/);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['GET'],
    );
  });

  test('一覧の result が配列でないときも、binding DB が無いとして落ちる', async () => {
    stubFetch([{ body: { success: true, result: null } }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(resetPasswordLoginRateLimits(), /binding DB が無い/);
  });

  test('一覧が1回失敗しても、次の呼び出しで一覧を引き直して成功する', async () => {
    stubFetch([{ status: 500, body: { success: false, errors: [{ message: 'busy' }] } }, listOk, rawOk]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(resetPasswordLoginRateLimits(), /busy/);
    assert.deepEqual(urlsAndMethods(), [{ url: LIST_URL, method: 'GET' }]);

    await resetPasswordLoginRateLimits();
    assert.deepEqual(urlsAndMethods(), [
      { url: LIST_URL, method: 'GET' },
      { url: LIST_URL, method: 'GET' },
      { url: rawUrl(DATABASE_UUID), method: 'POST' },
    ]);
  });

  test('一覧が成功したら、次の呼び出しでは引き直さない', async () => {
    stubFetch([listOk, rawOk, rawOk]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await resetPasswordLoginRateLimits();
    await resetPasswordLoginRateLimits();
    assert.deepEqual(
      calls.map((call) => call.url),
      [LIST_URL, rawUrl(DATABASE_UUID), rawUrl(DATABASE_UUID)],
    );
  });

  test('一覧の DB の行に uuid が無いときは、無い ID へ POST せず落ちる', async () => {
    stubFetch([{ body: { success: true, result: [{ name: 'DB' }] } }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(resetPasswordLoginRateLimits(), /binding DB が無い/);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['GET'],
    );
  });

  test('fetch が失敗したら、つながらなかった旨と URL を添え、元のエラーを cause に持って落ちる', async () => {
    const cause = new TypeError('fetch failed');
    stubFetch([{ error: cause }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(
      resetPasswordLoginRateLimits(),
      (err: Error) =>
        err.message.includes('エクスプローラーにつながらなかった') &&
        err.message.includes(LIST_URL) &&
        err.cause === cause,
    );
  });

  test('本文が JSON でない非 2xx（プロキシの 502 など）でも、HTTP ステータスを添えて落ちる', async () => {
    stubFetch([{ status: 502, text: '<html>bad gateway</html>' }]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await assert.rejects(resetPasswordLoginRateLimits(), /HTTP 502/);
  });

  test('一覧に似た名前や別の binding が並んでも、名前が DB の行の uuid へ流す', async () => {
    const otherUuid = '00000000-0000-4000-8000-0000000000aa';
    stubFetch([
      {
        body: {
          success: true,
          result: [
            { name: 'DB_OLD', uuid: otherUuid },
            { name: 'DB', uuid: DATABASE_UUID },
            { name: 'OTHER', uuid: otherUuid },
          ],
        },
      },
      rawOk,
    ]);
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await resetPasswordLoginRateLimits();
    assert.equal(calls[1]?.url, rawUrl(DATABASE_UUID));
  });

  test('raw には 1つの batch を JSON で送り、どの呼び出しにも打ち切りの signal が付く', async () => {
    stubFetch([listOk, rawOk]);
    // 打ち切りの値は docs/development.md の「打ち切りは 20 秒」と同じであること
    const timeout = mock.method(AbortSignal, 'timeout');
    const { resetPasswordLoginRateLimits } = await loadLocalD1();
    await resetPasswordLoginRateLimits();
    assert.deepEqual(
      timeout.mock.calls.map((call) => call.arguments[0]),
      [20_000, 20_000],
    );
    const post = calls[1];
    assert.equal(post?.contentType, 'application/json');
    assert.deepEqual(JSON.parse(post?.body ?? 'null'), {
      batch: [{ sql: "DELETE FROM rate_limits WHERE key LIKE 'password%';" }],
    });
    assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  });
});
