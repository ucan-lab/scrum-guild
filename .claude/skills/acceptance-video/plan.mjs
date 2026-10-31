// 手順書（steps の JSON）の形の検査と、録画の長さの見積もり。ブラウザを使わないので、録画の前に何度でも回せる。
// 待ちの値は record.mjs と同じものを使う（字幕を読む時間を削ると、字幕が変わるのと画面が動くのが重なって見づらくなる）

export const READ_MS = 2000; // 字幕を出してから、画面を動かすまで。人が読む時間
export const PAUSE_MS = 1000; // 操作と操作の間
export const HOLD_MS = 1000; // 操作のあと、結果を見せる時間
export const RESULT_MS = 2800; // 操作のない場面（結果だけを見せる）の長さ
export const MARK_MS = 700; // 枠を付けてから操作するまで
export const STARTUP_MS = 500; // 録画が始まってから最初の場面まで
export const MAX_SECONDS = 30;
// 録画の動作（画面の読み込み、描画）が見積もりに足す分の余裕。試作の #574 は、見積もり 25.1 秒に対して録画が 27.8 秒だった
export const ESTIMATE_LIMIT_SECONDS = 26;
// 字幕の帯は 1280px 幅で、32px の文字が収まるのは約 38 文字
export const MAX_CAPTION_CHARS = 38;

const VERBS = ['goto', 'click', 'check', 'select', 'fill', 'wait', 'pause'];
const LOCATOR_KEYS = ['css', 'role', 'label'];

function locatorProblems(spec, where) {
  if (spec === null || typeof spec !== 'object') return [`${where}: 要素の指定が無い`];
  const keys = LOCATOR_KEYS.filter((key) => spec[key] !== undefined);
  const problems = [];
  if (keys.length !== 1) problems.push(`${where}: css、role、label のどれか1つだけを指定する`);
  if (spec.role !== undefined && typeof spec.name !== 'string') problems.push(`${where}: role には name も指定する`);
  if (spec.within !== undefined) problems.push(...locatorProblems(spec.within, `${where}.within`));
  return problems;
}

function actionProblems(action, where) {
  if (action === null || typeof action !== 'object') return [`${where}: 操作がオブジェクトでない`];
  const verbs = VERBS.filter((verb) => action[verb] !== undefined);
  if (verbs.length !== 1) return [`${where}: ${VERBS.join('、')} のどれか1つだけを指定する`];
  const verb = verbs[0];
  if (verb === 'goto') return typeof action.goto === 'string' && action.goto.startsWith('/') ? [] : [`${where}: goto は / で始まるパス`];
  if (verb === 'pause') return Number.isFinite(action.pause) && action.pause >= 0 ? [] : [`${where}: pause はミリ秒の数`];
  const problems = locatorProblems(action[verb], `${where}.${verb}`);
  if (verb === 'select' && typeof action.label !== 'string') problems.push(`${where}: select には label（選ぶ項目の表示）も指定する`);
  if (verb === 'fill' && typeof action.text !== 'string') problems.push(`${where}: fill には text も指定する`);
  return problems;
}

const INVISIBLE = ['goto', 'wait', 'pause'];

/** i 番目の操作のあとに PAUSE_MS を置くか。見える操作が続くときだけで、待つだけの操作の前後には置かない */
export function pausesAfter(actions, i) {
  const isVisible = (action) => !INVISIBLE.some((verb) => action[verb] !== undefined);
  return i < actions.length - 1 && isVisible(actions[i]) && isVisible(actions[i + 1]);
}

/** 手順書の問題を文の配列で返す。空なら録画に進める */
export function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object') return ['手順書がオブジェクトでない'];
  const problems = [];
  if (plan.who !== undefined && typeof plan.who !== 'string') problems.push('who は seed のセッションの名前（admin など）');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return [...problems, 'steps が空'];
  plan.steps.forEach((step, i) => {
    const where = `steps[${i}]`;
    if (step === null || typeof step !== 'object') {
      problems.push(`${where}: 場面がオブジェクトでない`);
      return;
    }
    if (step.caption !== undefined) {
      if (typeof step.caption !== 'string' || step.caption === '') problems.push(`${where}: caption は空でない文`);
      else if ([...step.caption].length > MAX_CAPTION_CHARS) {
        problems.push(`${where}: caption が ${MAX_CAPTION_CHARS} 文字を超える（帯に収まらない）`);
      }
    }
    if (step.mark !== undefined) problems.push(...locatorProblems(step.mark, `${where}.mark`));
    for (const key of ['read', 'hold']) {
      if (step[key] !== undefined && !(Number.isFinite(step[key]) && step[key] >= 0)) problems.push(`${where}: ${key} はミリ秒の数`);
    }
    if (step.actions !== undefined && !Array.isArray(step.actions)) problems.push(`${where}: actions が配列でない`);
    else (step.actions ?? []).forEach((action, j) => problems.push(...actionProblems(action, `${where}.actions[${j}]`)));
  });
  return problems;
}

/** 待ちだけから見積もった長さ（秒）。操作と読み込みの時間は含まない */
export function estimateSeconds(plan) {
  let ms = STARTUP_MS;
  for (const step of plan.steps) {
    const actions = step.actions ?? [];
    if (step.mark) ms += MARK_MS;
    if (actions.length > 0) {
      if (step.caption) ms += step.read ?? READ_MS;
      actions.forEach((action, i) => {
        if (pausesAfter(actions, i)) ms += PAUSE_MS;
        if (action.pause !== undefined) ms += action.pause;
      });
      ms += step.hold ?? HOLD_MS;
    } else {
      ms += step.hold ?? RESULT_MS;
    }
  }
  return ms / 1000;
}
