import type { InputOf, OutputOf } from '../shared/operations/define.ts';
import type { backlogCompletedTasks } from '../shared/operations/task/backlog-completed-tasks.ts';
import type { ApiResult } from './api.ts';

type Input = Pick<InputOf<typeof backlogCompletedTasks>, 'before' | 'limit'>;
type Output = OutputOf<typeof backlogCompletedTasks>;

// 世代を進めて古い応答を捨てる。読み直しは全部読めてから置き換え、失敗時は同じ件数で再試行する。
export class CompletedBacklog {
  tasks = $state<Output['tasks']>([]);
  next = $state<Output['next']>(null);
  loading = $state(false);
  failed = $state(false);
  // 直近の読み取りが続きの追加か（真なら、読めた行は今の一覧の後ろに並ぶ。偽なら先頭から置き換わる）。再試行の後のフォーカスの先に使う
  retryAppends = false;
  private generation = 0;
  private retryRead: () => Promise<void> = async () => {};

  constructor(private readonly read: (input: Input) => Promise<ApiResult<Output>>) {}

  async refresh(): Promise<void> {
    return this.load(this.tasks.length || 20, false);
  }

  async more(): Promise<void> {
    if (this.loading || this.next === null) return;
    return this.load(20, true);
  }

  async retry(): Promise<void> {
    if (!this.loading) await this.retryRead();
  }

  cancel(): void {
    this.generation++;
    this.loading = false;
  }

  reset(): void {
    this.cancel();
    this.tasks = [];
    this.next = null;
    this.failed = false;
  }

  private async load(count: number, append: boolean): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.failed = false;
    this.retryRead = () => this.load(count, append);
    this.retryAppends = append;
    let tasks: Output['tasks'] = [];
    let next = append ? this.next : null;
    do {
      const result = await this.read({
        limit: Math.min(200, count - tasks.length),
        ...(next === null ? {} : { before: next }),
      });
      if (generation !== this.generation) return;
      if (!result.ok) {
        this.loading = false;
        this.failed = true;
        return;
      }
      tasks = [...tasks, ...result.data.tasks];
      next = result.data.next;
    } while (next !== null && tasks.length < count);
    this.tasks = append ? [...this.tasks, ...tasks] : tasks;
    this.next = next;
    this.loading = false;
  }
}
