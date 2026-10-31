// 線画の定義。見本の design/art.js の ARTS と同じ中身（scripts/design-parity.test.ts が突き合わせる）。
// 使うときは Art.svelte、スプライトは ArtSprite.svelte。
export const artViewBox = '0 0 64 64';

export const arts = {
  notice:
    '<path d="M8 8h48v34H8z"/><path d="M20 42v14M44 42v14"/><path d="M16 14h16v14H16z"/><path d="M24 14v.01"/><path d="M40 16h10M40 22h10M40 28h6" stroke-dasharray="1 5"/>',
  chest:
    '<path d="M10 32h44v20H10z"/><path d="M10 32l4-16h36l4 16"/><path d="M28 32v6h8v-6"/><path d="M32 4v5M21 7l2 4M43 7l-2 4"/>',
  map: '<path d="M8 14l16-6 16 6 16-6v42l-16 6-16-6-16 6z"/><path d="M24 8v42M40 14v42"/><path d="M13 40c5-8 10-8 15-4s9 0 11-8" stroke-dasharray="0 6"/><path d="M45 28l6 6M51 28l-6 6"/>',
} as const;

export type ArtName = keyof typeof arts;
