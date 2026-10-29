// 未実装の入れ物（Issue #487）。実装の書き手が置き換える。
export const REVIEW_AGENTS = [];
export const WINDOW_MS = 120000;
export const BASE_LIMIT = 2;
export function emptyState() {
  throw new Error('未実装');
}
export function judgeReview(state, agentType, now) {
  throw new Error('未実装');
}
export function extendState(state, rounds, reason, now) {
  throw new Error('未実装');
}
export function branchFileName(branch) {
  throw new Error('未実装');
}
