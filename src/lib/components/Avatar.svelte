<script lang="ts" module>
  // userId が null なら担当なしで、名前を持たない。userId があるときは名前を必須にする
  export type AvatarProps =
    | { userId: null; name?: undefined; large?: boolean; left?: undefined }
    | { userId: string; name: string; large?: boolean; left?: boolean };
</script>

<script lang="ts">
  import { hueOf } from '../avatar-hue.ts';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の avatar / avatarOf。色相は users.id から計算し、style:--h（CSSOM）で渡す。
  // style 属性の文字列は CSP の style-src に止められる。画像として読み上げられるよう role="img" と aria-label を付ける
  let { userId, name, large = false, left = false }: AvatarProps = $props();

  const label = $derived(name === undefined ? t('unassigned') : `${name}${left ? t('leftMember') : ''}`);
  const initial = $derived(name === undefined ? '?' : ([...name][0] ?? '?'));
</script>

{#if userId === null}
  <span class="avatar is-none" class:is-lg={large} role="img" aria-label={label} title={label}>{initial}</span>
{:else}
  <span
    class="avatar"
    class:is-lg={large}
    class:is-left={left}
    style:--h={hueOf(userId)}
    role="img"
    aria-label={label}
    title={label}>{initial}</span
  >
{/if}
