<script lang="ts">
  import { hueOf } from '../avatar-hue.ts';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の avatar / avatarOf。userId が null なら担当なしの破線の円。色相は users.id から計算する。
  // 色相は style:--h（CSSOM）で渡す。style 属性の文字列は CSP の style-src に止められる
  let {
    userId,
    name,
    large = false,
    left = false,
  }: { userId: string | null; name?: string; large?: boolean; left?: boolean } = $props();

  const initial = $derived(name ? ([...name][0] ?? '?') : '?');
  const title = $derived(name ? `${name}${left ? t('leftMember') : ''}` : t('unassigned'));
</script>

{#if userId === null}
  <span class="avatar is-none" class:is-lg={large} {title}>?</span>
{:else}
  <span class="avatar" class:is-lg={large} class:is-left={left} style:--h={hueOf(userId)} {title}>{initial}</span>
{/if}
