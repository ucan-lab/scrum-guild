import { sql, type RawBuilder } from 'kysely';

// 解約した組織の消す予定日（organizations.purge_on）の条件。消す SQL のガード（scripts/purge-organization-sql.ts の
// purge_on < date('now')）と同じ境目を、D1 の時計で見るための式。organizations を引く文の中だけで使う。

// 消す予定日を過ぎていない: 予定日が無いか、today（Worker の now() の UTC の日付、YYYY-MM-DD）以降で、かつ D1 の date('now') 以降。
// 束縛値は開発用の時計（DEV_NOW）で境目を確かめるため、date('now') は Worker と D1 の時計が UTC の 0 時をまたいでずれても、
// 消す SQL のガードが真の組織を外すため。両方を満たすときだけ真で、消す SQL のガードとは同時に真にならない
export function purgeNotDue(today: string): RawBuilder<boolean> {
  return sql<boolean>`(purge_on IS NULL OR (purge_on >= ${today} AND purge_on >= date('now')))`;
}

// 消す予定日を D1 の date('now') で過ぎている（消す SQL のガードと同じ式）。1 か 0
export function purgeDueInDatabase(): RawBuilder<number> {
  return sql<number>`(purge_on IS NOT NULL AND purge_on < date('now'))`;
}
