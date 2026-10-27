<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 木の行の区分、リポジトリ、入っているスプリントの名前の印（.chip.is-name。長い名前は折り返す）。区分はタグ、リポジトリは git、
  // スプリントは暦のアイコン（kit.js の repoTag、sprintTag）で、状態の印と見分けられるようにする。
  // 種類は見えない文字（「<区分>：」「リポジトリ：」「<スプリント>：」）で読み上げに添える。
  // mono が真なら名前を等幅（.mono）で出す（名前の無いスプリントの期間）
  let {
    kind,
    name,
    mono = false,
  }: { kind: 'category' | 'repository' | 'sprint'; name: string; mono?: boolean } = $props();

  const icon = $derived(kind === 'category' ? 'tag' : kind === 'repository' ? 'git' : 'calendar');
  const kindName = $derived(
    kind === 'category' ? t('category') : kind === 'repository' ? t('repository') : t('sprint'),
  );
</script>

<span class="chip is-name"
  ><Icon name={icon} /><span
    ><span class="visually-hidden">{t('chipPrefix', { kind: kindName })}</span>{#if mono}<span class="mono">{name}</span
      >{:else}{name}{/if}</span
  ></span
>
