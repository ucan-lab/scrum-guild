// seed（pnpm db:seed）が手元の D1 に入れる API トークンの生の値。手元の API を curl で確かめるときに使う
// （`curl -X POST -H "Authorization: Bearer <値>" -H "Content-Type: application/json" -d '{}' http://localhost:8787/api/me`）。
// どれも開発用の値で、リポジトリを読める人なら誰でも知っている。本番の D1 には入れない（seed/README.md）。
// 形は発行が作るトークンと同じ `sgp_` + base64url の43文字。DB の `api_tokens.token_hash` には、その SHA-256 の16進を
// seed/data.sql に固定で書く（test/api-token-seed.test.ts が、ここの値と data.sql のハッシュが合うことを確かめる）

export type SeedApiToken = {
  token: string;
  // seed/sessions.ts の SEED_SESSIONS の同じ人のアカウントの ID
  accountId: string;
  scope: 'read' | 'write';
  description: string;
};

export const SEED_API_TOKENS = {
  adminWrite: {
    token: 'sgp_dev-seed-admin-write00000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000101',
    scope: 'write',
    description: 'あおば開発の管理者（ミナト）の書き込みのトークン',
  },
  memberRead: {
    token: 'sgp_dev-seed-member-read00000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000102',
    scope: 'read',
    description: 'あおば開発の一般のユーザー（ハルカ）の読み取りのトークン。書き込みの操作は 403',
  },
  operatorWrite: {
    token: 'sgp_dev-seed-operator-write00000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000104',
    scope: 'write',
    description: '運用者の書き込みのトークン。運用者の操作はどのトークンでも 403',
  },
} as const satisfies Record<string, SeedApiToken>;
