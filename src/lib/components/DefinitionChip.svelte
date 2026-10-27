<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 木の行の区分、リポジトリ、入っているスプリントの名前の印（.chip.is-name。長い名前は折り返す）。区分はタグ、リポジトリは git、
  // スプリントは暦のアイコン（kit.js の repoTag、sprintTag）で、状態の印と見分けられるようにする。
  // 種類は見えない文字（「<区分>：」「リポジトリ：」「<スプリント>：」）で読み上げに添える
  let { kind, name }: { kind: 'category' | 'repository' | 'sprint'; name: string } = $props();

  const icon = $derived(kind === 'category' ? 'tag' : kind === 'repository' ? 'git' : 'calendar');
  const kindName = $derived(
    kind === 'category' ? t('category') : kind === 'repository' ? t('repository') : t('sprint'),
  );
</script>

<span class="chip is-name"
  ><Icon name={icon} /><span><span class="visually-hidden">{t('chipPrefix', { kind: kindName })}</span>{name}</span
  ></span
>
