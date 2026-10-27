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
  // {story} {task} は、その言葉づかいの言葉を画面が渡す。エピックの並べ替えは #308 で足す
  backlogOrderNote: workspace(
    '上にあるものほど優先します。{story}と{task}は、行の「上へ」「下へ」か、行の中にフォーカスを置いて Alt と ↑ ↓ で並べ替えます。',
    '上にあるものほど優先します。{story}と{task}は、行の「上へ」「下へ」か、行の中にフォーカスを置いて Alt と ↑ ↓ で並べ替えます。',
  ),
  // つまみのドラッグに触れる文。つまみを出さない狭い幅と指の画面では、この文も隠す（.drag-note）
  backlogDragNote: workspace(
    '行の先頭のつまみをドラッグしても並べ替えられます。',
    '行の先頭のつまみをドラッグしても並べ替えられます。',
  ),
  // 親なしの段が空のとき、行をつかんでいる間だけ出す落とし先
  dropSlotTask: workspace('親なしの{task}へ移す', '親なしの{task}へ移す'),
  dropSlotStory: workspace('親なしの{story}へ移す', '親なしの{story}へ移す'),
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
  // ドラッグで、親を変えて途中に入れたときの知らせ。移した先の親と、{index} 番目を伝える
  moveAnnouncedAtUnder: workspace(
    '「{title}」を{story}「{parent}」の {index} 番目に移しました',
    '「{title}」を{story}「{parent}」の {index} 番目に移しました',
  ),
  moveAnnouncedAtUnderEpic: workspace(
    '「{title}」を{epic}「{epicTitle}」の{story}「{parent}」の {index} 番目に移しました',
    '「{title}」を{epic}「{epicTitle}」の{story}「{parent}」の {index} 番目に移しました',
  ),
  moveAnnouncedAtRoot: workspace(
    '「{title}」を親なしの {index} 番目に移しました',
    '「{title}」を親なしの {index} 番目に移しました',
  ),
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
  // ストーリーの親（エピック）を移すときの、完了か中止したエピックの下へは移せない知らせ
  moveEpicDone: workspace(
    '{done}か中止した{epic}の下へは移せません。一覧を読み直します',
    '{done}か中止した{epic}の下へは移せません。一覧を読み直します',
  ),

  // エピックの行（木の最上段）。{title} はエピックの題
  epicCreate: workspace('{epic}を作る', '{epic}を作る'),
  epicCleared: workspace('クリア済み', '完了'),
  epicCanceled: workspace('中止', '中止'),
  epicNoStories: workspace('{story}はまだありません', '{story}はまだありません'),
  // エピックのダイアログ（作るときも直すときも同じ欄）。欄の文言はストーリーのダイアログと同じ項目を使う
  epicTitlePlaceholder: workspace('何を成し遂げるか', '何を成し遂げるか'),
  epicCreated: workspace('{epic}を作りました', '{epic}を作りました'),
  epicSaved: workspace('{epic}を保存しました', '{epic}を保存しました'),
  epicGone: workspace(
    'この{epic}は見つかりません。一覧を読み直します',
    'この{epic}は見つかりません。一覧を読み直します',
  ),
  epicReadOnly: workspace(
    '終了した{workspace}の{epic}は、読み取りだけできます',
    '終了した{workspace}の{epic}は、読み取りだけできます',
  ),
  epicLoadFailed: workspace(
    'この{epic}を読み込めませんでした。もう一度試してください。',
    'この{epic}を読み込めませんでした。もう一度試してください。',
  ),
  // エピックのダイアログ専用の文言（ストーリーのダイアログの文言を流用しない）
  epicTitleRequired: organization('タイトルを入れてください', 'タイトルを入れてください'),
  epicTitleTooLong: organization('タイトルは {max} 字までです', 'タイトルは {max} 字までです'),
  epicTitleInvalidCharacter: organization(
    'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
    'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  ),
  epicCreateSubmit: organization('作る', '作る'),
  epicCreating: organization('作っています', '作っています'),
  epicCreateFailed: organization(
    '作れませんでした。もう一度試してください。',
    '作れませんでした。もう一度試してください。',
  ),
  epicSave: organization('保存する', '保存する'),
  epicSaving: organization('保存しています', '保存しています'),
  epicSaveFailed: organization(
    '保存できませんでした。もう一度試してください。',
    '保存できませんでした。もう一度試してください。',
  ),
  // 画面の検査を通った後に、サーバーが 400 で断ったとき。どの欄かは分からない
  epicBadRequest: organization(
    '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
    '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
  ),
  epicLoading: organization('読み込んでいます', '読み込んでいます'),
  epicLinkOpen: organization('開く', '開く'),
  epicLinkOpenLabel: organization('リンクを新しいタブで開く', 'リンクを新しいタブで開く'),
  // 親の選択欄で、親のないストーリーをまとめる見出し
  parentRootGroup: workspace('親なしの{story}', '親なしの{story}'),
  // タスクを、エピックの下のストーリーへ移したときの知らせ。{epicTitle} は親のストーリーの親のエピックの題
  moveAnnouncedUnderEpic: workspace(
    '「{title}」を{epic}「{epicTitle}」の{story}「{parent}」の末尾へ移しました',
    '「{title}」を{epic}「{epicTitle}」の{story}「{parent}」の末尾へ移しました',
  ),

  // ストーリーの完了と取り消し。{title} はストーリーの題。同じ名前のボタンが並ぶので、読み上げの名前に題を添える
  storyCompleteLabel: workspace('{complete}: {title}', '{complete}: {title}'),
  // 配下に未完了のタスクが残っているあいだ、完了の操作の横に出す
  storyRemaining: workspace('残り {count} 件の{task}', '残り {count} 件の{task}'),
  // 押せない理由の全文。見えない文字で置き、完了の操作の aria-describedby から指す
  storyRemainingNote: workspace(
    '未完了の{task}が残っているあいだは{done}にできません',
    '未完了の{task}が残っているあいだは{done}にできません',
  ),
  // 親のエピックが完了か中止しているとき、「取り消す」の横に出す
  storyReopenBlocked: workspace(
    '{done}か中止した{epic}の下の{story}は取り消せません',
    '{done}か中止した{epic}の下の{story}は取り消せません',
  ),
  // 親のエピックが完了か中止しているとき、「完了にする」の横に出す（完了にすると取り消せなくなるため、断る）
  storyCompleteBlocked: workspace(
    '{done}か中止した{epic}の下の{story}は{done}にできません',
    '{done}か中止した{epic}の下の{story}は{done}にできません',
  ),
  storyReopen: organization('取り消す', '取り消す'),
  storyReopenLabel: workspace('{done}を取り消す: {title}', '{done}を取り消す: {title}'),
  storyCompleting: workspace('{done}にしています', '{done}にしています'),
  storyReopening: workspace('{done}を取り消しています', '{done}を取り消しています'),
  storyCompleted: workspace('{story}を{done}にしました', '{story}を{done}にしました'),
  storyReopened: workspace('{story}の{done}を取り消しました', '{story}の{done}を取り消しました'),
  storyOpenTasks: workspace(
    '未完了の{task}が残っているため、{done}にできません。一覧を読み直します',
    '未完了の{task}が残っているため、{done}にできません。一覧を読み直します',
  ),
  storyAlreadyDone: workspace(
    'この{story}は、すでに{done}です。一覧を読み直します',
    'この{story}は、すでに{done}です。一覧を読み直します',
  ),
  storyNotDone: workspace(
    'この{story}は{done}していません。一覧を読み直します',
    'この{story}は{done}していません。一覧を読み直します',
  ),
  storyCompleteParentDone: workspace(
    '{done}か中止した{epic}の下の{story}は、{done}にできません。一覧を読み直します',
    '{done}か中止した{epic}の下の{story}は、{done}にできません。一覧を読み直します',
  ),
  storyReopenParentDone: workspace(
    '{done}か中止した{epic}の下の{story}は、取り消せません。一覧を読み直します',
    '{done}か中止した{epic}の下の{story}は、取り消せません。一覧を読み直します',
  ),
  storyCompletionChanged: organization(
    'ほかの画面で変わったため、できませんでした。一覧を読み直します',
    'ほかの画面で変わったため、できませんでした。一覧を読み直します',
  ),
  storyCompleteFailed: workspace(
    '{done}にできませんでした。もう一度試してください。',
    '{done}にできませんでした。もう一度試してください。',
  ),
  storyReopenFailed: organization(
    '取り消せませんでした。もう一度試してください。',
    '取り消せませんでした。もう一度試してください。',
  ),

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
    '下の届いた招待から冒険者ギルドを選び、招待を承諾すると入れます。',
    '下の届いた招待から組織を選び、招待を承諾すると入れます。',
  ),
  invitationsHeading: organization('届いた招待', '届いた招待'),
  invitationPending: organization('承諾待ちの招待があります', '承諾待ちの招待があります'),
  invitationsNote: organization(
    'すべての冒険者ギルドに届いた招待を、冒険者ギルドごとにまとめて出します。押すと、承諾するか辞退するかを選べます。',
    'すべての組織に届いた招待を、組織ごとにまとめて出します。押すと、承諾するか辞退するかを選べます。',
  ),
  // 招待の画面（/<slug>/invitations と、組織に入れず招待だけがある人の組織の画面）。
  // {organization} は組織の名前、{workspace} はワークスペースの言葉、{name} はワークスペースの名前
  invitationInboxLead: organization(
    '{organization}から届いた招待です。承諾すると、その{workspace}に入れます。',
    '{organization}から届いた招待です。承諾すると、その{workspace}に入れます。',
  ),
  invitationInboxEmptyTitle: organization('承諾待ちの招待はありません', '承諾待ちの招待はありません'),
  invitationInboxEmptyText: organization(
    'この冒険者ギルドに届いた招待は、承諾か辞退が済んだか、取り消されました。',
    'この組織に届いた招待は、承諾か辞退が済んだか、取り消されました。',
  ),
  // {inviter} は招待した人の名前、{role} はロール、{date} は招待した日（YYYY-MM-DD）
  invitationInboxMeta: organization(
    '{organization}・{inviter}さんから・{role}・{date}',
    '{organization}・{inviter}さんから・{role}・{date}',
  ),
  invitationInboxClosed: organization(
    'この{workspace}は終了しているため、承諾できません。辞退はできます。',
    'この{workspace}は終了しているため、承諾できません。辞退はできます。',
  ),
  invitationAccept: organization('承諾する', '承諾する'),
  invitationDecline: organization('辞退する', '辞退する'),
  invitationAcceptLabel: organization('{name}への招待を承諾する', '{name}への招待を承諾する'),
  invitationDeclineLabel: organization('{name}への招待を辞退する', '{name}への招待を辞退する'),
  invitationAccepting: organization('招待を承諾しています', '招待を承諾しています'),
  invitationDeclining: organization('招待を辞退しています', '招待を辞退しています'),
  invitationDeclined: organization('招待を辞退しました', '招待を辞退しました'),
  invitationErrorNotFound: organization(
    '招待が見つかりませんでした。取り消されたか、別のアカウントに宛てた招待です。',
    '招待が見つかりませんでした。取り消されたか、別のアカウントに宛てた招待です。',
  ),
  invitationErrorChanged: organization(
    '招待の状態が変わっていました。取り消されたか、承諾か辞退が済んでいます。',
    '招待の状態が変わっていました。取り消されたか、承諾か辞退が済んでいます。',
  ),
  invitationErrorClosed: organization(
    'この{workspace}は終了したため、承諾できませんでした。',
    'この{workspace}は終了したため、承諾できませんでした。',
  ),
  invitationErrorAlreadyMember: organization(
    'もうこの{workspace}に所属しています。',
    'もうこの{workspace}に所属しています。',
  ),
  invitationErrorUnreachable: organization(
    '通信できませんでした。時間をおいてもう一度試してください。',
    '通信できませんでした。時間をおいてもう一度試してください。',
  ),
  invitationErrorFailed: organization(
    '招待を処理できませんでした。時間をおいてもう一度試してください。',
    '招待を処理できませんでした。時間をおいてもう一度試してください。',
  ),
  // 組織に入れる人が招待の画面から組織の画面へ戻るリンク。組織の名前は入れない（区切りの無い長い名前で、狭い幅からはみ出さないように）
  invitationInboxBack: organization('冒険者ギルドの画面へ戻る', '組織の画面へ戻る'),
  invitationAccepted: organization('招待を承諾しました', '招待を承諾しました'),
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
    '運用者は{organization}の中（タスク、メンバー、記録、添付ファイルの中身など）を見られません。ここに出すのは名前、slug、状態と、数、上限、日時だけです。',
    '運用者は{organization}の中（タスク、メンバー、記録、添付ファイルの中身など）を見られません。ここに出すのは名前、slug、状態と、数、上限、日時だけです。',
  ),
  operatorEmptyTitle: organization('{organization}がまだありません', '{organization}がまだありません'),
  operatorEmptyText: organization(
    '{organization}を作り、最初の{admin}を指名してください。',
    '{organization}を作り、最初の{admin}を指名してください。',
  ),
  operatorCreate: organization('{organization}を作る', '{organization}を作る'),
  operatorColumnOrganization: organization('{organization}・slug', '{organization}・slug'),
  // 組織ごとの集計の列。{workspace} {task} は辞書の同じ名前の項目で埋める
  operatorColumnSeats: organization('人数 / 上限', '人数 / 上限'),
  operatorColumnWorkspaces: organization('{workspace}の数', '{workspace}の数'),
  operatorColumnTasks: organization('{task}の数', '{task}の数'),
  operatorColumnQuota: organization('添付ファイルの上限', '添付ファイルの上限'),
  operatorColumnLastUsed: organization('最後に使われた日時', '最後に使われた日時'),
  // {used} は人数、{limit} は人数の上限。空白は不可分の空白（U+00A0）で、積んだ行でも数の間で割れない
  operatorSeats: organization('{used} / {limit}', '{used} / {limit}'),
  operatorSeatsFull: organization('上限に達した', '上限に達した'),
  // {size} は GB か MB の数（1 GB 未満は MB。src/lib/format.ts の quotaSize）。空白は不可分の空白
  operatorQuotaSize: organization('{size} GB', '{size} GB'),
  operatorQuotaSizeMb: organization('{size} MB', '{size} MB'),
  // 名前の列の2行目。{slug} は組織の slug、{date} は作った日時（ブラウザのタイムゾーン。format-datetime.ts）
  operatorCreatedLabel: organization('作成', '作成'),
  operatorNeverUsed: organization('まだ使われていない', 'まだ使われていない'),
  // 一覧の印。{date} は停止した日と、解約で消す予定日。どちらも UTC の日付（消す予定日を UTC の日付で数えるのにそろえる）
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
  // 開いた直後は今の理由が選ばれていて「変える」を押せないので、その理由と次にできることを伝える
  operatorChangeUnchangedHint: organization(
    '今の理由です。別の理由を選ぶと変えられます。',
    '今の理由です。別の理由を選ぶと変えられます。',
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
  // ロールは、リーダーと管理者には選択欄で、一般のメンバーには文字で出す。
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
  // 所属している人の行の操作。ロールの付け替えと「外す」はリーダーと管理者に、「抜ける」は自分の行に出す。
  // {name} は人の名前、{role} はロールの名前、{workspaceName} は開いているワークスペースの名前、
  // {task} {workspace} {organization} {leader} {admin} は、その言葉づかいの言葉を画面が渡す
  memberActionsHeader: workspace('操作', '操作'),
  memberRoleLabel: workspace('{name}のロール', '{name}のロール'),
  memberRemove: workspace('外す', '外す'),
  memberRemoveLabel: workspace('{name}を外す', '{name}を外す'),
  memberLeave: workspace('抜ける', '抜ける'),
  memberLeaveLabel: workspace('{workspaceName}から抜ける', '{workspaceName}から抜ける'),
  membersActionNote: workspace(
    '外すと、その人の未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。',
    '外すと、その人の未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。',
  ),
  memberWorking: workspace('{member}を更新しています', '{member}を更新しています'),
  memberRemoveTitle: workspace('{name}を外しますか', '{name}を外しますか'),
  memberRemoveText: workspace(
    '{name}は{workspace}から外れます。担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻すには、もう一度招待します。',
    '{name}は{workspace}から外れます。担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻すには、もう一度招待します。',
  ),
  memberLeaveTitle: workspace('{workspaceName}から抜けますか', '{workspaceName}から抜けますか'),
  memberLeaveText: workspace(
    '担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻るには、もう一度招待を受けてください。',
    '担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻るには、もう一度招待を受けてください。',
  ),
  // 管理者でなく、ほかに所属するワークスペースが無い人が抜けるとき
  memberLeaveLastText: workspace(
    'ほかに所属している{workspace}が無いので、抜けると、この{organization}に入れなくなります。担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻るには、もう一度招待を受けてください。',
    'ほかに所属している{workspace}が無いので、抜けると、この{organization}に入れなくなります。担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻るには、もう一度招待を受けてください。',
  ),
  memberDemoteTitle: workspace('自分を一般に戻しますか', '自分を一般に戻しますか'),
  memberDemoteText: workspace(
    '一般に戻すと、ロールの付け替え、招待、{member}を外すことができなくなります。{leader}に戻るには、ほかの{leader}か{admin}に頼んでください。',
    '一般に戻すと、ロールの付け替え、招待、{member}を外すことができなくなります。{leader}に戻るには、ほかの{leader}か{admin}に頼んでください。',
  ),
  memberDemoteConfirm: workspace('一般に戻す', '一般に戻す'),
  // 他人の唯一のリーダーを一般に戻すとき（続けて memberLastLeaderNote を添える）
  memberDemoteOtherTitle: workspace('{name}を一般に戻しますか', '{name}を一般に戻しますか'),
  memberDemoteOtherText: workspace(
    '{name}は一般に戻り、ロールの付け替え、招待、{member}を外すことができなくなります。',
    '{name}は一般に戻り、ロールの付け替え、招待、{member}を外すことができなくなります。',
  ),
  memberRoleChanged: workspace('{name}を{role}にしました', '{name}を{role}にしました'),
  memberRemoved: workspace('{name}を外しました', '{name}を外しました'),
  memberLeft: workspace('{workspaceName}から抜けました', '{workspaceName}から抜けました'),
  // 唯一のリーダーが抜ける、外される、自分を一般に戻すときに、確かめのダイアログへ添える
  memberLastLeaderNote: workspace(
    'この{workspace}の{leader}がいなくなります。新しい{leader}は{admin}が任命します。',
    'この{workspace}の{leader}がいなくなります。新しい{leader}は{admin}が任命します。',
  ),
  memberErrorClosed: workspace(
    '終了した{workspace}の{member}は変えられません。画面を読み直しました。',
    '終了した{workspace}の{member}は変えられません。画面を読み直しました。',
  ),
  memberErrorForbidden: workspace(
    'この操作ができるのは{leader}と{admin}だけです。画面を読み直しました。',
    'この操作ができるのは{leader}と{admin}だけです。画面を読み直しました。',
  ),
  memberErrorChanged: workspace(
    '{member}のロールが先に変わっていました。一覧を読み直しました。',
    '{member}のロールが先に変わっていました。一覧を読み直しました。',
  ),
  memberErrorNotFound: workspace(
    'その人はもう所属していませんでした。一覧を読み直しました。',
    'その人はもう所属していませんでした。一覧を読み直しました。',
  ),
  memberRoleFailed: workspace(
    'ロールを付け替えられませんでした。もう一度試してください。',
    'ロールを付け替えられませんでした。もう一度試してください。',
  ),
  memberRemoveFailed: workspace(
    'メンバーを外せませんでした。もう一度試してください。',
    'メンバーを外せませんでした。もう一度試してください。',
  ),
  memberLeaveFailed: workspace(
    '{workspace}から抜けられませんでした。もう一度試してください。',
    '{workspace}から抜けられませんでした。もう一度試してください。',
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
  // テーマの説明。見本の design/kit.js の THEME_NOTE と同じ文（src/shared/theme.ts の themeNoteKeys）
  themeNoteSimple: organization(
    '業務の道具として落ち着いた見た目。OS のライトとダークに合わせる',
    '業務の道具として落ち着いた見た目。OS のライトとダークに合わせる',
  ),
  themeNoteSimpleLight: organization(
    '業務の道具として落ち着いた見た目。いつも明るい地',
    '業務の道具として落ち着いた見た目。いつも明るい地',
  ),
  themeNoteSimpleDark: organization(
    '業務の道具として落ち着いた見た目。いつも暗い地',
    '業務の道具として落ち着いた見た目。いつも暗い地',
  ),
  themeNoteMedieval: organization(
    '冒険者ギルドの帳簿。紙と墨、完了に朱の判子',
    '冒険者ギルドの帳簿。紙と墨、完了に朱の判子',
  ),
  themeNoteModern: organization(
    'ハンターに届くシステムのウィンドウ。暗い地に光る枠',
    'ハンターに届くシステムのウィンドウ。暗い地に光る枠',
  ),

  // 組織の言葉づかいと既定のテーマ（組織の管理の画面）。{workspace} と {leader} は、その言葉づかいの言葉を画面が渡す。
  // 言葉づかいの選択肢の例（orgVocabularyNote）は、その言葉づかいの {organization} と {admin} を画面が渡す
  orgVocabularyTitle: organization('{workspace}の外の言葉づかい', '{workspace}の外の言葉づかい'),
  orgVocabularyDesc: organization(
    '「冒険者ギルド」「ギルドマスター」などの言葉。{workspace}の中の言葉づかいは、それぞれの{leader}が決めます。',
    '「組織」「管理者」などの言葉。{workspace}の中の言葉づかいは、それぞれの{leader}が決めます。',
  ),
  orgVocabularyNote: organization('{organization}、{admin}', '{organization}、{admin}'),
  orgThemeTitle: organization('既定のテーマ', '既定のテーマ'),
  orgThemeDesc: organization(
    '画面の見た目の既定。自分で選んでいないユーザーに効きます。会社で使うならシンプルが無難です。',
    '画面の見た目の既定。自分で選んでいないユーザーに効きます。会社で使うならシンプルが無難です。',
  ),
  // 節ごとの「保存する」。選んだ値が今の値と違うときだけ押せる
  orgSettingsSave: organization('保存する', '保存する'),
  orgSettingsSaving: organization('保存しています', '保存しています'),
  orgVocabularyChanged: organization('言葉づかいを「{label}」に変えました', '言葉づかいを「{label}」に変えました'),
  orgThemeChanged: organization('既定のテーマを「{label}」に変えました', '既定のテーマを「{label}」に変えました'),
  // ほかの管理者が先に同じ項目を変えていた（409）。読み直した値を見てもらう
  orgSettingsConflict: organization(
    'ほかの{admin}が先に変えていました。今の値を読み直したので、確かめてから選び直してください',
    'ほかの{admin}が先に変えていました。今の値を読み直したので、確かめてから選び直してください',
  ),
  // 見つからない、または操作できない（404、403。管理者でなくなったなど）。読み直した画面を見てもらう
  orgSettingsUnavailable: organization(
    '保存できませんでした。操作できない状態です。画面を読み直しました。',
    '保存できませんでした。操作できない状態です。画面を読み直しました。',
  ),
  // 通信の失敗と 5xx。選んだ値は残すので、そのまま押し直せる
  orgSettingsFailed: organization(
    '保存できませんでした。もう一度「保存する」を押してください。',
    '保存できませんでした。もう一度「保存する」を押してください。',
  ),

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

  // 組織の休日（組織の管理の画面）。{workspace} と {capacity} は、その言葉づかいの言葉を画面が渡す。
  // {date} は休日の日付（YYYY-MM-DD）、{line} は貼り付けた行の番号、{text} はその行、{max} は上限
  holidaysTitle: organization('組織の休日', '組織の休日'),
  holidaysDesc: organization(
    '祝日など、すべての{workspace}に効く休日。日付の一覧を貼り付けて、まとめて登録できます。',
    '祝日など、すべての{workspace}に効く休日。日付の一覧を貼り付けて、まとめて登録できます。',
  ),
  holidayPasteLabel: organization('貼り付けて登録', '貼り付けて登録'),
  holidayPastePlaceholder: organization(
    '2027-02-11 建国記念の日\n2027-02-23 天皇誕生日',
    '2027-02-11 建国記念の日\n2027-02-23 天皇誕生日',
  ),
  holidayPasteHint: organization(
    '1行に1日。日付（2026-11-03 か 2026/11/3、2000〜2099 年）のあとに、空白、タブ、カンマで区切って名前を書けます。表計算から写した行は、名前より後の列を読みません。登録済みの日付は飛ばします。',
    '1行に1日。日付（2026-11-03 か 2026/11/3、2000〜2099 年）のあとに、空白、タブ、カンマで区切って名前を書けます。表計算から写した行は、名前より後の列を読みません。登録済みの日付は飛ばします。',
  ),
  holidaySubmit: organization('登録する', '登録する'),
  holidaySubmitting: organization('登録しています', '登録しています'),
  holidayAdded: organization('{added} 日を登録しました', '{added} 日を登録しました'),
  holidayAddedWithSkipped: organization(
    '{added} 日を登録しました（{skipped} 日は登録済み）',
    '{added} 日を登録しました（{skipped} 日は登録済み）',
  ),
  holidayNothingToAdd: organization(
    '登録できる行がありません。1行に1日、日付から書いてください。',
    '登録できる行がありません。1行に1日、日付から書いてください。',
  ),
  holidayTooMany: organization(
    '登録できる行が {count} 日あります。1回に登録できるのは {max} 日までです。分けて登録してください。',
    '登録できる行が {count} 日あります。1回に登録できるのは {max} 日までです。分けて登録してください。',
  ),
  holidayAddFailed: organization(
    '登録できませんでした。もう一度試してください。',
    '登録できませんでした。もう一度試してください。',
  ),
  // 画面の解析と API の検証は同じ決まりなので、ふつうは起きない（400）
  holidayAddRejected: organization(
    '登録できない行がありました。日付と名前を確かめてください。',
    '登録できない行がありました。日付と名前を確かめてください。',
  ),
  holidayProblemsLabel: organization('登録しない行', '登録しない行'),
  // 理由の要約。読み上げ（role="alert"）にはこの文だけを入れ、行ごとの理由は入れない
  holidayProblemsSummary: organization(
    '{count} 行を登録しません。直して、もう一度「登録する」を押してください。',
    '{count} 行を登録しません。直して、もう一度「登録する」を押してください。',
  ),
  // 理由の一覧に出しきれない行の数
  holidayProblemsMore: organization('ほか {count} 行', 'ほか {count} 行'),
  holidayProblemLine: organization('{line} 行目「{text}」: {reason}', '{line} 行目「{text}」: {reason}'),
  holidayProblemInvalidDate: organization(
    '日付の形ではありません（2026-11-03 か 2026/11/3）',
    '日付の形ではありません（2026-11-03 か 2026/11/3）',
  ),
  holidayProblemNoSuchDate: organization('暦に無い日付です', '暦に無い日付です'),
  holidayProblemOutOfRange: organization(
    '{first}〜{last} 年の日付だけを登録できます',
    '{first}〜{last} 年の日付だけを登録できます',
  ),
  holidayProblemTooLong: organization('名前は {max} 字までです', '名前は {max} 字までです'),
  holidayProblemInvalidCharacter: organization(
    '名前に使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
    '名前に使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  ),
  holidayProblemDuplicate: organization('同じ日付が前の行にあります', '同じ日付が前の行にあります'),
  holidayListLabel: organization('登録した休日', '登録した休日'),
  holidayEmptyTitle: organization('まだ休日がありません', 'まだ休日がありません'),
  holidayEmptyText: organization(
    '登録した日は、{capacity}の計算で全員が稼働しない日になります。',
    '登録した日は、{capacity}の計算で全員が稼働しない日になります。',
  ),
  holidayDeleteLabel: organization('{date} を消す', '{date} を消す'),
  holidayDeleting: organization('消しています', '消しています'),
  holidayDeleted: organization('{date} を消しました', '{date} を消しました'),
  holidayDeletedWithName: organization('{date}（{name}）を消しました', '{date}（{name}）を消しました'),
  // 別の画面で先に消されていた（404）
  holidayAlreadyDeleted: organization(
    '{date} は見つかりませんでした。一覧を確かめてください',
    '{date} は見つかりませんでした。一覧を確かめてください',
  ),
  holidayDeleteFailed: organization(
    '{date} を消せませんでした。もう一度試してください。',
    '{date} を消せませんでした。もう一度試してください。',
  ),
  holidayListLoadFailed: organization('休日の一覧を読み込めませんでした', '休日の一覧を読み込めませんでした'),
  holidayListRefreshFailed: organization('休日の一覧を更新できませんでした', '休日の一覧を更新できませんでした'),

  // 組織の変更の履歴（組織の管理の画面）。{organization}、{admin}、{workspace}、{member} は、その言葉づかいの言葉を画面が渡す。
  // 内容の文は organization-history の種類ごとに1つ。{name} は人か組織かワークスペースの名前、{date} は消す予定日（YYYY-MM-DD）
  orgHistoryTitle: organization('変更の履歴', '変更の履歴'),
  orgHistoryDesc: organization(
    '{admin}の指名、運用者の操作、{workspace}の作成と終了など、{organization}の単位の変更を新しい順に出します。{workspace}の中の変更（{member}の所属など）は出しません。',
    '{admin}の指名、運用者の操作、{workspace}の作成と終了など、{organization}の単位の変更を新しい順に出します。{workspace}の中の変更（{member}の所属など）は出しません。',
  ),
  orgHistoryListLabel: organization('{organization}の変更の履歴', '{organization}の変更の履歴'),
  orgHistoryColumnAt: organization('日時', '日時'),
  orgHistoryColumnActor: organization('した人', 'した人'),
  orgHistoryColumnEvent: organization('内容', '内容'),
  orgHistoryActorOperator: organization('運用者', '運用者'),
  orgHistoryActorSystem: organization('自動の処理', '自動の処理'),
  // 人の行が無い（まとめて消えた）か、まだ名前の分からない人
  orgHistoryUnknownPerson: organization('名前の分からない人', '名前の分からない人'),
  orgHistoryOrganizationCreated: organization(
    '{organization}「{name}」を作りました',
    '{organization}「{name}」を作りました',
  ),
  orgHistoryOrganizationCreatedNoName: organization('{organization}を作りました', '{organization}を作りました'),
  orgHistoryOrganizationSuspended: organization(
    '{organization}を停止しました（消す予定日 {date}）',
    '{organization}を停止しました（消す予定日 {date}）',
  ),
  orgHistoryOrganizationSuspendedTemporary: organization(
    '{organization}を一時的に停止しました',
    '{organization}を一時的に停止しました',
  ),
  orgHistoryOrganizationResumed: organization('{organization}を再開しました', '{organization}を再開しました'),
  orgHistorySuspensionChanged: organization(
    '停止の理由を解約に切り替えました（消す予定日 {date}）',
    '停止の理由を解約に切り替えました（消す予定日 {date}）',
  ),
  orgHistorySuspensionChangedTemporary: organization(
    '停止の理由を一時的な停止に切り替えました',
    '停止の理由を一時的な停止に切り替えました',
  ),
  orgHistoryOrganizationSettingsChanged: organization(
    '{organization}の設定を変更しました',
    '{organization}の設定を変更しました',
  ),
  orgHistoryAdminDesignated: organization('{name}を{admin}に指名しました', '{name}を{admin}に指名しました'),
  // Google の招待で指名し、本人がまだログインしていない（名前はメールアドレスなので出さない）
  orgHistoryAdminDesignatedGoogle: organization(
    'Google で招待した人を{admin}に指名しました',
    'Google で招待した人を{admin}に指名しました',
  ),
  orgHistoryAdminLoginLinked: organization(
    '{name}が Google でログインし、{admin}の指名を受けました',
    '{name}が Google でログインし、{admin}の指名を受けました',
  ),
  orgHistoryAdminDesignationMerged: organization(
    'Google の招待で、{name}を{admin}にしました',
    'Google の招待で、{name}を{admin}にしました',
  ),
  orgHistoryAdminRevoked: organization('{name}の{admin}を解除しました', '{name}の{admin}を解除しました'),
  orgHistoryUserDisabled: organization('{name}を無効にしました', '{name}を無効にしました'),
  orgHistoryUserEnabled: organization('{name}を有効に戻しました', '{name}を有効に戻しました'),
  orgHistoryWorkspaceCreated: organization('{workspace}「{name}」を作りました', '{workspace}「{name}」を作りました'),
  orgHistoryWorkspaceCreatedNoName: organization('{workspace}を作りました', '{workspace}を作りました'),
  orgHistoryWorkspaceClosed: organization('{workspace}「{name}」を終了しました', '{workspace}「{name}」を終了しました'),
  orgHistoryWorkspaceReopened: organization(
    '{workspace}「{name}」を再開しました',
    '{workspace}「{name}」を再開しました',
  ),
  // ワークスペースの行が無く、名前の分からない終了と再開
  orgHistoryWorkspaceClosedNoName: organization('{workspace}を終了しました', '{workspace}を終了しました'),
  orgHistoryWorkspaceReopenedNoName: organization('{workspace}を再開しました', '{workspace}を再開しました'),
  // 知らない組（entity_type と action）
  orgHistoryOther: organization('{organization}を変更しました', '{organization}を変更しました'),
  orgHistoryEmptyTitle: organization('まだ変更の履歴がありません', 'まだ変更の履歴がありません'),
  orgHistoryEmptyText: organization(
    '{admin}の指名や{workspace}の作成をすると、ここに残ります。',
    '{admin}の指名や{workspace}の作成をすると、ここに残ります。',
  ),
  orgHistoryMore: organization('古い履歴を読む', '古い履歴を読む'),
  // 「古い履歴を読む」で足した件数。読み上げに伝える
  orgHistoryLoadedMore: organization('{count} 件を読みました', '{count} 件を読みました'),
  orgHistoryMoreFailed: organization(
    '続きを読み込めませんでした。もう一度試してください。',
    '続きを読み込めませんでした。もう一度試してください。',
  ),
  // 「古い履歴を読む」で最後まで読んだ（ボタンが消えるので、ここへフォーカスを移す）
  orgHistoryEnd: organization('これより前の履歴はありません', 'これより前の履歴はありません'),
  orgHistoryLoadFailed: organization('変更の履歴を読み込めませんでした', '変更の履歴を読み込めませんでした'),
  orgHistoryRefreshFailed: organization('変更の履歴を更新できませんでした', '変更の履歴を更新できませんでした'),

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
  // エピックとストーリーの削除（ダイアログの下のボタンと、配下の扱いを選ぶ確認。TreeDeleteDialog）。
  // 削除できる人、確認の本文と結び、送っている間、失敗の文はタスクの削除と同じ言葉を使う
  epicDelete: workspace('この{epic}を削除する', 'この{epic}を削除する'),
  storyDelete: workspace('この{story}を削除する', 'この{story}を削除する'),
  epicDeleteTitle: workspace('{epic}を削除する', '{epic}を削除する'),
  storyDeleteTitle: workspace('{story}を削除する', '{story}を削除する'),
  treeDeleteChildren: organization('配下の扱い', '配下の扱い'),
  treeDeleteKeep: organization('配下を親なしで残す', '配下を親なしで残す'),
  treeDeleteAll: organization('配下もまとめて削除する', '配下もまとめて削除する'),
  // 言葉と数、数と「件」の間は改行させない空白（U+00A0）
  epicDeleteKeepHint: workspace(
    '{story} {stories} 件は親なしの{story}として末尾へ移り、その下の{task} {tasks} 件は{story}の下のままです。{category}は{epic}の{category}を写します。',
    '{story} {stories} 件は親なしの{story}として末尾へ移り、その下の{task} {tasks} 件は{story}の下のままです。{category}は{epic}の{category}を写します。',
  ),
  epicDeleteAllHint: workspace(
    '{story} {stories} 件と{task} {tasks} 件を削除します。取り込んだ{task}は削除せず、{archive}へ移します。',
    '{story} {stories} 件と{task} {tasks} 件を削除します。取り込んだ{task}は削除せず、{archive}へ移します。',
  ),
  storyDeleteKeepHint: workspace(
    '{task} {tasks} 件は親なしの{task}として末尾へ移ります。{category}は{story}の{category}を写します。',
    '{task} {tasks} 件は親なしの{task}として末尾へ移ります。{category}は{story}の{category}を写します。',
  ),
  storyDeleteAllHint: workspace(
    '{task} {tasks} 件を削除します。取り込んだ{task}は削除せず、{archive}へ移します。',
    '{task} {tasks} 件を削除します。取り込んだ{task}は削除せず、{archive}へ移します。',
  ),
  treeDeleteAllLeaderOnly: workspace(
    '配下に他の人が作ったものがあるため、まとめて削除できるのは{leader}だけです。',
    '配下に他の人が作ったものがあるため、まとめて削除できるのは{leader}だけです。',
  ),
  epicDeleteNoChildren: workspace('配下の{story}はありません。', '配下の{story}はありません。'),
  storyDeleteNoChildren: workspace('配下の{task}はありません。', '配下の{task}はありません。'),
  epicDeleted: workspace('{epic}を削除しました', '{epic}を削除しました'),
  storyDeleted: workspace('{story}を削除しました', '{story}を削除しました'),
  // 変更の履歴（引き出しの「変更の履歴」の節。src/lib/task-history.ts が列の名前と値を文にする）
  historyTitle: workspace('変更の履歴', '変更の履歴'),
  historyEmpty: workspace('まだ変更はありません。', 'まだ変更はありません。'),
  historyLoadFailed: workspace('変更の履歴を読み込めませんでした。', '変更の履歴を読み込めませんでした。'),
  historyMore: workspace('さらに読む', 'さらに読む'),
  historyMoreFailed: workspace(
    '続きを読み込めませんでした。もう一度試してください。',
    '続きを読み込めませんでした。もう一度試してください。',
  ),
  // 変えた人のいない行（同期などの定期処理と、運用者の操作）
  historyActorSystem: workspace('定期処理か運用者', '定期処理か運用者'),
  historyCreated: workspace('依頼を出した', '作成した'),
  historyUpdated: workspace('書き換えた', '変更した'),
  historyCompleted: workspace('{done}にした', '{done}にした'),
  historyDeleted: workspace('削除した', '削除した'),
  historyChange: workspace('{before} → {after}', '{before} → {after}'),
  historyFieldEdited: workspace('{field}を直した', '{field}を直した'),
  historyNone: workspace('なし', 'なし'),
  historyFieldOther: workspace('そのほかの欄', 'そのほかの欄'),
  historyFieldParent: workspace('親の{story}', '親の{story}'),
  // 名前が空の人、区分、親（読めなかった名前）
  historyUnknownName: workspace('不明', '不明'),
  // 「さらに読む」で行を足したことを、読み上げに伝える
  historyMoreAdded: workspace('{count} 件を足しました', '{count} 件を足しました'),
  // 保存した後の読み直しに失敗したとき。前に読めた行は残し、節の上に添える
  historyReloadFailed: workspace(
    '最新の変更の履歴を読み込めませんでした。',
    '最新の変更の履歴を読み込めませんでした。',
  ),

  // コメント（引き出しの「コメント N」のタブ。src/lib/components/TaskComments.svelte）。N は消していないコメントの数
  drawerTabs: workspace('コメントと変更の履歴', 'コメントと変更の履歴'),
  commentsTab: workspace('コメント {count}', 'コメント {count}'),
  commentEmpty: workspace('まだコメントはありません。', 'まだコメントはありません。'),
  commentLoadFailed: workspace('コメントを読み込めませんでした。', 'コメントを読み込めませんでした。'),
  commentReloadFailed: workspace('最新のコメントを読み込めませんでした。', '最新のコメントを読み込めませんでした。'),
  commentOlder: workspace('前のコメントを読む', '前のコメントを読む'),
  commentOlderFailed: workspace(
    '前のコメントを読み込めませんでした。もう一度試してください。',
    '前のコメントを読み込めませんでした。もう一度試してください。',
  ),
  // 「前のコメントを読む」で足したことを、読み上げに伝える
  commentOlderAdded: workspace('前のコメントを {count} 件足しました', '前のコメントを {count} 件足しました'),
  commentEdited: workspace('編集済み', '編集済み'),
  commentEdit: workspace('編集', '編集'),
  commentDelete: workspace('削除', '削除'),
  commentEditLabel: workspace('コメントを直す', 'コメントを直す'),
  // 消したコメント。本人が消したら「削除されました」だけ、本人以外（{leader}）が消したら消した人の名前を添える
  commentDeleted: workspace('削除されました', '削除されました'),
  commentDeletedBy: workspace('{name}が削除しました', '{name}が削除しました'),
  commentNewLabel: workspace('コメントを書く', 'コメントを書く'),
  commentPlaceholder: workspace('Markdown で書けます', 'Markdown で書けます'),
  commentSend: workspace('送る', '送る'),
  commentSending: workspace('コメントを送っています', 'コメントを送っています'),
  commentSaving: workspace('コメントを保存しています', 'コメントを保存しています'),
  commentDeleting: workspace('コメントを削除しています', 'コメントを削除しています'),
  commentField: workspace('コメント', 'コメント'),
  commentRequired: workspace('コメントを書いてから送ってください', 'コメントを書いてから送ってください'),
  commentSent: workspace('コメントを送りました', 'コメントを送りました'),
  commentSaved: workspace('コメントを直しました', 'コメントを直しました'),
  commentRemoved: workspace('コメントを削除しました', 'コメントを削除しました'),
  commentSendFailed: workspace(
    'コメントを送れませんでした。書いた文は残しています。もう一度試してください。',
    'コメントを送れませんでした。書いた文は残しています。もう一度試してください。',
  ),
  commentSaveFailed: workspace(
    'コメントを保存できませんでした。書いた文は残しています。もう一度試してください。',
    'コメントを保存できませんでした。書いた文は残しています。もう一度試してください。',
  ),
  commentDeleteFailed: workspace(
    'コメントを削除できませんでした。もう一度試してください。',
    'コメントを削除できませんでした。もう一度試してください。',
  ),
  // 直している間に、ほかの人（{leader}）がそのコメントを消した。書きかけは欄に残し、一覧を読み直す
  commentGoneWhileEditing: workspace(
    'このコメントは削除されました。書きかけの文は欄に残しています。',
    'このコメントは削除されました。書きかけの文は欄に残しています。',
  ),
  commentAlreadyDeleted: workspace('このコメントはすでに削除されています', 'このコメントはすでに削除されています'),
  // 権限が無かった（ロールが替わったなど）。一覧を読み直して、出せる操作を出し直す
  commentForbidden: workspace(
    'このコメントは操作できません。一覧を読み直しました。',
    'このコメントは操作できません。一覧を読み直しました。',
  ),
  commentDeleteTitle: workspace('コメントを削除する', 'コメントを削除する'),
  // {name} は書いた人、{at} は書いた日時（ワークスペースのタイムゾーンの YYYY-MM-DD HH:mm）
  commentDeleteText: workspace(
    '{name}が {at} に書いたコメントを削除します。本文は戻せません。一覧には「削除されました」と残ります。',
    '{name}が {at} に書いたコメントを削除します。本文は戻せません。一覧には「削除されました」と残ります。',
  ),
  // フォーカスを置いたときに読む、コメントの一覧と欄の領域の名前
  commentThread: workspace('コメントの一覧', 'コメントの一覧'),
  // 書きかけのまま書き込めなくなった（終了した）。欄は読み取り専用で残し、写せるようにする
  commentDraftReadOnly: workspace(
    '終了した{workspace}には送れません。書きかけの文は写して残せます。',
    '終了した{workspace}には送れません。書きかけの文は写して残せます。',
  ),

  // 計画の画面（design/plan.html）と、スプリントの作成と変更のダイアログ（kit.js の sprintCreate）
  planPageName: workspace('{plan}・{name}', '{plan}・{name}'),
  sprintCreate: workspace('{sprint}を作る', '{sprint}を作る'),
  sprintEdit: workspace('{sprint}を直す', '{sprint}を直す'),
  // 名前のあるスプリントは名前を、無いものは期間を名前として出す（kit.js の sprintLabel）
  sprintLabelNamed: workspace('{sprint} {name}', '{sprint} {name}'),
  sprintLabelPeriod: workspace('{sprint} {start}〜{end}', '{sprint} {start}〜{end}'),
  sprintPeriod: workspace('{start}〜{end}', '{start}〜{end}'),
  sprintLengthDays: workspace('{length} 日', '{length} 日'),
  sprintActive: workspace('進行中', '進行中'),
  sprintEmptyTitle: workspace('まだ{sprint}がありません', 'まだ{sprint}がありません'),
  sprintEmptyText: workspace(
    '{sprint}は、期間を区切って{task}を進める単位です。作ると、ここに先の{sprint}が並び、入れた{points}と{capacity}を見比べられます。終えた{sprint}がたまると、ベロシティも出ます。',
    '{sprint}は、期間を区切って{task}を進める単位です。作ると、ここに先の{sprint}が並び、入れた{points}と{capacity}を見比べられます。終えた{sprint}がたまると、ベロシティも出ます。',
  ),
  // リーダーでない人の空の状態。作り方の案内の代わりに、作るのは誰かを添える
  sprintEmptyMemberText: workspace(
    '{sprint}は、期間を区切って{task}を進める単位です。{sprint}を作るのは{leader}です。',
    '{sprint}は、期間を区切って{task}を進める単位です。{sprint}を作るのは{leader}です。',
  ),
  sprintEmptyClosedText: workspace(
    '終了した{workspace}には、{sprint}を作れません。',
    '終了した{workspace}には、{sprint}を作れません。',
  ),
  sprintEditAction: workspace('直す', '直す'),
  sprintEditLabel: workspace('直す: {label}', '直す: {label}'),
  sprintDeleteAction: workspace('削除する', '削除する'),
  sprintDeleteLabel: workspace('削除する: {label}', '削除する: {label}'),
  sprintFieldStart: workspace('開始日', '開始日'),
  sprintFieldLength: workspace('長さ（日）', '長さ（日）'),
  sprintFieldEnd: workspace('最終日', '最終日'),
  sprintFieldName: workspace('名前（任意）', '名前（任意）'),
  sprintNamePlaceholder: workspace('空なら期間を名前にします', '空なら期間を名前にします'),
  sprintFormHint: workspace(
    '長さは {min}〜{max} 日。作ったあと、{backlog}から{task}を入れてから始めます。',
    '長さは {min}〜{max} 日。作ったあと、{backlog}から{task}を入れてから始めます。',
  ),
  sprintStartRequired: workspace('開始日を入れてください', '開始日を入れてください'),
  sprintLengthInvalid: workspace(
    '長さは {min}〜{max} の整数で入れてください',
    '長さは {min}〜{max} の整数で入れてください',
  ),
  sprintEndOutOfRange: workspace('最終日が暦の範囲を外れます', '最終日が暦の範囲を外れます'),
  sprintNameTooLong: workspace('名前は {max} 字までです', '名前は {max} 字までです'),
  sprintNameInvalidCharacter: workspace(
    '名前に使えない文字（制御文字や見えない文字）が入っています',
    '名前に使えない文字（制御文字や見えない文字）が入っています',
  ),
  sprintOverlap: workspace(
    '期間が、ほかの{sprint}と重なっています。開始日か長さを変えてください',
    '期間が、ほかの{sprint}と重なっています。開始日か長さを変えてください',
  ),
  sprintStarted: workspace(
    'この{sprint}はもう始まっているので、直せません。一覧を読み直します',
    'この{sprint}はもう始まっているので、直せません。一覧を読み直します',
  ),
  sprintGone: workspace(
    'この{sprint}は見つかりません。一覧を読み直します',
    'この{sprint}は見つかりません。一覧を読み直します',
  ),
  sprintForbidden: workspace(
    '{sprint}を作り、直し、削除するのは{leader}です',
    '{sprint}を作り、直し、削除するのは{leader}です',
  ),
  sprintBadRequest: workspace(
    '入力を受け付けられませんでした。値を見直してください',
    '入力を受け付けられませんでした。値を見直してください',
  ),
  sprintCreateSubmit: workspace('作る', '作る'),
  sprintCreating: workspace('作っています', '作っています'),
  sprintCreated: workspace('{sprint}を作りました', '{sprint}を作りました'),
  sprintCreateFailed: workspace('作れませんでした。もう一度試してください', '作れませんでした。もう一度試してください'),
  sprintSave: workspace('保存する', '保存する'),
  sprintSaving: workspace('保存しています', '保存しています'),
  sprintSaved: workspace('{sprint}を保存しました', '{sprint}を保存しました'),
  sprintSaveFailed: workspace(
    '保存できませんでした。もう一度試してください',
    '保存できませんでした。もう一度試してください',
  ),
  sprintDeleteTitle: workspace('{sprint}を削除する', '{sprint}を削除する'),
  sprintDeleteText: workspace(
    '「{label}」（{period}）を削除します。削除したものは画面から消え、この版では戻せません。',
    '「{label}」（{period}）を削除します。削除したものは画面から消え、この版では戻せません。',
  ),
  sprintDeleting: workspace('削除しています', '削除しています'),
  sprintDeleted: workspace('{sprint}を削除しました', '{sprint}を削除しました'),
  sprintDeleteStarted: workspace(
    'この{sprint}はもう始まっているので、削除できません。一覧を読み直します',
    'この{sprint}はもう始まっているので、削除できません。一覧を読み直します',
  ),
  sprintDeleteFailed: workspace(
    '削除できませんでした。もう一度試してください',
    '削除できませんでした。もう一度試してください',
  ),
  // 経験値とレベル（kit.js の levelPanel と emblem、me.html の「経験値の明細」）。経験値の数値と明細は本人にだけ出す
  levelLabel: organization('レベル {level}', 'レベル {level}'),
  levelShort: organization('LV', 'LV'),
  levelPanelTitle: organization('レベル', 'レベル'),
  levelPanelNote: organization('経験値は本人だけに見えます', '経験値は本人だけに見えます'),
  xpUnit: organization('XP', 'XP'),
  levelToNext: organization('次のレベルまで', '次のレベルまで'),
  levelProspect: organization('見込み', '見込み'),
  levelSubSeparator: organization('・', '・'),
  levelGaugeLabel: organization(
    '次のレベルまでの {confirmed}% を確定、{prospective}% が見込み',
    '次のレベルまでの {confirmed}% を確定、{prospective}% が見込み',
  ),
  levelLegendConfirmed: organization('確定', '確定'),
  levelLegendProspect: organization('見込み（{task}の{done}で確定）', '見込み（{task}の{done}で確定）'),
  levelBreakdownLabel: organization('{workspace}ごとの経験値', '{workspace}ごとの経験値'),
  levelBreakdownTotal: organization('すべての{workspace}', 'すべての{workspace}'),
  levelLoadFailed: organization('レベルを読み込めませんでした', 'レベルを読み込めませんでした'),
  xpPlus: organization('+{value}', '+{value}'),
  meExperienceTitle: organization('経験値の明細', '経験値の明細'),
  meExperienceDescription: organization(
    '本人だけが見られます。打ち消しは負の値で残ります。手で足し引きする操作はありません。',
    '本人だけが見られます。打ち消しは負の値で残ります。手で足し引きする操作はありません。',
  ),
  xpHeaderConfirmedAt: organization('確定日時', '確定日時'),
  xpHeaderAction: organization('行動', '行動'),
  xpHeaderContent: organization('内容', '内容'),
  xpNoContent: organization('（なし）', '（なし）'),
  xpActionTaskCreated: workspace('起票', '起票'),
  xpActionTaskDetailed: workspace('手配書', '詳細'),
  xpActionTaskCompleted: workspace('完遂', '完了'),
  xpActionReview: workspace('レビュー', 'レビュー'),
  xpActionHelp: workspace('手助け', '手助け'),
  xpActionStoryCompleted: workspace('達成目標の完遂', 'ストーリーの完了'),
  xpActionEpicReward: workspace('クリア報酬', 'クリア報酬'),
  xpActionReversal: organization('{action}の打ち消し', '{action}の打ち消し'),
  xpEmptyTitle: organization('経験値の明細はまだありません', '経験値の明細はまだありません'),
  xpEmptyText: organization(
    '{task}を{complete}と、起票や{done}の経験値がここに並びます。',
    '{task}を{complete}と、起票や{done}の経験値がここに並びます。',
  ),
  xpContentHidden: organization(
    '（今所属していない{workspace}の内容は表示しません）',
    '（今所属していない{workspace}の内容は表示しません）',
  ),
  retrySection: organization('もう一度試す（{section}）', 'もう一度試す（{section}）'),
  meOtherSettingsNote: organization(
    '今は経験値だけを見られます。1日の基準、休み、テーマなどの設定は、これから足します。',
    '今は経験値だけを見られます。1日の基準、休み、テーマなどの設定は、これから足します。',
  ),
  xpLedgerFailedTitle: organization('経験値の明細を読み込めませんでした', '経験値の明細を読み込めませんでした'),
  xpLoadMore: organization('続きを読む', '続きを読む'),
  xpLoadMoreFailed: organization(
    '続きを読み込めませんでした。もう一度試してください',
    '続きを読み込めませんでした。もう一度試してください',
  ),
  xpAllLoaded: organization('明細をすべて表示しました', '明細をすべて表示しました'),
  teamXpLabel: workspace('パーティ全体の経験値', 'チーム全体の経験値'),

  // 日付に曜日を添える（kit.js の withWeekday）。曜日は 0 が日曜
  dateWithWeekday: organization('{date}（{weekday}）', '{date}（{weekday}）'),
  weekday0: organization('日', '日'),
  weekday1: organization('月', '月'),
  weekday2: organization('火', '火'),
  weekday3: organization('水', '水'),
  weekday4: organization('木', '木'),
  weekday5: organization('金', '金'),
  weekday6: organization('土', '土'),

  // Markdown の本文。変換が終わらなかった本文を、書かれたまま出すときの注記
  markdownPlainNote: workspace('整形せずに表示しています', '整形せずに表示しています'),
  // リンクは新しいタブで開く。リンクの補足（aria-describedby）として読み上げに伝える
  markdownNewTab: workspace('新しいタブで開きます', '新しいタブで開きます'),
  // 横にスクロールするコードと表の枠の名前。キーボードで枠にフォーカスを置いて動かすため、読み上げに名前を伝える
  markdownCodeRegion: workspace('コード', 'コード'),
  markdownTableRegion: workspace('表', '表'),

  // 完成の定義（設定の画面の節、詳細の引き出しの完了の操作の横、バックログの画面の上）。{dod} はその言葉づかいの言葉を画面が渡す。
  // スプリントの画面の完了の列に出すようになったら、説明の文にも足す
  dodDesc: workspace(
    'すべての{task}に共通する完了の基準。{backlog}の上と、完了の操作の横に出します。',
    'すべての{task}に共通する完了の基準。{backlog}の上と、完了の操作の横に出します。',
  ),
  dodFieldLabel: workspace('Markdown', 'Markdown'),
  dodHint: workspace(
    'Markdown で書けます。空にして保存すると、どこにも出しません。',
    'Markdown で書けます。空にして保存すると、どこにも出しません。',
  ),
  dodSave: workspace('保存する', '保存する'),
  dodSaving: workspace('{dod}を保存しています', '{dod}を保存しています'),
  dodSaved: workspace('{dod}を保存しました', '{dod}を保存しました'),
  dodCleared: workspace('{dod}を空にしました', '{dod}を空にしました'),
  dodUnchanged: workspace('保存した内容から変わっていません', '保存した内容から変わっていません'),
  // {max} は桁区切りの数（100,000）を画面が渡す
  dodTooLong: workspace('{dod}は {max} 字までです', '{dod}は {max} 字までです'),
  dodInvalidCharacter: workspace('{dod}に使えない文字が含まれています', '{dod}に使えない文字が含まれています'),
  dodSaveFailed: workspace(
    '{dod}を保存できませんでした。もう一度「保存する」を押してください。',
    '{dod}を保存できませんでした。もう一度「保存する」を押してください。',
  ),
  // 403 と 404（リーダーでなくなった、ワークスペースが見つからない）。枠を読み直す
  dodUnavailable: workspace(
    '保存できませんでした。操作できない状態です。画面を読み直しました。',
    '保存できませんでした。操作できない状態です。画面を読み直しました。',
  ),
  // ほかの画面で同時に書かれて、やり直しても書けなかった（409 の conflict）。書いた文は欄に残す
  dodConflict: workspace(
    'ほかの画面で同時に変わったため、保存できませんでした。もう一度「保存する」を押してください。',
    'ほかの画面で同時に変わったため、保存できませんでした。もう一度「保存する」を押してください。',
  ),
  dodEmptyReadOnly: workspace('まだ{dod}がありません。', 'まだ{dod}がありません。'),
  // 詳細の引き出しの完了の印の横。{at} は完了した日時
  taskCompletedAt: workspace('{done} {at}', '{done} {at}'),

  // ワークスペースの設定の画面（/[slug]/w/[id]/settings。見本は design/settings.html）
  settingsPageName: workspace('{settings}・{name}', '{settings}・{name}'),
  settingsForbiddenTitle: workspace('この画面には入れません', 'この画面には入れません'),
  settingsForbiddenText: workspace(
    '{settings}を開けるのは{leader}と{admin}だけです。',
    '{settings}を開けるのは{leader}と{admin}だけです。',
  ),
  repository: workspace('リポジトリ', 'リポジトリ'),
  categoriesDesc: workspace(
    '{epic}に振ると配下が引き継ぎます。「月ごとに計上する」{category}は、完了の記録に計上月を持ちます。切り替えても、すでにある完了の記録の計上月は変わりません。',
    '{epic}に振ると配下が引き継ぎます。「月ごとに計上する」{category}は、完了の記録に計上月を持ちます。切り替えても、すでにある完了の記録の計上月は変わりません。',
  ),
  repositoriesDesc: workspace(
    '{task}がどのリポジトリの作業かを示します。{task}に1つまで振れ、起票のときにボタンで選びます。',
    '{task}がどのリポジトリの作業かを示します。{task}に1つまで振れ、起票のときにボタンで選びます。',
  ),
  categoryBilledMonthly: workspace('月ごとに計上する', '月ごとに計上する'),
  categoryBilledMonthlyLabel: workspace('月ごとに計上する: {name}', '月ごとに計上する: {name}'),
  definitionListLabel: workspace('{kind}の一覧', '{kind}の一覧'),
  definitionEmptyTitle: workspace('まだ{kind}がありません', 'まだ{kind}がありません'),
  definitionEmptyText: workspace('下の欄から足せます。', '下の欄から足せます。'),
  definitionEmptyReadOnly: workspace('まだ{kind}がありません。', 'まだ{kind}がありません。'),
  definitionNewLabel: workspace('新しい{kind}の名前', '新しい{kind}の名前'),
  definitionAdd: workspace('{kind}を足す', '{kind}を足す'),
  definitionRenameHint: workspace('名前を直す', '名前を直す'),
  definitionNameLabel: workspace('{kind}の名前', '{kind}の名前'),
  definitionDuplicate: workspace('同じ名前の{kind}があります', '同じ名前の{kind}があります'),
  definitionLimit: workspace(
    '{kind}は {max} 件までです。使わないものを削除してから足してください',
    '{kind}は {max} 件までです。使わないものを削除してから足してください',
  ),
  definitionBadRequest: workspace('名前に使えない文字が含まれています', '名前に使えない文字が含まれています'),
  definitionSaveFailed: workspace(
    '{kind}を保存できませんでした。もう一度試してください。',
    '{kind}を保存できませんでした。もう一度試してください。',
  ),
  definitionSaved: workspace('「{name}」を保存しました', '「{name}」を保存しました'),
  definitionAddNotFound: workspace('足せませんでした。画面を読み直します', '足せませんでした。画面を読み直します'),
  definitionDeleting: workspace('{kind}を削除しています', '{kind}を削除しています'),
  definitionDeleteAction: workspace('削除', '削除'),
  definitionDeleteConfirm: workspace('削除する', '削除する'),
  settingsRefreshFailed: workspace('一覧を更新できませんでした', '一覧を更新できませんでした'),
  settingsRefreshed: workspace('一覧を更新しました', '一覧を更新しました'),
  settingsBackToBacklog: workspace('{backlog}へ戻る', '{backlog}へ戻る'),
  definitionsLoadFailed: workspace(
    '{category}とリポジトリの一覧を読み込めませんでした。',
    '{category}とリポジトリの一覧を読み込めませんでした。',
  ),
  repositoryEmptyHint: workspace(
    'リポジトリは{leader}が{settings}の画面で足せます。',
    'リポジトリは{leader}が{settings}の画面で足せます。',
  ),
  categoryCurrentUnread: workspace(
    '今の{category}（一覧を読み込めませんでした）',
    '今の{category}（一覧を読み込めませんでした）',
  ),
  definitionAdded: workspace('「{name}」を足しました', '「{name}」を足しました'),
  definitionSaving: workspace('{kind}を保存しています', '{kind}を保存しています'),
  definitionGone: workspace(
    'この{kind}はほかの画面で削除されています。一覧を読み直します',
    'この{kind}はほかの画面で削除されています。一覧を読み直します',
  ),
  definitionChanged: workspace(
    'ほかの画面で変わったため、できませんでした。一覧を読み直します',
    'ほかの画面で変わったため、できませんでした。一覧を読み直します',
  ),
  definitionMoved: workspace('「{name}」を {position} 番目に移しました', '「{name}」を {position} 番目に移しました'),
  definitionMoveFailed: workspace('移せませんでした。一覧を読み直します', '移せませんでした。一覧を読み直します'),
  definitionDeleteLabel: workspace('削除: {name}', '削除: {name}'),
  definitionDeleteTitle: workspace('「{name}」を削除する', '「{name}」を削除する'),
  categoryDeleteText: workspace(
    '振っていた{epic}、{story}、{task}は{category}なしに戻ります。完了の記録は元の{category}のまま残ります。',
    '振っていた{epic}、{story}、{task}は{category}なしに戻ります。完了の記録は元の{category}のまま残ります。',
  ),
  repositoryDeleteText: workspace(
    '振っていた{task}はリポジトリなしに戻ります。',
    '振っていた{task}はリポジトリなしに戻ります。',
  ),
  definitionDeleted: workspace('「{name}」を削除しました', '「{name}」を削除しました'),
  definitionDeleteFailed: workspace(
    '削除できませんでした。もう一度試してください。',
    '削除できませんでした。もう一度試してください。',
  ),
  // 起票のダイアログ、エピックとストーリーのダイアログ、詳細の引き出しの区分とリポジトリ
  categoryNone: workspace('{category}なし', '{category}なし'),
  categoryInherited: workspace('親から引き継ぎ', '親から引き継ぎ'),
  repositoryNone: workspace('なし', 'なし'),
  repositoryHint: workspace(
    '複数のリポジトリにまたがる作業は、リポジトリごとに{task}を分けます。',
    '複数のリポジトリにまたがる作業は、リポジトリごとに{task}を分けます。',
  ),
  categoryHasParent: workspace(
    '親のある{task}には{category}を振れません。親の{category}を引き継ぎます。',
    '親のある{task}には{category}を振れません。親の{category}を引き継ぎます。',
  ),
  definitionRefGone: workspace(
    '選んだ{kind}は削除されています。選び直してください',
    '選んだ{kind}は削除されています。選び直してください',
  ),
  // 木の行の区分とリポジトリの印。見えない文字で種類を添える
  chipPrefix: workspace('{kind}：', '{kind}：'),
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
