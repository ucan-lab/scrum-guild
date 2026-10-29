// e2e が手元の D1 に直に SQL を流す。テストが変えた seed の行のうち、API に戻す操作の無いもの（ログアウトで消したセッション、
// 承諾や取り消しで閉じた招待）を、繰り返し（--repeat-each）と並べて走るほかのテストのために seed の状態へ戻すときだけ使う。
// 画面と API の振る舞いは本物の操作で確かめ、ここでは確かめない。
// --local だけを付ける（本番の D1 には流さない。scripts/db-seed.ts と同じ）。e2e の Worker（wrangler dev）と同じ手元の D1 に当たる
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tokenHash } from '../scripts/seed.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';

const run = promisify(execFile);

// 文を1回の wrangler d1 execute で流す。値は呼ぶ側が固定の seed の値だけを埋める（外から来た文字は埋めない）。
// SQL は --command= に続けて1つの引数で渡す（別の引数にすると、- で始まる文を wrangler がフラグと読みうる）。
// 固まったときにテストの上限まで待たないよう、20 秒で打ち切る（1回は手元で約 2 秒）
async function executeLocalD1(sql: string): Promise<void> {
  try {
    await run('wrangler', ['d1', 'execute', 'DB', '--local', `--command=${sql}`], {
      encoding: 'utf8',
      timeout: 20_000,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`手元の D1 に SQL を流せなかった: ${stderr.trim()}`, { cause: err });
  }
}

// seed/data.sql の行の ID
const HIBARI_ORGANIZATION_ID = '019a0000-0000-7000-8000-000000000202';
const HIBARI_TOOLS_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000402';
const HIBARI_DESIGN_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000404';
// 社内ツールへの kaede--seed の招待（e2e/members.test.ts が取り消す）
const KAEDE_INVITATION_ID = '019a0000-0000-7000-8000-000000000a02';
// デザイン相談室へのヒナタの招待（e2e/invitations.test.ts が承諾する）
const HINATA_INVITATION_ID = '019a0000-0000-7000-8000-000000000a03';

// 取り消した seed の kaede--seed への招待を、承諾待ちに戻す。取り消しが書いた変更の履歴は残す（追記だけの記録で、数えるテストは無い）
export async function restoreKaedeInvitation(): Promise<void> {
  await executeLocalD1(
    `UPDATE invitations SET status = 'pending', responded_at = NULL ` +
      `WHERE id = '${KAEDE_INVITATION_ID}' AND workspace_id = '${HIBARI_TOOLS_WORKSPACE_ID}';`,
  );
}

// ヒナタ（seed/sessions.ts の invitee）の承諾を無かったことにし、seed の状態（ひばり工房に users の行を持たず、
// デザイン相談室への承諾待ちの招待だけがある）へ戻す。承諾が書いた行（users、memberships、change_logs の2行）を消し、招待を承諾待ちに戻す。
// どの文もひばり工房で絞る。外部キーの向きに合わせ、変更の履歴と所属を先に消す
export async function restoreHinataInvitation(): Promise<void> {
  const hinata =
    `SELECT id FROM users WHERE organization_id = '${HIBARI_ORGANIZATION_ID}' ` +
    `AND account_id = '${SEED_SESSIONS.invitee.accountId}'`;
  await executeLocalD1(
    [
      `DELETE FROM change_logs WHERE organization_id = '${HIBARI_ORGANIZATION_ID}' AND actor_user_id IN (${hinata});`,
      `DELETE FROM memberships WHERE workspace_id = '${HIBARI_DESIGN_WORKSPACE_ID}' AND user_id IN (${hinata});`,
      `DELETE FROM users WHERE organization_id = '${HIBARI_ORGANIZATION_ID}' AND account_id = '${SEED_SESSIONS.invitee.accountId}';`,
      `UPDATE invitations SET status = 'pending', responded_at = NULL ` +
        `WHERE id = '${HINATA_INVITATION_ID}' AND workspace_id = '${HIBARI_DESIGN_WORKSPACE_ID}';`,
    ].join('\n'),
  );
}

// セッションの期限。seed（scripts/seed.ts）と同じく入れた時刻から30日
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

// seed のセッションの行を、無ければ入れ直す（あればそのまま）。ログアウトの e2e が消す専用の行を、消す前に戻すのに使う
export async function restoreSeedSession(who: keyof typeof SEED_SESSIONS): Promise<void> {
  const session = SEED_SESSIONS[who];
  const now = new Date();
  const at = now.toISOString();
  const expires = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
  await executeLocalD1(
    `INSERT OR IGNORE INTO sessions (token_hash, account_id, created_at, last_used_at, expires_at) VALUES ` +
      `('${tokenHash(session.token)}', '${session.accountId}', '${at}', '${at}', '${expires}');`,
  );
}
