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

// 同じ警告は行ごとに何度も出るので、名前、中身、画面のパスの組で1つにまとめて並べる
export function formatDevWarnings(warnings: readonly DevWarningAt[]): string {
  const lines = [...new Set(warnings.map(({ name, detail, path }) => `- ${name}: ${detail}（画面 ${path}）`))];
  return [
    `開発時の警告が ${lines.length} 種類出た。本番の build では出ないが、本物のエラーを埋もれさせるので直す（docs/development.md の「e2e の書き方」）`,
    ...lines,
  ].join('\n');
}
