// 計画の画面の集計（plan-summary）を画面に出すときの計算。ブラウザの状態に頼らない純粋な関数だけを置く

// ポイントの出し方。整数はそのまま、小数（ベロシティの平均）は小数 1 桁
export function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// 先のスプリントに入れたポイントが、ベロシティ（平均）を厳密に上回るか。同じ値は上回らない。
// ベロシティが出ていない（null）ときと、0 のとき（比べる基準にならない）は比べない
export function isOverVelocity(points: number, average: number | null): boolean {
  return average !== null && average > 0 && points > average;
}

// 上回った分（ポイント）。上回っていなければ 0
export function overBy(points: number, average: number | null): number {
  return average === null ? 0 : Math.max(0, points - average);
}

// 先のスプリントの棒（.lane-fill-bar）の、入れたポイントの幅と、ベロシティの印の位置（どちらも 0〜100 の %）。
// 棒の長さは、入れたポイントとベロシティの大きい方の 1.15 倍。どちらも 0 なら、幅も位置も 0
export function laneFillShape(points: number, average: number | null): { width: number; mark: number | null } {
  const max = Math.max(points, average ?? 0) * 1.15;
  if (max <= 0) return { width: 0, mark: average === null ? null : 0 };
  return { width: (points / max) * 100, mark: average === null ? null : (average / max) * 100 };
}

// ベロシティの棒グラフ（.bars）の、棒の高さと平均の線の高さ（px）。いちばん大きい値が chartHeight になる
export function velocityBarShape(
  points: number[],
  average: number | null,
  chartHeight: number,
): { heights: number[]; mark: number | null } {
  const max = Math.max(1, ...points, average ?? 0);
  return {
    heights: points.map((value) => (value / max) * chartHeight),
    mark: average === null ? null : (average / max) * chartHeight,
  };
}

// エピックの残りのポイント（配下の未完了のタスクのポイントの合計）
export function epicRemaining(epic: { points_done: number; points_all: number }): number {
  return Math.max(0, epic.points_all - epic.points_done);
}
