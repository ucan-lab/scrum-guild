// 撮った受け入れ動画を、Issue ごとに 1 枚の HTML に並べる。sprint-review で、まとめて撮った動画を見て回るために使う。
// 使い方: node .claude/skills/acceptance-video/gallery.mjs <動画の置き場所>
//   <動画の置き場所>/manifest.json を読み、同じ場所に index.html を書いて、開く URL を出す。外のファイルは読み込まない
// manifest.json: { "title"?: string, "judge"?: boolean, "items": [{ "issue": 番号, "title": Issue の題, "video"?: "issue-番号.mp4", "skipped"?: 理由, "failed"?: 理由, "captions"?: [字幕], "done"?: boolean }] }
//   video、skipped、failed のどれか 1 つだけを持つ。judge が true なら、動画の Issue ごとに ok / ng と理由とコメントを付けられ、結果をプロンプト用の文にしてコピーできる
//   done が true の Issue は完了済み。判定の一覧、件数、結果の文に入らず、動画は見直せる。judge なら、動画の Issue は「判定の対象に戻す」ボタンで判定の対象へ戻せる
//   HTML は Issue ごとのタブと、先頭の「状況」タブ（一覧と判定の進み具合）に分かれる。判定の対象と完了済みが両方あれば、一覧もタブも 2 つの枠に分ける
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Issue の題と理由は外の人も書けるので、HTML に入れる前にエスケープする。動画は置き場所の直下の mp4 だけを読む
const VIDEO_NAME = /^[A-Za-z0-9._-]+\.mp4$/;
const MANIFEST_KEYS = ['title', 'judge', 'items'];
// ng の理由の選択肢。sprint-review の手順 10 の候補の種別（不具合、仕様の穴、要望）に写せる分け方にしてある
export const NG_REASONS = ['条件を満たさない', '表示が崩れる・動かない', '文言・言葉づかいが違う', '想定と違う', '要望がある'];
const ITEM_KEYS = ['issue', 'title', 'video', 'skipped', 'failed', 'captions', 'done'];
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
  if (manifest.judge !== undefined && typeof manifest.judge !== 'boolean') problems.push('manifest: judge は true か false');
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) return [...problems, 'items が空'];
  const seen = new Set();
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
    else if (seen.has(item.issue)) problems.push(`${where}: issue #${item.issue} が重複している`);
    else seen.add(item.issue);
    if (!isText(item.title)) problems.push(`${where}: title は空でない文字列`);
    const given = OUTCOMES.filter((key) => item[key] !== undefined);
    if (given.length !== 1) problems.push(`${where}: ${OUTCOMES.join('、')} のどれか 1 つだけを指定する`);
    for (const key of given) {
      if (!isText(item[key])) problems.push(`${where}: ${key} は空でない文字列`);
    }
    if (typeof item.video === 'string' && !VIDEO_NAME.test(item.video)) {
      problems.push(`${where}: video は置き場所の直下の .mp4 のファイル名（英数字、ドット、ハイフン、アンダースコア）`);
    }
    if (item.done !== undefined && typeof item.done !== 'boolean') problems.push(`${where}: done は true か false`);
    if (item.captions !== undefined && !(Array.isArray(item.captions) && item.captions.every(isText))) {
      problems.push(`${where}: captions は空でない文字列の配列`);
    }
    if (item.captions !== undefined && item.video === undefined) {
      problems.push(`${where}: captions は video の Issue にだけ付ける（HTML に出ない）`);
    }
  });
  return problems;
}

/**
 * 判定の結果を、プロンプトに貼る文にする。entries: [{ issue, title, status: 'ok' | 'ng' | '', reasons: [理由], comment, note?, done? }]
 * done が true の項目（戻していない完了済み）は、行にも件数にも入れない
 * HTML にそのまま埋め込んで動かすので、外の値を参照しない（toString で写す）。ng でない Issue の理由は出さない
 */
export function buildResult(allEntries) {
  const entries = allEntries.filter((entry) => !entry.done);
  // 題とメモは外の人も書ける。改行を残すと、別の Issue の行を偽れるので、1 行に潰す
  const flat = (text) => String(text).replace(/\s+/g, ' ').trim();
  const count = (status) => entries.filter((entry) => (entry.status || '') === status).length;
  const lines = [
    'sprint-review の受け入れの結果です（動画の HTML で判定）。',
    'ok ' + count('ok') + ' 件、ng ' + count('ng') + ' 件、未判定 ' + count('') + ' 件',
    '',
  ];
  // 判定の対象が 1 件も無いときは、ヘッダだけの 0 件が空の結果に見えないよう、理由を 1 行で添える
  if (entries.length === 0) lines.push('判定の対象の Issue が無い（すべて完了済み）。');
  for (const entry of entries) {
    const label = entry.status === 'ok' ? 'ok' : entry.status === 'ng' ? 'ng' : '未判定';
    lines.push('- #' + entry.issue + ' ' + flat(entry.title) + ': ' + label);
    const reasons = entry.status === 'ng' ? entry.reasons || [] : [];
    if (reasons.length > 0) lines.push('  - 理由: ' + reasons.join('、'));
    const comment = (entry.comment || '').trim();
    if (comment) lines.push('  - コメント: ' + comment.split('\n').join('\n      '));
    if (entry.note) lines.push('  - メモ: ' + flat(entry.note));
  }
  return lines.join('\n');
}

const KIND_LABELS = { video: '動画', skipped: '飛ばした', failed: '撮れなかった' };
const kindOf = (item) => OUTCOMES.find((key) => item[key] !== undefined);
// 動画の無い Issue は HTML で判定できないので、結果には未判定のメモとして入れる
const noteOf = (item) => (item.video === undefined ? `${KIND_LABELS[kindOf(item)]}: ${item[kindOf(item)]}` : '');

function renderJudge() {
  const reasons = NG_REASONS.map(
    (reason) => `<label class="check"><input type="checkbox" value="${escapeHtml(reason)}"> ${escapeHtml(reason)}</label>`,
  ).join('');
  return `<div class="judge">
<div class="verdict" role="group" aria-label="判定"><button type="button" class="verdict-btn ok" data-set="ok" aria-pressed="false">ok</button><button type="button" class="verdict-btn ng" data-set="ng" aria-pressed="false">ng</button></div>
<fieldset class="reasons" hidden><legend>ng の理由（複数選べる）</legend>${reasons}</fieldset>
<label class="comment">フィードバック（任意）<textarea rows="3"></textarea></label>
</div>`;
}

// 完了済みの Issue に出す帯。戻した後は、パネルの data-done が外れて CSS で隠れる。戻すのは判定できる動画の Issue だけ
function renderDoneBox(item, judge) {
  const canReturn = judge && item.video !== undefined;
  const text = judge ? '完了済み: 判定の一覧、件数、結果の文に入れていない。' : '完了済み。';
  const back = canReturn
    ? ' ng を付け直すときは、<button type="button" class="return-btn" data-return>判定の対象に戻す</button>'
    : '';
  return `<div class="done-box"><p>${text}${back}</p></div>`;
}

function renderPanel(item, judge) {
  const heading = `<h2><span class="num">#${item.issue}</span> ${escapeHtml(item.title)}</h2>`;
  const done = item.done === true;
  let body;
  if (item.video !== undefined) {
    const captions = (item.captions ?? []).map((caption) => `<li>${escapeHtml(caption)}</li>`).join('');
    // 録画の頭は、画面を読み込む前の白い画面なので、再生前のサムネイルを 2 秒目の画面にする
    body = `<video controls preload="metadata" src="${escapeHtml(item.video)}#t=2"></video>${
      captions ? `<ol class="captions">${captions}</ol>` : ''
    }${done ? renderDoneBox(item, judge) : ''}${judge ? renderJudge() : ''}`;
  } else {
    const kind = kindOf(item);
    body = `<p class="note ${kind}">${KIND_LABELS[kind]}: ${escapeHtml(item[kind])}</p>${done ? renderDoneBox(item, judge) : ''}${
      judge && !done
        ? '<p class="note">動画が無いので、ここでは判定しない。未判定のまま、画面で 1 条件ずつ確かめる。</p>'
        : ''
    }`;
  }
  const n = item.issue;
  // data-was-done は、戻した後も残り、戻したことを localStorage に保存する目印になる
  const doneAttrs = done ? ' data-done data-was-done' : '';
  return `<section class="card" role="tabpanel" id="panel-${n}" aria-labelledby="tab-${n}" data-issue="${n}" data-title="${escapeHtml(item.title)}" data-note="${escapeHtml(noteOf(item))}"${doneAttrs} hidden>${heading}${body}</section>`;
}

function renderTab(item) {
  const n = item.issue;
  return `<button type="button" role="tab" id="tab-${n}"${item.done === true ? ' class="done"' : ''} aria-controls="panel-${n}" aria-selected="false" tabindex="-1" data-tab="${n}">#${n}<span class="mark" data-mark="${n}"></span></button>`;
}

function renderRow(item, judge) {
  const n = item.issue;
  const badge = judge ? `<span class="badge" data-badge="${n}"${item.done === true ? ' hidden' : ''}>未判定</span>` : '';
  return `<li><button type="button" class="row" data-goto="${n}"><span class="num">#${n}</span><span class="row-title">${escapeHtml(item.title)}</span><span class="kind ${kindOf(item)}">${KIND_LABELS[kindOf(item)]}</span>${badge}</button></li>`;
}

// タブの切り替え、判定の保存、結果のコピー。データは DOM の data 属性から読む（スクリプトに値を埋め込まない）
const CLIENT_SCRIPT = String.raw`(function () {
  var judge = document.body.hasAttribute('data-judge');
  // 判定の対象に戻すとタブの並びが変わるので、タブは使うたびに DOM から取り直す
  function tabList() { return [].slice.call(document.querySelectorAll('[role=tab]')); }
  var panels = [].slice.call(document.querySelectorAll('[role=tabpanel]'));
  var issuePanels = panels.filter(function (p) { return p.hasAttribute('data-issue'); });
  // 作り直した HTML に、前の判定を引き継がないよう、生成ごとの値をキーに入れる。file:// は同じ origin で共有される
  var storeKey = 'scrum-guild-review:' + location.pathname + ':' + document.body.getAttribute('data-run');

  function select(id, focus) {
    tabList().forEach(function (tab) {
      var on = tab.getAttribute('data-tab') === id;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    panels.forEach(function (panel) {
      var on = panel.id === 'panel-' + id;
      panel.hidden = !on;
      if (!on) [].forEach.call(panel.querySelectorAll('video'), function (v) { v.pause(); });
    });
    try { history.replaceState(null, '', '#' + id); } catch (e) {}
  }

  function read(panel) {
    var status = panel.getAttribute('data-status') || '';
    return {
      issue: Number(panel.getAttribute('data-issue')),
      title: panel.getAttribute('data-title'),
      status: status,
      reasons: [].map.call(panel.querySelectorAll('.reasons input:checked'), function (i) { return i.value; }),
      comment: panel.querySelector('textarea') ? panel.querySelector('textarea').value : '',
      note: panel.getAttribute('data-note') || '',
      // done は、戻していない完了済み。returned は、完了済みから判定の対象に戻したもの
      done: panel.hasAttribute('data-done'),
      returned: panel.hasAttribute('data-was-done') && !panel.hasAttribute('data-done')
    };
  }

  function rowOf(panel) { return document.querySelector('[data-goto="' + panel.getAttribute('data-issue') + '"]').parentNode; }
  function tabOf(panel) { return document.getElementById('tab-' + panel.getAttribute('data-issue')); }

  // 戻したパネルの一覧の行とタブを、判定の対象の枠の中で manifest の順（issuePanels の順）の位置に入れる。
  // 開き直したときの復元（manifest の順）と、戻した順に関わらず並びが同じになる
  function place(panel) {
    var later = issuePanels.slice(issuePanels.indexOf(panel) + 1).filter(function (p) { return !p.hasAttribute('data-done'); })[0];
    var sep = document.getElementById('tabs-sep');
    document.getElementById('rows-active').insertBefore(rowOf(panel), later ? rowOf(later) : null);
    sep.parentNode.insertBefore(tabOf(panel), later ? tabOf(later) : sep);
    tabOf(panel).classList.remove('done');
  }

  // 枠の見出しは、判定の対象と完了済みが両方あるときだけ見せる
  function layout() {
    var sep = document.getElementById('tabs-sep');
    if (!sep) return;
    var doneCount = issuePanels.filter(function (p) { return p.hasAttribute('data-done'); }).length;
    var split = doneCount > 0 && doneCount < issuePanels.length;
    sep.hidden = !split;
    document.getElementById('done-heading').hidden = !split;
  }

  function refresh(save) {
    if (!judge) return;
    var entries = issuePanels.map(read);
    entries.forEach(function (e) {
      var panel = document.getElementById('panel-' + e.issue);
      [].forEach.call(panel.querySelectorAll('.verdict-btn'), function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-set') === e.status ? 'true' : 'false');
      });
      var reasons = panel.querySelector('.reasons');
      if (reasons) reasons.hidden = e.status !== 'ng';
      var label = e.status === 'ok' ? 'ok' : e.status === 'ng' ? 'ng' : '未判定';
      var badge = document.querySelector('[data-badge="' + e.issue + '"]');
      badge.textContent = label;
      badge.className = 'badge ' + (e.status || 'none');
      badge.hidden = e.done;
      var mark = document.querySelector('[data-mark="' + e.issue + '"]');
      mark.textContent = e.status === 'ok' ? ' ✓' : e.status === 'ng' ? ' ✕' : '';
      mark.className = 'mark ' + (e.status || 'none');
    });
    // 戻していない完了済みは、進み具合の件数に入れない（結果の文は buildResult が同じ決まりで外す）
    var counted = entries.filter(function (e) { return !e.done; });
    var n = function (s) { return counted.filter(function (e) { return e.status === s; }).length; };
    document.getElementById('counts').textContent = 'ok ' + n('ok') + ' 件、ng ' + n('ng') + ' 件、未判定 ' + n('') + ' 件';
    document.getElementById('result').value = buildResult(entries);
    layout();
    if (save) {
      var kept = entries.map(function (e) {
        return { issue: e.issue, status: e.status, reasons: e.reasons, comment: e.comment, returned: e.returned };
      });
      try { localStorage.setItem(storeKey, JSON.stringify(kept)); } catch (e) {}
    }
  }

  function restore() {
    var saved;
    try { saved = JSON.parse(localStorage.getItem(storeKey) || '[]'); } catch (e) { return; }
    if (!Array.isArray(saved)) return;
    saved.forEach(function (e) {
      var panel = e && document.getElementById('panel-' + e.issue);
      if (!panel || !panel.hasAttribute('data-issue') || !panel.querySelector('.judge')) return;
      // 戻した完了済みは、戻した状態で開き直す
      if (e.returned === true && panel.hasAttribute('data-done')) {
        panel.removeAttribute('data-done');
        place(panel);
      }
      if (e.status === 'ok' || e.status === 'ng') panel.setAttribute('data-status', e.status);
      [].forEach.call(panel.querySelectorAll('.reasons input'), function (i) {
        i.checked = Array.isArray(e.reasons) && e.reasons.indexOf(i.value) >= 0;
      });
      if (typeof e.comment === 'string') panel.querySelector('textarea').value = e.comment;
    });
  }

  tabList().forEach(function (tab) {
    tab.addEventListener('click', function () { select(tab.getAttribute('data-tab')); });
    tab.addEventListener('keydown', function (ev) {
      var step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (step) {
        ev.preventDefault();
        var list = tabList();
        select(list[(list.indexOf(tab) + step + list.length) % list.length].getAttribute('data-tab'), true);
      }
    });
  });
  [].forEach.call(document.querySelectorAll('[data-goto]'), function (row) {
    row.addEventListener('click', function () { select(row.getAttribute('data-goto')); window.scrollTo(0, 0); });
  });

  if (judge) {
    [].forEach.call(document.querySelectorAll('.verdict-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var panel = btn.closest('[data-issue]');
        var next = btn.getAttribute('data-set');
        // 押し直すと未判定に戻す
        if (panel.getAttribute('data-status') === next) panel.removeAttribute('data-status');
        else panel.setAttribute('data-status', next);
        refresh(true);
      });
    });
    [].forEach.call(document.querySelectorAll('[data-return]'), function (btn) {
      btn.addEventListener('click', function () {
        var panel = btn.closest('[data-issue]');
        panel.removeAttribute('data-done');
        place(panel);
        refresh(true);
        // 押したボタンを含む帯が消えるので、フォーカスが body に落ちないよう判定の先頭のボタンへ移す
        panel.querySelector('.verdict-btn.ok').focus();
      });
    });
    document.addEventListener('input', function () { refresh(true); });
    document.getElementById('copy').addEventListener('click', function () {
      var result = document.getElementById('result');
      var message = document.getElementById('copied');
      var done = function (ok) { message.textContent = ok ? 'コピーした' : 'コピーできなかった。下の欄を選んでコピーする'; };
      var fallback = function () {
        result.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        done(ok);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(result.value).then(function () { done(true); }, fallback);
      } else {
        fallback();
      }
    });
    restore();
    refresh(false);
  }

  var initial = location.hash.slice(1);
  select(tabList().some(function (t) { return t.getAttribute('data-tab') === initial; }) ? initial : 'status');
})();`;

/** manifest から、外のファイルを読まない 1 枚の HTML を作る。呼ぶ前に validateManifest を通す */
export function renderGallery(manifest) {
  const title = manifest.title ?? '受け入れ動画';
  // 要約は判定の対象だけを数え、完了済みは別に件数を添える
  const countActive = (key) => manifest.items.filter((item) => item.done !== true && item[key] !== undefined).length;
  const doneCount = manifest.items.filter((item) => item.done === true).length;
  const summary = `動画 ${countActive('video')} 本、飛ばした ${countActive('skipped')} 件、撮れなかった ${countActive('failed')} 件${
    doneCount > 0 ? `、完了済み ${doneCount} 件` : ''
  }`;
  const judge = manifest.judge === true;
  // スクリプトは固定で、manifest の値を含まない。本文のハッシュだけを CSP で許し、エスケープの漏れが実行にならないようにする
  const script = `${buildResult.toString()}\n${CLIENT_SCRIPT}`;
  const scriptHash = createHash('sha256').update(script).digest('base64');
  // 完了済み（done: true）は、判定の対象と別の枠に置く。枠の見出しは、両方があるときだけ見せる
  const activeItems = manifest.items.filter((item) => item.done !== true);
  const doneItems = manifest.items.filter((item) => item.done === true);
  const split = activeItems.length > 0 && doneItems.length > 0;
  const rows = (items) => items.map((item) => renderRow(item, judge)).join('\n');
  const doneRows =
    doneItems.length > 0
      ? `
<h3 id="done-heading"${split ? '' : ' hidden'}>完了済み（判定の対象外）</h3>
<ul class="rows" id="rows-done">
${rows(doneItems)}
</ul>`
      : '';
  const statusPanel = `<section class="card" role="tabpanel" id="panel-status" aria-labelledby="tab-status" hidden>
<h2>状況</h2>
<p class="summary">${summary}</p>${judge ? '\n<p class="progress" id="counts"></p>' : ''}
<ul class="rows" id="rows-active">
${rows(activeItems)}
</ul>${doneRows}${
    judge
      ? `
<h3>結果（プロンプトに貼る）</h3>
<p class="hint">未判定も含めて、判定の対象の Issue が全部入る。完了済み（判定の対象に戻していないもの）は入らない。未判定は、セッションが画面で 1 条件ずつ確かめる。</p>
<div class="actions"><button type="button" class="copy" id="copy">結果をコピー</button><span id="copied" role="status"></span></div>
<textarea id="result" class="result" rows="12" readonly></textarea>`
      : ''
  }
</section>`;
  const tabBar = `<div class="tabs" role="tablist" aria-label="Issue">
<button type="button" role="tab" id="tab-status" aria-controls="panel-status" aria-selected="true" data-tab="status">状況</button>
${activeItems.map(renderTab).join('\n')}${
    doneItems.length > 0
      ? `\n<span class="tabs-sep" id="tabs-sep" role="presentation" aria-hidden="true"${split ? '' : ' hidden'}>完了済み</span>\n${doneItems.map(renderTab).join('\n')}`
      : ''
  }
</div>`;
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'; media-src file: 'self'">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg: #f6f7f8; --surface: #fff; --fg: #1d2630; --muted: #5d6a78; --line: #dde2e7; --warn: #9a5b00; --bad: #b3261e; --ok: #1b7f3b; --accent: #1f5fbf; --on: #fff; color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #12171d; --surface: #1a212a; --fg: #e4e9ee; --muted: #9aa7b5; --line: #2b3541; --warn: #f0b457; --bad: #f2938d; --ok: #6fcf8e; --accent: #7ab0f5; --on: #12171d; color-scheme: dark; }
  }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.7 "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .summary { margin: 0 0 20px; color: var(--muted); }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 12px; position: sticky; top: 0; padding: 8px 0; background: var(--bg); z-index: 1; }
  .tabs [role=tab] { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--fg); cursor: pointer; font-variant-numeric: tabular-nums; }
  .tabs-sep { align-self: center; margin: 0 4px 0 12px; color: var(--muted); font-size: 13px; white-space: nowrap; }
  .tabs [role=tab].done { border-style: dashed; color: var(--muted); }
  .tabs [role=tab][aria-selected=true] { background: var(--accent); border-color: var(--accent); color: var(--on); }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; min-width: 0; }
  .card[hidden] { display: none; }
  h2 { font-size: 16px; margin: 0 0 10px; overflow-wrap: anywhere; }
  h3 { font-size: 14px; margin: 20px 0 4px; }
  .num { color: var(--muted); font-variant-numeric: tabular-nums; }
  video { width: 100%; max-width: 100%; max-height: 70vh; background: #000; border-radius: 4px; }
  .captions { margin: 10px 0 0; padding-left: 1.4em; color: var(--muted); font-size: 14px; }
  .note { margin: 0 0 8px; }
  .hint { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
  .skipped { color: var(--warn); }
  .failed { color: var(--bad); }
  .progress { margin: 0 0 12px; font-weight: 600; }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .row { font: inherit; width: 100%; display: flex; gap: 10px; align-items: baseline; text-align: left; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
  .row:hover { border-color: var(--accent); }
  .row-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .kind { color: var(--muted); font-size: 13px; white-space: nowrap; }
  .badge { font-size: 13px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--line); white-space: nowrap; }
  .badge.ok, .mark.ok { color: var(--ok); border-color: var(--ok); }
  .badge.ng, .mark.ng { color: var(--bad); border-color: var(--bad); }
  .tabs .mark { font-weight: 700; }
  .rows + .rows { margin-top: 6px; }
  .done-box { margin-top: 14px; padding: 8px 12px; border: 1px dashed var(--line); border-radius: 6px; color: var(--muted); }
  .done-box p { margin: 0; }
  .card:not([data-done]) .done-box { display: none; }
  .card[data-done] .judge { display: none; }
  .return-btn { font: inherit; padding: 2px 12px; border-radius: 6px; border: 1px solid var(--accent); background: var(--bg); color: var(--accent); cursor: pointer; }
  .judge { margin-top: 14px; display: grid; gap: 12px; }
  .verdict { display: flex; gap: 8px; }
  .verdict-btn { font: inherit; font-weight: 600; min-width: 88px; padding: 6px 16px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
  .verdict-btn.ok[aria-pressed=true] { background: var(--ok); border-color: var(--ok); color: var(--on); }
  .verdict-btn.ng[aria-pressed=true] { background: var(--bad); border-color: var(--bad); color: var(--on); }
  .reasons { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; }
  .reasons[hidden] { display: none; }
  .check { display: block; }
  .comment { display: grid; gap: 4px; }
  textarea { font: inherit; width: 100%; box-sizing: border-box; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
  .result { font-family: ui-monospace, monospace; font-size: 13px; }
  .actions { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
  .copy { font: inherit; padding: 6px 16px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--on); cursor: pointer; }
  button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
<body data-run="${randomUUID()}"${judge ? ' data-judge' : ''}>
<main>
  <h1>${escapeHtml(title)}</h1>
${tabBar}
${statusPanel}
${manifest.items.map((item) => renderPanel(item, judge)).join('\n')}
</main>
<script>${script}</script>
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
  // 形の検査を通ってから、動画のファイルを確かめる（形が誤りなら、items を読まない）
  const problems = validateManifest(manifest);
  if (problems.length === 0) {
    for (const item of manifest.items) {
      if (item.video === undefined) continue;
      const file = join(dir, item.video);
      if (!existsSync(file)) problems.push(`#${item.issue}: ${item.video} が置き場所に無い`);
      else if (!statSync(file).isFile() || statSync(file).size === 0) {
        problems.push(`#${item.issue}: ${item.video} が空か、ファイルでない`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  // 既にある index.html が symlink などだと、書き込みがリンク先を上書きするので、通常のファイルでなければ断る
  const out = join(dir, 'index.html');
  if (lstatSync(out, { throwIfNoEntry: false })?.isFile() === false) {
    console.error(`index.html が通常のファイルでない（${out}）。消してから、もう一度走らせる`);
    process.exit(1);
  }
  try {
    writeFileSync(out, renderGallery(manifest));
  } catch (err) {
    console.error(`index.html を書けない（${out}）: ${err.message}`);
    process.exit(1);
  }
  console.log(pathToFileURL(out).href);
}

// symlink 経由で呼ばれても動くよう、呼ばれたパスを realpath にして比べる（import.meta.url は realpath になる）
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  if (process.argv[2] === undefined) {
    console.error('使い方: node gallery.mjs <動画の置き場所>');
    process.exit(2);
  }
  main(resolve(process.argv[2]));
}
