<script lang="ts">
  import type { IconName } from '../icons.ts';

  let { name }: { name: IconName } = $props();
</script>

<svg class="ico" aria-hidden="true"><use href="#i-{name}" /></svg>
