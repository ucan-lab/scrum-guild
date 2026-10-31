// 手順書（steps の JSON）の形の検査と、録画の長さの見積もり。ブラウザを使わないので、録画の前に何度でも回せる。
// 待ちの値は record.mjs と同じものを使う（字幕を読む時間を削ると、字幕が変わるのと画面が動くのが重なって見づらくなる）

export const READ_MS = 2000; // 字幕を出してから、画面を動かすまで。人が読む時間
export const PAUSE_MS = 1000; // 見える操作と見える操作の間
export const HOLD_MS = 1000; // 操作のあと、結果を見せる時間
export const RESULT_MS = 2800; // 操作のない場面（結果だけを見せる）の長さ
export const MARK_MS = 700; // 枠を付けてから操作するまで
export const FINISH_MS = 300; // 最後の字幕を閉じてから、録画を止めるまで
// 操作 1 つの実時間（Playwright の待ちと描画）の目安。見本（操作 12 個）の録画で、待ちの合計より約 1.1 秒長かった
export const OPERATION_MS = 150;
// 字幕のある場面は、読む時間と結果を見る時間をこれ未満にさせない（字幕を読む間に画面が変わるのを防ぐ）
export const MIN_VIEW_MS = 1500;
export const MAX_WAIT_MS = 10_000;
// compose.py は録画を 30 秒で数える。見積もりとの差（読み込みの揺れ）を 2 秒見る
export const ESTIMATE_LIMIT_SECONDS = 28;
// 字幕の帯は 1280px 幅で、32px の文字が収まるのは約 38 文字
export const MAX_CAPTION_CHARS = 38;

const VERBS = ['goto', 'click', 'check', 'select', 'fill', 'wait', 'pause'];
const ACTION_EXTRA_KEYS = { select: ['label'], fill: ['text'], wait: ['state'] };
const WAIT_STATES = ['visible', 'hidden', 'attached', 'detached'];
const PLAN_KEYS = ['who', 'steps'];
const STEP_KEYS = ['caption', 'read', 'hold', 'mark', 'actions'];
const TARGET_KEYS = ['css', 'role', 'label'];
const LOCATOR_KEYS = [...TARGET_KEYS, 'name', 'exact', 'within', 'nth'];

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isWait = (value) => Number.isFinite(value) && value >= 0 && value <= MAX_WAIT_MS;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function unknownKeys(object, allowed, where) {
  return Object.keys(object)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}: ${key} は使えない（綴りの誤りか）。使えるのは ${allowed.join('、')}`);
}

function locatorProblems(spec, where) {
  if (!isObject(spec)) return [`${where}: 要素の指定が無い`];
  const problems = unknownKeys(spec, LOCATOR_KEYS, where);
  const targets = TARGET_KEYS.filter((key) => spec[key] !== undefined);
  if (targets.length !== 1) problems.push(`${where}: css、role、label のどれか1つだけを指定する`);
  for (const key of [...TARGET_KEYS, 'name']) {
    if (spec[key] !== undefined && !isText(spec[key])) problems.push(`${where}: ${key} は空でない文字列`);
  }
  if (spec.role !== undefined && spec.name === undefined) problems.push(`${where}: role には name も指定する`);
  if (spec.exact !== undefined && typeof spec.exact !== 'boolean') problems.push(`${where}: exact は true か false`);
  if (spec.nth !== undefined && !(Number.isInteger(spec.nth) && spec.nth >= 0)) problems.push(`${where}: nth は 0 以上の整数`);
  if (spec.within !== undefined) problems.push(...locatorProblems(spec.within, `${where}.within`));
  return problems;
}

function actionProblems(action, where) {
  if (!isObject(action)) return [`${where}: 操作がオブジェクトでない`];
  const verbs = VERBS.filter((verb) => action[verb] !== undefined);
  if (verbs.length !== 1) return [`${where}: ${VERBS.join('、')} のどれか1つだけを指定する`];
  const verb = verbs[0];
  const problems = unknownKeys(action, [verb, ...(ACTION_EXTRA_KEYS[verb] ?? [])], where);
  if (verb === 'goto') {
    if (typeof action.goto !== 'string' || !action.goto.startsWith('/')) problems.push(`${where}: goto は / で始まるパス`);
  } else if (verb === 'pause') {
    if (!isWait(action.pause)) problems.push(`${where}: pause は 0 から ${MAX_WAIT_MS} のミリ秒`);
  } else {
    problems.push(...locatorProblems(action[verb], `${where}.${verb}`));
    if (verb === 'select' && !isText(action.label)) problems.push(`${where}: select には label（選ぶ項目の表示）も指定する`);
    if (verb === 'fill' && typeof action.text !== 'string') problems.push(`${where}: fill には text も指定する`);
    if (verb === 'wait' && action.state !== undefined && !WAIT_STATES.includes(action.state)) {
      problems.push(`${where}: state は ${WAIT_STATES.join('、')} のどれか`);
    }
  }
  return problems;
}

function stepProblems(step, where) {
  if (!isObject(step)) return [`${where}: 場面がオブジェクトでない`];
  const problems = unknownKeys(step, STEP_KEYS, where);
  if (step.caption !== undefined) {
    if (!isText(step.caption)) problems.push(`${where}: caption は空でない文`);
    else if ([...step.caption].length > MAX_CAPTION_CHARS) {
      problems.push(`${where}: caption が ${MAX_CAPTION_CHARS} 文字を超える（帯に収まらない）`);
    }
  }
  if (step.mark !== undefined) problems.push(...locatorProblems(step.mark, `${where}.mark`));
  for (const key of ['read', 'hold']) {
    if (step[key] !== undefined && !isWait(step[key])) problems.push(`${where}: ${key} は 0 から ${MAX_WAIT_MS} のミリ秒`);
  }
  if (step.actions !== undefined && !Array.isArray(step.actions)) {
    problems.push(`${where}: actions が配列でない`);
    return problems;
  }
  const actions = step.actions ?? [];
  actions.forEach((action, i) => problems.push(...actionProblems(action, `${where}.actions[${i}]`)));
  // 字幕を出している間に画面を動かさないための下限。操作のある場面は読む時間、操作のない場面は結果を見る時間
  if (isText(step.caption)) {
    const [key, ms] = actions.length > 0 ? ['read', step.read ?? READ_MS] : ['hold', step.hold ?? RESULT_MS];
    if (ms < MIN_VIEW_MS) problems.push(`${where}: caption のある場面は ${key} を ${MIN_VIEW_MS} ミリ秒以上にする（字幕を読む時間）`);
  }
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
  if (!isObject(plan)) return ['手順書がオブジェクトでない'];
  const problems = unknownKeys(plan, PLAN_KEYS, '手順書');
  if (plan.who !== undefined && !isText(plan.who)) problems.push('who は seed のセッションの名前（admin など）');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return [...problems, 'steps が空'];
  plan.steps.forEach((step, i) => problems.push(...stepProblems(step, `steps[${i}]`)));
  return problems;
}

/** 待ちと、操作の実時間の目安から見積もった長さ（秒）。読み込みの揺れは含まない */
export function estimateSeconds(plan) {
  let ms = FINISH_MS;
  for (const step of plan.steps) {
    const actions = step.actions ?? [];
    if (step.mark) ms += MARK_MS;
    if (actions.length > 0) {
      if (step.caption) ms += step.read ?? READ_MS;
      actions.forEach((action, i) => {
        ms += OPERATION_MS;
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
