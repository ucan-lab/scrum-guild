// 表の列を TypeScript の定数で持つための部品。Kysely の表の型は、この定数から導く。
// 定数がマイグレーションの列と合っているかは test/table-columns.test.ts が PRAGMA table_info と照合する
import type { Generated } from 'kysely';

export type ColumnSpec = {
  readonly type: 'text' | 'integer' | 'real';
  // NULL を許す列。INSERT では省ける
  readonly nullable: boolean;
  // NOT NULL で DEFAULT のある列。INSERT では省ける
  readonly hasDefault: boolean;
};

export type TableSpec = Readonly<Record<string, ColumnSpec>>;

export const text = { type: 'text', nullable: false, hasDefault: false } as const;
export const textOrNull = { type: 'text', nullable: true, hasDefault: false } as const;
export const textDefault = { type: 'text', nullable: false, hasDefault: true } as const;
export const integer = { type: 'integer', nullable: false, hasDefault: false } as const;
export const integerOrNull = { type: 'integer', nullable: true, hasDefault: false } as const;
export const integerDefault = { type: 'integer', nullable: false, hasDefault: true } as const;
export const real = { type: 'real', nullable: false, hasDefault: false } as const;

type ValueOf<C extends ColumnSpec> = C['type'] extends 'text' ? string : number;

type ColumnOf<C extends ColumnSpec> = C['nullable'] extends true
  ? ValueOf<C> | null
  : C['hasDefault'] extends true
    ? Generated<ValueOf<C>>
    : ValueOf<C>;

type TableOf<T extends TableSpec> = { -readonly [K in keyof T]: ColumnOf<T[K]> };

export type DatabaseOf<D extends Readonly<Record<string, TableSpec>>> = { -readonly [K in keyof D]: TableOf<D[K]> };
