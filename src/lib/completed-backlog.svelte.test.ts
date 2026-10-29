import { expect, test, vi } from 'vitest';
import { CompletedBacklog } from './completed-backlog.svelte.ts';
import type {
  CompletedBacklogTask,
  CompletedBacklogCursor,
} from '../shared/operations/task/backlog-completed-tasks.ts';

const rows = (count: number, prefix = ''): CompletedBacklogTask[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    title: `完了${i}`,
    completed_at: '2026-10-20T00:00:00.000Z',
    points: null,
    assignee: null,
  }));
const cursor = { completed_at: '2026-10-20T00:00:00.000Z', id: 'next' };
const ok = (tasks: CompletedBacklogTask[], next: CompletedBacklogCursor | null = null) => ({
  ok: true as const,
  data: { tasks, next },
});

test('最初は20件、さらに20件。読み直しは表示件数を先頭から置き換える（戻した行は消える）', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(ok(rows(20), cursor))
    .mockResolvedValueOnce(ok(rows(20, 'more')))
    .mockResolvedValueOnce(ok(rows(39, 'fresh')));
  const list = new CompletedBacklog(read);
  await list.refresh();
  await list.more();
  expect(list.tasks).toHaveLength(40);
  expect(read.mock.calls).toEqual([[{ limit: 20 }], [{ limit: 20, before: cursor }]]);
  await list.refresh();
  expect(read).toHaveBeenLastCalledWith({ limit: 40 });
  expect(list.tasks).toEqual(rows(39, 'fresh'));
});

test('200件を超えて表示していたらnextをたどり、全部読めてから差し替える', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(ok(rows(200, 'fresh'), cursor))
    .mockResolvedValueOnce(ok(rows(20, 'tail')));
  const list = new CompletedBacklog(read);
  list.tasks = rows(220);
  await list.refresh();
  expect(read.mock.calls).toEqual([[{ limit: 200 }], [{ limit: 20, before: cursor }]]);
  expect(list.tasks).toHaveLength(220);
  expect(list.tasks[0]?.id).toBe('fresh0');
});

test('途中で読めなければ前の一覧を保ち、再試行で先頭から必要件数を読み直す', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(ok(rows(200), cursor))
    .mockResolvedValueOnce({ ok: false, status: 500, error: null })
    .mockResolvedValueOnce(ok(rows(200, 'retry'), cursor))
    .mockResolvedValueOnce(ok(rows(20, 'tail')));
  const list = new CompletedBacklog(read);
  list.tasks = rows(220, 'old');
  await list.refresh();
  expect(list.failed).toBe(true);
  expect(list.tasks[0]?.id).toBe('old0');
  await list.retry();
  expect(read.mock.calls[2]).toEqual([{ limit: 200 }]);
  expect(list.failed).toBe(false);
  expect(list.tasks[0]?.id).toBe('retry0');
});

test('追加の失敗の再試行は同じbeforeを使い、既存の行を重複させない', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(ok(rows(20), cursor))
    .mockResolvedValueOnce({ ok: false, status: 0, error: null })
    .mockResolvedValueOnce(ok(rows(2, 'tail')));
  const list = new CompletedBacklog(read);
  await list.refresh();
  await list.more();
  await list.retry();
  expect(list.tasks).toHaveLength(22);
  expect(read.mock.calls[1]).toEqual(read.mock.calls[2]);
});

test('閉じた後や新しい読み直し後に届く古い応答は捨てる', async () => {
  let release!: (value: ReturnType<typeof ok>) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(ok(rows(1, 'new')));
  const list = new CompletedBacklog(read);
  const old = list.refresh();
  expect(list.loading).toBe(true);
  list.cancel();
  await list.refresh();
  release(ok(rows(20, 'old')));
  await old;
  expect(list.tasks).toEqual(rows(1, 'new'));
  expect(list.loading).toBe(false);
});

test('20件未満を表示していたら、その件数だけ読み直す', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(ok(rows(3)))
    .mockResolvedValueOnce(ok(rows(3, 'new'), cursor));
  const list = new CompletedBacklog(read);
  await list.refresh();
  await list.refresh();
  expect(read).toHaveBeenLastCalledWith({ limit: 3 });
  expect(list.next).toEqual(cursor);
});

test('閉じて開き直すと先頭20件から読む', async () => {
  const read = vi.fn().mockResolvedValue(ok(rows(20), cursor));
  const list = new CompletedBacklog(read);
  await list.refresh();
  await list.more();
  list.reset();
  expect(list.tasks).toEqual([]);
  await list.refresh();
  expect(read).toHaveBeenLastCalledWith({ limit: 20 });
});
