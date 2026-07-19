import { createImageConverters } from './server/lib/haocode/image-converters.js';
import fs from 'node:fs';
const c = createImageConverters({ dataDir: '/tmp/ocr-dbg-cache', logger: { log(){}, error(){} } });
const dataUri = 'data:image/png;base64,' + fs.readFileSync('/tmp/ocr-big.png').toString('base64');
console.log('OCR:', JSON.stringify(await c.ocr(dataUri)));
