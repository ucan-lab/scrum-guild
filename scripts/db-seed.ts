// pnpm db:seed: 手元の D1 に全マイグレーションを当て、全部の表の行を消して seed を入れ直す。
// --local だけを使う。seed のトークンは公開された開発用の値なので、本番の D1 には入れない（seed/README.md）
// --persist-to <dir> を渡すと、その場所の D1 に入れる（scripts/migrate-fresh.ts が空の D1 で確かめるのに使う）
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { seedSql } from './seed.ts';

const persistIndex = process.argv.indexOf('--persist-to');
const persistTo = persistIndex === -1 ? undefined : process.argv[persistIndex + 1];
if (persistIndex !== -1 && !persistTo) {
  console.error('--persist-to に場所を渡してください');
  process.exit(1);
}
const local = ['--local', ...(persistTo ? ['--persist-to', persistTo] : [])];

function wrangler(args: string[], capture = false): string {
  const result = spawnSync('wrangler', ['d1', ...args, ...local], {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    console.error(`wrangler d1 ${args[0]} が失敗しました`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

wrangler(['migrations', 'apply', 'DB']);

const listed = JSON.parse(
  wrangler(
    ['execute', 'DB', '--json', '--command', "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"],
    true,
  ),
) as { results: { name: string }[] }[];
const tables = listed.flatMap((r) => r.results.map((row) => row.name));

const data = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');
const dir = mkdtempSync(path.join(tmpdir(), 'scrum-guild-seed-'));
try {
  const file = path.join(dir, 'seed.sql');
  writeFileSync(file, seedSql(tables, data, Object.values(SEED_SESSIONS), new Date()));
  wrangler(['execute', 'DB', '--file', file]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('seed を入れました（セッションのトークンは seed/sessions.ts）');
