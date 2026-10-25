// 入口の型。共通の表の入口と組織の中の表の入口は、型の引数（表の一覧と範囲）が違うだけで同じ形。
// 文は入口の statement() でしか作れず、範囲（common か organization）を持つ。batch() は同じ範囲の文しか受け取らない
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
  type CompiledQuery,
  type QueryCreator,
} from 'kysely';
import { sendBatch, sendOne, type SendResult } from './send.ts';

export type Scope = 'common' | 'organization';

export class Statement<S extends Scope, Row = unknown> {
  readonly scope: S;
  readonly query: CompiledQuery;
  // 行の型を型の側に運ぶだけの印。実行時には持たない
  declare readonly row?: Row;

  constructor(scope: S, query: CompiledQuery) {
    this.scope = scope;
    this.query = query;
  }
}

export type StatementResult<Row> = { rows: Row[]; changes: number };

type BatchResults<Statements extends readonly Statement<Scope>[]> = {
  [K in keyof Statements]: Statements[K] extends Statement<Scope, infer Row> ? StatementResult<Row> : never;
};

// 組み立てだけに使う Kysely。ドライバーは何も送らないので、ここから execute() しても D1 には届かない
export function compileOnlyKysely<DB>(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}

export class DbEntry<DB, S extends Scope> {
  readonly #d1: D1Database;
  readonly #scope: S;
  readonly #queries: Kysely<DB>;

  constructor(d1: D1Database, scope: S, queries: Kysely<DB>) {
    this.#d1 = d1;
    this.#scope = scope;
    this.#queries = queries;
  }

  // 引数の q は、この入口の表だけを型に持つ。別の入口の表を引くとここで型の検査に落ちる
  statement<Row>(build: (q: QueryCreator<DB>) => Compilable<Row>): Statement<S, Row> {
    return new Statement(this.#scope, build(this.#queries).compile());
  }

  async rows<Row>(statement: Statement<S, Row>): Promise<Row[]> {
    return (await this.run(statement)).rows;
  }

  async first<Row>(statement: Statement<S, Row>): Promise<Row | undefined> {
    return (await this.run(statement)).rows[0];
  }

  async run<Row>(statement: Statement<S, Row>): Promise<StatementResult<Row>> {
    this.#assertOwn(statement);
    const result = await sendOne(this.#d1, statement.query);
    return result as StatementResult<Row>;
  }

  // 書き込みはこれで1回に送る。途中の文が失敗すると、前の文も書かれない
  async batch<const Statements extends readonly Statement<S>[]>(
    statements: Statements,
  ): Promise<BatchResults<Statements>> {
    statements.forEach((statement) => this.#assertOwn(statement));
    const results: SendResult[] = await sendBatch(
      this.#d1,
      statements.map((statement) => statement.query),
    );
    return results as unknown as BatchResults<Statements>;
  }

  // 型の検査をキャストで抜けた文を、実行時にも止める
  #assertOwn(statement: Statement<Scope>): void {
    if (statement.scope !== this.#scope) {
      throw new Error(`${statement.scope} の文を ${this.#scope} の入口で実行できない`);
    }
  }
}
