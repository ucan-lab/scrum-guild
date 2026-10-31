// 撮った受け入れ動画を、Issue ごとに 1 枚の HTML に並べる。sprint-review で、まとめて撮った動画を見て回るために使う。
// 使い方: node .claude/skills/acceptance-video/gallery.mjs <動画の置き場所>
//   <動画の置き場所>/manifest.json を読み、同じ場所に index.html を書いて、開く URL を出す。外のファイルは読み込まない
// manifest.json: { "title"?: string, "items": [{ "issue": 番号, "title": Issue の題, "video"?: "issue-番号.mp4", "skipped"?: 理由, "failed"?: 理由, "captions"?: [字幕] }] }
//   video、skipped、failed のどれか 1 つだけを持つ
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Issue の題と理由は外の人も書けるので、HTML に入れる前にエスケープする。動画は置き場所の直下の mp4 だけを読む
const VIDEO_NAME = /^[A-Za-z0-9._-]+\.mp4$/;
const MANIFEST_KEYS = ['title', 'items'];
const ITEM_KEYS = ['issue', 'title', 'video', 'skipped', 'failed', 'captions'];
const OUTCOMES = ['video', 'skipped', 'failed'];

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** 問題を文の配列で返す。空なら HTML を作れる */
export function validateManifest(manifest) {
  if (!isObject(manifest)) return ['manifest がオブジェクトでない'];
  const problems = Object.keys(manifest)
    .filter((key) => !MANIFEST_KEYS.includes(key))
    .map((key) => `manifest: ${key} は使えない`);
  if (manifest.title !== undefined && !isText(manifest.title)) problems.push('manifest: title は空でない文字列');
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) return [...problems, 'items が空'];
  manifest.items.forEach((item, i) => {
    const where = `items[${i}]`;
    if (!isObject(item)) {
      problems.push(`${where}: オブジェクトでない`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!ITEM_KEYS.includes(key)) problems.push(`${where}: ${key} は使えない`);
    }
    if (!(Number.isInteger(item.issue) && item.issue > 0)) problems.push(`${where}: issue は正の整数`);
    if (!isText(item.title)) problems.push(`${where}: title は空でない文字列`);
    const given = OUTCOMES.filter((key) => item[key] !== undefined);
    if (given.length !== 1) problems.push(`${where}: ${OUTCOMES.join('、')} のどれか 1 つだけを指定する`);
    for (const key of given) {
      if (!isText(item[key])) problems.push(`${where}: ${key} は空でない文字列`);
    }
    if (typeof item.video === 'string' && !VIDEO_NAME.test(item.video)) {
      problems.push(`${where}: video は置き場所の直下の .mp4 のファイル名（英数字、ドット、ハイフン、アンダースコア）`);
    }
    if (item.captions !== undefined && !(Array.isArray(item.captions) && item.captions.every(isText))) {
      problems.push(`${where}: captions は空でない文字列の配列`);
    }
  });
  return problems;
}

function renderItem(item) {
  const heading = `<h2><span class="num">#${item.issue}</span> ${escapeHtml(item.title)}</h2>`;
  if (item.video !== undefined) {
    const captions = (item.captions ?? []).map((caption) => `<li>${escapeHtml(caption)}</li>`).join('');
    // 録画の頭は、画面を読み込む前の白い画面なので、再生前のサムネイルを 2 秒目の画面にする
    return `<article class="card">${heading}<video controls preload="metadata" src="${escapeHtml(item.video)}#t=2"></video>${
      captions ? `<ol class="captions">${captions}</ol>` : ''
    }</article>`;
  }
  const [kind, label] = item.skipped !== undefined ? ['skipped', '飛ばした'] : ['failed', '撮れなかった'];
  return `<article class="card">${heading}<p class="note ${kind}">${label}: ${escapeHtml(item[kind])}</p></article>`;
}

/** manifest から、外のファイルを読まない 1 枚の HTML を作る。呼ぶ前に validateManifest を通す */
export function renderGallery(manifest) {
  const title = manifest.title ?? '受け入れ動画';
  const count = (key) => manifest.items.filter((item) => item[key] !== undefined).length;
  const summary = `動画 ${count('video')} 本、飛ばした ${count('skipped')} 件、撮れなかった ${count('failed')} 件`;
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg: #f6f7f8; --surface: #fff; --fg: #1d2630; --muted: #5d6a78; --line: #dde2e7; --warn: #9a5b00; --bad: #b3261e; color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #12171d; --surface: #1a212a; --fg: #e4e9ee; --muted: #9aa7b5; --line: #2b3541; --warn: #f0b457; --bad: #f2938d; color-scheme: dark; }
  }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.7 "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .summary { margin: 0 0 20px; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr)); gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; min-width: 0; }
  h2 { font-size: 16px; margin: 0 0 10px; overflow-wrap: anywhere; }
  .num { color: var(--muted); font-variant-numeric: tabular-nums; }
  video { width: 100%; max-width: 100%; background: #000; border-radius: 4px; }
  .captions { margin: 10px 0 0; padding-left: 1.4em; color: var(--muted); font-size: 14px; }
  .note { margin: 0; }
  .skipped { color: var(--warn); }
  .failed { color: var(--bad); }
</style>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="summary">${summary}</p>
  <section class="grid">
${manifest.items.map(renderItem).join('\n')}
  </section>
</main>
`;
}

function main(dir) {
  const manifestPath = join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`manifest を読めない（${manifestPath}）: ${err.message}`);
    process.exit(1);
  }
  const problems = validateManifest(manifest);
  for (const item of Array.isArray(manifest.items) ? manifest.items : []) {
    if (typeof item?.video === 'string' && VIDEO_NAME.test(item.video) && !existsSync(join(dir, item.video))) {
      problems.push(`#${item.issue}: ${item.video} が置き場所に無い`);
    }
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const out = join(dir, 'index.html');
  writeFileSync(out, renderGallery(manifest));
  console.log(pathToFileURL(out).href);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === undefined) {
    console.error('使い方: node gallery.mjs <動画の置き場所>');
    process.exit(2);
  }
  main(resolve(process.argv[2]));
}
