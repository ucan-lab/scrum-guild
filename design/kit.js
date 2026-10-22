// 部品の HTML を作る関数、画面の枠、言葉づかいとテーマの切り替え。
// カタログ（index.html）と画面の見本が同じ関数を使い、見た目がずれないようにする。
// 本番の Svelte では、ここの関数がそれぞれ1つのコンポーネントになる。
// sample-data.js を先に読み込んでおくこと。
(function () {
  "use strict";
  const D = window.SQ_DATA;

  // ---- 言葉の辞書（ゲームの言葉 / スクラムの言葉） ----
  const DICT = {
    workspace: ["冒険者ギルド", "ワークスペース"], inbox: ["届いた便り", "受信箱"], backlog: ["掲示板", "バックログ"],
    sprint: ["遠征", "スプリント"], plan: ["遠征の計画", "計画"], epic: ["レイド", "エピック"], story: ["達成目標", "ストーリー"],
    task: ["クエスト", "タスク"], archive: ["保管庫", "アーカイブ"], connection: ["便りの経路", "接続"],
    sprintGoal: ["遠征の目的", "スプリントゴール"], detail: ["手配書", "詳細"], ac: ["達成条件", "受け入れ基準"],
    due: ["期限", "期日"], points: ["難易度", "ポイント"], assignee: ["担い手", "担当"], category: ["系統", "区分"],
    capacity: ["積載量", "作業量と基準"], over: ["重量オーバー", "超過"], done: ["完遂", "完了"], column: ["行程", "列"],
    doneToday: ["今日の完遂", "今日の完了"], complete: ["完遂にする", "完了にする"],
    requester: ["依頼主", "作成者"], party: ["パーティ", "参加者"], accept: ["受注する", "参加する"], leave: ["パーティを抜ける", "参加をやめる"],
    reward: ["クリア報酬", "完了の報酬"], clear: ["レイドをクリアする", "エピックを完了にする"], create: ["依頼を出す", "起票"],
    leader: ["ギルドマスター", "リーダー"], member: ["冒険者", "メンバー"], dod: ["ギルドの掟", "完成の定義"],
    vocab: ["ゲームの言葉", "スクラムの言葉"], kingdom: ["王国", "組織"], king: ["国王", "管理者"],
  };
  let vocab = 0;
  const listeners = [];
  const t = (k) => (DICT[k] ? DICT[k][vocab] : k);
  function setVocab(v) { vocab = v; listeners.forEach((fn) => fn()); }
  function toggleVocab() { setVocab(vocab ? 0 : 1); }
  function onChange(fn) { listeners.push(fn); }

  // ---- 小さな道具 ----
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (id) => `<svg class="ico" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const sumPts = (list) => list.reduce((a, x) => a + (x.pts || 0), 0);

  // ---- データの引き方 ----
  const user = (id) => D.users[id];
  const task = (id) => D.tasks.find((x) => x.id === id);
  const tasksWhere = (pred) => D.tasks.filter(pred);
  function sprintLabel(id) {
    const s = D.sprints[id];
    if (!s) return "";
    return s.name ? `${t("sprint")} ${s.name}` : `${t("sprint")} ${md(s.start)}〜${md(s.end)}`;
  }
  function colName(x) {
    if (x.colName) return x.colName;
    const c = D.columns.find((c) => c.id === x.col);
    return c ? (c.done ? t("done") : c.name) : "";
  }
  // 区分は、親のエピック、親のストーリー、タスク自身の順に引き継ぐ
  function categoryOf(x) {
    if (x.story) {
      const st = D.stories[x.story];
      if (st.epic) return { id: D.epics[st.epic].cat, inherited: true };
      return { id: st.cat, inherited: true };
    }
    return x.cat ? { id: x.cat, inherited: false } : null;
  }
  function storyPts(sid) {
    const list = tasksWhere((x) => x.story === sid);
    return { done: sumPts(list.filter((x) => x.doneAt)), all: sumPts(list) };
  }
  function epicPts(eid) {
    const list = tasksWhere((x) => x.story && D.stories[x.story].epic === eid);
    return { done: sumPts(list.filter((x) => x.doneAt)), all: sumPts(list) };
  }
  // 表示する期日。Team Leveling で振った期日、なければ取り込み元の期限
  function dueOf(x) {
    if (x.due) return { date: x.due, fromSource: false };
    if (x.src && x.src.due) return { date: x.src.due, fromSource: true };
    return null;
  }
  const SRC = {
    backlog: { label: "Backlog の課題", icon: "link" },
    issue: { label: "GitHub の Issue", icon: "git" },
    pr: { label: "GitHub の PR", icon: "git" },
    review: { label: "レビュー依頼", icon: "git" },
  };
  const titleOf = (x) => `${x.src && x.src.kind === "review" ? "レビュー: " : ""}${esc(x.title)}`;

  // ---- 部品 ----
  // ロゴの印。中世風は「冒」、他は頭文字
  const brandSeal = `<span class="brand-seal" aria-hidden="true"><span class="orn-medieval">冒</span><span class="orn-plain">TL</span></span>`;
  function avatar(name, hue, opts = {}) {
    if (!name) return `<span class="avatar is-none ${opts.lg ? "is-lg" : ""}" title="担当なし">?</span>`;
    return `<span class="avatar ${opts.lg ? "is-lg" : ""} ${opts.left ? "is-left" : ""}" style="--h:${hue}" title="${esc(name)}${opts.left ? "（離脱済み）" : ""}">${esc(name[0])}</span>`;
  }
  function avatarOf(uid, opts = {}) {
    if (!uid) return avatar(null, 0, opts);
    const u = user(uid);
    return avatar(u.name, u.hue, { ...opts, left: u.left });
  }
  function emblem(level, sm) {
    return sm
      ? `<span class="emblem is-sm" role="img" aria-label="レベル ${level}"><span>${level}</span></span>`
      : `<span class="emblem" role="img" aria-label="レベル ${level}"><span><small>LV</small>${level}</span></span>`;
  }
  function pts(p) {
    return p == null
      ? `<span class="pts is-none" title="未見積もり">未</span>`
      : `<span class="pts" title="${t("points")} ${p}">${p}</span>`;
  }
  function dueChip(due, opts = {}) {
    if (!due) return "";
    const src = opts.fromSource ? "（取り込み元）" : "";
    if (opts.done) return `<span class="chip">${icon("clock")}${md(due)}${src}</span>`;
    if (due < D.today) return `<span class="chip is-danger">${icon("alert")}${t("due")}切れ ${md(due)}${src}</span>`;
    if (due === D.today) return `<span class="chip is-warn">${icon("clock")}今日まで${src}</span>`;
    if (due <= D.weekEnd) return `<span class="chip is-warn">${icon("clock")}今週 ${md(due)}${src}</span>`;
    return `<span class="chip">${icon("clock")}${md(due)}${src}</span>`;
  }
  function taskDue(x) {
    const d = dueOf(x);
    return d ? dueChip(d.date, { fromSource: d.fromSource, done: !!x.doneAt }) : "";
  }
  function tier(size) {
    const map = { small: ["小", 100], medium: ["中", 300], large: ["大", 600] };
    const [label, xp] = map[size];
    return `<span class="tier is-${size}">${label} · <b>${xp}</b> XP</span>`;
  }
  function sourceKey(x) {
    return x.src ? `<span class="source-key">${icon(SRC[x.src.kind].icon)} ${esc(x.src.key)}</span>` : "";
  }
  function taskFlags(x) {
    const carried = x.todayOn && x.todayOn < D.today && !x.doneAt;
    return `${carried ? `<span class="chip is-carry">${icon("redo")}昨日から持ち越し</span>` : ""}
      ${x.unfilled ? `<span class="chip is-todo">${icon("pen")}${t("detail")} 未記入</span>` : ""}
      ${x.srcDone && !x.doneAt ? `<span class="chip is-ok">${icon("check")}取り込み元で完了</span>` : ""}`;
  }
  const stamped = new Set();
  function doneControl(x) {
    return x.doneAt
      ? `<span class="hanko ${stamped.has(x.id) ? "is-new" : ""}" role="img" aria-label="${t("done")}">${icon("check")}<b>完</b></span>
         <button class="link-btn" type="button" data-undo="${x.id}">戻す</button>`
      : `<button class="done-btn" type="button" data-done="${x.id}" aria-label="${t("complete")}" title="${t("complete")}">${icon("check")}</button>`;
  }

  // 台帳の1行。opts: showWs, showParent（既定 true）, showAssignee
  function entry(x, opts = {}) {
    const showParent = opts.showParent !== false;
    const parent = x.story ? D.stories[x.story].title : null;
    const lead = opts.lead !== undefined ? opts.lead
      : `<button class="sun" type="button" data-sun="${x.id}" aria-pressed="${x.todayOn === D.today}" aria-label="今日やる" title="今日やる">${icon("sun")}</button>`;
    const title = opts.noLink ? `<span class="entry-title">${titleOf(x)}</span>` : `<a class="entry-title" href="#" data-task="${x.id}">${titleOf(x)}</a>`;
    return `<div class="entry ${x.doneAt ? "is-done" : ""}">
      ${lead}
      <div class="entry-main">
        ${title}
        <span class="entry-meta">
          ${opts.showWs ? `<span class="tag">${esc(D.workspaces[x.ws].name)}</span>` : ""}
          ${sourceKey(x)}
          ${showParent && parent ? `<span>${icon("flag")} ${esc(parent)}</span>` : ""}
          ${x.doneAt ? `<span>${t("done")} ${esc(x.doneAt)}</span>` : colName(x) ? `<span class="status-dot">${esc(colName(x))}</span>` : ""}
          ${taskFlags(x)}${opts.meta ? opts.meta(x) : ""}
        </span>
      </div>
      <div class="entry-end">${taskDue(x)}${opts.hidePts ? "" : pts(x.pts)}${opts.showAssignee ? avatarOf(x.who) : ""}${opts.actions ? opts.actions(x) : doneControl(x)}</div>
    </div>`;
  }
  function book(list, opts) {
    return `<div class="book">${list.length ? list.map((x) => entry(x, opts)).join("") : `<div class="book-empty">ありません</div>`}</div>`;
  }
  function section(id, title, count, body, hint = "") {
    return `<section class="section" aria-labelledby="${id}">
      <div class="section-head"><h2 class="section-title" id="${id}">${title}</h2>${count != null ? `<span class="section-count">${count} 件</span>` : ""}${hint ? `<span class="section-hint">${hint}</span>` : ""}</div>
      ${body}
    </section>`;
  }
  function pageHead(eyebrow, title, tallies = [], actions = "") {
    const tally = tallies.length
      ? `<dl class="tally">${tallies.map(([cls, ic, label, n]) => `<div class="${n ? cls : ""}"><dt>${ic ? icon(ic) : ""}${label}</dt><dd>${n}</dd></div>`).join("")}</dl>`
      : "";
    return `<header class="page-head">
      ${eyebrow ? `<span class="page-eyebrow">${eyebrow}</span>` : ""}
      <div class="page-head-row"><h1 class="page-title">${title}</h1>${actions ? `<div class="page-actions">${actions}</div>` : ""}</div>
      ${tally}
    </header>`;
  }

  // スプリントのカード（列の中）
  function card(x) {
    const parent = x.story ? D.stories[x.story].title : null;
    return `<article class="card ${x.doneAt ? "is-done" : ""}">
      ${parent ? `<span class="card-parent">${icon("flag")} ${esc(parent)}</span>` : ""}
      <a class="card-title" href="#" data-task="${x.id}">${titleOf(x)}</a>
      <div class="card-meta">${sourceKey(x)}${taskFlags(x)}${taskDue(x)}</div>
      <div class="card-foot">${pts(x.pts)}${avatarOf(x.who)}<span class="card-end">${doneControl(x)}</span></div>
    </article>`;
  }
  function board(sprintId) {
    const list = tasksWhere((x) => x.sprint === sprintId);
    return `<div class="board-wrap"><div class="board">${D.columns.map((c) => {
      const items = list.filter((x) => (c.done ? x.doneAt : !x.doneAt && x.col === c.id));
      return `<section class="board-col ${c.done ? "is-done" : ""}" aria-label="${c.done ? t("done") : esc(c.name)}">
        <div class="board-col-head">${c.done ? icon("check") : ""}<span class="board-col-name">${c.done ? t("done") : esc(c.name)}</span><span class="board-col-n">${items.length}</span><span class="board-col-pts">${sumPts(items)} pt</span></div>
        ${c.done ? `<details class="dod"><summary>${t("dod")}</summary><ul>${D.definitionOfDone.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></details>` : ""}
        ${items.map(card).join("") || `<p class="board-empty">なし</p>`}
      </section>`;
    }).join("")}</div></div>`;
  }

  // バックログの木
  function treeStory(sid, solo) {
    const st = D.stories[sid];
    const list = tasksWhere((x) => x.story === sid);
    const open = list.filter((x) => !x.doneAt);
    const done = list.length - open.length;
    const p = storyPts(sid);
    return `<details class="tree-group" open>
      <summary class="tree-row is-story ${solo ? "is-root" : ""}">
        <span class="tree-caret">${icon("chevron")}</span>
        <span class="kind is-story" title="${t("story")}">${icon("check")}</span>
        <span class="tree-title">${esc(st.title)}${solo && st.cat ? ` <span class="chip">${esc(D.categories[st.cat].name)}</span>` : ""}</span>
        <span class="tree-ratio" title="完了 / 全体">${t("done")} ${p.done} / ${p.all} pt</span>
      </summary>
      <div class="tree-children">${open.map((x) => entry(x, { showParent: false, showAssignee: true })).join("")}
        ${done ? `<p class="tree-folded">完了 ${done} 件を折りたたんでいます</p>` : ""}${!list.length ? `<p class="tree-folded">${t("task")}はまだありません</p>` : ""}</div>
    </details>`;
  }
  function treeEpic(eid) {
    const e = D.epics[eid];
    const p = epicPts(eid);
    const stories = Object.keys(D.stories).filter((s) => D.stories[s].epic === eid);
    return `<details class="tree-group" open>
      <summary class="tree-row is-epic">
        <span class="tree-caret">${icon("chevron")}</span>
        <span class="kind is-epic" title="${t("epic")}">${icon("flag")}</span>
        <span class="tree-title"><a href="epic.html" class="tree-link">${esc(e.title)}</a> <span class="chip">${esc(D.categories[e.cat].name)}</span> ${dueChip(e.due)}</span>
        <span class="tree-ratio" title="完了 / 全体">${t("done")} ${p.done} / ${p.all} pt</span>
      </summary>
      <div class="tree-children">${stories.map((s) => treeStory(s)).join("")}</div>
    </details>`;
  }

  // スプリントゴールの貼り紙
  function sprintNotice(id, opts = {}) {
    const s = D.sprints[id];
    const ticks = Array.from({ length: s.days }, (_, i) => `<i class="${i < s.dayIndex ? "is-past" : i === s.dayIndex ? "is-today" : ""}"></i>`).join("");
    return `<article class="notice">
      <span class="notice-label">${t("sprintGoal")}</span>
      <p class="notice-title">${esc(s.goal)}</p>
      <div class="notice-meta">${opts.showWs !== false ? `<span>${esc(D.workspaces[s.ws].name)}</span>` : ""}<span>${sprintLabel(id)}</span>${s.name ? `<span class="mono">${md(s.start)}〜${md(s.end)}</span>` : ""}<span>残り ${s.days - s.dayIndex} 日</span></div>
      <div class="day-ticks" role="img" aria-label="${s.days} 日のうち ${s.dayIndex + 1} 日目">${ticks}</div>
    </article>`;
  }
  // レイドの貼り紙（一覧や計画の中で使う小さな形）
  function raidNotice(eid, opts = {}) {
    const q = D.epics[eid];
    const p = epicPts(eid);
    const cleared = opts.cleared ?? q.cleared;
    const joined = q.party.includes(D.me);
    const pct = p.all ? Math.round((p.done / p.all) * 100) : 0;
    return `<article class="notice is-raid ${cleared ? "is-cleared" : ""}">
      <span class="notice-label"><span class="orn-medieval">依 頼 書</span><span class="orn-plain">${t("epic")}</span>　·　${esc(D.categories[q.cat].name)}</span>
      <a class="notice-title notice-link" href="epic.html">${esc(q.title)}</a>
      <dl class="notice-facts">
        <div><dt>${t("requester")}</dt><dd>${avatarOf(q.requester)}${esc(user(q.requester).name)}<span class="seal" aria-hidden="true">印</span></dd></div>
        <div><dt>${t("reward")}</dt><dd>${tier(q.tier)}</dd></div>
        <div><dt>${t("due")}</dt><dd>${dueChip(q.due) || "なし"}</dd></div>
        <div><dt>${t("party")}</dt><dd><span class="avatar-stack">${q.party.map((u) => avatarOf(u)).join("")}</span>${q.party.length}人</dd></div>
      </dl>
      <div class="notice-foot">
        ${progress(p.done, p.all)}
        ${cleared ? `<span class="hanko" role="img" aria-label="クリア済み">${icon("check")}<b>済</b></span>` : `<button class="btn ${joined ? "" : "is-primary"} is-sm" type="button" data-join="${eid}">${joined ? t("leave") : t("accept")}</button>`}
      </div>
    </article>`;
  }
  function progress(done, all) {
    const pct = all ? Math.round((done / all) * 100) : 0;
    return `<span class="progress"><span class="progress-bar" role="img" aria-label="完了 ${done} / ${all} ${t("points")}"><span style="width:${pct}%"></span></span><span class="progress-num">${done} / ${all} pt</span></span>`;
  }

  // レベルの面
  function levelPanel(l = D.level) {
    return `<section class="panel">
      <div class="panel-title"><b>レベル</b>経験値は本人だけに見えます</div>
      <div class="level">${emblem(l.level)}
        <div><div class="xp-num">${l.xp.toLocaleString()}<small>XP</small></div>
        <div class="xp-sub">次のレベルまで <b>${l.toNext}</b>・見込み <b>+${l.soon}</b></div></div>
      </div>
      <div class="gauge" role="img" aria-label="次のレベルまでの ${l.gotPct}% を確定、${l.soonPct}% が見込み"><span class="gauge-got" style="width:${l.gotPct}%"></span><span class="gauge-soon" style="width:${l.soonPct}%"></span></div>
      <div class="legend"><span><i class="is-got"></i>確定</span><span><i class="is-soon"></i>見込み（${t("sprint")}の終了で確定）</span></div>
      ${l.rows ? `<dl class="breakdown">${l.rows.map(([n, v]) => `<div><dt>${esc(n)}</dt><dd>${v.toLocaleString()}</dd></div>`).join("")}
        <div class="is-total"><dt>すべての${t("workspace")}</dt><dd>${l.total.toLocaleString()}</dd></div></dl>` : ""}
    </section>`;
  }

  // 積載量の1行。opts: tolerance、none（未見積もりの件数）、unset（配分未設定）、lead（名前の前に置く HTML）
  function load(name, sub, base, work, opts = {}) {
    const lead = opts.lead || "";
    if (opts.unset) {
      return `<div class="load">
        <div class="load-top">${lead}<span class="load-name">${esc(name)}</span><span class="load-sub">${esc(sub)}</span>
          <span class="load-val">${work.toFixed(1)}<small> h</small></span></div>
        <div class="cap is-unset" role="img" aria-label="配分が未設定なので基準を出せません"></div>
        <div class="load-foot"><span class="verdict is-unknown">配分未設定</span><span class="load-sub">${t("leader")}が配分を決めると出ます</span></div>
      </div>`;
    }
    const tol = opts.tolerance ?? 0.125;
    const none = opts.none || 0;
    const hi = base * (1 + tol), lo = base * (1 - tol);
    const max = Math.max(hi, work, 1) * 1.12;
    let key, label;
    if (work > hi) { key = "is-over"; label = `${icon("alert")}${t("over")}`; }
    else if (work < lo && none) { key = "is-unknown"; label = `未見積もり ${none} 件あり`; }
    else if (work < lo) { key = "is-free"; label = `${icon("check")}余力あり`; }
    else { key = ""; label = `${icon("check")}範囲内`; }
    return `<div class="load">
      <div class="load-top">${lead}<span class="load-name">${esc(name)}</span><span class="load-sub">${esc(sub)}</span>
        <span class="load-val">${work.toFixed(1)}<small> / ${base.toFixed(1)} h</small></span></div>
      <div class="cap ${key}" role="img" aria-label="基準 ${base.toFixed(1)} 時間、作業量 ${work.toFixed(1)} 時間">
        <span class="cap-band" style="left:${(lo / max) * 100}%;width:${((hi - lo) / max) * 100}%"></span>
        <span class="cap-fill" style="width:${(work / max) * 100}%"></span></div>
      <div class="load-foot"><span class="verdict ${key}">${label}</span><span class="load-sub">許容幅 ${lo.toFixed(1)}〜${hi.toFixed(1)} h${none && key !== "is-unknown" ? `・未見積もり ${none} 件` : ""}</span></div>
    </div>`;
  }
  function capacityRows(rows = D.capacity) {
    return rows.map((c) => {
      const u = user(c.who);
      return load(u.name, c.alloc == null ? "配分 —" : `配分 ${c.alloc}%`, c.base, c.work,
        { none: c.none, unset: c.alloc == null, lead: avatarOf(c.who) });
    }).join("");
  }

  // ---- 添付ファイル ----
  // 付く先のキー（タスク、ストーリー、エピックの ID、コメントは "comment:<タスク>:<番号>"）ごとに D.files に持つ。
  // 画像と動画は縮小した絵を並べ、それ以外は1行ずつ。押すとプレビューが開く
  const FILE_ICON = { image: "image", video: "play", file: "file" };
  const FILE_KIND = { image: "画像", video: "動画", file: "ファイル" };
  const filesOf = (key) => D.files[key] || [];
  function findFile(id) {
    for (const key of Object.keys(D.files)) {
      const f = D.files[key].find((x) => x.id === id);
      if (f) return { key, f };
    }
    return null;
  }
  function fileArt(f) {
    return `<span class="file-art ${f.type === "video" ? "is-video" : ""}" aria-hidden="true">${icon(f.type === "video" ? "play" : "image")}${f.length ? `<span class="file-art-time">${f.length}</span>` : ""}</span>`;
  }
  function fileThumb(f) {
    return `<button class="file-thumb" type="button" data-file="${f.id}" aria-label="${esc(f.name)}（${FILE_KIND[f.type]}、${f.size}）を開く">${fileArt(f)}<span class="file-thumb-label"><b>${esc(f.name)}</b><span>${f.size}</span></span></button>`;
  }
  // 1行。f.state が uploading なら進み、error なら理由を出す
  function fileRow(f) {
    if (f.state === "uploading") {
      return `<div class="file-row">${icon("upload")}<div class="file-main"><span class="file-name">${esc(f.name)}</span>
        <span class="file-meta">上げています ${f.pct}%・${f.size}</span>
        <span class="file-bar" role="progressbar" aria-valuenow="${f.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(f.name)} を上げています"><span style="width:${f.pct}%"></span></span></div>
        <div class="file-actions"><button class="btn is-sm is-quiet" type="button" data-cancel-file="${f.id}">やめる</button></div></div>`;
    }
    if (f.state === "error") {
      return `<div class="file-row is-error" role="alert">${icon("alert")}<div class="file-main"><span class="file-name">${esc(f.name)}</span><span class="file-meta">${esc(f.error)}</span></div>
        <div class="file-actions"><button class="btn is-sm is-quiet" type="button" data-cancel-file="${f.id}">閉じる</button></div></div>`;
    }
    return `<div class="file-row">${icon(FILE_ICON[f.type])}<div class="file-main"><button class="file-name" type="button" data-file="${f.id}">${esc(f.name)}</button>
      <span class="file-meta">${f.size}・${esc(user(f.who).name)}・${f.at}</span></div>
      <div class="file-actions"><button class="icon-btn" type="button" data-toast="ダウンロードを始めました" aria-label="${esc(f.name)} をダウンロード" title="ダウンロード">${icon("download")}</button>
        <button class="icon-btn is-danger" type="button" data-delete-file="${f.id}" aria-label="${esc(f.name)} を消す" title="消す">${icon("trash")}</button></div></div>`;
  }
  // 上げる場所。opts.button なら小さなボタンだけ、opts.full なら上限に達した状態
  function dropzone(key, opts = {}) {
    if (opts.full ?? D.storage.used >= D.storage.quota) {
      return `<div class="dropzone is-disabled">${icon("alert")}<span class="dropzone-text"><b>${t("kingdom")}の添付ファイルが上限（${D.storage.quota} GB）に達しているため、添付できません</b><span>${t("king")}が不要なファイルを消すか、上限を上げると添付できます</span></span></div>`;
    }
    if (opts.button) return `<div><button class="btn is-sm is-quiet" type="button" data-pick-file="${key}">${icon("clip")}ファイルを添付</button></div>`;
    return `<div class="dropzone ${opts.over ? "is-over" : ""}" data-drop="${key}">${icon("upload")}
      <span class="dropzone-text"><b>${opts.over ? "離すと添付します" : "ここにファイルをドラッグして添付"}</b><span>1 ファイル 50 MB まで。画像は本文やコメントに貼り付けても添付できます</span></span>
      <button class="btn is-sm" type="button" data-pick-file="${key}">${icon("clip")}ファイルを選ぶ</button></div>`;
  }
  // 添付ファイルの一覧と上げる場所。opts.noDrop なら一覧だけ。上げると data-files-for の中だけを描き直す
  function attachments(key, opts = {}) {
    const list = filesOf(key);
    const media = list.filter((f) => f.type !== "file" && !f.state);
    const rest = list.filter((f) => f.type === "file" || f.state);
    return `<div class="files" data-files-for="${key}" data-files-opts='${JSON.stringify(opts)}'>
      ${media.length ? `<div class="file-thumbs">${media.map(fileThumb).join("")}</div>` : ""}
      ${rest.map(fileRow).join("")}
      ${opts.noDrop ? "" : dropzone(key, opts)}</div>`;
  }
  // Markdown に差し込んだ画像。消したファイルは「見つかりません」と出す
  function mdImage(alt, id) {
    const hit = findFile(id);
    if (!hit) return `<div class="file-row is-error">${icon("image")}<div class="file-main"><span class="file-name">${esc(alt)}</span><span class="file-meta">ファイルが見つかりません。消されたか、まだ上げ終わっていません</span></div></div>`;
    return `<figure class="md-figure">${fileThumb(hit.f)}</figure>`;
  }
  // 本文の段落。"![説明](ファイルの ID)" だけの行は画像として出す
  function mdBody(lines) {
    return lines.map((b) => {
      const m = /^!\[(.*)\]\((\w+)\)$/.exec(b);
      return m ? mdImage(m[1], m[2]) : `<p>${esc(b)}</p>`;
    }).join("");
  }
  // 使っている量と上限。80% を超えたら is-warn、上限に達したら is-full
  function meter(used, quota, opts = {}) {
    const pct = Math.min(100, Math.round((used / quota) * 100));
    const key = used >= quota ? "is-full" : pct >= 80 ? "is-warn" : "";
    const label = `上限 ${quota} GB のうち ${used} GB（${pct}%）`;
    const state = key === "is-full" ? `<span class="chip is-danger">${icon("alert")}上限に達しています</span>`
      : key ? `<span class="chip is-warn">${icon("alert")}上限の ${pct}%</span>` : `<span class="props-note">上限の ${pct}%</span>`;
    if (opts.small) {
      return `<div class="meter meter-small ${key}"><span class="meter-small-top"><span class="mono">${used} / ${quota} GB</span>${key ? `<span class="verdict is-over">${icon("alert")}${pct}%</span>` : ""}</span>
        <div class="meter-bar" role="img" aria-label="${label}"><span style="width:${pct}%"></span></div></div>`;
    }
    return `<div class="meter ${key}"><div class="meter-top"><span class="meter-num">${used}<small> / ${quota} GB</small></span>${state}</div>
      <div class="meter-bar" role="img" aria-label="${label}"><span style="width:${pct}%"></span></div>
      <span class="props-note">縦の線は 80% の位置。超えると${t("king")}に通知します。</span></div>`;
  }

  // ---- タスクの詳細（右から出る引き出し） ----
  const drawer = { id: null, tab: "comments", thanked: new Set(), opener: null };
  function drawerHtml() {
    const x = task(drawer.id);
    const parent = x.story ? D.stories[x.story] : null;
    const epic = parent && parent.epic ? D.epics[parent.epic] : null;
    const d = dueOf(x);
    const cat = categoryOf(x);
    const comments = D.comments[x.id] || [];
    const history = D.history[x.id] || [];
    const others = Object.keys(D.users).filter((u) => u !== D.me && !user(u).left);
    const fieldBody = x.unfilled
      ? `<div class="doc-box is-empty">まだ書かれていません。${t("sprint")}の終了までにすべて埋まっていると、最後に書いた人に経験値が付きます。</div>`
      : `<div class="doc-box"><ul>${(parent ? parent.ac.slice(0, 2) : ["結果を確かめる手順が書かれている"]).map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`;
    const HIST = { column: t("column"), points: t("points"), sprint: t("sprint"), create: "作成" };
    return `
      <div class="drawer-top">
        <span class="chip">${icon(x.src ? SRC[x.src.kind].icon : "pen")}${x.src ? SRC[x.src.kind].label : `手で作った${t("task")}`}</span>
        ${x.src ? `<span class="source-key">${esc(x.src.key)}</span><span class="chip">取り込み元: ${esc(x.src.status)}</span>` : ""}
        <button class="pill drawer-close" type="button" data-close-drawer aria-label="閉じる">${icon("x")}</button>
      </div>
      <h2 class="drawer-title" id="drawer-title">${titleOf(x)}</h2>
      ${x.srcDone && !x.doneAt ? `<div class="callout is-ok">${icon("check")}<span>取り込み元で完了になりました。完了にするかはここで決めます。</span></div>` : ""}
      <dl class="props">
        <div><dt>${t("column")}</dt><dd>${colName(x) ? `<span class="status-dot">${esc(colName(x))}</span>` : "—"}</dd></div>
        <div><dt>${t("assignee")}</dt><dd>${avatarOf(x.who)}${x.who ? esc(user(x.who).name) : "担当なし"}</dd></div>
        <div><dt>${t("points")}</dt><dd>${pts(x.pts)}${x.pts == null ? `<span class="props-note">未見積もり</span>` : ""}</dd></div>
        <div><dt>${t("due")}</dt><dd>${d ? `${taskDue(x)}<span class="props-note">${d.fromSource ? "取り込み元の期限。ここでは変えられません" : "Team Leveling で振った" + t("due")}</span>` : "—"}</dd></div>
        <div><dt>親</dt><dd>${parent ? `${icon("flag")} ${esc(parent.title)}${epic ? `<span class="props-note">${esc(epic.title)}</span>` : ""}` : "なし"}</dd></div>
        <div><dt>${t("sprint")}</dt><dd>${x.sprint ? esc(sprintLabel(x.sprint)) : t("backlog")}</dd></div>
        <div><dt>${t("category")}</dt><dd>${cat ? `${esc(D.categories[cat.id].name)}${cat.inherited ? `<span class="props-note">親から引き継ぎ</span>` : ""}` : `${t("category")}なし`}</dd></div>
        <div><dt>今日やる</dt><dd><button class="sun" type="button" data-sun="${x.id}" aria-pressed="${x.todayOn === D.today}" aria-label="今日やる">${icon("sun")}</button>${x.todayOn === D.today ? "今日やる" : ""}</dd></div>
      </dl>
      <div class="field">
        <span class="field-label">${icon("pen")} ${t("detail")}・${t("ac")} ${x.unfilled ? `<span class="chip is-todo">未記入</span>` : ""}</span>
        ${fieldBody}
      </div>
      <div class="field">
        <span class="field-label">本文</span>
        <div class="doc-box">${x.src ? `<p class="props-note">取り込み元の本文は <span class="mono">${esc(x.src.key)}</span> で開いて読みます。ここには Team Leveling のメモを書けます。</p>` : mdBody(x.body || ["まだ書かれていません。"])}</div>
      </div>
      <div class="field">
        <span class="field-label">${icon("clip")} 添付ファイル ${filesOf(x.id).filter((f) => !f.state).length || ""}</span>
        ${attachments(x.id)}
      </div>
      <div class="done-bar">
        ${x.doneAt ? `<span class="hanko" role="img" aria-label="${t("done")}">${icon("check")}<b>完</b></span><span>${t("done")} ${esc(x.doneAt)}</span><button class="link-btn" type="button" data-undo="${x.id}">戻す</button>`
          : `<button class="btn is-primary" type="button" data-done="${x.id}">${icon("check")}${t("complete")}</button>`}
        <span class="done-bar-dod"><b>${t("dod")}</b>${D.definitionOfDone.map(esc).join("・")}</span>
      </div>
      <div class="field">
        <span class="field-label">${icon("heart")} 感謝</span>
        <div class="thanks">${others.map((u) => {
          const on = drawer.thanked.has(u);
          return `<button class="btn is-sm ${on ? "is-on" : ""}" type="button" data-thank="${u}" aria-pressed="${on}">${avatarOf(u)}${esc(user(u).name)}${on ? " に送った" : " に送る"}</button>`;
        }).join("")}</div>
        <span class="field-hint">送れるのは${t("assignee")}だけ。${t("task")}が完了すると相手に経験値が付きます。完了までは取り消せます。</span>
      </div>
      <div>
        <div class="tabs" role="tablist">
          <button class="tab" type="button" role="tab" data-tab="comments" aria-selected="${drawer.tab === "comments"}">コメント ${comments.filter((c) => !c.deleted).length}</button>
          <button class="tab" type="button" role="tab" data-tab="history" aria-selected="${drawer.tab === "history"}">変更の履歴</button>
        </div>
        ${drawer.tab === "comments" ? `
        <div class="thread">
          ${comments.map((c, i) => `<div class="comment ${c.deleted ? "is-deleted" : ""}">${avatarOf(c.who)}<div>
            <div class="comment-head"><b>${esc(user(c.who).name)}</b><span class="mono">${c.at}</span>${c.edited ? "<span>編集済み</span>" : ""}</div>
            <p class="comment-body">${c.deleted ? "削除されました" : esc(c.body)}</p>
            ${!c.deleted && filesOf(`comment:${x.id}:${i}`).length ? `<div class="comment-files">${filesOf(`comment:${x.id}:${i}`).map((f) => (f.type === "file" ? fileRow(f) : fileThumb(f))).join("")}</div>` : ""}</div></div>`).join("") || `<p class="props-note">まだコメントはありません。</p>`}
          <label class="field" for="new-comment"><span class="field-label">コメントを書く</span><textarea class="textarea" id="new-comment" placeholder="Markdown で書けます"></textarea></label>
          ${attachments(`comment-new:${x.id}`, { noDrop: true })}
          <div class="composer-foot"><button class="btn is-sm is-quiet" type="button" data-pick-file="comment-new:${x.id}">${icon("clip")}ファイルを添付</button>
            <span class="field-hint">画像は貼り付けても添付できます。</span><button class="btn" type="button">送る</button></div>
        </div>` : `
        <ul class="history">${history.map((h) => `<li><span class="mono">${h[0]}</span>${avatarOf(h[1])}<span>${esc(user(h[1]).name)}</span><span class="props-note">${HIST[h[2]]}</span><span>${esc(h[3])}</span></li>`).join("") || `<li class="props-note">まだ変更はありません。</li>`}</ul>`}
      </div>`;
  }
  function openDrawer(id, opener) {
    drawer.id = id; drawer.tab = "comments"; drawer.thanked = new Set(); drawer.opener = opener || null;
    renderDrawer();
    document.querySelector("[data-close-drawer]")?.focus();
  }
  function closeDrawer() {
    drawer.id = null;
    renderDrawer();
    const back = drawer.opener && document.querySelector(`[data-task="${drawer.opener}"]`);
    if (back) back.focus();
  }
  function renderDrawer() {
    const el = document.getElementById("drawer"), scrim = document.getElementById("scrim");
    if (!el) return;
    if (drawer.id) { el.innerHTML = drawerHtml(); el.hidden = false; scrim.hidden = false; }
    else { el.innerHTML = ""; el.hidden = true; scrim.hidden = true; }
  }

  // ---- ダイアログ ----
  // html は中身。閉じる操作は data-close-dialog。開いた元の要素にフォーカスを戻す
  let dialogOpener = null;
  function openDialog(title, body, foot) {
    dialogOpener = document.activeElement;
    const el = document.getElementById("dialog");
    el.innerHTML = `<div class="dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <div class="dialog-head"><h2 class="dialog-title" id="dialog-title">${title}</h2>
        <button class="pill" type="button" data-close-dialog aria-label="閉じる">${icon("x")}</button></div>
      <div class="dialog-body">${body}</div>
      <div class="dialog-foot">${foot}</div></div>`;
    el.hidden = false;
    (el.querySelector("input, textarea, select, .btn.is-primary") || el.querySelector("[data-close-dialog]")).focus();
  }
  function closeDialog() {
    const el = document.getElementById("dialog");
    if (!el || el.hidden) return false;
    el.hidden = true; el.innerHTML = "";
    if (dialogOpener && dialogOpener.focus) dialogOpener.focus();
    return true;
  }
  // 短い知らせ。数秒で消える
  function toast(html) {
    const el = document.getElementById("toasts");
    const item = document.createElement("div");
    item.className = "toast"; item.setAttribute("role", "status"); item.innerHTML = html;
    el.append(item);
    setTimeout(() => item.remove(), 4000);
  }
  // レイドのクリアの演出。判子が押されて、報酬を知らせる。動きを減らす設定では動かさない
  function celebrate(title, reward) {
    const el = document.getElementById("celebrate");
    el.innerHTML = `<div class="celebrate-sheet" role="status">
      <span class="celebrate-stamp" aria-hidden="true">クリア</span>
      <p class="celebrate-title">${esc(title)}</p>
      <p class="celebrate-reward">${reward}</p>
      <button class="btn" type="button" data-close-celebrate>閉じる</button></div>`;
    el.hidden = false;
    el.querySelector("[data-close-celebrate]").focus();
  }
  function closeCelebrate() { const el = document.getElementById("celebrate"); if (el && !el.hidden) { el.hidden = true; el.innerHTML = ""; return true; } return false; }

  // 月の積載量の小さなセル。cell = [基準, 作業量, 未見積もり] か "unset" か null（計画なし）
  function miniCap(cell) {
    if (cell === null) return `<span class="mini-cap is-none">計画なし</span>`;
    if (cell === "unset") return `<span class="mini-cap is-none">配分未設定</span>`;
    const [base, work, none] = cell;
    const hi = base * 1.125, lo = base * 0.875;
    const key = work > hi ? "is-over" : work < lo ? (none ? "is-unknown" : "is-free") : "";
    const label = work > hi ? t("over") : work < lo ? (none ? `未見積もり ${none}` : "余力あり") : "範囲内";
    const max = Math.max(hi, work) * 1.12;
    return `<span class="mini-cap">
      <span class="mini-cap-num">${work.toFixed(1)}<small> / ${base.toFixed(1)}</small></span>
      <span class="cap is-mini ${key}" role="img" aria-label="基準 ${base} 時間、作業量 ${work} 時間"><span class="cap-band" style="left:${(lo / max) * 100}%;width:${((hi - lo) / max) * 100}%"></span><span class="cap-fill" style="width:${(work / max) * 100}%"></span></span>
      <span class="verdict ${key}">${key === "is-over" ? icon("alert") : ""}${label}</span></span>`;
  }

  // ---- 画面で使うダイアログ。data-dialog="名前" のボタンで開く ----
  const DIALOGS = {
    sprintStart: () => openDialog(`${t("sprint")}を始める`,
      `<p>${sprintLabel("sp15")}（${md(D.sprints.sp15.start)}〜${md(D.sprints.sp15.end)}）を始めます。入っている${t("task")}は 3 件、11 pt です。</p>
       <div class="callout is-warn">${icon("alert")}<span>未見積もりが 1 件、${t("detail")}が未記入のものが 2 件あります。始めることはできます。</span></div>
       <label class="field" for="d-goal"><span class="field-label">${t("sprintGoal")}</span><textarea class="textarea" id="d-goal" placeholder="この${t("sprint")}で何ができるようになるか"></textarea><span class="field-hint">空でも始められます。計画、${t("sprint")}、自分の今日の画面に出ます。</span></label>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="${t("sprint")}を始めました">始める</button>`),
    sprintExtend: () => openDialog(`${t("sprint")}を延ばす`,
      `<div class="form-row"><label class="field" for="d-days"><span class="field-label">延ばす日数</span><input class="input" id="d-days" type="number" min="1" value="2"></label>
         <div class="field"><span class="field-label">新しい最終日</span><span class="mono">2026-10-28（水）</span></div></div>
       <div class="callout is-info">${icon("calendar")}<span>次の ${sprintLabel("sp15")} と重なるので、${sprintLabel("sp15")} と ${sprintLabel("sp16")} を同じく 2 日ずつ後ろへずらします。</span></div>
       <p class="field-hint">延ばした${t("sprint")}は、計画の画面のベロシティから除きます。</p>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="2 日延ばしました">2 日延ばす</button>`),
    sprintEnd: () => openDialog(`${t("sprint")}を終える`,
      `<p>${sprintLabel("sp14")} を終えます。終えた${t("sprint")}の期間と中身は、あとから変えられません。</p>
       <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="field-label">終わらなかった${t("task")} 7 件の行き先</legend>
         <div class="choice-list">
           <label class="choice"><input type="radio" name="d-carry" checked><div><b>次の ${sprintLabel("sp15")} へ持ち越す</b><span>同じ${t("task")}をそのまま移します。</span></div></label>
           <label class="choice"><input type="radio" name="d-carry"><div><b>${t("backlog")}へ戻す</b><span>どの${t("sprint")}にも入っていない状態にします。</span></div></label>
         </div></fieldset>
       <div class="field"><span class="field-label">${t("sprintGoal")}は達成できましたか</span>
         <p class="props-note">${esc(D.sprints.sp14.goal)}</p>
         <div class="segmented" role="radiogroup"><label><input type="radio" name="d-goal" checked><span>達成した</span></label><label><input type="radio" name="d-goal"><span>達成していない</span></label></div></div>
       <div class="ac-box"><b>終えると確定する経験値</b><ul><li>起票: 6 件</li><li>${t("detail")}を書いた: 5 件</li></ul></div>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="${sprintLabel("sp14")} を終えました。経験値が確定しました">終える</button>`),
    createTask: () => openDialog(`${t("create")}`,
      `<label class="field" for="d-title"><span class="field-label">タイトル</span><input class="input" id="d-title" placeholder="何をするか"></label>
       <div class="form-row">
         <label class="field" for="d-parent"><span class="field-label">親の${t("story")}</span><select class="select" id="d-parent"><option>なし</option>${Object.values(D.stories).map((x) => `<option>${esc(x.title)}</option>`).join("")}</select></label>
         <label class="field" for="d-who"><span class="field-label">${t("assignee")}</span><select class="select" id="d-who"><option>担当なし</option>${Object.values(D.users).filter((u) => !u.left).map((u) => `<option>${esc(u.name)}</option>`).join("")}</select></label>
       </div>
       <div class="field"><span class="field-label">${t("points")}</span>
         <div class="segmented" role="radiogroup">${["未", 0, 1, 2, 3, 5, 8, 13].map((v, i) => `<label><input type="radio" name="d-pts" ${i === 0 ? "checked" : ""}><span>${v}</span></label>`).join("")}</div>
         <span class="field-hint">「未」は未見積もり。起票の経験値は、1 以上のポイントが振られたまま${t("sprint")}を終えると付きます。</span></div>
       <div class="field"><span class="field-label">添付ファイル</span>${attachments("new", { button: true })}
         <span class="field-hint">保存せずに閉じると、上げたファイルは 1 日で消えます。</span></div>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="${t("backlog")}の末尾に足しました">${t("create")}</button>`),
    deleteEpic: () => {
      openDialog(`${t("epic")}を削除する`,
        `<p>「${esc(D.epics.e1.title)}」を削除します。削除したものは画面から消え、この版では戻せません。</p>
         <div class="choice-list">
           <label class="choice"><input type="radio" name="d-del" checked><div><b>配下を親なしで残す</b><span>${t("story")} 2 件と${t("task")} 6 件は、そのまま${t("backlog")}に残ります。</span></div></label>
           <label class="choice"><input type="radio" name="d-del"><div><b>配下もまとめて削除する</b><span>取り込んだ${t("task")}は削除せず、${t("archive")}へ移します。経験値は残ります。</span></div></label>
         </div>`,
        `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-danger" type="button" data-close-dialog data-toast="削除しました">削除する</button>`);
      document.querySelector(".dialog-sheet").classList.add("is-danger");
    },
    editRecord: () => openDialog("完了の記録を直す",
      `<p class="props-note">「ランク表示の文言を直す」の記録です。直しても経験値は動きません。直したことは変更の履歴に残ります。</p>
       <div class="form-row">
         <label class="field" for="d-rp"><span class="field-label">${t("points")}</span><select class="select" id="d-rp">${[0, 1, 2, 3, 5, 8, 13].map((v) => `<option ${v === 1 ? "selected" : ""}>${v}</option>`).join("")}</select></label>
         <label class="field" for="d-rat"><span class="field-label">完了日時</span><input class="input" id="d-rat" value="2026-10-07 10:30"></label>
         <label class="field" for="d-rm"><span class="field-label">計上月</span><input class="input" id="d-rm" value="2026-10"></label>
       </div>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="記録を直しました">直す</button>`),
    createWorkspace: () => openDialog(`${t("workspace")}を作る`,
      `<label class="field" for="d-wn"><span class="field-label">名前</span><input class="input" id="d-wn" placeholder="例: 保守チーム"></label>
       <label class="field" for="d-wl"><span class="field-label">最初の${t("leader")}</span><select class="select" id="d-wl">${Object.values(D.users).filter((u) => !u.left).map((u) => `<option>${esc(u.name)}</option>`).join("")}</select><span class="field-hint">自分でもかまいません。あとから${t("leader")}を足せます。</span></label>
       <p class="field-hint">列は「出発前、遂行中、査定中、${t("done")}」、換算は 1 ${t("points")} = 4 時間、週の始まりは月曜で作ります。あとから設定で変えられます。</p>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="${t("workspace")}を作りました">作る</button>`),
    createKingdom: () => openDialog(`${t("kingdom")}を作る`,
      `<label class="field" for="d-ks"><span class="field-label">URL の名前（slug）</span><input class="input mono" id="d-ks" placeholder="例: sakura-dev"><span class="field-hint">英小文字、数字、ハイフンで 2〜40 字。あとから変えられません。</span></label>
         <label class="field" for="d-kn"><span class="field-label">表示名</span><input class="input" id="d-kn" placeholder="例: さくら開発"></label>
       <label class="field" for="d-ka"><span class="field-label">最初の${t("king")}の GitHub ユーザー名</span><input class="input mono" id="d-ka" placeholder="例: sakura-taro"><span class="field-hint">作るときに GitHub のユーザー ID に解決します。その人が GitHub でログインすると、この${t("kingdom")}の${t("king")}として入れます。</span></label>
       <div class="callout is-info">${icon("link")}<span>URL は <span class="mono">team-leveling.dev/&lt;slug&gt;/</span> になります。この URL を${t("king")}に伝えてください。</span></div>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="${t("kingdom")}を作りました">作る</button>`),
    reassignKing: () => openDialog(`${t("king")}を指名し直す`,
      `<p>くもラボには今${t("king")}がいません。新しい${t("king")}を GitHub のユーザー名で指名します。</p>
       <label class="field" for="d-ra"><span class="field-label">GitHub ユーザー名</span><input class="input mono" id="d-ra" placeholder="例: kumo-hanako"><span class="field-hint">この${t("kingdom")}のユーザーでなくてもかまいません。指名しても、運用者はこの${t("kingdom")}の中を見られるようにはなりません。</span></label>
       <p class="field-hint">指名は${t("kingdom")}の変更の履歴に、運用者の操作として残ります。</p>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="${t("king")}を指名しました">指名する</button>`),
    // 添付ファイルのプレビュー。画像と動画は画面で見られ、それ以外はダウンロードして開く
    previewFile: (id) => {
      const hit = findFile(id);
      if (!hit) return;
      const f = hit.f;
      openDialog(esc(f.name),
        `<div class="preview">${f.type === "file" ? `<div class="empty" style="border:0">${icon("file")}<b>このファイルは画面では開けません</b><span>ダウンロードして開いてください。</span></div>` : fileArt(f)}</div>
         <dl class="facts"><div><dt>種類</dt><dd>${FILE_KIND[f.type]}</dd></div><div><dt>大きさ</dt><dd class="mono">${f.size}</dd></div><div><dt>上げた人</dt><dd>${avatarOf(f.who)}${esc(user(f.who).name)}</dd></div><div><dt>上げた日時</dt><dd class="mono">${f.at}</dd></div></dl>`,
        `<button class="btn is-quiet is-danger" type="button" data-delete-file="${f.id}">${icon("trash")}消す</button><button class="btn is-primary" type="button" data-toast="ダウンロードを始めました">${icon("download")}ダウンロード</button>`);
      document.querySelector(".dialog-sheet").classList.add("is-wide");
    },
    deleteFile: (id) => {
      const hit = findFile(id);
      if (!hit) return;
      openDialog("添付ファイルを消す",
        `<p>「${esc(hit.f.name)}」を消します。消したファイルは戻せません。</p>
         <p class="field-hint">本文やコメントに差し込んでいた所には「ファイルが見つかりません」と出ます。消したことは変更の履歴に残ります。消せるのは、上げた人と${t("leader")}です。</p>`,
        `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-danger" type="button" data-confirm-delete-file="${id}">${icon("trash")}消す</button>`);
      document.querySelector(".dialog-sheet").classList.add("is-danger");
    },
    changeQuota: () => openDialog("添付ファイルの上限を変える",
      `<p>あおば開発の添付ファイルの合計の上限を変えます。今の合計は 8.3 GB、上限は 10 GB です。</p>
       <div class="choice-list">
         <label class="choice"><input type="radio" name="d-q" checked><div><b>10 GB</b><span>小さい${t("kingdom")}（〜10人）の値段の段</span></div></label>
         <label class="choice"><input type="radio" name="d-q"><div><b>50 GB</b><span>標準（〜50人）の値段の段</span></div></label>
         <label class="choice"><input type="radio" name="d-q"><div><b>ほかの値</b><span><input class="input" type="number" min="1" aria-label="上限（GB）" placeholder="GB で入力" style="max-width:10em"></span></div></label>
       </div>
       <p class="field-hint">今の合計より小さくすると、合計が下がるまで新しく添付できなくなります。上限を上げて 80% を下回ると、次に超えたときにまた${t("king")}に通知します。</p>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-primary" type="button" data-close-dialog data-toast="上限を変えました">変える</button>`),
    suspendKingdom: () => {
      openDialog(`${t("kingdom")}を停止する`,
      `<p>ひばり工房を停止します。停止すると誰も入れなくなり、取り込みと日をまたぐ処理も止まります。データは残り、再開すれば元どおりに使えます。</p>
       <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="field-label">停止の理由</legend>
         <div class="choice-list">
           <label class="choice"><input type="radio" name="d-why" checked><div><b>一時的に止める</b><span>支払いの遅れなど。消す予定は立てません。</span></div></label>
           <label class="choice"><input type="radio" name="d-why"><div><b>解約</b><span>停止から 30 日後に、運用の手順でデータをすべて消します。それまでは再開できます。</span></div></label>
         </div></fieldset>`,
      `<button class="btn is-quiet" type="button" data-close-dialog>やめる</button><button class="btn is-danger" type="button" data-close-dialog data-toast="${t("kingdom")}を停止しました">停止する</button>`);
      document.querySelector(".dialog-sheet").classList.add("is-danger");
    },
  };

  // ---- 画面の枠 ----
  // [id, アイコン, 名前, ファイル, 件数]。文字列だけの行は見出し
  const PAGES = [
    "kingdom",
    ["today", "sun", () => "自分の今日", "today.html"],
    ["notifications", "bell", () => "通知", "notifications.html", 3],
    ["me", "users", () => "自分の設定", "me.html"],
    ["admin", "shield", () => "王国の管理", "admin.html"],
    "workspace",
    ["inbox", "inbox", () => t("inbox"), "inbox.html", 4],
    ["backlog", "board", () => t("backlog"), "backlog.html"],
    ["sprint", "columns", () => t("sprint"), "sprint.html"],
    ["plan", "calendar", () => t("plan"), "plan.html"],
    ["epic", "flag", () => t("epic"), "epic.html"],
    "記録",
    ["capacity", "trend", () => t("capacity"), "capacity.html"],
    ["records", "check", () => "完了の記録", "records.html"],
    ["archive", "archive", () => t("archive"), "archive.html"],
    "管理",
    ["connection", "link", () => t("connection"), "connections.html"],
    ["members", "users", () => "メンバー", "members.html"],
    ["settings", "gear", () => "設定", "settings.html"],
    ["history", "clock", () => "変更の履歴", "history.html"],
  ];
  // 運用者の画面。王国の外にあり、王国の中の画面へは行けない
  const OPERATOR_PAGES = [
    ["operator", "shield", () => "運用", "operator.html"],
  ];
  function navHtml(current, pages) {
    return pages.map((p) => {
      // 入れる王国が2つ以上のときだけ出す。選び直すと王国の選択の画面へ
      if (p === "kingdom") return D.kingdoms.length < 2 ? "" : `<label class="ws-select" for="kd"><span>${t("kingdom")}</span><select id="kd" onchange="location.href='kingdoms.html'">${D.kingdoms.map((k) => `<option ${k.slug === D.kingdom ? "selected" : ""}>${esc(k.name)}</option>`).join("")}<option>${t("kingdom")}の一覧へ</option></select></label>`;
      if (p === "workspace") return `<div class="nav-group">${t("workspace")}</div>
        <label class="ws-select" for="ws"><span>${t("workspace")}</span><select id="ws"><option>${esc(D.workspaces.wa.name)}</option><option>${esc(D.workspaces.wb.name)}</option></select></label>`;
      if (typeof p === "string") return `<div class="nav-group">${p}</div>`;
      const [id, ic, label, href, badge] = p;
      return `<a class="nav-item" href="${href}" ${current === id ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label()}</span>${badge ? `<span class="nav-badge">${badge}</span>` : ""}</a>`;
    }).join("");
  }
  let page = null;
  function redraw() {
    if (!page) return;
    document.getElementById("nav").innerHTML = navHtml(page.current, page.operator ? OPERATOR_PAGES : PAGES);
    document.querySelectorAll("[data-vocab-label]").forEach((el) => (el.textContent = `言葉: ${t("vocab")}`));
    document.getElementById("content").innerHTML = page.render();
    applyTheme();
    renderDrawer();
    stamped.clear();
  }
  // 画面の見本を組み立てる。render は中身の HTML を返す関数。
  // opts.operator なら運用者の画面の枠にする（王国のメニュー、通知、レベルを出さない）
  function mount(current, render, opts = {}) {
    page = { current, render, operator: !!opts.operator };
    const me = user(D.me);
    const who = page.operator
      ? `<span class="me">${avatar(D.operator.name, 0)}${esc(D.operator.name)}<span class="chip">運用者</span></span>`
      : `<button class="pill" type="button" aria-label="通知 3件">${icon("bell")}<span class="pill-count">3</span></button>
          <span class="me">${avatarOf(D.me)}${esc(me.name)}${emblem(me.level, true)}</span>`;
    document.getElementById("app").innerHTML = `
    <div class="app">
      <aside class="binding" aria-label="メニュー"><div class="binding-inner">
        <a class="brand" href="index.html" title="デザインシステムのカタログへ">${brandSeal}<span class="brand-name">Team Leveling</span></a>
        <nav class="nav" id="nav"></nav>
        <p class="binding-foot">デザインの見本。データはすべて架空の例です</p>
      </div></aside>
      <div class="sheet">
        <div class="topbar">
          <button class="pill" type="button" data-switch="vocab">${icon("swap")}<span data-vocab-label></span></button>
          <button class="pill" type="button" data-switch="theme">${icon("moon")}<span data-theme-label></span></button>
          ${who}
        </div>
        <main class="content" id="content"></main>
      </div>
    </div>
    <div class="scrim" id="scrim" data-close-drawer hidden></div>
    <aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden></aside>
    <div class="dialog" id="dialog" hidden></div>
    <div class="celebrate" id="celebrate" hidden></div>
    <div class="toasts" id="toasts" aria-live="polite"></div>`;
    document.querySelector("[data-switch='vocab']").addEventListener("click", toggleVocab);
    document.querySelector("[data-switch='theme']").addEventListener("click", cycleTheme);
    onChange(redraw);
    applyTheme();
    redraw();
  }

  // ---- 操作（見本の中だけで動き、保存はしない） ----
  document.addEventListener("click", (ev) => {
    const hit = (attr) => ev.target.closest(`[${attr}]`);
    let el;
    if ((el = hit("data-sun"))) {
      const x = task(el.dataset.sun);
      x.todayOn = x.todayOn === D.today ? null : D.today;
      redrawAll(); return;
    }
    if ((el = hit("data-done"))) {
      const x = task(el.dataset.done);
      x.doneAt = "10/20 10:12"; if (x.sprint && x.col) x.prevCol = x.col, x.col = "done";
      stamped.add(x.id); redrawAll();
      document.querySelector(`#content [data-undo="${x.id}"]`)?.focus();
      return;
    }
    if ((el = hit("data-undo"))) {
      const x = task(el.dataset.undo);
      x.doneAt = null; if (x.col === "done") x.col = x.prevCol || "c3";
      redrawAll(); return;
    }
    if ((el = hit("data-join"))) {
      const e = D.epics[el.dataset.join];
      e.party = e.party.includes(D.me) ? e.party.filter((u) => u !== D.me) : [...e.party, D.me];
      redrawAll(); return;
    }
    if ((el = hit("data-thank"))) {
      const u = el.dataset.thank;
      drawer.thanked.has(u) ? drawer.thanked.delete(u) : drawer.thanked.add(u);
      renderDrawer(); return;
    }
    if ((el = hit("data-tab"))) { drawer.tab = el.dataset.tab; renderDrawer(); return; }
    if (hit("data-close-drawer")) { closeDrawer(); return; }
    if ((el = hit("data-dialog"))) { if (el.dataset.dialog === "createTask") delete D.files.new; DIALOGS[el.dataset.dialog](); return; }
    if ((el = hit("data-file"))) { DIALOGS.previewFile(el.dataset.file); return; }
    if ((el = hit("data-delete-file"))) { closeDialog(); DIALOGS.deleteFile(el.dataset.deleteFile); return; }
    if ((el = hit("data-confirm-delete-file"))) {
      const found = findFile(el.dataset.confirmDeleteFile);
      if (found) D.files[found.key] = D.files[found.key].filter((x) => x !== found.f);
      closeDialog(); redrawAll(); toast(`${icon("check")}添付ファイルを消しました`); return;
    }
    if ((el = hit("data-pick-file"))) { fakeUpload(el.dataset.pickFile); return; }
    if ((el = hit("data-cancel-file"))) {
      const found = findFile(el.dataset.cancelFile);
      if (found) { D.files[found.key] = D.files[found.key].filter((x) => x !== found.f); redrawFiles(found.key); }
      return;
    }
    if ((el = hit("data-celebrate"))) {
      const e = D.epics[el.dataset.celebrate];
      celebrate(e.title, `${t("party")}の ${e.party.length} 人に ${{ small: 100, medium: 300, large: 600 }[e.tier]} XP`); return;
    }
    if ((el = hit("data-close-dialog")) || ev.target.id === "dialog") {
      const msg = el && el.dataset.toast; closeDialog(); if (msg) toast(`${icon("check")}${esc(msg)}`); return;
    }
    if ((el = hit("data-toast"))) { toast(`${icon("check")}${esc(el.dataset.toast)}`); return; }
    if (hit("data-close-celebrate") || ev.target.id === "celebrate") { closeCelebrate(); return; }
    if ((el = hit("data-task"))) { ev.preventDefault(); openDrawer(el.dataset.task, el.dataset.task); return; }
  });
  document.addEventListener("change", (ev) => {
    if (ev.target.matches("[data-pick-theme]")) setTheme(ev.target.value || null);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (closeCelebrate() || closeDialog()) return;
    if (drawer.id) closeDrawer();
  });
  // 見本の中だけの、上げる動き。ファイルを選ぶかドラッグすると、進みを出してから一覧に加える
  let uploads = 0;
  function redrawFiles(key) {
    document.querySelectorAll(`[data-files-for="${key}"]`).forEach((el) => {
      const opts = JSON.parse(el.dataset.filesOpts || "{}");
      el.outerHTML = attachments(key, opts);
    });
  }
  function fakeUpload(key) {
    uploads += 1;
    const f = uploads % 3 === 0
      ? { id: `n${uploads}`, name: "画面の録画 2026-10-20 11.52.mov", type: "video", size: "82.1 MB", state: "error", error: "50 MB を超えているため添付できません（82.1 MB）" }
      : { id: `n${uploads}`, name: `スクリーンショット 2026-10-20 11.4${uploads}.png`, type: "image", size: "1.8 MB", who: D.me, at: "10/20 11:4" + uploads, state: "uploading", pct: 0 };
    (D.files[key] = D.files[key] || []).push(f);
    redrawFiles(key);
    if (f.state !== "uploading") return;
    const timer = setInterval(() => {
      if (!findFile(f.id)) { clearInterval(timer); return; }
      f.pct = Math.min(100, f.pct + 25);
      if (f.pct === 100) { clearInterval(timer); delete f.state; toast(`${icon("check")}添付しました`); }
      redrawFiles(key);
    }, 350);
  }
  document.addEventListener("dragover", (ev) => {
    const zone = ev.target.closest && ev.target.closest("[data-drop]");
    document.querySelectorAll(".dropzone.is-over").forEach((z) => z !== zone && z.classList.remove("is-over"));
    if (!zone) return;
    ev.preventDefault(); zone.classList.add("is-over");
  });
  document.addEventListener("dragleave", (ev) => {
    const zone = ev.target.closest && ev.target.closest("[data-drop]");
    if (zone && !zone.contains(ev.relatedTarget)) zone.classList.remove("is-over");
  });
  document.addEventListener("drop", (ev) => {
    const zone = ev.target.closest && ev.target.closest("[data-drop]");
    if (!zone) return;
    ev.preventDefault(); fakeUpload(zone.dataset.drop);
  });

  const extraRedraws = [];
  function redrawAll() { redraw(); extraRedraws.forEach((fn) => fn()); }

  // ---- テーマの切り替え（シンプル（自動）→ シンプル（ライト）→ シンプル（ダーク）→ 中世風 → 現代風） ----
  // 値は DB の列挙と同じ。null は自分で選んでいない状態で、見本では王国の既定のシンプル（自動）として出す。
  // 本番では、ユーザーが選んだテーマか王国の既定を data-theme に入れる
  const THEMES = ["simple", "simple_light", "simple_dark", "medieval", "modern"];
  const THEME_LABEL = { simple: "シンプル（自動）", simple_light: "シンプル（ライト）", simple_dark: "シンプル（ダーク）", medieval: "中世風", modern: "現代風" };
  const THEME_NOTE = {
    simple: "業務の道具として落ち着いた見た目。OS のライトとダークに合わせる",
    simple_light: "業務の道具として落ち着いた見た目。いつも明るい地",
    simple_dark: "業務の道具として落ち着いた見た目。いつも暗い地",
    medieval: "冒険者ギルドの帳簿。紙と墨、完了に朱の判子",
    modern: "ハンターに届くシステムのウィンドウ。暗い地に光る枠",
  };
  let theme = null;
  try { theme = localStorage.getItem("sq-design-theme"); } catch (e) { /* なくても動く */ }
  if (!THEMES.includes(theme)) theme = null;
  function applyTheme() {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    document.querySelectorAll("[data-theme-label]").forEach((el) => (el.textContent = `テーマ: ${THEME_LABEL[theme || "simple"]}`));
    // 「王国の既定に従う」（値が空）の選択肢がない並びでは、選んでいない状態をシンプル（自動）として示す
    document.querySelectorAll("[data-pick-theme]").forEach((el) => {
      const hasDefault = !!document.querySelector(`[data-pick-theme][name="${el.name}"][value=""]`);
      el.checked = el.value === (theme || (hasDefault ? "" : "simple"));
    });
  }
  function cycleTheme() { setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]); }
  function setTheme(v) {
    theme = THEMES.includes(v) ? v : null;
    try { theme ? localStorage.setItem("sq-design-theme", theme) : localStorage.removeItem("sq-design-theme"); } catch (e) { /* 同上 */ }
    applyTheme();
  }

  window.SQ = {
    D, t, brandSeal, THEMES, THEME_LABEL, THEME_NOTE, setVocab, toggleVocab, onChange, esc, icon, md, sumPts, cycleTheme, setTheme, applyTheme, mount,
    onRedraw: (fn) => extraRedraws.push(fn), openDrawer, drawerHtml, drawerState: drawer,
    user, task, tasksWhere, sprintLabel, colName, categoryOf, storyPts, epicPts, dueOf,
    avatar, avatarOf, emblem, pts, dueChip, taskDue, tier, sourceKey, entry, book, section, pageHead,
    card, board, treeStory, treeEpic, sprintNotice, raidNotice, progress, levelPanel, load, capacityRows,
    openDialog, closeDialog, toast, celebrate, miniCap, redraw: () => redrawAll(), DIALOGS,
    filesOf, fileThumb, fileRow, dropzone, attachments, mdBody, meter,
  };
})();
