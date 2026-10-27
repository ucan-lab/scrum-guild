// スプリントの見せ方（kit.js の sprintLabel）。名前のあるスプリントは「<スプリント> <名前>」、無いものは期間を名前にして
// 「<スプリント> <M/D>〜<M/D>」。計画の画面、バックログの木の行、タスクの詳細が同じ決まりを使う。
// 辞書は引数（translate）で受け取り、画面の状態に頼らない
import type { DictionaryKey, TemplateParams } from '../shared/vocabulary.ts';
import { formatMonthDay } from './format.ts';

type Translate = (key: DictionaryKey, params?: TemplateParams) => string;

type SprintNaming = { name: string | null; start_on: string; end_on: string };

export function sprintLabel(sprint: SprintNaming, t: Translate): string {
  return sprint.name === null
    ? t('sprintLabelPeriod', {
        sprint: t('sprint'),
        start: formatMonthDay(sprint.start_on),
        end: formatMonthDay(sprint.end_on),
      })
    : t('sprintLabelNamed', { sprint: t('sprint'), name: sprint.name });
}

// 期間（M/D〜M/D）
export function sprintPeriod(sprint: SprintNaming, t: Translate): string {
  return t('sprintPeriod', { start: formatMonthDay(sprint.start_on), end: formatMonthDay(sprint.end_on) });
}

// タスクを完了にしたときの知らせ。始まっていないスプリントの中で完了してスプリントから外れたら（task-complete の left_sprint）、
// 「始まっていない<スプリント>から外れました」を添える
export function completedMessage(leftSprint: boolean, t: Translate): string {
  const done = t('taskCompleted', { task: t('task'), done: t('done') });
  return leftSprint ? `${done}。${t('taskLeftPlannedSprint', { sprint: t('sprint') })}` : done;
}

// 名前だけ（行の印に出す。「<スプリント>」の語は印の種類として読み上げに添える）。名前が無ければ期間
export function sprintShortName(sprint: SprintNaming, t: Translate): string {
  return sprint.name ?? sprintPeriod(sprint, t);
}
