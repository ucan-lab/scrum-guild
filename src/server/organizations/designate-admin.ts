// 運用者による管理者の指名の書き込み（組織の DB の users と change_logs）。組織の作成の最初の管理者と、
// 管理者の指名し直し（Issue #60）が同じ関数を使う。
// 入口は確かめた組織の OrganizationDb。組織の ID はそこから取り、呼び出し側の入力から取らない。
// account_id は、指名する人が既にアカウントを持つとき（共通の DB の account_logins に当たったとき）に呼び出し側が渡す。
// 共通の表は別の入口で読んで渡し、この書き込みの batch() に共通の表を混ぜない（docs/data-model.md の「読み書きの入口」）
import type { OrganizationDb, Statement } from '../db/index.ts';
import { uuidv7 } from '../uuid.ts';

export type AdminNominee = {
  // ログインの手段（`account_logins.login_provider` と同じ値）と、手段の中の不変の ID
  provider: string;
  subject: string;
  // users.name。GitHub はユーザー名
  name: string;
  // 指名する人が既にアカウントを持つときの ID。無ければ null（その人が初めてログインしたときに結ぶ）
  accountId: string | null;
};

export type AdminDesignation = {
  nominee: AdminNominee;
  // 運用者のログインの ID（`github:12345` の形）。change_logs.operator に残す
  operatorLoginId: string;
  now: Date;
};

// 最初の管理者の users と、その指名の change_logs の文。batch() に他の文（組織の作成の change_logs など）と並べて送る
export function adminDesignationStatements(
  db: OrganizationDb,
  designation: AdminDesignation,
): { userId: string; statements: [Statement<'organization'>, Statement<'organization'>] } {
  const { nominee, operatorLoginId, now } = designation;
  const at = now.toISOString();
  const userId = uuidv7(now.getTime());
  return {
    userId,
    statements: [
      db.statement((q) =>
        q.insertInto('users').values({
          id: userId,
          organization_id: db.organizationId,
          account_id: nominee.accountId,
          login_provider: nominee.provider,
          login_subject: nominee.subject,
          name: nominee.name,
          is_admin: 1,
          created_at: at,
          updated_at: at,
        }),
      ),
      db.statement((q) =>
        q.insertInto('change_logs').values({
          id: uuidv7(now.getTime()),
          organization_id: db.organizationId,
          actor_user_id: null,
          operator: operatorLoginId,
          entity_type: 'user',
          entity_id: userId,
          action: 'create',
          changes_json: JSON.stringify({
            is_admin: [null, 1],
            name: [null, nominee.name],
            login_provider: [null, nominee.provider],
            login_subject: [null, nominee.subject],
          }),
          created_at: at,
        }),
      ),
    ],
  };
}

// 管理者を指名する。users と change_logs を1回の batch() で書く
export async function designateAdmin(db: OrganizationDb, designation: AdminDesignation): Promise<{ userId: string }> {
  const { userId, statements } = adminDesignationStatements(db, designation);
  await db.batch(statements);
  return { userId };
}
