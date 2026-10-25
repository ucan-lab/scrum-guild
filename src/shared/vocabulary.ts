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
    '作った{workspace}の一覧です。閉じた{workspace}も含みます。{member}の数は{leader}を含みます。',
    '作った{workspace}の一覧です。閉じた{workspace}も含みます。{member}の数は{leader}を含みます。',
  ),
  workspaceListLabel: organization('{workspace}の一覧', '{workspace}の一覧'),
  workspaceEmptyText: organization(
    'チームや用途ごとに作ります。{member}の招待は、作った{workspace}の{leader}が行います。',
    'チームや用途ごとに作ります。{member}の招待は、作った{workspace}の{leader}が行います。',
  ),
  workspaceOpenLabel: organization('開いている{workspace}', '開いている{workspace}'),
  workspaceMemberCountHeader: organization('{member}数', '{member}数'),
  workspaceLeaderCountHeader: organization('{leader}数', '{leader}数'),
  fieldName: organization('名前', '名前'),
  createdOn: organization('作った日', '作った日'),
  workspaceClosedChip: organization('閉じた {date}', '閉じた {date}'),
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
    '閉じた{workspace}には、{task}を作れません。',
    '閉じた{workspace}には、{task}を作れません。',
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
  workspaceClosedReadOnly: workspace('閉じた{workspace}には書き込めません', '閉じた{workspace}には書き込めません'),

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
  operatorSuspended: organization('停止中', '停止中'),
  operatorAdminNone: organization('{admin}がいない', '{admin}がいない'),
  operatorAdminPending: organization('{admin}はログイン待ち', '{admin}はログイン待ち'),

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
  operatorGoogleSoon: organization(
    'Google での指名はまだ使えません。GitHub を選んでください。',
    'Google での指名はまだ使えません。GitHub を選んでください。',
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
  operatorExistingAdminPending: organization(
    '指名された{admin}は、まだログインしていません。',
    '指名された{admin}は、まだログインしていません。',
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
    'ログインできませんでした。どの{organization}の{workspace}にも所属しておらず、招待も届いていません。招待された手段（GitHub か Google）と、招待されたアカウントでログインしているか確かめてください。招待がまだなら、{leader}に GitHub のユーザー名で招待してもらってください。',
    'ログインできませんでした。どの{organization}の{workspace}にも所属しておらず、招待も届いていません。招待された手段（GitHub か Google）と、招待されたアカウントでログインしているか確かめてください。招待がまだなら、{leader}に GitHub のユーザー名で招待してもらってください。',
  ),
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
