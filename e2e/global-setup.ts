// e2e の前に、答えたサーバーがこの実行で build したものかを確かめ（#132）、手元の D1 に seed を入れ直す（手元の D1 の行は消える）。
// ログインした画面は seed のセッションの Cookie で開く。
// webServer が立ってから動くので、立てたままのサーバー（E2E_REUSE_SERVER=1）を使い回すときも流れる。
// seed は --local だけを付ける（本番の D1 には入れない。scripts/db-seed.ts）
import { spawnSync } from 'node:child_process';
import { e2eHealthURL, serverVersionMismatch } from '../scripts/e2e-server.ts';

export default async function globalSetup(): Promise<void> {
  // 版は playwright.config.ts が決めて process.env に置く
  const expected = process.env.APP_VERSION ?? '';
  const res = await fetch(e2eHealthURL(process.env));
  const body: unknown = await res.json().catch(() => undefined);
  const actual = typeof body === 'object' && body !== null && 'version' in body ? body.version : undefined;
  const mismatch = serverVersionMismatch(expected, actual, process.env);
  if (mismatch) throw new Error(mismatch);

  // wrangler の出力は長いので、失敗のときの標準エラーだけを出す
  const result = spawnSync('pnpm', ['db:seed'], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error || result.status !== 0) throw new Error('pnpm db:seed が失敗した');
}
