import { createWorker } from 'tesseract.js';
console.log('bun', Bun.version, 'creating worker (workerBlobURL:false)...');
const w = await createWorker(['eng'], 1, { workerBlobURL: false, logger: (m) => console.log('T>', m.status ?? m) });
console.log('worker created');
const r = await w.recognize('/tmp/ocr-test.png');
console.log('RESULT:', JSON.stringify(r.data.text));
await w.terminate();
