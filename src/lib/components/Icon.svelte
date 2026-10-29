<script lang="ts">
  import type { IconName } from '../icons.ts';

  // kit.js の icon。tone="xp" は経験値の色（.ico.is-xp）。ゲームの物の経験値（crystal）とレベル（crest）に使う
  let { name, tone }: { name: IconName; tone?: 'xp' } = $props();
</script>

<svg class="ico" class:is-xp={tone === 'xp'} aria-hidden="true"><use href="#i-{name}" /></svg>
