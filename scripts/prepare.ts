// 依存を入れたばかりの作業コピーでも check、test、dev が build の前に動くよう、生成物を用意する。
// tsconfig.json は svelte-kit sync が作る $app/tsconfig を継ぎ、Worker の型は wrangler types が作る
// worker-configuration.d.ts を読み、wrangler の設定の assets は build/ を指す。
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('build', { recursive: true });

for (const [command, args] of [
  ['svelte-kit', ['sync']],
  ['wrangler', ['types']],
] as const) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error || result.status !== 0) {
    console.error(`${command} ${args.join(' ')} が失敗しました`);
    process.exit(result.status ?? 1);
  }
}
