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
  import Setting from '../Setting.svelte';

  // 組織の管理の画面（admin.html）の「ワークスペースの外の言葉づかい」と「既定のテーマ」の2つの節。
  // 値は組織の枠が読んだ値（organization 操作の結果）を受け取り、節は自分で読まない。
  // ラジオを選ぶとすぐ送る。送っている間は、両方の節の選択肢を aria-disabled にして選んでも無視する（フォーカスは残す）。
  // 通ったら知らせを出し、組織の枠を読み直して自分の画面にも当てる（テーマは自分で選んでいなければ変わる）。
  // 409（ほかの管理者が先に変えた）は知らせて読み直す。401 はログインへ。ほかの失敗は選択を元の値に戻して知らせる
  let { slug, vocabulary, theme }: { slug: string; vocabulary: Vocabulary; theme: Theme } = $props();

  type Change = InputOf<typeof organizationSettingsUpdate>;

  const ids = $props.id();
  // 送っている項目と値。送っている間は、その値を選んだ状態で見せる。終われば空にし、受け取った値（読み直した組織の枠の値）に戻る
  let pending = $state<Change | null>(null);

  const shownVocabulary = $derived(pending?.vocabulary ?? vocabulary);
  const shownTheme = $derived(pending?.theme ?? theme);
  const busy = $derived(pending !== null);
  const vocabularies: readonly Vocabulary[] = ['game', 'scrum'];

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

  // 送っている間は選んでも無視する。矢印のキーでの移動も click を経るので、ここで止まる
  function guard(event: MouseEvent): void {
    if (busy) event.preventDefault();
  }

  async function send(change: Change): Promise<void> {
    if (busy) return;
    const sentSlug = slug;
    // 知らせの文言は、送る前の言葉づかいで決める（言葉づかいを変えると、読み直した後は新しい言葉になる）
    const success =
      change.vocabulary !== undefined
        ? t('orgVocabularyChanged', { label: vocabularyLabel(change.vocabulary) })
        : t('orgThemeChanged', { label: t(themeLabelKeys[change.theme!]) });
    pending = change;
    try {
      const result = await callOperation(organizationSettingsUpdate, change, { slug: sentSlug });
      if (sentSlug !== slug) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.ok) {
        showToast(success, 'check');
        await invalidateAll();
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        showToast(t('orgSettingsConflict', { admin: t('admin') }), 'alert');
        await invalidateAll();
      } else {
        showToast(t('orgSettingsFailed'), 'alert');
      }
    } finally {
      // 失敗したときと、読み直した値が選んだ値と違うときは、選択が受け取った値に戻る
      pending = null;
    }
  }
</script>

<Setting
  title={t('orgVocabularyTitle', { workspace: t('workspace') })}
  description={t('orgVocabularyDesc', { workspace: t('workspace'), leader: t('leader') })}
>
  <div
    class="choice-list"
    role="radiogroup"
    aria-label={t('orgVocabularyTitle', { workspace: t('workspace') })}
    aria-busy={busy}
  >
    {#each vocabularies as value (value)}
      <label class="choice">
        <input
          type="radio"
          name="{ids}-vocabulary"
          {value}
          checked={shownVocabulary === value}
          aria-disabled={busy}
          onclick={guard}
          onchange={() => send({ vocabulary: value })}
        />
        <div><b>{vocabularyLabel(value)}</b><span>{vocabularyExample(value)}</span></div>
      </label>
    {/each}
  </div>
</Setting>

<Setting title={t('orgThemeTitle')} description={t('orgThemeDesc')}>
  <div class="choice-list" role="radiogroup" aria-label={t('orgThemeTitle')} aria-busy={busy}>
    {#each themes as value (value)}
      <label class="choice">
        <input
          type="radio"
          name="{ids}-theme"
          {value}
          checked={shownTheme === value}
          aria-disabled={busy}
          onclick={guard}
          onchange={() => send({ theme: value })}
        />
        <div><b>{t(themeLabelKeys[value])}</b><span>{t(themeNoteKeys[value])}</span></div>
      </label>
    {/each}
  </div>
  <!-- 送っている間の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{busy ? t('orgSettingsSaving') : ''}</span>
</Setting>
