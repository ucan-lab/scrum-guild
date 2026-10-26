import { describe, expect, test, vi } from 'vitest';
import { MoveQueue } from './move-queue.ts';

type Result = { ok: boolean; name: string };

// 外から解決できる応答。送っている最中の操作を作るのに使う
function deferred() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((done) => (resolve = done));
  return { promise, resolve };
}

// 列が次の操作を送り始めるまで待つ
const started = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const sent: string[] = [];
  const failed: string[] = [];
  const reload = vi.fn(async () => {});
  const dropped = vi.fn();
  const queue = new MoveQueue<Result>({ reload, dropped });
  return { queue, sent, failed, reload, dropped };
}

describe('MoveQueue の失敗', () => {
  test('断られた後の読み直し（onFailed）が失敗しても、後始末に進み、待っていた操作を捨てたことを知らせる', async () => {
    const { queue, sent, reload, dropped } = setup();
    const first = deferred();
    const onFailed = async () => {
      queue.reloaded();
      throw new Error('reload failed');
    };
    void queue.send(() => {
      sent.push('a');
      return first.promise;
    }, onFailed);
    const last = queue.send(async () => {
      sent.push('b');
      return { ok: true, name: 'b' };
    }, onFailed);
    first.resolve({ ok: false, name: 'a' });
    await last;
    expect(sent).toEqual(['a']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  test('列が空になった後の読み直し（hooks.reload）が失敗しても知らせ、印を後の操作に持ち越さない', async () => {
    const reload = vi.fn(async () => {
      throw new Error('reload failed');
    });
    const dropped = vi.fn();
    const queue = new MoveQueue<Result>({ reload, dropped });
    const onFailed = async () => queue.reloaded();
    const first = deferred();
    void queue.send(() => first.promise, onFailed);
    const last = queue.send(async () => ({ ok: true, name: 'b' }), onFailed);
    first.resolve({ ok: false, name: 'a' });
    await last;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(1);

    // 後の操作は、残った印で読み直しも知らせもしない。列も止まらずに送る
    const sent: string[] = [];
    await queue.send(async () => {
      sent.push('c');
      return { ok: true, name: 'c' };
    }, onFailed);
    expect(sent).toEqual(['c']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});

describe('MoveQueue', () => {
  test('押した順に1つずつ送り、何も読み直さなければ追加の読み直しをしない', async () => {
    const { queue, sent, reload, dropped } = setup();
    const first = deferred();
    const onFailed = async () => {};
    void queue.send(() => {
      sent.push('a');
      return first.promise;
    }, onFailed);
    const last = queue.send(async () => {
      sent.push('b');
      return { ok: true, name: 'b' };
    }, onFailed);
    await Promise.resolve();
    // a の応答が来るまで b は送らない
    expect(sent).toEqual(['a']);
    first.resolve({ ok: true, name: 'a' });
    await last;
    expect(sent).toEqual(['a', 'b']);
    expect(reload).not.toHaveBeenCalled();
    expect(dropped).not.toHaveBeenCalled();
  });

  test('先の操作が断られて読み直したら、待っていた操作は送らずに捨て、最後にもう一度読み直して知らせる', async () => {
    const { queue, sent, failed, reload, dropped } = setup();
    const first = deferred();
    // 画面は、断られたら理由を知らせて木を読み直す。読み直した木が reloaded() を呼ぶ
    const onFailed = async (result: Result) => {
      failed.push(result.name);
      queue.reloaded();
    };
    void queue.send(() => {
      sent.push('a');
      return first.promise;
    }, onFailed);
    void queue.send(async () => {
      sent.push('b');
      return { ok: true, name: 'b' };
    }, onFailed);
    const last = queue.send(async () => {
      sent.push('c');
      return { ok: true, name: 'c' };
    }, onFailed);
    first.resolve({ ok: false, name: 'a' });
    await last;
    expect(sent).toEqual(['a']);
    expect(failed).toEqual(['a']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(1);

    // 後の操作は、残った印で余計に読み直さない
    await queue.send(async () => ({ ok: true, name: 'd' }), onFailed);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  test('送っている間に読み直されたら、送り終えた後にもう一度読み直す。捨てた操作が無ければ知らせない', async () => {
    const { queue, reload, dropped } = setup();
    const first = deferred();
    const last = queue.send(
      () => first.promise,
      async () => {},
    );
    await started();
    queue.reloaded();
    first.resolve({ ok: true, name: 'a' });
    await last;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  test('1件だけ送って断られたときは、画面の読み直しだけで、追加の読み直しをしない', async () => {
    const { queue, reload, dropped } = setup();
    await queue.send(
      async () => ({ ok: false, name: 'a' }),
      async () => queue.reloaded(),
    );
    expect(reload).not.toHaveBeenCalled();
    expect(dropped).not.toHaveBeenCalled();
  });

  test('discard() の後に送る前だった操作は捨てる', async () => {
    const { queue, sent, reload, dropped } = setup();
    const first = deferred();
    void queue.send(
      () => {
        sent.push('a');
        return first.promise;
      },
      async () => {},
    );
    const last = queue.send(
      async () => {
        sent.push('b');
        return { ok: true, name: 'b' };
      },
      async () => {},
    );
    await started();
    queue.discard();
    first.resolve({ ok: true, name: 'a' });
    await last;
    expect(sent).toEqual(['a']);
    // discard() は読み直しではないので、追加の読み直しも知らせもしない
    expect(reload).not.toHaveBeenCalled();
    // 捨てた数は残さない。後の読み直しで、捨てていない操作を知らせない
    const next = deferred();
    const after = queue.send(
      () => next.promise,
      async () => {},
    );
    await started();
    queue.reloaded();
    next.resolve({ ok: true, name: 'c' });
    await after;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });
});
