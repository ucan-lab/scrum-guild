// 部品の HTML を作る関数、画面の枠、言葉づかいと配色の切り替え。
// カタログ（index.html）と画面の見本が同じ関数を使い、見た目がずれないようにする。
// 本番の Svelte では、ここの関数がそれぞれ1つのコンポーネントになる。
// sample-data.js を先に読み込んでおくこと。
(function () {
  "use strict";
  const D = window.SQ_DATA;

  // ---- 言葉の辞書（ゲームの言葉 / スクラムの言葉） ----
  const DICT = {
    workspace: ["冒険者ギルド", "ワークスペース"], inbox: ["届いた便り", "受信箱"], backlog: ["掲示板", "バックログ"],
    sprint: ["遠征", "スプリント"], plan: ["遠征の計画", "計画"], epic: ["クエスト", "エピック"], story: ["達成目標", "ストーリー"],
    task: ["ミッション", "タスク"], archive: ["保管庫", "アーカイブ"], connection: ["便りの経路", "接続"],
    sprintGoal: ["遠征の目的", "スプリントゴール"], detail: ["手配書", "詳細"], ac: ["達成条件", "受け入れ基準"],
    due: ["期限", "期日"], points: ["難易度", "ポイント"], assignee: ["担い手", "担当"], category: ["系統", "区分"],
    capacity: ["積載量", "作業量と基準"], over: ["重量オーバー", "超過"], done: ["完遂", "完了"], column: ["行程", "列"],
    doneToday: ["今日の完遂", "今日の完了"], complete: ["完遂にする", "完了にする"],
    requester: ["依頼主", "作成者"], party: ["パーティ", "参加者"], accept: ["受注する", "参加する"], leave: ["パーティを抜ける", "参加をやめる"],
    reward: ["クリア報酬", "完了の報酬"], clear: ["クエストをクリアする", "エピックを完了にする"], create: ["依頼を出す", "起票"],
    leader: ["ギルドマスター", "リーダー"], member: ["冒険者", "メンバー"], dod: ["ギルドの掟", "完成の定義"],
    vocab: ["ゲームの言葉", "スクラムの言葉"],
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
  // 表示する期日。scrum-quest で振った期日、なければ取り込み元の期限
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
      ? `<span class="hanko ${stamped.has(x.id) ? "is-new" : ""}" role="img" aria-label="${t("done")}">完</span>
         <button class="link-btn" type="button" data-undo="${x.id}">戻す</button>`
      : `<button class="done-btn" type="button" data-done="${x.id}" aria-label="${t("complete")}" title="${t("complete")}">${icon("check")}</button>`;
  }

  // 台帳の1行。opts: showWs, showParent（既定 true）, showAssignee
  function entry(x, opts = {}) {
    const showParent = opts.showParent !== false;
    const parent = x.story ? D.stories[x.story].title : null;
    return `<div class="entry ${x.doneAt ? "is-done" : ""}">
      <button class="sun" type="button" data-sun="${x.id}" aria-pressed="${x.todayOn === D.today}" aria-label="今日やる" title="今日やる">${icon("sun")}</button>
      <div class="entry-main">
        <a class="entry-title" href="#" data-task="${x.id}">${titleOf(x)}</a>
        <span class="entry-meta">
          ${opts.showWs ? `<span class="tag">${esc(D.workspaces[x.ws].name)}</span>` : ""}
          ${sourceKey(x)}
          ${showParent && parent ? `<span>${icon("flag")} ${esc(parent)}</span>` : ""}
          ${x.doneAt ? `<span>${t("done")} ${esc(x.doneAt)}</span>` : colName(x) ? `<span class="status-dot">${esc(colName(x))}</span>` : ""}
          ${taskFlags(x)}
        </span>
      </div>
      <div class="entry-end">${taskDue(x)}${pts(x.pts)}${opts.showAssignee ? avatarOf(x.who) : ""}${doneControl(x)}</div>
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
        <span class="tree-ratio" title="完了 / 全体">${p.done} / ${p.all}</span>
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
        <span class="tree-ratio" title="完了 / 全体">${p.done} / ${p.all}</span>
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
  // クエストの貼り紙（一覧や計画の中で使う小さな形）
  function questNotice(eid, opts = {}) {
    const q = D.epics[eid];
    const p = epicPts(eid);
    const cleared = opts.cleared ?? q.cleared;
    const joined = q.party.includes(D.me);
    const pct = p.all ? Math.round((p.done / p.all) * 100) : 0;
    return `<article class="notice is-quest ${cleared ? "is-cleared" : ""}">
      <span class="notice-label">依 頼 書　·　${esc(D.categories[q.cat].name)}</span>
      <a class="notice-title notice-link" href="epic.html">${esc(q.title)}</a>
      <dl class="notice-facts">
        <div><dt>${t("requester")}</dt><dd>${avatarOf(q.requester)}${esc(user(q.requester).name)}<span class="seal" aria-hidden="true">印</span></dd></div>
        <div><dt>${t("reward")}</dt><dd>${tier(q.tier)}</dd></div>
        <div><dt>${t("due")}</dt><dd>${dueChip(q.due) || "なし"}</dd></div>
        <div><dt>${t("party")}</dt><dd><span class="avatar-stack">${q.party.map((u) => avatarOf(u)).join("")}</span>${q.party.length}人</dd></div>
      </dl>
      <div class="notice-foot">
        ${progress(p.done, p.all)}
        ${cleared ? `<span class="hanko" role="img" aria-label="クリア済み">済</span>` : `<button class="btn ${joined ? "" : "is-primary"} is-sm" type="button" data-join="${eid}">${joined ? t("leave") : t("accept")}</button>`}
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
        <div><dt>${t("due")}</dt><dd>${d ? `${taskDue(x)}<span class="props-note">${d.fromSource ? "取り込み元の期限。ここでは変えられません" : "scrum-quest で振った" + t("due")}</span>` : "—"}</dd></div>
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
        <div class="doc-box">${x.src ? `<p class="props-note">取り込み元の本文は <span class="mono">${esc(x.src.key)}</span> で開いて読みます。ここには scrum-quest のメモを書けます。</p>` : (x.body || ["まだ書かれていません。"]).map((b) => `<p>${esc(b)}</p>`).join("")}</div>
      </div>
      <div class="done-bar">
        ${x.doneAt ? `<span class="hanko" role="img" aria-label="${t("done")}">完</span><span>${t("done")} ${esc(x.doneAt)}</span><button class="link-btn" type="button" data-undo="${x.id}">戻す</button>`
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
          ${comments.map((c) => `<div class="comment ${c.deleted ? "is-deleted" : ""}">${avatarOf(c.who)}<div>
            <div class="comment-head"><b>${esc(user(c.who).name)}</b><span class="mono">${c.at}</span>${c.edited ? "<span>編集済み</span>" : ""}</div>
            <p class="comment-body">${c.deleted ? "削除されました" : esc(c.body)}</p></div></div>`).join("") || `<p class="props-note">まだコメントはありません。</p>`}
          <label class="field" for="new-comment"><span class="field-label">コメントを書く</span><textarea class="textarea" id="new-comment" placeholder="Markdown で書けます"></textarea></label>
          <div><button class="btn" type="button">送る</button></div>
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

  // ---- 画面の枠 ----
  const PAGES = [
    ["today", "sun", () => "自分の今日", "today.html"],
    null,
    ["inbox", "inbox", () => t("inbox"), null, 3],
    ["backlog", "board", () => t("backlog"), "backlog.html"],
    ["sprint", "columns", () => t("sprint"), "sprint.html"],
    ["plan", "calendar", () => t("plan"), "plan.html"],
    ["epic", "flag", () => t("epic"), "epic.html"],
    ["archive", "archive", () => t("archive"), null],
    ["connection", "link", () => t("connection"), null],
    ["settings", "gear", () => "設定", null],
  ];
  function navHtml(current) {
    return PAGES.map((p) => {
      if (!p) return `<div class="nav-group">${t("workspace")}</div>
        <label class="ws-select" for="ws"><span>${t("workspace")}</span><select id="ws"><option>${esc(D.workspaces.wa.name)}</option><option>${esc(D.workspaces.wb.name)}</option></select></label>`;
      const [id, ic, label, href, badge] = p;
      if (!href) return `<span class="nav-item is-later" aria-disabled="true" title="この見本にはまだありません">${icon(ic)}<span>${label()}</span>${badge ? `<span class="nav-badge">${badge}</span>` : ""}</span>`;
      return `<a class="nav-item" href="${href}" ${current === id ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label()}</span>${badge ? `<span class="nav-badge">${badge}</span>` : ""}</a>`;
    }).join("");
  }
  let page = null;
  function redraw() {
    if (!page) return;
    document.getElementById("nav").innerHTML = navHtml(page.current);
    document.querySelectorAll("[data-vocab-label]").forEach((el) => (el.textContent = `言葉: ${t("vocab")}`));
    document.getElementById("content").innerHTML = page.render();
    renderDrawer();
    stamped.clear();
  }
  // 画面の見本を組み立てる。render は中身の HTML を返す関数
  function mount(current, render) {
    page = { current, render };
    const me = user(D.me);
    document.getElementById("app").innerHTML = `
    <div class="app">
      <aside class="binding" aria-label="メニュー"><div class="binding-inner">
        <a class="brand" href="index.html" title="デザインシステムのカタログへ"><span class="brand-seal" aria-hidden="true">冒</span><span class="brand-name">scrum-quest</span></a>
        <nav class="nav" id="nav"></nav>
        <p class="binding-foot">デザインの見本。データはすべて架空の例です</p>
      </div></aside>
      <div class="sheet">
        <div class="topbar">
          <button class="pill" type="button" data-switch="vocab">${icon("swap")}<span data-vocab-label></span></button>
          <button class="pill" type="button" data-switch="theme">${icon("moon")}<span data-theme-label></span></button>
          <button class="pill" type="button" aria-label="通知 3件">${icon("bell")}<span class="pill-count">3</span></button>
          <span class="me">${avatarOf(D.me)}${esc(me.name)}${emblem(me.level, true)}</span>
        </div>
        <main class="content" id="content"></main>
      </div>
    </div>
    <div class="scrim" id="scrim" data-close-drawer hidden></div>
    <aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden></aside>`;
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
    if ((el = hit("data-task"))) { ev.preventDefault(); openDrawer(el.dataset.task, el.dataset.task); return; }
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && drawer.id) closeDrawer(); });
  const extraRedraws = [];
  function redrawAll() { redraw(); extraRedraws.forEach((fn) => fn()); }

  // ---- 配色の切り替え（OS に合わせる → ライト → ダーク） ----
  const THEMES = [null, "light", "dark"];
  const THEME_LABEL = { null: "OS に合わせる", light: "ライト", dark: "ダーク" };
  let theme = null;
  try { theme = localStorage.getItem("sq-design-theme"); } catch (e) { /* なくても動く */ }
  if (!THEMES.includes(theme)) theme = null;
  function applyTheme() {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    document.querySelectorAll("[data-theme-label]").forEach((el) => (el.textContent = `配色: ${THEME_LABEL[theme]}`));
  }
  function cycleTheme() {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { theme ? localStorage.setItem("sq-design-theme", theme) : localStorage.removeItem("sq-design-theme"); } catch (e) { /* 同上 */ }
    applyTheme();
  }

  window.SQ = {
    D, t, setVocab, toggleVocab, onChange, esc, icon, md, sumPts, cycleTheme, applyTheme, mount,
    onRedraw: (fn) => extraRedraws.push(fn), openDrawer, drawerHtml, drawerState: drawer,
    user, task, tasksWhere, sprintLabel, colName, categoryOf, storyPts, epicPts, dueOf,
    avatar, avatarOf, emblem, pts, dueChip, taskDue, tier, sourceKey, entry, book, section, pageHead,
    card, board, treeStory, treeEpic, sprintNotice, questNotice, progress, levelPanel, load, capacityRows,
  };
})();
