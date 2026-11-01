// 自分の設定の load（routes/[slug]/me/+page.ts）が、API トークンの一覧と届いた招待を経験値の2つと並べて読み、
// 読めなかったものだけを null にし、401 ならログインへ移すことを、fetch を差し替えて確かめる
import { expect, test } from 'vitest';
import { load } from '../routes/[slug]/me/+page.ts';
import { operationPath } from '../shared/operations/define.ts';
import { experienceGrants, experienceSummary } from '../shared/operations/experience/index.ts';
import { tokenList } from '../shared/operations/session/index.ts';
import { invitationList } from '../shared/operations/workspace/index.ts';

type Reply = { status: number; body: unknown };

function fetcher(replies: Record<string, Reply>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fake = (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    calls.push(path);
    const reply = replies[path] ?? { status: 500, body: 'no reply' };
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  };
  return { fetch: fake as typeof fetch, calls };
}

const summaryPath = operationPath(experienceSummary, 'aoba');
const grantsPath = operationPath(experienceGrants, 'aoba');
const tokenPath = operationPath(tokenList);
const invitationPath = operationPath(invitationList, 'aoba');
const unauthenticated: Reply = { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } };

async function run(replies: Record<string, Reply>) {
  const { fetch: fake, calls } = fetcher(replies);
  const url = new URL('http://localhost/aoba/me?tab=x');
  const event = { params: { slug: 'aoba' }, fetch: fake, url } as unknown as Parameters<typeof load>[0];
  return { result: await (load as (e: typeof event) => Promise<unknown>)(event), calls };
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const tokens = { tokens: [{ id: 'a'.repeat(64), name: 'n', scope: 'read' }] };
const inbox = { organization: { name: 'あおば開発', theme: 'simple' }, invitations: [] };

test('API トークンの一覧は組織の slug を付けない組織の外のパスで読む', () => {
  expect(tokenPath).not.toContain('aoba');
});

test('一覧だけが失敗しても、経験値の2つは残り、tokens だけが null になる', async () => {
  const { result } = await run({
    [summaryPath]: ok({ level: 1 }),
    [grantsPath]: ok({ grants: [] }),
    [tokenPath]: { status: 500, body: { error: { code: 'internal', message: 'x' } } },
    [invitationPath]: ok(inbox),
  });
  expect(result).toEqual({ summary: { level: 1 }, grants: { grants: [] }, tokens: null, invitations: inbox });
});

test('経験値が失敗しても、API トークンの一覧は残る。一覧の値は tokens の配列だけを渡す', async () => {
  const { result } = await run({
    [summaryPath]: { status: 500, body: null },
    [grantsPath]: { status: 500, body: null },
    [tokenPath]: ok(tokens),
    [invitationPath]: ok(inbox),
  });
  expect(result).toEqual({ summary: null, grants: null, tokens: tokens.tokens, invitations: inbox });
});

test('届いた招待だけが失敗しても、ほかの節の値は残り、invitations だけが null になる。組織の slug を付けたパスで読む', async () => {
  expect(invitationPath).toContain('aoba');
  const { result } = await run({
    [summaryPath]: ok({ level: 1 }),
    [grantsPath]: ok({ grants: [] }),
    [tokenPath]: ok(tokens),
    [invitationPath]: { status: 500, body: { error: { code: 'internal', message: 'x' } } },
  });
  expect(result).toEqual({ summary: { level: 1 }, grants: { grants: [] }, tokens: tokens.tokens, invitations: null });
});

test('一覧の応答が JSON でなくても（転送が効かず HTML が返ったとき）null になり、例外にならない', async () => {
  const { fetch: fake } = fetcher({});
  const html = ((input: RequestInfo | URL) =>
    String(input) === tokenPath
      ? Promise.resolve(new Response('<html></html>', { status: 200 }))
      : fake(input)) as typeof fetch;
  const event = {
    params: { slug: 'aoba' },
    fetch: html,
    url: new URL('http://localhost/aoba/me'),
  } as unknown as Parameters<typeof load>[0];
  const result = (await (load as (e: typeof event) => Promise<{ tokens: unknown }>)(event)).tokens;
  expect(result).toBeNull();
});

test('一覧だけが 401 でも、ログインへ 307 で移し、戻り先に今のパスとクエリを持たせる', async () => {
  await expect(
    run({ [summaryPath]: ok({}), [grantsPath]: ok({}), [tokenPath]: unauthenticated, [invitationPath]: ok(inbox) }),
  ).rejects.toMatchObject({
    status: 307,
    location: `/login?return_to=${encodeURIComponent('/aoba/me?tab=x')}`,
  });
});

test('届いた招待だけが 401 でも、ログインへ 307 で移す', async () => {
  await expect(
    run({ [summaryPath]: ok({}), [grantsPath]: ok({}), [tokenPath]: ok(tokens), [invitationPath]: unauthenticated }),
  ).rejects.toMatchObject({ status: 307 });
});

test('4つとも同時に読みに行く（直列にしない）', async () => {
  // どの応答も、4件の要求が出そろうまで返さない。直列の実装は1件目の応答を待って止まり、4件そろわない
  const started: string[] = [];
  const release: (() => void)[] = [];
  const fake = ((input: RequestInfo | URL) => {
    started.push(String(input));
    return new Promise<Response>((resolve) => {
      release.push(() => resolve(new Response(JSON.stringify({}), { status: 200 })));
    });
  }) as typeof fetch;
  const event = {
    params: { slug: 'aoba' },
    fetch: fake,
    url: new URL('http://localhost/aoba/me'),
  } as unknown as Parameters<typeof load>[0];
  const running = (load as (e: typeof event) => Promise<unknown>)(event);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const startedBeforeAnyReply = [...started].sort();
  for (const resolve of release) resolve();
  await running;
  expect(startedBeforeAnyReply).toEqual([grantsPath, invitationPath, summaryPath, tokenPath].sort());
});
