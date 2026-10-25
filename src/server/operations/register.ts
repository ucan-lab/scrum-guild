// 操作の一覧を Hono のルートに登録する1つの関数。順に行うこと（docs/development.md の「操作の定義」）:
// Origin の検査 → セッションの読み取り → 組織の確かめと権限の検査（ログインできる条件の確かめを含む）→ 回数の上限 →
// 入力の検証 → ワークスペースの確かめと権限の検査 → 処理 → 出力の検証。
// 入力に workspace_id がある操作では、ワークスペースの確かめは入力の検証の後になる。
// 処理に渡す道具は、運用者の操作には運用者を確かめた後の運用者の道具、組織の中の操作には組織に入れた後の、その組織に結んだ組織の道具
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  assertOperationDefinition,
  isOutsideOperation,
  isWorkspaceOperation,
  type AnyOperationDefinition,
  type Permission,
} from '../../shared/operations/define.ts';
import { sessionCookieClearOptions, sessionCookieName, sessionCookieOptions } from '../../shared/session-cookie.ts';
import type { AppEnv } from '../app-env.ts';
import type { InviteeResolver } from '../auth/login-method.ts';
import { githubMethod } from '../auth/login-routes.ts';
import { consumeRateLimit } from '../auth/rate-limit.ts';
import { deleteSessionsOf, readSession } from '../auth/session.ts';
import {
  assertVerifiedWorkspace,
  commonDb,
  enterOrganization,
  verifyWorkspace,
  type OrganizationActor,
  type VerifiedWorkspace,
} from '../db/index.ts';
import { ApiError, knownError } from '../errors.ts';
import { executionContextOf } from '../execution-context.ts';
import { outsideAccount, type OutsideAccount } from './account.ts';
import { readInput, requireOrigin } from './guards.ts';
import type { Defer, ImplementedOperation } from './implement.ts';
import { operatorTools, type OperatorTools } from './operator-tools.ts';
import { organizationTools } from './organization-tools.ts';
import { logOperation } from './operation-log.ts';

// ログに残す、リクエストの途中で分かった値
type Trace = { organizationId: string | null; userId: string | null; accountId: string | null };

// 処理に渡す文脈の型は implement() が定義から決めている。ここでは型を消して呼ぶ
type Handler = (context: unknown) => Promise<unknown>;

function unreachable(value: never): never {
  throw new Error(`扱っていない権限: ${String(value)}`);
}

// 定義が型の検査を抜けていても、登録のときに落とす。権限の分岐に知らない値が来たまま動かさない
export type OperationsAppOptions = {
  // ログインの手段（GitHub）への通信。運用者の操作と組織の中の操作が GitHub のユーザー名を解決するのに使う。テストが差し替える
  fetcher: typeof fetch;
};

// 運用者の道具と組織の道具に渡す、招待する人の解決器。持つのは GitHub だけ。
// ログインの手段のほかの口（認可の URL、code の確かめ）を処理に渡さないよう、resolveInvitee だけを持つ入れ物に包む
function inviteeResolverOf(
  c: Context<AppEnv>,
  options: OperationsAppOptions,
): (provider: string) => InviteeResolver | undefined {
  return (provider) => {
    if (provider !== 'github') return undefined;
    const method = githubMethod(c, options.fetcher);
    if (method === undefined) return undefined;
    return { resolveInvitee: (reference) => method.resolveInvitee(reference) };
  };
}

export function operationsApp(
  operations: readonly ImplementedOperation[],
  options: OperationsAppOptions,
): Hono<AppEnv> {
  const names = new Set<string>();
  const app = new Hono<AppEnv>();
  for (const operation of operations) {
    assertOperationDefinition(operation.definition);
    if (typeof operation.handler !== 'function') throw new Error(`操作 ${operation.definition.name} に処理が無い`);
    const { name } = operation.definition;
    if (names.has(name)) throw new Error(`操作の名前が重なっている（${name}）`);
    names.add(name);
    const path = isOutsideOperation(operation.definition) ? `/${name}` : `/:slug/${name}`;
    app.post(path, (c) => handleOperation(c, operation, options));
  }
  return app;
}

// このリクエストの応答に付けるセッションの Cookie の状態。付けるのは応答を作る直前の1回で、期限を延ばす（extend）か、
// 消す（clear）かの片方だけ。両方を付けると、同じ名前の Set-Cookie が2本並び（Max-Age 30日と Max-Age=0）、
// 受け取る側の処理の順に頼ることになるので、消すときは延ばす Cookie を付けない
type SessionCookie = { applied: boolean; extend: boolean; clear: boolean };

function applySessionCookie(c: Context<AppEnv>, cookie: SessionCookie): void {
  if (cookie.applied) return;
  cookie.applied = true;
  const name = sessionCookieName(c.env.PUBLIC_ORIGIN);
  if (cookie.clear) {
    deleteCookie(c, name, sessionCookieClearOptions(c.env.PUBLIC_ORIGIN));
    return;
  }
  const token = cookie.extend ? getCookie(c, name) : undefined;
  if (token !== undefined) setCookie(c, name, token, sessionCookieOptions(c.env.PUBLIC_ORIGIN));
}

async function handleOperation(
  c: Context<AppEnv>,
  operation: ImplementedOperation,
  options: OperationsAppOptions,
): Promise<Response> {
  const startedAt = Date.now();
  const trace: Trace = { organizationId: null, userId: null, accountId: null };
  let status = 200;
  let code = 'ok';
  const cookie: SessionCookie = { applied: false, extend: false, clear: false };
  try {
    return await execute(c, operation, trace, cookie, options);
  } catch (err) {
    // 失敗の応答にも、期限を延ばす Cookie と、消す Cookie を付ける（1本だけ。applySessionCookie）
    applySessionCookie(c, cookie);
    const known = knownError(err);
    status = known?.status ?? 500;
    code = known?.code ?? 'internal';
    throw err;
  } finally {
    logOperation({
      requestId: c.get('requestId'),
      operation: operation.definition.name,
      ...trace,
      code,
      status,
      durationMs: Date.now() - startedAt,
    });
  }
}

// 組織に入れた人への、入力の検証より前の検査。承諾待ちの招待だけの人には、招待の操作（invitee）以外を見せない
function checkOrganizationPermission(permission: Permission, actor: OrganizationActor): void {
  if (actor.invitedOnly && permission !== 'invitee') throw new ApiError(404, 'not_found');
  switch (permission) {
    case 'invitee':
    case 'organization':
    case 'member':
    case 'leader':
      return;
    case 'admin':
      if (!actor.isAdmin) throw new ApiError(403, 'forbidden');
      return;
    case 'login':
    case 'operator':
      throw new Error(`組織の外の権限 ${permission} が組織の中の操作に付いている`);
    default:
      return unreachable(permission);
  }
}

// ワークスペースの下の操作の権限。管理者は所属していないワークスペースでも、リーダーと同じ操作ができる
function isAllowedInWorkspace(permission: Permission, actor: OrganizationActor, workspace: VerifiedWorkspace): boolean {
  switch (permission) {
    case 'admin':
      return actor.isAdmin;
    case 'leader':
      return actor.isAdmin || workspace.actorRole === 'leader';
    case 'member':
      return actor.isAdmin || workspace.actorRole !== null;
    case 'login':
    case 'operator':
    case 'invitee':
    case 'organization':
      throw new Error(`権限 ${permission} はワークスペースの下の操作に付けられない`);
    default:
      return unreachable(permission);
  }
}

// ログインできる条件を失った人（入れる組織も届いた招待も無く、運用者でもない人）は、セッションを消し、Cookie も消して 401。
// 組織に入れるかはリクエストのたびに確かめているので、消し忘れても入れはしない（docs/data-model.md の「書き込みの単位」）。
// 判定を走らせるのは、組織の外の操作（定義が skipsLoginAccess を付けたものを除く）と、組織の中の操作で組織に入れなかったとき。
// 運用者は入れる組織が無くても通す。消すのは判定した時刻までに作られたセッションで、判定の後に作られたものは残す
async function requireLoginAccess(
  c: Context<AppEnv>,
  cookie: SessionCookie,
  accountId: string,
  account: OutsideAccount,
): Promise<void> {
  if (await account.isOperator()) return;
  const checkedAt = new Date();
  // 組織の選択と同じ読み取りの結果（account.organizations()。同じリクエストの中で1回だけ引く）。
  // アカウントに結ばれる前の行は数えない。数えると、結ばれる前の行だけの人が、どこにも入れないままセッションを持ち続ける。
  // その人は 401 でセッションが消え、もう一度ログインすると結ばれて入れる
  const { organizations, invitations } = await account.organizations();
  if (organizations.length > 0 || invitations.length > 0) return;
  await deleteSessionsOf(commonDb(c.env), accountId, checkedAt);
  cookie.clear = true;
  throw new ApiError(401, 'unauthenticated');
}

// 定義の rateLimit を、アカウントと操作ごとに数える。権限の検査の後、入力を読む前に行う
async function enforceRateLimit(
  c: Context<AppEnv>,
  definition: AnyOperationDefinition,
  accountId: string,
): Promise<void> {
  const { rateLimit } = definition;
  if (rateLimit === undefined) return;
  const allowed = await consumeRateLimit(
    c.env,
    `operation:${definition.name}:${accountId}`,
    { max: rateLimit.max, windowMs: rateLimit.windowSeconds * 1000 },
    new Date(),
  );
  if (!allowed) throw new ApiError(429, 'rate_limited');
}

async function execute(
  c: Context<AppEnv>,
  operation: ImplementedOperation,
  trace: Trace,
  cookie: SessionCookie,
  options: OperationsAppOptions,
): Promise<Response> {
  const { definition } = operation;
  const handler = operation.handler as Handler;

  requireOrigin(c);

  const cookieName = sessionCookieName(c.env.PUBLIC_ORIGIN);
  const token = getCookie(c, cookieName);
  const session = await readSession(c.env, token, new Date(), c.get('requestId'));
  if (session === undefined) throw new ApiError(401, 'unauthenticated');
  trace.accountId = session.accountId;
  // 使うたびに期限を延ばす。DB の expires_at を書き直したときは Cookie の期限も同じだけ延ばす（付けるのは応答を作る直前）
  cookie.extend = session.refreshed && token !== undefined;

  const deferred = deferrer(c);
  // 運用者の判定と、アカウントに結んだログインの手段と ID の読み取りは account.ts の1か所。
  // ログインの手段と ID は、使われたときに1回だけ引く。設定の誤りは app のミドルウェアが先に 500 にしている
  const account = outsideAccount(c.env, session.accountId);
  let result: unknown;
  if (isOutsideOperation(definition)) {
    // 運用者は入れる組織が無くてもログインできる。それ以外は、入れる組織を失っていればセッションを消して 401。
    // 確かめないのは、定義が skipsLoginAccess を付けた操作（ログアウトなど）だけ。
    // 運用者の権限の検査（403）より前に確かめる（入れる組織を失った非運用者には、403 でなく 401 を返す）
    if (definition.skipsLoginAccess !== true) await requireLoginAccess(c, cookie, session.accountId, account);
    // 運用者の操作には、運用者のログインの ID と運用者の道具を渡す。運用者でなければ 403
    let operator: OperatorTools | undefined;
    if (definition.permission === 'operator') {
      const operatorLoginId = await account.operatorLoginId();
      if (operatorLoginId === undefined) throw new ApiError(403, 'forbidden');
      operator = operatorTools(
        c.env,
        { loginId: operatorLoginId, requestId: c.get('requestId') },
        inviteeResolverOf(c, options),
      );
    }
    await enforceRateLimit(c, definition, session.accountId);
    const input = await readInput(c, definition.input);
    result = await handler({
      db: commonDb(c.env),
      accountId: session.accountId,
      account,
      session: {
        tokenHash: session.tokenHash,
        clearCookie: () => {
          cookie.clear = true;
        },
      },
      ...(operator === undefined ? {} : { operator }),
      input,
    });
  } else {
    // 運用者かどうかは組織に入れるかを変えない。入れる組織が無い運用者は、組織が無いときと同じ 404 になる
    const slug = c.req.param('slug');
    if (slug === undefined) throw new ApiError(404, 'not_found');
    const entry = await enterOrganization(c.env, slug, { accountId: session.accountId, loadLogins: account.logins });
    if (entry === undefined) {
      // この組織に入れないだけか、どの組織にも入れなくなったか。入れる組織があれば、組織が無いときと同じ 404
      await requireLoginAccess(c, cookie, session.accountId, account);
      throw new ApiError(404, 'not_found');
    }
    const { db, actor, organization } = entry;
    // 入れた組織の入口に結ぶ。どの道具も組織の ID を引数に取らない
    const tools = organizationTools(c.env, db, inviteeResolverOf(c, options));
    trace.organizationId = db.organizationId;
    trace.userId = actor.userId;
    checkOrganizationPermission(definition.permission, actor);
    await enforceRateLimit(c, definition, session.accountId);

    const input = await readInput(c, definition.input);
    if (isWorkspaceOperation(definition)) {
      // 別の組織のワークスペースは、存在しないときと同じ 404
      const workspace = await verifyWorkspace(db, actor, (input as { workspace_id: string }).workspace_id);
      if (workspace === undefined) throw new ApiError(404, 'not_found');
      if (!isAllowedInWorkspace(definition.permission, actor, workspace)) throw new ApiError(403, 'forbidden');
      // 閉じたワークスペースは読み取り専用。開き直す操作だけが通る
      if (workspace.closed && definition.mode === 'write' && definition.allowClosed !== true) {
        throw new ApiError(409, 'workspace_closed');
      }
      assertVerifiedWorkspace(workspace);
      result = await handler({ db, actor, organization, tools, input, workspace, defer: deferred.defer });
    } else {
      result = await handler({ db, actor, organization, tools, input, defer: deferred.defer });
    }
  }

  const output = definition.output.parse(result);
  await deferred.settle();
  // Cookie は応答を作る前に付ける（作った後に c.header で足しても、返す応答には載らない）
  applySessionCookie(c, cookie);
  // 検証した値（スキーマの変換を通した出力）をそのまま送る。画面は同じスキーマで検証し直さない
  return c.json(output);
}

// 応答を待たせずに続ける仕事（定義の副作用の書き込み）。ExecutionContext の waitUntil に渡す。
// ExecutionContext が無い環境（テスト）では、応答の前に待つ。失敗はログに例外の名前だけを残し、応答は変えない
function deferrer(c: Context<AppEnv>): { defer: Defer; settle: () => Promise<unknown> } {
  const executionContext = executionContextOf(c);
  const inline: Promise<void>[] = [];
  const defer: Defer = (task) => {
    const done = (async () => task())().then(
      () => undefined,
      (err: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            code: 'internal',
            requestId: c.get('requestId'),
            reason: '応答の後の書き込みに失敗した',
            error: err instanceof Error ? err.name : typeof err,
          }),
        );
      },
    );
    // waitUntil 自身の失敗は隠さない（ExecutionContext の有無の判定だけを executionContextOf に寄せている）
    if (executionContext === undefined) inline.push(done);
    else executionContext.waitUntil(done);
  };
  return { defer, settle: () => Promise.all(inline) };
}
