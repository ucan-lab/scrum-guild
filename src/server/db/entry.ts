// 入口の型。共通の表の入口と組織の中の表の入口は、型の引数（表の一覧と範囲）が違うだけで同じ形。
// 文は入口の statement() でしか作れない。batch() は同じ範囲の文しか受け取らず、文を作った入口のインスタンスでしか実行できない
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
  type CompiledQuery,
  type DeleteResult,
  type InsertResult,
  type MergeResult,
  type QueryCreator,
  type UpdateResult,
} from 'kysely';
import { sendBatch, sendOne, type SendResult } from './send.ts';

export type Scope = 'common' | 'organization';

// 書き込みの文（RETURNING の無い INSERT、UPDATE、DELETE）は読める行を持たない。結果は changes で見る
type RowOf<Result> = Result extends InsertResult | UpdateResult | DeleteResult | MergeResult ? never : Result;

// 読める行を持たない文（Row が never）を rows と first に渡せなくする
type Reads<Row> = [Row] extends [never] ? never : unknown;

// 実行できる文の印。#private を持つので、同じ形のオブジェクトや { ...statement } は型の検査を通らない。
// 実行時には、入口が文を作ったときに issued へ結び付けたものだけを受け取る
export class Statement<S extends Scope, Row = unknown> {
  readonly #issued = true;
  // 範囲と行の型を型の側に運ぶだけの印。実行時には持たない
  declare readonly scope?: S;
  declare readonly row?: Row;

  static is(value: unknown): value is Statement<Scope> {
    return typeof value === 'object' && value !== null && #issued in value;
  }
}

// 文を作った入口のインスタンスと、組み立てた SQL。別の入口（同じ範囲の別の組織の入口を含む）の文を実行時に拒むのに使う
const issued = new WeakMap<Statement<Scope>, { owner: object; query: CompiledQuery }>();

export type StatementResult<Row> = { rows: Row[]; changes: number };

type BatchResults<Statements extends readonly Statement<Scope>[]> = {
  [K in keyof Statements]: Statements[K] extends Statement<Scope, infer Row> ? StatementResult<Row> : never;
};

// テストが組み立てた SQL を確かめるのに使う（testing.ts）
export function compiledQueryOf(statement: Statement<Scope>): { sql: string; parameters: readonly unknown[] } {
  const found = issued.get(statement);
  if (found === undefined) throw new Error('入口が作った文ではない');
  return { sql: found.query.sql, parameters: found.query.parameters };
}

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
  readonly #queries: Kysely<DB>;

  constructor(d1: D1Database, queries: Kysely<DB>) {
    this.#d1 = d1;
    this.#queries = queries;
  }

  // 引数の q は、この入口の表だけを型に持つ。別の入口の表を引くとここで型の検査に落ちる
  statement<Result>(build: (q: QueryCreator<DB>) => Compilable<Result>): Statement<S, RowOf<Result>> {
    const statement = new Statement<S, RowOf<Result>>();
    issued.set(statement, { owner: this, query: build(this.#queries).compile() });
    return statement;
  }

  async rows<Row>(statement: Statement<S, Row> & Reads<Row>): Promise<Row[]> {
    return (await this.run(statement)).rows;
  }

  async first<Row>(statement: Statement<S, Row> & Reads<Row>): Promise<Row | undefined> {
    return (await this.run(statement)).rows[0];
  }

  async run<Row>(statement: Statement<S, Row>): Promise<StatementResult<Row>> {
    const result = await sendOne(this.#d1, this.#queryOf(statement));
    return result as StatementResult<Row>;
  }

  // 書き込みはこれで1回に送る。途中の文が失敗すると、前の文も書かれない。
  // changes が 0 の文があっても、後ろの文は書かれる（docs/development.md の「入口を守る規則」）
  async batch<const Statements extends readonly Statement<S>[]>(
    statements: Statements,
  ): Promise<BatchResults<Statements>> {
    const queries = statements.map((statement) => this.#queryOf(statement));
    const results: SendResult[] = await sendBatch(this.#d1, queries);
    return results as unknown as BatchResults<Statements>;
  }

  // 型の検査をキャストで抜けた文（付け替えた文、形だけのオブジェクト、別の入口の文）を、実行時にも止める
  #queryOf(statement: Statement<Scope>): CompiledQuery {
    const found = Statement.is(statement) ? issued.get(statement) : undefined;
    if (found === undefined || found.owner !== this) throw new Error('この入口が作った文ではない');
    return found.query;
  }
}
