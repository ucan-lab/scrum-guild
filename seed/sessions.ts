// seed（pnpm db:seed）が手元の D1 に入れるセッションのトークン。e2e もここから Cookie の値を取る。
// どれも開発用の値で、リポジトリを読める人なら誰でも知っている。本番の D1 には入れない（seed/README.md）
// 形はログインが作るトークンと同じ base64url の43文字。DB には SHA-256 の16進を入れる

// 運用者のログインの ID。.dev.vars.example の OPERATOR_LOGIN_IDS と同じ値
export const SEED_OPERATOR_LOGIN_ID = 'github:9000000000000001';

export type SeedSession = { token: string; accountId: string; description: string };

export const SEED_SESSIONS = {
  admin: {
    token: 'dev-seed-admin-0000000000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000101',
    description: 'あおば開発の管理者（ミナト）。ひばり工房にも一般のユーザーとして入る',
  },
  member: {
    token: 'dev-seed-member-000000000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000102',
    description: 'あおば開発の一般のユーザー（ハルカ）',
  },
  otherOrg: {
    token: 'dev-seed-other-org-000000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000103',
    description: 'ひばり工房だけに入れる管理者（リン）',
  },
  operator: {
    token: 'dev-seed-operator-0000000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000104',
    description: 'どの組織にも属さない運用者',
  },
  invitee: {
    token: 'dev-seed-invitee-00000000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000108',
    description: 'どの組織にも属さず、ひばり工房のデザイン相談室への承諾待ちの招待だけが届いた人（ヒナタ）',
  },
  // e2e のログアウトが消すための2本目。e2e は上のセッションを全ファイルで共有して並列に走るので、共有のものはログアウトしない
  adminLogout: {
    token: 'dev-seed-admin-logout-000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000101',
    description: 'admin と同じアカウントの2本目（e2e のログアウトが消す）',
  },
  operatorLogout: {
    token: 'dev-seed-operator-logout-000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000104',
    description: 'operator と同じアカウントの2本目（e2e のログアウトが消す）',
  },
  // くもラボ（e2e の組織の既定のテーマだけが使い、組織の値を書き換える組織）の3人。ほかの組織には入らない
  lookAdmin: {
    token: 'dev-seed-look-admin-00000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000105',
    description: 'くもラボの管理者（カイ）。e2e の組織の既定のテーマが使う',
  },
  lookMember: {
    token: 'dev-seed-look-member-0000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000106',
    description: 'くもラボの一般のユーザーで、テーマを選んでいない（ソウタ）',
  },
  lookThemed: {
    token: 'dev-seed-look-themed-0000000000000000000000',
    accountId: '019a0000-0000-7000-8000-000000000107',
    description: 'くもラボの一般のユーザーで、自分のテーマ（シンプル（ダーク））を選んでいる（コハル）',
  },
} as const satisfies Record<string, SeedSession>;
