// 受け入れ動画の録画。手順書（steps の JSON）に沿って seed の画面を操作し、録画（recording.webm）と、字幕を出す時刻（cues.json）を書く。
// 字幕は画面に重ねず、時刻だけを残す。帯への載せ方は compose.py。
// 使い方（ワークツリーの根で。先に pnpm preview と pnpm db:seed）:
//   node .claude/skills/acceptance-video/record.mjs <steps.json> <出力のディレクトリ>
//   node .claude/skills/acceptance-video/record.mjs --check <steps.json>    手順書の形と、見積もりの長さを確かめる
//   node .claude/skills/acceptance-video/record.mjs --probe <steps.json>    録画せずに、要素の指し方が実画面に在るかを試す（書き込みの操作は実行しない）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ESTIMATE_LIMIT_SECONDS,
  FINISH_MS,
  HOLD_MS,
  MARK_MS,
  PAUSE_MS,
  PROBE_TIMEOUT_MS,
  READ_MS,
  RESULT_MS,
  describeItem,
  estimateSeconds,
  pausesAfter,
  probePlan,
  runProbe,
  validatePlan,
} from './plan.mjs';

// 録画の画面。上に 80px の帯を足して 1280×720 にする（compose.py）
const VIEWPORT = { width: 1280, height: 640 };
const MARK_STYLE = '4px solid #ff8c3c';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readPlan(path) {
  let plan;
  try {
    plan = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`手順書を読めない（${path}）: ${err.message}`);
  }
  const problems = validatePlan(plan);
  if (problems.length > 0) fail(problems.join('\n'));
  const seconds = estimateSeconds(plan);
  if (seconds > ESTIMATE_LIMIT_SECONDS) {
    fail(`見積もり ${seconds.toFixed(1)} 秒が ${ESTIMATE_LIMIT_SECONDS} 秒を超える。場面を減らすか、待ちを縮める`);
  }
  return { plan, seconds };
}

function locate(page, spec) {
  const scope = spec.within ? locate(page, spec.within) : page;
  let locator;
  if (spec.css) locator = scope.locator(spec.css);
  else if (spec.role) locator = scope.getByRole(spec.role, { name: spec.name, exact: spec.exact });
  else locator = scope.getByLabel(spec.label);
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}

// ワークツリーの根（cwd）の Playwright、seed のセッション、ポートで、seed のセッションを持つブラウザを開く。
// 録画と試しで、向き先と外へ出さない制限を同じにする
async function openSession(plan, contextOptions) {
  // 別のコピーの値を混ぜない
  const root = process.cwd();
  const { chromium } = createRequire(join(root, 'package.json'))('@playwright/test');
  const load = (file) => import(pathToFileURL(join(root, file)).href);
  const { devPorts } = await load('scripts/dev-ports.ts');
  const { SEED_SESSIONS } = await load('seed/sessions.ts');
  const { sessionCookieName } = await load('src/shared/session-cookie.ts');

  // 向き先は手元の preview だけにする。seed のトークンを別のホストへ送らないよう、上書きの口を持たない
  const base = `http://localhost:${devPorts({}).api}`;
  const who = plan.who ?? 'admin';
  if (!Object.hasOwn(SEED_SESSIONS, who)) fail(`seed に ${who} のセッションが無い（seed/sessions.ts）`);
  console.log(`root: ${root}\nbase: ${base}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, timezoneId: 'Asia/Tokyo', ...contextOptions });
  await context.addCookies([{ name: sessionCookieName(base), value: SEED_SESSIONS[who].token, url: base, httpOnly: true }]);
  // 手順書の操作（リンクを押す、アドレスを入れる）で、手元のブラウザが preview の外のページへ移らないようにする。
  // 止めるのは別オリジンへのナビゲーションだけで、画像や API などの別オリジンの読み込みは止めない
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && new URL(request.url()).origin !== base) return route.abort();
    return route.continue();
  });
  return { browser, context, base };
}

// 録画しない試し。手順書を録画と同じ操作で最後まで通し（待ちは省く）、場面ごとに指し方が実画面に在るかを一覧にする。
// click などで seed の行を書き換えるので、録画の前に pnpm db:seed で戻す。見つからないものがあれば終了コード 1
async function probe(planPath) {
  const { plan } = readPlan(planPath);
  const { browser, context, base } = await openSession(plan);
  let results;
  try {
    const page = await context.newPage();
    const timeout = PROBE_TIMEOUT_MS;
    const exec = async ({ kind, spec, action, path }) => {
      if (kind === 'goto') {
        const response = await page.goto(base + path, { timeout });
        if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
      } else if (kind === 'mark') await locate(page, spec).waitFor({ state: 'attached', timeout });
      else if (kind === 'click') await locate(page, spec).click({ timeout });
      else if (kind === 'check') await locate(page, spec).check({ timeout });
      else if (kind === 'select') await locate(page, spec).selectOption({ label: action.label }, { timeout });
      else if (kind === 'fill') await locate(page, spec).fill(action.text, { timeout });
      else await locate(page, spec).waitFor({ state: action.state ?? 'visible', timeout });
    };
    results = await runProbe(probePlan(plan), exec);
  } finally {
    await context.close();
    await browser.close();
  }
  for (const r of results) {
    const verdict = { found: '在る', missing: '見つからない', skipped: '試せなかった' }[r.status];
    const tail = r.status === 'skipped' ? `（${r.reason}）` : r.detail ? `（${r.detail}）` : '';
    console.log(`場面 ${r.step}: ${verdict}: ${describeItem(r)}${tail}`);
  }
  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(`試した ${count('found') + count('missing')}、見つからない ${count('missing')}、試せなかった ${count('skipped')}`);
  if (count('missing') > 0) process.exit(1);
}

async function main(planPath, outArg) {
  const { plan, seconds } = readPlan(planPath);
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  console.log(`見積もり: ${seconds.toFixed(1)} 秒`);

  const { browser, context, base } = await openSession(plan, { recordVideo: { dir: out, size: VIEWPORT } });
  try {
    const page = await context.newPage();

    // 録画は newPage から始まるので、字幕の時刻の起点をここに置く
    const startedAt = Date.now();
    const cues = [];
    const caption = (text) => cues.push({ t: (Date.now() - startedAt) / 1000, text });
    const wait = (ms) => page.waitForTimeout(ms);

    const perform = async (action) => {
      if (action.goto !== undefined) await page.goto(base + action.goto);
      else if (action.click !== undefined) await locate(page, action.click).click();
      else if (action.check !== undefined) await locate(page, action.check).check();
      else if (action.select !== undefined) await locate(page, action.select).selectOption({ label: action.label });
      else if (action.fill !== undefined) await locate(page, action.fill).fill(action.text);
      else if (action.wait !== undefined) await locate(page, action.wait).waitFor({ state: action.state ?? 'visible' });
      else await wait(action.pause);
    };
    // 録画にはマウスカーソルが映らないので、操作する要素を枠で示す。枠は画面の動きに数えない
    const mark = (spec) =>
      locate(page, spec).evaluate((el, style) => {
        el.dataset.avMark = '1';
        el.style.outline = style;
        el.style.outlineOffset = '3px';
      }, MARK_STYLE);
    const unmark = () =>
      page.evaluate(() =>
        document.querySelectorAll('[data-av-mark]').forEach((el) => {
          el.style.outline = '';
          el.style.outlineOffset = '';
          delete el.dataset.avMark;
        }),
      );

    for (const step of plan.steps) {
      const actions = step.actions ?? [];
      // 字幕を変えるのは画面が止まっているときだけ。出してから READ_MS は画面を動かさず、読んでから操作する
      if (step.caption) caption(step.caption);
      if (step.mark) {
        await mark(step.mark);
        await wait(MARK_MS);
      }
      if (actions.length > 0) {
        if (step.caption) await wait(step.read ?? READ_MS);
        for (const [i, action] of actions.entries()) {
          await perform(action);
          if (pausesAfter(actions, i)) await wait(PAUSE_MS);
        }
        await unmark();
        await wait(step.hold ?? HOLD_MS);
      } else {
        await wait(step.hold ?? RESULT_MS);
        await unmark();
      }
    }

    // 空の字幕で、最後の字幕を閉じる時刻を残す。compose.py は、この少し後で動画を切る
    caption('');
    await wait(FINISH_MS);
    const video = page.video();
    // saveAs は、ブラウザを閉じると動画を取り出せなくなるので、context を閉じたあと、browser を閉じる前に呼ぶ。
    // recordVideo が出力先に書く元のファイルは、saveAs で写したあとに消す
    await context.close();
    await video.saveAs(join(out, 'recording.webm'));
    await video.delete();
    writeFileSync(join(out, 'cues.json'), JSON.stringify(cues, null, 2));
    console.log(`recording: ${join(out, 'recording.webm')}\ncues: ${join(out, 'cues.json')}`);
  } finally {
    await browser.close();
  }
}

const [first, second] = process.argv.slice(2);
if (first === '--probe') {
  await probe(second ?? '');
} else if (first === '--check') {
  const { plan, seconds } = readPlan(second ?? '');
  console.log(`場面 ${plan.steps.length}、見積もり ${seconds.toFixed(1)} 秒（${ESTIMATE_LIMIT_SECONDS} 秒まで）`);
} else if (first === undefined || second === undefined) {
  console.error(
    '使い方: node record.mjs <steps.json> <出力のディレクトリ> | node record.mjs --check <steps.json> | node record.mjs --probe <steps.json>',
  );
  process.exit(2);
} else {
  await main(first, second);
}
