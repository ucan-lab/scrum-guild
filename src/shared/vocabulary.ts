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
  retrying: organization('読み込んでいます', '読み込んでいます'),
  // 読み直しに失敗したときの、もう一度試すボタンの横の知らせ
  retryFailed: organization('まだ読み込めませんでした', 'まだ読み込めませんでした'),
  loading: organization('読み込んでいます', '読み込んでいます'),
  loadingText: organization('しばらくお待ちください。', 'しばらくお待ちください。'),

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

  // 自分の今日の空の状態（管理者）。{workspace} と {member} は、その言葉づかいの言葉を画面が渡す。
  // 組織にワークスペースが1つも無いときは、最初のワークスペースを作る案内。作る画面の行き先は、その画面を作る Issue で決める
  firstWorkspaceTitle: organization('まだ{workspace}がありません', 'まだ{workspace}がありません'),
  firstWorkspaceText: organization(
    '最初の{workspace}を作ります。最初の{leader}を1人決めて作ります。',
    '最初の{workspace}を作ります。最初の{leader}を1人決めて作ります。',
  ),
  // ワークスペースはあるが、自分の所属が0件のとき
  noMembershipTitle: organization('どの{workspace}にも所属していません', 'どの{workspace}にも所属していません'),
  noMembershipText: organization(
    '{workspace}に加わると、ここから使えます。',
    '{workspace}に加わると、ここから使えます。',
  ),

  // 組織の管理の画面（管理者）。{workspace} と {leader} は、その言葉づかいの言葉を画面が渡す
  adminEyebrow: organization('{admin}だけが見られます', '{admin}だけが見られます'),
  adminWorkspacesDesc: organization(
    '作った{workspace}の一覧です。終了した{workspace}も含みます。{member}の数は{leader}を含みます。',
    '作った{workspace}の一覧です。終了した{workspace}も含みます。{member}の数は{leader}を含みます。',
  ),
  workspaceListLabel: organization('{workspace}の一覧', '{workspace}の一覧'),
  workspaceEmptyText: organization(
    'チームや用途ごとに作ります。{member}の招待は、作った{workspace}の{leader}が行います。',
    'チームや用途ごとに作ります。{member}の招待は、作った{workspace}の{leader}が行います。',
  ),
  workspaceOpenLabel: organization('進行中の{workspace}', '進行中の{workspace}'),
  workspaceMemberCountHeader: organization('{member}数', '{member}数'),
  workspaceLeaderCountHeader: organization('{leader}数', '{leader}数'),
  fieldName: organization('名前', '名前'),
  createdOn: organization('作った日', '作った日'),
  workspaceClosedChip: organization('終了 {date}', '終了 {date}'),
  workspaceNoLeaderChip: organization('{leader}がいない', '{leader}がいない'),

  // ワークスペースを作るダイアログ。選んだ言葉づかいの名前は、画面が選んだ言葉づかいで引いて渡す
  workspaceCreateAction: organization('{workspace}を作る', '{workspace}を作る'),
  workspaceNamePlaceholder: organization('例: 保守チーム', '例: 保守チーム'),
  workspaceNameRequired: organization('名前を入れてください', '名前を入れてください'),
  workspaceNameTooLong: organization('名前は {max} 字までです', '名前は {max} 字までです'),
  workspaceLeaderLabel: organization('最初の{leader}', '最初の{leader}'),
  workspaceLeaderHint: organization(
    '自分でもかまいません。あとから{leader}を足せます。',
    '自分でもかまいません。あとから{leader}を足せます。',
  ),
  workspaceLeaderLoadFailed: organization('選べる人を読み込めませんでした', '選べる人を読み込めませんでした'),
  workspaceVocabularyLabel: organization('言葉づかい', '言葉づかい'),
  vocabularyGameLabel: organization('ゲームの言葉', 'ゲームの言葉'),
  vocabularyScrumLabel: organization('スクラムの言葉', 'スクラムの言葉'),
  // 言葉づかいの選択肢の例。その言葉づかいの言葉を、画面が渡す
  vocabularyNote: organization('{workspace}、{task}、{epic}', '{workspace}、{task}、{epic}'),
  workspaceVocabularyHint: organization(
    '{column}と決まった欄の名前は、選んだ言葉づかいで決まります。あとから言葉づかいを替えても、名前は変わりません。',
    '{column}と決まった欄の名前は、選んだ言葉づかいで決まります。あとから言葉づかいを替えても、名前は変わりません。',
  ),
  workspaceNameInvalidCharacter: organization(
    '名前に使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
    '名前に使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  ),
  workspaceNoCandidates: organization('最初の{leader}に指せる人がいません', '最初の{leader}に指せる人がいません'),
  workspaceTimezoneRejected: organization(
    'このブラウザのタイムゾーン（{timezone}）では作れません。ブラウザの設定を確かめてください。',
    'このブラウザのタイムゾーン（{timezone}）では作れません。ブラウザの設定を確かめてください。',
  ),
  workspaceDefaultsNote: organization(
    '{column}は「{columns}」、決まった欄は「{field}」、換算は 1 {points} = {hours} 時間、週の始まりは月曜、タイムゾーンは {timezone}（このブラウザの設定）で作ります。あとから設定で変えられます。',
    '{column}は「{columns}」、決まった欄は「{field}」、換算は 1 {points} = {hours} 時間、週の始まりは月曜、タイムゾーンは {timezone}（このブラウザの設定）で作ります。あとから設定で変えられます。',
  ),
  cancel: organization('やめる', 'やめる'),
  workspaceSubmit: organization('作る', '作る'),
  workspaceSubmitting: organization('作っています', '作っています'),
  workspaceCreated: organization('{workspace}を作りました', '{workspace}を作りました'),
  workspaceCreateFailed: organization(
    '作れませんでした。もう一度試してください。',
    '作れませんでした。もう一度試してください。',
  ),
  workspaceLeaderRejected: organization(
    '選んだ人は、いま最初の{leader}に指せません。選び直してください。',
    '選んだ人は、いま最初の{leader}に指せません。選び直してください。',
  ),

  // ワークスペースの枠と画面。見つからない画面は、組織の枠の中に出す
  notMemberAdminChip: organization('所属せず{admin}として開いています', '所属せず{admin}として開いています'),
  workspaceNotFoundTitle: organization('{workspace}が見つかりません', '{workspace}が見つかりません'),
  workspaceNotFoundText: organization(
    'URL が違うか、入れない{workspace}です。',
    'URL が違うか、入れない{workspace}です。',
  ),
  pageNotFoundTitle: organization('画面が見つかりません', '画面が見つかりません'),
  pageNotFoundText: organization('URL が違うか、開けない画面です。', 'URL が違うか、開けない画面です。'),
  backToToday: organization('自分の今日へ', '自分の今日へ'),

  // バックログ（ワークスペースの画面）。{backlog} {task} {create} {done} {points} は、その言葉づかいの言葉を画面が渡す
  backlogTasksLabel: workspace('{backlog}の{task}', '{backlog}の{task}'),
  backlogEmptyTitle: workspace('まだ{task}がありません', 'まだ{task}がありません'),
  backlogEmptyText: workspace(
    '{task}を優先する順に並べる場所です。上の「{create}」から最初の{task}を作ります。',
    '{task}を優先する順に並べる場所です。上の「{create}」から最初の{task}を作ります。',
  ),
  backlogEmptyClosedText: workspace(
    '終了した{workspace}には、{task}を作れません。',
    '終了した{workspace}には、{task}を作れません。',
  ),
  // 完了にした親のないタスクの件数。行は返さず、件数の1行にする。完了にした行は、読み直すまでこの件数に入らない
  backlogFolded: workspace(
    '親のない{done} {count} 件を折りたたんでいます',
    '親のない{done} {count} 件を折りたたんでいます',
  ),
  // 画面の題名の「画面」の部分。画面（バックログ）とワークスペースの両方が分かる形にする。{name} はワークスペースの名前
  backlogPageName: workspace('{backlog}・{name}', '{backlog}・{name}'),
  // 未完了が0件で、完了した親のないタスクがあるとき、折りたたみの行の上に出す
  backlogNoOpenTitle: workspace('未完了の{task}はありません', '未完了の{task}はありません'),
  backlogNoOpenText: workspace(
    '次の{task}は、上の「{create}」から作ります。',
    '次の{task}は、上の「{create}」から作ります。',
  ),
  // タスクの行と、完了の操作
  pointsLabel: workspace('{points} {value}', '{points} {value}'),
  doneMarkLabel: workspace('{title}: {done}', '{title}: {done}'),
  taskCompleting: workspace('{done}にしています', '{done}にしています'),
  taskGone: workspace(
    'この{task}は見つかりません。一覧を読み直します',
    'この{task}は見つかりません。一覧を読み直します',
  ),
  pointsUnsetMark: workspace('未', '未'),
  pointsUnsetTitle: workspace('未見積もり', '未見積もり'),
  // 完了の印の判子の文字。中世風のテーマだけが見せる
  doneStamp: workspace('完', '完'),
  // 完了の操作の読み上げの名前。同じ名前のボタンが並ぶので、どのタスクかを添える
  taskCompleteLabel: workspace('{complete}: {title}', '{complete}: {title}'),
  taskCompleted: workspace('{task}を{done}にしました', '{task}を{done}にしました'),
  taskCompleteFailed: workspace(
    '{done}にできませんでした。もう一度試してください。',
    '{done}にできませんでした。もう一度試してください。',
  ),
  taskAlreadyDone: workspace('この{task}は、すでに{done}です', 'この{task}は、すでに{done}です'),
  workspaceClosedReadOnly: workspace('終了した{workspace}には書き込めません', '終了した{workspace}には書き込めません'),

  // 起票のダイアログ
  fieldTitle: organization('タイトル', 'タイトル'),
  taskTitlePlaceholder: workspace('何をするか', '何をするか'),
  taskTitleRequired: organization('タイトルを入れてください', 'タイトルを入れてください'),
  taskTitleTooLong: organization('タイトルは {max} 字までです', 'タイトルは {max} 字までです'),
  taskTitleInvalidCharacter: organization(
    'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
    'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  ),
  taskPointsHint: workspace(
    '「未」は未見積もり。1 以上の{points}が振られたまま{task}が{done}すると、依頼を出した経験値が付きます。',
    '「未」は未見積もり。起票の経験値は、1 以上の{points}が振られたまま{task}が{done}すると付きます。',
  ),
  taskSubmitting: organization('作っています', '作っています'),
  taskCreated: workspace('{backlog}の末尾に足しました', '{backlog}の末尾に足しました'),
  taskCreateFailed: organization(
    '作れませんでした。もう一度試してください。',
    '作れませんでした。もう一度試してください。',
  ),
  // 親の選択欄。選べるのは、親のないストーリー。{story} {done} は、その言葉づかいの言葉を画面が渡す
  taskParent: workspace('親の{story}', '親の{story}'),
  taskParentNone: workspace('なし', 'なし'),
  // {title} は親のストーリーの題
  taskCreatedUnder: workspace('{story}「{title}」の末尾に足しました', '{story}「{title}」の末尾に足しました'),
  taskParentGone: workspace(
    'この{story}は見つかりません。親を選び直してください',
    'この{story}は見つかりません。親を選び直してください',
  ),
  taskParentDone: workspace(
    'この{story}はすでに{done}しています。親を選び直してください',
    'この{story}はすでに{done}しています。親を選び直してください',
  ),

  // バックログの木（ストーリーの行、期日の印）
  storyCreate: workspace('{story}を作る', '{story}を作る'),
  // 木の行の「＋タスク」の読み上げの名前。同じ名前のボタンが並ぶので、どのストーリーかを添える
  storyAddTaskLabel: workspace('{task}を足す: {title}', '{task}を足す: {title}'),
  treeRatio: workspace('{done} {value} / {all} pt', '{done} {value} / {all} pt'),
  treeRatioTitle: workspace('{done} / 全体', '{done} / 全体'),
  storyFolded: workspace('{done} {count} 件を折りたたんでいます', '{done} {count} 件を折りたたんでいます'),
  storyNoTasks: workspace('{task}はまだありません', '{task}はまだありません'),
  dueOverdue: workspace('{due}切れ {date}', '{due}切れ {date}'),
  dueToday: workspace('今日まで', '今日まで'),
  dueThisWeek: workspace('今週 {date}', '今週 {date}'),

  // ストーリーのダイアログ（作るときも直すときも同じ欄）
  fieldBody: organization('本文', '本文'),
  fieldLink: organization('リンク', 'リンク'),
  storyTitlePlaceholder: workspace('どこまで進めば区切りか', 'どこまで進めば区切りか'),
  linkPlaceholder: organization('https://', 'https://'),
  fieldTextTooLong: organization('{field}は {max} 字までです', '{field}は {max} 字までです'),
  fieldTextInvalidCharacter: organization(
    '{field}に使えない文字（改行とタブ以外の制御文字、ゼロ幅のスペースなど）が含まれています',
    '{field}に使えない文字（改行とタブ以外の制御文字、ゼロ幅のスペースなど）が含まれています',
  ),
  linkInvalid: organization(
    'http か https で始まる URL を入れてください',
    'http か https で始まる URL を入れてください',
  ),
  linkTooLong: organization('リンクは {max} 字までです', 'リンクは {max} 字までです'),
  storySave: organization('保存する', '保存する'),
  storySaving: organization('保存しています', '保存しています'),
  storyCreated: workspace('{story}を作りました', '{story}を作りました'),
  storySaved: workspace('{story}を保存しました', '{story}を保存しました'),
  storySaveFailed: organization(
    '保存できませんでした。もう一度試してください。',
    '保存できませんでした。もう一度試してください。',
  ),
  storyGone: workspace(
    'この{story}は見つかりません。一覧を読み直します',
    'この{story}は見つかりません。一覧を読み直します',
  ),
  storyReadOnly: workspace(
    '終了した{workspace}の{story}は、読み取りだけできます',
    '終了した{workspace}の{story}は、読み取りだけできます',
  ),
  // ストーリーのダイアログ専用の文言（タスクのダイアログの文言を流用しない）
  storyTitleRequired: organization('タイトルを入れてください', 'タイトルを入れてください'),
  storyTitleTooLong: organization('タイトルは {max} 字までです', 'タイトルは {max} 字までです'),
  storyTitleInvalidCharacter: organization(
    'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
    'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  ),
  storyCreateSubmit: organization('作る', '作る'),
  storyCreating: organization('作っています', '作っています'),
  storyCreateFailed: organization(
    '作れませんでした。もう一度試してください。',
    '作れませんでした。もう一度試してください。',
  ),
  // 画面の検査を通った後に、サーバーが 400 で断ったとき。どの欄かは分からない
  storyBadRequest: organization(
    '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
    '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
  ),
  storyLoading: organization('読み込んでいます', '読み込んでいます'),
  storyLoadFailed: workspace(
    'この{story}を読み込めませんでした。もう一度試してください。',
    'この{story}を読み込めませんでした。もう一度試してください。',
  ),
  dueInvalid: workspace('{due}は正しい日付で入れてください', '{due}は正しい日付で入れてください'),
  storyLinkOpen: organization('開く', '開く'),
  storyLinkOpenLabel: organization('リンクを新しいタブで開く', 'リンクを新しいタブで開く'),
  // 木の行の開閉のボタンの読み上げの名前。{title} はストーリーの題
  treeOpen: workspace('{title}を開く', '{title}を開く'),
  treeClose: workspace('{title}を閉じる', '{title}を閉じる'),

  // バックログの並べ替えと親の移動。{title} は動かす行の題
  backlogOrderNote: workspace(
    '上にあるものほど優先します。行の「上へ」「下へ」か、行の中にフォーカスを置いて Alt と ↑ ↓ で並べ替えます。',
    '上にあるものほど優先します。行の「上へ」「下へ」か、行の中にフォーカスを置いて Alt と ↑ ↓ で並べ替えます。',
  ),
  moveUp: organization('上へ', '上へ'),
  moveDown: organization('下へ', '下へ'),
  // 同じ名前のボタンが並ぶので、どの行かを添える
  moveUpLabel: organization('上へ: {title}', '上へ: {title}'),
  moveDownLabel: organization('下へ: {title}', '下へ: {title}'),
  moveParent: workspace('親を移す', '親を移す'),
  moveParentLabel: workspace('親を移す: {title}', '親を移す: {title}'),
  // 並べ替えの読み上げ。{index} は同じ親の中で何番目か
  moveAnnounced: workspace('「{title}」を {index} 番目に移しました', '「{title}」を {index} 番目に移しました'),
  // 親を移したときの知らせ。{parent} は移す先のストーリーの題
  moveAnnouncedUnder: workspace(
    '「{title}」を{story}「{parent}」の末尾へ移しました',
    '「{title}」を{story}「{parent}」の末尾へ移しました',
  ),
  moveAnnouncedRoot: workspace('「{title}」を親なしの末尾へ移しました', '「{title}」を親なしの末尾へ移しました'),
  moveFailed: organization('移せませんでした。一覧を読み直します', '移せませんでした。一覧を読み直します'),
  moveConflict: organization(
    'ほかの画面で変わったため、移せませんでした。一覧を読み直します',
    'ほかの画面で変わったため、移せませんでした。一覧を読み直します',
  ),
  moveParentDone: workspace(
    '{done}した{story}の下へは移せません。一覧を読み直します',
    '{done}した{story}の下へは移せません。一覧を読み直します',
  ),
  // 動かした行か、直前の行か、親が見つからなかった（404）。どれが消えたかは分からない
  moveGone: organization(
    '一覧が変わったため移せませんでした。一覧を読み直します',
    '一覧が変わったため移せませんでした。一覧を読み直します',
  ),
  moveTaskDone: workspace(
    'この{task}は{done}しています。一覧を読み直します',
    'この{task}は{done}しています。一覧を読み直します',
  ),
  // 動かしている間に一覧が読み直され、まだ送っていなかった移動を捨てたとき
  moveReloaded: organization(
    '動かしている間に一覧が読み直されたため、一覧を読み直しました。並びが変わっていなければ、もう一度動かしてください',
    '動かしている間に一覧が読み直されたため、一覧を読み直しました。並びが変わっていなければ、もう一度動かしてください',
  ),
  // 端の行で Alt と ↑ ↓ を押したときの読み上げ
  moveAtTop: organization('いちばん上です', 'いちばん上です'),
  moveAtBottom: organization('いちばん下です', 'いちばん下です'),
  // 親を移すダイアログ。見出しに、どのタスクを動かすかを添える
  moveParentTitle: workspace('「{title}」の親を移す', '「{title}」の親を移す'),
  moveParentField: organization('移す先', '移す先'),
  moveParentNone: organization('親なし', '親なし'),
  moveParentHint: organization('移す先の末尾に置きます。', '移す先の末尾に置きます。'),
  moveParentSubmit: organization('移す', '移す'),

  // 組織の選択と、枠の外の画面（組織の切り替え、見つからない、運用の仮の画面）
  organizationChooseTitle: organization('冒険者ギルドを選ぶ', '組織を選ぶ'),
  organizationChooseLead: organization(
    '入れる冒険者ギルドが {count} つあります。名前や稼働の設定は冒険者ギルドごとに別です。',
    '入れる組織が {count} つあります。名前や稼働の設定は組織ごとに別です。',
  ),
  organizationChooseNote: organization(
    'あとから、画面の左上（狭い幅では上の帯）の冒険者ギルドの切り替えで選び直せます。',
    'あとから、画面の左上（狭い幅では上の帯）の組織の切り替えで選び直せます。',
  ),
  organizationList: organization('冒険者ギルドの一覧へ', '組織の一覧へ'),
  // 組織の切り替えのボタンと一覧の読み上げの名前。{name} は今の組織の名前
  organizationSwitchLabel: organization('{name}。冒険者ギルドを切り替える', '{name}。組織を切り替える'),
  organizationListLabel: organization('入れる冒険者ギルド', '入れる組織'),
  organizationMoving: organization('移っています', '移っています'),
  invitationsBadge: organization('届いた招待あり', '届いた招待あり'),
  invitationsReceived: organization('招待が届いています', '招待が届いています'),
  noOrganizationTitle: organization('入れる冒険者ギルドがありません', '入れる組織がありません'),
  noOrganizationText: organization(
    'ギルドマスターから招待が届くと、ここに出ます。',
    '管理者から招待が届くと、ここに出ます。',
  ),
  // 入れる組織は無いが、届いた招待がある人
  noOrganizationInvitedTitle: organization('まだ入れる冒険者ギルドがありません', 'まだ入れる組織がありません'),
  noOrganizationInvitedText: organization(
    '届いた招待の承諾と辞退は、この画面にこれから加わります。',
    '届いた招待の承諾と辞退は、この画面にこれから加わります。',
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
  // 組織の枠の停止の画面（API が 403 の organization_suspended を返したとき）
  organizationSuspendedTitle: organization('冒険者ギルドは停止しています', '組織は停止しています'),
  organizationSuspendedText: organization(
    'この冒険者ギルドは停止しています。運用者に問い合わせてください。',
    'この組織は停止しています。運用者に問い合わせてください。',
  ),
  operatorOpen: organization('運用の画面へ', '運用の画面へ'),
  pageOperator: organization('運用', '運用'),
  // 運用の画面。{organization} {admin} は、それぞれ辞書の同じ名前の項目で埋める
  operatorNotice: organization(
    '運用者は{organization}の中（タスク、メンバー、記録、添付ファイルの中身など）を見られません。ここに出すのは名前、slug、状態だけです。',
    '運用者は{organization}の中（タスク、メンバー、記録、添付ファイルの中身など）を見られません。ここに出すのは名前、slug、状態だけです。',
  ),
  operatorEmptyTitle: organization('{organization}がまだありません', '{organization}がまだありません'),
  operatorEmptyText: organization(
    '{organization}を作り、最初の{admin}を指名してください。',
    '{organization}を作り、最初の{admin}を指名してください。',
  ),
  operatorCreate: organization('{organization}を作る', '{organization}を作る'),
  operatorColumnOrganization: organization('{organization}・slug', '{organization}・slug'),
  operatorColumnCreated: organization('作った日時', '作った日時'),
  // 一覧の印。{date} は停止した日（ブラウザのタイムゾーンの日付）と、解約で消す予定日（UTC の日付）
  operatorSuspended: organization('停止 {date}', '停止 {date}'),
  operatorPurgeOn: organization('{date} に消す', '{date} に消す'),
  operatorActionsHeader: organization('操作', '操作'),
  // 組織の停止と再開。{organization} は辞書の同じ名前の項目、{name} は組織の名前
  operatorSuspendAction: organization('停止する', '停止する'),
  operatorResumeAction: organization('再開する', '再開する'),
  operatorSuspendLabel: organization('「{name}」を停止する', '「{name}」を停止する'),
  operatorResumeLabel: organization('「{name}」を再開する', '「{name}」を再開する'),
  operatorSuspendTitle: organization('{organization}を停止する', '{organization}を停止する'),
  operatorSuspendText: organization(
    '「{name}」を停止します。停止すると誰も入れなくなり、取り込みと日をまたぐ処理も止まります。データは残り、再開すれば元どおりに使えます。',
    '「{name}」を停止します。停止すると誰も入れなくなり、取り込みと日をまたぐ処理も止まります。データは残り、再開すれば元どおりに使えます。',
  ),
  operatorSuspendReason: organization('停止の理由', '停止の理由'),
  operatorSuspendTemporary: organization('一時的に止める', '一時的に止める'),
  operatorSuspendTemporaryHint: organization(
    '支払いの遅れなど。消す予定は立てません。',
    '支払いの遅れなど。消す予定は立てません。',
  ),
  operatorSuspendCancellation: organization('解約', '解約'),
  // {days} は PURGE_AFTER_DAYS（src/shared/operations/operator/organization-suspend.ts）
  operatorSuspendCancellationHint: organization(
    '停止から {days} 日後に、運用の手順でデータをすべて消します。それまでは再開できます。',
    '停止から {days} 日後に、運用の手順でデータをすべて消します。それまでは再開できます。',
  ),
  operatorSuspending: organization('停止しています', '停止しています'),
  operatorResuming: organization('再開しています', '再開しています'),
  operatorSuspendDone: organization('「{name}」を停止しました', '「{name}」を停止しました'),
  operatorResumeDone: organization('「{name}」を再開しました', '「{name}」を再開しました'),
  // 停止中の組織の停止の理由を、再開せずに切り替える（停止した日時は変えない）
  operatorChangeAction: organization('停止の理由を変える', '停止の理由を変える'),
  operatorChangeLabel: organization('「{name}」の停止の理由を変える', '「{name}」の停止の理由を変える'),
  operatorChangeTitle: organization('停止の理由を変える', '停止の理由を変える'),
  operatorChangeText: organization(
    '「{name}」の停止の理由を選び直します。停止した日時は変わらず、再開しなくても切り替えられます。',
    '「{name}」の停止の理由を選び直します。停止した日時は変わらず、再開しなくても切り替えられます。',
  ),
  operatorChangeTemporaryHint: organization('消す予定を取り消します。', '消す予定を取り消します。'),
  operatorChangeCancellationHint: organization(
    '切り替えた日から {days} 日後に、運用の手順でデータをすべて消します。それまでは再開できます。',
    '切り替えた日から {days} 日後に、運用の手順でデータをすべて消します。それまでは再開できます。',
  ),
  operatorChangeSubmit: organization('変える', '変える'),
  operatorChanging: organization('変えています', '変えています'),
  operatorChangeDone: organization('「{name}」の停止の理由を変えました', '「{name}」の停止の理由を変えました'),
  operatorChangeFailed: organization(
    '停止の理由を変えられませんでした。もう一度試してください。',
    '停止の理由を変えられませんでした。もう一度試してください。',
  ),
  operatorSuspendFailed: organization(
    '{organization}を停止できませんでした。もう一度試してください。',
    '{organization}を停止できませんでした。もう一度試してください。',
  ),
  operatorResumeFailed: organization(
    '{organization}を再開できませんでした。もう一度試してください。',
    '{organization}を再開できませんでした。もう一度試してください。',
  ),
  // 別の画面で先に操作されていた（409）。停止した状態か再開した状態かは言い切らず、読み直した一覧を見てもらう
  operatorStateChanged: organization(
    '「{name}」の状態が変わっていました。一覧で状態を確かめてください',
    '「{name}」の状態が変わっていました。一覧で状態を確かめてください',
  ),
  // 見つからない、または操作できない（404、403）
  operatorUnavailable: organization(
    '「{name}」を操作できませんでした。見つからないか、操作できない状態です。一覧で状態を確かめてください',
    '「{name}」を操作できませんでした。見つからないか、操作できない状態です。一覧で状態を確かめてください',
  ),
  operatorAdminNone: organization('{admin}がいない', '{admin}がいない'),
  operatorAdminPending: organization('{admin}は指名済み、ログイン待ち', '{admin}は指名済み、ログイン待ち'),
  operatorAdminExpired: organization('{admin}の招待の URL は期限切れ', '{admin}の招待の URL は期限切れ'),

  // 組織の作成のダイアログ
  operatorCreateTitle: organization('{organization}を作る', '{organization}を作る'),
  operatorSlugLabel: organization('URL の名前（slug）', 'URL の名前（slug）'),
  operatorSlugExample: organization('例: sakura-dev', '例: sakura-dev'),
  operatorSlugHint: organization(
    '英小文字、数字、ハイフンで 2〜40 字。あとから変えられません。',
    '英小文字、数字、ハイフンで 2〜40 字。あとから変えられません。',
  ),
  operatorNameLabel: organization('表示名', '表示名'),
  operatorNameExample: organization('例: さくら開発', '例: さくら開発'),
  operatorAdminVia: organization('最初の{admin}のログインの手段', '最初の{admin}のログインの手段'),
  operatorGithubName: organization('GitHub', 'GitHub'),
  operatorGoogleName: organization('Google', 'Google'),
  operatorGithubUserLabel: organization('GitHub のユーザー名', 'GitHub のユーザー名'),
  operatorGithubUserExample: organization('例: kotone-dev', '例: kotone-dev'),
  operatorGithubUserHint: organization(
    'GitHub のユーザー ID に解決します。「確かめる」を押して、指名する人を見て確かめてから作ります。',
    'GitHub のユーザー ID に解決します。「確かめる」を押して、指名する人を見て確かめてから作ります。',
  ),
  operatorGoogleEmailLabel: organization('Google のメールアドレス', 'Google のメールアドレス'),
  operatorGoogleEmailExample: organization('例: mio.hoshino@example.com', '例: mio.hoshino@example.com'),
  operatorGoogleEmailHint: organization(
    'その人が招待の URL を開き、このメールアドレスの Google アカウントでログインすると、{admin}として入れます。招待の URL は14日で切れます。',
    'その人が招待の URL を開き、このメールアドレスの Google アカウントでログインすると、{admin}として入れます。招待の URL は14日で切れます。',
  ),
  operatorErrorEmailRequired: organization('メールアドレスを入れてください。', 'メールアドレスを入れてください。'),
  operatorErrorEmailInvalid: organization(
    'メールアドレスの形に合いません。英数字などの ASCII の文字だけで、本人が Google に登録した綴りのまま入れてください。',
    'メールアドレスの形に合いません。英数字などの ASCII の文字だけで、本人が Google に登録した綴りのまま入れてください。',
  ),
  operatorVerify: organization('確かめる', '確かめる'),
  operatorVerifying: organization('確かめています', '確かめています'),
  operatorVerifyLead: organization(
    'この人を最初の{admin}にします。アバター、ユーザー名、表示名が、伝えたい人のものか確かめてください。ユーザー名は 1 字違いでも別の人に当たります。',
    'この人を最初の{admin}にします。アバター、ユーザー名、表示名が、伝えたい人のものか確かめてください。ユーザー名は 1 字違いでも別の人に当たります。',
  ),
  operatorNoDisplayName: organization('表示名なし', '表示名なし'),
  operatorGithubId: organization('GitHub のユーザー ID {id}', 'GitHub のユーザー ID {id}'),
  operatorCancel: organization('やめる', 'やめる'),
  operatorSubmit: organization('作る', '作る'),
  operatorSubmitting: organization('作っています', '作っています'),
  operatorErrorSlugRequired: organization('slug を入れてください。', 'slug を入れてください。'),
  operatorErrorSlugFormat: organization(
    '英小文字、数字、ハイフンで 2〜40 字にしてください。',
    '英小文字、数字、ハイフンで 2〜40 字にしてください。',
  ),
  operatorErrorSlugReserved: organization(
    'この名前はアプリが使うので付けられません。',
    'この名前はアプリが使うので付けられません。',
  ),
  operatorErrorSlugTaken: organization(
    'この slug はもう使われています。今作った{organization}かもしれないので、一覧を確かめてください。このダイアログを閉じると入力は消えます。',
    'この slug はもう使われています。今作った{organization}かもしれないので、一覧を確かめてください。このダイアログを閉じると入力は消えます。',
  ),
  operatorAlreadyCreated: organization(
    '「{slug}」の{organization}はもう作られています。名前も入力と同じなので、今作ったものと思われます。',
    '「{slug}」の{organization}はもう作られています。名前も入力と同じなので、今作ったものと思われます。',
  ),
  operatorAlreadyCreatedOther: organization(
    '「{slug}」の{organization}はもう作られています。名前が入力と違うので、この入力で作ったものではないかもしれません。',
    '「{slug}」の{organization}はもう作られています。名前が入力と違うので、この入力で作ったものではないかもしれません。',
  ),
  operatorAlreadyCreatedNoAdmin: organization(
    '最初の{admin}が書かれていません。{admin}の指名し直しは、運用の画面にこれから加わります。',
    '最初の{admin}が書かれていません。{admin}の指名し直しは、運用の画面にこれから加わります。',
  ),
  operatorShowCreated: organization('作られた{organization}の URL を見る', '作られた{organization}の URL を見る'),
  // ダイアログの読み上げの領域（常に置き、文字だけを替える）
  operatorLiveVerifying: organization('確かめています', '確かめています'),
  operatorLiveVerified: organization('確かめました: {name}', '確かめました: {name}'),
  operatorLiveCreating: organization('作っています', '作っています'),
  operatorLiveCreated: organization('作りました', '作りました'),
  operatorLiveExisting: organization(
    '作られていた{organization}を見ています',
    '作られていた{organization}を見ています',
  ),
  // 作れたか分からない失敗の後に、読み直した一覧で見つけた組織の表示。{admin} に指名された人は、ここでは分からない
  operatorExistingTitle: organization('{organization}はもう作られています', '{organization}はもう作られています'),
  operatorExistingLead: organization(
    'この slug の{organization}は、もう作られています。次の URL を確かめてください。誰を{admin}に指名したかは、ここでは分かりません。',
    'この slug の{organization}は、もう作られています。次の URL を確かめてください。誰を{admin}に指名したかは、ここでは分かりません。',
  ),
  // 招待の URL は作った直後の応答にしか出ないので、ここでは出せない。出し直すには指名し直しの操作が要る
  operatorExistingAdminPending: organization(
    '指名された{admin}は、まだログインしていません。Google で指名したときの招待の URL は、ここでは出せません。URL を渡せていなければ、指名し直す操作が入るまで、この{organization}は使い始められません。',
    '指名された{admin}は、まだログインしていません。Google で指名したときの招待の URL は、ここでは出せません。URL を渡せていなければ、指名し直す操作が入るまで、この{organization}は使い始められません。',
  ),
  operatorExistingAdminExpired: organization(
    '指名された{admin}の招待の URL は、期限が切れています。URL はもう出せず、指名し直す操作が入るまで、この{organization}は使い始められません。',
    '指名された{admin}の招待の URL は、期限が切れています。URL はもう出せず、指名し直す操作が入るまで、この{organization}は使い始められません。',
  ),
  operatorExistingAdminActive: organization(
    '{admin}は、もうログインしています。',
    '{admin}は、もうログインしています。',
  ),
  operatorErrorNameRequired: organization('表示名を入れてください。', '表示名を入れてください。'),
  operatorErrorNameLong: organization('表示名は 80 字までです。', '表示名は 80 字までです。'),
  operatorErrorNameInvalid: organization(
    '表示名に使えない文字（制御文字、行や段落の区切り、向きを変える文字、見えない空白や演算子）が含まれています。',
    '表示名に使えない文字（制御文字、行や段落の区切り、向きを変える文字、見えない空白や演算子）が含まれています。',
  ),
  operatorErrorInvalid: organization(
    '入力に誤りがあります。内容を確かめてください。',
    '入力に誤りがあります。内容を確かめてください。',
  ),
  operatorErrorVerifyFailed: organization(
    'ユーザー名を確かめられませんでした。もう一度試してください。',
    'ユーザー名を確かめられませんでした。もう一度試してください。',
  ),
  operatorErrorVerifyAgain: organization(
    'ユーザー名を直したので、もう一度確かめてください。',
    'ユーザー名を直したので、もう一度確かめてください。',
  ),
  operatorErrorUserRequired: organization('ユーザー名を入れてください。', 'ユーザー名を入れてください。'),
  operatorErrorUserNotFound: organization(
    'そのユーザー名の人が GitHub にいません。',
    'そのユーザー名の人が GitHub にいません。',
  ),
  operatorErrorNotUser: organization(
    'GitHub の組織のアカウントなどで、個人のアカウントではありません。ログインできないので指名できません。',
    'GitHub の組織のアカウントなどで、個人のアカウントではありません。ログインできないので指名できません。',
  ),
  operatorErrorUserChanged: organization(
    '確かめたあとに、ユーザー名の持ち主が変わりました。もう一度確かめてください。',
    '確かめたあとに、ユーザー名の持ち主が変わりました。もう一度確かめてください。',
  ),
  operatorErrorGithubUnavailable: organization(
    'GitHub に届きませんでした。しばらくしてから、もう一度試してください。',
    'GitHub に届きませんでした。しばらくしてから、もう一度試してください。',
  ),
  operatorErrorCreate: organization(
    '{organization}を作れたか分かりません。サーバーでは作られていることがあるので、一覧を確かめてから、もう一度試してください。このダイアログを閉じると入力は消えます。',
    '{organization}を作れたか分かりません。サーバーでは作られていることがあるので、一覧を確かめてから、もう一度試してください。このダイアログを閉じると入力は消えます。',
  ),
  operatorErrorUnreachable: organization('サーバーに届きませんでした。', 'サーバーに届きませんでした。'),

  // 作った後の表示
  operatorDoneTitle: organization('{organization}を作りました', '{organization}を作りました'),
  operatorDoneLead: organization(
    'Scrum Guild はメールを送りません。{admin}になる人に、次の URL とログインの手段を伝えてください。',
    'Scrum Guild はメールを送りません。{admin}になる人に、次の URL とログインの手段を伝えてください。',
  ),
  operatorDoneUrlLabel: organization('{organization}の URL', '{organization}の URL'),
  operatorCopy: organization('コピー', 'コピー'),
  operatorCopied: organization('URL をコピーしました', 'URL をコピーしました'),
  operatorCopyFailed: organization(
    'コピーできませんでした。URL を選んでコピーしてください。',
    'コピーできませんでした。URL を選んでコピーしてください。',
  ),
  operatorDoneTell: organization(
    'GitHub の {name} でログインするよう伝えてください。',
    'GitHub の {name} でログインするよう伝えてください。',
  ),
  // Google の指名で作った後の表示。招待の URL はこの画面にだけ出る
  operatorInviteLead: organization(
    'Scrum Guild はメールを送りません。{admin}になる人に、次の招待の URL を伝えてください。本人がこの URL を開き、指名したメールアドレスの Google アカウントでログインすると、{organization}に入れます。',
    'Scrum Guild はメールを送りません。{admin}になる人に、次の招待の URL を伝えてください。本人がこの URL を開き、指名したメールアドレスの Google アカウントでログインすると、{organization}に入れます。',
  ),
  operatorInviteUrlLabel: organization('招待の URL', '招待の URL'),
  operatorInviteCopied: organization('招待の URL をコピーしました', '招待の URL をコピーしました'),
  operatorInviteOnce: organization(
    'この URL はこの画面を閉じると二度と出せません。期限は14日（{expires} まで）です。期限までに本人へ伝えてください。',
    'この URL はこの画面を閉じると二度と出せません。期限は14日（{expires} まで）です。期限までに本人へ伝えてください。',
  ),
  // 続けて、メールアドレスを別の要素（等幅で、狭い幅では折り返す）で出す
  operatorInviteTell: organization(
    '次のメールアドレスの Google アカウントでログインするよう伝えてください。',
    '次のメールアドレスの Google アカウントでログインするよう伝えてください。',
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

  // アカウントのメニュー（組織の中の上の帯）とログアウト。{name} はログインしている人の名前
  accountMenuLabel: organization('{name}。アカウントのメニュー', '{name}。アカウントのメニュー'),
  logout: organization('ログアウト', 'ログアウト'),
  logoutMoving: organization('ログアウトしています', 'ログアウトしています'),
  logoutFailed: organization(
    'ログアウトできませんでした。時間をおいてもう一度試してください。',
    'ログアウトできませんでした。時間をおいてもう一度試してください。',
  ),
  loggedOut: organization('ログアウトしました。', 'ログアウトしました。'),

  // ログインの画面。{organization} {workspace} {leader} は、それぞれ辞書の同じ名前の項目で埋める
  loginTitle: organization('ログイン', 'ログイン'),
  loginLead: organization(
    'いずれかの{organization}に所属しているか、招待されている人がログインできます。招待されたときの手段でログインしてください。',
    'いずれかの{organization}に所属しているか、招待されている人がログインできます。招待されたときの手段でログインしてください。',
  ),
  loginWithGithub: organization('GitHub でログイン', 'GitHub でログイン'),
  loginWithGoogle: organization('Google でログイン', 'Google でログイン'),
  loginNote: organization(
    'どちらも本人確認だけに使います。入れる{organization}が2つ以上あれば、ログインのあとに選びます。',
    'どちらも本人確認だけに使います。入れる{organization}が2つ以上あれば、ログインのあとに選びます。',
  ),
  loginErrorDenied: organization(
    'ログインできませんでした。どの{organization}の{workspace}にも所属しておらず、招待も届いていません。招待された手段（GitHub か Google）と、招待されたアカウントでログインしているか確かめてください。招待がまだなら、{leader}に GitHub のユーザー名か Google のメールアドレスで招待してもらってください。',
    'ログインできませんでした。どの{organization}の{workspace}にも所属しておらず、招待も届いていません。招待された手段（GitHub か Google）と、招待されたアカウントでログインしているか確かめてください。招待がまだなら、{leader}に GitHub のユーザー名か Google のメールアドレスで招待してもらってください。',
  ),
  // 入れる{organization}（や届いた招待）が、停止した{organization}にだけあるとき（?error=suspended）
  loginErrorSuspended: organization(
    'ログインできませんでした。所属しているか招待されている{organization}は停止しています。運用者に問い合わせてください。',
    'ログインできませんでした。所属しているか招待されている{organization}は停止しています。運用者に問い合わせてください。',
  ),
  // 招待の URL から結べなかったとき。理由（期限切れ、取り消し、別のアカウント、使い済み）は分けず、どのメールアドレスに招待したかも出さない
  loginErrorInvite: organization(
    'この招待の URL は使えません。期限が切れたか、取り消されたか、招待されたのと別のアカウントでログインしています。招待した人に確かめるか、届いた招待の URL をもう一度開いてください。もう入れる{organization}がある人は、下のボタンからそのままログインできます。',
    'この招待の URL は使えません。期限が切れたか、取り消されたか、招待されたのと別のアカウントでログインしています。招待した人に確かめるか、届いた招待の URL をもう一度開いてください。もう入れる{organization}がある人は、下のボタンからそのままログインできます。',
  ),
  // /invite を、URL の続き（# 以降）が無いまま開いたとき。秘密は読んだらすぐ URL から消すので、戻る・再読み込みでもここに来る
  inviteUnusable: organization(
    'この招待の URL は使えません。招待の URL を開いた直後の画面だけが使えます。戻る・再読み込みをしたときや、URL が欠けているときは、届いた招待の URL をもう一度開いてください。',
    'この招待の URL は使えません。招待の URL を開いた直後の画面だけが使えます。戻る・再読み込みをしたときや、URL が欠けているときは、届いた招待の URL をもう一度開いてください。',
  ),
  inviteMoving: organization('Google へ移っています', 'Google へ移っています'),
  loginErrorRetry: organization(
    'ログインを完了できませんでした。もう一度ログインしてください。',
    'ログインを完了できませんでした。もう一度ログインしてください。',
  ),
  loginErrorTooMany: organization(
    'ログインの試行が多すぎます。しばらく待ってから、もう一度ログインしてください。',
    'ログインの試行が多すぎます。しばらく待ってから、もう一度ログインしてください。',
  ),
  loginErrorUnavailable: organization(
    'いまログインを受け付けられません。時間をおいてもう一度試してください。続くときは運用者に連絡してください。',
    'いまログインを受け付けられません。時間をおいてもう一度試してください。続くときは運用者に連絡してください。',
  ),

  // メンバーの画面（ワークスペースの画面）。{leader} {member} {admin} は、その言葉づかいの言葉を画面が渡す。
  // ロールは文字で出す（付け替え、外す、抜ける は後の Issue で足す）。
  // 以下のキーのうち、ゲームとスクラムで同じ文字列にしているのは見本（design/members.html）どおりの意図による
  // （例: 「一般」はゲームの言葉でも「一般」。見本はロールの select の「一般」を言葉づかいで替えない）。
  // 言葉づかいで変わるのは、{leader} {member} {admin} などの辞書の言葉を埋め込むところだけ
  membersPageName: workspace('{members}・{name}', '{members}・{name}'),
  membersTallyBelonging: workspace('所属', '所属'),
  membersTallyInvited: workspace('招待中', '招待中'),
  membersSectionTitle: workspace('所属している人', '所属している人'),
  membersTableLabel: workspace('所属している人の一覧', '所属している人の一覧'),
  membersEmptyTitle: workspace('所属している人はいません', '所属している人はいません'),
  membersEmptyText: workspace(
    '招待を承諾した{member}が、ここに並びます。',
    '招待を承諾した{member}が、ここに並びます。',
  ),
  memberRoleHeader: workspace('ロール', 'ロール'),
  memberJoinedHeader: workspace('参加日', '参加日'),
  roleMember: workspace('一般', '一般'),
  // 承諾待ちの招待。{leader} と {admin} にだけ見える
  invitationsSectionTitle: workspace('承諾待ちの招待', '承諾待ちの招待'),
  invitationsSectionHint: workspace('{leader}と{admin}にだけ見えます', '{leader}と{admin}にだけ見えます'),
  invitationsTableLabel: workspace('承諾待ちの招待の一覧', '承諾待ちの招待の一覧'),
  invitationsEmptyTitle: workspace('承諾待ちの招待はありません', '承諾待ちの招待はありません'),
  invitationsEmptyText: workspace(
    '招待した人が承諾するまで、ここに並びます。',
    '招待した人が承諾するまで、ここに並びます。',
  ),
  invitationViaHeader: workspace('手段', '手段'),
  invitedOnHeader: workspace('招待した日', '招待した日'),
  loginProviderGithub: workspace('GitHub', 'GitHub'),
  loginProviderGoogle: workspace('Google', 'Google'),
  // Google の招待の期限（作ってから14日）。{date} は YYYY-MM-DD
  invitationExpiresOn: workspace('{date} まで', '{date} まで'),
  invitationExpired: workspace('期限切れ', '期限切れ'),
  // 承諾待ちの招待の取り消し（リーダーと管理者）。{name} は招待のときの名前
  invitationActionsHeader: workspace('操作', '操作'),
  invitationRevoke: workspace('取り消す', '取り消す'),
  invitationRevokeLabel: workspace('{name} への招待を取り消す', '{name} への招待を取り消す'),
  invitationRevoking: workspace('招待を取り消しています', '招待を取り消しています'),
  invitationRevoked: workspace('招待を取り消しました', '招待を取り消しました'),
  invitationRevokeChanged: workspace(
    '招待の状態が変わっていました。一覧を読み直しました。',
    '招待の状態が変わっていました。一覧を読み直しました。',
  ),
  invitationRevokeNotFound: workspace(
    '招待が見つかりませんでした。一覧を読み直しました。',
    '招待が見つかりませんでした。一覧を読み直しました。',
  ),
  invitationRevokeFailed: workspace(
    '招待を取り消せませんでした。もう一度試してください。',
    '招待を取り消せませんでした。もう一度試してください。',
  ),
  // 「招待する」の節（リーダーと管理者）。ログインの手段は GitHub だけ（Google は #190 で足す）。
  // {organization} {admin} {workspace} は、その言葉づかいの言葉を画面が渡す
  inviteSectionTitle: workspace('招待する', '招待する'),
  inviteSeats: workspace('{organization}の人数 {used} / {limit} 人', '{organization}の人数 {used} / {limit} 人'),
  inviteViaLabel: workspace('ログインの手段', 'ログインの手段'),
  inviteGithubUserLabel: workspace('GitHub のユーザー名', 'GitHub のユーザー名'),
  inviteGithubUserExample: workspace('例: kotone-dev', '例: kotone-dev'),
  inviteGithubUserHint: workspace(
    'GitHub のユーザー ID に解決します。「確かめる」を押して、招待する人を見て確かめてから招待します。',
    'GitHub のユーザー ID に解決します。「確かめる」を押して、招待する人を見て確かめてから招待します。',
  ),
  inviteVerify: workspace('確かめる', '確かめる'),
  inviteVerifying: workspace('確かめています', '確かめています'),
  inviteVerifyLead: workspace(
    'この人を招待します。アバター、ユーザー名、表示名が、招待したい人のものか確かめてください。ユーザー名は 1 字違いでも別の人に当たります。',
    'この人を招待します。アバター、ユーザー名、表示名が、招待したい人のものか確かめてください。ユーザー名は 1 字違いでも別の人に当たります。',
  ),
  inviteNoDisplayName: workspace('表示名なし', '表示名なし'),
  inviteGithubId: workspace('GitHub のユーザー ID {id}', 'GitHub のユーザー ID {id}'),
  inviteSubmit: workspace('招待する', '招待する'),
  inviteSubmitting: workspace('招待しています', '招待しています'),
  // 続けて組織の URL を出す（長い URL を折り返せるよう、URL は別の要素にする）
  inviteSendNote: workspace(
    'Scrum Guild は招待をメールで送りません。次の{organization}の URL を本人に伝えてください。',
    'Scrum Guild は招待をメールで送りません。次の{organization}の URL を本人に伝えてください。',
  ),
  inviteDone: workspace('{name} を招待しました', '{name} を招待しました'),
  inviteLiveVerified: workspace('確かめました: {name}', '確かめました: {name}'),
  inviteLimitReached: workspace(
    '{organization}の人数が上限（{limit} 人）に達しているため、新しい人は招待できません。すでに{organization}にいる人は招待できます。上限を上げるには{admin}に相談してください。',
    '{organization}の人数が上限（{limit} 人）に達しているため、新しい人は招待できません。すでに{organization}にいる人は招待できます。上限を上げるには{admin}に相談してください。',
  ),
  inviteNotCountedAtLimit: workspace(
    'この人はまだ{organization}の人数に数えられていないため、上限に達している間は招待できません。',
    'この人はまだ{organization}の人数に数えられていないため、上限に達している間は招待できません。',
  ),
  inviteErrorUserRequired: workspace('ユーザー名を入れてください。', 'ユーザー名を入れてください。'),
  inviteErrorVerifyAgain: workspace(
    'ユーザー名を直したので、もう一度確かめてください。',
    'ユーザー名を直したので、もう一度確かめてください。',
  ),
  inviteErrorUserNotFound: workspace(
    'そのユーザー名の人が GitHub にいません。',
    'そのユーザー名の人が GitHub にいません。',
  ),
  inviteErrorNotUser: workspace(
    'GitHub の組織のアカウントなどで、個人のアカウントではありません。ログインできないので招待できません。',
    'GitHub の組織のアカウントなどで、個人のアカウントではありません。ログインできないので招待できません。',
  ),
  inviteErrorUserChanged: workspace(
    '確かめたあとに、ユーザー名の持ち主が変わりました。もう一度確かめてください。',
    '確かめたあとに、ユーザー名の持ち主が変わりました。もう一度確かめてください。',
  ),
  inviteErrorAlreadyMember: workspace(
    'この人は、もうこの{workspace}に所属しています。',
    'この人は、もうこの{workspace}に所属しています。',
  ),
  inviteErrorAlreadyInvited: workspace(
    'この人には、この{workspace}への承諾待ちの招待があります。',
    'この人には、この{workspace}への承諾待ちの招待があります。',
  ),
  inviteErrorClosed: workspace(
    '終了した{workspace}には招待できません。画面を読み直しました。',
    '終了した{workspace}には招待できません。画面を読み直しました。',
  ),
  inviteErrorForbidden: workspace(
    '招待できる権限がなくなっていました。画面を読み直しました。',
    '招待できる権限がなくなっていました。画面を読み直しました。',
  ),
  inviteErrorTooMany: workspace(
    '確かめる回数が多すぎます。しばらく待ってから、もう一度試してください。',
    '確かめる回数が多すぎます。しばらく待ってから、もう一度試してください。',
  ),
  inviteErrorTooManyInvites: workspace(
    '招待する回数が多すぎます。しばらく待ってから、もう一度試してください。',
    '招待する回数が多すぎます。しばらく待ってから、もう一度試してください。',
  ),
  inviteErrorGithubUnavailable: workspace(
    'GitHub に届きませんでした。しばらくしてから、もう一度試してください。',
    'GitHub に届きませんでした。しばらくしてから、もう一度試してください。',
  ),
  inviteErrorUnreachable: workspace('サーバーに届きませんでした。', 'サーバーに届きませんでした。'),
  inviteErrorVerifyFailed: workspace(
    'ユーザー名を確かめられませんでした。もう一度試してください。',
    'ユーザー名を確かめられませんでした。もう一度試してください。',
  ),
  inviteErrorFailed: workspace(
    '招待できませんでした。もう一度試してください。',
    '招待できませんでした。もう一度試してください。',
  ),
  // 招待の URL を開く画面（/invite）。組織の名前は、秘密を API に送る前なので出さない
  inviteTitle: organization('{app} への招待', '{app} への招待'),
  inviteLead: organization(
    '招待されたメールアドレスの Google アカウントでログインしてください。',
    '招待されたメールアドレスの Google アカウントでログインしてください。',
  ),
  inviteNote: organization(
    'ボタンを押すまでログインを始めません。すでにログインしていても、Google のアカウントでログインし直します。',
    'ボタンを押すまでログインを始めません。すでにログインしていても、Google のアカウントでログインし直します。',
  ),

  // テーマ
  themeLabel: organization('テーマ', 'テーマ'),
  themeSimple: organization('シンプル（自動）', 'シンプル（自動）'),
  themeSimpleLight: organization('シンプル（ライト）', 'シンプル（ライト）'),
  themeSimpleDark: organization('シンプル（ダーク）', 'シンプル（ダーク）'),
  themeMedieval: organization('中世風', '中世風'),
  themeModern: organization('現代風', '現代風'),

  // ワークスペースを終了する、再開する（組織の管理の画面。API の操作の名前は workspace-close と workspace-reopen のまま）。
  // {workspace} は、その言葉づかいの言葉を画面が渡す。{name} はワークスペースの名前
  workspaceActionsHeader: organization('操作', '操作'),
  workspaceCloseAction: organization('終了する', '終了する'),
  workspaceReopenAction: organization('再開する', '再開する'),
  workspaceCloseLabel: organization('「{name}」を終了する', '「{name}」を終了する'),
  workspaceReopenLabel: organization('「{name}」を再開する', '「{name}」を再開する'),
  workspaceCloseTitle: organization('「{name}」を終了しますか？', '「{name}」を終了しますか？'),
  workspaceCloseText: organization(
    '終了すると読み取り専用になり、中の書き込みはすべてできなくなります。この画面からいつでも再開できます。',
    '終了すると読み取り専用になり、中の書き込みはすべてできなくなります。この画面からいつでも再開できます。',
  ),
  workspaceClosing: organization('終了しています', '終了しています'),
  workspaceReopening: organization('再開しています', '再開しています'),
  workspaceClosed: organization('{workspace}を終了しました', '{workspace}を終了しました'),
  workspaceReopened: organization('{workspace}を再開しました', '{workspace}を再開しました'),
  workspaceCloseFailed: organization(
    '{workspace}を終了できませんでした。もう一度試してください。',
    '{workspace}を終了できませんでした。もう一度試してください。',
  ),
  workspaceReopenFailed: organization(
    '{workspace}を再開できませんでした。もう一度試してください。',
    '{workspace}を再開できませんでした。もう一度試してください。',
  ),
  // 別の画面で先に操作されていた（409）。終了した状態か再開した状態かは言い切らず、読み直した一覧を見てもらう
  workspaceStateChanged: organization(
    '「{name}」の状態が変わっていました。一覧で状態を確かめてください',
    '「{name}」の状態が変わっていました。一覧で状態を確かめてください',
  ),
  // 見つからない、または操作できない（404、403）
  workspaceUnavailable: organization(
    '「{name}」を操作できませんでした。見つからないか、操作できない状態です。一覧で状態を確かめてください',
    '「{name}」を操作できませんでした。見つからないか、操作できない状態です。一覧で状態を確かめてください',
  ),
  workspaceListRefreshFailed: organization(
    '{workspace}の一覧を更新できませんでした',
    '{workspace}の一覧を更新できませんでした',
  ),
  workspaceListLoadFailed: organization(
    '{workspace}の一覧を読み込めませんでした',
    '{workspace}の一覧を読み込めませんでした',
  ),

  // 終了したワークスペースの帯（ワークスペースの中の全画面）。{date} は終了した日、{page} は組織の管理の画面の名前
  workspaceClosedBanner: workspace(
    '{date} に終了しました。読み取り専用です。',
    '{date} に終了しました。読み取り専用です。',
  ),
  workspaceClosedBannerLink: organization('{page}で再開する', '{page}で再開する'),

  // タスクの詳細の引き出し
  drawerExpand: organization('広げる', '広げる'),
  drawerShrink: organization('横に戻す', '横に戻す'),
  taskManualChip: workspace('手で作った{task}', '手で作った{task}'),
  taskImportedChip: workspace('取り込んだ{task}', '取り込んだ{task}'),
  taskDrawerLoadFailed: workspace(
    'この{task}を読み込めませんでした。もう一度試してください。',
    'この{task}を読み込めませんでした。もう一度試してください。',
  ),
  // タイトルとリンクの値のボタンの、読み上げに添える文（押すと入力欄になる）
  taskTitleEditHint: workspace('（押して{task}のタイトルを直す）', '（押して{task}のタイトルを直す）'),
  linkEditHint: organization('（押してリンクを直す）', '（押してリンクを直す）'),
  linkAdd: organization('リンクを足す', 'リンクを足す'),
  linkEdit: organization('リンクを直す', 'リンクを直す'),
  editSave: organization('保存', '保存'),
  editCancel: organization('取り消し', '取り消し'),
  editBody: organization('編集', '編集'),
  bodyEmpty: organization('まだ書かれていません。', 'まだ書かれていません。'),
  bodyEditHint: organization(
    'Markdown で書けます。見出しは # が小見出しの大きさから始まります。',
    'Markdown で書けます。見出しは # が小見出しの大きさから始まります。',
  ),
  dueClear: organization('クリア', 'クリア'),
  // 完了したタスクのポイントは直せない（経験値とスプリントの集計が、完了の記録の値を使うため）
  taskPointsLocked: workspace('{done}した{task}の{points}は直せません', '{done}した{task}の{points}は直せません'),
  // 取り込んだタスクは、タイトルとリンクを直せず、削除でなくアーカイブで外す（取り込み元のキーと期限は、取り込みの Issue で足す）
  taskImportedNote: workspace(
    '取り込んだ{task}のタイトルは、ここでは直せません',
    '取り込んだ{task}のタイトルは、ここでは直せません',
  ),
  taskImportedLocked: workspace(
    '取り込んだ{task}のタイトルとリンクは直せません。',
    '取り込んだ{task}のタイトルとリンクは直せません。',
  ),
  taskImportedNoDelete: workspace(
    '取り込んだ{task}は削除せず、{archive}へ移して外します。',
    '取り込んだ{task}は削除せず、{archive}へ移して外します。',
  ),
  taskSaveRaced: organization(
    'ほかの人が同時に直したため、保存できませんでした。最新の内容を読み直したので、もう一度試してください。',
    'ほかの人が同時に直したため、保存できませんでした。最新の内容を読み直したので、もう一度試してください。',
  ),
  taskSaved: organization('保存しました', '保存しました'),
  taskSaving: organization('保存しています', '保存しています'),
  taskSaveFailed: organization(
    '保存できませんでした。もう一度試してください。',
    '保存できませんでした。もう一度試してください。',
  ),
  taskSaveConflict: workspace(
    'この{task}は{done}になっているため、{points}は直せません。',
    'この{task}は{done}になっているため、{points}は直せません。',
  ),
  taskBadRequest: organization(
    '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
    '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
  ),
  // 担当の選択（引き出しと起票のダイアログ）。候補は、そのワークスペースに今所属している人
  assigneeCandidatesFailed: workspace(
    '{assignee}の候補を読み込めませんでした',
    '{assignee}の候補を読み込めませんでした',
  ),
  assigneeNotMember: workspace(
    '選んだ人は、もうこの{workspace}にいません。{assignee}を選び直してください',
    '選んだ人は、もうこの{workspace}に所属していません。{assignee}を選び直してください',
  ),
  // 完了したタスクの担当は替えない（完了の経験値と完了の記録が、完了した時点の担当を使うため）
  taskAssigneeLocked: workspace(
    '{done}した{task}の{assignee}は替えられません',
    '{done}した{task}の{assignee}は替えられません',
  ),
  taskAssigneeDone: workspace(
    'この{task}は{done}になっているため、{assignee}は替えられません。',
    'この{task}は{done}になっているため、{assignee}は替えられません。',
  ),
  taskReadOnly: workspace(
    '終了した{workspace}の{task}は、読み取りだけできます',
    '終了した{workspace}の{task}は、読み取りだけできます',
  ),
  // 書きかけがあるまま閉じる（か別のタスクへ移る）ときの確認
  discardTitle: organization('書きかけを捨てますか', '書きかけを捨てますか'),
  discardText: organization(
    '保存していない変更があります。捨てると元に戻せません。',
    '保存していない変更があります。捨てると元に戻せません。',
  ),
  discardKeep: organization('書き続ける', '書き続ける'),
  discardConfirm: organization('捨てる', '捨てる'),
  // 削除
  taskDelete: workspace('この{task}を削除する', 'この{task}を削除する'),
  taskDeleteWho: workspace('削除できるのは作った人と{leader}です。', '削除できるのは作った人と{leader}です。'),
  taskDeleteTitle: workspace('{task}を削除する', '{task}を削除する'),
  taskDeleteText: workspace(
    '「{title}」を削除します。削除したものは画面から消え、この版では戻せません。',
    '「{title}」を削除します。削除したものは画面から消え、この版では戻せません。',
  ),
  taskDeleteHint: organization('完了の記録と経験値は残ります。', '完了の記録と経験値は残ります。'),
  taskDeleteConfirm: organization('削除する', '削除する'),
  taskDeleteCancel: organization('やめる', 'やめる'),
  taskDeleting: organization('削除しています', '削除しています'),
  taskDeleted: workspace('{task}を削除しました', '{task}を削除しました'),
  taskDeleteFailed: organization(
    '削除できませんでした。もう一度試してください。',
    '削除できませんでした。もう一度試してください。',
  ),
  taskDeleteForbidden: workspace('作った人と{leader}だけが削除できます', '作った人と{leader}だけが削除できます'),

  // Markdown の本文。変換が終わらなかった本文を、書かれたまま出すときの注記
  markdownPlainNote: workspace('整形せずに表示しています', '整形せずに表示しています'),
  // リンクは新しいタブで開く。リンクの補足（aria-describedby）として読み上げに伝える
  markdownNewTab: workspace('新しいタブで開きます', '新しいタブで開きます'),
  // 横にスクロールするコードと表の枠の名前。キーボードで枠にフォーカスを置いて動かすため、読み上げに名前を伝える
  markdownCodeRegion: workspace('コード', 'コード'),
  markdownTableRegion: workspace('表', '表'),
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
