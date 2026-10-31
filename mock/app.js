// Scrum Guild のモック。データはすべて架空の例で、操作は保存しない
"use strict";

// ---- 言葉の辞書（スクラムの言葉） ----
const DICT = {
  workspace: "ワークスペース",
  inbox: "受信箱",
  archive: "アーカイブ",
  backlog: "バックログ",
  epic: "エピック",
  story: "ストーリー",
  task: "タスク",
  sprint: "スプリント",
  sprintGoal: "スプリントゴール",
  dod: "完成の定義",
  requester: "作成者",
  party: "参加者",
  accept: "参加する",
  leave: "参加をやめる",
  clear: "エピックを完了する",
  column: "列",
  doneCol: "完了",
  connection: "接続",
  create: "起票",
  detail: "詳細",
  ac: "受け入れ基準",
  due: "期日",
  points: "ポイント",
  assignee: "担当",
  category: "区分",
  capacity: "作業量と基準",
  over: "超過",
  leader: "リーダー",
  member: "メンバー",
  plan: "計画",
};
const state = {
  view: "today",
  epicId: "e1",
  taskId: null,
  drawerTab: "comments",
};
const t = (k) => DICT[k] ?? k;

// ---- 例のデータ ----
const TODAY = "2026-10-20";
const WEEK = ["2026-10-19", "2026-10-25"]; // 週の始まりは月曜

const USERS = {
  u1: { name: "ミナト", hue: 172, lv: 7 },
  u2: { name: "ハルカ", hue: 28, lv: 9 },
  u3: { name: "ソウタ", hue: 220, lv: 5 },
  u4: { name: "リン", hue: 320, lv: 6 },
  u5: { name: "カイ", hue: 90, lv: 4, left: true },
};
const ME = "u1";

const CATEGORIES = {
  k1: { name: "追加案件", monthly: true },
  k2: { name: "保守" },
  k3: { name: "社内改善" },
};

const COLUMNS = [
  { id: "c1", name: "未着手" },
  { id: "c2", name: "作業中" },
  { id: "c3", name: "レビュー" },
  { id: "done", done: true },
];

const SPRINTS = {
  sp13: { label: "第13回", start: "2026-09-29", end: "2026-10-12", status: "closed", done: 29 },
  sp14: {
    label: "第14回", start: "2026-10-13", end: "2026-10-26", status: "active",
    goal: "会員ポイントの付与を管理画面で確かめられる所まで進め、決済の障害の検知を入れる",
  },
  sp15: { label: null, start: "2026-10-27", end: "2026-11-09", status: "planned" },
  sp16: { label: null, start: "2026-11-10", end: "2026-11-23", status: "planned" },
};

const EPICS = {
  e1: {
    title: "会員ポイント制度を公開する", cat: "k1", due: "2026-11-20", tier: "大", reward: 600,
    requester: "u2", party: ["u2", "u1", "u3"],
    body: [
      "購入額に応じてポイントを付け、次の購入で使えるようにする。年内の公開が先方との約束。",
      "失効は付与から1年。管理画面で付与と失効の履歴を追えることを先方が重視している。",
    ],
    link: "https://example.com/spec/points",
  },
  e2: {
    title: "決済まわりの障害を減らす", cat: "k2", due: "2026-10-24", tier: "中", reward: 300,
    requester: "u1", party: ["u1", "u4"],
    body: ["9月に2回あった決済の取りこぼしを受けて、検知と連絡の流れを整える。"],
  },
};

const STORIES = {
  s1: {
    epic: "e1", title: "ポイントの付与と失効を管理画面で確かめられる",
    ac: ["購入の確定でポイントが付く", "失効日を過ぎたポイントが残高から消える", "管理画面で会員ごとの履歴が見られる"],
  },
  s2: {
    epic: "e1", title: "購入時にポイントを使える",
    ac: ["残高の範囲で1ポイント単位で使える", "使ったポイントが注文の明細に出る"],
  },
  s3: {
    epic: "e2", title: "決済の失敗をすぐ検知できる",
    ac: ["Webhook の再送が3回失敗したら通知が届く", "障害時の連絡先と手順が1か所にまとまっている"],
  },
  s4: {
    epic: null, cat: "k2", title: "問い合わせの一次回答を早くする",
    ac: ["よくある問い合わせ10件にテンプレートがある"],
  },
};

// src: 取り込み元。kind は backlog / issue / pr / review
const TASKS = {
  t1: { ws: "受託開発チーム", title: "ポイント付与のバッチを作る", story: "s1", sprint: "sp14", col: "c2", who: "u1", pts: 5, today: TODAY, filled: true, creator: "u1" },
  t2: { ws: "受託開発チーム", title: "失効日の計算に月末の扱いを足す", story: "s1", sprint: "sp14", col: "c3", who: "u3", pts: 3, filled: true,
        src: { kind: "pr", key: "acme/shop#412", status: "open" } },
  t3: { ws: "受託開発チーム", title: "管理画面にポイント履歴の一覧を出す", story: "s1", sprint: "sp14", col: "c1", who: "u2", pts: 5, filled: false, creator: "u2" },
  t4: { ws: "受託開発チーム", title: "購入画面でポイント残高を出す", story: "s2", sprint: "sp15", who: "u3", pts: 3, filled: true, creator: "u3" },
  t5: { ws: "受託開発チーム", title: "ポイント利用の API を設計する", story: "s2", sprint: "sp15", who: "u1", pts: 8, filled: false, creator: "u1" },
  t6: { ws: "受託開発チーム", title: "決済 Webhook の再送を監視する", story: "s3", sprint: "sp14", col: "c2", who: "u4", pts: 3, filled: true,
        src: { kind: "backlog", key: "SHOP-128", status: "処理中", due: TODAY } },
  t7: { ws: "受託開発チーム", title: "タイムアウトの閾値を見直す", story: "s3", sprint: "sp14", col: "done", who: "u4", pts: 2, filled: true, done: "2026-10-16", creator: "u4" },
  t8: { ws: "受託開発チーム", title: "障害時の連絡手順を書く", story: "s3", sprint: "sp14", col: "c1", who: "u1", pts: 1, due: "2026-10-17", today: "2026-10-19", filled: true, creator: "u1" },
  t9: { ws: "受託開発チーム", title: "問い合わせテンプレートを整える", story: "s4", who: null, pts: null, filled: false, creator: "u4" },
  t10: { ws: "受託開発チーム", title: "依存パッケージを更新する", cat: "k2", sprint: "sp14", col: "done", who: "u3", pts: 2, filled: true, done: "2026-10-15",
         src: { kind: "issue", key: "acme/shop#398", status: "closed" } },
  t11: { ws: "受託開発チーム", title: "クーポンの併用制限", cat: "k1", sprint: "sp14", col: "c1", who: "u1", pts: 1, today: TODAY, filled: true,
         src: { kind: "review", key: "acme/shop#418", status: "レビュー待ち" } },
  t12: { ws: "受託開発チーム", title: "請求書 PDF の文字化けを直す", cat: "k2", sprint: "sp14", col: "c3", who: "u1", pts: 2, filled: true,
         src: { kind: "backlog", key: "SHOP-131", status: "完了", sourceDone: true } },
  t13: { ws: "社内ツール", title: "勤怠の CSV 出力で締め日を選べるようにする", sprint: "x", col: "x", who: "u1", pts: 3, due: "2026-10-22", filled: true, creator: "u1" },
  t14: { ws: "受託開発チーム", title: "ポイント失効の通知メールを作る", story: "s1", sprint: "sp15", who: null, pts: null, filled: false, creator: "u2" },
};

const COMMENTS = {
  t1: [
    { who: "u2", at: "10/15 10:12", body: "付与のタイミングは購入の確定時でお願いします。キャンセルされた注文は対象外です。" },
    { who: "u1", at: "10/15 11:40", body: "了解です。確定とキャンセルの両方のイベントを拾うようにします。", edited: true },
    { who: "u3", at: "10/16 09:05", deleted: true },
    { who: "u3", at: "10/16 09:06", body: "バッチの実行時刻は深夜の集計と重ならない 3:30 がよさそうです。" },
  ],
};
const HISTORY = {
  t1: [
    ["10/19 18:02", "u1", t("column"), "未着手 → 作業中"],
    ["10/14 09:30", "u2", t("points"), "3 → 5"],
    ["10/13 10:00", "u2", t("sprint"), "なし → 第14回"],
    ["10/12 16:44", "u1", "作成", ""],
  ],
};

// 積載量（第14回）。値はモックの例として固定で持つ
const CAPACITY = [
  { who: "u1", alloc: 60, base: 45.6, work: 56.0, none: 0, off: "10/23 半日" },
  { who: "u2", alloc: 100, base: 80.0, work: 76.0, none: 0 },
  { who: "u3", alloc: 50, base: 40.0, work: 24.0, none: 1 },
  { who: "u4", alloc: null, base: null, work: 20.0, none: 0 },
];
const TOLERANCE = 0.125;

// ---- 小さな部品 ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const icon = (id) => `<svg class="ico" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

function avatar(uid, cls = "") {
  if (!uid) return `<span class="avatar empty ${cls}" title="担当なし">?</span>`;
  const u = USERS[uid];
  return `<span class="avatar ${cls} ${u.left ? "left" : ""}" style="--h:${u.hue}" title="${esc(u.name)}">${esc(u.name[0])}</span>`;
}
function lv(uid) {
  return `<span class="lv">${icon("star")}Lv ${USERS[uid].lv}</span>`;
}
function pts(p) {
  return p == null
    ? `<span class="pts none" title="未見積もり">未</span>`
    : `<span class="pts" title="${t("points")} ${p}">${p}</span>`;
}
function dueOf(task) {
  if (task.due) return { date: task.due, from: "sq" };
  if (task.src && task.src.due) return { date: task.src.due, from: "src" };
  return null;
}
function dueChip(task) {
  const d = dueOf(task);
  if (!d || task.done) return d ? `<span class="chip">${icon("clock")}${md(d.date)}</span>` : "";
  const srcNote = d.from === "src" ? "（取り込み元）" : "";
  if (d.date < TODAY) return `<span class="chip due-over">${icon("alert")}${t("due")}切れ ${md(d.date)}${srcNote}</span>`;
  if (d.date === TODAY) return `<span class="chip due-week">${icon("clock")}今日${srcNote}</span>`;
  if (d.date <= WEEK[1]) return `<span class="chip due-week">${icon("clock")}今週 ${md(d.date)}${srcNote}</span>`;
  return `<span class="chip">${icon("clock")}${md(d.date)}${srcNote}</span>`;
}
const SRC_LABEL = { backlog: "Backlog 課題", issue: "GitHub Issue", pr: "GitHub PR", review: "レビュー依頼" };
function srcChip(task) {
  if (!task.src) return "";
  return `<span class="src">${icon(task.src.kind === "backlog" ? "link" : "git")}<span class="mono">${esc(task.src.key)}</span></span>`;
}
function flags(task) {
  let s = "";
  if (!task.filled) s += `<span class="chip warn">${icon("pen")}${t("detail")} 未記入</span>`;
  if (task.src && task.src.sourceDone && !task.done) s += `<span class="chip ok">${icon("check")}取り込み元で完了</span>`;
  return s;
}
function catName(task) {
  if (task.story) {
    const st = STORIES[task.story];
    if (st.epic) return CATEGORIES[EPICS[st.epic].cat]?.name;
    return CATEGORIES[st.cat]?.name;
  }
  return task.cat ? CATEGORIES[task.cat].name : null;
}
function sprintName(id) {
  const s = SPRINTS[id];
  if (!s) return "";
  return s.label ? `${t("sprint")} ${s.label}` : `${t("sprint")} ${md(s.start)}〜${md(s.end)}`;
}
function colName(id) {
  const c = COLUMNS.find((c) => c.id === id);
  return c ? (c.done ? t("doneCol") : c.name) : "";
}
function sumPts(list) {
  return list.reduce((a, x) => a + (x.pts || 0), 0);
}
function tasksOf(pred) {
  return Object.entries(TASKS).filter(([, x]) => pred(x)).map(([id, x]) => ({ id, ...x }));
}
function storyPts(sid) {
  const list = tasksOf((x) => x.story === sid);
  return { done: sumPts(list.filter((x) => x.done)), all: sumPts(list) };
}
function epicPts(eid) {
  const list = tasksOf((x) => x.story && STORIES[x.story].epic === eid);
  return { done: sumPts(list.filter((x) => x.done)), all: sumPts(list) };
}

function taskRow(task, opts = {}) {
  const parent = task.story ? STORIES[task.story].title : null;
  const todayOn = task.today === TODAY;
  const carried = task.today && task.today < TODAY && !task.done;
  return `
  <div class="row ${task.done ? "done" : ""} ${opts.cls || ""}" data-task="${task.id}" role="button" tabindex="0">
    <button class="todaybtn" type="button" data-today="${task.id}" aria-pressed="${todayOn}" title="今日やる">${icon("sun")}</button>
    <div class="row-title">
      <span class="t">${task.src && task.src.kind === "review" ? "レビュー: " : ""}${esc(task.title)}</span>
      <span class="row-meta">
        ${opts.ws ? `<span class="chip ws">${esc(task.ws)}</span>` : ""}
        ${srcChip(task)}
        ${opts.parent && parent ? `<span class="src">${icon("flag")}${esc(parent)}</span>` : ""}
        ${carried ? `<span class="chip warn">${icon("swap")}前日から持ち越し</span>` : ""}
        ${flags(task)}
      </span>
    </div>
    <div class="row-end">
      ${dueChip(task)}
      ${pts(task.pts)}
      ${avatar(task.who)}
    </div>
  </div>`;
}

// ---- 画面 ----
const VIEWS = {
  today: { title: () => "自分の今日", icon: "sun", render: renderToday },
  inbox: { title: () => t("inbox"), icon: "inbox", later: true, count: 3 },
  backlog: { title: () => t("backlog"), icon: "board", render: renderBacklog },
  sprint: { title: () => t("sprint"), icon: "columns", render: renderSprint },
  plan: { title: () => t("plan"), icon: "calendar", render: renderPlan },
  raid: { title: () => t("epic"), icon: "flag", render: renderRaid },
  archive: { title: () => t("archive"), icon: "archive", later: true },
  connections: { title: () => t("connection"), icon: "link", later: true },
  settings: { title: () => "設定", icon: "gear", later: true },
};

function renderNav() {
  const item = (key) => {
    const v = VIEWS[key];
    const cur = state.view === key ? ' aria-current="page"' : "";
    return `<a href="#${key}" data-view="${key}"${cur} class="${v.later ? "later" : ""}">${icon(v.icon)}<span>${v.title()}</span>${v.count ? `<span class="count num">${v.count}</span>` : ""}</a>`;
  };
  document.getElementById("nav").innerHTML = `
    ${item("today")}
    <div class="nav-group">${t("workspace")}</div>
    ${item("inbox")}${item("backlog")}${item("sprint")}${item("plan")}${item("raid")}
    ${item("archive")}${item("connections")}${item("settings")}`;
}

function renderToday() {
  const mine = tasksOf((x) => x.who === ME && !x.done);
  const todayList = mine.filter((x) => x.today);
  const dueList = mine.filter((x) => !x.today && dueOf(x) && dueOf(x).date <= WEEK[1]);
  const sprintList = mine.filter((x) => !x.today && !(dueOf(x) && dueOf(x).date <= WEEK[1]) && x.sprint && (x.sprint === "x" || SPRINTS[x.sprint].status === "active"));
  const sec = (title, aside, list) => `
    <section class="section">
      <div class="section-head"><h2>${title}</h2><span class="aside num">${aside}</span></div>
      <div class="rows">${list.length ? list.map((x) => taskRow(x, { ws: true, parent: true })).join("") : `<div class="empty-row">ありません</div>`}</div>
    </section>`;
  const sp = SPRINTS.sp14;
  return `
  <div class="today-grid">
    <div class="section" style="gap:24px">
      <div class="goal">${icon("flag")}<div><b>${t("sprintGoal")}</b>（受託開発チーム ${sprintName("sp14")}）<br>${esc(sp.goal)}
        <div class="meta num">${md(sp.start)}〜${md(sp.end)}・残り 6 日</div></div></div>
      ${sec("今日やる", `${todayList.length} 件`, todayList)}
      ${sec("今日と今週が" + t("due"), `${dueList.length} 件`, dueList)}
      ${sec("進行中の" + t("sprint"), `${sprintList.length} 件`, sprintList)}
    </div>
    <div class="today-side">
      <div class="panel xp-card">
        <div class="xp-head">${avatar(ME, "lg")}<div><div class="side-title">${esc(USERS[ME].name)}</div><div class="muted" style="font-size:var(--fs-xs)">${t("leader")}</div></div>
          <span style="margin-left:auto" class="lvbig">Lv 7</span></div>
        <div class="xp-bar" role="img" aria-label="次のレベルまで 160、見込み 90"><span class="got" style="width:64%"></span><span class="soon" style="width:20%"></span></div>
        <dl class="kv">
          <dt>この${t("workspace")}の経験値</dt><dd>1,240</dd>
          <dt>見込み（${t("sprint")}の終了で確定）</dt><dd>+90</dd>
          <dt>次のレベルまで</dt><dd>160</dd>
          <dt>すべての${t("workspace")}の合計</dt><dd>2,010</dd>
        </dl>
        <div class="muted" style="font-size:var(--fs-xs)">経験値の数値は本人だけに見えます。他のメンバーにはレベルだけが見えます。</div>
      </div>
      <div class="panel xp-card">
        <div class="side-title">${t("capacity")}（${sprintName("sp14")}）</div>
        ${gauge(CAPACITY[0])}
        <dl class="kv"><dt>基準</dt><dd>45.6 時間</dd><dt>作業量</dt><dd>56.0 時間</dd><dt>休み</dt><dd>10/23 半日</dd></dl>
        <span class="status over">${icon("alert")}${t("over")}</span>
      </div>
      <div class="panel xp-card">
        <div class="side-title">チームの経験値</div>
        <dl class="kv"><dt>受託開発チームの合計</dt><dd>9,880</dd></dl>
        <div class="muted" style="font-size:var(--fs-xs)">メンバーの順位は出しません。</div>
      </div>
    </div>
  </div>`;
}

function renderBacklog() {
  const roots = [
    ...Object.keys(EPICS).map((id) => ({ type: "epic", id })),
    { type: "story", id: "s4" },
    { type: "task", id: "t11" },
    { type: "task", id: "t12" },
  ];
  const storyNode = (sid, solo) => {
    const st = STORIES[sid];
    const list = tasksOf((x) => x.story === sid);
    const open = list.filter((x) => !x.done);
    const done = list.filter((x) => x.done);
    const p = storyPts(sid);
    return `<details open>
      <summary class="node story" ${solo ? 'style="padding-left:12px"' : ""}>
        ${icon("chevron").replace('class="ico"', 'class="ico caret"')}
        <span class="kind story" title="${t("story")}">${icon("check")}</span>
        <span>${esc(st.title)} ${solo ? `<span class="chip">${CATEGORIES[st.cat].name}</span>` : ""}</span>
        <span class="ratio num" title="完了 / 全体">${p.done} / ${p.all}</span>
      </summary>
      ${open.map((x) => taskRow(x, { cls: "child" })).join("")}
      ${done.length ? `<div class="folded">完了 ${done.length} 件を折りたたんでいます</div>` : ""}
    </details>`;
  };
  const html = roots.map((r) => {
    if (r.type === "epic") {
      const e = EPICS[r.id];
      const p = epicPts(r.id);
      const stories = Object.keys(STORIES).filter((s) => STORIES[s].epic === r.id);
      return `<details open>
        <summary class="node epic">
          ${icon("chevron").replace('class="ico"', 'class="ico caret"')}
          <span class="kind epic" title="${t("epic")}">${icon("flag")}</span>
          <span>${esc(e.title)} <span class="chip">${CATEGORIES[e.cat].name}</span> ${dueChip({ due: e.due })}</span>
          <span class="ratio num" title="完了 / 全体">${p.done} / ${p.all}</span>
        </summary>
        ${stories.map((s) => storyNode(s)).join("")}
      </details>`;
    }
    if (r.type === "story") return storyNode(r.id, true);
    return taskRow({ id: r.id, ...TASKS[r.id] }, { cls: "child solo" });
  }).join("") + `<div class="folded" style="padding-left:12px">親のない完了 1 件を折りたたんでいます</div>`;
  return `
  <div class="filters">
    <label class="search" for="q">${icon("search")}<input id="q" type="search" placeholder="タイトルや SHOP-128 で探す"></label>
    <select id="f-who" aria-label="${t("assignee")}"><option>${t("assignee")}: すべて</option><option>ミナト</option><option>担当なし</option></select>
    <select id="f-cat" aria-label="${t("category")}"><option>${t("category")}: すべて</option><option>追加案件</option><option>保守</option><option>${t("category")}なし</option></select>
    <select id="f-conn" aria-label="${t("connection")}"><option>${t("connection")}: すべて</option><option>ミナトの Backlog</option><option>ミナトの GitHub</option></select>
    <button class="btn primary" type="button">${icon("plus")}${t("create")}</button>
  </div>
  <div class="tree">${html}</div>
  <p class="muted" style="font-size:var(--fs-xs);margin:0">並びが優先順位です。ドラッグか、行を選んで Alt + ↑↓ で並べ替えます。</p>`;
}

function card(task) {
  const parent = task.story ? STORIES[task.story].title : null;
  return `<button class="card ${task.done ? "done" : ""}" type="button" data-task="${task.id}">
    ${parent ? `<span class="parent">${icon("flag")}${esc(parent)}</span>` : ""}
    <span class="t">${task.src && task.src.kind === "review" ? "レビュー: " : ""}${esc(task.title)}</span>
    <span class="foot">${srcChip(task)}${flags(task)}${task.done ? "" : dueChip(task)}
      <span class="end">${pts(task.pts)}${avatar(task.who)}</span></span>
  </button>`;
}

function renderSprint() {
  const sp = SPRINTS.sp14;
  const list = tasksOf((x) => x.sprint === "sp14");
  const cols = COLUMNS.map((c) => {
    const items = list.filter((x) => x.col === c.id);
    return `<div class="col ${c.done ? "done" : ""}">
      <div class="col-head">${c.done ? icon("check") : ""}<span>${c.done ? t("doneCol") : esc(c.name)}</span><span class="n">${items.length}</span><span class="sum" title="${t("points")}">${sumPts(items)} pt</span></div>
      ${c.done ? `<details class="dod"><summary>${t("dod")}</summary><ul><li>レビューを1人以上が通した</li><li>本番相当の環境で動きを確かめた</li><li>利用者向けの変更なら手順書を直した</li></ul></details>` : ""}
      ${items.map(card).join("")}
    </div>`;
  }).join("");
  const total = sumPts(list), done = sumPts(list.filter((x) => x.done));
  const unfilled = list.filter((x) => !x.filled).length;
  return `
  <div class="sprint-head">
    <h2 style="font-size:var(--fs-lg)">${sprintName("sp14")}</h2>
    <span class="period num">${sp.start} 〜 ${sp.end}</span>
    <span class="chip accent">進行中・残り 6 日</span>
    <span class="chip num">完了 ${done} / ${total} pt</span>
    ${unfilled ? `<span class="chip warn">${icon("pen")}${t("detail")} 未記入 ${unfilled} 件</span>` : ""}
    <span style="margin-left:auto;display:flex;gap:8px">
      <button class="btn" type="button">延長する</button>
      <button class="btn" type="button" disabled title="最終日を過ぎると押せます">終了する</button>
    </span>
  </div>
  <div class="goal">${icon("flag")}<div><b>${t("sprintGoal")}</b><br>${esc(sp.goal)}</div></div>
  <div class="board-wrap"><div class="board">${cols}</div></div>`;
}

function gauge(c) {
  if (c.base == null) return `<div class="gauge" aria-hidden="true"></div>`;
  const max = Math.max(c.base * (1 + TOLERANCE), c.work) * 1.1;
  const lo = (c.base * (1 - TOLERANCE)) / max * 100;
  const hi = (c.base * (1 + TOLERANCE)) / max * 100;
  const st = capStatus(c);
  return `<div class="gauge" role="img" aria-label="基準 ${c.base} 時間に対して作業量 ${c.work} 時間">
    <span class="band" style="left:${lo}%;width:${hi - lo}%"></span>
    <span class="fill ${st.key}" style="width:${(c.work / max) * 100}%"></span></div>`;
}
function capStatus(c) {
  if (c.alloc == null) return { key: "none", html: `<span class="status none">配分未設定</span>` };
  const hi = c.base * (1 + TOLERANCE), lo = c.base * (1 - TOLERANCE);
  if (c.work > hi) return { key: "over", html: `<span class="status over">${icon("alert")}${t("over")}</span>` };
  if (c.work < lo && c.none === 0) return { key: "free", html: `<span class="status free">${icon("check")}余力あり</span>` };
  if (c.work < lo) return { key: "none", html: `<span class="status none">未見積もりあり</span>` };
  return { key: "ok", html: `<span class="status ok">${icon("check")}範囲内</span>` };
}

function renderPlan() {
  const col = (id) => {
    const sp = SPRINTS[id];
    const list = tasksOf((x) => x.sprint === id);
    const unfilled = list.filter((x) => !x.filled).length;
    const none = list.filter((x) => x.pts == null).length;
    return `<div class="panel plan-col ${sp.status === "active" ? "active" : ""}">
      <h3>${sprintName(id)} ${sp.status === "active" ? `<span class="chip accent">進行中</span>` : ""}</h3>
      <div class="sub num"><span>${md(sp.start)}〜${md(sp.end)}</span><span>${sumPts(list)} pt</span>
        ${none ? `<span>未見積もり ${none} 件</span>` : ""}${unfilled ? `<span>${t("detail")} 未記入 ${unfilled} 件</span>` : ""}</div>
      ${list.map((x) => `<div class="plan-item" data-task="${x.id}" role="button" tabindex="0">${pts(x.pts)}<span class="t">${esc(x.title)}</span>${avatar(x.who)}</div>`).join("")}
      <button class="btn small" type="button">${icon("plus")}${t("backlog")}から入れる</button>
    </div>`;
  };
  const capRows = CAPACITY.map((c) => `
    <tr>
      <td><span class="who">${avatar(c.who)}${esc(USERS[c.who].name)}</span></td>
      <td class="n">${c.alloc == null ? "—" : c.alloc + "%"}</td>
      <td class="n">${c.base == null ? "—" : c.base.toFixed(1)}</td>
      <td class="n">${c.work.toFixed(1)}</td>
      <td>${gauge(c)}</td>
      <td>${capStatus(c).html}${c.none ? ` <span class="chip">未見積もり ${c.none} 件</span>` : ""}</td>
      <td class="muted" style="font-size:var(--fs-xs)">${c.off || ""}</td>
    </tr>`).join("");
  const epicRows = Object.entries(EPICS).map(([id, e]) => {
    const p = epicPts(id);
    return `<tr>
      <td><a href="#raid" data-epic="${id}" style="color:inherit">${esc(e.title)}</a></td>
      <td class="n">${p.all - p.done}</td>
      <td><div class="progress" role="img" aria-label="完了 ${p.done} / ${p.all}"><span style="width:${p.all ? (p.done / p.all) * 100 : 0}%"></span></div></td>
      <td>${dueChip({ due: e.due })}</td>
    </tr>`;
  }).join("");
  return `
  <div class="panel" style="padding:14px 16px">
    <div class="velocity">
      <div><div class="muted" style="font-size:var(--fs-xs)">ベロシティ（直近3回、延長した${t("sprint")}を除く）</div><span class="big num">31</span> <span class="muted">pt</span></div>
      <div class="muted" style="font-size:var(--fs-sm)">第11回 34・第12回 30・第13回 29</div>
    </div>
  </div>
  <div class="plan-grid">${col("sp14")}${col("sp15")}${col("sp16")}</div>
  <section class="section">
    <div class="section-head"><h2>${t("capacity")}（${sprintName("sp14")}）</h2><span class="aside">1 ${t("points")} = 4 時間・許容幅 ±12.5%</span></div>
    <div class="panel table-wrap"><table class="cap-table">
      <thead><tr><th>${t("member")}</th><th>配分</th><th>基準（時間）</th><th>作業量（時間）</th><th>基準と許容幅</th><th>判定</th><th>休み</th></tr></thead>
      <tbody>${capRows}</tbody></table></div>
  </section>
  <section class="section">
    <div class="section-head"><h2>${t("epic")}ごとの残り</h2></div>
    <div class="panel table-wrap"><table class="cap-table">
      <thead><tr><th>${t("epic")}</th><th>残り（pt）</th><th>進み</th><th>${t("due")}</th></tr></thead>
      <tbody>${epicRows}</tbody></table></div>
  </section>`;
}

function renderRaid() {
  const id = state.epicId;
  const e = EPICS[id];
  const p = epicPts(id);
  const joined = e.party.includes(ME);
  const stories = Object.keys(STORIES).filter((s) => STORIES[s].epic === id);
  const allDone = p.all > 0 && p.done === p.all;
  const others = Object.keys(EPICS).filter((x) => x !== id);
  return `
  <div class="panel raid-hero">
    <div class="eyebrow">${icon("flag")}${t("epic")}・${CATEGORIES[e.cat].name}</div>
    <h2>${esc(e.title)}</h2>
    <div class="raid-facts">
      <div class="fact"><span class="k">${t("requester")}</span><span class="v">${avatar(e.requester)}${esc(USERS[e.requester].name)}</span></div>
      <div class="fact"><span class="k">クリア報酬</span><span class="v"><span class="reward">${e.tier}・${e.reward} XP</span><span class="muted" style="font-size:var(--fs-xs)">${t("party")}全員に同額</span></span></div>
      <div class="fact"><span class="k">${t("due")}</span><span class="v">${dueChip({ due: e.due })}</span></div>
      <div class="fact"><span class="k">${t("points")}</span><span class="v"><span class="ratio num">${p.done} / ${p.all}</span><span class="progress" style="flex:1"><span style="width:${p.all ? (p.done / p.all) * 100 : 0}%"></span></span></span></div>
    </div>
    <div class="fact"><span class="k">${t("party")}（${e.party.length}人）</span>
      <div class="party">${e.party.map((u) => `<span class="member">${avatar(u)}${esc(USERS[u].name)} ${lv(u)}</span>`).join("")}</div></div>
    <div class="raid-actions">
      <button class="btn ${joined ? "" : "primary"}" type="button" id="join-btn">${joined ? t("leave") : t("accept")}</button>
      <button class="btn" type="button">${t("party")}に割り振る</button>
      <button class="btn" type="button">報酬を変える</button>
      <button class="btn primary" type="button" ${allDone ? "" : "disabled"} title="${allDone ? "" : "配下がすべて完了すると押せます"}">${icon("check")}${t("clear")}</button>
      <span class="muted" style="font-size:var(--fs-xs)">${allDone ? "" : `配下がすべて完了すると押せます`}</span>
    </div>
    <div class="raid-body">${e.body.map((b) => `<p>${esc(b)}</p>`).join("")}
      ${e.link ? `<p class="src">${icon("link")}<span class="mono">${esc(e.link)}</span></p>` : ""}</div>
  </div>
  <section class="section">
    <div class="section-head"><h2>${t("story")}</h2><span class="aside">${stories.length} 件</span></div>
    ${stories.map((s) => {
      const st = STORIES[s];
      const sp = storyPts(s);
      const list = tasksOf((x) => x.story === s);
      return `<div class="panel story-card">
        <h3><span class="kind story">${icon("check")}</span>${esc(st.title)}<span class="ratio num" style="margin-left:auto">${sp.done} / ${sp.all}</span></h3>
        <div class="ac"><b>${t("ac")}</b><ul>${st.ac.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>
        <div class="rows">${list.map((x) => taskRow(x)).join("")}</div>
      </div>`;
    }).join("")}
  </section>
  <p class="muted" style="font-size:var(--fs-sm);margin:0">他の${t("epic")}: ${others.map((o) => `<a href="#raid" data-epic="${o}" style="color:var(--accent)">${esc(EPICS[o].title)}</a>`).join("、")}</p>`;
}

function renderLater() {
  const v = VIEWS[state.view];
  return `<div class="panel later-box">${icon(v.icon)}<b>${v.title()}</b><span>この画面は2周目で作ります。</span></div>`;
}

// ---- タスクの詳細 ----
function renderDrawer() {
  const id = state.taskId;
  const x = { id, ...TASKS[id] };
  const parent = x.story ? STORIES[x.story] : null;
  const epic = parent && parent.epic ? EPICS[parent.epic] : null;
  const d = dueOf(x);
  const comments = COMMENTS[id] || [];
  const history = HISTORY[id] || [];
  const thanked = state.thanks || [];
  const fieldBox = x.filled
    ? `<div class="field-box"><ul>${(parent ? parent.ac.slice(0, 2) : ["結果を確かめる手順が書かれている"]).map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`
    : `<div class="field-box empty">まだ書かれていません。書くと${t("sprint")}の終了で経験値が付きます。</div>`;
  return `
  <div class="drawer-top">
    <span class="chip">${icon(x.src ? (x.src.kind === "backlog" ? "link" : "git") : "pen")}${x.src ? SRC_LABEL[x.src.kind] : "手で作った" + t("task")}</span>
    ${x.src ? `<span class="mono" style="font-size:var(--fs-sm)">${esc(x.src.key)}</span><span class="chip">取り込み元: ${esc(x.src.status)}</span>` : ""}
    <button class="tool icon-only close" type="button" id="close-drawer" aria-label="閉じる">${icon("x")}</button>
  </div>
  <h2>${x.src && x.src.kind === "review" ? "レビュー: " : ""}${esc(x.title)}</h2>
  ${x.src && x.src.sourceDone ? `<div class="flag">${icon("check")}<span>取り込み元で完了になりました。完了にするかはここで決めます。</span><button class="btn small" type="button">完了にする</button></div>` : ""}
  <dl class="props">
    <dt>${t("column")}</dt><dd>${x.col && x.col !== "x" ? esc(colName(x.col)) : "—"}</dd>
    <dt>${t("assignee")}</dt><dd>${avatar(x.who)}${x.who ? esc(USERS[x.who].name) : "担当なし"}</dd>
    <dt>${t("points")}</dt><dd>${pts(x.pts)}${x.pts == null ? `<span class="muted">未見積もり</span>` : ""}</dd>
    <dt>${t("due")}</dt><dd>${d ? `${dueChip(x)}<span class="muted" style="font-size:var(--fs-xs)">${d.from === "src" ? "取り込み元の期限" : "Scrum Guild で振った" + t("due")}</span>` : "—"}</dd>
    <dt>親</dt><dd>${parent ? `${icon("flag")}${esc(parent.title)}${epic ? `<span class="muted">（${esc(epic.title)}）</span>` : ""}` : "なし"}</dd>
    <dt>${t("sprint")}</dt><dd>${x.sprint && SPRINTS[x.sprint] ? esc(sprintName(x.sprint)) : x.sprint === "x" ? "社内ツールの進行中の" + t("sprint") : `${t("backlog")}`}</dd>
    <dt>${t("category")}</dt><dd>${catName(x) ? esc(catName(x)) + (parent ? `<span class="muted" style="font-size:var(--fs-xs)">親から引き継ぎ</span>` : "") : `${t("category")}なし`}</dd>
    <dt>今日やる</dt><dd><button class="todaybtn" type="button" data-today="${id}" aria-pressed="${x.today === TODAY}">${icon("sun")}</button>${x.today === TODAY ? "今日やる" : "—"}</dd>
  </dl>
  <div class="field">
    <span class="field-label">${icon("pen")}${t("detail")}・${t("ac")}${x.filled ? "" : `<span class="chip warn">未記入</span>`}</span>
    ${fieldBox}
  </div>
  <div class="field">
    <span class="field-label">本文</span>
    <div class="field-box">${x.src ? `<p class="muted">取り込み元の本文は <span class="mono">${esc(x.src.key)}</span> で開いて読みます。ここには Scrum Guild のメモを書けます。</p>` : `<p>確定とキャンセルのイベントを夜間にまとめて処理する。付与率は会員ランクごとの設定値を使う。</p><p>参考: 管理画面の設計メモ https://example.com/notes/42</p>`}</div>
  </div>
  <div class="done-bar">
    <button class="btn primary" type="button">${icon("check")}完了にする</button>
    <span class="dodlink">${t("dod")}: レビューを通した・本番相当で確かめた・手順書を直した</span>
  </div>
  <div class="field">
    <span class="field-label">${icon("heart")}感謝</span>
    <div class="thanks">
      ${["u2", "u3", "u4"].map((u) => `<button class="btn small ${thanked.includes(u) ? "given" : ""}" type="button" data-thank="${u}" aria-pressed="${thanked.includes(u)}">${avatar(u)}${esc(USERS[u].name)}${thanked.includes(u) ? " に送った" : " に送る"}</button>`).join("")}
      <span class="muted" style="font-size:var(--fs-xs)">送れるのは${t("assignee")}だけ。${t("task")}が完了すると相手に経験値が付きます。</span>
    </div>
  </div>
  <div>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="comments" aria-selected="${state.drawerTab === "comments"}">コメント ${comments.filter((c) => !c.deleted).length}</button>
      <button type="button" role="tab" data-tab="history" aria-selected="${state.drawerTab === "history"}">変更の履歴</button>
    </div>
    ${state.drawerTab === "comments" ? `
    <div class="comments" style="padding-top:12px">
      ${comments.length ? comments.map((c) => `<div class="comment ${c.deleted ? "deleted" : ""}">${avatar(c.who)}<div>
        <div class="head"><b>${esc(USERS[c.who].name)}</b><span class="num">${c.at}</span>${c.edited ? "<span>編集済み</span>" : ""}</div>
        <div class="body">${c.deleted ? "削除されました" : esc(c.body)}</div></div></div>`).join("") : `<div class="muted" style="font-size:var(--fs-sm)">まだコメントはありません。</div>`}
      <div class="compose"><label for="new-comment" class="field-label">コメントを書く</label><textarea id="new-comment" placeholder="Markdown で書けます"></textarea><div><button class="btn" type="button">送る</button></div></div>
    </div>` : `
    <div class="history" style="padding-top:12px">
      ${history.length ? `<ul>${history.map((h) => `<li><time>${h[0]}</time>${avatar(h[1])}<span>${esc(USERS[h[1]].name)}</span><span class="muted">${esc(h[2])}</span><span>${esc(h[3])}</span></li>`).join("")}</ul>` : `<div class="muted">まだ変更はありません。</div>`}
    </div>`}
  </div>`;
}

// ---- 描画と操作 ----
function render() {
  const v = VIEWS[state.view] || VIEWS.today;
  document.getElementById("page-title").textContent = v.title();
  document.title = `${v.title()} · Scrum Guild モック`;
  document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = t(el.dataset.t)));
  document.getElementById("me-chip").innerHTML = `${avatar(ME)}${esc(USERS[ME].name)} ${lv(ME)}`;
  renderNav();
  document.getElementById("main").innerHTML = v.later ? renderLater() : v.render();
  const drawer = document.getElementById("drawer");
  const scrim = document.getElementById("scrim");
  if (state.taskId) {
    drawer.innerHTML = renderDrawer();
    drawer.hidden = false;
    scrim.hidden = false;
  } else {
    drawer.hidden = true;
    scrim.hidden = true;
  }
}

function go(view) {
  state.view = VIEWS[view] ? view : "today";
  state.taskId = null;
  render();
  document.getElementById("main").focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function openTask(id) {
  state.taskId = id;
  state.drawerTab = "comments";
  state.thanks = [];
  render();
  document.getElementById("close-drawer").focus();
}
function closeTask() {
  const id = state.taskId;
  state.taskId = null;
  render();
  const back = document.querySelector(`[data-task="${id}"]`);
  if (back) back.focus();
}

document.addEventListener("click", (ev) => {
  const el = ev.target;
  const today = el.closest("[data-today]");
  if (today) {
    ev.stopPropagation();
    const x = TASKS[today.dataset.today];
    x.today = x.today === TODAY ? null : TODAY;
    render();
    return;
  }
  const thank = el.closest("[data-thank]");
  if (thank) {
    const u = thank.dataset.thank;
    state.thanks = state.thanks.includes(u) ? state.thanks.filter((x) => x !== u) : [...state.thanks, u];
    render();
    return;
  }
  const tab = el.closest("[data-tab]");
  if (tab) { state.drawerTab = tab.dataset.tab; render(); return; }
  const epicLink = el.closest("[data-epic]");
  if (epicLink) { ev.preventDefault(); state.epicId = epicLink.dataset.epic; location.hash = "raid"; go("raid"); return; }
  const nav = el.closest("[data-view]");
  if (nav) { ev.preventDefault(); location.hash = nav.dataset.view; go(nav.dataset.view); return; }
  if (el.closest("#join-btn")) {
    const e = EPICS[state.epicId];
    e.party = e.party.includes(ME) ? e.party.filter((u) => u !== ME) : [...e.party, ME];
    render();
    return;
  }
  if (el.closest("#close-drawer") || el.id === "scrim") { closeTask(); return; }
  const task = el.closest("[data-task]");
  if (task && !el.closest(".drawer")) { openTask(task.dataset.task); return; }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.taskId) { closeTask(); return; }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches(".row[data-task], .plan-item[data-task]")) {
    ev.preventDefault();
    openTask(ev.target.dataset.task);
  }
});
// 配色: OS に合わせる → ライト → ダーク の順に切り替える
const THEMES = [null, "light", "dark"];
const THEME_LABEL = { null: "OS に合わせる", light: "ライト", dark: "ダーク" };
let theme = null;
try { theme = localStorage.getItem("sq-mock-theme"); } catch (e) { /* 使えなくても動かす */ }
if (!THEMES.includes(theme)) theme = null;
function applyTheme() {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.getElementById("theme-label").textContent = `配色: ${THEME_LABEL[theme]}`;
}
document.getElementById("theme-btn").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { theme ? localStorage.setItem("sq-mock-theme", theme) : localStorage.removeItem("sq-mock-theme"); } catch (e) { /* 同上 */ }
  applyTheme();
});

applyTheme();
const initial = location.hash.slice(1);
state.view = VIEWS[initial] ? initial : "today";
render();
window.addEventListener("hashchange", () => {
  const h = location.hash.slice(1);
  if (VIEWS[h] && h !== state.view) go(h);
});
