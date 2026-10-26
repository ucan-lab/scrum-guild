<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 木の行の区分とリポジトリの名前の印（.chip.is-name。長い名前は折り返す）。区分はタグ、リポジトリは git のアイコン（kit.js の repoTag）で、
  // 状態の印と見分けられるようにする。種類は見えない文字（「<区分>：」「リポジトリ：」）で読み上げに添える
  let { kind, name }: { kind: 'category' | 'repository'; name: string } = $props();
</script>

<span class="chip is-name"
  ><Icon name={kind === 'category' ? 'tag' : 'git'} /><span
    ><span class="visually-hidden"
      >{t('chipPrefix', { kind: kind === 'category' ? t('category') : t('repository') })}</span
    >{name}</span
  ></span
>
