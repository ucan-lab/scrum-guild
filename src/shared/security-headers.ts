// 画面の資産（build/_headers）と API（Hono のミドルウェア）が同じ値を使うよう、ヘッダーをここに1つだけ持つ。
// vite.config.ts、src/server、scripts/ の3か所から読むので、Node の型の除去で動く書き方に留める（enum を使わない）。

export const fixedHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
} as const;

// kit.csp の型は書き換えられる配列を求めるので、as const の読み取り専用の配列にせず、値の文字列だけを絞る
function sources<const T extends string[]>(...values: T): T {
  return values;
}

// SvelteKit の kit.csp に渡す。値の書き方は SvelteKit のもの（キーワードを引用符で囲まない）
export const pageCspDirectives = {
  'default-src': sources('self'),
  'object-src': sources('none'),
  'base-uri': sources('self'),
  'form-action': sources('self'),
  'frame-ancestors': sources('none'),
  // GitHub のアバターの画像。運用者が最初の管理者に指名する人を、作る前に確かめるのに見せる（アバターの URL は
  // src/server/auth/github.ts がこのホストの https だけを通す）
  'img-src': sources('self', 'https://avatars.githubusercontent.com'),
  // SvelteKit が差し込む読み上げ用の要素（svelte-announcer）の style 属性だけを通す。
  // Kit を上げて値が変わると、pnpm build の最後（scripts/write-headers.ts）が落ちる
  'style-src': sources('self', 'unsafe-hashes', 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='),
};

// SvelteKit は CSP を meta で出すときにこれらを捨てる。_headers に写すときに pageCspDirectives から足し戻す
export const metaIgnoredDirectives = ['frame-ancestors', 'report-uri', 'sandbox'] as const;

// JSON にスクリプトは無いので、何も読ませず、埋め込ませない
export const apiCsp = "default-src 'none'; frame-ancestors 'none'";

// API は後でログインした人のデータを返すので、どの応答もキャッシュに残さない
export const apiCacheControl = 'no-store';

// /_app/immutable/ の下はファイル名にハッシュが入り、中身が変わらない
export const immutableCacheControl = 'public, max-age=31536000, immutable';
