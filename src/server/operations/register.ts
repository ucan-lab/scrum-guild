// 操作の一覧を Hono のルートに登録する1つの関数。順に行うこと（docs/development.md の「操作の定義」）:
// Origin の検査 → セッションの読み取り → 組織の確かめと権限の検査 → 入力の検証 → ワークスペースの確かめと権限の検査 → 処理 → 出力の検証。
// 入力に workspace_id がある操作では、ワークスペースの確かめは入力の検証の後になる
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { isOutsideOperation, isWorkspaceOperation } from '../../shared/operations/define.ts';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../../shared/session-cookie.ts';
import type { AppEnv } from '../app-env.ts';
import { accountLogins } from '../auth/account-logins.ts';
import { isOperator, operatorLoginIds } from '../auth/operators.ts';
import { readSession } from '../auth/session.ts';
import { commonDb, enterOrganization, verifyWorkspace } from '../db/index.ts';
import { ApiError, errorBody, knownError } from '../errors.ts';
import { readInput, requireOrigin } from './guards.ts';
import type { ImplementedOperation } from './implement.ts';
import { logOperation } from './operation-log.ts';

const MAX_BODY_BYTES = 1024 * 1024;

// ログに残す、リクエストの途中で分かった値
type Trace = { organizationId: string | null; userId: string | null; accountId: string | null };

// 処理に渡す文脈の型は implement() が定義から決めている。ここでは型を消して呼ぶ
type Handler = (context: unknown) => Promise<unknown>;

export function operationsApp(operations: readonly ImplementedOperation[]): Hono<AppEnv> {
  const names = new Set<string>();
  const app = new Hono<AppEnv>();
  for (const operation of operations) {
    const { name } = operation.definition;
    if (names.has(name)) throw new Error(`操作の名前が重なっている（${name}）`);
    names.add(name);
    const path = isOutsideOperation(operation.definition) ? `/${name}` : `/:slug/${name}`;
    app.post(
      path,
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json(errorBody('invalid_input', 'payload too large'), 413),
      }),
      (c) => handleOperation(c, operation),
    );
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
      requestId: c.req.header('cf-ray') ?? crypto.randomUUID(),
      operation: operation.definition.name,
      ...trace,
      code,
      status,
      durationMs: Date.now() - startedAt,
    });
  }
}

async function execute(c: Context<AppEnv>, operation: ImplementedOperation, trace: Trace): Promise<Response> {
  const { definition } = operation;
  const handler = operation.handler as Handler;

  requireOrigin(c);

  const token = getCookie(c, SESSION_COOKIE_NAME);
  const session = await readSession(c.env, token, new Date());
  if (session === undefined) throw new ApiError(401, 'unauthenticated');
  trace.accountId = session.accountId;
  // 使うたびに期限を延ばす。DB の expires_at を書き直したときは Cookie の期限も同じだけ延ばす
  if (session.refreshed && token !== undefined) setCookie(c, SESSION_COOKIE_NAME, token, sessionCookieOptions);

  let result: unknown;
  if (isOutsideOperation(definition)) {
    if (definition.permission === 'operator') {
      // 設定の誤りは app のミドルウェアが先に 500 にしている。ここに来る一覧は解釈できている
      const operators = operatorLoginIds(c.env);
      const logins = await accountLogins(c.env, session.accountId);
      if (!operators.ok || !isOperator(operators.ids, logins)) throw new ApiError(403, 'forbidden');
    }
    const input = await readInput(c, definition.input);
    result = await handler({ db: commonDb(c.env), accountId: session.accountId, input });
  } else {
    // 運用者かどうかは組織に入れるかを変えない。入れる組織が無い運用者は、組織が無いときと同じ 404 になる
    const slug = c.req.param('slug');
    if (slug === undefined) throw new ApiError(404, 'not_found');
    const logins = await accountLogins(c.env, session.accountId);
    const entry = await enterOrganization(c.env, slug, { accountId: session.accountId, logins });
    if (entry === undefined) throw new ApiError(404, 'not_found');
    const { db, actor } = entry;
    trace.organizationId = db.organizationId;
    trace.userId = actor.userId;
    if (definition.permission === 'admin' && !actor.isAdmin) throw new ApiError(403, 'forbidden');

    const input = await readInput(c, definition.input);
    if (isWorkspaceOperation(definition)) {
      // 別の組織のワークスペースは、存在しないときと同じ 404
      const workspace = await verifyWorkspace(db, actor, (input as { workspace_id: string }).workspace_id);
      if (workspace === undefined) throw new ApiError(404, 'not_found');
      // 管理者は所属していないワークスペースでも、リーダーと同じ操作ができる
      const allowed =
        actor.isAdmin ||
        (definition.permission === 'leader'
          ? workspace.actorRole === 'leader'
          : definition.permission === 'member'
            ? workspace.actorRole !== null
            : false);
      if (!allowed) throw new ApiError(403, 'forbidden');
      result = await handler({ db, actor, input, workspace });
    } else {
      result = await handler({ db, actor, input });
    }
  }

  return c.json(definition.output.parse(result));
}
