// 3 つの load（/、/[slug]、/operator）が 403 の terms_required を同意の画面（/consent）へ移すことを、fetch を差し替えて確かめる（#648）。
// 見るのは、呼び出しの組み合わせ（どれか 1 つの terms_required、401 や 403 との同時）と、return_to に外へ向く値が入らないこと
import { describe, expect, test, vi } from 'vitest';
// $app/paths は SvelteKit の仮想モジュールで、node の vitest では解決できない。resolve('/') は base が空なので '/' を返す
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { load as rootLoad } from '../routes/+page.ts';
import { load as slugLoad } from '../routes/[slug]/+layout.ts';
import { load as operatorLoad } from '../routes/operator/+page.ts';
import { operationPath } from '../shared/operations/define.ts';
import { listOrganizations } from '../shared/operations/operator/index.ts';
import { myOrganizations, organizationInfo } from '../shared/operations/organization/index.ts';
import { invitationList } from '../shared/operations/workspace/index.ts';

type Reply = { status: number; body: unknown };

const termsRequired: Reply = { status: 403, body: { error: { code: 'terms_required', message: 'x' } } };
const unauthenticated: Reply = { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } };
const forbidden: Reply = { status: 403, body: { error: { code: 'forbidden', message: 'x' } } };
const notFound: Reply = { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
const invited = (slug: string): Reply => ({
  status: 200,
  body: {
    organizations: [],
    invitations: [{ organization_name: '招待元', slug }],
    suspended: [],
    operator: false,
  },
});

function fakeFetch(replies: Record<string, Reply>): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const reply = replies[String(input)] ?? { status: 500, body: 'no reply' };
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  }) as typeof fetch;
}

// load が投げる redirect（SvelteKit の Redirect）の status と location。投げなければ undefined
async function redirectOf(run: () => Promise<unknown>): Promise<{ status: number; location: string } | undefined> {
  try {
    await run();
  } catch (thrown) {
    const { status, location } = thrown as { status?: number; location?: string };
    if (typeof status === 'number' && typeof location === 'string') return { status, location };
    throw thrown;
  }
  return undefined;
}

function slugRun(url: string, replies: Record<string, Reply>) {
  const event = { params: { slug: 'aoba' }, fetch: fakeFetch(replies), url: new URL(url) };
  return () => (slugLoad as (e: unknown) => Promise<unknown>)(event);
}

const orgPath = operationPath(organizationInfo, 'aoba');
const mineOk = { status: 200, body: { organizations: [], invitations: [], suspended: [], operator: false } };
const minePath = operationPath(myOrganizations);

describe('/[slug] の load', () => {
  test('organization-info だけが terms_required でも同意の画面へ。クエリを return_to に残す', async () => {
    const moved = await redirectOf(
      slugRun('http://localhost/aoba?tab=x', { [orgPath]: termsRequired, [minePath]: mineOk }),
    );
    expect(moved).toEqual({ status: 307, location: '/consent?return_to=%2Faoba%3Ftab%3Dx' });
  });

  test('my-organizations だけが terms_required でも同意の画面へ', async () => {
    const moved = await redirectOf(
      slugRun('http://localhost/aoba', { [orgPath]: { status: 200, body: {} }, [minePath]: termsRequired }),
    );
    expect(moved?.location).toBe('/consent?return_to=%2Faoba');
  });

  test('片方が 401、もう片方が terms_required のときは同意の画面（ログインの画面でない）', async () => {
    const moved = await redirectOf(
      slugRun('http://localhost/aoba', { [orgPath]: unauthenticated, [minePath]: termsRequired }),
    );
    expect(moved?.location.startsWith('/consent?')).toBe(true);
  });

  test('招待だけの人で invitation-list が terms_required のときも同意の画面へ', async () => {
    const moved = await redirectOf(
      slugRun('http://localhost/aoba/invitations', {
        [orgPath]: notFound,
        [minePath]: invited('aoba'),
        [operationPath(invitationList, 'aoba')]: termsRequired,
      }),
    );
    expect(moved).toEqual({ status: 307, location: '/consent?return_to=%2Faoba%2Finvitations' });
  });

  test('パスが // で始まっても、return_to は外へ向かず / に落ちる', async () => {
    const moved = await redirectOf(
      slugRun('http://localhost//evil.example', { [orgPath]: termsRequired, [minePath]: mineOk }),
    );
    expect(moved?.location).toBe('/consent?return_to=%2F');
  });
});

describe('/ の load', () => {
  test('terms_required は同意の画面へ。// のパスでも外へ向かない', async () => {
    const run = (url: string) => () =>
      (rootLoad as (e: unknown) => Promise<unknown>)({
        fetch: fakeFetch({ [minePath]: termsRequired }),
        url: new URL(url),
      });
    expect(await redirectOf(run('http://localhost/?a=1'))).toEqual({
      status: 307,
      location: '/consent?return_to=%2F%3Fa%3D1',
    });
    expect((await redirectOf(run('http://localhost//evil.example')))?.location).toBe('/consent?return_to=%2F');
  });
});

describe('/operator の load', () => {
  const run = (reply: Reply) => () =>
    (operatorLoad as (e: unknown) => Promise<unknown>)({
      fetch: fakeFetch({ [operationPath(listOrganizations)]: reply }),
      url: new URL('http://localhost/operator'),
    });

  test('403 の terms_required は同意の画面へ（運用者でないとして / へ戻さない）', async () => {
    expect(await redirectOf(run(termsRequired))).toEqual({ status: 307, location: '/consent?return_to=%2Foperator' });
  });

  test('同じ 403 でも forbidden は従来どおり / へ、401 はログインの画面へ', async () => {
    expect((await redirectOf(run(forbidden)))?.location).toBe('/');
    expect((await redirectOf(run(unauthenticated)))?.location.startsWith('/login?')).toBe(true);
  });
});
