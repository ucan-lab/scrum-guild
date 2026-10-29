// レビューのエージェントを起動できる巡の上限の判定（Issue #487）。入口は review-budget.mjs。
// 純関数だけを置く。時刻とファイルの入出力は入口が渡す。
// 1巡は「巡の最初の起動から WINDOW_MS 以内の起動」の束。拒否した起動は記録しない。

import { createHash } from 'node:crypto';

const MAX_NAME = 150;
const HEAD_LEN = 100;

export const REVIEW_AGENTS = ['code-reviewer', 'security-reviewer', 'database-reviewer', 'ui-reviewer', 'falsification-qa'];
export const WINDOW_MS = 120000;
export const BASE_LIMIT = 2;

export function emptyState() {
  return { starts: [], extra: 0 };
}

// 戻り値の state は渡された state を書き換えずに作る。拒否と対象外では渡された state をそのまま返す。
export function judgeReview(state, agentType, now) {
  if (typeof agentType !== 'string' || !REVIEW_AGENTS.includes(agentType)) return { decision: 'allow', state };
  // どの巡の最初の起動とも差が窓以内なら同じ巡。差は絶対値で測るので、時刻の巻き戻りや、
  // 同時に呼ばれた起動の到着順が入れ替わっても、数える巡は変わらない
  if (state.starts.some((s) => Math.abs(now - s) <= WINDOW_MS)) return { decision: 'allow', state };
  const limit = BASE_LIMIT + state.extra;
  if (state.starts.length >= limit) return { decision: 'deny', state, reason: denyReason(limit) };
  return { decision: 'allow', state: { ...state, starts: [...state.starts, now] } };
}

export function extendState(state, rounds, reason, now) {
  return {
    ...state,
    extra: state.extra + rounds,
    extensions: [...(state.extensions ?? []), { rounds, reason, at: now }],
  };
}

function denyReason(limit) {
  return [
    `このブランチのレビューのエージェントは ${limit} 巡まで起動済みです（120秒以内の起動は同じ巡。上限は既定 ${BASE_LIMIT} 巡に延長を足したもの）。`,
    '名前を変えて呼び直す、Skill や別の経路で同じ点検をするなどで回避しないでください。',
    'AskUserQuestion でユーザーに延長を聞き、承認されたら次を実行してから呼び直してください:',
    'node .claude/hooks/review-budget.mjs extend <巡数> --reason <理由>',
  ].join('\n');
}

// ブランチ名をファイル名にする。英数字と _ - 以外はバイトごとに %XX にするので、
// 別のブランチが同じ名前にならず、/ や . を含まない（% 自身も符号化する）
export function branchFileName(branch) {
  let out = '';
  for (const ch of branch) {
    if (/[A-Za-z0-9_-]/.test(ch)) out += ch;
    else for (const byte of Buffer.from(ch, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (out.length <= MAX_NAME) return out;
  // 長いときは符号化の先頭（%XX を割らない位置まで）と全体のハッシュ。'~' は符号化されないので短い名前と衝突しない
  let head = out.slice(0, HEAD_LEN);
  const cut = head.lastIndexOf('%');
  if (cut > HEAD_LEN - 3) head = head.slice(0, cut);
  return `${head}~${createHash('sha256').update(branch).digest('hex')}`;
}
