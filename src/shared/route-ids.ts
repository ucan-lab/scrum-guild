// 画面の route.id の一覧（Issue #376）。src/routes の +page.svelte の置き場所と一致することを、route-ids.test.ts が確かめる。
// 画面から送られた経路がこの一覧に無ければ、サーバーは null に置き換える
export const ROUTE_IDS: readonly string[] = [
  '/',
  '/[slug]',
  '/[slug]/admin',
  '/[slug]/invitations',
  '/[slug]/me',
  '/[slug]/w/[id]',
  '/[slug]/w/[id]/epics/[epicId]',
  '/[slug]/w/[id]/members',
  '/[slug]/w/[id]/plan',
  '/[slug]/w/[id]/settings',
  '/[slug]/w/[id]/sprint',
  '/[slug]/w/[id]/tasks/[taskId]',
  '/invite',
  '/login',
  '/operator',
  '/privacy',
  '/terms',
];
