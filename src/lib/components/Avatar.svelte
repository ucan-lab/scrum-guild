<script lang="ts" module>
  // userId が null なら担当なしで、名前を持たない。userId があるときは名前を必須にする。
  // image はログインの手段の側のアバターの画像の URL（運用者が指名する人を確かめるときなど）。無ければ頭文字の円。
  // decorative は、横に同じ名前を読む要素（選択欄など）があるときに、読み上げから外す（title は残す）
  export type AvatarProps =
    | { userId: null; name?: undefined; large?: boolean; left?: undefined; image?: undefined; decorative?: boolean }
    | { userId: string; name: string; large?: boolean; left?: boolean; image?: string | null; decorative?: boolean };
</script>

<script lang="ts">
  import { hueOf } from '../avatar-hue.ts';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の avatar / avatarOf。色相は users.id から計算し、style:--h（CSSOM）で渡す。
  // style 属性の文字列は CSP の style-src に止められる。画像として読み上げられるよう role="img" と aria-label を付ける。
  // 画像が読み込めないとき（CSP、通信、URL の失効）は、頭文字の円に戻す
  let { userId, name, large = false, left = false, image = null, decorative = false }: AvatarProps = $props();

  let failedImage = $state<string | null>(null);

  const label = $derived(name === undefined ? t('unassigned') : `${name}${left ? t('leftMember') : ''}`);
  const initial = $derived(name === undefined ? '?' : ([...name][0] ?? '?'));
  const shownImage = $derived(image && image !== failedImage ? image : null);
</script>

{#if userId === null}
  <span
    class="avatar is-none"
    class:is-lg={large}
    role={decorative ? undefined : 'img'}
    aria-label={decorative ? undefined : label}
    aria-hidden={decorative ? 'true' : undefined}
    title={label}>{initial}</span
  >
{:else}
  <span
    class="avatar"
    class:is-lg={large}
    class:is-left={left}
    style:--h={hueOf(userId)}
    role={decorative ? undefined : 'img'}
    aria-label={decorative ? undefined : label}
    aria-hidden={decorative ? 'true' : undefined}
    title={label}
  >
    {#if shownImage}<img
        src={shownImage}
        alt=""
        referrerpolicy="no-referrer"
        onerror={() => (failedImage = shownImage)}
      />{:else}{initial}{/if}
  </span>
{/if}
