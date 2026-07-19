import { createImageConverters } from './server/lib/haocode/image-converters.js';
import fs from 'node:fs';
const c = createImageConverters({ dataDir: '/tmp/cap-dbg-cache', logger: console });
const img = 'data:image/png;base64,' + fs.readFileSync('/tmp/ocr-big.png').toString('base64');
console.log('caption:', JSON.stringify(await c.caption(img)));
console.log('ocr:', JSON.stringify(await c.ocr(img)));
