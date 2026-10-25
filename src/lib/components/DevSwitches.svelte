<script lang="ts">
  import { themeLabelKeys, type Theme } from '../../shared/theme.ts';
  import { setTheme, themeState } from '../theme.svelte.ts';
  import { setVocabularies, t, vocabularies } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 開発用のテーマと言葉の切り替え。kit.js の上の帯の「言葉」と「テーマ」に当たる。
  // 本番の build には入れない（呼ぶ側が import.meta.env.DEV で囲む）。本物の切り替えは設定の画面で作る（#53 で消す）。

  // シンプル（自動、属性なし）→ ライト → ダーク → 中世風 → 現代風 → 属性なし。
  // 値 simple は属性なしと同じ見た目なので、巡回には入れない（最初の1回で見た目が変わらなくなる）
  const cycle: (Theme | null)[] = [null, 'simple_light', 'simple_dark', 'medieval', 'modern'];

  function cycleTheme(): void {
    const index = cycle.indexOf(themeState.current);
    setTheme(cycle[(index + 1) % cycle.length]);
  }

  // 組織の言葉もワークスペースの言葉も、まとめてゲームとスクラムを入れ替える
  function toggleVocabulary(): void {
    const next = vocabularies.workspace === 'game' ? 'scrum' : 'game';
    setVocabularies({ workspace: next, organization: next });
  }
</script>

<button class="pill" type="button" data-dev-switch="vocabulary" onclick={toggleVocabulary}>
  <Icon name="swap" /><span>{t('vocabLabel')}: {t('vocab')}</span>
</button>
<button class="pill" type="button" data-dev-switch="theme" onclick={cycleTheme}>
  <Icon name="moon" /><span>{t('themeLabel')}: {t(themeLabelKeys[themeState.current ?? 'simple'])}</span>
</button>
