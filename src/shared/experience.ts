// 行動ごとの経験値。どの組織でも同じ固定の値で、変えても確定済みの明細は動かさない（docs/requirements.md の「ゲームの仕組み」）。
// 目安は、1人が1スプリントで完了 8件、起票 6件、ほかの行動で 100 前後を足して約 400。
// 詳細、レビュー、手助けの値は、それぞれの行動を作る Issue で、この尺度に合わせて足す

// タスクの起票。手で作ったタスクの作った人に、完了にした時点で付く
export const XP_TASK_CREATED = 10;

// タスクの完了。完了した時点の担当者に、担当がいなければ完了にした人に付く
export const XP_TASK_COMPLETED = 30;

// ストーリーの完了。配下のタスクで完了の経験値を受け取った人全員に、1人1回ずつ付く（取り消すと打ち消す）
export const XP_STORY_COMPLETED = 20;

// エピックのクリア報酬の段階（epics.reward_tier の CHECK と同じ並び）と、段階ごとの経験値。
// 1人1スプリントで約 400 の尺度に対し、大は 1.5 スプリント分。画面に額を出すために持つ。払うのはクリアの処理
export const epicRewardTiers = ['small', 'medium', 'large'] as const;
export type EpicRewardTier = (typeof epicRewardTiers)[number];

export const XP_EPIC_REWARD: Readonly<Record<EpicRewardTier, number>> = { small: 100, medium: 300, large: 600 };

// 経験値の明細の行動（xp_grants.action の CHECK と同じ並び）
export const experienceActions = [
  'task_created',
  'task_detailed',
  'task_completed',
  'review',
  'help',
  'story_completed',
  'epic_reward',
] as const;
export type ExperienceAction = (typeof experienceActions)[number];

// ---- レベル（docs/requirements.md の「ゲームの仕組み」） ----
// レベル L に達するのに要る合計は 50 × L × (L − 1)。次のレベルまでに要るのは 100 × L。上限は無い。
// 合計が 0 を下回っても（打ち消しで減っても）レベル1より下げない。画面と API が同じ関数を使う

// レベル L の始まりの合計
export function levelStartOf(level: number): number {
  return 50 * level * (level - 1);
}

// 合計からレベルを出す。数でない値と 100 未満（負を含む）はレベル1。
// 平方根の丸めの誤差で境界を外さないよう、式で出した値を始まりの合計と比べて直す
export function levelOf(total: number): number {
  if (!Number.isFinite(total) || total < levelStartOf(2)) return 1;
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * total) / 50)) / 2));
  while (levelStartOf(level + 1) <= total) level++;
  while (level > 1 && levelStartOf(level) > total) level--;
  return level;
}

export type LevelProgress = {
  level: number;
  // 今のレベルの始まりの合計と、次のレベルに要る合計
  levelStart: number;
  nextLevelAt: number;
  // 次のレベルまでの残り（合計が負なら、始まりの 0 までの分も含む）
  toNext: number;
  // ゲージの割合（0〜1）。確定は今のレベルの幅のうち貯まった分、見込みは残りの幅を超えない分
  confirmedRatio: number;
  prospectiveRatio: number;
};

// 合計と見込みから、レベルとゲージの割合を出す。
// 確定 = (合計 − 今のレベルの始まり) / (100 × L)（負なら 0）。見込み = 見込み / (100 × L) を、残りの幅（1 − 確定）で切る
export function levelProgressOf(total: number, prospective = 0): LevelProgress {
  const level = levelOf(total);
  const levelStart = levelStartOf(level);
  const nextLevelAt = levelStartOf(level + 1);
  const span = nextLevelAt - levelStart;
  const safeTotal = Number.isFinite(total) ? total : 0;
  const confirmedRatio = Math.min(1, Math.max(0, (safeTotal - levelStart) / span));
  const prospectiveRatio = Math.min(
    1 - confirmedRatio,
    Math.max(0, (Number.isFinite(prospective) ? prospective : 0) / span),
  );
  return {
    level,
    levelStart,
    nextLevelAt,
    toNext: nextLevelAt - safeTotal,
    confirmedRatio,
    prospectiveRatio,
  };
}
