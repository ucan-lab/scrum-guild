// e2e の前に、答えたサーバーがこの実行で build したものかを確かめ（#132）、手元の D1 に seed を入れ直す（手元の D1 の行は消える）。
// ログインした画面は seed のセッションの Cookie で開く。
// webServer が立ってから動くので、立てたままのサーバー（E2E_REUSE_SERVER=1）を使い回すときも流れる。
// seed は --local だけを付ける（本番の D1 には入れない。scripts/db-seed.ts）
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { DEV_WARNING_CODE, e2eGlobalSetup } from '../scripts/e2e-server.ts';

// build した画面の JS（build/_app の下の .js）のどれかに、開発時の警告を出すコードがあるか（E2E_DEV_BUILD=1 のときだけ呼ぶ）
function hasDevWarningCode(): boolean {
  const files = readdirSync('build/_app', { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.js'));
  return files.some((file) => DEV_WARNING_CODE.test(readFileSync(`build/_app/${file}`, 'utf8')));
}

export default async function globalSetup(): Promise<void> {
  // 版は playwright.config.ts が決めて process.env に置く
  await e2eGlobalSetup(process.env, {
    fetchHealth: (url, signal) => fetch(url, { signal }),
    seed: () => {
      // wrangler の出力は長いので、失敗のときの標準エラーだけを出す
      const result = spawnSync('pnpm', ['db:seed'], { stdio: ['ignore', 'ignore', 'inherit'] });
      if (result.error || result.status !== 0) throw new Error('pnpm db:seed が失敗した');
    },
    hasDevWarningCode,
  });
}
