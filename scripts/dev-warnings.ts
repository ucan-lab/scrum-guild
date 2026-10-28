// 開発モードの build（E2E_DEV_BUILD=1）の e2e で、Svelte と SvelteKit が開発時だけ出す警告を読む（#375）。
// 警告は console.warn で `%c[svelte] <名前>\n%c<中身>\nhttps://svelte.dev/e/<名前>` の形で出て、
// Playwright の message.text() には %c と書式の引数（font-weight: bold など）が残る。e2e/fixtures.ts が使う

export type DevWarning = { name: string; detail: string };
export type DevWarningAt = DevWarning & { path: string };

// 1行目が `[svelte]` か `[sveltekit]` で始まるものだけを警告に数え、1行目をそのまま名前にする。ほかの console.warn は見ない。
// 名前の形（`[a-z_]+` など）では絞らない。形の違う新しい警告を、警告でないものとして握りつぶさないため
const HEAD = /^\[(?:svelte|sveltekit)\](?: |$)/;

export function parseDevWarning(text: string): DevWarning | undefined {
  const [head = '', detail = ''] = text.split('\n');
  const name = head.replace(/^%c/, '').trim();
  if (!HEAD.test(name)) return undefined;
  return { name, detail: detail.replace(/^%c/, '').trim() };
}

// 今ある警告のうち、数えないもの。2種類ある。
//   - 直すまで数えないもの（#375 で入れたときに main に残っていた分）。名前と、中身か画面のパスで絞る。直す Issue が直したときに
//     ここから外す。新しく足さない（新しい警告は直してからマージする）
//   - 開発の build では当てにならないので数えないもの（nameOnly）。名前だけで並べ、代わりのテストで確かめる。外す条件は行に書く
// 数えずに通した警告は、e2e/fixtures.ts がテストの annotation（known-dev-warning）に残す
type KnownDevWarning = { name: string; detail?: RegExp; path?: RegExp; nameOnly?: true; reason: string };

export const KNOWN_DEV_WARNINGS: readonly KnownDevWarning[] = [
  {
    name: '[sveltekit] goto_invalidate_all_deprecated',
    // 今使っている画面だけ: 組織の管理（ワークスペースの作成）、招待の一覧、メンバー（自分が抜ける）
    path: /^\/[^/]+\/(admin|invitations|w\/[^/]+\/members)$/,
    reason: '#388 で refreshAll に置き換える',
  },
  // 開発の build では関数名が縮められ、SvelteKit がスタックで load の中かを判定できない。そのため load が走っている間に
  // 画面の部品（引き出しなど）が送った window.fetch も、この警告に数える（#393）。どの画面とどの URL でも数えない。
  // load が SvelteKit の渡す fetch で API を呼ぶことは、src/routes/load-fetch.test.ts がソースの AST で確かめる。
  // 画面の部品が load の間に送るたびに出るので、annotation から消えることはない。SvelteKit が開発の build でも load の中かを
  // 判定できるようになったら（fetcher.js の check_stack_trace が縮めた名前でも通る）、この行を外し、絞った行に戻す
  {
    name: '[sveltekit] window_fetch_in_load',
    nameOnly: true,
    reason:
      '開発の build ではスタックで load の中かを判定できず、load の間の画面の操作も数える（#393）。load の fetch は src/routes/load-fetch.test.ts が確かめる',
  },
  // SvelteKit が、app の error() でないエラー（SvelteKit の 404 か、予期しない例外）で開発時に出す。
  // 存在しないパスを開いて 404 の画面を確かめるテスト（e2e/shell.test.ts）の分だけを外す。ほかの画面では予期しない例外の印なので数える
  {
    name: '[sveltekit] hmr_reload_after_error',
    path: /^\/foo\/bar\/baz$/,
    reason: '存在しないパスを開いて 404 の画面を確かめるテストで、わざと出す',
  },
  // 画面のエラーの送り手が、最初の描画と load の例外も送ることを確かめるテスト（e2e/client-errors-hooks.test.ts）が、
  // わざと予期しない例外を起こす。ほかの e2e が開かない、そのテストの経路だけを外す（#376）
  {
    name: '[sveltekit] hmr_reload_after_error',
    path: /^\/(kumo\/me|e2e-client-error)$/,
    reason: '画面のエラーを送るテストで、わざと予期しない例外を起こす',
  },
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
