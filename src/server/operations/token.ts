// API トークンの発行・一覧・取消の処理（定義は src/shared/operations/session/token.ts）
import { tokenCreate, tokenList, tokenRevoke } from '../../shared/operations/session/index.ts';
import { implement } from './implement.ts';

export const tokenCreateOperation = implement(tokenCreate, async () => {
  throw new Error('未実装');
});

export const tokenListOperation = implement(tokenList, async () => {
  throw new Error('未実装');
});

export const tokenRevokeOperation = implement(tokenRevoke, async () => {
  throw new Error('未実装');
});
