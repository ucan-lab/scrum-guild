import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import type { TaskDetail } from '../../shared/operations/task/index.ts';
import { setVocabularies } from '../vocabulary.svelte.ts';
import TaskThanks from './TaskThanks.svelte';

const task: TaskDetail = {
  id: 'task',
  title: '調査する',
  body_md: null,
  points: null,
  due_on: null,
  link_url: null,
  assignee: { id: 'self', name: '送り手', left: false },
  is_imported: false,
  completed_at: null,
  reopenable: false,
  can_delete: true,
  story_id: null,
  category: null,
  repository: null,
  sprint: null,
  can_send_thanks: true,
  thanks: [
    {
      id: 'thanks',
      sender: { id: 'self', name: '送り手' },
      recipient: { id: 'sent', name: '送付済みの人' },
      created_at: '2026-10-01T00:00:00.000Z',
      can_revoke: true,
    },
  ],
};
const props = {
  slug: 'test',
  workspaceId: 'workspace',
  task,
  currentUserId: 'self',
  canWrite: true,
  candidates: [
    { id: 'self', name: '送り手' },
    { id: 'sent', name: '送付済みの人' },
    { id: 'next', name: '次の相手' },
  ],
  candidatesLoading: false,
  candidatesFailed: false,
  onretry: () => {},
  onrefresh: async () => task,
  onstale: () => {},
};

test('送れる人には自分と送付済み以外への送付口、本人が送った行には取消口を出す', () => {
  for (const vocabulary of ['game', 'scrum'] as const) {
    setVocabularies({ workspace: vocabulary });
    const { body } = render(TaskThanks, { props });
    expect(body).toContain('次の相手 に送る');
    expect(body).not.toContain('送り手 に送る');
    expect(body).not.toContain('送付済みの人 に送る');
    expect(body).toContain('送付済みの人 への感謝を取り消す');
    expect(body).toContain('#i-heart');
  }
});

test('送れない人、完了済み、閉じたワークスペースでは送り手と受取人の一覧だけを出す', () => {
  for (const changes of [
    {
      task: {
        ...task,
        can_send_thanks: false,
        thanks: task.thanks.map((thanks) => ({ ...thanks, can_revoke: false })),
      },
    },
    { task: { ...task, completed_at: '2026-10-01T00:00:00.000Z' } },
    { canWrite: false },
  ]) {
    const { body } = render(TaskThanks, { props: { ...props, ...changes } });
    expect(body).toContain('送り手 から 送付済みの人 に送った感謝');
    expect(body).not.toContain('<button');
  }
});

test('送れる人でも他人が送った感謝は取り消せない', () => {
  const { body } = render(TaskThanks, {
    props: { ...props, task: { ...task, thanks: task.thanks.map((thanks) => ({ ...thanks, can_revoke: false })) } },
  });
  expect(body).toContain('次の相手 に送る');
  expect(body).not.toContain('への感謝を取り消す');
});

test('担当が替わって送れなくなっても、送った本人には取消口だけを出す', () => {
  const { body } = render(TaskThanks, { props: { ...props, task: { ...task, can_send_thanks: false } } });
  expect(body).toContain('送付済みの人 への感謝を取り消す');
  expect(body).not.toContain('次の相手 に送る');
});

test('候補が無いときは送付ボタンの入れ物を出さない', () => {
  const { body } = render(TaskThanks, { props: { ...props, candidates: [{ id: 'self', name: '送り手' }] } });
  expect(body).not.toContain('class="thanks"');
});

test('空の一覧と候補の読み込み失敗を案内する', () => {
  const { body } = render(TaskThanks, {
    props: { ...props, task: { ...task, thanks: [] }, candidates: null, candidatesFailed: true },
  });
  expect(body).toContain('まだ感謝は送られていません。');
  expect(body).toContain('感謝を送る相手を読み込めませんでした。');
  expect(body).toContain('もう一度試す');
});
