// 操作の一覧を回して、組織の分離と権限を確かめる仕組み。新しい操作を一覧に足しても、テストを書き足す必要はない。
// 足すのは、組織の中の操作ごとのテスト用の関数（Pointer）だけで、足し忘れるとテストが落ちる
import { beforeAll, describe, expect, test } from 'vitest';
import { isOutsideOperation, operationPath, type AnyOperationDefinition } from '../../src/shared/operations/define.ts';
import { SESSION_COOKIE_NAME } from '../../src/shared/session-cookie.ts';
import { createApp } from '../../src/server/app.ts';
import type { ImplementedOperation } from '../../src/server/operations/implement.ts';
import { createTarget, getOperator, testEnv, type Person, type Target } from './world.ts';

// 対象の組織の行を指す、成功する入力を作る。別の組織の対象を渡すと、同じ入力が 404 になる。
// 入力が組織の中の行を指さない操作は、成功する入力を noReference に書く（分離の検査はスラッグだけになる）
export type Pointer = ((target: Target) => Promise<unknown>) | { noReference: unknown };
export type Pointers = Readonly<Record<string, Pointer>>;

// テスト用の関数の無い組織の中の操作と、操作の無い関数があれば落とす
export function assertPointersCover(operations: readonly ImplementedOperation[], pointers: Pointers): void {
  const names = operations.map((operation) => operation.definition.name);
  const missing = operations
    .filter((operation) => !isOutsideOperation(operation.definition))
    .map((operation) => operation.definition.name)
    .filter((name) => !(name in pointers));
  if (missing.length > 0) {
    throw new Error(
      `組織の分離のテスト用の関数が無い操作: ${missing.join(', ')}（test/operations/pointers.ts に足す）`,
    );
  }
  const stale = Object.keys(pointers).filter((name) => !names.includes(name));
  if (stale.length > 0) throw new Error(`一覧に無い操作のテスト用の関数: ${stale.join(', ')}`);
}

type PostOptions = {
  slug?: string;
  token?: string;
  // null は Origin を付けない。省略は公開する URL
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
};

export function post(
  app: ReturnType<typeof createApp>,
  definition: AnyOperationDefinition,
  options: PostOptions = {},
): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json', ...options.headers });
  const origin = options.origin === undefined ? testEnv.PUBLIC_ORIGIN : options.origin;
  if (origin !== null) headers.set('Origin', origin);
  if (options.token !== undefined) headers.set('Cookie', `${SESSION_COOKIE_NAME}=${options.token}`);
  return Promise.resolve(
    app.request(
      operationPath(definition, options.slug),
      { method: 'POST', headers, body: options.rawBody ?? JSON.stringify(options.body ?? {}) },
      testEnv,
    ),
  );
}

export async function errorCodeOf(res: Response): Promise<string | undefined> {
  const body: unknown = await res.json();
  return (body as { error?: { code?: string } }).error?.code;
}

export function defineOperationChecks(operations: readonly ImplementedOperation[], pointers: Pointers): void {
  const app = createApp(operations);
  const inputFor = async (definition: AnyOperationDefinition, target: Target): Promise<unknown> => {
    const pointer = pointers[definition.name];
    if (pointer === undefined) return {};
    return typeof pointer === 'function' ? pointer(target) : pointer.noReference;
  };

  describe.each(operations.map((operation) => operation.definition))('$name（$permission）', (definition) => {
    let own: Target;
    let other: Target;
    let operator: Person;
    beforeAll(async () => {
      [own, other, operator] = await Promise.all([createTarget(), createTarget(), getOperator()]);
    });

    // 成功の応答が定義の出力の形であることまで確かめる
    const expectOk = async (res: Response) => {
      expect(res.status).toBe(200);
      expect(definition.output.safeParse(await res.json()).success).toBe(true);
    };

    test('Origin が公開する URL と違う、または無いと 403', async () => {
      const token = (definition.permission === 'login' || definition.permission === 'operator' ? operator : own.admin)
        .token;
      const body = await inputFor(definition, own);
      const slug = own.slug;
      for (const origin of ['https://evil.example', `${testEnv.PUBLIC_ORIGIN}.evil.example`, null]) {
        const res = await post(app, definition, { slug, token, origin, body });
        expect(res.status, String(origin)).toBe(403);
        expect(await errorCodeOf(res)).toBe('forbidden');
      }
    });

    test('ログインしていないと 401 の unauthenticated', async () => {
      const res = await post(app, definition, { slug: own.slug, body: await inputFor(definition, own) });
      expect(res.status).toBe(401);
      expect(await errorCodeOf(res)).toBe('unauthenticated');
    });

    if (isOutsideOperation(definition)) {
      test('ログインしている運用者は成功する', async () => {
        await expectOk(await post(app, definition, { token: operator.token, body: await inputFor(definition, own) }));
      });
      if (definition.permission === 'operator') {
        test('運用者でない人は 403', async () => {
          const res = await post(app, definition, { token: own.admin.token, body: await inputFor(definition, own) });
          expect(res.status).toBe(403);
          expect(await errorCodeOf(res)).toBe('forbidden');
        });
      }
      return;
    }

    test('別の組織の人は、その組織の slug で 404', async () => {
      const res = await post(app, definition, {
        slug: own.slug,
        token: other.admin.token,
        body: await inputFor(definition, own),
      });
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    });

    test('存在しない slug は 404', async () => {
      const res = await post(app, definition, {
        slug: 'no-such-organization',
        token: own.admin.token,
        body: await inputFor(definition, own),
      });
      expect(res.status).toBe(404);
    });

    test('組織に属さない運用者は組織の中の操作に入れず 404', async () => {
      const res = await post(app, definition, {
        slug: own.slug,
        token: operator.token,
        body: await inputFor(definition, own),
      });
      expect(res.status).toBe(404);
    });

    // 404 が入力の誤りや権限の不足ではなく、別の組織の行を指したことで返ったと言えるよう、
    // 同じ入力の自分の組織の版が成功することと対にする
    test('自分の組織の行を指す入力は成功し、別の組織の行を指す入力は 404', async () => {
      await expectOk(
        await post(app, definition, { slug: own.slug, token: own.admin.token, body: await inputFor(definition, own) }),
      );
      const pointer = pointers[definition.name];
      if (pointer !== undefined && typeof pointer === 'function') {
        const res = await post(app, definition, {
          slug: own.slug,
          token: own.admin.token,
          body: await inputFor(definition, other),
        });
        expect(res.status).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    });

    switch (definition.permission) {
      case 'organization':
        test('組織に入れる人は、所属がなくても成功する', async () => {
          const body = await inputFor(definition, own);
          for (const person of [own.admin, own.leader, own.member, own.bystander]) {
            await expectOk(await post(app, definition, { slug: own.slug, token: person.token, body }));
          }
        });
        break;
      case 'admin':
        test('管理者でなければ 403', async () => {
          const body = await inputFor(definition, own);
          for (const person of [own.leader, own.member, own.bystander]) {
            const res = await post(app, definition, { slug: own.slug, token: person.token, body });
            expect(res.status).toBe(403);
            expect(await errorCodeOf(res)).toBe('forbidden');
          }
        });
        break;
      case 'leader':
        test('一般のメンバーと所属していない人は 403、リーダーと管理者は成功する', async () => {
          const body = await inputFor(definition, own);
          for (const person of [own.member, own.bystander]) {
            const res = await post(app, definition, { slug: own.slug, token: person.token, body });
            expect(res.status).toBe(403);
            expect(await errorCodeOf(res)).toBe('forbidden');
          }
          for (const person of [own.leader, own.admin]) {
            await expectOk(await post(app, definition, { slug: own.slug, token: person.token, body }));
          }
        });
        break;
      case 'member':
        test('所属していない人は 403、メンバーと管理者は成功する', async () => {
          const body = await inputFor(definition, own);
          const res = await post(app, definition, { slug: own.slug, token: own.bystander.token, body });
          expect(res.status).toBe(403);
          expect(await errorCodeOf(res)).toBe('forbidden');
          for (const person of [own.member, own.leader, own.admin]) {
            await expectOk(await post(app, definition, { slug: own.slug, token: person.token, body }));
          }
        });
        break;
    }
  });
}
