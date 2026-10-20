// 部品の HTML を作る関数と、言葉づかいと配色の切り替え。
// カタログ（index.html）と画面の見本が同じ関数を使い、見た目がずれないようにする。
// 本番の Svelte では、ここの関数がそれぞれ1つのコンポーネントになる。
(function () {
  "use strict";

  // ---- 言葉の辞書（ゲームの言葉 / スクラムの言葉） ----
  const DICT = {
    kingdom: ["王国", "全体"],
    workspace: ["冒険者ギルド", "ワークスペース"], inbox: ["届いた便り", "受信箱"], backlog: ["掲示板", "バックログ"],
    sprint: ["遠征", "スプリント"], plan: ["遠征の計画", "計画"], epic: ["クエスト", "エピック"], story: ["達成目標", "ストーリー"],
    task: ["ミッション", "タスク"], archive: ["保管庫", "アーカイブ"], connection: ["便りの経路", "接続"],
    sprintGoal: ["遠征の目的", "スプリントゴール"], detail: ["手配書", "詳細"], ac: ["達成条件", "受け入れ基準"],
    due: ["期限", "期日"], points: ["難易度", "ポイント"], assignee: ["担い手", "担当"], category: ["系統", "区分"],
    capacity: ["積載量", "作業量と基準"], over: ["重量オーバー", "超過"], done: ["完遂", "完了"],
    doneToday: ["今日の完遂", "今日の完了"], complete: ["完遂にする", "完了にする"],
    requester: ["依頼主", "作成者"], party: ["パーティ", "参加者"], accept: ["受注する", "参加する"],
    reward: ["クリア報酬", "完了の報酬"], clear: ["クリアする", "完了にする"], create: ["依頼を出す", "起票"],
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

  // ---- 部品 ----
  function avatar(name, hue, opts = {}) {
    if (!name) return `<span class="avatar is-none ${opts.lg ? "is-lg" : ""}" title="担当なし">?</span>`;
    return `<span class="avatar ${opts.lg ? "is-lg" : ""} ${opts.left ? "is-left" : ""}" style="--h:${hue}" title="${esc(name)}${opts.left ? "（離脱済み）" : ""}">${esc(name[0])}</span>`;
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
  // 期日の印。today と weekEnd は YYYY-MM-DD
  function dueChip(due, today, weekEnd, opts = {}) {
    if (!due) return "";
    const src = opts.fromSource ? "（取り込み元）" : "";
    if (opts.done) return `<span class="chip">${icon("clock")}${md(due)}${src}</span>`;
    if (due < today) return `<span class="chip is-danger">${icon("alert")}${t("due")}切れ ${md(due)}${src}</span>`;
    if (due === today) return `<span class="chip is-warn">${icon("clock")}今日まで${src}</span>`;
    if (due <= weekEnd) return `<span class="chip is-warn">${icon("clock")}今週 ${md(due)}${src}</span>`;
    return `<span class="chip">${icon("clock")}${md(due)}${src}</span>`;
  }
  function tier(size) {
    const map = { small: ["小", 100], medium: ["中", 300], large: ["大", 600] };
    const [label, xp] = map[size];
    return `<span class="tier is-${size}">${label} · <b>${xp}</b> XP</span>`;
  }

  // 台帳の1行。x はタスク、ctx は { today, weekEnd, stamped:Set }
  function entry(x, ctx) {
    const isToday = x.todayOn === ctx.today;
    const carried = x.todayOn && x.todayOn < ctx.today && !x.doneAt;
    const end = x.doneAt
      ? `<span class="hanko ${ctx.stamped && ctx.stamped.has(x.id) ? "is-new" : ""}" role="img" aria-label="${t("done")}">完</span>
         <button class="link-btn" type="button" data-undo="${x.id}">戻す</button>`
      : `<button class="done-btn" type="button" data-done="${x.id}" aria-label="${t("complete")}" title="${t("complete")}">${icon("check")}</button>`;
    return `<div class="entry ${x.doneAt ? "is-done" : ""}">
      <button class="sun" type="button" data-sun="${x.id}" aria-pressed="${isToday}" aria-label="今日やる" title="今日やる">${icon("sun")}</button>
      <div class="entry-main">
        <a class="entry-title" href="#">${x.review ? "レビュー: " : ""}${esc(x.title)}</a>
        <span class="entry-meta">
          ${x.ws ? `<span class="tag">${esc(x.ws)}</span>` : ""}
          ${x.srcKey ? `<span class="source-key">${icon(x.srcIcon || "link")} ${esc(x.srcKey)}</span>` : ""}
          ${x.parent ? `<span>${icon("flag")} ${esc(x.parent)}</span>` : ""}
          ${x.doneAt ? `<span>${t("done")} ${x.doneAt}</span>` : x.col ? `<span class="status-dot">${esc(x.col)}</span>` : ""}
          ${carried ? `<span class="chip is-carry">${icon("redo")}昨日から持ち越し</span>` : ""}
          ${x.unfilled ? `<span class="chip is-todo">${icon("pen")}${t("detail")} 未記入</span>` : ""}
          ${x.srcDone && !x.doneAt ? `<span class="chip is-ok">${icon("check")}取り込み元で完了</span>` : ""}
        </span>
      </div>
      <div class="entry-end">${dueChip(x.due, ctx.today, ctx.weekEnd, { done: !!x.doneAt })}${pts(x.pts)}${x.assignee ? avatar(x.assignee[0], x.assignee[1]) : ""}${end}</div>
    </div>`;
  }
  function book(list, ctx) {
    return `<div class="book">${list.length ? list.map((x) => entry(x, ctx)).join("") : `<div class="book-empty">ありません</div>`}</div>`;
  }
  function section(id, title, count, body, hint = "") {
    return `<section class="section" aria-labelledby="${id}">
      <div class="section-head"><h2 class="section-title" id="${id}">${title}</h2>${count != null ? `<span class="section-count">${count} 件</span>` : ""}${hint ? `<span class="section-hint">${hint}</span>` : ""}</div>
      ${body}
    </section>`;
  }

  // スプリントゴールの貼り紙。s = { ws, name, start, end, days, dayIndex, goal }
  function sprintNotice(s) {
    const name = s.name ? `${t("sprint")} ${s.name}` : `${t("sprint")} ${md(s.start)}〜${md(s.end)}`;
    const ticks = Array.from({ length: s.days }, (_, i) => `<i class="${i < s.dayIndex ? "is-past" : i === s.dayIndex ? "is-today" : ""}"></i>`).join("");
    return `<article class="notice">
      <span class="notice-label">${t("sprintGoal")}</span>
      <p class="notice-title">${esc(s.goal)}</p>
      <div class="notice-meta"><span>${esc(s.ws)}</span><span>${name}</span>${s.name ? `<span class="mono">${md(s.start)}〜${md(s.end)}</span>` : ""}<span>残り ${s.days - s.dayIndex} 日</span></div>
      <div class="day-ticks" role="img" aria-label="${s.days} 日のうち ${s.dayIndex + 1} 日目">${ticks}</div>
    </article>`;
  }

  // クエストの貼り紙。q = { title, category, requester:[name,hue], tier, due, party:[[name,hue]...], done, all, joined, cleared }
  function questNotice(q, ctx) {
    const pct = q.all ? Math.round((q.done / q.all) * 100) : 0;
    return `<article class="notice is-quest ${q.cleared ? "is-cleared" : ""}">
      <span class="notice-label">依 頼 書${q.category ? `　·　${esc(q.category)}` : ""}</span>
      <p class="notice-title">${esc(q.title)}</p>
      <dl class="notice-facts">
        <div><dt>${t("requester")}</dt><dd>${avatar(q.requester[0], q.requester[1])}${esc(q.requester[0])}<span class="seal" aria-hidden="true">印</span></dd></div>
        <div><dt>${t("reward")}</dt><dd>${tier(q.tier)}</dd></div>
        <div><dt>${t("due")}</dt><dd>${dueChip(q.due, ctx.today, ctx.weekEnd) || "なし"}</dd></div>
        <div><dt>${t("party")}</dt><dd><span class="avatar-stack">${q.party.map((p) => avatar(p[0], p[1])).join("")}</span>${q.party.length}人</dd></div>
      </dl>
      <div class="notice-foot">
        <span class="progress"><span class="progress-bar" role="img" aria-label="完了 ${q.done} / ${q.all} ${t("points")}"><span style="width:${pct}%"></span></span><span class="progress-num">${q.done} / ${q.all} pt</span></span>
        ${q.cleared ? `<span class="hanko" role="img" aria-label="クリア済み">済</span>` : `<button class="btn ${q.joined ? "" : "is-primary"} is-sm" type="button">${q.joined ? "パーティを抜ける" : t("accept")}</button>`}
      </div>
    </article>`;
  }

  // レベルの面。l = { level, xp, toNext, soon, gotPct, soonPct, rows:[[name, xp]...], total }
  function levelPanel(l) {
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

  // 積載量の1行。基準と許容幅（±tolerance）の帯に作業量を重ねる。none は未見積もりの件数
  function load(name, sub, base, work, opts = {}) {
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
      <div class="load-top"><span class="load-name">${esc(name)}</span><span class="load-sub">${esc(sub)}</span>
        <span class="load-val">${work.toFixed(1)}<small> / ${base.toFixed(1)} h</small></span></div>
      <div class="cap ${key}" role="img" aria-label="基準 ${base.toFixed(1)} 時間、作業量 ${work.toFixed(1)} 時間">
        <span class="cap-band" style="left:${(lo / max) * 100}%;width:${((hi - lo) / max) * 100}%"></span>
        <span class="cap-fill" style="width:${(work / max) * 100}%"></span></div>
      <div class="load-foot"><span class="verdict ${key}">${label}</span><span class="load-sub">許容幅 ${lo.toFixed(1)}〜${hi.toFixed(1)} h</span></div>
    </div>`;
  }

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

  // 上の帯の切り替えボタン（言葉、配色）を配線する
  function wireSwitches() {
    document.querySelectorAll("[data-switch='vocab']").forEach((b) => b.addEventListener("click", toggleVocab));
    document.querySelectorAll("[data-switch='theme']").forEach((b) => b.addEventListener("click", cycleTheme));
    const label = () => document.querySelectorAll("[data-vocab-label]").forEach((el) => (el.textContent = `言葉: ${t("vocab")}`));
    onChange(label);
    label();
    applyTheme();
  }

  window.SQ = {
    t, setVocab, toggleVocab, onChange, esc, icon, md, wireSwitches, cycleTheme, applyTheme,
    avatar, emblem, pts, dueChip, tier, entry, book, section, sprintNotice, questNotice, levelPanel, load,
  };
})();
