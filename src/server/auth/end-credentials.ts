// ログインできる条件を失った人の、セッションの削除と API トークンの取り消しを1回の batch() で行う。
// 片方だけ書かれると、セッションは消えたのにトークンが残る（または逆）ので、呼び出し点はこの関数だけを使う。
// 消す・取り消すのは、判定した時刻（checkedAt）までに作られたものだけ。条件は個別の関数（deleteSessionsOf、revokeApiTokensOf）の
// 文を使い、ここには持たない
import { type CommonDb } from '../db/index.ts';
import { revokeApiTokensStatement } from './api-token.ts';
import { deleteSessionsStatement } from './session.ts';

export async function endCredentialsOf(db: CommonDb, accountId: string, checkedAt: Date): Promise<void> {
  await db.batch([
    deleteSessionsStatement(db, accountId, checkedAt),
    revokeApiTokensStatement(db, accountId, checkedAt),
  ]);
}
