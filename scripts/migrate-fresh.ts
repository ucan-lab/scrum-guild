// CI の migration のジョブ（pnpm db:migrate:fresh）: 空のローカルの D1 に全マイグレーションを順に当てる。
// wrangler は migrations/ が無いと失敗するので、0件のときは当てずに成功で終える
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrationFiles } from './ci.ts';

const dir = 'migrations';
const files = existsSync(dir) ? migrationFiles(readdirSync(dir)) : [];

if (files.length === 0) {
  console.log('マイグレーションは0件です。当てるものはありません');
} else {
  // 手元の .wrangler/state を使うと、前に当てた状態から始まってしまう
  const persistTo = mkdtempSync(path.join(tmpdir(), 'scrum-guild-d1-'));
  console.log(`${files.length}件のマイグレーションを空の D1（${persistTo}）に当てます`);
  const result = spawnSync('wrangler', ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo], {
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    console.error('マイグレーションを当てられませんでした');
    process.exit(result.status ?? 1);
  }
}
