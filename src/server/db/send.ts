// Kysely が組み立てた SQL を D1 に送る部分。D1 の binding に触れるのは、ここと select-database.ts だけにする。
// Kysely の D1 の方言は使わない（kysely-d1 は更新が止まっている）。1件の問い合わせも batch() も prepare().bind() の同じ道を通る
import type { CompiledQuery } from 'kysely';

export type SendResult = {
  rows: unknown[];
  // D1 の meta.changes。先に読んだ値で判定した書き込みの競合（0 なら 409）を見つけるのに使う
  changes: number;
};

function prepare(d1: D1Database, query: CompiledQuery): D1PreparedStatement {
  return d1.prepare(query.sql).bind(...query.parameters);
}

export async function sendOne(d1: D1Database, query: CompiledQuery): Promise<SendResult> {
  const result = await prepare(d1, query).all();
  return { rows: result.results, changes: result.meta.changes };
}

// D1 の batch() は全部の文を1つのトランザクションで流し、途中の文が失敗すると前の文も戻す
export async function sendBatch(d1: D1Database, queries: readonly CompiledQuery[]): Promise<SendResult[]> {
  if (queries.length === 0) return [];
  const results = await d1.batch(queries.map((query) => prepare(d1, query)));
  return results.map((result) => ({ rows: result.results, changes: result.meta.changes }));
}
