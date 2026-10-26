<script lang="ts">
  import type { DefinitionRef } from '../../shared/operations/definition/definition.ts';
  import { withCurrent } from '../definition-options.ts';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の repoPicker。リポジトリを1回押して選ぶボタンの並び（.segmented、role="radiogroup"）。先頭が「なし」。
  // 選んだ値は value（空は null）。選び直すたびに onchange を呼ぶ（起票のダイアログは bind:value で受け、引き出しはその場で保存する）。
  // current は今振っているリポジトリで、候補（repositories）に無い（削除された、一覧を読めなかった）ときも選んだ印を残すために足す。
  // readonly では選べない形（.is-readonly）にし、選んだ値の色は保つ
  let {
    repositories,
    value = $bindable(null),
    current = null,
    labelledBy,
    describedBy,
    readonly = false,
    busy = false,
    onchange,
  }: {
    repositories: readonly DefinitionRef[];
    value?: string | null;
    current?: DefinitionRef | null;
    labelledBy: string;
    describedBy?: string;
    readonly?: boolean;
    // 選択肢を読み込んでいる間
    busy?: boolean;
    onchange?: (value: string | null) => void;
  } = $props();

  const name = $props.id();
  const options = $derived(withCurrent(repositories, current));

  function choose(next: string | null): void {
    value = next;
    onchange?.(next);
  }
</script>

<div
  class="segmented"
  class:is-readonly={readonly}
  role="radiogroup"
  aria-labelledby={labelledBy}
  aria-describedby={describedBy}
  aria-busy={busy || undefined}
>
  <label>
    <input type="radio" {name} value="" checked={value === null} disabled={readonly} onchange={() => choose(null)} />
    <span>{t('repositoryNone')}</span>
  </label>
  {#each options as repository (repository.id)}
    <label>
      <input
        type="radio"
        {name}
        value={repository.id}
        checked={value === repository.id}
        disabled={readonly}
        onchange={() => choose(repository.id)}
      />
      <span>{repository.name}</span>
    </label>
  {/each}
</div>
