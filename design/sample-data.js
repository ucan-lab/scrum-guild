// 見本の画面が共有する例のデータ。すべて架空。
// 今日は 2026-10-20（火）。週の始まりは月曜。自分は「ミナト」。
window.SQ_DATA = (function () {
  "use strict";
  const today = "2026-10-20";
  return {
    today,
    weekStart: "2026-10-19",
    weekEnd: "2026-10-25",
    todayLabel: "2026年10月20日（火）",
    me: "u1",
    workspace: "wa",
    organization: "aoba",
    // AI の機能。組織の管理で管理者が有効にし、送る先を選ぶ。利用量は百万トークンで数え、上限は運用者が決める
    ai: { enabled: true, provider: "claude", used: 1.3, limit: 5, resets: "11/1" },

    // 自分が入れる組織。組織ごとに名前、レベル、経験値が別になる
    organizations: [
      { slug: "aoba", name: "あおば開発", wss: 2, level: 7, admin: true, lastSeen: "10/20" },
      { slug: "hibari", name: "ひばり工房", wss: 1, level: 3, lastSeen: "10/14" },
    ],

    users: {
      u1: { name: "ミナト", hue: 172, level: 7, role: "leader" },
      u2: { name: "ハルカ", hue: 28, level: 9, role: "member" },
      u3: { name: "ソウタ", hue: 220, level: 5, role: "member" },
      u4: { name: "リン", hue: 320, level: 6, role: "member" },
      u5: { name: "カイ", hue: 90, level: 4, role: "member", left: true },
    },
    workspaces: {
      wa: { name: "受託開発チーム" },
      wb: { name: "社内ツール" },
    },
    columns: [
      { id: "c1", name: "出発前" },
      { id: "c2", name: "遂行中" },
      { id: "c3", name: "査定中" },
      { id: "done", done: true },
    ],
    categories: {
      k1: { name: "追加案件", monthly: true },
      k2: { name: "保守" },
    },
    // タスクに振るリポジトリ。source は結んだ取り込み元の入る先。結ばずに名前だけでも作れる
    repositories: {
      r1: { name: "shop", source: "acme/shop" },
      r2: { name: "shop-admin" },
    },
    definitionOfDone: ["レビューを1人以上が通した", "本番相当の環境で動きを確かめた", "利用者向けの変更なら手順書を直した"],

    sprints: {
      sp10: { ws: "wa", name: "第10回", start: "2026-08-18", end: "2026-08-31", status: "closed", donePts: 32 },
      sp11: { ws: "wa", name: "第11回", start: "2026-09-01", end: "2026-09-14", status: "closed", donePts: 34 },
      sp12: { ws: "wa", name: "第12回", start: "2026-09-15", end: "2026-09-28", status: "closed", donePts: 41, extended: 2 },
      sp13: { ws: "wa", name: "第13回", start: "2026-09-29", end: "2026-10-12", status: "closed", donePts: 29 },
      sp14: { ws: "wa", name: "第14回", start: "2026-10-13", end: "2026-10-26", status: "active", days: 14, dayIndex: 7,
              goal: "会員ポイントの付与を管理画面で確かめられる所まで進め、決済の障害の検知を入れる" },
      sp15: { ws: "wa", name: null, start: "2026-10-27", end: "2026-11-09", status: "planned" },
      sp16: { ws: "wa", name: null, start: "2026-11-10", end: "2026-11-23", status: "planned" },
      spb: { ws: "wb", name: null, start: "2026-10-14", end: "2026-10-27", status: "active", days: 14, dayIndex: 6,
             goal: "勤怠の月次の締めを手作業なしで回す" },
    },

    epics: {
      e1: {
        title: "会員ポイント制度を公開する", cat: "k1", due: "2026-11-20", tier: "large",
        requester: "u2", creator: "u2", party: ["u2", "u1", "u3"],
        body: [
          "購入額に応じてポイントを付け、次の購入で使えるようにする。年内の公開が先方との約束。",
          "失効は付与から1年。管理画面で付与と失効の履歴を追えることを先方が重視している。",
        ],
        link: "https://example.com/spec/points",
      },
      e2: {
        title: "決済まわりの障害を減らす", cat: "k2", due: "2026-10-24", tier: "medium",
        requester: "u1", creator: "u1", party: ["u1", "u4"],
        body: ["9月に2回あった決済の取りこぼしを受けて、検知と連絡の流れを整える。"],
      },
    },
    stories: {
      s1: { epic: "e1", title: "ポイントの付与と失効を管理画面で確かめられる",
            body: ["先方の運用担当が、問い合わせを受けたときに会員ごとの付与と失効を自分で追えるようにする。"],
            ac: ["購入の確定でポイントが付く", "失効日を過ぎたポイントが残高から消える", "管理画面で会員ごとの履歴が見られる"] },
      s2: { epic: "e1", title: "購入時にポイントを使える",
            ac: ["残高の範囲で1ポイント単位で使える", "使ったポイントが注文の明細に出る"] },
      s3: { epic: "e2", title: "決済の失敗をすぐ検知できる",
            ac: ["Webhook の再送が3回失敗したら通知が届く", "障害時の連絡先と手順が1か所にまとまっている"] },
      s4: { epic: null, cat: "k2", due: "2026-10-23", title: "問い合わせの一次回答を早くする",
            ac: ["よくある問い合わせ10件にテンプレートがある"] },
    },

    // src.kind: backlog（Backlog の課題）、issue、pr、review（レビュー依頼）
    tasks: [
      { id: "t1", ws: "wa", repo: "r1", title: "ポイント付与のバッチを作る", story: "s1", sprint: "sp14", col: "c2", who: "u1", pts: 5, todayOn: today, creator: "u1", link: "https://example.com/notes/42",
        body: ["確定とキャンセルのイベントを夜間にまとめて処理する。付与率は会員ランクごとの設定値を使う。", "![付与率の設定画面](f1)", "参考: 管理画面の設計メモ https://example.com/notes/42"] },
      { id: "t2", ws: "wa", repo: "r1", title: "失効日の計算に月末の扱いを足す", story: "s1", sprint: "sp14", col: "c3", who: "u3", pts: 3,
        src: { kind: "pr", key: "acme/shop#412", status: "open" } },
      { id: "t3", ws: "wa", repo: "r2", title: "管理画面にポイント履歴の一覧を出す", story: "s1", sprint: "sp14", col: "c1", who: "u2", pts: 5, unfilled: true, creator: "u2" },
      { id: "t4", ws: "wa", repo: "r1", title: "購入画面でポイント残高を出す", story: "s2", sprint: "sp15", who: "u3", pts: 3, creator: "u3" },
      { id: "t5", ws: "wa", repo: "r1", title: "ポイント利用の API を設計する", story: "s2", sprint: "sp15", who: "u1", pts: 8, unfilled: true, creator: "u1" },
      { id: "t6", ws: "wa", repo: "r1", title: "決済 Webhook の再送を監視する", story: "s3", sprint: "sp14", col: "c2", who: "u4", pts: 3,
        src: { kind: "backlog", key: "SHOP-128", status: "処理中", due: today } },
      { id: "t7", ws: "wa", repo: "r1", title: "タイムアウトの閾値を見直す", story: "s3", sprint: "sp14", col: "done", who: "u4", pts: 2, doneAt: "10/16 15:20", creator: "u4" },
      { id: "t8", ws: "wa", title: "障害時の連絡手順を書く", story: "s3", sprint: "sp14", col: "c1", who: "u1", pts: 1, due: "2026-10-17", todayOn: "2026-10-19", creator: "u1" },
      { id: "t9", ws: "wa", title: "問い合わせテンプレートを整える", story: "s4", who: null, pts: null, unfilled: true, creator: "u4" },
      { id: "t10", ws: "wa", repo: "r1", title: "依存パッケージを更新する", cat: "k2", sprint: "sp14", col: "done", who: "u3", pts: 2, doneAt: "10/15 11:02",
        src: { kind: "issue", key: "acme/shop#398", status: "closed" } },
      { id: "t11", ws: "wa", repo: "r1", title: "クーポンの併用制限", cat: "k1", sprint: "sp14", col: "c1", who: "u1", pts: 1, todayOn: today,
        src: { kind: "review", key: "acme/shop#418", status: "レビュー待ち" } },
      { id: "t12", ws: "wa", repo: "r2", title: "請求書 PDF の文字化けを直す", cat: "k2", sprint: "sp14", col: "c3", who: "u1", pts: 2,
        src: { kind: "backlog", key: "SHOP-131", status: "完了" }, srcDone: true },
      { id: "t13", ws: "wa", repo: "r2", title: "ポイント失効の通知メールを作る", story: "s1", sprint: "sp15", who: null, pts: null, unfilled: true, creator: "u2" },
      { id: "t14", ws: "wa", repo: "r1", title: "決済通知のメール文面を直す", story: "s3", sprint: "sp14", col: "done", who: "u1", pts: 1, doneAt: "10/20 09:40",
        src: { kind: "backlog", key: "SHOP-126", status: "完了" } },
      { id: "t15", ws: "wb", title: "勤怠の CSV 出力で締め日を選べるようにする", sprint: "spb", colName: "遂行中", who: "u1", pts: 3, due: "2026-10-22", creator: "u1" },
      { id: "t16", ws: "wb", title: "有給の残日数を一覧に出す", sprint: "spb", colName: "出発前", who: "u1", pts: null, unfilled: true, creator: "u1" },
    ],

    comments: {
      t1: [
        { who: "u2", at: "10/15 10:12", body: "付与のタイミングは購入の確定時でお願いします。キャンセルされた注文は対象外です。" },
        { who: "u1", at: "10/15 11:40", body: "了解です。確定とキャンセルの両方のイベントを拾うようにします。", edited: true },
        { who: "u3", at: "10/16 09:05", deleted: true },
        { who: "u3", at: "10/16 09:06", body: "バッチの実行時刻は、深夜の集計と重ならない 3:30 がよさそうです。" },
      ],
    },
    // 添付ファイル。付く先（タスク、ストーリー、エピック、コメント）ごと。中身は見本にないので、画像と動画は絵の代わりの模様で出す
    files: {
      t1: [
        { id: "f1", name: "付与率の設定画面.png", type: "image", size: "412 KB", who: "u2", at: "10/15 10:10" },
        { id: "f2", name: "バッチの処理の流れ.pdf", type: "file", size: "1.2 MB", who: "u1", at: "10/15 11:38" },
        { id: "f3", name: "キャンセル時の再現手順.mp4", type: "video", size: "18.4 MB", who: "u3", at: "10/16 09:02", length: "0:42" },
      ],
      "comment:t1:3": [
        { id: "f4", name: "集計の実行時刻.png", type: "image", size: "236 KB", who: "u3", at: "10/16 09:06" },
      ],
      e1: [
        { id: "f5", name: "会員ランクと付与率の表.xlsx", type: "file", size: "48 KB", who: "u2", at: "10/02 14:20" },
        { id: "f6", name: "先方の要望メモ（10月2日）.pdf", type: "file", size: "2.4 MB", who: "u2", at: "10/02 14:21" },
      ],
      s1: [
        { id: "f7", name: "ポイント残高の画面案.png", type: "image", size: "688 KB", who: "u4", at: "10/08 17:02" },
      ],
    },
    // 組織の添付ファイルの合計（GB）。上限の 80% を超えると管理者に知らせる
    storage: { used: 25.1, quota: 30, byWorkspace: [["wa", 612, 18.4], ["wb", 205, 6.7]] },
    // 組織の人数と上限。人数は管理者と、いずれかのワークスペースに所属しているか招待されている人
    seats: { used: 5, limit: 15 },
    history: {
      // [日時（ワークスペースのタイムゾーン）, 変えた人, 操作, [[列, 値の文], ...]]
      t1: [
        ["2026-10-19 18:02", "u1", "update", [["due", "なし → 2026-10-24"]]],
        ["2026-10-14 09:30", "u2", "update", [["points", "3 → 5"], ["assignee", "ソウタ → ミナト"]]],
        ["2026-10-12 16:44", "u1", "create", [["title", "ポイント付与のバッチを作る"], ["points", "3"], ["assignee", "ソウタ"]]],
      ],
    },

    level: { level: 7, xp: 2550, toNext: 250, soon: 140, gotPct: 64, soonPct: 20, rows: [["受託開発チーム", 1780], ["社内ツール", 770]], total: 2550 },

    // 第14回の積載量。基準と作業量は時間
    capacity: [
      { who: "u1", alloc: 60, base: 45.6, work: 56.0, off: "10/23 半日" },
      { who: "u2", alloc: 100, base: 80.0, work: 76.0 },
      { who: "u3", alloc: 50, base: 40.0, work: 24.0, none: 1 },
      { who: "u4", alloc: null, work: 20.0 },
    ],
    hoursPerPoint: 4,
  };
})();

// ---- 残りの画面の例のデータ ----
Object.assign(window.SQ_DATA, {
  // 受信箱とアーカイブ（取り込んだが、まだバックログに入れていないもの）
  inbox: [
    { id: "i1", ws: "wa", title: "管理者のパスワード再設定メールが届かない", who: "u1", pts: null,
      src: { kind: "backlog", key: "SHOP-133", status: "未対応", due: "2026-10-23" }, conn: "c1", arrivedAt: "10/20 08:15" },
    { id: "i2", ws: "wa", repo: "r1", title: "Node 22 に上げる", who: "u1", pts: null,
      src: { kind: "issue", key: "acme/shop#420", status: "open" }, conn: "c2", arrivedAt: "10/20 08:15" },
    { id: "i3", ws: "wa", repo: "r1", title: "商品画像の遅延読み込み", who: "u1", pts: null, review: true,
      src: { kind: "review", key: "acme/shop#421", status: "レビュー待ち" }, conn: "c2", arrivedAt: "10/19 17:30" },
    { id: "i4", ws: "wa", title: "請求先住所の郵便番号が7桁で切れる", who: "u4", pts: null,
      src: { kind: "backlog", key: "SHOP-129", status: "完了" }, srcDone: true, conn: "c3", arrivedAt: "10/18 09:00" },
  ],
  archive: [
    { id: "a1", ws: "wa", title: "社内勉強会の資料置き場を作る", who: "u1", pts: null, src: { kind: "issue", key: "acme/handbook#33", status: "open" }, archivedAt: "10/14", archivedBy: "u2" },
    { id: "a2", ws: "wa", title: "デザインの古いトークンを消す", who: "u3", pts: 2, src: { kind: "pr", key: "acme/web#88", status: "closed" }, archivedAt: "10/02", archivedBy: "u3", missing: "10/18" },
  ],

  connections: [
    { id: "c1", owner: "u1", provider: "backlog", name: "ミナトの Backlog", host: "acme.backlog.jp", status: "active",
      lastSuccess: "10/20 10:00", scope: { mode: "include", items: ["SHOP（ECサイト）"] }, last4: "q9Zt", mappings: [["未対応", "出発前"], ["処理中", "遂行中"], ["処理済み", "査定中"]] },
    { id: "c2", owner: "u1", provider: "github", name: "ミナトの GitHub", host: "github.com", status: "error",
      lastSuccess: "10/20 08:15", error: "GitHub の応答が遅れています（503）。次の同期で再試行します。", errorAt: "10/20 10:00", failures: 2,
      scope: { mode: "include", items: ["acme/shop", "acme/web"] }, last4: "Xk2c", mappings: [["open", "出発前"]] },
    { id: "c3", owner: "u4", provider: "backlog", name: "リンの Backlog", host: "acme.backlog.jp", status: "stopped",
      stoppedReason: "認証に失敗したので止めました。本人が API キーを登録し直すと再開します。", lastSuccess: "10/17 18:00",
      scope: { mode: "exclude", items: ["SANDBOX"] }, last4: "7hQe", mappings: [] },
  ],

  members: [
    { who: "u1", role: "leader", joined: "2025-04-01", alloc: 60 },
    { who: "u2", role: "leader", joined: "2025-04-01", alloc: 100 },
    { who: "u3", role: "member", joined: "2025-09-16", alloc: 50 },
    { who: "u4", role: "member", joined: "2026-02-02", alloc: null },
    { who: "u5", role: "member", joined: "2025-04-01", left: "2026-08-31", alloc: null },
  ],
  invitations: [
    { login: "kotone-dev", via: "github", role: "member", by: "u1", at: "10/18" },
    { login: "mio.hoshino@example.com", via: "google", role: "member", by: "u1", at: "10/20", expires: "11/03" },
  ],

  detailFields: ["達成条件", "確かめ方"],
  pointRates: [["2026-04", 4], ["2025-04", 3]],
  workspaceHolidays: [["2026-12-29", "年末休業"], ["2026-12-30", "年末休業"], ["2026-12-31", "年末休業"]],
  settings: { timezone: "Asia/Tokyo", weekStart: 1, vocab: 0 },

  // 完了の記録（10月）
  completions: [
    { at: "10/20 09:40", task: "決済通知のメール文面を直す", by: "u1", who: "u1", pts: 1, sprint: "第14回", cat: "保守", month: null },
    { at: "10/16 15:20", task: "タイムアウトの閾値を見直す", by: "u4", who: "u4", pts: 2, sprint: "第14回", cat: "保守", month: null },
    { at: "10/15 11:02", task: "依存パッケージを更新する", by: "u3", who: "u3", pts: 2, sprint: "第14回", cat: "保守", month: null },
    { at: "10/10 17:45", task: "ポイントの付与率を設定できるようにする", by: "u2", who: "u2", pts: 5, sprint: "第13回", cat: "追加案件", month: "2026-10" },
    { at: "10/09 12:10", task: "会員ランクの判定を夜間に回す", by: "u1", who: "u1", pts: 8, sprint: "第13回", cat: "追加案件", month: "2026-10" },
    { at: "10/07 10:30", task: "ランク表示の文言を直す", by: "u3", who: "u3", pts: 1, sprint: "第13回", cat: "追加案件", month: "2026-10", edited: true },
    { at: "10/02 16:00", task: "問い合わせフォームの迷惑投稿を減らす", by: "u4", who: "u4", pts: 3, sprint: null, cat: null, month: null },
  ],

  // 変更の履歴（リーダーと管理者だけが見る分）
  audit: [
    ["10/20 09:12", "u1", "配分", "ソウタ・11月", "なし → 50%"],
    ["10/18 14:03", "u1", "招待", "kotone-dev", "一般で招待"],
    ["10/17 18:00", null, "接続", "リンの Backlog", "認証の失敗で停止"],
    ["10/12 11:40", "u2", "完了の記録", "ランク表示の文言を直す", "ポイント 2 → 1"],
    ["09/01 09:00", "u2", "ロール", "ミナト", "一般 → リーダー"],
    ["08/31 18:20", "u2", "離脱", "カイ", "メンバーから外す"],
  ],

  // 月の積載量（メンバー × 月）。[基準, 作業量, 未見積もり件数]、null は計画なし
  monthly: {
    months: ["2026-09", "2026-10", "2026-11", "2026-12"],
    rows: [
      { who: "u1", cells: [[96.0, 92.0, 0], [103.2, 118.0, 0], [96.0, 64.0, 1], null] },
      { who: "u2", cells: [[160.0, 150.0, 0], [172.0, 168.0, 0], [160.0, 120.0, 0], null] },
      { who: "u3", cells: [[80.0, 70.0, 0], [86.0, 60.0, 1], [80.0, 44.0, 2], null] },
      { who: "u4", cells: ["unset", "unset", "unset", null] },
    ],
  },

  notifications: [
    { kind: "storage", at: "10/20 11:30", read: false, href: "admin.html", text: "添付ファイルの合計が上限の 80% を超えました（25.1 GB / 30 GB）。上限に達すると新しく添付できなくなります" },
    { kind: "srcDone", at: "10/20 10:00", read: false, text: "SHOP-131「請求書 PDF の文字化けを直す」が取り込み元で完了になりました", task: "t12" },
    { kind: "comment", at: "10/16 09:06", read: false, who: "u3", text: "ソウタさんが「ポイント付与のバッチを作る」にコメントしました", task: "t1" },
    { kind: "party", at: "10/15 13:20", read: false, who: "u2", text: "ハルカさんがあなたをレイド「会員ポイント制度を公開する」の討伐隊に割り振りました" },
    { kind: "error", at: "10/20 10:00", read: true, text: "接続「ミナトの GitHub」の取り込みに失敗しています（503）。次の同期で再試行します" },
    { kind: "thanks", at: "10/14 18:30", read: true, who: "u4", text: "リンさんから「障害時の連絡手順を書く」で感謝が届きました" },
    { kind: "reward", at: "10/10 10:00", read: true, who: "u2", text: "レイド「会員ポイント制度を公開する」のクリア報酬が 中 から 大 に変わりました" },
  ],
  receivedInvites: [
    { organization: "ひばり工房", ws: "デザイン相談室", by: "ユイ", role: "member", at: "10/19" },
  ],

  // 自分の設定（自分は me のユーザー）
  mine: {
    capacityHistory: [["2026-10", 8, 12.5, "月・火・水・木・金"], ["2026-04", 6, 12.5, "月・火・水・木"]],
    weekdays: [1, 2, 3, 4, 5],
    workStart: "2025-04-01", workEnd: null,
    timeOff: [["2026-10-23", "半日"], ["2026-11-02", "終日"], ["2026-11-24", "終日"]],
    overrides: [["2026-12", 120]],
    allocTotals: [["2026-10", 100], ["2026-11", 110]],
    xp: [
      ["10/20 09:40", "完了", "決済通知のメール文面を直す", 20],
      ["10/20 09:40", "起票", "決済通知のメール文面を直す", 10],
      ["10/09 12:10", "詳細", "会員ランクの判定を夜間に回す", 15],
      ["10/09 12:10", "完了", "会員ランクの判定を夜間に回す", 20],
      ["10/06 16:00", "手助け", "ハルカさんへの感謝", 15],
      ["10/03 11:00", "打ち消し", "完了を戻した: ログ出力の整理", -20],
    ],
  },

  admin: {
    users: [
      { who: "u1", admin: true, wss: 2, lastLogin: "10/20" },
      { who: "u2", admin: true, wss: 1, lastLogin: "10/20" },
      { who: "u3", admin: false, wss: 1, lastLogin: "10/19" },
      { who: "u4", admin: false, wss: 2, lastLogin: "10/17" },
      { who: "u5", admin: false, wss: 0, lastLogin: "08/31", disabled: true },
    ],
    workspaces: [
      { name: "受託開発チーム", members: 4, leaders: 2, created: "2025-04-01" },
      { name: "社内ツール", members: 2, leaders: 1, created: "2025-10-01" },
      { name: "旧サイト保守", members: 0, leaders: 0, created: "2024-04-01", closed: "2026-03-31" },
    ],
    holidays: [["2026-11-03", "文化の日"], ["2026-11-23", "勤労感謝の日"], ["2027-01-01", "元日"], ["2027-01-11", "成人の日"]],
    allocTotals: [["ミナト", 100, 100], ["リン", 0, 110], ["ハルカ", 100, 100]],
    // 全ワークスペースの積載量の合計。[基準, 作業量, 未見積もり件数]
    loadTotals: [["u1", [172.0, 168.0, 0], [160.0, 118.0, 1]], ["u2", [172.0, 168.0, 0], [160.0, 120.0, 0]], ["u4", [86.0, 104.0, 0], [96.0, 70.0, 0]]],
    // 組織の変更の履歴。[日時, した人（null は運用者）, 内容]。新しい順
    audit: [
      ["2026/10/18 14:02", "u1", "ハルカを管理者に指名しました"],
      ["2026/09/01 10:15", "u2", "カイを無効にしました"],
      ["2026/06/01 09:00", null, "ミナトを管理者に指名しました"],
      ["2026/06/01 09:00", null, "組織「あおば開発」を作りました"],
    ],
  },

  // 運用者の画面。組織の中のデータは持たず、数、上限、日時だけ。添付ファイルは上限だけを持つ（使った量の合計は #68 で足す）。
  // 日時は本番（format-datetime.ts）と同じ形で、日付と時刻の間は不可分の空白（ ）
  operator: {
    name: "運用担当",
    organizations: [
      { slug: "aoba", name: "あおば開発", users: 5, limit: 15, wss: 3, tasks: 1284, quota: 30, lastUsed: "2026/10/20 09:12", created: "2026/06/01 09:00", admins: 2 },
      { slug: "hibari", name: "ひばり工房", users: 15, limit: 15, wss: 1, tasks: 212, quota: 30, lastUsed: "2026/10/19 18:40", created: "2026/09/15 10:20", admins: 1, adminPending: true },
      { slug: "tsubame", name: "つばめ商会", users: 1, limit: 15, wss: 0, tasks: 0, quota: 30, lastUsed: null, created: "2026/10/05 14:05", admins: 1, adminExpired: true },
      { slug: "kumo-lab", name: "くもラボ", users: 38, limit: 50, wss: 4, tasks: 3410, quota: 100, lastUsed: "2026/10/18 11:03", created: "2026/07/10 09:45", admins: 0 },
      { slug: "nagi", name: "なぎ設計", users: 2, limit: 15, wss: 1, tasks: 96, quota: 30, lastUsed: "2026/09/02 15:21", created: "2026/08/01 16:30", admins: 1, suspended: "2026-09-30", purgeOn: "2026-10-30" },
    ],
  },
});
