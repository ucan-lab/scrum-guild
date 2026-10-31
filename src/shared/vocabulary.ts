// 画面の言葉の辞書。キーごとにスクラムの言葉の文字列を1つ持つ。
// 画面の文言は、直に書かずにこの辞書を通して出す。
// 見本の design/kit.js の DICT にあるキーは、同じ中身を持つ（scripts/design-parity.test.ts が突き合わせる）。
// 語順や記号を含む文は、{名前} の置き換えを持つ1項目にする（format で埋める）。
// 読むのは画面（src/lib）と scripts/ のテスト。テストは Node の型の除去で読むので、enum を使わない。

// 辞書の型の検査。文字列でない項目は、ここで型エラーになる
// （src/shared/vocabulary.typecheck.ts が、文字列でないときに落ちることを確かめる）
export function defineDictionary<const T extends Record<string, string>>(entries: T): T {
  return entries;
}

export const dictionary = defineDictionary({
  // ---- 見本（design/kit.js の DICT）と同じキー ----
  workspace: 'ワークスペース',
  inbox: '受信箱',
  backlog: 'バックログ',
  sprint: 'スプリント',
  plan: '計画',
  epic: 'エピック',
  story: 'ストーリー',
  task: 'タスク',
  archive: 'アーカイブ',
  connection: '接続',
  sprintGoal: 'スプリントゴール',
  detail: '詳細',
  ac: '受け入れ基準',
  due: '期日',
  points: 'ポイント',
  assignee: '担当',
  category: '区分',
  capacity: '作業量と基準',
  over: '超過',
  done: '完了',
  column: '列',
  doneToday: '今日の完了',
  complete: '完了にする',
  requester: '作成者',
  party: '参加者',
  accept: '参加する',
  leave: '参加をやめる',
  reward: 'クリア報酬',
  clear: 'エピックを完了にする',
  create: '起票',
  leader: 'リーダー',
  member: 'メンバー',
  dod: '完成の定義',
  organization: '組織',
  admin: '管理者',
  assistant: 'アシスタント',

  // ---- 本番の画面の文言 ----
  // 枠の共通の文言
  appName: 'Scrum Guild',
  pageTitle: '{page} - {app}',
  menu: 'メニュー',
  menuCollapse: 'メニューを畳む',
  menuExpand: 'メニューを広げる',
  close: '閉じる',
  countUnit: '件',
  unassigned: '担当なし',
  leftMember: '（離脱済み）',
  loadFailedTitle: '読み込めませんでした',
  loadFailedText: 'しばらくしてから、もう一度試してください。',
  retry: 'もう一度試す',
  retrying: '読み込んでいます',
  // 読み直しに失敗したときの、もう一度試すボタンの横の知らせ
  retryFailed: 'まだ読み込めませんでした',
  loading: '読み込んでいます',
  loadingText: 'しばらくお待ちください。',

  // メニューの項目と見出し。ワークスペースの外の画面は organization
  pageToday: '自分の今日',
  pageNotifications: '通知',
  pageMe: '自分の設定',
  pageOrgAdmin: '組織の管理',
  pageRecords: '完了の記録',
  pageMembers: 'メンバー',
  pageSettings: '設定',
  pageHistory: '変更の履歴',
  groupRecords: '記録',
  groupManage: '管理',

  // 自分の今日（仮の画面）
  sectionToday: '今日やる',
  sectionTodayHint: '日付が変わると印は外れます',
  todayEmptyTitle: '今日やるタスクは、この画面ができたらここに並びます',
  todayEmptyText: 'いまは API の疎通だけを確かめる仮の画面です。',

  // 自分の今日の空の状態（管理者）。{workspace} と {member} は、辞書の言葉を画面が渡す。
  // 組織にワークスペースが1つも無いときは、最初のワークスペースを作る案内。作る画面の行き先は、その画面を作る Issue で決める
  firstWorkspaceTitle: 'まだ{workspace}がありません',
  firstWorkspaceText: '最初の{workspace}を作ります。最初の{leader}を1人決めて作ります。',
  // ワークスペースはあるが、自分の所属が0件のとき
  noMembershipTitle: 'どの{workspace}にも所属していません',
  noMembershipText: '{workspace}に加わると、ここから使えます。',

  // 組織の管理の画面（管理者）。{workspace} と {leader} は、辞書の言葉を画面が渡す
  adminEyebrow: '{admin}だけが見られます',
  adminWorkspacesDesc: '作った{workspace}の一覧です。終了した{workspace}も含みます。{member}の数は{leader}を含みます。',
  workspaceListLabel: '{workspace}の一覧',
  workspaceEmptyText: 'チームや用途ごとに作ります。{member}の招待は、作った{workspace}の{leader}が行います。',
  workspaceOpenLabel: '進行中の{workspace}',
  workspaceMemberCountHeader: '{member}数',
  workspaceLeaderCountHeader: '{leader}数',
  fieldName: '名前',
  createdOn: '作った日',
  workspaceClosedChip: '終了 {date}',
  workspaceNoLeaderChip: '{leader}がいない',

  // ワークスペースを作るダイアログ
  workspaceCreateAction: '{workspace}を作る',
  workspaceNamePlaceholder: '例: 保守チーム',
  workspaceNameRequired: '名前を入れてください',
  workspaceNameTooLong: '名前は {max} 字までです',
  workspaceLeaderLabel: '最初の{leader}',
  workspaceLeaderHint: '自分でもかまいません。あとから{leader}を足せます。',
  workspaceLeaderLoadFailed: '選べる人を読み込めませんでした',
  workspaceNameInvalidCharacter: '名前に使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  workspaceNoCandidates: '最初の{leader}に指せる人がいません',
  workspaceTimezoneRejected:
    'このブラウザのタイムゾーン（{timezone}）では作れません。ブラウザの設定を確かめてください。',
  workspaceDefaultsNote:
    '{column}は「{columns}」、決まった欄は「{field}」、換算は 1 {points} = {hours} 時間、週の始まりは月曜、タイムゾーンは {timezone}（このブラウザの設定）で作ります。あとから設定で変えられます。',
  cancel: 'やめる',
  workspaceSubmit: '作る',
  workspaceSubmitting: '作っています',
  workspaceCreated: '{workspace}を作りました',
  workspaceCreateFailed: '作れませんでした。もう一度試してください。',
  workspaceLeaderRejected: '選んだ人は、いま最初の{leader}に指せません。選び直してください。',

  // ワークスペースの枠と画面。見つからない画面は、組織の枠の中に出す
  notMemberAdminChip: '所属せず{admin}として開いています',
  workspaceNotFoundTitle: '{workspace}が見つかりません',
  workspaceNotFoundText: 'URL が違うか、入れない{workspace}です。',
  pageNotFoundTitle: '画面が見つかりません',
  pageNotFoundText: 'URL が違うか、開けない画面です。',
  backToToday: '自分の今日へ',

  // バックログ（ワークスペースの画面）。{backlog} {task} {create} {done} {points} は、辞書の言葉を画面が渡す
  backlogTasksLabel: '{backlog}の{task}',
  backlogEmptyTitle: 'まだ{task}がありません',
  backlogEmptyText: '{task}を優先する順に並べる場所です。上の「{create}」から最初の{task}を作ります。',
  backlogEmptyClosedText: '終了した{workspace}には、{task}を作れません。',
  // 完了の折りたたみを開いた状態の文言。閉じた状態の文言は、親のないタスクが backlogFolded、ストーリーの配下が storyFolded
  completedCollapse: '{done} {count} 件を閉じる',
  completedRootCollapse: '親のない{done} {count} 件を閉じる',
  // ストーリーの配下の開閉のボタンの読み上げの名前。見える文言（{label}）を含め、どのストーリーのものかを添える
  completedToggleLabel: '{label}（{title}）',
  // 開いた一覧（role="group"）の名前
  completedRootListLabel: '親のない{done}した{task}',
  completedListLabel: '{title}の{done}した{task}',
  completedMore: 'さらに見る',
  // 完了した行の日付の前に付ける語。日付そのもの（formatLocalDate）は画面が等幅で続ける
  completedDate: '{done}した日',
  completedEmpty: '{done}した{task}はありません',
  // 完了にした親のないタスクの折りたたみを閉じているときの文言。木は行を返さず件数だけ返し、開くと backlog-completed-tasks で行を読む。
  // 完了にした行は、読み直すまでこの件数に入らない
  backlogFolded: '親のない{done} {count} 件を折りたたんでいます',
  // 画面の題名の「画面」の部分。画面（バックログ）とワークスペースの両方が分かる形にする。{name} はワークスペースの名前
  backlogPageName: '{backlog}・{name}',
  // 未完了が0件で、完了した親のないタスクがあるとき、折りたたみの行の上に出す
  backlogNoOpenTitle: '未完了の{task}はありません',
  backlogNoOpenText: '次の{task}は、上の「{create}」から作ります。',
  // 絞り込みの帯（見本の design/backlog.html の .toolbar）。{label} は選択欄の名前（{assignee}、{category}、リポジトリ、{epic}）
  filterLabel: '{backlog}の絞り込み',
  backlogSearch: 'タイトルで探す',
  filterAll: '{label}: すべて',
  filterMe: '自分',
  filterNoRepository: 'リポジトリなし',
  filterNoEpic: '{epic}なし',
  // URL の値が選択肢に無い（消えた、別のワークスペースの値）とき、選択欄にその値を残す選択肢
  filterUnknown: '一覧に無い値',
  // 区分とリポジトリの一覧を読めなかったとき、URL の値を残す選択肢（消えたかどうかは分からない）
  filterSelectedUnloaded: '選んでいる値',
  // 絞り込みの結果の読み上げ（常に置いた role="status" の領域）。{count} は出したタスクの行の数
  filterResultCount: '{count} 件に絞りました',
  filterResultNone: '当たるものはありません',
  // 絞っている間、帯の下に出す。ポイントの合計と完了の件数は絞る前の値のため
  filterTotalsNote: '{points}と件数は、絞る前の全体の値です',
  filterClear: '絞り込みを外す',
  // 検索の文字が上限を超えたとき（帯の下に出し、読み直さない）
  searchTooLong: '検索の文字は {max} 字までです',
  searchTooManyWords: '検索の語は {max} つまでです',
  // 絞っている間は並べ替えを出さない（backlogOrderNote の代わりに出す）
  backlogFilterOrderNote: '上にあるものほど優先します。絞り込みを外すと並べ替えられます。',
  backlogNoMatchTitle: '絞り込みに当たるものはありません',
  backlogNoMatchText: '条件を変えるか、絞り込みを外してください。',
  // 絞っているときに作った{task}、{story}、{epic}が、読み直した木に無いとき
  filterHiddenCreated: '作りました。絞り込みに当たらないので表示していません',
  // タスクの行と、完了の操作
  pointsLabel: '{points} {value}',
  doneMarkLabel: '{title}: {done}',
  taskCompleting: '{done}にしています',
  taskGone: 'この{task}は見つかりません。一覧を読み直します',
  pointsUnsetMark: '未',
  pointsUnsetTitle: '未見積もり',
  // 完了の印の判子の文字。中世風のテーマだけが見せる
  doneStamp: '完',
  // 完了の操作の読み上げの名前。同じ名前のボタンが並ぶので、どのタスクかを添える
  taskCompleteLabel: '{complete}: {title}',
  taskCompleted: '{task}を{done}にしました',
  taskCompleteFailed: '{done}にできませんでした。もう一度試してください。',
  taskAlreadyDone: 'この{task}は、すでに{done}です',
  // 完了を戻す（task-reopen。スプリントの画面の完了のカードと、詳細の引き出しの完了の帯）。読み上げの名前は題を添える
  taskReopen: '戻す',
  taskReopenLabel: '{done}を戻す: {title}',
  taskReopening: '{done}を戻しています',
  taskReopened: '{task}の{done}を戻しました',
  // 断られた理由（taskReopenConflictReasons）
  taskReopenNotDone: 'この{task}は{done}していません。一覧を読み直します',
  taskReopenSprintClosed: '終了した{sprint}の中で{done}した{task}は戻せません。一覧を読み直します',
  taskReopenParentDone:
    '{done}した{story}の下の{task}は戻せません。先に{story}の{done}を取り消してください。一覧を読み直します',
  taskReopenChanged: 'ほかの画面で変わったため、戻せませんでした。一覧を読み直します',
  taskReopenFailed: '{done}を戻せませんでした。もう一度試してください。',
  workspaceClosedReadOnly: '終了した{workspace}には書き込めません',

  // 起票のダイアログ
  fieldTitle: 'タイトル',
  taskTitlePlaceholder: '何をするか',
  taskTitleRequired: 'タイトルを入れてください',
  taskTitleTooLong: 'タイトルは {max} 字までです',
  taskTitleInvalidCharacter: 'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  taskPointsHint: '「未」は未見積もり。起票の経験値は、1 以上の{points}が振られたまま{task}が{done}すると付きます。',
  taskSubmitting: '作っています',
  taskCreated: '{backlog}の末尾に足しました',
  taskCreateFailed: '作れませんでした。もう一度試してください。',
  // 親の選択欄。選べるのは、親のないストーリー。{story} {done} は、辞書の言葉を画面が渡す
  taskParent: '親の{story}',
  taskParentNone: 'なし',
  // {title} は親のストーリーの題
  taskCreatedUnder: '{story}「{title}」の末尾に足しました',
  taskParentGone: 'この{story}は見つかりません。親を選び直してください',
  taskParentDone: 'この{story}はすでに{done}しています。親を選び直してください',

  // バックログの木（ストーリーの行、期日の印）
  storyCreate: '{story}を作る',
  // 木の行の「＋タスク」の読み上げの名前。同じ名前のボタンが並ぶので、どのストーリーかを添える
  storyAddTaskLabel: '{task}を足す: {title}',
  treeRatio: '{done} {value} / {all} pt',
  treeRatioTitle: '{done} / 全体',
  storyFolded: '{done} {count} 件を折りたたんでいます',
  storyNoTasks: '{task}はまだありません',
  dueOverdue: '{due}切れ {date}',
  dueToday: '今日まで',
  dueThisWeek: '今週 {date}',

  // ストーリーのダイアログ（作るときも直すときも同じ欄）
  fieldBody: '本文',
  fieldLink: 'リンク',
  storyTitlePlaceholder: 'どこまで進めば区切りか',
  linkPlaceholder: 'https://',
  fieldTextTooLong: '{field}は {max} 字までです',
  fieldTextInvalidCharacter: '{field}に使えない文字（改行とタブ以外の制御文字、ゼロ幅のスペースなど）が含まれています',
  linkInvalid: 'http か https で始まる URL を入れてください',
  linkTooLong: 'リンクは {max} 字までです',
  storySave: '保存する',
  storySaving: '保存しています',
  storyCreated: '{story}を作りました',
  storySaved: '{story}を保存しました',
  storySaveFailed: '保存できませんでした。もう一度試してください。',
  storyGone: 'この{story}は見つかりません。一覧を読み直します',
  storyReadOnly: '終了した{workspace}の{story}は、読み取りだけできます',
  // ストーリーのダイアログ専用の文言（タスクのダイアログの文言を流用しない）
  storyTitleRequired: 'タイトルを入れてください',
  storyTitleTooLong: 'タイトルは {max} 字までです',
  storyTitleInvalidCharacter: 'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  storyCreateSubmit: '作る',
  storyCreating: '作っています',
  storyCreateFailed: '作れませんでした。もう一度試してください。',
  // 画面の検査を通った後に、サーバーが 400 で断ったとき。どの欄かは分からない
  storyBadRequest: '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
  storyLoading: '読み込んでいます',
  storyLoadFailed: 'この{story}を読み込めませんでした。もう一度試してください。',
  dueInvalid: '{due}は正しい日付で入れてください',
  storyLinkOpen: '開く',
  storyLinkOpenLabel: 'リンクを新しいタブで開く',
  // 木の行の開閉のボタンの読み上げの名前。{title} はストーリーの題
  treeOpen: '{title}を開く',
  treeClose: '{title}を閉じる',

  // バックログの並べ替えと親の移動。{title} は動かす行の題
  // {epic} {story} {task} は、辞書の言葉を画面が渡す
  backlogOrderNote:
    '上にあるものほど優先します。{epic}、{story}、{task}は、行の「上へ」「下へ」か、行の中にフォーカスを置いて Alt と ↑ ↓ で並べ替えます。',
  // つまみのドラッグに触れる文。つまみを出さない狭い幅と指の画面では、この文も隠す（.drag-note）
  backlogDragNote: '行の先頭のつまみをドラッグしても並べ替えられます。',
  // 親なしの段が空のとき、行をつかんでいる間だけ出す落とし先
  dropSlotTask: '親なしの{task}へ移す',
  dropSlotStory: '親なしの{story}へ移す',
  moveUp: '上へ',
  moveDown: '下へ',
  // 同じ名前のボタンが並ぶので、どの行かを添える
  moveUpLabel: '上へ: {title}',
  moveDownLabel: '下へ: {title}',
  moveParent: '親を移す',
  moveParentLabel: '親を移す: {title}',
  // 並べ替えの読み上げ。{index} は同じ親の中で何番目か
  moveAnnounced: '「{title}」を {index} 番目に移しました',
  // 親を移したときの知らせ。{parent} は移す先のストーリーの題
  moveAnnouncedUnder: '「{title}」を{story}「{parent}」の末尾へ移しました',
  moveAnnouncedRoot: '「{title}」を親なしの末尾へ移しました',
  // ドラッグで、親を変えて途中に入れたときの知らせ。移した先の親と、{index} 番目を伝える
  moveAnnouncedAtUnder: '「{title}」を{story}「{parent}」の {index} 番目に移しました',
  moveAnnouncedAtUnderEpic: '「{title}」を{epic}「{epicTitle}」の{story}「{parent}」の {index} 番目に移しました',
  moveAnnouncedAtRoot: '「{title}」を親なしの {index} 番目に移しました',
  moveFailed: '移せませんでした。一覧を読み直します',
  moveConflict: 'ほかの画面で変わったため、移せませんでした。一覧を読み直します',
  moveParentDone: '{done}した{story}の下へは移せません。一覧を読み直します',
  // 動かした行か、直前の行か、親が見つからなかった（404）。どれが消えたかは分からない
  moveGone: '一覧が変わったため移せませんでした。一覧を読み直します',
  moveTaskDone: 'この{task}は{done}しています。一覧を読み直します',
  // 動かしている間に一覧が読み直され、まだ送っていなかった移動を捨てたとき
  moveReloaded:
    '動かしている間に一覧が読み直されたため、一覧を読み直しました。並びが変わっていなければ、もう一度動かしてください',
  // 端の行で Alt と ↑ ↓ を押したときの読み上げ
  moveAtTop: 'いちばん上です',
  moveAtBottom: 'いちばん下です',
  // 親を移すダイアログ。見出しに、どのタスクを動かすかを添える
  moveParentTitle: '「{title}」の親を移す',
  moveParentField: '移す先',
  moveParentNone: '親なし',
  moveParentHint: '移す先の末尾に置きます。',
  moveParentSubmit: '移す',
  // ストーリーの親（エピック）を移すときの、完了か中止したエピックの下へは移せない知らせ
  moveEpicDone: '{done}か中止した{epic}の下へは移せません。一覧を読み直します',

  // エピックの行（木の最上段）。{title} はエピックの題
  epicCreate: '{epic}を作る',
  epicCleared: '完了',
  epicCanceled: '中止',
  epicNoStories: '{story}はまだありません',
  // エピックのダイアログ（作るときも直すときも同じ欄）。欄の文言はストーリーのダイアログと同じ項目を使う
  epicTitlePlaceholder: '何を成し遂げるか',
  epicCreated: '{epic}を作りました',
  epicSaved: '{epic}を保存しました',
  epicGone: 'この{epic}は見つかりません。一覧を読み直します',
  epicReadOnly: '終了した{workspace}の{epic}は、読み取りだけできます',
  epicLoadFailed: 'この{epic}を読み込めませんでした。もう一度試してください。',
  // エピックのダイアログ専用の文言（ストーリーのダイアログの文言を流用しない）
  epicTitleRequired: 'タイトルを入れてください',
  epicTitleTooLong: 'タイトルは {max} 字までです',
  epicTitleInvalidCharacter: 'タイトルに使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  epicCreateSubmit: '作る',
  epicCreating: '作っています',
  epicCreateFailed: '作れませんでした。もう一度試してください。',
  epicSave: '保存する',
  epicSaving: '保存しています',
  epicSaveFailed: '保存できませんでした。もう一度試してください。',
  // 画面の検査を通った後に、サーバーが 400 で断ったとき。どの欄かは分からない
  epicBadRequest: '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
  epicLoading: '読み込んでいます',
  epicLinkOpen: '開く',
  epicLinkOpenLabel: 'リンクを新しいタブで開く',
  // エピックの画面（/[slug]/w/[id]/epics/[epicId]）。見出しの横の「直す」は、エピックのダイアログを開く
  epicPageBack: '{backlog}へ戻る',
  epicPageEdit: '{epic}を直す',
  epicPageTallyDone: '{done}の{points}',
  epicPageTallyRemaining: '残りの{points}',
  epicPageRequest: '概要',
  epicPageRewardNote: '{reward}は、完了にした時点の{party}全員に同じ額が入ります。',
  epicPagePartyCount: '{count} 人',
  // クリア済みと中止したエピックの報酬の注記（進行中は epicPageRewardNote）
  epicPageRewardNoteCleared: '{reward}は、完了にした時点の{party}全員に同じ額が入りました。',
  epicPageRewardNoteCanceled: '中止したので、{reward}は{party}に入りません。',
  // 見える文字のない見出し（概要の節の名前）
  epicPageOverview: '{epic}の本文',
  // 直した後の読み直しに失敗したとき。画面は前に読んだ値のまま
  epicPageStale: '最新の内容を読み込めませんでした。表示は前に読んだ内容です。',
  epicPagePartyEmpty: '参加者はまだいません。',
  epicPageStories: '配下の{story}',
  // 討伐隊の面の操作。受注と抜けるは accept と leave（見本と同じキー）。割り振りは依頼主とリーダーだけに出す
  epicPageAssign: '{party}に割り振る',
  epicPartyJoined: '{epic}に参加しました',
  epicPartyLeft: '{party}から抜けました',
  // 受注と抜けるで何も書かなかった（別の画面などで先に変わっていた）。画面は読み直す
  epicPartyAlreadyChanged: '{party}はもう変わっていました。最新の内容を表示しています',
  // 受注と抜けるが 403（ワークスペースに所属していない）
  epicPartyForbidden: 'この{workspace}に所属していないため、{party}を変えられません',
  epicPartyUpdating: '{party}を更新しています',
  // 終わった（クリアか中止した）エピックの討伐隊は変えられない（409 の conflict）
  epicPartyFinished: 'この{epic}は終わっているので、{party}を変えられません',
  // 受注と抜けるが 404。エピックが消えたか、呼んだ人がもう所属していない
  epicPartyGone: '{epic}が見つからないか、{workspace}に所属していないため、{party}を変えられません',
  epicPartyFailed: '{party}を更新できませんでした。もう一度試してください',
  // 割り振りのダイアログ。候補は member-list の今所属している人のうち、討伐隊にいない人
  epicAssignField: '割り振る人',
  epicAssignHint: '{workspace}に今所属していて、まだ{party}にいない人から選びます。',
  epicAssignNoCandidates: '割り振れる人がいません。{workspace}の全員が{party}にいます。',
  epicAssignCandidatesFailed: '割り振れる人を読み込めませんでした。',
  epicAssignSubmit: '割り振る',
  epicAssignSubmitting: '割り振っています',
  epicAssigned: '「{name}」を{party}に割り振りました',
  epicAssignAlready: '「{name}」はもう{party}にいます',
  // 割り振りが 404。選んだ人がもう所属していないか、エピックが消えた
  epicAssignGone: '選んだ人は{workspace}に所属していないか、{epic}が見つかりません。選び直してください。',
  epicAssignForbidden: '{party}に割り振れるのは、{requester}と{leader}だけです',
  // 討伐隊の面の操作。クリア報酬の段階を変えるのは依頼主とリーダー、依頼主を替えるのはリーダーだけ
  epicPageChangeReward: '{reward}を変える',
  epicPageChangeRequester: '{requester}を替える',
  // クリア報酬を変えるダイアログ。段階は額つきのラジオで選ぶ
  epicRewardField: '{reward}の段階',
  epicRewardUnchanged: '今の段階です。別の段階を選ぶと変えられます。',
  epicRewardSubmit: '変える',
  epicRewardSubmitting: '変えています',
  epicRewardChanged: '{reward}を「{tier}」に変えました',
  epicRewardAlready: '{reward}はもう「{tier}」です',
  epicRewardForbidden: '{reward}を変えられるのは、{requester}と{leader}だけです',
  // 報酬の変更が 409（終わったエピック）
  epicRewardFinished: 'この{epic}は終わっているので、{reward}を変えられません',
  epicRewardGone: '{epic}が見つかりません',
  epicRewardFailed: '{reward}を変えられませんでした。もう一度試してください',
  // 依頼主を替えるダイアログ。候補は member-list の今所属している人のうち、今の依頼主でない人
  epicRequesterField: '新しい{requester}',
  epicRequesterHint: '{workspace}に今所属している人から選びます。{party}は変わりません。',
  epicRequesterNoCandidates: '替えられる人がいません。{workspace}に、今の{requester}のほかに所属している人がいません。',
  epicRequesterCandidatesFailed: '替えられる人を読み込めませんでした。',
  epicRequesterSubmit: '替える',
  epicRequesterSubmitting: '替えています',
  epicRequesterChanged: '{requester}を「{name}」に替えました',
  epicRequesterAlready: '{requester}はもう「{name}」です',
  epicRequesterGone: '選んだ人は{workspace}に所属していないか、{epic}が見つかりません。選び直してください。',
  epicRequesterForbidden: '{requester}を替えられるのは、{leader}だけです',
  epicRequesterFinished: 'この{epic}は終わっているので、{requester}を替えられません',
  epicRequesterFailed: '{requester}を替えられませんでした。もう一度試してください',
  // 進み具合の棒の読み上げ（kit.js の progress の aria-label）と、棒の横の数
  progressLabel: '{done} {value} / {all} {points}',
  progressValue: '{value} / {all} pt',
  epicPageNotFoundTitle: '{epic}が見つかりません',
  epicPageNotFoundText: '削除されたか、この{workspace}にない{epic}です。',
  // クリア報酬の段階の呼び名。額は経験値の定数（XP_EPIC_REWARD）から出す
  epicTierSmall: '小',
  epicTierMedium: '中',
  epicTierLarge: '大',
  // 親の選択欄で、親のないストーリーをまとめる見出し
  parentRootGroup: '親なしの{story}',
  // タスクを、エピックの下のストーリーへ移したときの知らせ。{epicTitle} は親のストーリーの親のエピックの題
  moveAnnouncedUnderEpic: '「{title}」を{epic}「{epicTitle}」の{story}「{parent}」の末尾へ移しました',

  // ストーリーの完了と取り消し。{title} はストーリーの題。同じ名前のボタンが並ぶので、読み上げの名前に題を添える
  storyCompleteLabel: '{complete}: {title}',
  // 配下に未完了のタスクが残っているあいだ、完了の操作の横に出す
  storyRemaining: '残り {count} 件の{task}',
  // 押せない理由の全文。見えない文字で置き、完了の操作の aria-describedby から指す
  storyRemainingNote: '未完了の{task}が残っているあいだは{done}にできません',
  // 親のエピックが完了か中止しているとき、「取り消す」の横に出す
  storyReopenBlocked: '{done}か中止した{epic}の下の{story}は取り消せません',
  // 親のエピックが完了か中止しているとき、「完了にする」の横に出す（完了にすると取り消せなくなるため、断る）
  storyCompleteBlocked: '{done}か中止した{epic}の下の{story}は{done}にできません',
  storyReopen: '取り消す',
  storyReopenLabel: '{done}を取り消す: {title}',
  storyCompleting: '{done}にしています',
  storyReopening: '{done}を取り消しています',
  storyCompleted: '{story}を{done}にしました',
  storyReopened: '{story}の{done}を取り消しました',
  storyOpenTasks: '未完了の{task}が残っているため、{done}にできません。一覧を読み直します',
  storyAlreadyDone: 'この{story}は、すでに{done}です。一覧を読み直します',
  storyNotDone: 'この{story}は{done}していません。一覧を読み直します',
  storyCompleteParentDone: '{done}か中止した{epic}の下の{story}は、{done}にできません。一覧を読み直します',
  storyReopenParentDone: '{done}か中止した{epic}の下の{story}は、取り消せません。一覧を読み直します',
  storyCompletionChanged: 'ほかの画面で変わったため、できませんでした。一覧を読み直します',
  storyCompleteFailed: '{done}にできませんでした。もう一度試してください。',
  storyReopenFailed: '取り消せませんでした。もう一度試してください。',

  // 組織の選択と、枠の外の画面（組織の切り替え、見つからない、運用の仮の画面）
  organizationChooseTitle: '組織を選ぶ',
  organizationChooseLead: '入れる組織が {count} つあります。名前や稼働の設定は組織ごとに別です。',
  organizationChooseNote: 'あとから、画面の左上（狭い幅では上の帯）の組織の切り替えで選び直せます。',
  organizationList: '組織の一覧へ',
  // 組織の切り替えのボタンと一覧の読み上げの名前。{name} は今の組織の名前
  organizationSwitchLabel: '{name}。組織を切り替える',
  organizationListLabel: '入れる組織',
  organizationMoving: '移っています',
  invitationsBadge: '届いた招待あり',
  invitationsReceived: '招待が届いています',
  noOrganizationTitle: '入れる組織がありません',
  noOrganizationText: '管理者から招待が届くと、ここに出ます。',
  // 入れる組織は無いが、届いた招待がある人
  noOrganizationInvitedTitle: 'まだ入れる組織がありません',
  noOrganizationInvitedText: '下の届いた招待から組織を選び、招待を承諾すると入れます。',
  invitationsHeading: '届いた招待',
  invitationPending: '承諾待ちの招待があります',
  invitationsNote: 'すべての組織に届いた招待を、組織ごとにまとめて出します。押すと、承諾するか辞退するかを選べます。',
  // 招待の画面（/<slug>/invitations と、組織に入れず招待だけがある人の組織の画面）。
  // {organization} は組織の名前、{workspace} はワークスペースの言葉、{name} はワークスペースの名前
  invitationInboxLead: '{organization}から届いた招待です。承諾すると、その{workspace}に入れます。',
  invitationInboxEmptyTitle: '承諾待ちの招待はありません',
  invitationInboxEmptyText: 'この組織に届いた招待は、承諾か辞退が済んだか、取り消されました。',
  // {inviter} は招待した人の名前、{role} はロール、{date} は招待した日（YYYY-MM-DD）
  invitationInboxMeta: '{organization}・{inviter}さんから・{role}・{date}',
  invitationInboxClosed: 'この{workspace}は終了しているため、承諾できません。辞退はできます。',
  invitationAccept: '承諾する',
  invitationDecline: '辞退する',
  invitationAcceptLabel: '{name}への招待を承諾する',
  invitationDeclineLabel: '{name}への招待を辞退する',
  invitationAccepting: '招待を承諾しています',
  invitationDeclining: '招待を辞退しています',
  invitationDeclined: '招待を辞退しました',
  invitationErrorNotFound: '招待が見つかりませんでした。取り消されたか、別のアカウントに宛てた招待です。',
  invitationErrorChanged: '招待の状態が変わっていました。取り消されたか、承諾か辞退が済んでいます。',
  invitationErrorClosed: 'この{workspace}は終了したため、承諾できませんでした。',
  invitationErrorAlreadyMember: 'もうこの{workspace}に所属しています。',
  invitationErrorUnreachable: '通信できませんでした。時間をおいてもう一度試してください。',
  invitationErrorFailed: '招待を処理できませんでした。時間をおいてもう一度試してください。',
  // 組織に入れる人が招待の画面から組織の画面へ戻るリンク。組織の名前は入れない（区切りの無い長い名前で、狭い幅からはみ出さないように）
  invitationInboxBack: '組織の画面へ戻る',
  invitationAccepted: '招待を承諾しました',
  organizationNotFoundTitle: '組織が見つかりません',
  organizationNotFoundText: 'URL が違うか、入れない組織です。',
  // 組織の枠の停止の画面（API が 403 の organization_suspended を返したとき）
  organizationSuspendedTitle: '組織は停止しています',
  organizationSuspendedText: 'この組織は停止しています。運用者に問い合わせてください。',
  operatorOpen: '運用の画面へ',
  pageOperator: '運用',
  // 運用の画面。{organization} {admin} は、それぞれ辞書の同じ名前の項目で埋める
  operatorNotice:
    '運用者は{organization}の中（タスク、メンバー、記録、添付ファイルの中身など）を見られません。ここに出すのは名前、slug、状態と、数、上限、日時だけです。',
  operatorEmptyTitle: '{organization}がまだありません',
  operatorEmptyText: '{organization}を作り、最初の{admin}を指名してください。',
  operatorCreate: '{organization}を作る',
  operatorColumnOrganization: '{organization}・slug',
  // 組織ごとの集計の列。{workspace} {task} は辞書の同じ名前の項目で埋める
  operatorColumnSeats: '人数 / 上限',
  operatorColumnWorkspaces: '{workspace}の数',
  operatorColumnTasks: '{task}の数',
  operatorColumnQuota: '添付ファイルの上限',
  operatorColumnLastUsed: '最後に使われた日時',
  // {used} は人数、{limit} は人数の上限。空白は不可分の空白（U+00A0）で、積んだ行でも数の間で割れない
  operatorSeats: '{used} / {limit}',
  operatorSeatsFull: '上限に達した',
  // {size} は GB か MB の数（1 GB 未満は MB。src/lib/format.ts の quotaSize）。空白は不可分の空白
  operatorQuotaSize: '{size} GB',
  operatorQuotaSizeMb: '{size} MB',
  // 名前の列の2行目。{slug} は組織の slug、{date} は作った日時（ブラウザのタイムゾーン。format-datetime.ts）
  operatorCreatedLabel: '作成',
  operatorNeverUsed: 'まだ使われていない',
  // 一覧の印。{date} は停止した日と、解約で消す予定日。どちらも UTC の日付（消す予定日を UTC の日付で数えるのにそろえる）
  operatorSuspended: '停止 {date}',
  operatorPurgeOn: '{date} に消す',
  operatorActionsHeader: '操作',
  // 組織の停止と再開。{organization} は辞書の同じ名前の項目、{name} は組織の名前
  operatorSuspendAction: '停止する',
  operatorResumeAction: '再開する',
  operatorSuspendLabel: '「{name}」を停止する',
  operatorResumeLabel: '「{name}」を再開する',
  operatorSuspendTitle: '{organization}を停止する',
  operatorSuspendText:
    '「{name}」を停止します。停止すると誰も入れなくなり、取り込みと日をまたぐ処理も止まります。データは残り、再開すれば元どおりに使えます。',
  operatorSuspendReason: '停止の理由',
  operatorSuspendTemporary: '一時的に止める',
  operatorSuspendTemporaryHint: '支払いの遅れなど。消す予定は立てません。',
  operatorSuspendCancellation: '解約',
  // {days} は PURGE_AFTER_DAYS（src/shared/operations/operator/organization-suspend.ts）
  operatorSuspendCancellationHint:
    '停止から {days} 日後に、運用の手順でデータをすべて消します。消す予定日の当日までは再開できます。過ぎると、再開も停止の理由の切り替えもできません。',
  operatorSuspending: '停止しています',
  operatorResuming: '再開しています',
  operatorSuspendDone: '「{name}」を停止しました',
  operatorResumeDone: '「{name}」を再開しました',
  // 停止中の組織の停止の理由を、再開せずに切り替える（停止した日時は変えない）
  operatorChangeAction: '停止の理由を変える',
  operatorChangeLabel: '「{name}」の停止の理由を変える',
  operatorChangeTitle: '停止の理由を変える',
  operatorChangeText: '「{name}」の停止の理由を選び直します。停止した日時は変わらず、再開しなくても切り替えられます。',
  operatorChangeTemporaryHint: '消す予定を取り消します。',
  operatorChangeCancellationHint:
    '切り替えた日から {days} 日後に、運用の手順でデータをすべて消します。消す予定日の当日までは再開できます。過ぎると、再開も停止の理由の切り替えもできません。',
  // 開いた直後は今の理由が選ばれていて「変える」を押せないので、その理由と次にできることを伝える
  operatorChangeUnchangedHint: '今の理由です。別の理由を選ぶと変えられます。',
  operatorChangeSubmit: '変える',
  operatorChanging: '変えています',
  operatorChangeDone: '「{name}」の停止の理由を変えました',
  operatorChangeFailed: '停止の理由を変えられませんでした。もう一度試してください。',
  operatorSuspendFailed: '{organization}を停止できませんでした。もう一度試してください。',
  operatorResumeFailed: '{organization}を再開できませんでした。もう一度試してください。',
  // 別の画面で先に操作されていた（409）。停止した状態か再開した状態かは言い切らず、読み直した一覧を見てもらう
  operatorStateChanged: '「{name}」の状態が変わっていました。一覧で状態を確かめてください',
  // 見つからない、または操作できない（404、403）
  operatorUnavailable:
    '「{name}」を操作できませんでした。見つからないか、操作できない状態です。一覧で状態を確かめてください',
  // 解約で消す予定日を過ぎた組織（一覧の purge_due、操作の 409 の purge_due）。消している途中で戻さないよう、再開と
  // 一時的な停止への切り替えはサーバーが断る。一覧の行では「停止の理由を変える」と「再開する」の代わりに出す
  // {admin} は辞書の同じ名前の項目。管理者の指名し直しも、消している途中で組織の中に行を足さないよう断る
  operatorPurgeDue: '消す予定日を過ぎたので、再開も停止の理由の切り替えも{admin}の指名もできません',
  operatorReassignPurgeDue: '「{name}」は消す予定日を過ぎたので、{admin}を指名できません',
  // 一覧を開いた後に日付が変わり、操作が purge_due で断られたときのトースト。{name} は組織の名前
  operatorResumePurgeDue: '「{name}」は消す予定日を過ぎたので再開できません',
  operatorChangePurgeDue: '「{name}」は消す予定日を過ぎたので、停止の理由を変えられません',
  operatorAdminNone: '{admin}がいない',
  operatorAdminPending: '{admin}は指名済み、ログイン待ち',
  operatorAdminExpired: '{admin}の招待の URL は期限切れ',

  // 人数と添付ファイルの上限を変えるダイアログ（design/kit.js の changeQuota）。{name} は組織の名前、{organization} は辞書の同じ名前の項目。
  // 添付ファイルの今の合計と、合計に関わる注意（合計が下がるまで添付できない、80% の通知）は #68 まで出さない
  operatorQuotaAction: '人数と容量の上限を変える',
  operatorQuotaLabel: '「{name}」の人数と容量の上限を変える',
  operatorQuotaTitle: '人数と添付ファイルの上限を変える',
  // {used} は人数、{limit} は人数の上限、{quota} は添付ファイルの上限（operatorQuotaSize か operatorQuotaSizeMb）。
  // 数と「人」の間は不可分の空白（U+00A0）で、折り返しで割れない
  operatorQuotaText:
    '「{name}」の上限を変えます。今は人数 {used} 人（上限 {limit} 人）、添付ファイルの上限 {quota} です。',
  operatorQuotaChoices: '新しい上限',
  operatorQuotaTierSmall: '小さい{organization}',
  operatorQuotaTierStandard: '標準',
  // 段階の値。{members} は人数の上限、{quota} は添付ファイルの上限（operatorQuotaSize）
  operatorQuotaTierValue: '{members} 人・{quota}',
  operatorQuotaTierOther: 'ほかの値',
  operatorQuotaTierOtherHint: '51 人以上の{organization}のために値を入れます。',
  operatorQuotaMembersLabel: '人数の上限（人）',
  operatorQuotaSizeLabel: '添付ファイルの上限（GB）',
  // {max} は入れられる値の上限（MEMBER_LIMIT_MAX、ATTACHMENT_QUOTA_MAX_BYTES を GB にした値）を formatCount で3桁ごとに区切った文字
  operatorQuotaMembersInvalid: '人数の上限は 1〜{max} の整数で入れてください。',
  operatorQuotaSizeInvalid: '添付ファイルの上限は 1〜{max} の整数（GB）で入れてください。',
  operatorQuotaNote:
    '人数を今より小さくしても、今いる人はそのまま残り、上限を下回るまで新しい人の招待と管理者への指名だけを止めます。',
  operatorQuotaHistoryNote: '上限の変更は{organization}の変更の履歴に、運用者の操作として残ります。',
  // 開いた直後は今の上限に合う選択肢が選ばれていて「変える」を押せないので、その理由と次にできることを伝える
  operatorQuotaUnchangedHint: '今の上限です。別の値を選ぶと変えられます。',
  operatorQuotaDone: '「{name}」の上限を変えました',
  operatorQuotaFailed: '上限を変えられませんでした。もう一度試してください。',
  // 書かれたか分からない失敗（5xx、通信の切れ）。閉じると一覧を読み直す
  operatorQuotaFailedUnknown:
    '上限を変えられませんでした。変わっていることもあるので、閉じた後の一覧で確かめてからもう一度試してください。',

  // 組織の作成のダイアログ
  operatorCreateTitle: '{organization}を作る',
  operatorSlugLabel: 'URL の名前（slug）',
  operatorSlugExample: '例: sakura-dev',
  operatorSlugHint: '英小文字、数字、ハイフンで 2〜40 字。あとから変えられません。',
  operatorNameLabel: '表示名',
  operatorNameExample: '例: さくら開発',
  operatorAdminVia: '最初の{admin}のログインの手段',
  operatorGithubName: 'GitHub',
  operatorGoogleName: 'Google',
  operatorGithubUserLabel: 'GitHub のユーザー名',
  operatorGithubUserExample: '例: kotone-dev',
  operatorGithubUserHint:
    'GitHub のユーザー ID に解決します。「確かめる」を押して、指名する人を見て確かめてから作ります。',
  operatorGoogleEmailLabel: 'Google のメールアドレス',
  operatorGoogleEmailExample: '例: mio.hoshino@example.com',
  operatorGoogleEmailHint:
    'その人が招待の URL を開き、このメールアドレスの Google アカウントでログインすると、{admin}として入れます。招待の URL は14日で切れます。',
  operatorErrorEmailRequired: 'メールアドレスを入れてください。',
  operatorErrorEmailInvalid:
    'メールアドレスの形に合いません。英数字などの ASCII の文字だけで、本人が Google に登録した綴りのまま入れてください。',
  operatorVerify: '確かめる',
  operatorVerifying: '確かめています',
  operatorVerifyLead:
    'この人を最初の{admin}にします。アバター、ユーザー名、表示名が、伝えたい人のものか確かめてください。ユーザー名は 1 字違いでも別の人に当たります。',
  operatorNoDisplayName: '表示名なし',
  operatorGithubId: 'GitHub のユーザー ID {id}',
  operatorCancel: 'やめる',
  operatorSubmit: '作る',
  operatorSubmitting: '作っています',
  operatorErrorSlugRequired: 'slug を入れてください。',
  operatorErrorSlugFormat: '英小文字、数字、ハイフンで 2〜40 字にしてください。',
  operatorErrorSlugReserved: 'この名前はアプリが使うので付けられません。',
  operatorErrorSlugTaken:
    'この slug はもう使われています。今作った{organization}かもしれないので、一覧を確かめてください。このダイアログを閉じると入力は消えます。',
  operatorAlreadyCreated:
    '「{slug}」の{organization}はもう作られています。名前も入力と同じなので、今作ったものと思われます。',
  operatorAlreadyCreatedOther:
    '「{slug}」の{organization}はもう作られています。名前が入力と違うので、この入力で作ったものではないかもしれません。',
  operatorAlreadyCreatedNoAdmin:
    '最初の{admin}が書かれていません。一覧の「{admin}を指名」から、{admin}を指名し直してください。',
  operatorShowCreated: '作られた{organization}の URL を見る',
  // ダイアログの読み上げの領域（常に置き、文字だけを替える）
  operatorLiveVerifying: '確かめています',
  operatorLiveVerified: '確かめました: {name}',
  operatorLiveCreating: '作っています',
  operatorLiveCreated: '作りました',
  operatorLiveExisting: '作られていた{organization}を見ています',
  // 作れたか分からない失敗の後に、読み直した一覧で見つけた組織の表示。{admin} に指名された人は、ここでは分からない
  operatorExistingTitle: '{organization}はもう作られています',
  operatorExistingLead:
    'この slug の{organization}は、もう作られています。次の URL を確かめてください。誰を{admin}に指名したかは、ここでは分かりません。',
  // 招待の URL は作った直後の応答にしか出ないので、ここでは出せない。出し直すには指名し直す（新しい招待の URL が出る）
  operatorExistingAdminPending:
    '指名された{admin}は、まだログインしていません。Google で指名したときの招待の URL は、ここでは出せません。URL を渡せていなければ、一覧の「{admin}を指名」から指名し直してください。新しい招待の URL が出ます。',
  operatorExistingAdminExpired:
    '指名された{admin}の招待の URL は、期限が切れています。URL はもう出せないので、一覧の「{admin}を指名」から指名し直してください。',
  operatorExistingAdminActive: '{admin}は、もうログインしています。',
  operatorErrorNameRequired: '表示名を入れてください。',
  operatorErrorNameLong: '表示名は 80 字までです。',
  operatorErrorNameInvalid:
    '表示名に使えない文字（制御文字、行や段落の区切り、向きを変える文字、見えない空白や演算子）が含まれています。',
  operatorErrorInvalid: '入力に誤りがあります。内容を確かめてください。',
  operatorErrorVerifyFailed: 'ユーザー名を確かめられませんでした。もう一度試してください。',
  operatorErrorVerifyAgain: 'ユーザー名を直したので、もう一度確かめてください。',
  operatorErrorUserRequired: 'ユーザー名を入れてください。',
  operatorErrorUserNotFound: 'そのユーザー名の人が GitHub にいません。',
  operatorErrorNotUser:
    'GitHub の組織のアカウントなどで、個人のアカウントではありません。ログインできないので指名できません。',
  operatorErrorUserChanged: '確かめたあとに、ユーザー名の持ち主が変わりました。もう一度確かめてください。',
  operatorErrorGithubUnavailable: 'GitHub に届きませんでした。しばらくしてから、もう一度試してください。',
  operatorErrorCreate:
    '{organization}を作れたか分かりません。サーバーでは作られていることがあるので、一覧を確かめてから、もう一度試してください。このダイアログを閉じると入力は消えます。',
  operatorErrorUnreachable: 'サーバーに届きませんでした。',

  // 作った後の表示
  operatorDoneTitle: '{organization}を作りました',
  operatorDoneLead: 'Scrum Guild はメールを送りません。{admin}になる人に、次の URL とログインの手段を伝えてください。',
  operatorDoneUrlLabel: '{organization}の URL',
  operatorCopy: 'コピー',
  operatorCopied: 'URL をコピーしました',
  operatorCopyFailed: 'コピーできませんでした。URL を選んでコピーしてください。',
  operatorDoneTell: 'GitHub の {name} でログインするよう伝えてください。',
  // Google の指名で作った後の表示。招待の URL はこの画面にだけ出る
  operatorInviteLead:
    'Scrum Guild はメールを送りません。{admin}になる人に、次の招待の URL を伝えてください。本人がこの URL を開き、指名したメールアドレスの Google アカウントでログインすると、{organization}に入れます。',
  operatorInviteUrlLabel: '招待の URL',
  operatorInviteCopied: '招待の URL をコピーしました',
  operatorInviteOnce:
    'この URL はこの画面を閉じると二度と出せません。期限は14日（{expires} まで）です。期限までに本人へ伝えてください。',
  // 続けて、メールアドレスを別の要素（等幅で、狭い幅では折り返す）で出す
  operatorInviteTell: '次のメールアドレスの Google アカウントでログインするよう伝えてください。',
  // 招待の URL を失ったときと、期限が切れたときの直し方
  operatorInviteReissue:
    'URL を失ったときや期限が切れたときは、一覧の「{admin}を指名」から指名し直すと、新しい招待の URL が出ます。',

  // 管理者の指名し直し（一覧の各行のボタンと、そのダイアログ）。{name} は組織の名前
  operatorReassignAction: '{admin}を指名',
  operatorReassignLabel: '「{name}」の{admin}を指名',
  operatorReassignTitle: '{admin}を指名し直す',
  // ダイアログの最初の文。開いたときの一覧の管理者の状態で変える
  operatorReassignLeadNone:
    '「{name}」には今{admin}がいません。新しい{admin}を、GitHub のユーザー名か Google のメールアドレスで指名します。',
  operatorReassignLeadPending:
    '「{name}」の{admin}は指名済みで、まだログインしていません。{admin}を、GitHub のユーザー名か Google のメールアドレスで指名し直します。',
  operatorReassignLeadExpired:
    '「{name}」の{admin}の招待の URL は、期限が切れています。{admin}を、GitHub のユーザー名か Google のメールアドレスで指名し直します。',
  operatorReassignLeadActive:
    '「{name}」には、ログインした{admin}がいます。{admin}が辞めたときなどに、新しい{admin}を、GitHub のユーザー名か Google のメールアドレスで指名します。今の{admin}は外れません。',
  operatorReassignVia: '{admin}のログインの手段',
  operatorReassignGithubUserHint:
    'GitHub のユーザー ID に解決します。「確かめる」を押して、指名する人を見て確かめてから指名します。',
  operatorReassignVerifyLead:
    'この人を{admin}にします。アバター、ユーザー名、表示名が、伝えたい人のものか確かめてください。ユーザー名は 1 字違いでも別の人に当たります。',
  operatorReassignNote:
    'この{organization}のユーザーでなくてもかまいません。指名しても、運用者はこの{organization}の中を見られるようにはなりません。まだログインしていない前の指名は取り消されます。',
  operatorReassignHistoryNote: '指名は{organization}の変更の履歴に、運用者の操作として残ります。',
  operatorReassignSubmit: '指名する',
  operatorReassignSubmitting: '指名しています',
  operatorReassignDoneTitle: '{admin}を指名しました',
  operatorLiveReassigning: '指名しています',
  operatorLiveReassigned: '指名しました',
  // 指名し直しの失敗。409 は、読んでから書くまでに同じ人の行が変わった（何も書かれていない）
  operatorReassignConflict:
    '指名している間に、この{organization}の人の状態が変わりました。一覧を確かめてから、もう一度試してください。',
  // GitHub で解決した人が、操作している運用者自身（運用者のアカウントに結んだログイン）だった
  operatorErrorNomineeIsOperator:
    'この GitHub のユーザーは、あなた（運用者）のログインです。運用者は{organization}の中を見ないので、{organization}の人か、{admin}になる人を指名してください。',
  operatorReassignNotFound: 'この{organization}が見つかりません。一覧を確かめてください。',
  operatorReassignFailed: '指名し直せたか分かりません。一覧で{admin}の状態を確かめてから、もう一度試してください。',
  // 書く前に断られた失敗（回数の上限などの 4xx）。何も書かれていない
  operatorReassignRejected:
    '指名し直せませんでした。何も書かれていません。入力を確かめるか、少し待ってから、もう一度試してください。',

  // API の疎通の表示（仮の画面）
  apiHeading: 'API の疎通',
  apiStatus: 'API: {status}（版 {version}）',
  apiChecking: 'API を確かめています',
  apiUnreachable: 'API に届きませんでした',
  apiUnreachableStatus: 'API に届きませんでした（{status}）',
  apiShowDetail: '詳細を見る',
  apiRecheck: '確かめ直す',
  apiRecheckOk: 'API を確かめました',
  apiRecheckFailed: 'API に届きませんでした',
  apiDetailTitle: 'API の詳細',
  apiDetailBody: 'この画面が呼んだ API の応答です。',

  // アカウントのメニュー（組織の中の上の帯）とログアウト。{name} はログインしている人の名前
  accountMenuLabel: '{name}。アカウントのメニュー',
  logout: 'ログアウト',
  logoutMoving: 'ログアウトしています',
  logoutFailed: 'ログアウトできませんでした。時間をおいてもう一度試してください。',
  loggedOut: 'ログアウトしました。',

  // ログインの画面。{organization} {workspace} {leader} は、それぞれ辞書の同じ名前の項目で埋める
  loginTitle: 'ログイン',
  loginLead:
    'いずれかの{organization}に所属しているか、招待されている人がログインできます。招待されたときの手段でログインしてください。',
  loginWithGithub: 'GitHub でログイン',
  loginWithGoogle: 'Google でログイン',
  loginNote:
    'GitHub と Google は本人確認だけに使います。入れる{organization}が2つ以上あれば、ログインのあとに選びます。',
  // メールアドレスとパスワードでのログイン（POST /api/auth/password/login）。外の手段のボタンの下に、区切りを挟んで欄を置く
  loginDivider: 'または',
  loginEmailLabel: 'メールアドレス',
  loginPasswordLabel: 'パスワード',
  loginWithPassword: 'メールアドレスでログイン',
  loginWithPasswordMoving: 'ログインしています',
  // 違うパスワード、登録の無いメールアドレス、形の合わない入力（401）。どれかは分けない（登録の有無を漏らさない）
  loginErrorInvalidCredentials: 'メールアドレスかパスワードが違います。確かめて、もう一度ログインしてください。',
  loginErrorDenied:
    'ログインできませんでした。どの{organization}の{workspace}にも所属しておらず、招待も届いていません。招待された手段（GitHub か Google）と、招待されたアカウントでログインしているか確かめてください。招待がまだなら、{leader}に GitHub のユーザー名か Google のメールアドレスで招待してもらってください。',
  // パスワードが合った後に、入れる{organization}も招待も無いとき（POST /api/auth/password/login の 403 denied）。
  // 招待された手段を確かめる案内は GitHub と Google の人向けなので、パスワードの人には出さない
  loginErrorDeniedPassword:
    'ログインできませんでした。どの{organization}の{workspace}にも所属しておらず、招待も届いていません。ほかの手段で招待されていないか確かめてください。招待がまだなら、{leader}に招待してもらってください。',
  // メールアドレスかパスワードの欄が空のまま送ろうとしたとき。送らずに出す（回数の上限を使わない）
  loginErrorEmptyFields: 'メールアドレスとパスワードを入れてください。',
  // 入れる{organization}（や届いた招待）が、停止した{organization}にだけあるとき（?error=suspended）
  loginErrorSuspended:
    'ログインできませんでした。所属しているか招待されている{organization}は停止しています。運用者に問い合わせてください。',
  // 招待の URL から結べなかったとき。理由（期限切れ、取り消し、別のアカウント、使い済み）は分けず、どのメールアドレスに招待したかも出さない
  loginErrorInvite:
    'この招待の URL は使えません。期限が切れたか、取り消されたか、招待されたのと別のアカウントでログインしています。招待した人に確かめるか、届いた招待の URL をもう一度開いてください。もう入れる{organization}がある人は、下のボタンからそのままログインできます。',
  // /invite を、URL の続き（# 以降）が無いまま開いたとき。秘密は読んだらすぐ URL から消すので、戻る・再読み込みでもここに来る
  inviteUnusable:
    'この招待の URL は使えません。招待の URL を開いた直後の画面だけが使えます。戻る・再読み込みをしたときや、URL が欠けているときは、届いた招待の URL をもう一度開いてください。',
  inviteMoving: 'Google へ移っています',
  // URL を読み終えてボタンを出したときに、読み上げの領域へ入れる（ボタンは URL を置き換えた後に出るため）
  inviteReady: '招待の URL を読みました。「Google でログイン」を押すとログインを始めます。',
  loginErrorRetry: 'ログインを完了できませんでした。もう一度ログインしてください。',
  loginErrorTooMany: 'ログインの試行が多すぎます。しばらく待ってから、もう一度ログインしてください。',
  loginErrorUnavailable:
    'いまログインを受け付けられません。時間をおいてもう一度試してください。続くときは運用者に連絡してください。',

  // メンバーの画面（ワークスペースの画面）。{leader} {member} {admin} は、辞書の言葉を画面が渡す。
  // ロールは、リーダーと管理者には選択欄で、一般のメンバーには文字で出す。
  membersPageName: '{members}・{name}',
  membersTallyBelonging: '所属',
  membersTallyInvited: '招待中',
  membersSectionTitle: '所属している人',
  membersTableLabel: '所属している人の一覧',
  membersEmptyTitle: '所属している人はいません',
  membersEmptyText: '招待を承諾した{member}が、ここに並びます。',
  memberRoleHeader: 'ロール',
  memberJoinedHeader: '参加日',
  roleMember: '一般',
  // 承諾待ちの招待。{leader} と {admin} にだけ見える
  invitationsSectionTitle: '承諾待ちの招待',
  invitationsSectionHint: '{leader}と{admin}にだけ見えます',
  invitationsTableLabel: '承諾待ちの招待の一覧',
  invitationsEmptyTitle: '承諾待ちの招待はありません',
  invitationsEmptyText: '招待した人が承諾するまで、ここに並びます。',
  invitationViaHeader: '手段',
  invitedOnHeader: '招待した日',
  loginProviderGithub: 'GitHub',
  loginProviderGoogle: 'Google',
  // Google の招待の期限（作ってから14日）。{date} は YYYY-MM-DD
  invitationExpiresOn: '{date} まで',
  invitationExpired: '期限切れ',
  // 承諾待ちの招待の取り消し（リーダーと管理者）。{name} は招待のときの名前
  invitationActionsHeader: '操作',
  invitationRevoke: '取り消す',
  invitationRevokeLabel: '{name} への招待を取り消す',
  invitationRevoking: '招待を取り消しています',
  invitationRevoked: '招待を取り消しました',
  invitationRevokeChanged: '招待の状態が変わっていました。一覧を読み直しました。',
  invitationRevokeNotFound: '招待が見つかりませんでした。一覧を読み直しました。',
  invitationRevokeFailed: '招待を取り消せませんでした。もう一度試してください。',
  // 所属している人の行の操作。ロールの付け替えと「外す」はリーダーと管理者に、「抜ける」は自分の行に出す。
  // {name} は人の名前、{role} はロールの名前、{workspaceName} は開いているワークスペースの名前、
  // {task} {workspace} {organization} {leader} {admin} は、辞書の言葉を画面が渡す
  memberActionsHeader: '操作',
  memberRoleLabel: '{name}のロール',
  memberRemove: '外す',
  memberRemoveLabel: '{name}を外す',
  memberLeave: '抜ける',
  memberLeaveLabel: '{workspaceName}から抜ける',
  membersActionNote: '外すと、その人の未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。',
  memberWorking: '{member}を更新しています',
  memberRemoveTitle: '{name}を外しますか',
  memberRemoveText:
    '{name}は{workspace}から外れます。担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻すには、もう一度招待します。',
  memberLeaveTitle: '{workspaceName}から抜けますか',
  memberLeaveText:
    '担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻るには、もう一度招待を受けてください。',
  // 管理者でなく、ほかに所属するワークスペースが無い人が抜けるとき
  memberLeaveLastText:
    'ほかに所属している{workspace}が無いので、抜けると、この{organization}に入れなくなります。担当していた未完了の{task}は担当なしに戻ります。完了の記録と経験値は残ります。戻るには、もう一度招待を受けてください。',
  memberDemoteTitle: '自分を一般に戻しますか',
  memberDemoteText:
    '一般に戻すと、ロールの付け替え、招待、{member}を外すことができなくなります。{leader}に戻るには、ほかの{leader}か{admin}に頼んでください。',
  memberDemoteConfirm: '一般に戻す',
  // 他人の唯一のリーダーを一般に戻すとき（続けて memberLastLeaderNote を添える）
  memberDemoteOtherTitle: '{name}を一般に戻しますか',
  memberDemoteOtherText: '{name}は一般に戻り、ロールの付け替え、招待、{member}を外すことができなくなります。',
  memberRoleChanged: '{name}を{role}にしました',
  memberRemoved: '{name}を外しました',
  memberLeft: '{workspaceName}から抜けました',
  // 唯一のリーダーが抜ける、外される、自分を一般に戻すときに、確かめのダイアログへ添える
  memberLastLeaderNote: 'この{workspace}の{leader}がいなくなります。新しい{leader}は{admin}が任命します。',
  memberErrorClosed: '終了した{workspace}の{member}は変えられません。画面を読み直しました。',
  memberErrorForbidden: 'この操作ができるのは{leader}と{admin}だけです。画面を読み直しました。',
  memberErrorChanged: '{member}のロールが先に変わっていました。一覧を読み直しました。',
  memberErrorNotFound: 'その人はもう所属していませんでした。一覧を読み直しました。',
  memberRoleFailed: 'ロールを付け替えられませんでした。もう一度試してください。',
  memberRemoveFailed: 'メンバーを外せませんでした。もう一度試してください。',
  memberLeaveFailed: '{workspace}から抜けられませんでした。もう一度試してください。',
  // 「招待する」の節（リーダーと管理者）。ログインの手段は GitHub と Google。
  // {organization} {admin} {workspace} は、辞書の言葉を画面が渡す
  inviteSectionTitle: '招待する',
  inviteSeats: '{organization}の人数 {used} / {limit} 人',
  inviteViaLabel: 'ログインの手段',
  inviteGithubUserLabel: 'GitHub のユーザー名',
  inviteGithubUserExample: '例: kotone-dev',
  inviteGithubUserHint:
    'GitHub のユーザー ID に解決します。「確かめる」を押して、招待する人を見て確かめてから招待します。',
  inviteVerify: '確かめる',
  inviteVerifying: '確かめています',
  inviteVerifyLead:
    'この人を招待します。アバター、ユーザー名、表示名が、招待したい人のものか確かめてください。ユーザー名は 1 字違いでも別の人に当たります。',
  inviteNoDisplayName: '表示名なし',
  inviteGithubId: 'GitHub のユーザー ID {id}',
  inviteSubmit: '招待する',
  inviteSubmitting: '招待しています',
  // 続けて組織の URL を出す（長い URL を折り返せるよう、URL は別の要素にする）
  inviteSendNote:
    'Scrum Guild は招待をメールで送りません。Google の招待は、招待したときに出る招待の URL（14日で切れます）を本人に伝えてください。GitHub の招待は、次の{organization}の URL を伝えてください。',
  // Google の招待。メールアドレスで指し、確かめる手順は無い
  inviteGoogleEmailLabel: 'Google のメールアドレス',
  inviteGoogleEmailExample: '例: mio.hoshino@example.com',
  inviteGoogleEmailHint:
    '招待の URL を作ります。本人がその URL を開き、このメールアドレスの Google アカウントでログインすると、招待を承諾できます。招待の URL は14日で切れます。',
  inviteErrorEmailRequired: 'メールアドレスを入れてください。',
  inviteErrorEmailInvalid:
    'メールアドレスの形に合いません。英数字などの ASCII の文字だけで、本人が Google に登録した綴りのまま入れてください。',
  // Google で招待した後のダイアログ。招待の URL はこの画面にだけ出る
  inviteUrlTitle: '招待の URL',
  inviteUrlLead:
    '招待しました。Scrum Guild はメールを送りません。この招待の URL を本人に伝えてください。本人がこの URL を開き、招待したメールアドレスの Google アカウントでログインすると、招待を承諾して{workspace}に入れます。',
  inviteUrlLabel: '招待の URL',
  inviteCopy: 'コピー',
  inviteUrlCopied: '招待の URL をコピーしました',
  inviteCopyFailed: 'コピーできませんでした。URL を選んでコピーしてください。',
  // 続けて、メールアドレスを別の要素（等幅で、狭い幅では折り返す）で出す
  inviteUrlTell: '次のメールアドレスの Google アカウントでログインするよう伝えてください。',
  inviteUrlOnce:
    'この URL はこの画面を閉じると二度と出せません。期限は14日（{expires} まで）です。期限までに本人へ伝えてください。',
  inviteUrlReissue:
    'URL を失ったときや期限が切れたときは、同じメールアドレスで招待し直すと、新しい招待の URL が出ます（期限が切れた後は、{organization}の人数が上限なら招待し直せません）。招待し直すと（ほかの{leader}が招待し直したときも）、前の招待の URL は使えなくなります。',
  // 人数の上限の枠に、Google を選んでいるときだけ続けて出す。Google の招待の人数の判定はメールアドレスで見るので、
  // 招待の URL からログインを済ませた人（sub で数えられている）も、同じアドレスでは新しい人として断られる
  inviteLimitReachedGoogle:
    'Google の招待では、同じメールアドレスへの承諾待ちの招待がある人だけを、すでに数えられている人として扱います。招待の URL からログインを済ませた人を同じアドレスで招待するときも、上限の間は招待できません。',
  // Google の招待が書かれたか分からない失敗（通信の切れ、5xx）。書かれていても招待の URL は応答の本文にしか無いので、もう出せない
  inviteErrorUnknownGoogle:
    '招待できたか分かりません。承諾待ちに出ていても、招待の URL はもう出せません。もう一度招待すると新しい招待の URL が出て、前の URL は使えなくなります。',
  inviteDone: '{name} を招待しました',
  inviteLiveVerified: '確かめました: {name}',
  inviteLimitReached:
    '{organization}の人数が上限（{limit} 人）に達しているため、新しい人は招待できません。すでに{organization}にいる人は招待できます。上限を上げるには{admin}に相談してください。',
  inviteNotCountedAtLimit:
    'この人はまだ{organization}の人数に数えられていないため、上限に達している間は招待できません。',
  inviteErrorUserRequired: 'ユーザー名を入れてください。',
  inviteErrorVerifyAgain: 'ユーザー名を直したので、もう一度確かめてください。',
  inviteErrorUserNotFound: 'そのユーザー名の人が GitHub にいません。',
  inviteErrorNotUser:
    'GitHub の組織のアカウントなどで、個人のアカウントではありません。ログインできないので招待できません。',
  inviteErrorUserChanged: '確かめたあとに、ユーザー名の持ち主が変わりました。もう一度確かめてください。',
  inviteErrorAlreadyMember: 'この人は、もうこの{workspace}に所属しています。',
  inviteErrorAlreadyInvited: 'この人には、この{workspace}への承諾待ちの招待があります。',
  inviteErrorClosed: '終了した{workspace}には招待できません。画面を読み直しました。',
  inviteErrorForbidden: '招待できる権限がなくなっていました。画面を読み直しました。',
  inviteErrorTooMany: '確かめる回数が多すぎます。しばらく待ってから、もう一度試してください。',
  inviteErrorTooManyInvites: '招待する回数が多すぎます。しばらく待ってから、もう一度試してください。',
  inviteErrorGithubUnavailable: 'GitHub に届きませんでした。しばらくしてから、もう一度試してください。',
  inviteErrorUnreachable: 'サーバーに届きませんでした。',
  inviteErrorVerifyFailed: 'ユーザー名を確かめられませんでした。もう一度試してください。',
  inviteErrorFailed: '招待できませんでした。もう一度試してください。',
  // 招待の URL を開く画面（/invite）。組織の名前は、秘密を API に送る前なので出さない
  inviteTitle: '{app} への招待',
  inviteLead: '招待されたメールアドレスの Google アカウントでログインしてください。',
  inviteNote:
    'ボタンを押すまでログインを始めません。すでにログインしていても、Google のアカウントでログインし直します。',

  // テーマ
  themeLabel: 'テーマ',
  themeSimple: 'シンプル（自動）',
  themeSimpleLight: 'シンプル（ライト）',
  themeSimpleDark: 'シンプル（ダーク）',
  themeMedieval: '中世風',
  themeModern: '現代風',
  // テーマの説明。見本の design/kit.js の THEME_NOTE と同じ文（src/shared/theme.ts の themeNoteKeys）
  themeNoteSimple: '業務の道具として落ち着いた見た目。OS のライトとダークに合わせる',
  themeNoteSimpleLight: '業務の道具として落ち着いた見た目。いつも明るい地',
  themeNoteSimpleDark: '業務の道具として落ち着いた見た目。いつも暗い地',
  themeNoteMedieval: '冒険者ギルドの帳簿。紙と墨、完了に朱の判子',
  themeNoteModern: '近未来の端末のウィンドウ。暗い地に光る枠',

  // 組織の既定のテーマ（組織の管理の画面）
  orgThemeTitle: '既定のテーマ',
  orgThemeDesc: '画面の見た目の既定。自分で選んでいないユーザーに効きます。会社で使うならシンプルが無難です。',
  // 節ごとの「保存する」。選んだ値が今の値と違うときだけ押せる
  orgSettingsSave: '保存する',
  orgSettingsSaving: '保存しています',
  orgThemeChanged: '既定のテーマを「{label}」に変えました',
  // ほかの管理者が先に同じ項目を変えていた（409）。読み直した値を見てもらう
  orgSettingsConflict: 'ほかの{admin}が先に変えていました。今の値を読み直したので、確かめてから選び直してください',
  // 見つからない、または操作できない（404、403。管理者でなくなったなど）。読み直した画面を見てもらう
  orgSettingsUnavailable: '保存できませんでした。操作できない状態です。画面を読み直しました。',
  // 通信の失敗と 5xx。選んだ値は残すので、そのまま押し直せる
  orgSettingsFailed: '保存できませんでした。もう一度「保存する」を押してください。',

  // ワークスペースを終了する、再開する（組織の管理の画面。API の操作の名前は workspace-close と workspace-reopen のまま）。
  // {workspace} は、辞書の言葉を画面が渡す。{name} はワークスペースの名前
  workspaceActionsHeader: '操作',
  workspaceCloseAction: '終了する',
  workspaceReopenAction: '再開する',
  workspaceCloseLabel: '「{name}」を終了する',
  workspaceReopenLabel: '「{name}」を再開する',
  workspaceCloseTitle: '「{name}」を終了しますか？',
  workspaceCloseText:
    '終了すると読み取り専用になり、中の書き込みはすべてできなくなります。この画面からいつでも再開できます。',
  workspaceClosing: '終了しています',
  workspaceReopening: '再開しています',
  workspaceClosed: '{workspace}を終了しました',
  workspaceReopened: '{workspace}を再開しました',
  workspaceCloseFailed: '{workspace}を終了できませんでした。もう一度試してください。',
  workspaceReopenFailed: '{workspace}を再開できませんでした。もう一度試してください。',
  // 再開が人数の上限で断られた（409 の member_limit_reached）。組織の管理の表の上のコールアウトに出して残す。
  // {name} は再開しようとした{workspace}の名前、{adding} は再開で新しく人数に数えられる人、{used} は今の人数、{limit} は人数の上限、
  // {adminPage} は組織の管理の画面の名前（pageOrgAdmin）、{users} はその中のユーザーの節の名前（userSectionTitle）。
  // 数と「人」の間は不可分の空白（U+00A0）で、折り返しで割れない。
  // 閉じた{workspace}の招待は取り消せないので、対処は上限の見直し（運用者に問い合わせる）と、ほかのユーザーの無効化
  workspaceReopenMemberLimit:
    '「{name}」は再開できません。閉じている間は数えていなかった承諾待ちの招待の {adding} 人が{organization}の人数に加わり、今の {used} 人と合わせて上限の {limit} 人を超えます。上限の見直しは運用者に問い合わせてください。または、{adminPage}の「{users}」で、ほかのユーザーを無効にして人数を減らしてください。無効にした人はすべての{workspace}から外れ、有効に戻しても所属は戻りません。',
  // 上の文言の、数が読めない応答（details が無いか不正）の版。数は出さず、対処は同じ
  workspaceReopenMemberLimitUnknown:
    '「{name}」は再開できません。閉じている間は数えていなかった承諾待ちの招待を含めると、{organization}の人数が上限を超えます。上限の見直しは運用者に問い合わせてください。または、{adminPage}の「{users}」で、ほかのユーザーを無効にして人数を減らしてください。無効にした人はすべての{workspace}から外れ、有効に戻しても所属は戻りません。',
  // 別の画面で先に操作されていた（409）。終了した状態か再開した状態かは言い切らず、読み直した一覧を見てもらう
  workspaceStateChanged: '「{name}」の状態が変わっていました。一覧で状態を確かめてください',
  // 見つからない、または操作できない（404、403）
  workspaceUnavailable:
    '「{name}」を操作できませんでした。見つからないか、操作できない状態です。一覧で状態を確かめてください',
  workspaceListRefreshFailed: '{workspace}の一覧を更新できませんでした',
  workspaceListLoadFailed: '{workspace}の一覧を読み込めませんでした',

  // 組織のユーザー（組織の管理の画面の「ユーザー」の節。API の操作は user-list、user-admin-update、user-disable、user-enable）。
  // {admin}、{organization}、{workspace}、{task} は、辞書の言葉を画面が渡す。{name} はユーザーの名前
  userSectionTitle: 'ユーザー',
  userSectionDesc:
    '{admin}は他のユーザーを{admin}に指名でき、解除もできます。最後の{admin}は解除できません。無効にした人は{organization}に入れず、すべての{workspace}から外れます。名前、完了の記録、経験値は残ります。',
  userTally: 'ユーザー',
  userListLabel: '{organization}のユーザーの一覧',
  userWorkspaceCountHeader: '所属',
  userLastSeenHeader: '最後に入った日',
  userActionsHeader: '操作',
  userNeverSeen: '—',
  // 「—」に添える、読み上げだけの文
  userNeverSeenText: 'まだ入っていません',
  // 無効の人の押せない管理者の切り替えの理由（読み上げだけ）
  userAdminToggleDisabledNote: '無効の人は{admin}に指名できません',
  userDisabledChip: '無効',
  userAdminToggleLabel: '{name}を{admin}にする',
  userDisableAction: '無効にする',
  userEnableAction: '有効に戻す',
  userDisableLabel: '{name}を無効にする',
  userEnableLabel: '{name}を有効に戻す',
  userDisableTitle: '{name}を無効にしますか？',
  userDisableText:
    '{name}はこの{organization}に入れなくなります。すべての{workspace}から外れ、担当していた未完了の{task}は担当なしに戻り、承諾待ちの招待は取り消します。完了の記録と経験値は残ります。',
  userDisableAdminNote: '{admin}の指名も解除します。',
  userDisableEnableNote:
    '有効に戻しても所属と{admin}の指名は戻りません。もう一度使ってもらうには、{workspace}に招待し直してください。',
  // 自分の管理者を解除する前の確認。解除すると、この画面（組織の管理）を開けなくなる
  userRevokeSelfTitle: '自分の{admin}を解除しますか？',
  userRevokeSelfText:
    '解除すると、この画面を開けなくなります。{admin}に戻るには、ほかの{admin}に指名し直してもらいます。',
  userRevokeSelfConfirm: '解除する',
  userDesignated: '{name}を{admin}に指名しました',
  userRevoked: '{name}の{admin}を解除しました',
  userDisabled: '{name}を無効にしました',
  userEnabled: '{name}を有効に戻しました。入るには{workspace}への招待が要ります',
  userWorking: 'ユーザーを変更しています',
  // 409 の conflict の理由ごと（details.reason）と、そのほかの失敗。どれも一覧を読み直す
  userErrorLastAdmin: '最後の{admin}は解除も無効にもできません。先にほかの人を{admin}に指名してください',
  userErrorSelf: '自分は無効にできません',
  userErrorDisabled: '無効の人は{admin}に指名できません。先に有効に戻してください',
  userErrorMemberLimit:
    '{organization}の人数が上限に達しているため、{name}を{admin}に指名できません。上限を上げるには運用者に相談してください',
  userErrorChanged: '{name}の状態が先に変わっていました。一覧を読み直しました',
  userErrorNotFound: '{name}が見つかりませんでした。一覧を読み直しました',
  userErrorForbidden: 'この操作ができるのは{admin}だけです。画面を読み直しました',
  userErrorUnreachable: 'サーバーに届きませんでした',
  userUpdateFailed: '{name}を変更できませんでした。もう一度試してください',
  userListRefreshFailed: 'ユーザーの一覧を更新できませんでした',
  userListLoadFailed: 'ユーザーの一覧を読み込めませんでした',

  // 組織の休日（組織の管理の画面）。{workspace} と {capacity} は、辞書の言葉を画面が渡す。
  // {date} は休日の日付（YYYY-MM-DD）、{line} は貼り付けた行の番号、{text} はその行、{max} は上限
  holidaysTitle: '組織の休日',
  holidaysDesc: '祝日など、すべての{workspace}に効く休日。日付の一覧を貼り付けて、まとめて登録できます。',
  holidayPasteLabel: '貼り付けて登録',
  holidayPastePlaceholder: '2027-02-11 建国記念の日\n2027-02-23 天皇誕生日',
  holidayPasteHint:
    '1行に1日。日付（2026-11-03 か 2026/11/3、2000〜2099 年）のあとに、空白、タブ、カンマで区切って名前を書けます。表計算から写した行は、名前より後の列を読みません。登録済みの日付は飛ばします。',
  holidaySubmit: '登録する',
  holidaySubmitting: '登録しています',
  holidayAdded: '{added} 日を登録しました',
  holidayAddedWithSkipped: '{added} 日を登録しました（{skipped} 日は登録済み）',
  holidayNothingToAdd: '登録できる行がありません。1行に1日、日付から書いてください。',
  holidayTooMany: '登録できる行が {count} 日あります。1回に登録できるのは {max} 日までです。分けて登録してください。',
  holidayAddFailed: '登録できませんでした。もう一度試してください。',
  // 画面の解析と API の検証は同じ決まりなので、ふつうは起きない（400）
  holidayAddRejected: '登録できない行がありました。日付と名前を確かめてください。',
  holidayProblemsLabel: '登録しない行',
  // 理由の要約。読み上げ（role="alert"）にはこの文だけを入れ、行ごとの理由は入れない
  holidayProblemsSummary: '{count} 行を登録しません。直して、もう一度「登録する」を押してください。',
  // 理由の一覧に出しきれない行の数
  holidayProblemsMore: 'ほか {count} 行',
  holidayProblemLine: '{line} 行目「{text}」: {reason}',
  holidayProblemInvalidDate: '日付の形ではありません（2026-11-03 か 2026/11/3）',
  holidayProblemNoSuchDate: '暦に無い日付です',
  holidayProblemOutOfRange: '{first}〜{last} 年の日付だけを登録できます',
  holidayProblemTooLong: '名前は {max} 字までです',
  holidayProblemInvalidCharacter: '名前に使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  holidayProblemDuplicate: '同じ日付が前の行にあります',
  holidayListLabel: '登録した休日',
  holidayEmptyTitle: 'まだ休日がありません',
  holidayEmptyText: '登録した日は、{capacity}の計算で全員が稼働しない日になります。',
  holidayDeleteLabel: '{date} を消す',
  holidayDeleting: '消しています',
  holidayDeleted: '{date} を消しました',
  holidayDeletedWithName: '{date}（{name}）を消しました',
  // 別の画面で先に消されていた（404）
  holidayAlreadyDeleted: '{date} は見つかりませんでした。一覧を確かめてください',
  holidayDeleteFailed: '{date} を消せませんでした。もう一度試してください。',
  holidayListLoadFailed: '休日の一覧を読み込めませんでした',
  holidayListRefreshFailed: '休日の一覧を更新できませんでした',

  // 組織の変更の履歴（組織の管理の画面）。{organization}、{admin}、{workspace}、{member} は、辞書の言葉を画面が渡す。
  // 内容の文は organization-history の種類ごとに1つ。{name} は人か組織かワークスペースの名前、{date} は消す予定日（YYYY-MM-DD）
  orgHistoryTitle: '変更の履歴',
  orgHistoryDesc:
    '{admin}の指名、運用者の操作、{workspace}の作成と終了など、{organization}の単位の変更を新しい順に出します。{workspace}の中の変更（{member}の所属など）は出しません。',
  orgHistoryListLabel: '{organization}の変更の履歴',
  orgHistoryColumnAt: '日時',
  orgHistoryColumnActor: 'した人',
  orgHistoryColumnEvent: '内容',
  orgHistoryActorOperator: '運用者',
  orgHistoryActorSystem: '自動の処理',
  // 人の行が無い（まとめて消えた）か、まだ名前の分からない人
  orgHistoryUnknownPerson: '名前の分からない人',
  orgHistoryOrganizationCreated: '{organization}「{name}」を作りました',
  orgHistoryOrganizationCreatedNoName: '{organization}を作りました',
  orgHistoryOrganizationSuspended: '{organization}を停止しました（消す予定日 {date}）',
  orgHistoryOrganizationSuspendedTemporary: '{organization}を一時的に停止しました',
  orgHistoryOrganizationResumed: '{organization}を再開しました',
  orgHistorySuspensionChanged: '停止の理由を解約に切り替えました（消す予定日 {date}）',
  orgHistorySuspensionChangedTemporary: '停止の理由を一時的な停止に切り替えました',
  orgHistoryOrganizationSettingsChanged: '{organization}の設定を変更しました',
  orgHistoryAdminDesignated: '{name}を{admin}に指名しました',
  // Google の招待で指名し、本人がまだログインしていない（名前はメールアドレスなので出さない）
  orgHistoryAdminDesignatedGoogle: 'Google で招待した人を{admin}に指名しました',
  orgHistoryAdminLoginLinked: '{name}が Google でログインし、{admin}の指名を受けました',
  orgHistoryAdminDesignationMerged: 'Google の招待で、{name}を{admin}にしました',
  // 運用者が管理者を指名し直したときに、まだログインしていない前の指名を取り消した。Google の招待で待っていた人は名前が分からない
  orgHistoryAdminDesignationRemoved: '{name}への{admin}の指名を取り消しました',
  orgHistoryAdminDesignationRemovedNoName: 'Google で招待した人への{admin}の指名を取り消しました',
  orgHistoryAdminRevoked: '{name}の{admin}を解除しました',
  orgHistoryUserDisabled: '{name}を無効にしました',
  orgHistoryUserEnabled: '{name}を有効に戻しました',
  orgHistoryWorkspaceCreated: '{workspace}「{name}」を作りました',
  orgHistoryWorkspaceCreatedNoName: '{workspace}を作りました',
  orgHistoryWorkspaceClosed: '{workspace}「{name}」を終了しました',
  orgHistoryWorkspaceReopened: '{workspace}「{name}」を再開しました',
  // ワークスペースの行が無く、名前の分からない終了と再開
  orgHistoryWorkspaceClosedNoName: '{workspace}を終了しました',
  orgHistoryWorkspaceReopenedNoName: '{workspace}を再開しました',
  // 知らない組（entity_type と action）
  orgHistoryOther: '{organization}を変更しました',
  orgHistoryEmptyTitle: 'まだ変更の履歴がありません',
  orgHistoryEmptyText: '{admin}の指名や{workspace}の作成をすると、ここに残ります。',
  orgHistoryMore: '古い履歴を読む',
  // 「古い履歴を読む」で足した件数。読み上げに伝える
  orgHistoryLoadedMore: '{count} 件を読みました',
  orgHistoryMoreFailed: '続きを読み込めませんでした。もう一度試してください。',
  // 「古い履歴を読む」で最後まで読んだ（ボタンが消えるので、ここへフォーカスを移す）
  orgHistoryEnd: 'これより前の履歴はありません',
  orgHistoryLoadFailed: '変更の履歴を読み込めませんでした',
  orgHistoryRefreshFailed: '変更の履歴を更新できませんでした',

  // 終了したワークスペースの帯（ワークスペースの中の全画面）。{date} は終了した日、{page} は組織の管理の画面の名前
  workspaceClosedBanner: '{date} に終了しました。読み取り専用です。',
  workspaceClosedBannerLink: '{page}で再開する',

  // タスクの詳細の引き出し
  drawerOpenMode: '開き方',
  drawerSide: '横',
  drawerCenter: '真ん中',
  drawerPage: 'ページ全体',
  drawerTab: '新しいタブ',
  drawerTabBlocked: '新しいタブを開けませんでした',
  // 上の帯の前後のボタン。{task} は一覧の前後に並ぶ行の呼び名。キーボードは [ と ]
  drawerSteps: '前後の{task}',
  drawerPrev: '前の{task}',
  drawerNext: '次の{task}',
  // ボタンの title。キーを添える（読み上げの名前は変えない）。端で押せないときは、その理由
  drawerPrevTitle: '前の{task}（[）',
  drawerNextTitle: '次の{task}（]）',
  // 前後のボタンで移った先を読み上げる文。{title} は移った先のタイトル
  drawerMoved: '{task}「{title}」に移りました',
  drawerAtFirst: '先頭です',
  drawerAtLast: '最後です',
  taskManualChip: '手で作った{task}',
  taskImportedChip: '取り込んだ{task}',
  taskDrawerLoadFailed: 'この{task}を読み込めませんでした。もう一度試してください。',
  // タイトルとリンクの値のボタンの、読み上げに添える文（押すと入力欄になる）
  taskTitleEditHint: '（押して{task}のタイトルを直す）',
  linkEditHint: '（押してリンクを直す）',
  linkAdd: 'リンクを足す',
  linkEdit: 'リンクを直す',
  editSave: '保存',
  editCancel: '取り消し',
  editBody: '編集',
  bodyEmpty: 'まだ書かれていません。',
  bodyEditHint: 'Markdown で書けます。見出しは # が小見出しの大きさから始まります。',
  dueClear: 'クリア',
  // 完了したタスクのポイントは直せない（経験値とスプリントの集計が、完了の記録の値を使うため）
  taskPointsLocked: '{done}した{task}の{points}は直せません',
  // 取り込んだタスクは、タイトルとリンクを直せず、削除でなくアーカイブで外す（取り込み元のキーと期限は、取り込みの Issue で足す）
  taskImportedNote: '取り込んだ{task}のタイトルは、ここでは直せません',
  taskImportedLocked: '取り込んだ{task}のタイトルとリンクは直せません。',
  taskImportedNoDelete: '取り込んだ{task}は削除せず、{archive}へ移して外します。',
  taskSaveRaced:
    'ほかの人が同時に直したため、保存できませんでした。最新の内容を読み直したので、もう一度試してください。',
  taskSaved: '保存しました',
  taskSaving: '保存しています',
  taskSaveFailed: '保存できませんでした。もう一度試してください。',
  taskSaveConflict: 'この{task}は{done}になっているため、{points}は直せません。',
  taskBadRequest: '入力を受け付けられませんでした。内容を確かめて、もう一度試してください。',
  // 担当の選択（引き出しと起票のダイアログ）。候補は、そのワークスペースに今所属している人
  assigneeCandidatesFailed: '{assignee}の候補を読み込めませんでした',
  assigneeNotMember: '選んだ人は、もうこの{workspace}に所属していません。{assignee}を選び直してください',
  // 完了したタスクの担当は替えない（完了の経験値と完了の記録が、完了した時点の担当を使うため）
  taskAssigneeLocked: '{done}した{task}の{assignee}は替えられません',
  taskAssigneeDone: 'この{task}は{done}になっているため、{assignee}は替えられません。',
  taskReadOnly: '終了した{workspace}の{task}は、読み取りだけできます',
  // 書きかけがあるまま閉じる（か別のタスクへ移る）ときの確認
  discardTitle: '書きかけを捨てますか',
  discardText: '保存していない変更があります。捨てると元に戻せません。',
  discardKeep: '書き続ける',
  discardConfirm: '捨てる',
  // 削除
  taskDelete: 'この{task}を削除する',
  taskDeleteWho: '削除できるのは作った人と{leader}です。',
  taskDeleteTitle: '{task}を削除する',
  taskDeleteText: '「{title}」を削除します。削除したものは画面から消え、この版では戻せません。',
  taskDeleteHint: '完了の記録と経験値は残ります。',
  taskDeleteConfirm: '削除する',
  taskDeleteCancel: 'やめる',
  taskDeleting: '削除しています',
  taskDeleted: '{task}を削除しました',
  taskDeleteFailed: '削除できませんでした。もう一度試してください。',
  taskDeleteForbidden: '作った人と{leader}だけが削除できます',
  // エピックとストーリーの削除（ダイアログの下のボタンと、配下の扱いを選ぶ確認。TreeDeleteDialog）。
  // 削除できる人、確認の本文と結び、送っている間、失敗の文はタスクの削除と同じ言葉を使う
  epicDelete: 'この{epic}を削除する',
  storyDelete: 'この{story}を削除する',
  epicDeleteTitle: '{epic}を削除する',
  storyDeleteTitle: '{story}を削除する',
  treeDeleteChildren: '配下の扱い',
  treeDeleteKeep: '配下を親なしで残す',
  treeDeleteAll: '配下もまとめて削除する',
  // 言葉と数、数と「件」の間は改行させない空白（U+00A0）
  epicDeleteKeepHint:
    '{story} {stories} 件は親なしの{story}として末尾へ移り、その下の{task} {tasks} 件は{story}の下のままです。{category}は{epic}の{category}を写します。',
  epicDeleteAllHint:
    '{story} {stories} 件と{task} {tasks} 件を削除します。取り込んだ{task}は削除せず、{archive}へ移します。',
  storyDeleteKeepHint:
    '{task} {tasks} 件は親なしの{task}として末尾へ移ります。{category}は{story}の{category}を写します。',
  storyDeleteAllHint: '{task} {tasks} 件を削除します。取り込んだ{task}は削除せず、{archive}へ移します。',
  treeDeleteAllLeaderOnly: '配下に他の人が作ったものがあるため、まとめて削除できるのは{leader}だけです。',
  epicDeleteNoChildren: '配下の{story}はありません。',
  storyDeleteNoChildren: '配下の{task}はありません。',
  epicDeleted: '{epic}を削除しました',
  storyDeleted: '{story}を削除しました',
  thanks: '感謝',
  thanksNone: 'なし',
  thanksEmpty: 'まだ感謝は送られていません。',
  // コメントの「送る」ボタンと名前が重ならないよう、「送る」を含めない
  thanksSend: '{name} に感謝する',
  // 行の右端に寄せる部品（.party-list-end）は縮まないので、見える文字は短くし、相手の名前は読み上げの名前に回す
  thanksRevoke: '{name} への感謝を取り消す',
  thanksRevokeShort: '取り消す',
  thanksSent: '感謝を送りました',
  thanksRevoked: '感謝を取り消しました',
  thanksFromTo: '{sender} から {recipient} に送った感謝',
  thanksSelf: '自分には感謝を送れません。',
  thanksDuplicate: 'この相手には、すでに感謝を送っています。',
  thanksCompleted: '完了した{task}の感謝は送れず、取り消せません。',
  thanksForbidden: '感謝を送る権限、または取り消す権限がありません。',
  thanksNotFound: '対象の{task}、相手、または感謝が見つかりません。',
  thanksFailed: '感謝の操作に失敗しました。もう一度試してください。',
  thanksRefreshFailed: '感謝の操作は完了しましたが、最新の一覧を読み込めませんでした。',
  thanksCandidatesFailed: '感謝を送る相手を読み込めませんでした。',
  // 担当の欄の「もう一度試す」と同じ引き出しに並ぶので、名前を分ける
  thanksCandidatesRetry: '相手を読み直す',
  thanksCandidatesEmpty: '感謝を送れる相手はいません。',
  thanksHint:
    '送れるのは{assignee}だけ（{assignee}がいなければ作った人）です。完了するまでは、送った本人が取り消せます。',
  // 変更の履歴（引き出しの「変更の履歴」の節。src/lib/task-history.ts が列の名前と値を文にする）
  historyTitle: '変更の履歴',
  historyEmpty: 'まだ変更はありません。',
  historyLoadFailed: '変更の履歴を読み込めませんでした。',
  historyMore: 'さらに読む',
  historyMoreFailed: '続きを読み込めませんでした。もう一度試してください。',
  // 変えた人のいない行（同期などの定期処理と、運用者の操作）
  historyActorSystem: '定期処理か運用者',
  historyCreated: '作成した',
  historyUpdated: '変更した',
  historyCompleted: '{done}にした',
  historyDeleted: '削除した',
  historyReopened: '{done}を戻した',
  historyChange: '{before} → {after}',
  historyFieldEdited: '{field}を直した',
  historyNone: 'なし',
  historyFieldOther: 'そのほかの欄',
  historyFieldParent: '親の{story}',
  // 名前が空の人、区分、親（読めなかった名前）
  historyUnknownName: '不明',
  // 「さらに読む」で行を足したことを、読み上げに伝える
  historyMoreAdded: '{count} 件を足しました',
  // 保存した後の読み直しに失敗したとき。前に読めた行は残し、節の上に添える
  historyReloadFailed: '最新の変更の履歴を読み込めませんでした。',

  // コメント（引き出しの「コメント N」のタブ。src/lib/components/TaskComments.svelte）。N は消していないコメントの数
  drawerTabs: 'コメントと変更の履歴',
  commentsTab: 'コメント {count}',
  commentEmpty: 'まだコメントはありません。',
  commentLoadFailed: 'コメントを読み込めませんでした。',
  commentReloadFailed: '最新のコメントを読み込めませんでした。',
  commentOlder: '前のコメントを読む',
  commentOlderFailed: '前のコメントを読み込めませんでした。もう一度試してください。',
  // 「前のコメントを読む」で足したことを、読み上げに伝える
  commentOlderAdded: '前のコメントを {count} 件足しました',
  commentEdited: '編集済み',
  commentEdit: '編集',
  commentDelete: '削除',
  commentEditLabel: 'コメントを直す',
  // 消したコメント。本人が消したら「削除されました」だけ、本人以外（{leader}）が消したら消した人の名前を添える
  commentDeleted: '削除されました',
  commentDeletedBy: '{name}が削除しました',
  commentNewLabel: 'コメントを書く',
  commentPlaceholder: 'Markdown で書けます',
  commentSend: '送る',
  commentSending: 'コメントを送っています',
  commentSaving: 'コメントを保存しています',
  commentDeleting: 'コメントを削除しています',
  commentField: 'コメント',
  commentRequired: 'コメントを書いてから送ってください',
  commentSent: 'コメントを送りました',
  commentSaved: 'コメントを直しました',
  commentRemoved: 'コメントを削除しました',
  commentSendFailed: 'コメントを送れませんでした。書いた文は残しています。もう一度試してください。',
  commentSaveFailed: 'コメントを保存できませんでした。書いた文は残しています。もう一度試してください。',
  commentDeleteFailed: 'コメントを削除できませんでした。もう一度試してください。',
  // 直している間に、ほかの人（{leader}）がそのコメントを消した。書きかけは欄に残し、一覧を読み直す
  commentGoneWhileEditing: 'このコメントは削除されました。書きかけの文は欄に残しています。',
  commentAlreadyDeleted: 'このコメントはすでに削除されています',
  // 権限が無かった（ロールが替わったなど）。一覧を読み直して、出せる操作を出し直す
  commentForbidden: 'このコメントは操作できません。一覧を読み直しました。',
  commentDeleteTitle: 'コメントを削除する',
  // {name} は書いた人、{at} は書いた日時（ワークスペースのタイムゾーンの YYYY-MM-DD HH:mm）
  commentDeleteText:
    '{name}が {at} に書いたコメントを削除します。本文は戻せません。一覧には「削除されました」と残ります。',
  // フォーカスを置いたときに読む、コメントの一覧と欄の領域の名前
  commentThread: 'コメントの一覧',
  // 書きかけのまま書き込めなくなった（終了した）。欄は読み取り専用で残し、写せるようにする
  commentDraftReadOnly: '終了した{workspace}には送れません。書きかけの文は写して残せます。',

  // 計画の画面（design/plan.html）と、スプリントの作成と変更のダイアログ（kit.js の sprintCreate）
  planPageName: '{plan}・{name}',
  // 計画の画面の集計（ベロシティ、先のスプリントの棒、エピックごとの残り）
  velocity: 'ベロシティ',
  velocityAverage: '{velocity}（直近 {count} 回の平均）',
  velocityExcludedNote: '延長した{sprint}は除く',
  velocityEmpty: '終えた{sprint}がまだないので、{velocity}はまだ出ません。{sprint}を終えると、ここに出ます。',
  velocityAllExtended:
    '終えた{sprint}がすべて延長したものなので、{velocity}はまだ出ません。延長していない{sprint}を終えると出ます。',
  velocityBarItem: '{label} {points} pt',
  velocityBarExcluded: '（延長のため除外）',
  velocityAverageMark: '平均 {value}',
  velocityExcludedLabel: '延長 {days} 日・除外',
  planFilled: '入れた {points} pt',
  planFilledVelocity: '{velocity} {value}',
  planFilledLabel: '入れた {points} pt、{velocity} {value} pt',
  planFilledOver: '{over}（{velocity}より {gap} pt 多い）',
  planUnestimated: '未見積もり {count} 件',
  planTallyVelocity: '{velocity}（pt）',
  planTallyUnestimated: '未見積もり',
  planEpicsTitle: '{epic}ごとの残り',
  planEpicsEmpty: '進行中の{epic}はありません',
  planEpicRemaining: '残り（pt）',
  planEpicProgress: '進み',
  planSummaryFailed: '{velocity}と{epic}ごとの残りを読み込めませんでした。',
  planSummaryRetrying: '{velocity}と{epic}ごとの残りを読み直しています。',
  sprintCreate: '{sprint}を作る',
  sprintEdit: '{sprint}を直す',
  // 名前のあるスプリントは名前を、無いものは期間を名前として出す（kit.js の sprintLabel）
  sprintLabelNamed: '{sprint} {name}',
  sprintLabelPeriod: '{sprint} {start}〜{end}',
  sprintPeriod: '{start}〜{end}',
  sprintLengthDays: '{length} 日',
  sprintActive: '進行中',
  sprintEmptyTitle: 'まだ{sprint}がありません',
  sprintEmptyText:
    '{sprint}は、期間を区切って{task}を進める単位です。作ると、ここに先の{sprint}が並び、入れた{points}と{capacity}を見比べられます。終えた{sprint}がたまると、ベロシティも出ます。',
  // リーダーでない人の空の状態。作り方の案内の代わりに、作るのは誰かを添える
  sprintEmptyMemberText: '{sprint}は、期間を区切って{task}を進める単位です。{sprint}を作るのは{leader}です。',
  sprintEmptyClosedText: '終了した{workspace}には、{sprint}を作れません。',
  // 先のスプリントが無いが、ベロシティかエピックの集計は出すときの空の状態（リーダー向けの文は、ベロシティが出ているときの言い回し）
  planLanesEmptyTitle: '先の{sprint}はありません',
  planLanesEmptyText: '{sprint}を作ると、ここに先の{sprint}が並び、入れた{points}をベロシティと見比べられます。',
  sprintEditAction: '直す',
  sprintEditLabel: '直す: {label}',
  sprintDeleteAction: '削除する',
  sprintDeleteLabel: '削除する: {label}',
  sprintFieldStart: '開始日',
  sprintFieldLength: '長さ（日）',
  sprintFieldEnd: '最終日',
  sprintFieldName: '名前（任意）',
  sprintNamePlaceholder: '空なら期間を名前にします',
  sprintFormHint: '長さは {min}〜{max} 日。作ったあと、{backlog}から{task}を入れてから始めます。',
  sprintStartRequired: '開始日を入れてください',
  sprintLengthInvalid: '長さは {min}〜{max} の整数で入れてください',
  sprintEndOutOfRange: '最終日が暦の範囲を外れます',
  sprintNameTooLong: '名前は {max} 字までです',
  sprintNameInvalidCharacter: '名前に使えない文字（制御文字や見えない文字）が入っています',
  sprintOverlap: '期間が、ほかの{sprint}と重なっています。開始日か長さを変えてください',
  sprintStarted: 'この{sprint}はもう始まっているので、直せません。一覧を読み直します',
  sprintGone: 'この{sprint}は見つかりません。一覧を読み直します',
  sprintForbidden: '{sprint}を作り、直し、削除するのは{leader}です',
  sprintBadRequest: '入力を受け付けられませんでした。値を見直してください',
  sprintCreateSubmit: '作る',
  sprintCreating: '作っています',
  sprintCreated: '{sprint}を作りました',
  sprintCreateFailed: '作れませんでした。もう一度試してください',
  sprintSave: '保存する',
  sprintSaving: '保存しています',
  sprintSaved: '{sprint}を保存しました',
  sprintSaveFailed: '保存できませんでした。もう一度試してください',
  sprintDeleteTitle: '{sprint}を削除する',
  sprintDeleteText: '「{label}」（{period}）を削除します。削除したものは画面から消え、この版では戻せません。',
  sprintDeleting: '削除しています',
  sprintDeleted: '{sprint}を削除しました',
  sprintDeleteStarted: 'この{sprint}はもう始まっているので、削除できません。一覧を読み直します',
  sprintDeleteFailed: '削除できませんでした。もう一度試してください',
  // 計画の画面のスプリントの行に入っているタスク、外す操作、「バックログから入れる」のダイアログ（design/plan.html）
  sprintTasksEmpty: 'まだ何も入っていません',
  sprintTasksSummary: '{count} 件・{points} pt',
  sprintTaskAddOpen: '{backlog}から入れる',
  sprintTaskAddOpenLabel: '{backlog}から入れる: {label}',
  sprintTaskAddTitle: '{label} に入れる',
  sprintTaskAddHint:
    '{story}を選ぶと、配下の未完了の{task}をまとめて入れます。ほかの{sprint}に入っている{task}は、こちらへ移します。',
  sprintTaskAddStoryMeta: '未完了の{task} {count} 件',
  sprintTaskAddRootTasks: '親のない{task}',
  sprintTaskAddInSprint: '{label} から移します',
  sprintTaskAddNothing: '入れられる未完了の{task}がありません。{backlog}で起票してください。',
  sprintTaskAddSubmit: '{count} 件入れる',
  sprintTaskAddNoneSelected: '入れる{task}か{story}を選んでください',
  sprintTaskAddTooMany: '1回に入れられる{task}は {max} 件までです。選ぶ数を減らしてください',
  sprintTaskAdding: '入れています',
  sprintTaskAdded: '{count} 件入れました',
  sprintTaskSkippedCompleted: '{count} 件は{done}済みのため入れませんでした',
  sprintTaskSkippedUnavailable: '{count} 件は見つからないため入れませんでした',
  sprintTaskSkippedAlready: '{count} 件は既に入っていました',
  sprintTaskClosed: 'この{sprint}は終了しているので、中身を変えられません。一覧を読み直します',
  sprintTaskAddCompleted: '{done}済みの{task}は入れられません。一覧を読み直します',
  sprintTaskAddGone: '{task}か{sprint}が見つかりません。一覧を読み直します',
  sprintTaskAddFailed: '入れられませんでした。もう一度試してください',
  sprintTaskTreeFailed: '{backlog}を読み込めませんでした',
  sprintTaskRemoveLabel: '外す: {title}',
  sprintTaskRemove: '外す',
  sprintTaskRemoving: '外しています',
  sprintTaskRemoved: '「{title}」を外しました',
  sprintTaskRemoveCompleted: '{done}済みの{task}は外せません。外すには、先に{done}を戻してください。一覧を読み直します',
  sprintTaskRemoveGone: 'この{task}はもう入っていません。一覧を読み直します',
  sprintTaskRemoveFailed: '外せませんでした。もう一度試してください',
  // バックログの木の行と、タスクの詳細の、入っているスプリント
  sprintNone: '{backlog}',
  sprintPlanNote: '{plan}の画面で出し入れします',
  // 始まっていないスプリントの中で完了にして、スプリントから外れた（task-complete の left_sprint）
  taskLeftPlannedSprint: '始まっていない{sprint}から外れました',
  // スプリントに入れるダイアログ（SprintTaskPicker）の一覧、検索、足元の件数
  sprintTaskPickCount: '{count} 件を選んでいます',
  sprintTaskAddSubmitEmpty: '入れる',
  sprintTaskPickListLabel: '入れる{task}',
  sprintTaskPickSearch: '{task}と{story}のタイトルで絞る',
  sprintTaskPickSearchPlaceholder: 'タイトルで絞る',
  sprintTaskPickNoMatch: '当てはまる{task}がありません',
  // スプリントを始めるダイアログ（kit.js の DIALOGS.sprintStart）と、計画の画面の進行中のスプリントのゴール
  sprintStartAction: '始める',
  sprintStartLabel: '始める: {label}',
  sprintStartTitle: '{sprint}を始める',
  sprintStartText: '{label}（{period}）を始めます。入っている{task}は {count} 件、{points} pt です。',
  sprintStartUnestimated: '未見積もりが {count} 件あります。始めることはできます。',
  sprintStartGoalPlaceholder: 'この{sprint}で何ができるようになるか',
  sprintStartGoalHint: '空でも始められます。{max} 字まで書け、{plan}と{sprint}の画面に出ます。',
  sprintStartGoalTooLong: '{sprintGoal}は {max} 字までです',
  sprintStartGoalInvalidCharacter: '{sprintGoal}に使えない文字が含まれています',
  sprintStartSubmit: '始める',
  sprintStarting: '始めています',
  sprintStartDone: '{sprint}を始めました',
  sprintStartFailed: '始められませんでした。もう一度試してください',
  // 進行中の{sprint}が既にあるとき。ダイアログを開いた時点で分かれば、押す前から出す
  sprintStartActiveExists: '進行中の{sprint}があるので、始められません。終えてから始めてください',
  // 最終日がワークスペースの今日より前のスプリント。期間を直すか、削除して作り直す
  sprintStartEnded: 'この{sprint}は最終日を過ぎているので、始められません。期間を直すか、削除して作り直してください',
  sprintStartAlreadyStarted: 'この{sprint}はもう始まっています。一覧を読み直します',
  sprintStartForbidden: '{sprint}を始めるのは{leader}です',
  // 進行中のスプリントを延ばすダイアログ（kit.js の DIALOGS.sprintExtend）と、スプリントの画面の見出しの「延長する」と「名前とゴールを変更」
  sprintExtendAction: '延長する',
  sprintExtendSubmit: '{days} 日延長する',
  sprintExtendTitle: '{sprint}を延ばす',
  sprintExtendDays: '延ばす日数',
  sprintExtendRange: '1〜{max} 日',
  sprintExtendEnd: '新しい最終日',
  // ずれる{sprint}ごとの、今の期間 → 新しい期間と、ずれる日数
  sprintExtendShift: '{before} → {after}',
  sprintExtendShiftDays: '（{days} 日）',
  sprintExtendNoShift: '後ろの{sprint}は動きません',
  sprintExtendShiftMore: 'ほか {count} 本の{sprint}も、重なる分だけ後ろへずらします',
  // 予告の読み上げ。押し出す行を全部読むと長いので、新しい最終日とずらす本数だけを伝える
  sprintExtendPreviewSummary: '新しい最終日は {end}。後ろの{sprint}を {count} 本ずらします',
  sprintExtendVelocity: '延ばした{sprint}はベロシティの計算から除きます。',
  sprintExtended: '延長 {days} 日',
  sprintExtending: '延長しています',
  sprintExtendDone: '{sprint}を {days} 日延長しました',
  sprintExtendInvalid: '延ばす日数は 1〜{max} 日の整数で入力してください。全体の長さは{limit}日までです。',
  sprintExtendLimit: '長さが{limit}日のため、これ以上延長できません。',
  sprintExtendLoadFailed: '期間を読み込めませんでした。もう一度試してください。',
  sprintExtendFailed: '延長できませんでした。もう一度試してください。',
  sprintExtendNotActive: 'この{sprint}は進行中ではありません。画面を読み直しました。',
  sprintExtendChanged: '期間が変わりました。新しい期間を確かめて、もう一度試してください。',
  sprintEditActive: '名前と{sprintGoal}を変更',
  sprintEditGoalHint: '{max} 字まで。空にすると消えます',
  // スプリントを終えるダイアログ（kit.js の DIALOGS.sprintEnd）と、スプリントの画面の見出しの「終える」
  sprintCloseAction: '終える',
  sprintCloseLabel: '終える: {label}',
  sprintCloseTitle: '{sprint}を終える',
  sprintCloseText: '{label}を終えます。終えた{sprint}の期間と中身は、あとから変えられません。',
  // 名前のあるスプリントの呼び名に期間を添える。名前の無いスプリントは期間が名前なので、期間を重ねない（sprintLabelWithPeriod）
  sprintLabelWithPeriod: '{label}（{period}）',
  sprintCloseLoadFailed: '{sprint}の状態を読み込めませんでした。もう一度試してください',
  sprintCloseCarryLegend: '終わらなかった{task} {count} 件の行き先',
  sprintCloseCarryTo: '{label}へ持ち越す',
  sprintCloseCarryToNote: '同じ{task}をそのまま移します。',
  sprintCloseCarryBacklog: '{backlog}へ戻す',
  sprintCloseCarryBacklogNote: 'どの{sprint}にも入っていない状態にします。',
  sprintCloseCarryNoTarget: '持ち越せる{sprint}がありません。{backlog}へ戻します。',
  sprintCloseNoOpen: '終わらなかった{task}はありません。',
  sprintCloseGoalLegend: '{sprintGoal}は達成できましたか',
  sprintCloseGoalAchieved: '達成した',
  sprintCloseGoalMissed: '達成していない',
  sprintCloseSubmit: '終える',
  sprintClosing: '終えています',
  sprintClosedNone: '{label}を終えました',
  sprintClosedToSprint: '{label}を終えました。{task} {count} 件を{target}へ持ち越しました',
  sprintClosedToBacklog: '{label}を終えました。{task} {count} 件を{backlog}へ戻しました',
  sprintCloseNotActive: 'この{sprint}は進行中ではありません（もう終わっています）。読み直します',
  sprintCloseCarryTarget: '持ち越し先が使えなくなりました。選び直してください',
  sprintCloseChanged: '終える間に{task}が変わりました。読み直したので、行き先を確かめてもう一度押してください',
  sprintCloseForbidden: '{sprint}を終えるのは{leader}です',
  sprintCloseFailed: '終えられませんでした。もう一度試してください',
  // 最終日を過ぎた進行中のスプリントの知らせ（スプリントの画面と計画の画面）。終えるのはリーダー
  sprintOverdueLeader: '{label}は最終日（{end}）を過ぎています。終わらなかった{task}の行き先を決めて、終えてください。',
  sprintOverdueMember: '{label}は最終日（{end}）を過ぎています。終えるのは{leader}です。',
  // スプリントの画面（design/sprint.html）。見出しは進行中のスプリントの名前、小見出しは期間と何日目か
  sprintBoardPageName: '{name}・{workspace}',
  sprintBoardEyebrow: '{period}・{length} 日のうち {day} 日目',
  sprintBoardTallyDone: '{done}（pt）',
  sprintBoardTallyTotal: '合計（pt）',
  sprintBoardTallyRemaining: '残り（日）',
  sprintBoardRegion: '{sprint}の{column}とカード',
  sprintBoardColumnEmpty: 'なし',
  sprintBoardColumnPoints: '{points} pt',
  sprintBoardKeyHint:
    'カードを別の{column}へドラッグして移すか、カードを選んで Alt と ← → で隣の{column}、Alt と ↑ ↓ で{column}の中を動かせます。カードの下のボタンでも同じです。{done}の{column}の手前の{column}から次へ送ると、{done}になります。',
  sprintBoardEmptyTitle: '進行中の{sprint}はありません',
  sprintBoardEmptyLeaderText:
    '{plan}の画面で{sprint}を作り、{backlog}から{task}を入れてから始めます。始めると、ここに{column}とカードが並びます。',
  sprintBoardEmptyMemberText:
    '{sprint}を作って始めるのは{leader}です。{sprint}に入っていない{task}も、{backlog}から進めて{done}にできます。',
  sprintBoardEmptyClosedText: '終了した{workspace}では、{sprint}を始められません。',
  sprintBoardOpenPlan: '{plan}を開く',
  sprintBoardOpenBacklog: '{backlog}を開く',
  // カードの移動。ボタンの読み上げの名前は、同じ名前が並ぶので題を添える
  moveColumnPrev: '前の{column}へ',
  moveColumnNext: '次の{column}へ',
  moveColumnPrevLabel: '前の{column}へ: {title}',
  moveColumnNextLabel: '次の{column}へ: {title}',
  // 最後の完了でない列のカードの「次の列へ」。完了の列へ移す代わりに完了にする
  moveColumnComplete: '{done}の{column}へ（{complete}）',
  moveColumnCompleteLabel: '{done}の{column}へ（{complete}）: {title}',
  // 選んだカードの説明（aria-describedby）。{points} はポイントか未見積もりの文
  sprintCardSummary: '{points}、{assignee}は{name}',
  sprintCardSummaryUnassigned: '{points}、{unassigned}',
  // 動かした後の読み上げ。{index} は移した先の{column}の中で何番目か、{total} はその件数
  sprintCardMoved: '「{title}」を{column}の {index} 番目に移しました（{total} 件中）',
  sprintCardNoPrevColumn: 'これより前の{column}はありません',
  // 次の{column}が無い（完了の列が無い）ときだけ。最後の完了でない列の「次の列へ」は完了にする
  sprintCardNoNextColumn: 'これより後の{column}はありません',
  sprintCardMoveDoneColumn: '{done}の{column}へは、ここから移せません。一覧を読み直します',
  sprintCardMoveNotActive: 'この{sprint}はもう進行中ではありません。一覧を読み直します',
  sprintCardMoveGone: 'この{task}か{column}が見つかりません。一覧を読み直します',
  sprintCardMoveFailed: '動かせませんでした。一覧を読み直します',
  sprintCardCompleting: '{done}にしています',
  sprintCardReopening: '{done}を戻しています',
  // 完了か戻しを送っている間に押された、もう1つの完了か戻し。送らずに捨てたことを読み上げる
  sprintCardBusyCompleting: '{done}にしています。終わってからもう一度試してください。',
  sprintCardBusyReopening: '{done}を戻しています。終わってからもう一度試してください。',
  // 完了を戻して、{column}へ移した（task-reopen）
  sprintCardReopened: '「{title}」の{done}を戻し、{column}へ移しました',
  // 経験値とレベル（kit.js の levelPanel と emblem、me.html の「経験値の明細」）。経験値の数値と明細は本人にだけ出す
  levelLabel: 'レベル {level}',
  levelShort: 'LV',
  levelPanelTitle: 'レベル',
  levelPanelNote: '経験値は本人だけに見えます',
  xpUnit: 'XP',
  levelToNext: '次のレベルまで',
  levelProspect: '見込み',
  levelSubSeparator: '・',
  levelGaugeLabel: '次のレベルまでの {confirmed}% を確定、{prospective}% が見込み',
  levelLegendConfirmed: '確定',
  levelLegendProspect: '見込み（{task}の{done}で確定）',
  levelBreakdownLabel: '{workspace}ごとの経験値',
  levelBreakdownTotal: 'すべての{workspace}',
  levelLoadFailed: 'レベルを読み込めませんでした',
  levelThanksReceived: '受け取った感謝',
  xpPlus: '+{value}',
  meExperienceTitle: '経験値の明細',
  meExperienceDescription: '本人だけが見られます。打ち消しは負の値で残ります。手で足し引きする操作はありません。',
  xpHeaderConfirmedAt: '確定日時',
  xpHeaderAction: '行動',
  xpHeaderContent: '内容',
  xpNoContent: '（なし）',
  xpActionTaskCreated: '起票',
  xpActionTaskDetailed: '詳細',
  xpActionTaskCompleted: '完了',
  xpActionReview: 'レビュー',
  xpActionHelp: '手助け',
  xpActionStoryCompleted: 'ストーリーの完了',
  xpActionEpicReward: 'クリア報酬',
  xpActionReversal: '{action}の打ち消し',
  xpEmptyTitle: '経験値の明細はまだありません',
  xpEmptyText: '{task}を{complete}と、起票や{done}の経験値がここに並びます。',
  xpContentHidden: '（今所属していない{workspace}の内容は表示しません）',
  retrySection: 'もう一度試す（{section}）',
  meOtherSettingsNote:
    '今は経験値と API トークンだけを扱えます。1日の基準、休み、テーマなどの設定は、これから足します。',
  // API トークン（自分の設定の節。docs/development.md の「API トークン」）。組織の外の画面なので、言葉は organization
  apiTokenTitle: 'API トークン',
  apiTokenDesc: 'CLI や MCP に渡す鍵。発行した人と同じ権限の範囲で、画面を通さずに API を呼べます。',
  apiTokenFormLabel: 'API トークンの発行',
  apiTokenNameLabel: '名前',
  apiTokenNameHint: '何に使う鍵か分かる名前（{max}文字まで）',
  apiTokenScopeLabel: '範囲',
  apiTokenScopeRead: '読み取り',
  apiTokenScopeWrite: '書き込み',
  apiTokenScopeHint: '読み取りは見るだけ。書き込みは、あなたの権限で変えることもできます。',
  apiTokenLifetimeLabel: '有効日数',
  apiTokenLifetimeHint: '1〜{max}日。期限が来ると使えなくなります',
  apiTokenCreate: '発行する',
  apiTokenCreating: '発行しています',
  apiTokenNameRequired: '名前を入力してください',
  apiTokenNameTooLong: '名前は{max}文字までです',
  apiTokenLifetimeInvalid: '有効日数は1〜{max}の整数で入力してください',
  apiTokenLimitReached: '発行できるトークンは{max}件までです。使わないものを取り消してください',
  apiTokenLoaded: 'API トークンの一覧を読み込みました',
  apiTokenCreateFailed: '発行できませんでした。時間をおいて、もう一度試してください',
  apiTokenIssuedTitle: 'API トークンを発行しました',
  apiTokenIssuedLead: '「{name}」の値です。',
  apiTokenValueLabel: 'トークンの値',
  apiTokenCopy: 'コピーする',
  apiTokenCopied: 'トークンの値をコピーしました',
  apiTokenCopyFailed: 'コピーできませんでした。値を選んで、手でコピーしてください',
  apiTokenOnce: 'この値は二度と見られません。閉じる前にコピーして、安全な場所に保管してください。',
  apiTokenIssuedExpires: '{expires} まで使えます。',
  apiTokenListLabel: '発行済みの API トークン',
  apiTokenHeaderExpires: '期限',
  apiTokenHeaderLastUsed: '最後に使った日',
  apiTokenActionsHeader: '操作',
  apiTokenNeverUsed: '未使用',
  apiTokenRevoke: '取り消す',
  apiTokenRevokeLabel: 'API トークン「{name}」を取り消す',
  apiTokenRevokeTitle: 'API トークン「{name}」を取り消しますか',
  apiTokenRevokeText:
    '取り消すと、このトークンはすぐ使えなくなります。元に戻せません。使っている CLI や MCP は、新しく発行したトークンに替えてください。',
  apiTokenRevoking: '取り消しています',
  apiTokenRevoked: '「{name}」を取り消しました',
  apiTokenRevokeFailed: '取り消せませんでした。時間をおいて、もう一度試してください',
  apiTokenEmptyTitle: '発行済みの API トークンはありません',
  apiTokenEmptyText: '上のフォームで発行すると、ここに並びます。',
  apiTokenLoadFailed: 'API トークンを読み込めませんでした',
  xpLedgerFailedTitle: '経験値の明細を読み込めませんでした',
  xpLoadMore: '続きを読む',
  xpLoadMoreFailed: '続きを読み込めませんでした。もう一度試してください',
  xpAllLoaded: '明細をすべて表示しました',
  teamXpLabel: 'チーム全体の経験値',

  // 日付に曜日を添える（kit.js の withWeekday）。曜日は 0 が日曜
  dateWithWeekday: '{date}（{weekday}）',
  weekday0: '日',
  weekday1: '月',
  weekday2: '火',
  weekday3: '水',
  weekday4: '木',
  weekday5: '金',
  weekday6: '土',

  // Markdown の本文。変換が終わらなかった本文を、書かれたまま出すときの注記
  markdownPlainNote: '整形せずに表示しています',
  // リンクは新しいタブで開く。リンクの補足（aria-describedby）として読み上げに伝える
  markdownNewTab: '新しいタブで開きます',
  // 横にスクロールするコードと表の枠の名前。キーボードで枠にフォーカスを置いて動かすため、読み上げに名前を伝える
  markdownCodeRegion: 'コード',
  markdownTableRegion: '表',

  // 完成の定義（設定の画面の節、詳細の引き出しの完了の操作の横、バックログの画面の上、スプリントの画面の完了の列）。
  // {dod} は辞書の言葉を画面が渡す
  dodDesc:
    'すべての{task}に共通する完了の基準。{backlog}の上と、{sprint}の{done}の{column}と、完了の操作の横に出します。',
  dodFieldLabel: 'Markdown',
  dodHint: 'Markdown で書けます。空にして保存すると、どこにも出しません。',
  dodSave: '保存する',
  dodSaving: '{dod}を保存しています',
  dodSaved: '{dod}を保存しました',
  dodCleared: '{dod}を空にしました',
  dodUnchanged: '保存した内容から変わっていません',
  // {max} は桁区切りの数（100,000）を画面が渡す
  dodTooLong: '{dod}は {max} 字までです',
  dodInvalidCharacter: '{dod}に使えない文字が含まれています',
  dodSaveFailed: '{dod}を保存できませんでした。もう一度「保存する」を押してください。',
  // 403 と 404（リーダーでなくなった、ワークスペースが見つからない）。枠を読み直す
  dodUnavailable: '保存できませんでした。操作できない状態です。画面を読み直しました。',
  // ほかの画面で同時に書かれて、やり直しても書けなかった（409 の conflict）。書いた文は欄に残す
  dodConflict: 'ほかの画面で同時に変わったため、保存できませんでした。もう一度「保存する」を押してください。',
  dodEmptyReadOnly: 'まだ{dod}がありません。',
  // 詳細の引き出しの完了の印の横。{at} は完了した日時
  taskCompletedAt: '{done} {at}',

  // ワークスペースの設定の画面（/[slug]/w/[id]/settings。見本は design/settings.html）
  settingsPageName: '{settings}・{name}',
  settingsForbiddenTitle: 'この画面には入れません',
  settingsForbiddenText: '{settings}を開けるのは{leader}と{admin}だけです。',
  repository: 'リポジトリ',
  categoriesDesc:
    '{epic}に振ると配下が引き継ぎます。「月ごとに計上する」{category}は、完了の記録に計上月を持ちます。切り替えても、すでにある完了の記録の計上月は変わりません。',
  repositoriesDesc: '{task}がどのリポジトリの作業かを示します。{task}に1つまで振れ、起票のときにボタンで選びます。',
  categoryBilledMonthly: '月ごとに計上する',
  categoryBilledMonthlyLabel: '月ごとに計上する: {name}',
  definitionListLabel: '{kind}の一覧',
  definitionEmptyTitle: 'まだ{kind}がありません',
  definitionEmptyText: '下の欄から足せます。',
  definitionEmptyReadOnly: 'まだ{kind}がありません。',
  definitionNewLabel: '新しい{kind}の名前',
  definitionAdd: '{kind}を足す',
  definitionRenameHint: '名前を直す',
  definitionNameLabel: '{kind}の名前',
  definitionDuplicate: '同じ名前の{kind}があります',
  definitionLimit: '{kind}は {max} 件までです。使わないものを削除してから足してください',
  definitionBadRequest: '名前に使えない文字が含まれています',
  definitionSaveFailed: '{kind}を保存できませんでした。もう一度試してください。',
  definitionSaved: '「{name}」を保存しました',
  definitionAddNotFound: '足せませんでした。画面を読み直します',
  definitionDeleting: '{kind}を削除しています',
  definitionDeleteAction: '削除',
  definitionDeleteConfirm: '削除する',
  settingsRefreshFailed: '一覧を更新できませんでした',
  settingsRefreshed: '一覧を更新しました',
  settingsBackToBacklog: '{backlog}へ戻る',
  definitionsLoadFailed: '{category}とリポジトリの一覧を読み込めませんでした。',
  repositoryEmptyHint: 'リポジトリは{leader}が{settings}の画面で足せます。',
  categoryCurrentUnread: '今の{category}（一覧を読み込めませんでした）',
  definitionAdded: '「{name}」を足しました',
  definitionSaving: '{kind}を保存しています',
  definitionGone: 'この{kind}はほかの画面で削除されています。一覧を読み直します',
  definitionChanged: 'ほかの画面で変わったため、できませんでした。一覧を読み直します',
  definitionMoved: '「{name}」を {position} 番目に移しました',
  definitionMoveFailed: '移せませんでした。一覧を読み直します',
  definitionDeleteLabel: '削除: {name}',
  definitionDeleteTitle: '「{name}」を削除する',
  categoryDeleteText:
    '振っていた{epic}、{story}、{task}は{category}なしに戻ります。完了の記録は元の{category}のまま残ります。',
  repositoryDeleteText: '振っていた{task}はリポジトリなしに戻ります。',
  definitionDeleted: '「{name}」を削除しました',
  definitionDeleteFailed: '削除できませんでした。もう一度試してください。',
  // 起票のダイアログ、エピックとストーリーのダイアログ、詳細の引き出しの区分とリポジトリ
  categoryNone: '{category}なし',
  categoryInherited: '親から引き継ぎ',
  repositoryNone: 'なし',
  repositoryHint: '複数のリポジトリにまたがる作業は、リポジトリごとに{task}を分けます。',
  categoryHasParent: '親のある{task}には{category}を振れません。親の{category}を引き継ぎます。',
  definitionRefGone: '選んだ{kind}は削除されています。選び直してください',
  // 木の行の区分とリポジトリの印。見えない文字で種類を添える
  chipPrefix: '{kind}：',

  // ワークスペースの設定の画面の列の節（見本は design/settings.html の列）。リーダーが付けた列の名前は辞書を通さず
  // そのまま出し、完了の列だけ辞書の名前（done）を出す
  columnsDesc:
    '{sprint}の{column}。名前は付けたままで、訳しません。{task}が残っている{column}を削除するときは移し先を選びます。',
  columnDoneNote: '常に末尾',
  columnTaskCount: '削除すると {count} 件を移す',
  columnNameRequired: '名前を入れてください',
  columnNameTooLong: '名前は {max} 字までです',
  columnNameInvalidCharacter: '名前に使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
  columnSaveChanged: 'ほかの画面で変わったため、保存できませんでした。もう一度試してください',
  columnDeleteLastHint: '最後の{column}は削除できません',
  columnDeleteText:
    '{count} 件の{task}が残っています。移し先の{column}を選んでください。{sprint}ごとに、移し先の末尾へ今の順で移ります。終了した{sprint}の{task}は変わりません。',
  columnDeleteTextEmpty: '移す{task}はありません。終了した{sprint}の{task}は変わりません。',
  columnDeleteTarget: '移し先の{column}',
  columnDeletedMoved: '「{name}」を削除し、{count} 件の{task}を「{target}」へ移しました',
  columnDeleteLast: '最後の{column}は削除できません。一覧を読み直します',
  columnDeleteTargetRequired:
    '確かめている間に{task}が入りました。もう一度、移し先を選んでください。一覧を読み直します',
  columnDeleteTargetInvalid: '移し先に選べない{column}です。選び直してください。一覧を読み直します',
  columnDeleteNotFound: '削除する{column}か移し先の{column}が見つかりません。一覧を読み直します',
});

export type DictionaryKey = keyof typeof dictionary;

export type TemplateParams = Record<string, string | number>;

// {名前} を params の値で埋める。params に無い名前はそのまま残す（欠けに気づけるように）
export function format(template: string, params: TemplateParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export function word(key: DictionaryKey, params?: TemplateParams): string {
  return format(dictionary[key], params);
}
