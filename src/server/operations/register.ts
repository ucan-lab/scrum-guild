// 操作の一覧を Hono のルートに登録する1つの関数。順に行うこと（docs/development.md の「操作の定義」）:
// 認証（Authorization: Bearer があれば API トークンの読み取り、無ければ Origin の検査とセッションの読み取り）→
// 同意の検査（今の版に同意していなければ 403 の terms_required。skipsConsent の操作は飛ばす）→
// 組織の確かめと権限の検査 → API トークンの範囲の検査 → 回数の上限 →
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
import { readApiToken, type ApiToken } from '../auth/api-token.ts';
import { sessionCookieClearOptions, sessionCookieName, sessionCookieOptions } from '../../shared/session-cookie.ts';
import type { AppEnv } from '../app-env.ts';
import type { InviteeResolver } from '../auth/login-method.ts';
import { githubMethod } from '../auth/login-routes.ts';
import { consumeRateLimit } from '../auth/rate-limit.ts';
import { readSession } from '../auth/session.ts';
import {
  assertVerifiedWorkspace,
  commonDb,
  enterOrganization,
  isSuspendedOrganization,
  verifyWorkspace,
  type OrganizationActor,
  type VerifiedWorkspace,
} from '../db/index.ts';
import { ApiError, knownError } from '../errors.ts';
import { executionContextOf } from '../execution-context.ts';
import { outsideAccount } from './account.ts';
import { isCurrentConsent, latestConsentOf } from './consent.ts';
import { readInput, requireOrigin } from './guards.ts';
import type { CurrentSession, Defer, ImplementedOperation } from './implement.ts';
import { operatorTools, type OperatorTools } from './operator-tools.ts';
import { organizationTools } from './organization-tools.ts';
import { logOperation } from './operation-log.ts';
import { tokenAllows } from './token-scope.ts';

// ログに残す、リクエストの途中で分かった値
type Trace = { organizationId: string | null; userId: string | null; accountId: string | null };

// Authorization: Bearer <値> の値。Bearer の語（大文字小文字を区別する）で始まるヘッダーがあれば API トークンの呼び出しで、
// 値が空でも Bearer の呼び出し（401）。ヘッダーが無いか、ほかの書き方なら undefined（Cookie の呼び出し）
function bearerOf(c: Context<AppEnv>): string | undefined {
  const header = c.req.header('Authorization');
  if (header === undefined) return undefined;
  if (header === 'Bearer') return '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

// API トークンの呼び出しにセッションは無い。セッションを使う操作には cookieOnly を付けて、ここへ来る前に 403 にする。
// 付け忘れた操作が使ったら、別の行を指さずに 500 で落とす
function tokenCall(): CurrentSession {
  const unavailable = (): never => {
    throw new Error('API トークンの呼び出しにセッションは無い（cookieOnly が要る）');
  };
  return {
    get tokenHash(): string {
      return unavailable();
    },
    get createdAt(): string {
      return unavailable();
    },
    clearCookie: unavailable,
  };
}

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
  const bearer = bearerOf(c);
  try {
    return await execute(c, operation, trace, cookie, options, bearer);
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
      credential: bearer === undefined ? 'cookie' : 'token',
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

// API トークンで呼べるかの検査。権限の検査の後、入力を読む前に行う。
// 運用者の操作と cookieOnly の操作は、どのトークンでも 403。write の操作は write のトークンだけ（read のトークンは 403）
function checkTokenScope(definition: AnyOperationDefinition, apiToken: ApiToken | undefined): void {
  if (apiToken === undefined) return;
  if (!tokenAllows(definition, apiToken.scope)) throw new ApiError(403, 'forbidden');
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
  bearer: string | undefined,
): Promise<Response> {
  const { definition } = operation;
  const handler = operation.handler as Handler;

  // Bearer があれば API トークンだけで認証する。無効なら Cookie に落とさず 401。
  // Origin の検査も Cookie の読み取りも延長も消去もしない（ブラウザは Authorization を勝手に付けないので CSRF は成り立たない）
  let apiToken: ApiToken | undefined;
  let session: CurrentSession;
  let accountId: string;
  if (bearer !== undefined) {
    apiToken = await readApiToken(c.env, bearer, new Date());
    if (apiToken === undefined) throw new ApiError(401, 'unauthenticated');
    accountId = apiToken.accountId;
    session = tokenCall();
  } else {
    requireOrigin(c);

    const token = getCookie(c, sessionCookieName(c.env.PUBLIC_ORIGIN));
    const read = await readSession(c.env, token, new Date(), c.get('requestId'));
    if (read === undefined) throw new ApiError(401, 'unauthenticated');
    accountId = read.accountId;
    // 使うたびに期限を延ばす。DB の expires_at を書き直したときは Cookie の期限も同じだけ延ばす（付けるのは応答を作る直前）
    cookie.extend = read.refreshed && token !== undefined;
    session = {
      tokenHash: read.tokenHash,
      createdAt: read.createdAt,
      clearCookie: () => {
        cookie.clear = true;
      },
    };
  }
  trace.accountId = accountId;

  // 今の版に同意していない人は、組織に入る前（存在しない slug も入れない組織も同じ）、トークンの範囲の検査より前に断る。
  // 飛ばせるのは skipsConsent を付けた操作だけ（同意の操作、ログアウト、自分の確かめ）
  if (definition.skipsConsent !== true) {
    const latest = await latestConsentOf(commonDb(c.env), accountId);
    if (!isCurrentConsent(latest)) throw new ApiError(403, 'terms_required');
  }

  const deferred = deferrer(c);
  // 運用者の判定と、アカウントに結んだログインの手段と ID の読み取りは account.ts の1か所。
  // ログインの手段と ID は、使われたときに1回だけ引く。設定の誤りは app のミドルウェアが先に 500 にしている
  const account = outsideAccount(c.env, accountId);
  let result: unknown;
  if (isOutsideOperation(definition)) {
    // 組織の外の操作は、アカウントがあれば入れる組織が無くても通す（入れる組織を失った人も、停止した組織にしか入れない人も）
    // トークンでは運用者の操作と cookieOnly の操作を呼べない。運用者かどうかを引く前に 403 にする
    checkTokenScope(definition, apiToken);
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
    await enforceRateLimit(c, definition, accountId);
    const input = await readInput(c, definition.input);
    result = await handler({
      db: commonDb(c.env),
      accountId,
      account,
      session,
      tokenScope: apiToken?.scope,
      ...(operator === undefined ? {} : { operator }),
      input,
    });
  } else {
    // 運用者かどうかは組織に入れるかを変えない。入れる組織が無い運用者は、組織が無いときと同じ 404 になる
    const slug = c.req.param('slug');
    if (slug === undefined) throw new ApiError(404, 'not_found');
    const entry = await enterOrganization(c.env, slug, { accountId, loadLogins: account.logins });
    // 停止した組織は、停止していなければ入れた人にだけ伝える。入れない人は下の 404（組織があることを漏らさない）
    if (isSuspendedOrganization(entry)) {
      trace.organizationId = entry.organizationId;
      throw new ApiError(403, 'organization_suspended');
    }
    if (entry === undefined) {
      // 入れないときは、組織が無いときと同じ 404（入れる組織が1つも無い人も同じ）
      throw new ApiError(404, 'not_found');
    }
    const { db, actor, organization } = entry;
    // 入れた組織の入口に結ぶ。どの道具も組織の ID を引数に取らない
    const tools = organizationTools(c.env, db, actor, inviteeResolverOf(c, options));
    trace.organizationId = db.organizationId;
    trace.userId = actor.userId;
    checkOrganizationPermission(definition.permission, actor);
    checkTokenScope(definition, apiToken);
    await enforceRateLimit(c, definition, accountId);

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
