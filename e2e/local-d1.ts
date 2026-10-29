// e2e が手元の D1 に直に SQL を流す。テストが変えた seed の行のうち、API に戻す操作の無いもの（ログアウトで消したセッション、
// 承諾や取り消しで閉じた招待）を、繰り返し（--repeat-each）と並べて走るほかのテストのために seed の状態へ戻すときだけ使う。
// 画面と API の振る舞いは本物の操作で確かめ、ここでは確かめない。
// --local だけを付ける（本番の D1 には流さない。scripts/db-seed.ts と同じ）。e2e の Worker（wrangler dev）と同じ手元の D1 に当たる
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessionInserts } from '../scripts/seed.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';

const run = promisify(execFile);

// 文を1回の wrangler d1 execute で流す。値は呼ぶ側が固定の seed の値だけを埋める（外から来た文字は埋めない）。
// SQL は --command= に続けて1つの引数で渡す（別の引数にすると、- で始まる文を wrangler がフラグと読みうる）。
// 固まったときにテストの上限まで待たないよう、20 秒で打ち切る（1回は手元で約 2 秒）。
// 並べて走るほかのテストの片付けと e2e の Worker が同じ手元の D1 のファイルに書くので、SQLITE_BUSY（database is locked）で
// 断られることがある。ここで流す文はどれも何度流しても同じ結果（DELETE、seed の値へ戻す UPDATE、INSERT OR IGNORE）なので、
// 途中まで書かれていても、間を空けて3回まで流し直す
const BUSY_ATTEMPTS = 3;

async function executeLocalD1(sql: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run('wrangler', ['d1', 'execute', 'DB', '--local', `--command=${sql}`], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      return;
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      if (attempt < BUSY_ATTEMPTS && stderr.includes('SQLITE_BUSY')) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      throw new Error(`手元の D1 に SQL を流せなかった: ${stderr.trim()}`, { cause: err });
    }
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

// e2e/members.test.ts が社内ツールに Google で招待するメールアドレス（架空）
export const E2E_GOOGLE_INVITE_EMAIL = 'nagisa.e2e@example.com';

// 社内ツールへの、E2E_GOOGLE_INVITE_EMAIL への Google の招待（承諾待ちも取り消し済みも）と、その変更の履歴を消す。
// 招待は人数と承諾待ちの一覧に出るので、繰り返しとほかのテストのために seed の状態（この招待が無い）へ戻す。
// 外部キーの向きに合わせ、変更の履歴を先に消す
export async function removeE2eGoogleInvitations(): Promise<void> {
  const invitations =
    `SELECT id FROM invitations WHERE workspace_id = '${HIBARI_TOOLS_WORKSPACE_ID}' ` +
    `AND login_provider = 'google' AND login_email = '${E2E_GOOGLE_INVITE_EMAIL}'`;
  await executeLocalD1(
    [
      `DELETE FROM change_logs WHERE organization_id = '${HIBARI_ORGANIZATION_ID}' ` +
        `AND entity_type = 'invitation' AND entity_id IN (${invitations});`,
      `DELETE FROM invitations WHERE id IN (${invitations});`,
    ].join('\n'),
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

// パスワードでのログインのレート制限の行（`password:<IP>`、`password48:<…>`、`password-email:<ハッシュ>`）を消す。
// パスワードのログインの e2e（e2e/password-login.test.ts）が、繰り返し（--repeat-each）で同じメールアドレスと IP の枠
// （10分に10回、30回）を使い切らないよう、場面ごとに消す。ほかの e2e はパスワードのログインを使わない
export async function resetPasswordLoginRateLimits(): Promise<void> {
  await executeLocalD1(`DELETE FROM rate_limits WHERE key LIKE 'password%';`);
}

// seed のセッションの行を、無ければ入れ直す（あればそのまま）。ログアウトの e2e が消す専用の行を、消す前に戻すのに使う
export async function restoreSeedSession(who: keyof typeof SEED_SESSIONS): Promise<void> {
  // 列と期限は seed（scripts/seed.ts の sessionInserts）と同じ文を使い、あれば残すよう INSERT OR IGNORE にだけ替える
  const insert = sessionInserts([SEED_SESSIONS[who]], new Date());
  if (!insert.startsWith('INSERT INTO sessions ')) throw new Error('sessionInserts の文の形が変わった');
  await executeLocalD1(insert.replace(/^INSERT INTO /, 'INSERT OR IGNORE INTO '));
}
