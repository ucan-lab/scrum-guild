import { describe, expect, test } from 'vitest';
import type { Comment } from '../shared/operations/task/index.ts';
import { reloadView } from './comment-thread.ts';

// n 番目のコメント（created_at が n 秒の、書いた順）
function comment(n: number, overrides: Partial<Comment> = {}): Comment {
  return {
    id: `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    author: { id: 'u1', name: 'ミナト' },
    body_md: `本文 ${n}`,
    created_at: `2026-10-20T00:00:${String(n).padStart(2, '0')}.000Z`,
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    can_edit: true,
    can_delete: true,
    ...overrides,
  };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => comment(from + i));
const cursorOf = (c: Comment) => ({ created_at: c.created_at, id: c.id });

describe('reloadView', () => {
  test('前に足した古い行が新しい行と地続きなら残し、続きは前の next のまま', () => {
    const previous = { comments: range(1, 6), next: cursorOf(comment(1)), count: 6 };
    const view = reloadView(previous, { comments: range(4, 7), next: cursorOf(comment(4)), count: 7 }, []);
    expect(view.comments.map((c) => c.body_md)).toEqual(range(1, 7).map((c) => c.body_md));
    expect(view.next).toEqual(cursorOf(comment(1)));
    expect(view.count).toBe(7);
  });

  test('地続きでなければ（新しい行が前の一覧の先頭より後ろから始まる）、古い行を捨てて応答の next にする', () => {
    const previous = { comments: range(1, 3), next: null, count: 3 };
    const view = reloadView(previous, { comments: range(10, 12), next: cursorOf(comment(10)), count: 12 }, []);
    expect(view.comments.map((c) => c.id)).toEqual(range(10, 12).map((c) => c.id));
    expect(view.next).toEqual(cursorOf(comment(10)));
  });

  test('読み直しを始めた後に書いたコメントは、古い応答に無くても末尾に残し、件数に足す', () => {
    const previous = { comments: range(1, 2), next: null, count: 2 };
    const written = comment(3);
    const view = reloadView(previous, { comments: range(1, 2), next: null, count: 2 }, [written]);
    expect(view.comments.map((c) => c.id)).toEqual(range(1, 3).map((c) => c.id));
    expect(view.count).toBe(3);
  });

  test('読み直しを始めた後に直した本文と消した行は、古い応答の行に重ねる。消した分は件数から引く', () => {
    const previous = { comments: range(1, 3), next: null, count: 3 };
    const edited = comment(1, { body_md: '直した本文', edited_at: '2026-10-21T00:00:00.000Z' });
    const deleted = comment(2, {
      body_md: '',
      deleted_at: '2026-10-21T00:00:00.000Z',
      deleted_by: { id: 'u1', name: 'ミナト' },
    });
    const view = reloadView(previous, { comments: range(1, 3), next: null, count: 3 }, [edited, deleted]);
    expect(view.comments.map((c) => c.body_md)).toEqual(['直した本文', '', '本文 3']);
    expect(view.count).toBe(2);
  });

  test('応答がすでに書いた結果を含んでいれば、件数を二重に動かさない', () => {
    const written = comment(3);
    const view = reloadView({ comments: [], next: null, count: 0 }, { comments: range(1, 3), next: null, count: 3 }, [
      written,
    ]);
    expect(view.comments).toHaveLength(3);
    expect(view.count).toBe(3);
  });

  test('前のコメントがまだある一覧では、新しい行より古い書き込みは差し込まない（読んでいない区間に置かない）', () => {
    const view = reloadView(
      { comments: [], next: null, count: 0 },
      { comments: range(5, 6), next: cursorOf(comment(5)), count: 6 },
      [comment(2, { body_md: '直した古い行' })],
    );
    expect(view.comments.map((c) => c.id)).toEqual(range(5, 6).map((c) => c.id));
  });
});
