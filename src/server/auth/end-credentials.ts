// ログインできる条件を失った人の、セッションの削除と API トークンの取り消しを1回の batch() で行う。
// 片方だけ書かれると、セッションは消えたのにトークンが残る（または逆）ので、呼び出し点はこの関数だけを使う
import { type CommonDb } from '../db/index.ts';

// 消す・取り消すのは、判定した時刻（checkedAt）までに作られたものだけ。判定の後に作られたものは残す
// （deleteSessionsOf と revokeApiTokensOf の条件と同じ。個別の関数は、片方だけを使う呼び出しと、そのテストが使う）
export async function endCredentialsOf(db: CommonDb, accountId: string, checkedAt: Date): Promise<void> {
  const checked = checkedAt.toISOString();
  await db.batch([
    db.statement((q) =>
      q.deleteFrom('sessions').where('account_id', '=', accountId).where('created_at', '<=', checked),
    ),
    db.statement((q) =>
      q
        .updateTable('api_tokens')
        .set({ revoked_at: new Date().toISOString() })
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .where('created_at', '<=', checked),
    ),
  ]);
}
