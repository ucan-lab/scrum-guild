// 操作の一覧を Hono のルートに登録する1つの関数。順に行うこと（docs/development.md の「操作の定義」）:
// Origin の検査 → セッションの読み取り → 組織の確かめと権限の検査 → 入力の検証 → ワークスペースの確かめと権限の検査 → 処理 → 出力の検証。
// 入力に workspace_id がある操作では、ワークスペースの確かめは入力の検証の後になる
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  assertOperationDefinition,
  isOutsideOperation,
  isWorkspaceOperation,
  type Permission,
} from '../../shared/operations/define.ts';
import { sessionCookieName, sessionCookieOptions } from '../../shared/session-cookie.ts';
import type { AppEnv } from '../app-env.ts';
import { accountLogins } from '../auth/account-logins.ts';
import { outsideAccount } from './account.ts';
import { isOperator, operatorLoginIds } from '../auth/operators.ts';
import { readSession } from '../auth/session.ts';
import {
  assertVerifiedWorkspace,
  commonDb,
  enterOrganization,
  verifyWorkspace,
  type OrganizationActor,
  type VerifiedWorkspace,
} from '../db/index.ts';
import { ApiError, knownError } from '../errors.ts';
import { readInput, requireOrigin } from './guards.ts';
import type { ImplementedOperation } from './implement.ts';
import { logOperation } from './operation-log.ts';

// ログに残す、リクエストの途中で分かった値
type Trace = { organizationId: string | null; userId: string | null; accountId: string | null };

// 処理に渡す文脈の型は implement() が定義から決めている。ここでは型を消して呼ぶ
type Handler = (context: unknown) => Promise<unknown>;

function unreachable(value: never): never {
  throw new Error(`扱っていない権限: ${String(value)}`);
}

// 定義が型の検査を抜けていても、登録のときに落とす。権限の分岐に知らない値が来たまま動かさない
export function operationsApp(operations: readonly ImplementedOperation[]): Hono<AppEnv> {
  const names = new Set<string>();
  const app = new Hono<AppEnv>();
  for (const operation of operations) {
    assertOperationDefinition(operation.definition);
    if (typeof operation.handler !== 'function') throw new Error(`操作 ${operation.definition.name} に処理が無い`);
    const { name } = operation.definition;
    if (names.has(name)) throw new Error(`操作の名前が重なっている（${name}）`);
    names.add(name);
    const path = isOutsideOperation(operation.definition) ? `/${name}` : `/:slug/${name}`;
    app.post(path, (c) => handleOperation(c, operation));
  }
  return app;
}

async function handleOperation(c: Context<AppEnv>, operation: ImplementedOperation): Promise<Response> {
  const startedAt = Date.now();
  const trace: Trace = { organizationId: null, userId: null, accountId: null };
  let status = 200;
  let code = 'ok';
  try {
    return await execute(c, operation, trace);
  } catch (err) {
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

async function execute(c: Context<AppEnv>, operation: ImplementedOperation, trace: Trace): Promise<Response> {
  const { definition } = operation;
  const handler = operation.handler as Handler;

  requireOrigin(c);

  const cookieName = sessionCookieName(c.env.PUBLIC_ORIGIN);
  const token = getCookie(c, cookieName);
  const session = await readSession(c.env, token, new Date(), c.get('requestId'));
  if (session === undefined) throw new ApiError(401, 'unauthenticated');
  trace.accountId = session.accountId;
  // 使うたびに期限を延ばす。DB の expires_at を書き直したときは Cookie の期限も同じだけ延ばす
  if (session.refreshed && token !== undefined) setCookie(c, cookieName, token, sessionCookieOptions);

  let result: unknown;
  if (isOutsideOperation(definition)) {
    if (definition.permission === 'operator') {
      // 設定の誤りは app のミドルウェアが先に 500 にしている。ここに来る一覧は解釈できている
      const operators = operatorLoginIds(c.env);
      const logins = await accountLogins(c.env, session.accountId);
      if (!operators.ok || !isOperator(operators.ids, logins)) throw new ApiError(403, 'forbidden');
    }
    const input = await readInput(c, definition.input);
    result = await handler({
      db: commonDb(c.env),
      accountId: session.accountId,
      account: outsideAccount(c.env, session.accountId),
      input,
    });
  } else {
    // 運用者かどうかは組織に入れるかを変えない。入れる組織が無い運用者は、組織が無いときと同じ 404 になる
    const slug = c.req.param('slug');
    if (slug === undefined) throw new ApiError(404, 'not_found');
    const entry = await enterOrganization(c.env, slug, {
      accountId: session.accountId,
      loadLogins: () => accountLogins(c.env, session.accountId),
    });
    if (entry === undefined) throw new ApiError(404, 'not_found');
    const { db, actor, organization } = entry;
    trace.organizationId = db.organizationId;
    trace.userId = actor.userId;
    checkOrganizationPermission(definition.permission, actor);

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
      result = await handler({ db, actor, organization, input, workspace });
    } else {
      result = await handler({ db, actor, organization, input });
    }
  }

  // 検証した値（スキーマの変換を通した出力）をそのまま送る。画面は同じスキーマで検証し直さない
  return c.json(definition.output.parse(result));
}
