import { sql, type RawBuilder } from 'kysely';

// 行ごとに違う UUIDv7 の文字列を、SQL の中で作る（INSERT ... SELECT で複数の行を1文に入れるとき）。
// 形は src/server/uuid.ts の uuidv7 と同じ（小文字の16進、8-4-4-4-12、版は 7、variant は 8〜b）。
// 先頭の48ビットはアプリの時刻（ms。同じ文の created_at と同じ時計）で、残りは行ごとに randomblob と random から取る
// （SQLite は非決定の関数を行ごとに評価する）
export function uuidv7Sql(at: Date): RawBuilder<string> {
  const millis = at.getTime();
  return sql<string>`(substr(printf('%012x', ${millis}), 1, 8) || '-' || substr(printf('%012x', ${millis}), 9, 4) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))`;
}
