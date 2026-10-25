// 画面の言葉の辞書。キーごとにゲームの言葉とスクラムの言葉の両方を必須にする（片方を書き忘れると pnpm check が落ちる）。
// 画面の文言は、直に書かずにこの辞書を通して出す。言葉が同じ項目も両方書く。
// 見本の design/kit.js の DICT にあるキーは、同じ中身を持つ（scripts/design-parity.test.ts が突き合わせる）。
// vite.config.ts と scripts/ からも読むので、Node の型の除去で動く書き方に留める（enum を使わない）。

export type Vocabulary = 'game' | 'scrum';

// 言葉づかいを決める単位。ワークスペースの中の言葉は、ワークスペースの設定で切り替える。
// ワークスペースの外の言葉（冒険者ギルド、ギルドマスターなど）は、管理者が組織の設定で切り替える（docs/requirements.md の「ゲームの仕組み」）
export type VocabularyScope = 'workspace' | 'organization';

export type Vocabularies = Record<VocabularyScope, Vocabulary>;

// 既定はゲームの言葉
export const defaultVocabularies: Vocabularies = { workspace: 'game', organization: 'game' };

type Entry = { readonly scope: VocabularyScope; readonly game: string; readonly scrum: string };

const workspace = (game: string, scrum: string) => ({ scope: 'workspace', game, scrum }) as const;
const organization = (game: string, scrum: string) => ({ scope: 'organization', game, scrum }) as const;

export const dictionary = {
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
  appName: organization('Scrum Guild', 'Scrum Guild'),
  menu: organization('メニュー', 'メニュー'),
  close: workspace('閉じる', '閉じる'),
  countUnit: workspace('件', '件'),
  unassigned: workspace('担い手なし', '担当なし'),
  leftMember: workspace('（離脱済み）', '（離脱済み）'),

  // メニューの項目と見出し
  pageToday: workspace('自分の今日', '自分の今日'),
  pageNotifications: workspace('通知', '通知'),
  pageMe: workspace('自分の設定', '自分の設定'),
  pageOrgAdmin: organization('組織の管理', '組織の管理'),
  pageRecords: workspace('完了の記録', '完了の記録'),
  pageMembers: workspace('メンバー', 'メンバー'),
  pageSettings: workspace('設定', '設定'),
  pageHistory: workspace('変更の履歴', '変更の履歴'),
  groupRecords: workspace('記録', '記録'),
  groupManage: workspace('管理', '管理'),

  // 自分の今日（仮の画面）
  sectionToday: workspace('今日やる', '今日やる'),
  sectionTodayHint: workspace('日付が変わると印は外れます', '日付が変わると印は外れます'),
  todayEmptyTitle: workspace('今日やるクエストはまだありません', '今日やるタスクはまだありません'),
  todayEmptyText: workspace(
    'パーティに所属すると、自分が担い手のクエストがここに並びます。',
    'ワークスペースに所属すると、自分が担当のタスクがここに並びます。',
  ),

  // API の疎通の表示（仮の画面）
  apiHeading: workspace('API の疎通', 'API の疎通'),
  apiLabel: workspace('API', 'API'),
  apiVersion: workspace('版', '版'),
  apiChecking: workspace('API を確かめています', 'API を確かめています'),
  apiUnreachable: workspace('API に届きませんでした', 'API に届きませんでした'),
  apiShowDetail: workspace('詳細を見る', '詳細を見る'),
  apiRecheck: workspace('確かめ直す', '確かめ直す'),
  apiRechecked: workspace('API を確かめ直しました', 'API を確かめ直しました'),
  apiDetailTitle: workspace('API の詳細', 'API の詳細'),
  apiDetailBody: workspace('この画面が呼んだ API の応答です。', 'この画面が呼んだ API の応答です。'),

  // テーマ
  themeLabel: workspace('テーマ', 'テーマ'),
  themeSimple: workspace('シンプル（自動）', 'シンプル（自動）'),
  themeSimpleLight: workspace('シンプル（ライト）', 'シンプル（ライト）'),
  themeSimpleDark: workspace('シンプル（ダーク）', 'シンプル（ダーク）'),
  themeMedieval: workspace('中世風', '中世風'),
  themeModern: workspace('現代風', '現代風'),
  vocabLabel: workspace('言葉', '言葉'),
} as const satisfies Record<string, Entry>;

export type DictionaryKey = keyof typeof dictionary;

export function word(key: DictionaryKey, vocabularies: Vocabularies): string {
  const entry: Entry = dictionary[key];
  return entry[vocabularies[entry.scope]];
}
