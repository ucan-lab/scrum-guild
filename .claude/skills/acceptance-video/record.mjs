// 受け入れ動画の録画。手順書（steps の JSON）に沿って seed の画面を操作し、録画（recording.webm）と、字幕を出す時刻（cues.json）を書く。
// 字幕は画面に重ねず、時刻だけを残す。帯への載せ方は compose.py。
// 使い方（ワークツリーの根で。先に pnpm preview と pnpm db:seed）:
//   node .claude/skills/acceptance-video/record.mjs <steps.json> <出力のディレクトリ>
//   node .claude/skills/acceptance-video/record.mjs --check <steps.json>    手順書の形と、待ちだけの長さを確かめる
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ESTIMATE_LIMIT_SECONDS,
  HOLD_MS,
  MARK_MS,
  PAUSE_MS,
  READ_MS,
  RESULT_MS,
  estimateSeconds,
  pausesAfter,
  validatePlan,
} from './plan.mjs';

// 録画の画面。上に 80px の帯を足して 1280×720 にする（compose.py）
const VIEWPORT = { width: 1280, height: 640 };
const MARK_STYLE = '4px solid #ff8c3c';

function readPlan(path) {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const problems = validatePlan(plan);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  return plan;
}

function check(path) {
  const plan = readPlan(path);
  const seconds = estimateSeconds(plan);
  console.log(`場面 ${plan.steps.length}、待ちの合計 ${seconds.toFixed(1)} 秒（録画は、これに読み込みの分が足される）`);
  if (seconds > ESTIMATE_LIMIT_SECONDS) {
    console.error(`${ESTIMATE_LIMIT_SECONDS} 秒を超える。場面を減らすか、待ちを縮める`);
    process.exit(1);
  }
}

function locate(page, spec) {
  const scope = spec.within ? locate(page, spec.within) : page;
  let locator;
  if (spec.css) locator = scope.locator(spec.css);
  else if (spec.role) locator = scope.getByRole(spec.role, { name: spec.name, exact: spec.exact });
  else locator = scope.getByLabel(spec.label);
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}

async function main() {
  const [planPath, outArg] = process.argv.slice(2);
  if (planPath === undefined || outArg === undefined) {
    console.error('使い方: node record.mjs <steps.json> <出力のディレクトリ> | node record.mjs --check <steps.json>');
    process.exit(2);
  }
  const plan = readPlan(planPath);
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });

  // ワークツリーの根（cwd）の Playwright、seed のセッション、ポートを使う。別のコピーの値を混ぜない
  const root = process.cwd();
  const { chromium } = createRequire(join(root, 'package.json'))('@playwright/test');
  const load = (file) => import(pathToFileURL(join(root, file)).href);
  const { devPorts } = await load('scripts/dev-ports.ts');
  const { SEED_SESSIONS } = await load('seed/sessions.ts');
  const { sessionCookieName } = await load('src/shared/session-cookie.ts');

  const base = process.env.BASE_URL ?? `http://localhost:${devPorts(process.env).api}`;
  const session = SEED_SESSIONS[plan.who ?? 'admin'];
  if (session === undefined) {
    console.error(`seed に ${plan.who} のセッションが無い（seed/sessions.ts）`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: out, size: VIEWPORT },
    timezoneId: 'Asia/Tokyo',
  });
  await context.addCookies([{ name: sessionCookieName(base), value: session.token, url: base, httpOnly: true }]);
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
  // 録画にはマウスカーソルが映らないので、操作する要素を枠で示す
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

  // 空の字幕で、最後の字幕を閉じる時刻を残す
  caption('');
  await wait(300);
  const video = page.video();
  // saveAs は、ブラウザを閉じると動画を取り出せなくなるので、context を閉じたあと、browser を閉じる前に呼ぶ
  await context.close();
  await video.saveAs(join(out, 'recording.webm'));
  await browser.close();
  writeFileSync(join(out, 'cues.json'), JSON.stringify(cues, null, 2));
  console.log(`recording: ${join(out, 'recording.webm')}\ncues: ${join(out, 'cues.json')}`);
}

if (process.argv[2] === '--check') check(process.argv[3] ?? '');
else await main();
