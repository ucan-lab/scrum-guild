// 画面の言葉の辞書。キーごとにゲームの言葉とスクラムの言葉の両方を必須にする（片方を書き忘れると pnpm check が落ちる）。
// 画面の文言は、直に書かずにこの辞書を通して出す。言葉が同じ項目も両方書く。
// 見本の design/kit.js の DICT にあるキーは、同じ中身を持つ（scripts/design-parity.test.ts が突き合わせる）。
// 語順や記号を含む文は、{名前} の置き換えを持つ1項目にする（format で埋める）。
// 読むのは画面（src/lib）と scripts/ のテスト。テストは Node の型の除去で読むので、enum を使わない。

export type Vocabulary = 'game' | 'scrum';

// 言葉づかいを決める単位。ワークスペースの中の言葉は、ワークスペースの設定で切り替える。
// ワークスペースの外の言葉（冒険者ギルド、ギルドマスター、組織の画面の名前、枠の共通の文言）は、管理者が組織の設定で切り替える
// （docs/requirements.md の「ゲームの仕組み」）
export type VocabularyScope = 'workspace' | 'organization';

export type Vocabularies = Record<VocabularyScope, Vocabulary>;

// 既定はゲームの言葉
export const defaultVocabularies: Vocabularies = { workspace: 'game', organization: 'game' };

export type Entry = { readonly scope: VocabularyScope; readonly game: string; readonly scrum: string };

// 辞書の型の検査。game と scrum のどちらかが欠けた項目は、ここで型エラーになる
// （src/shared/vocabulary.typecheck.ts が、欠けたときに落ちることを確かめる）
export function defineDictionary<const T extends Record<string, Entry>>(entries: T): T {
  return entries;
}

export const workspace = (game: string, scrum: string) => ({ scope: 'workspace', game, scrum }) as const;
export const organization = (game: string, scrum: string) => ({ scope: 'organization', game, scrum }) as const;

export const dictionary = defineDictionary({
  // ---- 見本（design/kit.js の DICT）と同じキー ----
  workspace: workspace('パーティ', 'ワークスペース'),
  inbox: workspace('届いた便り', '受信箱'),
  backlog: workspace('掲示板', 'バックログ'),
  sprint: workspace('遠征', 'スプリント'),
  plan: workspace('遠征の計画', '計画'),
  epic: workspace('レイド', 'エピック'),
  story: workspace('達成目標', 'ストーリー'),
  task: workspace('クエスト', 'タスク'),
  archive: workspace('保管庫', 'アーカイブ'),
  connection: workspace('便りの経路', '接続'),
  sprintGoal: workspace('遠征の目的', 'スプリントゴール'),
  detail: workspace('手配書', '詳細'),
  ac: workspace('達成条件', '受け入れ基準'),
  due: workspace('期限', '期日'),
  points: workspace('難易度', 'ポイント'),
  assignee: workspace('担い手', '担当'),
  category: workspace('系統', '区分'),
  capacity: workspace('積載量', '作業量と基準'),
  over: workspace('重量オーバー', '超過'),
  done: workspace('完遂', '完了'),
  column: workspace('行程', '列'),
  doneToday: workspace('今日の完遂', '今日の完了'),
  complete: workspace('完遂にする', '完了にする'),
  requester: workspace('依頼主', '作成者'),
  party: workspace('討伐隊', '参加者'),
  accept: workspace('受注する', '参加する'),
  leave: workspace('討伐隊を抜ける', '参加をやめる'),
  reward: workspace('クリア報酬', 'クリア報酬'),
  clear: workspace('レイドをクリアする', 'エピックを完了にする'),
  create: workspace('依頼を出す', '起票'),
  leader: workspace('パーティリーダー', 'リーダー'),
  member: workspace('冒険者', 'メンバー'),
  dod: workspace('パーティの掟', '完成の定義'),
  vocab: workspace('ゲームの言葉', 'スクラムの言葉'),
  organization: organization('冒険者ギルド', '組織'),
  admin: organization('ギルドマスター', '管理者'),
  assistant: organization('ギルドの書記', 'アシスタント'),

  // ---- 本番の画面の文言 ----
  // 枠の共通の文言
  appName: organization('Scrum Guild', 'Scrum Guild'),
  pageTitle: organization('{page} - {app}', '{page} - {app}'),
  menu: organization('メニュー', 'メニュー'),
  close: organization('閉じる', '閉じる'),
  countUnit: organization('件', '件'),
  unassigned: workspace('担い手なし', '担当なし'),
  leftMember: workspace('（離脱済み）', '（離脱済み）'),
  loadFailedTitle: organization('読み込めませんでした', '読み込めませんでした'),
  loadFailedText: organization(
    'しばらくしてから、もう一度試してください。',
    'しばらくしてから、もう一度試してください。',
  ),
  retry: organization('もう一度試す', 'もう一度試す'),

  // メニューの項目と見出し。ワークスペースの外の画面は organization
  pageToday: organization('自分の今日', '自分の今日'),
  pageNotifications: organization('通知', '通知'),
  pageMe: organization('自分の設定', '自分の設定'),
  pageOrgAdmin: organization('組織の管理', '組織の管理'),
  pageRecords: workspace('完了の記録', '完了の記録'),
  pageMembers: workspace('メンバー', 'メンバー'),
  pageSettings: workspace('設定', '設定'),
  pageHistory: workspace('変更の履歴', '変更の履歴'),
  groupRecords: workspace('記録', '記録'),
  groupManage: workspace('管理', '管理'),

  // 自分の今日（仮の画面）
  sectionToday: organization('今日やる', '今日やる'),
  sectionTodayHint: organization('日付が変わると印は外れます', '日付が変わると印は外れます'),
  todayEmptyTitle: workspace(
    '今日やるクエストは、この画面ができたらここに並びます',
    '今日やるタスクは、この画面ができたらここに並びます',
  ),
  todayEmptyText: organization(
    'いまは API の疎通だけを確かめる仮の画面です。',
    'いまは API の疎通だけを確かめる仮の画面です。',
  ),

  // 自分の今日の空の状態。ワークスペースがまだない管理者に、最初のワークスペースを作るボタンを出す
  firstWorkspaceTitle: organization('まだ{workspace}がありません', 'まだ{workspace}がありません'),
  firstWorkspaceText: organization(
    '最初の{workspace}を作って、冒険者を招きましょう。',
    '最初の{workspace}を作って、メンバーを招きましょう。',
  ),
  firstWorkspaceCreate: organization('{workspace}を作る', '{workspace}を作る'),

  // 組織の選択と、枠の外の画面（組織の切り替え、見つからない、運用の仮の画面）
  organizationChooseTitle: organization('冒険者ギルドを選ぶ', '組織を選ぶ'),
  organizationChooseLead: organization(
    '入れる冒険者ギルドが {count} つあります。名前や稼働の設定は冒険者ギルドごとに別です。',
    '入れる組織が {count} つあります。名前や稼働の設定は組織ごとに別です。',
  ),
  organizationChooseNote: organization(
    'あとから、メニューの上の冒険者ギルドの切り替えで選び直せます。',
    'あとから、メニューの上の組織の切り替えで選び直せます。',
  ),
  organizationList: organization('冒険者ギルドの一覧へ', '組織の一覧へ'),
  noOrganizationTitle: organization('入れる冒険者ギルドがありません', '入れる組織がありません'),
  noOrganizationText: organization(
    'ギルドマスターから招待が届くと、ここに出ます。',
    '管理者から招待が届くと、ここに出ます。',
  ),
  invitationsHeading: organization('届いた招待', '届いた招待'),
  invitationPending: organization('承諾待ちの招待があります', '承諾待ちの招待があります'),
  invitationsNote: organization(
    'すべての冒険者ギルドに届いた招待をまとめて出します。',
    'すべての組織に届いた招待をまとめて出します。',
  ),
  organizationNotFoundTitle: organization('冒険者ギルドが見つかりません', '組織が見つかりません'),
  organizationNotFoundText: organization(
    'URL が違うか、入れない冒険者ギルドです。',
    'URL が違うか、入れない組織です。',
  ),
  operatorOpen: organization('運用の画面へ', '運用の画面へ'),
  pageOperator: organization('運用', '運用'),
  operatorEmptyTitle: organization('運用の画面は準備中です', '運用の画面は準備中です'),
  operatorEmptyText: organization(
    '運用者のログインで入りました。入れる組織はまだありません。',
    '運用者のログインで入りました。入れる組織はまだありません。',
  ),

  // API の疎通の表示（仮の画面）
  apiHeading: organization('API の疎通', 'API の疎通'),
  apiStatus: organization('API: {status}（版 {version}）', 'API: {status}（版 {version}）'),
  apiChecking: organization('API を確かめています', 'API を確かめています'),
  apiUnreachable: organization('API に届きませんでした', 'API に届きませんでした'),
  apiUnreachableStatus: organization('API に届きませんでした（{status}）', 'API に届きませんでした（{status}）'),
  apiShowDetail: organization('詳細を見る', '詳細を見る'),
  apiRecheck: organization('確かめ直す', '確かめ直す'),
  apiRecheckOk: organization('API を確かめました', 'API を確かめました'),
  apiRecheckFailed: organization('API に届きませんでした', 'API に届きませんでした'),
  apiDetailTitle: organization('API の詳細', 'API の詳細'),
  apiDetailBody: organization('この画面が呼んだ API の応答です。', 'この画面が呼んだ API の応答です。'),

  // テーマ
  themeLabel: organization('テーマ', 'テーマ'),
  themeSimple: organization('シンプル（自動）', 'シンプル（自動）'),
  themeSimpleLight: organization('シンプル（ライト）', 'シンプル（ライト）'),
  themeSimpleDark: organization('シンプル（ダーク）', 'シンプル（ダーク）'),
  themeMedieval: organization('中世風', '中世風'),
  themeModern: organization('現代風', '現代風'),
});

export type DictionaryKey = keyof typeof dictionary;

export type TemplateParams = Record<string, string | number>;

// {名前} を params の値で埋める。params に無い名前はそのまま残す（欠けに気づけるように）
export function format(template: string, params: TemplateParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export function word(key: DictionaryKey, vocabularies: Vocabularies, params?: TemplateParams): string {
  const entry: Entry = dictionary[key];
  return format(entry[vocabularies[entry.scope]], params);
}
