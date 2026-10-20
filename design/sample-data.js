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
            ac: ["購入の確定でポイントが付く", "失効日を過ぎたポイントが残高から消える", "管理画面で会員ごとの履歴が見られる"] },
      s2: { epic: "e1", title: "購入時にポイントを使える",
            ac: ["残高の範囲で1ポイント単位で使える", "使ったポイントが注文の明細に出る"] },
      s3: { epic: "e2", title: "決済の失敗をすぐ検知できる",
            ac: ["Webhook の再送が3回失敗したら通知が届く", "障害時の連絡先と手順が1か所にまとまっている"] },
      s4: { epic: null, cat: "k2", title: "問い合わせの一次回答を早くする",
            ac: ["よくある問い合わせ10件にテンプレートがある"] },
    },

    // src.kind: backlog（Backlog の課題）、issue、pr、review（レビュー依頼）
    tasks: [
      { id: "t1", ws: "wa", title: "ポイント付与のバッチを作る", story: "s1", sprint: "sp14", col: "c2", who: "u1", pts: 5, todayOn: today, creator: "u1",
        body: ["確定とキャンセルのイベントを夜間にまとめて処理する。付与率は会員ランクごとの設定値を使う。", "参考: 管理画面の設計メモ https://example.com/notes/42"] },
      { id: "t2", ws: "wa", title: "失効日の計算に月末の扱いを足す", story: "s1", sprint: "sp14", col: "c3", who: "u3", pts: 3,
        src: { kind: "pr", key: "acme/shop#412", status: "open" } },
      { id: "t3", ws: "wa", title: "管理画面にポイント履歴の一覧を出す", story: "s1", sprint: "sp14", col: "c1", who: "u2", pts: 5, unfilled: true, creator: "u2" },
      { id: "t4", ws: "wa", title: "購入画面でポイント残高を出す", story: "s2", sprint: "sp15", who: "u3", pts: 3, creator: "u3" },
      { id: "t5", ws: "wa", title: "ポイント利用の API を設計する", story: "s2", sprint: "sp15", who: "u1", pts: 8, unfilled: true, creator: "u1" },
      { id: "t6", ws: "wa", title: "決済 Webhook の再送を監視する", story: "s3", sprint: "sp14", col: "c2", who: "u4", pts: 3,
        src: { kind: "backlog", key: "SHOP-128", status: "処理中", due: today } },
      { id: "t7", ws: "wa", title: "タイムアウトの閾値を見直す", story: "s3", sprint: "sp14", col: "done", who: "u4", pts: 2, doneAt: "10/16 15:20", creator: "u4" },
      { id: "t8", ws: "wa", title: "障害時の連絡手順を書く", story: "s3", sprint: "sp14", col: "c1", who: "u1", pts: 1, due: "2026-10-17", todayOn: "2026-10-19", creator: "u1" },
      { id: "t9", ws: "wa", title: "問い合わせテンプレートを整える", story: "s4", who: null, pts: null, unfilled: true, creator: "u4" },
      { id: "t10", ws: "wa", title: "依存パッケージを更新する", cat: "k2", sprint: "sp14", col: "done", who: "u3", pts: 2, doneAt: "10/15 11:02",
        src: { kind: "issue", key: "acme/shop#398", status: "closed" } },
      { id: "t11", ws: "wa", title: "クーポンの併用制限", cat: "k1", sprint: "sp14", col: "c1", who: "u1", pts: 1, todayOn: today,
        src: { kind: "review", key: "acme/shop#418", status: "レビュー待ち" } },
      { id: "t12", ws: "wa", title: "請求書 PDF の文字化けを直す", cat: "k2", sprint: "sp14", col: "c3", who: "u1", pts: 2,
        src: { kind: "backlog", key: "SHOP-131", status: "完了" }, srcDone: true },
      { id: "t13", ws: "wa", title: "ポイント失効の通知メールを作る", story: "s1", sprint: "sp15", who: null, pts: null, unfilled: true, creator: "u2" },
      { id: "t14", ws: "wa", title: "決済通知のメール文面を直す", story: "s3", sprint: "sp14", col: "done", who: "u1", pts: 1, doneAt: "10/20 09:40",
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
    history: {
      t1: [
        ["10/19 18:02", "u1", "column", "出発前 → 遂行中"],
        ["10/14 09:30", "u2", "points", "3 → 5"],
        ["10/13 10:00", "u2", "sprint", "なし → 第14回"],
        ["10/12 16:44", "u1", "create", ""],
      ],
    },

    level: { level: 7, xp: 1240, toNext: 160, soon: 90, gotPct: 64, soonPct: 20, rows: [["受託開発チーム", 1240], ["社内ツール", 770]], total: 2010 },

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
