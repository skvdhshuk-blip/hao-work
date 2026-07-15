import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(__dirname, '../resources/icons');
const source = path.join(iconsDir, 'app-icon.svg');

const render = (size, destination) => sharp(source)
  .resize(size, size)
  .png()
  .toFile(destination);

await Promise.all([
  render(1024, path.join(iconsDir, 'icon.png')),
  render(1024, path.join(iconsDir, 'app-icon.png')),
  render(1024, path.join(iconsDir, 'dev-icon.png')),
]);

if (process.platform === 'darwin') {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hao-work-icons-'));
  const iconset = path.join(temporaryRoot, 'Hao Work.iconset');
  fs.mkdirSync(iconset);
  const entries = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  try {
    await Promise.all(entries.map(([size, filename]) => render(size, path.join(iconset, filename))));
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(iconsDir, 'icon.icns')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr || 'iconutil failed');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

console.log(`[electron] generated Hao Work icons from ${source}`);
