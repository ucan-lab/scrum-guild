// 解約した組織のデータを消す SQL を標準出力に書き出す（docs/operations.md の「解約した組織のデータを消す」）。
// node scripts/purge-organization.ts <組織の ID> > purge.sql
// 本番に流すのは人だけ（pnpm exec wrangler d1 execute scrum-guild --remote --file purge.sql）。このスクリプトは DB に触らない
import { purgeOrganizationSql } from './purge-organization-sql.ts';

const USAGE = '使い方: node scripts/purge-organization.ts <組織の ID> > purge.sql';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error(USAGE);
  process.exit(1);
}

try {
  process.stdout.write(purgeOrganizationSql(args[0]!));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(USAGE);
  process.exit(1);
}
