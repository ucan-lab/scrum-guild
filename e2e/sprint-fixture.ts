// スプリントの画面の見た目の検査（axe、狭い幅）で、sprint-board の応答に差し替える架空のスプリントと列とカード。
// seed の行も DB も書き換えず（ほかのファイルと並べて走るため）、4つの列に長い題や親のストーリーを含むカードを置く。
// ID は架空で、引き出しは開かない
import type { OutputOf } from '../src/shared/operations/define.ts';
import type { sprintBoard } from '../src/shared/operations/sprint/index.ts';

type Board = OutputOf<typeof sprintBoard>;

const card = (id: string, title: string, overrides: Partial<Board['columns'][number]['tasks'][number]> = {}) => ({
  id,
  title,
  points: null,
  assignee: null,
  completed_at: null,
  story: null,
  due_on: null,
  repository: null,
  ...overrides,
});

export const SAMPLE_BOARD: Board = {
  sprint: {
    id: '019a0000-0000-7000-8000-00000000f001',
    name: '第14回',
    goal: '会員ポイントの付与を管理画面で確かめられる所まで進め、決済の障害の検知を入れる',
    start_on: '2026-10-13',
    end_on: '2026-10-26',
    length: 14,
    status: 'active',
  },
  today: '2026-10-20',
  week_start: 1,
  columns: [
    {
      id: '019a0000-0000-7000-8000-00000000f101',
      name: '出発前',
      is_done: false,
      tasks: [
        card('019a0000-0000-7000-8000-00000000f201', '管理画面にポイント履歴の一覧を出す', {
          points: 5,
          assignee: { id: '019a0000-0000-7000-8000-000000000302', name: 'ハルカ' },
          story: { id: '019a0000-0000-7000-8000-00000000f301', title: 'ポイントの付与と失効を管理画面で確かめられる' },
        }),
        card('019a0000-0000-7000-8000-00000000f202', '障害時の連絡手順を書く', {
          due_on: '2026-10-17',
          repository: { id: '019a0000-0000-7000-8000-00000000f401', name: 'point-api' },
        }),
      ],
    },
    {
      id: '019a0000-0000-7000-8000-00000000f102',
      name: '遂行中',
      is_done: false,
      tasks: [
        card('019a0000-0000-7000-8000-00000000f203', 'ポイント付与のバッチを作る', {
          points: 3,
          assignee: { id: '019a0000-0000-7000-8000-000000000301', name: 'ミナト' },
        }),
      ],
    },
    { id: '019a0000-0000-7000-8000-00000000f103', name: '査定中', is_done: false, tasks: [] },
    {
      id: '019a0000-0000-7000-8000-00000000f104',
      name: null,
      is_done: true,
      tasks: [
        card('019a0000-0000-7000-8000-00000000f204', '付与の履歴を返す API を作る', {
          points: 2,
          assignee: { id: '019a0000-0000-7000-8000-000000000301', name: 'ミナト' },
          completed_at: '2026-10-19T08:00:00.000Z',
        }),
      ],
    },
  ],
};
