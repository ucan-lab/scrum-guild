// 開発モードの build（E2E_DEV_BUILD=1）の e2e で、Svelte と SvelteKit が開発時だけ出す警告を読む（#375）。
// 警告は console.warn で `%c[svelte] <名前>\n%c<中身>\nhttps://svelte.dev/e/<名前>` の形で出て、
// Playwright の message.text() には %c と書式の引数（font-weight: bold など）が残る。e2e/fixtures.ts が使う

export type DevWarning = { name: string; detail: string };
export type DevWarningAt = DevWarning & { path: string };

// 1行目が `[svelte] <名前>` か `[sveltekit] <名前>` のものだけを警告に数える。ほかの console.warn は見ない
const HEAD = /^(?:%c)?(\[(?:svelte|sveltekit)\] [a-z_]+)$/;

export function parseDevWarning(text: string): DevWarning | undefined {
  const [head = '', detail = ''] = text.split('\n');
  const match = HEAD.exec(head.trim());
  if (!match) return undefined;
  return { name: match[1] ?? '', detail: detail.replace(/^%c/, '').trim() };
}

// 今ある警告のうち、直すまで数えないもの（#375 で入れたときに main に残っていた分）。名前と、中身か画面のパスで絞る。
// 直す Issue があるものは、その Issue が直したときにここから外す。新しく足さない（新しい警告は直してからマージする）
type KnownDevWarning = { name: string; detail?: RegExp; path?: RegExp; reason: string };

export const KNOWN_DEV_WARNINGS: readonly KnownDevWarning[] = [
  { name: '[sveltekit] goto_invalidate_all_deprecated', reason: '#388 で refreshAll に置き換える' },
  {
    name: '[sveltekit] window_fetch_in_load',
    detail: /^Loading `\/api\/[^/]+\/member-list` using `window\.fetch`/,
    reason: '#393 で出どころを確かめる',
  },
  { name: '[sveltekit] history_api_conflict', path: /^\/invite$/, reason: '#394 で $app/navigation に置き換える' },
  // 開発用のサーバーの HMR の知らせ。HMR の無い build した画面では意味が無く、エラーの画面を開くテストで必ず出る
  { name: '[sveltekit] hmr_reload_after_error', reason: 'build した画面には HMR が無い' },
];

export function isKnownDevWarning(warning: DevWarningAt): boolean {
  return KNOWN_DEV_WARNINGS.some(
    (known) =>
      known.name === warning.name &&
      (known.detail === undefined || known.detail.test(warning.detail)) &&
      (known.path === undefined || known.path.test(warning.path)),
  );
}

// 同じ警告は行ごとに何度も出るので、名前、中身、画面のパスの組で1つにまとめて並べる
export function formatDevWarnings(warnings: readonly DevWarningAt[]): string {
  const lines = [...new Set(warnings.map(({ name, detail, path }) => `- ${name}: ${detail}（画面 ${path}）`))];
  return [
    `開発時の警告が ${lines.length} 種類出た。本番の build では出ないが、本物のエラーを埋もれさせるので直す（docs/development.md の「e2e の書き方」）`,
    ...lines,
  ].join('\n');
}
