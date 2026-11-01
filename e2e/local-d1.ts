// e2e が手元の D1 に直に SQL を流す。テストが変えた seed の行のうち、API に戻す操作の無いもの（ログアウトで消したセッション、
// 承諾や取り消しで閉じた招待）を、繰り返し（--repeat-each）と並べて走るほかのテストのために seed の状態へ戻すときだけ使う。
// 画面と API の振る舞いは本物の操作で確かめ、ここでは確かめない。
// localhost の wrangler dev（e2e の Worker）にしか送らない（本番の D1 には届かない。scripts/db-seed.ts の --local と同じ）。
// wrangler d1 execute --local は別プロセスで同じ SQLite のファイルを開き、Worker と取り合って双方に SQLITE_BUSY が出るので使わない（#501）。
// wrangler dev の手元のエクスプローラーなら、同じ workerd の中で Worker と同じ D1 のオブジェクトが文を順に流す
import { devPorts } from '../scripts/dev-ports.ts';
import { sessionInserts } from '../scripts/seed.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';

const EXPLORER_D1_URL = `http://localhost:${devPorts(process.env).api}/cdn-cgi/local/explorer/api/d1/database`;
const D1_BINDING = 'DB';
// 固まったときにテストの上限まで待たないよう、20 秒で打ち切る（1回は手元で数十ミリ秒）
const REQUEST_TIMEOUT_MS = 20_000;
const EXPLORER_HINT =
  '404 ならエクスプローラーが無効か口が変わった。X_LOCAL_EXPLORER と miniflare の版を見る（docs/development.md の「e2e の書き方」）';

type ExplorerBody = { success?: boolean; errors?: { message?: string }[]; result?: unknown };

// 応答の全文は貼らない。HTTP ステータスと success の両方を見て、エラーは message だけを出す
async function callExplorer(url: string, init: RequestInit, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`${what}: エクスプローラーにつながらなかった（${url}）。e2e のサーバーが立っているかを見る`, {
      cause: err,
    });
  }
  const body = (await response.json().catch(() => undefined)) as ExplorerBody | undefined;
  // SQL のエラーは HTTP 500 と success: false で返る（miniflare 5.20261019.2-beta）ので、どちらでも message を添える
  const messages = (body?.errors ?? []).map((e) => e.message ?? '(message なし)').join(' / ');
  const detail = messages === '' ? '' : `: ${messages}`;
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status}${detail}。${response.status === 404 ? EXPLORER_HINT : ''}`);
  }
  if (body?.success !== true) {
    throw new Error(`${what}: success が true でない${detail}`);
  }
  return body.result;
}

// binding DB の database_id。無い ID を渡すとエクスプローラーは空の D1 を新しく作って成功を返すので、決め打ちせず一覧から引く。
// 引けなかったときは Promise を捨て、次の呼び出しで引き直す
let databaseId: Promise<string> | undefined;

function findDatabaseId(): Promise<string> {
  databaseId ??= (async () => {
    const result = await callExplorer(EXPLORER_D1_URL, {}, '手元の D1 の一覧を引けなかった');
    const found = (Array.isArray(result) ? (result as { name?: string; uuid?: string }[]) : []).find(
      (database) => database.name === D1_BINDING,
    );
    if (found?.uuid === undefined) {
      throw new Error(`手元の D1 の一覧に binding ${D1_BINDING} が無い`);
    }
    return found.uuid;
  })().catch((err: unknown) => {
    databaseId = undefined;
    throw err;
  });
  return databaseId;
}

// 文を1つの batch（1つのトランザクション）で流す。値は呼ぶ側が固定の seed の値だけを埋める（外から来た文字は埋めない）。
// ここで流す文はどれも何度流しても同じ結果（DELETE、seed の値へ戻す UPDATE、INSERT OR IGNORE）
async function executeLocalD1(statements: string[]): Promise<void> {
  const id = await findDatabaseId();
  await callExplorer(
    `${EXPLORER_D1_URL}/${id}/raw`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: statements.map((sql) => ({ sql })) }),
    },
    `手元の D1 に SQL を流せなかった（${statements.join(' ').slice(0, 80)}…）`,
  );
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
  await executeLocalD1([
    `UPDATE invitations SET status = 'pending', responded_at = NULL ` +
      `WHERE id = '${KAEDE_INVITATION_ID}' AND workspace_id = '${HIBARI_TOOLS_WORKSPACE_ID}';`,
  ]);
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
  await executeLocalD1([
    `DELETE FROM change_logs WHERE organization_id = '${HIBARI_ORGANIZATION_ID}' ` +
      `AND entity_type = 'invitation' AND entity_id IN (${invitations});`,
    `DELETE FROM invitations WHERE id IN (${invitations});`,
  ]);
}

// ヒナタ（seed/sessions.ts の invitee）の承諾を無かったことにし、seed の状態（ひばり工房に users の行を持たず、
// デザイン相談室への承諾待ちの招待だけがある）へ戻す。承諾が書いた行（users、memberships、change_logs の2行）を消し、招待を承諾待ちに戻す。
// どの文もひばり工房で絞る。外部キーの向きに合わせ、変更の履歴と所属を先に消す
export async function restoreHinataInvitation(): Promise<void> {
  const hinata =
    `SELECT id FROM users WHERE organization_id = '${HIBARI_ORGANIZATION_ID}' ` +
    `AND account_id = '${SEED_SESSIONS.invitee.accountId}'`;
  await executeLocalD1([
    `DELETE FROM change_logs WHERE organization_id = '${HIBARI_ORGANIZATION_ID}' AND actor_user_id IN (${hinata});`,
    `DELETE FROM memberships WHERE workspace_id = '${HIBARI_DESIGN_WORKSPACE_ID}' AND user_id IN (${hinata});`,
    `DELETE FROM users WHERE organization_id = '${HIBARI_ORGANIZATION_ID}' AND account_id = '${SEED_SESSIONS.invitee.accountId}';`,
    `UPDATE invitations SET status = 'pending', responded_at = NULL ` +
      `WHERE id = '${HINATA_INVITATION_ID}' AND workspace_id = '${HIBARI_DESIGN_WORKSPACE_ID}';`,
  ]);
}

// パスワードでのログインのレート制限の行（`password:<IP>`、`password48:<…>`、`password-email:<ハッシュ>`）を消す。
// パスワードのログインの e2e（e2e/password-login.test.ts）が、繰り返し（--repeat-each）で同じメールアドレスと IP の枠
// （10分に10回、30回）を使い切らないよう、場面ごとに消す。ほかの e2e はパスワードのログインを使わない
export async function resetPasswordLoginRateLimits(): Promise<void> {
  await executeLocalD1([`DELETE FROM rate_limits WHERE key LIKE 'password%';`]);
}

// seed のセッションの行を、無ければ入れ直す（あればそのまま）。ログアウトの e2e が消す専用の行を、消す前に戻すのに使う
export async function restoreSeedSession(who: keyof typeof SEED_SESSIONS): Promise<void> {
  // 列と期限は seed（scripts/seed.ts の sessionInserts）と同じ文を使い、あれば残すよう INSERT OR IGNORE にだけ替える
  const insert = sessionInserts([SEED_SESSIONS[who]], new Date());
  if (!insert.startsWith('INSERT INTO sessions ')) throw new Error('sessionInserts の文の形が変わった');
  await executeLocalD1([insert.replace(/^INSERT INTO /, 'INSERT OR IGNORE INTO ')]);
}

// パスワードのログインで作られたアカウント（手段 `password`）の同意の行を消す。seed のパスワードの人（seed/passwords.ts）は
// 初めてのログインでアカウントができ、同意の行を持たない。同意まで通した後の繰り返し（--repeat-each）でも、
// ログインの直後に同意の画面へ移る状態から始めるため、パスワードのログインの e2e（e2e/password-login.test.ts）が場面ごとに使う
export async function resetPasswordAccountConsents(): Promise<void> {
  await executeLocalD1([
    `DELETE FROM account_consents WHERE account_id IN (SELECT account_id FROM account_logins WHERE login_provider = 'password');`,
  ]);
}

// seed のセッションのアカウントの同意の行を消し、未同意の状態へ戻す。同意の e2e（e2e/consent.test.ts）が、
// 繰り返し（--repeat-each）で毎回「未同意」から始めるため、テストの前と後に使う。同意の行は追記だけで API に消す操作が無い
export async function resetAccountConsents(who: keyof typeof SEED_SESSIONS): Promise<void> {
  await executeLocalD1([`DELETE FROM account_consents WHERE account_id = '${SEED_SESSIONS[who].accountId}';`]);
}

const CONSENT_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const CONSENT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// seed のセッションのアカウントに、旧い版の同意の行を1つ入れる（今の版に同意していないが、前の版には同意した人にする）。
// 前の版に同意した人への「改めました」の案内の e2e（e2e/consent.test.ts）が使う。呼ぶ前後に resetAccountConsents で行を消す。
// SQL に埋める値は呼ぶ側の固定の値だけだが、形を確かめて、外から来た文字を埋めない約束を守る
export async function seedOldAccountConsent(
  who: keyof typeof SEED_SESSIONS,
  consent: { termsVersion: string; privacyVersion: string; consentedAt: string },
): Promise<void> {
  const { termsVersion, privacyVersion, consentedAt } = consent;
  if (!CONSENT_VERSION.test(termsVersion) || !CONSENT_VERSION.test(privacyVersion) || !CONSENT_AT.test(consentedAt)) {
    throw new Error('旧い同意の行の版は YYYY-MM-DD、日時は ISO 8601（ミリ秒つきの UTC）で渡す');
  }
  await executeLocalD1([
    `INSERT OR IGNORE INTO account_consents (account_id, terms_version, privacy_version, consented_at) ` +
      `VALUES ('${SEED_SESSIONS[who].accountId}', '${termsVersion}', '${privacyVersion}', '${consentedAt}');`,
  ]);
}
