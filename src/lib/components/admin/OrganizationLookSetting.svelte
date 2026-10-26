<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import type { InputOf } from '../../../shared/operations/define.ts';
  import { organizationSettingsUpdate } from '../../../shared/operations/organization/index.ts';
  import { themeLabelKeys, themeNoteKeys, themes, type Theme } from '../../../shared/theme.ts';
  import type { Vocabulary } from '../../../shared/vocabulary.ts';
  import { callOperation } from '../../api.ts';
  import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';
  import { showToast } from '../../toast.svelte.ts';
  import { t, tIn } from '../../vocabulary.svelte.ts';
  import Icon from '../Icon.svelte';
  import Setting from '../Setting.svelte';

  // 組織の管理の画面（admin.html）の「ワークスペースの外の言葉づかい」と「既定のテーマ」の2つの節。
  // 値は組織の枠が読んだ値（organization 操作の結果）を受け取り、節は自分で読まない。
  // 選ぶことと確定することを分ける（矢印のキーでラジオを動かすたびに、組織の全員の既定を変えない）。節ごとの「保存する」は、
  // 選んだ値が今の値と違うときだけ押せる。送っている間はそのボタンを aria-disabled にして押しても無視し、ラジオは選べたままにする
  // （結果は送った値で判断する）。通ったら知らせを出し、組織の枠を読み直して自分の画面にも当てる（テーマは自分で選んでいなければ変わる）。
  // 409（ほかの管理者が先に変えた）と 403、404 は知らせて読み直し、今の値を見せる。401 はログインへ。
  // ほかの失敗（通信、5xx）は選んだ値を残して知らせ、そのまま押し直せる。
  // 失敗の知らせは、トーストでなく節の中（role="alert"）に、次に選ぶか押すまで残す（消えると、失敗したのか未操作なのか分からない）
  let { slug, vocabulary, theme }: { slug: string; vocabulary: Vocabulary; theme: Theme } = $props();

  type Field = 'vocabulary' | 'theme';
  type Values = { vocabulary: Vocabulary; theme: Theme };

  const ids = $props.id();
  // 選んだがまだ保存していない値。null は選んでいない（今の値を見せる）
  let drafts = $state<{ vocabulary: Vocabulary | null; theme: Theme | null }>({ vocabulary: null, theme: null });
  // 送っている値。節ごとに持つ
  let sending = $state<{ vocabulary: Vocabulary | null; theme: Theme | null }>({ vocabulary: null, theme: null });
  // 節ごとの失敗の知らせ。次に選ぶか押すまで残す
  let errors = $state<{ vocabulary: string | null; theme: string | null }>({ vocabulary: null, theme: null });

  const current = $derived<Values>({ vocabulary, theme });
  const chosen = $derived<Values>({
    vocabulary: drafts.vocabulary ?? vocabulary,
    theme: drafts.theme ?? theme,
  });
  const vocabularies: readonly Vocabulary[] = ['game', 'scrum'];

  // slug が替わったら、前の組織で選んだ値を捨てる
  $effect(() => {
    void slug;
    drafts = { vocabulary: null, theme: null };
    errors = { vocabulary: null, theme: null };
  });

  function vocabularyLabel(value: Vocabulary): string {
    return t(value === 'game' ? 'vocabularyGameLabel' : 'vocabularyScrumLabel');
  }

  // その言葉づかいでの組織と管理者の呼び方（冒険者ギルド、ギルドマスター / 組織、管理者）
  function vocabularyExample(value: Vocabulary): string {
    const scope = { organization: value };
    return tIn('orgVocabularyNote', scope, {
      organization: tIn('organization', scope),
      admin: tIn('admin', scope),
    });
  }

  function choose(field: Field, value: string): void {
    drafts = { ...drafts, [field]: value };
    errors = { ...errors, [field]: null };
  }

  function canSave(field: Field): boolean {
    return sending[field] === null && chosen[field] !== current[field];
  }

  // 送った値のままなら、選んだ値を捨てて受け取った値（読み直した組織の枠の値）を見せる。送っている間に選び直していれば残す
  function dropDraft(field: Field, sent: string): void {
    if (drafts[field] === sent) drafts = { ...drafts, [field]: null };
  }

  async function save(field: Field): Promise<void> {
    if (!canSave(field)) return;
    const sentSlug = slug;
    const value = chosen[field];
    // 見ていた値（from）も送る。ほかの管理者が先に変えていれば 409 になり、気づかずに上書きしない
    const change = { [field]: { from: current[field], to: value } } as InputOf<typeof organizationSettingsUpdate>;
    // 知らせの文言は、送る前の言葉づかいで決める（言葉づかいを変えると、読み直した後は新しい言葉になる）
    const success =
      field === 'vocabulary'
        ? t('orgVocabularyChanged', { label: vocabularyLabel(value as Vocabulary) })
        : t('orgThemeChanged', { label: t(themeLabelKeys[value as Theme]) });
    sending = { ...sending, [field]: value };
    errors = { ...errors, [field]: null };
    try {
      const result = await callOperation(organizationSettingsUpdate, change, { slug: sentSlug });
      if (sentSlug !== slug) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.ok) {
        showToast(success, 'check');
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        errors = { ...errors, [field]: t('orgSettingsConflict', { admin: t('admin') }) };
      } else if (result.status === 403 || result.status === 404) {
        errors = { ...errors, [field]: t('orgSettingsUnavailable') };
      } else {
        // 選んだ値は残し、そのまま押し直せる
        errors = { ...errors, [field]: t('orgSettingsFailed') };
        return;
      }
      await invalidateAll();
      if (sentSlug === slug) dropDraft(field, value);
    } finally {
      sending = { ...sending, [field]: null };
    }
  }

  const status = $derived(sending.vocabulary !== null || sending.theme !== null ? t('orgSettingsSaving') : '');
</script>

<Setting
  title={t('orgVocabularyTitle', { workspace: t('workspace') })}
  description={t('orgVocabularyDesc', { workspace: t('workspace'), leader: t('leader') })}
>
  <div class="choice-list" role="radiogroup" aria-label={t('orgVocabularyTitle', { workspace: t('workspace') })}>
    {#each vocabularies as value (value)}
      <label class="choice">
        <input
          type="radio"
          name="{ids}-vocabulary"
          {value}
          checked={chosen.vocabulary === value}
          onchange={() => choose('vocabulary', value)}
        />
        <div><b>{vocabularyLabel(value)}</b><span>{vocabularyExample(value)}</span></div>
      </label>
    {/each}
  </div>
  <div class="form-actions">
    <button class="btn" type="button" aria-disabled={!canSave('vocabulary')} onclick={() => save('vocabulary')}>
      {sending.vocabulary !== null ? t('orgSettingsSaving') : t('orgSettingsSave')}
      <!-- 2つの節に同じ「保存する」が並ぶので、読み上げの名前にどの節のものかを足す（見える文字は名前の先頭に残す） -->
      <span class="visually-hidden">{t('orgVocabularyTitle', { workspace: t('workspace') })}</span>
    </button>
  </div>
  <!-- 失敗の知らせ。領域は常に置き、中の文字だけを替える -->
  <div role="alert">
    {#if errors.vocabulary !== null}<span class="field-error"><Icon name="alert" />{errors.vocabulary}</span>{/if}
  </div>
</Setting>

<Setting title={t('orgThemeTitle')} description={t('orgThemeDesc')}>
  <div class="choice-list" role="radiogroup" aria-label={t('orgThemeTitle')}>
    {#each themes as value (value)}
      <label class="choice">
        <input
          type="radio"
          name="{ids}-theme"
          {value}
          checked={chosen.theme === value}
          onchange={() => choose('theme', value)}
        />
        <div><b>{t(themeLabelKeys[value])}</b><span>{t(themeNoteKeys[value])}</span></div>
      </label>
    {/each}
  </div>
  <div class="form-actions">
    <button class="btn" type="button" aria-disabled={!canSave('theme')} onclick={() => save('theme')}>
      {sending.theme !== null ? t('orgSettingsSaving') : t('orgSettingsSave')}
      <span class="visually-hidden">{t('orgThemeTitle')}</span>
    </button>
  </div>
  <!-- 失敗の知らせ。領域は常に置き、中の文字だけを替える -->
  <div role="alert">
    {#if errors.theme !== null}<span class="field-error"><Icon name="alert" />{errors.theme}</span>{/if}
  </div>
  <!-- 送っている間の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Setting>
