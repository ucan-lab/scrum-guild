// 組織の枠の load（routes/[slug]/+layout.ts）が、組織に入れる人に届いた招待の件数（invitationCount）を数えることを、fetch を差し替えて確かめる。
// 組織の選択の届いた招待にこの slug が無い人は、invitation-list を呼ばない（追加の呼び出しを増やさない）
import { expect, test, vi } from 'vitest';
// $app/paths は SvelteKit の仮想モジュールで、node の vitest では解決できない。resolve('/') は base が空なので '/' を返す
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { load } from '../routes/[slug]/+layout.ts';
import { operationPath } from '../shared/operations/define.ts';
import { myOrganizations, organizationInfo } from '../shared/operations/organization/index.ts';
import { invitationList } from '../shared/operations/workspace/index.ts';

type Reply = { status: number; body: unknown };

const orgPath = operationPath(organizationInfo, 'aoba');
const minePath = operationPath(myOrganizations);
const listPath = operationPath(invitationList, 'aoba');

const organization: Reply = {
  status: 200,
  body: {
    organization: { name: 'あおば開発', theme: 'simple', has_workspaces: true },
    me: { id: 'u1', name: 'ミナト', is_admin: false, theme: null, level: 1 },
    workspaces: [],
  },
};
const mine = (slugs: string[]): Reply => ({
  status: 200,
  body: {
    organizations: [{ slug: 'aoba', name: 'あおば開発' }],
    invitations: slugs.map((slug) => ({ organization_name: '招待元', slug })),
    suspended: [],
    operator: false,
  },
});
const invitationItem = (id: string) => ({
  invitation_id: id,
  workspace_id: `w-${id}`,
  workspace_name: 'デザイン相談室',
  closed: false,
  role: 'member',
  invited_by_name: 'ユイ',
  invited_on: '2026-10-19',
});

async function run(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const fake = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    const reply = replies[String(input)] ?? { status: 500, body: 'no reply' };
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  }) as typeof fetch;
  const event = { params: { slug: 'aoba' }, fetch: fake, url: new URL('http://localhost/aoba') };
  const data = (await (load as (e: unknown) => Promise<{ invitationCount: number }>)(event)) as {
    invitationCount: number;
  };
  return { data, calls };
}

test('この組織に招待が届いていれば、invitation-list の件数を invitationCount に入れる', async () => {
  const { data } = await run({
    [orgPath]: organization,
    [minePath]: mine(['aoba']),
    [listPath]: {
      status: 200,
      body: {
        organization: { name: 'あおば開発', theme: 'simple' },
        invitations: [invitationItem('a'), invitationItem('b')],
      },
    },
  });
  expect(data.invitationCount).toBe(2);
});

test('この組織に招待が無ければ（ほかの組織だけ）0 で、invitation-list を呼ばない', async () => {
  const { data, calls } = await run({ [orgPath]: organization, [minePath]: mine(['hibari']) });
  expect(data.invitationCount).toBe(0);
  expect(calls).not.toContain(listPath);
});

test('招待が届いていても invitation-list が読めなければ 0（印を出さない。枠は開く）', async () => {
  const { data } = await run({
    [orgPath]: organization,
    [minePath]: mine(['aoba']),
    [listPath]: { status: 500, body: { error: { code: 'internal', message: 'x' } } },
  });
  expect(data.invitationCount).toBe(0);
});
