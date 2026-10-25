// 運用者だけの操作の定義（permission: 'operator'）。運用者の権限を決める定義なので、人が差分を読む領域（docs/development.md の「マージの判定」）。
// 本物の操作は組織の作成などの Issue で足す
import type { AnyOperationDefinition } from '../define.ts';

export const operatorOperations: readonly AnyOperationDefinition[] = [];
