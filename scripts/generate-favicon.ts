// SVG を Chromium で実寸描画し、透過 PNG を16px・32pxの ICO にまとめる。
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const svg = await readFile(new URL('../static/favicon.svg', import.meta.url), 'utf8');
const sizes = [16, 32];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const images: Buffer[] = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
    );
    images.push(await page.screenshot({ omitBackground: true }));
  }

  // ICONDIR は6バイト、各 ICONDIRENTRY は16バイト。画像の位置はファイル先頭基準。
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [index, image] of images.entries()) {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  }
  await writeFile(new URL('../static/favicon.ico', import.meta.url), Buffer.concat([header, ...images]));
} finally {
  await browser.close();
}
