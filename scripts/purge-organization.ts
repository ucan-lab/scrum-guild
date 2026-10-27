// 解約した組織のデータを消す SQL を標準出力に書き出す（docs/operations.md の「解約した組織のデータを消す」）。
// node scripts/purge-organization.ts <組織の ID> > /tmp/purge-<組織の ID>.sql   消す文を1行に1文
// node scripts/purge-organization.ts --count <組織の ID>                         残りを数える1行の SELECT
// 本番に流すのは人だけ（1文ずつ `pnpm exec wrangler d1 execute scrum-guild --remote --command "<文>"`）。このスクリプトは DB に触らない
import { purgeOrganizationCountSql, purgeOrganizationSql } from './purge-organization-sql.ts';

const USAGE = [
  '使い方: node scripts/purge-organization.ts <組織の ID> > /tmp/purge-<組織の ID>.sql',
  '        node scripts/purge-organization.ts --count <組織の ID>',
].join('\n');

const args = process.argv.slice(2);
const count = args[0] === '--count';
const ids = count ? args.slice(1) : args;
if (ids.length !== 1) {
  console.error(USAGE);
  process.exit(1);
}

try {
  process.stdout.write(count ? purgeOrganizationCountSql(ids[0]!) : purgeOrganizationSql(ids[0]!));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(USAGE);
  process.exit(1);
}
