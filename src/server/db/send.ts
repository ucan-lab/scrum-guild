// Kysely が組み立てた SQL を D1 に送る部分。D1 の binding に触れるのは、ここと select-database.ts だけにする。
// Kysely の D1 の方言は使わない（kysely-d1 は更新が止まっている）。1件の問い合わせも batch() も prepare().bind() の同じ道を通る
import type { CompiledQuery } from 'kysely';

export type SendResult = {
  rows: unknown[];
  // D1 の meta.changes。先に読んだ値で判定した書き込みの競合（0 なら 409）を見つけるのに使う
  changes: number;
};

// D1 の1文あたりの束縛の上限
export const MAX_BOUND_PARAMETERS = 100;

// 超えた文は D1 に送る前に止める。文を見つけられるよう番号を添え、SQL と値は入れない（値に入力の本文や認証情報が混ざりうる）
type SqlWithParameters = Pick<CompiledQuery, 'sql' | 'parameters'>;

function assertBindable(query: SqlWithParameters, label: string): void {
  if (query.parameters.length > MAX_BOUND_PARAMETERS) {
    throw new Error(`${label}の束縛が ${query.parameters.length} 個で、D1 の上限 ${MAX_BOUND_PARAMETERS} を超えた`);
  }
}

function prepare(d1: D1Database, query: CompiledQuery): D1PreparedStatement {
  return d1.prepare(query.sql).bind(...query.parameters);
}

export async function sendOne(d1: D1Database, query: CompiledQuery): Promise<SendResult> {
  assertBindable(query, '文');
  const result = await prepare(d1, query).all();
  return { rows: result.results, changes: result.meta.changes };
}

// 文の実行計画（EXPLAIN QUERY PLAN の detail の列）。テストが索引に乗るかを確かめるために、testing.ts だけが呼ぶ。
// D1 の binding に触れる場所を増やさないよう、ここに置く
export async function explainQueryPlan(d1: D1Database, query: SqlWithParameters): Promise<string[]> {
  assertBindable(query, '文');
  const result = await d1
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .bind(...query.parameters)
    .all<{ detail: string }>();
  return result.results.map((row) => row.detail);
}

// D1 の batch() は全部の文を1つのトランザクションで流し、途中の文が失敗すると前の文も戻す。
// 件数 0 の文があっても戻さないので、後ろの文は先に読んだ値の条件を自分の WHERE に持つ
export async function sendBatch(d1: D1Database, queries: readonly CompiledQuery[]): Promise<SendResult[]> {
  if (queries.length === 0) return [];
  queries.forEach((query, index) => assertBindable(query, `batch の ${index + 1} 番目の文`));
  const results = await d1.batch(queries.map((query) => prepare(d1, query)));
  return results.map((result) => ({ rows: result.results, changes: result.meta.changes }));
}
