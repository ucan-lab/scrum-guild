// 組織の slug の決まり（docs/data-model.md の `organizations`）。URL の先頭に入れる名前で、後から変えない。
// 形は `organizations.slug` の CHECK と同じ（英小文字と数字で始まり、英小文字、数字、ハイフンだけで 2〜40 字）。
// scripts/ のテストと Worker の型の検査からも読むので、Node の型の除去で動く書き方に留める（enum を使わない）

export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 40;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

// 画面と API が最上段に使う名前。組織の slug にすると、その組織の URL が画面か API と重なる。
// 画面の最上段のルート（src/routes/ の直下）を足したら、ここにも足す（scripts/organization-slug.test.ts が落とす）。
// `_app` は SvelteKit の静的ファイルの置き場所。slug の形には合わないが、予約の一覧として持つ。
// `cdn-cgi` は Cloudflare が Worker より先に受け取るパスで、組織の URL にすると届かない
export const reservedSlugs: readonly string[] = [
  'cdn-cgi',
  'api',
  'auth',
  'login',
  'logout',
  'invite',
  'terms',
  'privacy',
  // 規約への同意の画面（#645 のストーリー2）の経路。ルートはまだ無いが、後から作ったときに組織の URL と重ならないよう先に予約する
  'consent',
  'operator',
  'health',
  'static',
  'assets',
  '_app',
];

export type SlugProblem = 'format' | 'reserved';

// 形が合わない、または予約した名前なら理由を返す。使える slug は undefined
export function slugProblem(slug: string): SlugProblem | undefined {
  if (!SLUG_PATTERN.test(slug)) return 'format';
  if (reservedSlugs.includes(slug)) return 'reserved';
  return undefined;
}
