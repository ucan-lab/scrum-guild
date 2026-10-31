// 受け入れ動画の録画。手順書（steps の JSON）に沿って seed の画面を操作し、録画（recording.webm）と、字幕を出す時刻（cues.json）を書く。
// 字幕は画面に重ねず、時刻だけを残す。帯への載せ方は compose.py。
// 使い方（ワークツリーの根で。先に pnpm preview と pnpm db:seed）:
//   node .claude/skills/acceptance-video/record.mjs <steps.json> <出力のディレクトリ>
//   node .claude/skills/acceptance-video/record.mjs --check <steps.json>    手順書の形と、見積もりの長さを確かめる
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_VOCABULARY,
  ESTIMATE_LIMIT_SECONDS,
  FINISH_MS,
  HOLD_MS,
  KEEP_SEED_VOCABULARY,
  MARK_MS,
  PAUSE_MS,
  READ_MS,
  RESULT_MS,
  estimateSeconds,
  pausesAfter,
  validatePlan,
  withVocabulary,
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

async function main(planPath, outArg) {
  const { plan, seconds } = readPlan(planPath);
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });

  // ワークツリーの根（cwd）の Playwright、seed のセッション、ポートを使う。別のコピーの値を混ぜない
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
  const vocabulary = plan.vocabulary ?? DEFAULT_VOCABULARY;
  console.log(`root: ${root}\nbase: ${base}\n言葉づかい: ${vocabulary}\n見積もり: ${seconds.toFixed(1)} 秒`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: out, size: VIEWPORT },
      timezoneId: 'Asia/Tokyo',
    });
    await context.addCookies([
      { name: sessionCookieName(base), value: SEED_SESSIONS[who].token, url: base, httpOnly: true },
    ]);
    // 手順書の操作（リンクを押す、アドレスを入れる）で、手元のブラウザが preview の外へ出ないようにする。
    // あわせて API の応答の言葉づかいを vocabulary にそろえる。seed にはゲームの言葉のワークスペースがあり、
    // データを書き換えずに、録画の言葉だけをそろえるため
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.isNavigationRequest() && url.origin !== base) return route.abort();
      if (url.origin !== base || !url.pathname.startsWith('/api/') || vocabulary === KEEP_SEED_VOCABULARY) {
        return route.continue();
      }
      const response = await route.fetch();
      if (!(response.headers()['content-type'] ?? '').includes('application/json')) return route.fulfill({ response });
      // 本文を替えるので、元の長さと圧縮の指定は引き継がない
      const headers = { ...response.headers() };
      delete headers['content-length'];
      delete headers['content-encoding'];
      return route.fulfill({ response, headers, json: withVocabulary(await response.json(), vocabulary) });
    });
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
if (first === '--check') {
  const { plan, seconds } = readPlan(second ?? '');
  console.log(`場面 ${plan.steps.length}、見積もり ${seconds.toFixed(1)} 秒（${ESTIMATE_LIMIT_SECONDS} 秒まで）`);
} else if (first === undefined || second === undefined) {
  console.error('使い方: node record.mjs <steps.json> <出力のディレクトリ> | node record.mjs --check <steps.json>');
  process.exit(2);
} else {
  await main(first, second);
}
