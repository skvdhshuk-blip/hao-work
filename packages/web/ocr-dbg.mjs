import { createWorker } from 'tesseract.js';
console.log('creating worker...');
const w = await createWorker(['eng'], 1, { logger: (m) => console.log('T>', m.status ?? m) });
console.log('worker created');
const r = await w.recognize('/tmp/ocr-test.png');
console.log('RESULT:', JSON.stringify(r.data.text));
await w.terminate();
