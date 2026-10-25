// /api/health の疎通。共通の入口で SELECT 1 を送る
import { sql } from 'kysely';
import { commonDb } from './entries.ts';

// 送るのに失敗したことだけを表す。文の組み立ての誤りは、これに包まず呼び出し側へそのまま投げる
export class DatabaseUnavailableError extends Error {
  constructor(cause: unknown) {
    super('database unavailable', { cause });
    this.name = 'DatabaseUnavailableError';
  }
}

export async function pingDatabase(env: Env): Promise<void> {
  const db = commonDb(env);
  const statement = db.statement((q) => q.selectNoFrom(sql<number>`1`.as('ok')));
  try {
    await db.first(statement);
  } catch (cause) {
    throw new DatabaseUnavailableError(cause);
  }
}
