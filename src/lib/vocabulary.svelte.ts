import {
  defaultVocabularies,
  word,
  type DictionaryKey,
  type TemplateParams,
  type Vocabularies,
  type Vocabulary,
} from '../shared/vocabulary.ts';

const VALUES: readonly unknown[] = ['game', 'scrum'];

// テーマの sg-theme と同じ仕組み。組織の枠が入れた組織の言葉づかいを覚え、次の読み込みの最初の描画から当てる
export const vocabularyStorageKey = 'sg-vocabulary';

// 覚える値は `<言葉づかい>:<組織の slug>`（例 game:aoba）。今開いている URL の組織と同じときだけ使う。
// 別の組織の値で最初の描画が始まり、スクラムの言葉の組織にゲームの言葉が一瞬出るのを防ぐため
function currentSlug(): string | null {
  try {
    return location.pathname.split('/')[1] || null;
  } catch {
    return null;
  }
}

// localStorage を取り出すだけで例外になる環境（権限なし、プライベートモード）、Node のテストでは、覚えていないものとして扱う
function remembered(): Vocabulary | null {
  try {
    const [value, slug] = (localStorage.getItem(vocabularyStorageKey) ?? '').split(':');
    return VALUES.includes(value) && slug !== undefined && slug === currentSlug() ? (value as Vocabulary) : null;
  } catch {
    return null;
  }
}

// 今開いている組織の言葉づかいとして覚える。覚えられなくても、この画面の間は当たっている
export function rememberVocabulary(value: Vocabulary | null): void {
  try {
    const slug = currentSlug();
    if (value && slug) localStorage.setItem(vocabularyStorageKey, `${value}:${slug}`);
    else localStorage.removeItem(vocabularyStorageKey);
  } catch {
    // 覚えない
  }
}

// 今の言葉づかい。組織の枠が、組織の操作の結果を入れる（organization.svelte.ts）。
// 入るまでは、今開いている組織について覚えている言葉づかい、なければ既定のスクラムの言葉
const stored = remembered();
export const vocabularies: Vocabularies = $state(
  stored ? { workspace: stored, organization: stored } : { ...defaultVocabularies },
);

// ワークスペースの中の画面が、そのワークスペースの言葉づかいでワークスペースの言葉を上書きする（src/routes/[slug]/w/[id]/+layout.svelte）。
// 組織の値を入れ直す処理（applyOrganization）が先に走っても、ワークスペースの中にいる間はこちらを使う
let workspaceOverride: Vocabulary | null = $state(null);

function effective(): Vocabularies {
  return workspaceOverride === null ? vocabularies : { ...vocabularies, workspace: workspaceOverride };
}

// テンプレートから呼ぶと、言葉づかいが変わったときに描き直される。{名前} を持つ項目は params で埋める
export function t(key: DictionaryKey, params?: TemplateParams): string {
  return word(key, effective(), params);
}

// 今の言葉づかいとは別の言葉づかいで引く。ワークスペースを作るダイアログが、選んだ言葉づかいの列の名前などを見せるのに使う
export function tIn(key: DictionaryKey, scopes: Partial<Vocabularies>, params?: TemplateParams): string {
  return word(key, { ...effective(), ...scopes }, params);
}

// API の JSON をそのまま渡されても、決まった2つのキーと値だけを入れる
export function setVocabularies(next: Partial<Vocabularies>): void {
  for (const scope of ['workspace', 'organization'] as const) {
    const value = next[scope];
    if (VALUES.includes(value)) vocabularies[scope] = value as Vocabularies[typeof scope];
  }
}

// null でワークスペースの外に戻す（組織の値に従う）
export function setWorkspaceVocabulary(value: unknown): void {
  workspaceOverride = VALUES.includes(value) ? (value as Vocabulary) : null;
}
