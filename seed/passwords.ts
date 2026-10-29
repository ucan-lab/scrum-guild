// seed（pnpm db:seed）が手元の D1 に入れる、メールアドレスとパスワードでログインする人。e2e もここからメールアドレスとパスワードを取る。
// どれも開発用の値で、リポジトリを読める人なら誰でも知っている。本番の D1 には入れない（seed/README.md）。
// seed/data.sql の password_credentials には、パスワードそのものではなく、src/server/auth/password-hash.ts の hashPassword で
// 作ったハッシュ（今の反復回数 100,000）を固定の文字列で書く。パスワードを変えたら、ハッシュも作り直して data.sql を直す。
// アカウントと account_logins の行は seed に入れない（ほかの手段と同じく、初めてのログインで作る）

export type SeedPasswordLogin = {
  email: string;
  password: string;
  // password_credentials.login_subject（users.login_subject と同じ値）
  loginSubject: string;
  name: string;
  // 入れる組織の slug。seed/data.sql の users の行（管理者）と同じ
  organizations: readonly string[];
  description: string;
};

export const SEED_PASSWORD_LOGINS = {
  // 入れる組織が1つの人。ログインすると、その組織の画面へ移る
  single: {
    email: 'tsumugi@example.test',
    password: 'seed-password-tsumugi',
    loginSubject: '019a0000-0000-7000-8000-0000000f0001',
    name: 'ツムギ',
    organizations: ['yuzu'],
    description: 'ゆず書房だけに入れる管理者（ツムギ）',
  },
  // 入れる組織が2つの人。ログインすると、組織の選択（/）へ移る
  multi: {
    email: 'aoi@example.test',
    password: 'seed-password-aoi',
    loginSubject: '019a0000-0000-7000-8000-0000000f0002',
    name: 'アオイ',
    organizations: ['yuzu', 'minamo'],
    description: 'ゆず書房とみなも舎に入れる管理者（アオイ）',
  },
} as const satisfies Record<string, SeedPasswordLogin>;
