// CI の migration のジョブ（pnpm db:migrate:fresh）: 空のローカルの D1 に全マイグレーションを順に当て、
// 続けて同じ D1 に seed を2回流す。マイグレーションと seed のずれと、流し直せることを PR ごとに確かめるため。
// wrangler は migrations/ が無いと失敗するので、0件のときは当てずに成功で終える
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrationFiles } from './ci.ts';

const dir = 'migrations';
const files = existsSync(dir) ? migrationFiles(readdirSync(dir)) : [];

function run(command: string, args: string[], failure: string): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(failure);
    rmSync(persistTo, { recursive: true, force: true });
    process.exit(result.status ?? 1);
  }
}

if (files.length === 0) {
  console.log('マイグレーションは0件です。当てるものはありません');
  process.exit(0);
}

// 手元の .wrangler/state を使うと、前に当てた状態から始まってしまう
const persistTo = mkdtempSync(path.join(tmpdir(), 'scrum-guild-d1-'));
console.log(`${files.length}件のマイグレーションを空の D1（${persistTo}）に当てます`);
run(
  'wrangler',
  ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo],
  'マイグレーションを当てられませんでした',
);
const seed = path.join(import.meta.dirname, 'db-seed.ts');
for (const round of [1, 2]) {
  console.log(`seed を流します（${round}回目）`);
  run(process.execPath, [seed, '--persist-to', persistTo], `seed を流せませんでした（${round}回目）`);
}
rmSync(persistTo, { recursive: true, force: true });
